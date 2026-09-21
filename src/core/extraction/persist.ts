/**
 * Persist half of the extraction pipeline — resolve entities, gate triples,
 * upsert rows for one chunk's outputs.
 *
 * Lifted from `src/cli/extract.ts` (persistOutputs and its entity helpers)
 * so the CLI and the MCP extract tool (T3) share one persist implementation.
 * The caller owns the transaction: every function here runs single statements
 * against the caller's `Queryable` and never opens, commits or rolls back a
 * transaction itself.
 *
 * Gates applied per output (mark-and-continue, never chunk-fatal on their
 * own — only `allSelfLoop` escalates, and that escalation is the batch
 * orchestrator's decision):
 *   1. alias+type self-loop reject (head === tail after normalization);
 *   2. resolved-id self-loop reject (the SC6 head/tail merge exclusion
 *      backstop);
 *   3. evidence-span grounding gate (`isGrounded`, SC7): an ungrounded span
 *      is a hallucination and never lands.
 */
import { randomUUID } from "node:crypto";

import type { Logger } from "../../logging.js";
import type { ProjectionSubject } from "../storage/projection-outbox.js";
import type { ExtractionOutput, SurvivorRef } from "./types.js";
import { upsertTriple } from "./dedup.js";
import { isGrounded } from "../extraction-eval/filter.js";
import { normalizeRelation, DEFAULT_THRESHOLD, UNMAPPED } from "./normalize.js";
import { ALLOWED } from "./vocabulary.js";
import type { Queryable } from "./records.js";
import {
  mergeEntitiesWithGating,
  normalizeAlias,
  type CandidateEntity,
  type IncomingEntity,
} from "../entities/merge.js";
import { resolveCanonicalId } from "../entities/resolve.js";
import { computeEntityEmbeddingText } from "../entities/embedding.js";
import { GraphragError } from "../errors.js";
import type { EmbeddingClient } from "../embedder.js";
import {
  embedWithSlotFallback,
  readSlotGenerationState,
  slotWriteFragments,
  slotWriteTargets,
  type SlotEmbeddingSource,
  type SlotVectorBatches,
} from "../embed-slots.js";
import { activeSlotForRead } from "../storage/embedding-generation.js";
import type { EmbeddingGenerationState } from "../types.js";
import { normalizeEntityType, type EntityType } from "./entity-type.js";

/**
 * Everything the persist half needs from its caller. The batch orchestrator
 * (pipeline.ts) extends this with the LLM client and the precision layer.
 */
export interface ExtractPersistDeps {
  embedder: EmbeddingClient;
  logger: Logger;
  /** Injectable clock for deterministic started_at in tests. */
  now?: () => string;
  /**
   * Embedding rotate T2: where to get the embedder for the OTHER slot's
   * (model, dimensions) pair while a `dual_write` rotate is open. Absent →
   * legacy single-generation embed; an OPEN rotate then typed-refuses.
   */
  slotEmbedding?: SlotEmbeddingSource;
  /**
   * T4 write-time supersede switch. Forwarded to `upsertTriple` so a
   * contradicting older row is retired in the same per-chunk transaction
   * instead of accumulating until an offline consolidate `--apply`.
   * Production threads the `loadEnv()` value — ON by default per ADR-0009,
   * explicit off as the escape hatch. Omitted (test injection) keeps the
   * pre-T4 merge-on-overlap shape.
   */
  writeTimeSupersede?: boolean;
}

/** Injectable clock fallback: every log/timestamp site reads the time here. */
export function depsNow(deps: ExtractPersistDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

export interface PersistCounts {
  triples: number;
  unmapped: number;
  /**
   * Outputs whose evidence span did not ground in the chunk text. Per-triple
   * rejects (mark-and-continue): the chunk is NOT failed for them — only
   * allSelfLoop escalates — but the count surfaces in the batch log so a
   * hallucination spike is observable without reading rows back.
   */
  ungrounded: number;
  /**
   * Ledger subjects this chunk touched, in write order — the projection
   * intents the caller emits before committing. Chunks are never listed:
   * they do not enter the graph (ADR-0001).
   */
  projected: ProjectionSubject[];
  /**
   * Unique canonical entity ids touched this chunk. De-duplicated because
   * the same entity may appear as the head of one output and the tail of
   * another; the precision-layer projection needs one row per entity id,
   * and a survivor of a soft-merge counts only once (the loser is NOT in
   * this set — it stays in `projected` for the Neo4j projection but the
   * ES entity index never sees a retired/merged-away row).
   */
  entities: string[];
  /**
   * Loser ids materialised by an L3 merge. Each loser is a fresh
   * `entities` row whose `merged_into` now points at a survivor; the
   * precision layer must drop them from its entity index so a lexical
   * seed lookup cannot resolve to a row that exists only as audit
   * history in the ledger.
   */
  mergedLoserIds: string[];
  /**
   * T3 standard-enrichment input: one entry per resolved endpoint of every
   * output that reached entity resolution, keyed by the SURVIVOR id the
   * merge settled on (never a loser). `enrichStandardChunk` groups these
   * into per-entity description lists after the merge, inside the same
   * chunk transaction.
   */
  survivors: SurvivorRef[];
  /**
   * SC5: every output in this chunk was rejected as a self-loop. The chunk
   * produced zero graph edges and zero entities; the orchestrator marks it
   * `failed` with the SELF_LOOP_REJECTED sentinel so --list-failed /
   * --only-failed can hide it from "must re-extract" lists.
   */
  allSelfLoop: boolean;
}

/** Resolve/create entities and upsert triples for one chunk's outputs. */
export async function persistOutputs(
  deps: ExtractPersistDeps,
  client: Queryable,
  chunkId: string,
  chunkContent: string,
  outputs: ExtractionOutput[],
  startedAt: string
): Promise<PersistCounts> {
  let triples = 0;
  let unmapped = 0;
  let selfLoopCount = 0;
  let ungroundedCount = 0;
  const projected: ProjectionSubject[] = [];
  const entityIds = new Set<string>();
  const mergedLoserIds = new Set<string>();
  const survivors: SurvivorRef[] = [];
  for (const out of outputs) {
    // Closed-set gate (entity-type-and-filter T1): a type outside
    // person/organization/place/event normalizes to null. Neither endpoint
    // may become an entity row, and an edge dangling off a skipped entity
    // would break the triple FK — so the whole output is typed-skipped
    // (mark-and-continue, never a fallback bucket).
    const types = resolveClosedSetTypes(out);
    if (types === null) {
      logUnknownTypeSkip(deps, chunkId, out);
      continue;
    }
    if (isAliasSelfLoop(out, types)) {
      logSelfLoopRejection(deps, chunkId, out);
      selfLoopCount += 1;
      continue;
    }
    const {
      headId,
      headName,
      tailId,
      tailName,
      mergedLoserIds: losers,
    } = await resolveEndpoints(deps, client, out, types);
    // Both endpoints are projectable nodes even when the triple below is
    // rejected — an entity with no edge is still a node the graph arm can
    // seed on.
    projected.push({ kind: "entity", id: headId });
    entityIds.add(headId);
    survivors.push({
      entityId: headId,
      canonicalName: headName,
      description: out.description,
    });
    for (const loser of losers) mergedLoserIds.add(loser);
    if (headId === tailId) {
      logSelfLoopRejection(deps, chunkId, out, headId);
      selfLoopCount += 1;
      continue;
    }
    projected.push({ kind: "entity", id: tailId });
    entityIds.add(tailId);
    survivors.push({
      entityId: tailId,
      canonicalName: tailName,
      description: out.description,
    });
    // Persist gate for the evidence span (SC7, assumption 10): the span must
    // be a non-empty substring of the chunk text, or the triple is a
    // hallucination and never lands. Per-triple mark-and-continue — the
    // grounded siblings still insert and the chunk still succeeds.
    if (!isGrounded(out, chunkContent)) {
      logUngroundedRejection(deps, chunkId, out);
      ungroundedCount += 1;
      continue;
    }
    const relationNorm = await vetRelationNorm(deps, out);
    const upserted = await resolveAndUpsertTriple(
      deps,
      client,
      chunkId,
      out,
      headId,
      tailId,
      relationNorm,
      startedAt
    );
    projected.push({ kind: "triple", id: upserted.tripleId });
    if (upserted.retiredTripleId !== undefined) {
      // The retired row's validity window just closed; Neo4j re-reads the
      // row on drain, so it needs an intent of its own (same transaction).
      projected.push({ kind: "triple", id: upserted.retiredTripleId });
    }
    triples += 1;
    if (relationNorm === UNMAPPED) unmapped += 1;
  }
  // SC5: `allSelfLoop` is true only when outputs were present and EVERY
  // one was a self-loop. An empty `outputs` array vacuously yields false so
  // the caller still treats it as a normal zero-output chunk.
  const allSelfLoop = outputs.length > 0 && selfLoopCount === outputs.length;
  return {
    triples,
    unmapped,
    ungrounded: ungroundedCount,
    projected,
    entities: [...entityIds],
    mergedLoserIds: [...mergedLoserIds],
    survivors,
    allSelfLoop,
  };
}

/**
 * Resolve the two ends of one output.
 *
 * SC6 invariant: the head and the tail of a single output are mutually
 * exclusive merge candidates. The extraction schema gives one output ONE
 * `description`, which both ends are resolved with, so leaving the head in
 * the tail's candidate set lets the L3 name+description cosine fold the tail
 * into the head — the triple then asserts a relation from an entity to
 * itself. Excluding the resolved `headId` from the tail's candidate array
 * removes that path before the gates run, without touching
 * `mergeEntitiesWithGating`'s locked signature (G7).
 */
async function resolveEndpoints(
  deps: ExtractPersistDeps,
  client: Queryable,
  out: ExtractionOutput,
  types: ClosedSetTypes
): Promise<{
  headId: string;
  headName: string;
  tailId: string;
  tailName: string;
  mergedLoserIds: string[];
}> {
  // The pair arrives normalized from persistOutputs (CR High #2 plus the T1
  // closed-set gate) so the merge gates and the persisted row agree on the
  // same CHECK-safe type value.
  const head = await resolveEntity(deps, client, {
    canonicalName: out.head,
    type: types.headType,
    description: out.description,
  });
  const tail = await resolveEntity(
    deps,
    client,
    {
      canonicalName: out.tail,
      type: types.tailType,
      description: out.description,
    },
    { excludeIds: [head.id] }
  );
  return {
    headId: head.id,
    headName: head.canonicalName,
    tailId: tail.id,
    tailName: tail.canonicalName,
    mergedLoserIds: [...head.mergedLoserIds, ...tail.mergedLoserIds],
  };
}

/** One output's endpoint types after the closed-set normalization (T1). */
interface ClosedSetTypes {
  headType: EntityType;
  tailType: EntityType;
}

/**
 * Normalize both endpoint types at once; `null` is the typed-skip signal —
 * either endpoint outside the closed set makes the whole output
 * unprojectable, so the pair is only ever handed on as a unit.
 */
function resolveClosedSetTypes(out: ExtractionOutput): ClosedSetTypes | null {
  const headType = normalizeEntityType(out.headType);
  const tailType = normalizeEntityType(out.tailType);
  return headType !== null && tailType !== null ? { headType, tailType } : null;
}

/** Alias-level self-loop: same surface form AND same closed-set type. */
function isAliasSelfLoop(out: ExtractionOutput, types: ClosedSetTypes): boolean {
  return (
    normalizeAlias(out.head) === normalizeAlias(out.tail) &&
    types.headType === types.tailType
  );
}

/**
 * Backstop for the SC6 exclusion above: a triple whose two ends resolved to
 * the same entity asserts nothing, so it is rejected. Only THAT triple is
 * skipped — the chunk's remaining outputs and the rest of the batch continue,
 * same mark-and-continue posture the merge gates take on a gray-zone reject.
 */
function logSelfLoopRejection(  deps: ExtractPersistDeps,
  chunkId: string,
  out: ExtractionOutput,
  entityId?: string
): void {
  deps.logger.warn("triple-self-loop-rejected", {
    chunkId,
    entityId: entityId ?? null,
    head: out.head,
    tail: out.tail,
    relationRaw: out.relationRaw,
    reason: "head-equals-tail",
  });
}

/**
 * The closed-set leg of the persist gate (T1): an endpoint type the mapper
 * refused (null) makes this output unprojectable. Warn so the skip is
 * observable in the batch log — the raw proposed types are included because
 * they are short metadata, never ingest-body.
 */
function logUnknownTypeSkip(
  deps: ExtractPersistDeps,
  chunkId: string,
  out: ExtractionOutput
): void {
  deps.logger.warn("entity-type-unknown-skip", {
    chunkId,
    head: out.head,
    tail: out.tail,
    relationRaw: out.relationRaw,
    // Cap the raw type: it is unbounded provider output, and one pathological
    // response must not blow up the log line's size (64 chars is well past any
    // realistic type word, so the skip stays diagnosable).
    headType:
      normalizeEntityType(out.headType) === null
        ? out.headType.slice(0, 64)
        : null,
    tailType:
      normalizeEntityType(out.tailType) === null
        ? out.tailType.slice(0, 64)
        : null,
    reason: "type-outside-closed-set",
  });
}

/**
 * The ungrounded leg of the SC7 persist gate: the span text itself is never
 * logged — only its length (no ingest-body leak into logs).
 */
function logUngroundedRejection(
  deps: ExtractPersistDeps,
  chunkId: string,
  out: ExtractionOutput
): void {
  deps.logger.warn("triple-ungrounded-rejected", {
    chunkId,
    entityId: null,
    head: out.head,
    tail: out.tail,
    relationRaw: out.relationRaw,
    evidenceSpanLength: out.evidenceSpan.length,
    reason: "span-not-in-chunk",
  });
}

/**
 * Upsert one grounded triple. A merge returns the surviving row's id: its
 * confidence just moved, so the edge still needs re-projecting (the caller
 * pushes it onto `projected` either way).
 *
 * `extractor` follows the output's provenance tag: the LLM path leaves it
 * absent and the row defaults to `'llm'`; the fast NLP path (T4) tags its
 * co-occurrence outputs `'fast'` so the ledger records which method
 * produced the edge. A rule-based or human writer sets its own tag.
 *
 * T4: the write-time supersede switch from `deps.writeTimeSupersede` is
 * forwarded to `upsertTriple` as `options.writeTimeSupersede`. The
 * supersede boundary uses `startedAt` (the per-chunk transaction start,
 * already injected as the deterministic clock) instead of `now()` so two
 * parallel chunks picking the same contradiction stamp a consistent
 * boundary.
 *
 * A supersede also retires an older row, whose closed `valid_window` must
 * reach Neo4j — so the caller emits a projection intent for
 * `retiredTripleId` too (the offline `--apply` path does the same).
 */
async function resolveAndUpsertTriple(
  deps: ExtractPersistDeps,
  client: Queryable,
  chunkId: string,
  out: ExtractionOutput,
  headId: string,
  tailId: string,
  relationNorm: string,
  startedAt: string
): Promise<{ tripleId: string; retiredTripleId?: string }> {
  return upsertTriple(
    client,
    {
      headId,
      tailId,
      relationRaw: out.relationRaw,
      relationNorm,
      confidence: out.confidence,
      sourceChunkId: chunkId,
      evidenceSpan: out.evidenceSpan,
      validWindow: { start: startedAt, end: null },
      extractor: out.extractor ?? "llm",
    },
    {
      ...(deps.writeTimeSupersede === true
        ? { writeTimeSupersede: true, now: () => startedAt }
        : {}),
    }
  );
}

/**
 * A10 trust policy for the LLM's claimed `relationNorm`.
 *
 * The claim is accepted iff it is a case-insensitive member of `ALLOWED`, and
 * the canonical `ALLOWED` spelling is what gets persisted — `relation_norm` is
 * the traversal key of the dedup triple `(head_id, relation_norm, tail_id)`,
 * so one relation must have exactly one spelling. Any other claim is discarded
 * and re-derived from `relation_raw` through the #4 D5 cascade, whose miss leg
 * is the legal `UNMAPPED` sentinel — never a silent coerce onto a neighbouring
 * term. `relation_raw` itself is stored exactly as received (#3 D3 audit
 * fidelity), which is what `--list-unmapped` groups on.
 */
async function vetRelationNorm(
  deps: ExtractPersistDeps,
  out: ExtractionOutput
): Promise<string> {
  const claimed = out.relationNorm.trim().toLowerCase();
  const accepted = ALLOWED.find((term) => term === claimed);
  if (accepted !== undefined) return accepted;
  return normalizeRelation(out.relationRaw, {
    embedder: deps.embedder,
    threshold: DEFAULT_THRESHOLD,
  });
}

/**
 * Resolve the incoming entity via the merge gates, then persist. Merge →
 * reuse the survivor id; created-new / reject → insert a fresh row (the
 * gray-zone log already recorded the rejection via the merge default sink).
 *
 * A8 first-write-wins: a merge leaves the survivor's embedding, description
 * and canonical name alone. The only write a merge makes is the A11 alias row
 * recording the surface form the survivor was reached by.
 *
 * `excludeIds` drops candidates the caller has already ruled out — the SC6
 * head/tail exclusion. The filter is applied to the loaded `CandidateEntity[]`
 * before the gates see it, so the merge module keeps its locked signature.
 *
 * Returns the resolved id, the SURVIVOR's canonical name (the T3 enrichment
 * describe/claims input is keyed by ledger name, never by the LLM's surface
 * form), and any loser ids this call wrote. Loser ids are
 * the rows materialized as `merged_into` survivors — the precision layer
 * must remove them from its entity index so a lexical seed lookup can
 * never resolve to a row the ledger no longer answers for.
 */
async function resolveEntity(
  deps: ExtractPersistDeps,
  client: Queryable,
  incoming: IncomingEntity,
  opts: { excludeIds?: string[] } = {}
): Promise<{
  id: string;
  canonicalName: string;
  mergedLoserIds: string[];
}> {
  const excluded = new Set(opts.excludeIds ?? []);
  // Review repair A: read the generation ledger ONCE per resolution and
  // thread it down — the candidate-vector SELECT, the slot write targets
  // and the cosine gates must all see the SAME state, so a rotate opening
  // mid-resolution cannot half-bind the read to one generation.
  const state = await readSlotGenerationState(client);
  const live = (await loadEntities(client, state)).filter(
    (c) => !excluded.has(c.id)
  );
  const { canonicalId, decision } = await mergeEntitiesWithGating(
    incoming,
    live,
    {
      embedder: deps.embedder,
    }
  );
  if (decision !== "created-new" && decision.kind === "merge") {
    const survivorId = await resolveCanonicalId(client, canonicalId);
    const survivor = live.find((c) => c.id === survivorId);
    const mergedLoserIds: string[] = [];
    if (decision.via === "L3") {
      // L3 is the only fuzzy merge: materialize the incoming entity as the
      // loser so the ledger retains a rollbackable merged_into edge. L0
      // matches an existing row exactly and must remain idempotent.
      const loserId = randomUUID();
      await insertEntity(
        client,
        loserId,
        incoming,
        await embedEntityForWrite(deps, client, incoming, state)
      );
      await linkMergedEntity(client, loserId, survivorId);
      mergedLoserIds.push(loserId);
    }
    if (survivor && survivor.canonicalName !== incoming.canonicalName) {
      await insertAlias(client, survivorId, incoming.canonicalName, "variant");
    }
    return {
      id: survivorId,
      // The survivor row's name; a resolveCanonicalId hop that left the
      // live set falls back to the incoming form the merge matched on.
      canonicalName: survivor?.canonicalName ?? incoming.canonicalName,
      mergedLoserIds,
    };
  }
  const id = randomUUID();
  await insertEntity(
    client,
    id,
    incoming,
    await embedEntityForWrite(deps, client, incoming, state)
  );
  await insertAlias(client, id, incoming.canonicalName, "name");
  return { id, canonicalName: incoming.canonicalName, mergedLoserIds: [] };
}

/**
 * Load live entities as merge candidates, carrying the stored embedding and
 * the `metadata.description` value (A7/A13) so the L2/L3 gates see production
 * data instead of empty strings.
 *
 * Review repair A (T3 read binding): the vector column is the ledger's
 * ACTIVE slot via `activeSlotForRead` — after a cutover the merge cosine
 * reads the new generation only, and a later drop of the legacy column
 * cannot crash this read. `state === null` (pre-ledger store, injected
 * test deps) keeps the legacy `embedding` column, unchanged.
 */
export async function loadEntities(
  client: Queryable,
  state: EmbeddingGenerationState | null = null
): Promise<CandidateEntity[]> {
  const slot = activeSlotForRead(state);
  const { rows } = await client.query(
    `SELECT id, canonical_name, type, ${slot}::text AS embedding,
            coalesce(metadata->>'description', '') AS description
       FROM entities WHERE retired = false`,
    []
  );
  return rows.map((r) => {
    const embedding = parseVectorLiteral(r.embedding);
    return {
      id: r.id as string,
      canonicalName: r.canonical_name as string,
      type: r.type as string,
      description: (r.description as string | null) ?? "",
      ...(embedding ? { embedding } : {}),
    };
  });
}

/**
 * #6 Q1 SSOT: the entity vector is embedded from
 * `canonical_name + " | " + description` via `computeEntityEmbeddingText`,
 * with the same embedder and dimension as chunks. Computed once, at insert —
 * or, for a row that predates that write path, once at the CLI's
 * `--backfill-embeddings` time, which is why this takes the name/description
 * pair rather than a whole `IncomingEntity`.
 *
 * T2 slot awareness: the ACTIVE-slot vector, embedded with the active
 * generation's pair when the ledger says so (the `--backfill-embeddings`
 * repair never touches the incoming slot, so `includeIncoming` is false).
 */
export async function embedEntity(
  deps: ExtractPersistDeps,
  incoming: { canonicalName: string; description: string },
  state: EmbeddingGenerationState | null = null
): Promise<number[]> {
  const batches = await embedEntityBatches(deps, state, incoming, false);
  return requireEntityVector(incoming, batches.active[0]);
}

/**
 * The vectors one entity write must land in BOTH open generations with
 * (embedding generation rotate T2, dual-write): the active vector plus the
 * incoming-slot vector embedded with the INCOMING pair, and the physical
 * slot columns the INSERT names. All batches are computed before the caller
 * writes, so a secondary embed failure leaves the row unwritten.
 */
export interface EntitySlotVectors {
  active: number[];
  incoming: number[] | null;
  activeSlot: string;
  incomingSlot: string | null;
}

export async function embedEntityForWrite(
  deps: ExtractPersistDeps,
  client: Queryable,
  incoming: { canonicalName: string; description: string },
  /** Ledger read by the caller; omitted here re-reads (standalone callers). */
  state?: EmbeddingGenerationState | null
): Promise<EntitySlotVectors> {
  const generation =
    state === undefined ? await readSlotGenerationState(client) : state;
  const batches = await embedEntityBatches(deps, generation, incoming);
  const targets = slotWriteTargets(generation);
  return {
    active: requireEntityVector(incoming, batches.active[0]),
    incoming:
      batches.incoming === null
        ? null
        : requireEntityVector(incoming, batches.incoming[0]),
    ...targets,
  };
}

async function embedEntityBatches(
  deps: ExtractPersistDeps,
  state: EmbeddingGenerationState | null,
  incoming: { canonicalName: string; description: string },
  includeIncoming?: boolean
): Promise<SlotVectorBatches> {
  const text = computeEntityEmbeddingText(
    incoming.canonicalName,
    incoming.description
  );
  // SC10 embed log: one entry per embed call, whitelist fields only — the
  // embedded SSOT text itself never travels with the log line. Same shared
  // contract as the tools' "embed" event; no itemCount (single text) and
  // the caller's injectable clock drives `time`.
  return embedWithSlotFallback({
    embedder: deps.embedder,
    slotEmbedding: deps.slotEmbedding,
    state,
    site: "entity",
    texts: [text],
    logger: deps.logger,
    eventName: "entity-embed",
    now: () => depsNow(deps),
    ...(includeIncoming === undefined
      ? {}
      : { includeIncoming }),
  });
}

function requireEntityVector(
  incoming: { canonicalName: string },
  vector: number[] | undefined
): number[] {
  if (!vector) {
    throw new GraphragError(
      `embedder returned no vector for entity "${incoming.canonicalName}"`,
      "EMBEDDING_FAILED"
    );
  }
  return vector;
}

/**
 * Persist one entity row. The production path always runs through
 * `persistOutputs`, whose closed-set gate normalizes the type first; the
 * normalize + throw below is the fail-closed backstop for a caller that
 * bypasses that gate. Exported as a test seam (same posture as
 * `loadEntities`) so the backstop's typed error is pinable directly —
 * through `persistOutputs` an unknown type can never reach it.
 */
export async function insertEntity(
  client: Queryable,
  id: string,
  incoming: IncomingEntity,
  vectors: EntitySlotVectors
): Promise<void> {
  // CR High #2 backstop: the DDL pins entities.type to the closed 4-value
  // CHECK set (person/organization/place/event). persistOutputs already
  // typed-skips unknown types, so a null here means a caller bypassed that
  // gate — fail closed with a typed error rather than let the INSERT roll
  // back the whole chunk transaction (or worse, land in a fallback bucket).
  const type = normalizeEntityType(incoming.type);
  if (type === null) {
    throw new GraphragError(
      `refusing to insert entity "${incoming.canonicalName}" with ` +
        `type "${incoming.type}" outside the closed set`,
      "INVALID_INPUT"
    );
  }
  // A7: description rides in the existing metadata JSONB — the spec-1 DDL is
  // frozen, so there is no description column to write.
  // T2 dual-write / review repair B: while a rotate is open the incoming
  // slot column joins the same INSERT through the shared fragments SSOT, so
  // the row lands in BOTH generations atomically. The slot columns stay
  // contiguous; the values array keeps metadata at $5 and the incoming
  // vector last at $6, matching the existing bind-position contract.
  const { activeSlot, incomingSlot } = vectors;
  const { columns, valuePlaceholders } = slotWriteFragments({
    activeSlot,
    incomingSlot,
    activeParam: 4,
    incomingParam: 6,
  });
  await client.query(
    `INSERT INTO entities (id, canonical_name, type, ${columns}, metadata, retired)
     VALUES ($1, $2, $3, ${valuePlaceholders}, $5::jsonb, false)`,
    [
      id,
      incoming.canonicalName,
      type,
      toVectorLiteral(vectors.active),
      JSON.stringify({ description: incoming.description }),
      ...(incomingSlot === null
        ? []
        : [toVectorLiteral(vectors.incoming as number[])]),
    ]
  );
}

/**
 * Persist a soft-merge pointer without rewriting any triple foreign keys.
 *
 * Exported so the SC6 idempotency contract (slice 4 of
 * `specs/retrieve-graph-quality.md`) is testable against real Postgres rows
 * without re-running the full merge path. The `WHERE merged_into IS NULL`
 * guard is what makes the second call a no-op — the pointer is permanent
 * for this round once written.
 */
export async function linkMergedEntity(
  client: Queryable,
  loserId: string,
  survivorId: string
): Promise<void> {
  await client.query(
    `UPDATE entities SET merged_into = $2
      WHERE id = $1 AND merged_into IS NULL`,
    [loserId, survivorId]
  );
}

/**
 * Write one surface form into `entity_aliases` (A11). The UNIQUE
 * `(entity_id, alias)` index makes a repeat a silent no-op instead of an
 * error that would roll back the whole chunk transaction.
 */
async function insertAlias(
  client: Queryable,
  entityId: string,
  alias: string,
  aliasType: "name" | "variant"
): Promise<void> {
  await client.query(
    `INSERT INTO entity_aliases (id, entity_id, alias, alias_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (entity_id, alias) DO NOTHING`,
    [randomUUID(), entityId, alias, aliasType]
  );
}

/** Serialized pgvector literal: `[0.1,0.2,...]`; the SQL casts it `::vector`. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Inverse of `toVectorLiteral`; a NULL or unparseable column yields undefined. */
function parseVectorLiteral(raw: unknown): number[] | undefined {
  if (typeof raw !== "string") return undefined;
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.length === 0) return undefined;
  const values = inner.split(",").map(Number);
  return values.some(Number.isNaN) ? undefined : values;
}
