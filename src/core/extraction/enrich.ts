/**
 * Standard post-merge enrichment — entity descriptions + claims (T3).
 *
 * `specs/graph-index-standard-fast.md` puts the standard method's two
 * extra legs AFTER canonical merge and BEFORE Leiden: (1) summarize each
 * merge survivor's description list into one description (ADR 0069), and
 * (2) extract time-bounded claims anchored on the survivors (ADR 0071).
 * The chunk transaction already persisted the survivors (persistOutputs),
 * so this module runs in the SAME transaction, right after it — a rolled
 * back chunk leaves no summaries and no claims behind.
 *
 * Failure posture (ticket acceptance "one description miss does not fail
 * the whole C job"): every LLM-level outcome is SEALED — a failed or
 * throwing leg skips its descriptions / claim rows and records counts + a
 * warn event, and NEVER throws at the orchestrator. DB write errors are
 * deliberately NOT caught here: they roll the whole chunk transaction
 * back through the pipeline's catch, which is the established "no partial
 * ledger" discipline. The T6 description-vector embed rides the same
 * sealed posture: an embedder failure skips the vectors (the summarized
 * descriptions stay durable), matching the joint spec's "one entity-summary
 * miss skips that node's vector" — explicitly NOT the all-or-nothing
 * failure class the community-summary embedding takes (T5).
 *
 * Capability-gated: both legs run only when the LLM client carries the
 * optional methods (`describeEntities` / `extractClaims`). A client
 * without them (legacy fakes, unwired doubles) sees a silent zero-write
 * skip; `AnthropicLLMClient` always carries them, so the production
 * standard job has claim/describe ON by default — while the fast method
 * never reaches this module at all (pipeline gates on `method`).
 *
 * Claims are Postgres SoR ledger rows (table `claims`, schema-bootstrap).
 * They are NOT graph subjects: no projection intent is emitted here —
 * Neo4j stays an entity/triple projection (ADR-0001).
 */
import { randomUUID } from "node:crypto";

import type { Logger } from "../../logging.js";
import { normalizeAlias } from "../entities/merge.js";
import { computeEntityEmbeddingText } from "../entities/embedding.js";
import {
  embedWithSlotFallback,
  readSlotGenerationState,
  slotWriteTargets,
  type SlotEmbeddingSource,
} from "../embed-slots.js";
import { GraphragError } from "../errors.js";
import type { EmbeddingClient } from "../embedder.js";
import type { ChunkInput } from "./extract.js";
import { LLM_EXCEPTION_CODE } from "./extract.js";
import type { LLMClient } from "./llm-client.js";
import { toVectorLiteral } from "./persist.js";
import type { Queryable } from "./records.js";
import type {
  ClaimsResponse,
  DescribeResponse,
  SurvivorRef,
} from "./types.js";

export type { SurvivorRef } from "./types.js";

/**
 * Typed seal code for an enrichment client that THREW — one vocabulary
 * with the extract half's `LLM_EXCEPTION_CODE`, aliased so enrich callers
 * do not import `extract.js` for the name.
 */
export const LLM_EXCEPTION_ENRICH_CODE = LLM_EXCEPTION_CODE;

/** Per-leg outcome counts, reported on the chunk success log. */
export interface EnrichCounts {
  described: number;
  describeSkipped: number;
  /** T6: survivors whose new description vector was written. */
  embedded: number;
  /** T6: survivors whose vector write was sealed-skipped (embedder failure). */
  embedSkipped: number;
  claimsWritten: number;
  claimsSkipped: number;
  /** Sealed failure code of the last failed/throwing describe call. */
  lastDescribeErrorCode?: string;
  /** Sealed failure code of the last failed/throwing claims call. */
  lastClaimsErrorCode?: string;
  /** Sealed failure code of the last throwing description-embed call. */
  lastEmbedErrorCode?: string;
}

/** The zero outcome — enrichment did not run (fast method / no survivors). */
export const ZERO_ENRICH: EnrichCounts = {
  described: 0,
  describeSkipped: 0,
  embedded: 0,
  embedSkipped: 0,
  claimsWritten: 0,
  claimsSkipped: 0,
};

/** Minimal deps: the LLM seam, the embedder (T6 description class), the logger. */
export interface EnrichDeps {
  llm: LLMClient;
  /**
   * The SAME embedder the persist half uses: one model, one dimension for
   * all three index embedding classes (ADR 0058 / spec Open Question 3,
   * answered "reuse the existing embedder").
   */
  embedder: EmbeddingClient;
  logger: Logger;
  /**
   * Embedding rotate T2: per-slot embedder source for the re-embed UPDATE
   * (mirrors ExtractPersistDeps). Absent → legacy single-column write, or
   * a typed refuse inside the sealed skip when a dual-write rotate is open.
   */
  slotEmbedding?: SlotEmbeddingSource;
}

/** One survivor of the merge, with this chunk's deduped description set. */
interface SurvivorGroup {
  entityId: string;
  canonicalName: string;
  descriptions: string[];
}

/**
 * Run the standard leg for ONE chunk: describe each survivor's merged
 * description list, then re-state the chunk's claims. Callers invoke this
 * only for `method === "standard"`, after `persistOutputs`, inside the
 * chunk transaction.
 */
export async function enrichStandardChunk(
  deps: EnrichDeps,
  client: Queryable,
  chunk: ChunkInput,
  survivors: SurvivorRef[],
  startedAt: string
): Promise<EnrichCounts> {
  const groups = groupSurvivors(survivors);
  const counts: EnrichCounts = { ...ZERO_ENRICH };
  // Empty merge result: nothing to describe, nothing to anchor claims on
  // — zero LLM calls, zero queries (the empty-boundary class).
  if (groups.length === 0) return counts;

  if (deps.llm.describeEntities) {
    await runDescribeLeg(deps, client, chunk.id, groups, counts);
  }
  if (deps.llm.extractClaims) {
    await runClaimsLeg(deps, client, chunk, groups, startedAt, counts);
  }
  return counts;
}

/**
 * Collapse per-output survivor refs into one entry per entity id: the
 * same description reaches head AND tail of one output, so it dedups;
 * whitespace-only descriptions drop. The list is sorted by canonical name
 * so a repeat run over equal inputs dials the LLM with identical data,
 * and claim rows resolve their anchor in a deterministic map.
 */
function groupSurvivors(survivors: SurvivorRef[]): SurvivorGroup[] {
  const byId = new Map<
    string,
    { canonicalName: string; descriptions: Set<string> }
  >();
  for (const ref of survivors) {
    const text = ref.description.trim();
    if (text.length === 0) continue;
    let entry = byId.get(ref.entityId);
    if (!entry) {
      entry = { canonicalName: ref.canonicalName, descriptions: new Set() };
      byId.set(ref.entityId, entry);
    }
    entry.descriptions.add(text);
  }
  return [...byId.entries()]
    .map(([entityId, e]) => ({
      entityId,
      canonicalName: e.canonicalName,
      descriptions: [...e.descriptions],
    }))
    .sort((a, b) => (a.canonicalName < b.canonicalName ? -1 : 1));
}

/** Call the describe leg, sealing a client throw into a typed failure. */
async function sealDescribe(
  call: () => Promise<DescribeResponse>
): Promise<DescribeResponse> {
  try {
    return await call();
  } catch (err) {
    return {
      kind: "failed",
      errorCode: LLM_EXCEPTION_ENRICH_CODE,
      errorMsg: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Call the claims leg with the same sealed-throw posture. */
async function sealClaims(
  call: () => Promise<ClaimsResponse>
): Promise<ClaimsResponse> {
  try {
    return await call();
  } catch (err) {
    return {
      kind: "failed",
      errorCode: LLM_EXCEPTION_ENRICH_CODE,
      errorMsg: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Describe leg (ADR 0069): fold each survivor's stored description (the
 * summary of all PAST chunks) into this run's new descriptions, dial ONE
 * batched call, and UPDATE only the entities the response covers. A
 * missing draft is that entity's miss — skipped, counted, never fatal.
 * Every written draft then feeds the T6 description-embedding class
 * (ADR 0058): one batched embed of the survivor set, vectors UPDATEd onto
 * `entities.embedding` inside the same chunk transaction.
 */
async function runDescribeLeg(
  deps: EnrichDeps,
  client: Queryable,
  chunkId: string,
  groups: SurvivorGroup[],
  counts: EnrichCounts
): Promise<void> {
  const stored = await loadStoredDescriptions(
    client,
    groups.map((g) => g.entityId)
  );
  const inputs = groups.map((g) => {
    const storedText = stored.get(g.entityId) ?? "";
    return {
      canonicalName: g.canonicalName,
      // Stored summary first: it carries the earlier chunks' facts the
      // merge kept but this chunk's outputs do not.
      descriptions: storedText
        ? [storedText, ...g.descriptions.filter((d) => d !== storedText)]
        : g.descriptions,
    };
  });
  const response = await sealDescribe(() =>
    deps.llm.describeEntities!({ entities: inputs })
  );
  if (response.kind === "failed") {
    counts.describeSkipped += inputs.length;
    counts.lastDescribeErrorCode = response.errorCode;
    deps.logger.warn("standard-enrichment-describe-failed", {
      chunkId,
      code: response.errorCode,
      skipped: inputs.length,
    });
    return;
  }
  const drafts = new Map(
    response.descriptions.map((d) => [d.canonicalName, d.description])
  );
  const written: DescribedDraft[] = [];
  for (const group of groups) {
    const draft = drafts.get(group.canonicalName)?.trim();
    if (!draft) {
      // One description miss skips THIS entity (ADR 0069) — the run and
      // the chunk continue, and with no draft there is nothing to embed.
      counts.describeSkipped += 1;
      continue;
    }
    await client.query(
      `UPDATE entities
          SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{description}',
                to_jsonb($2::text),
                true
              )
        WHERE id = $1`,
      [group.entityId, draft]
    );
    counts.described += 1;
    written.push({ entityId: group.entityId, canonicalName: group.canonicalName, draft });
  }
  await reembedDescriptions(deps, client, chunkId, written, counts);
}

/** One survivor whose new description just landed — the re-embed input. */
interface DescribedDraft {
  entityId: string;
  canonicalName: string;
  draft: string;
}

/**
 * T6 description-embedding class: embed `canonical_name | draft` (the same
 * `computeEntityEmbeddingText` SSOT the insert path uses, so one entity
 * always carries its latest description vector) with ONE batched call,
 * then UPDATE each survivor's `entities.embedding`.
 *
 * Failure posture (joint spec assumption 9): sealed skip. A throwing or
 * short embedder response leaves the committed description text with its
 * previous vector and records the count + code — it never fails the chunk
 * or the C job, unlike the all-or-nothing community-summary class (T5).
 */
async function reembedDescriptions(
  deps: EnrichDeps,
  client: Queryable,
  chunkId: string,
  entries: DescribedDraft[],
  counts: EnrichCounts
): Promise<void> {
  if (entries.length === 0) return;
  const texts = entries.map((e) =>
    computeEntityEmbeddingText(e.canonicalName, e.draft)
  );
  const state = await readSlotGenerationState(client);
  const targets = slotWriteTargets(state);
  let active: number[][];
  let incoming: number[][] | null;
  try {
    const batches = await embedWithSlotFallback({
      embedder: deps.embedder,
      slotEmbedding: deps.slotEmbedding,
      state,
      site: "entity-description",
      texts,
      logger: deps.logger,
      eventName: "entity-description-embed",
      itemCount: texts.length,
    });
    active = batches.active;
    incoming = batches.incoming;
  } catch (err) {
    // EXIT: sealed per-leg skip — the embed log already fired inside
    // embedWithLog; the description writes above stay committed with the
    // chunk.
    const code = err instanceof GraphragError ? err.code : "EMBEDDING_FAILED";
    counts.embedSkipped += entries.length;
    counts.lastEmbedErrorCode = code;
    deps.logger.warn("standard-enrichment-embed-failed", {
      chunkId,
      code,
      skipped: entries.length,
    });
    return;
  }
  for (let i = 0; i < entries.length; i += 1) {
    const vector = active[i];
    const incomingVector = incoming === null ? null : incoming[i];
    if (
      !vector ||
      vector.length === 0 ||
      (incoming !== null && (!incomingVector || incomingVector.length === 0))
    ) {
      // Row-level mark-and-continue (T2 both-or-neither per row): a short
      // response — in EITHER open slot — skips THIS node's vector update
      // entirely; a dual-write rotate never sees a one-generation-only
      // description vector. The described siblings still land theirs.
      counts.embedSkipped += 1;
      continue;
    }
    await client.query(
      `UPDATE entities SET ${targets.activeSlot} = $2::vector${
        targets.incomingSlot === null
          ? ""
          : `, ${targets.incomingSlot} = $3::vector`
      } WHERE id = $1`,
      [
        entries[i]!.entityId,
        toVectorLiteral(vector),
        ...(incomingVector === null ? [] : [toVectorLiteral(incomingVector)]),
      ]
    );
    counts.embedded += 1;
  }
}

/**
 * Claims leg (ADR 0071): dial once with the chunk text + survivor names;
 * on success REPLACE this chunk's rows (DELETE → INSERTs) so the claim
 * set stays a per-chunk function of the LATEST extraction — a repeat run
 * restates, never duplicates. A failed/throwing call touches nothing:
 * the previous rows describe the last successful extraction and stay.
 */
async function runClaimsLeg(
  deps: EnrichDeps,
  client: Queryable,
  chunk: ChunkInput,
  groups: SurvivorGroup[],
  startedAt: string,
  counts: EnrichCounts
): Promise<void> {
  const idsByAlias = new Map(
    groups.map((g) => [normalizeAlias(g.canonicalName), g.entityId])
  );
  const response = await sealClaims(() =>
    deps.llm.extractClaims!({
      chunkText: chunk.content,
      entities: groups.map((g) => g.canonicalName),
    })
  );
  if (response.kind === "failed") {
    counts.lastClaimsErrorCode = response.errorCode;
    deps.logger.warn("standard-enrichment-claims-failed", {
      chunkId: chunk.id,
      code: response.errorCode,
    });
    return;
  }
  await client.query(`DELETE FROM claims WHERE source_chunk_id = $1`, [
    chunk.id,
  ]);
  for (const item of response.claims) {
    const entityId = idsByAlias.get(normalizeAlias(item.entity));
    const claimText = item.claim.trim();
    const window = resolveWindow(item.validFrom, item.validTo, startedAt);
    const confidenceOk =
      typeof item.confidence === "number" &&
      item.confidence >= 0 &&
      item.confidence <= 1;
    if (!entityId || claimText.length === 0 || window === null || !confidenceOk) {
      // Row-level mark-and-continue (ADR 0071): a stray entity name, an
      // inverted window or an out-of-range confidence skips THAT row.
      counts.claimsSkipped += 1;
      continue;
    }
    await client.query(
      `INSERT INTO claims
         (id, entity_id, source_chunk_id, claim_text, valid_window,
          confidence, evidence_span, extractor)
       VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[)'), $7, $8, $9)`,
      [
        randomUUID(),
        entityId,
        chunk.id,
        claimText,
        window.start,
        window.end,
        item.confidence,
        item.evidenceSpan.length > 0 ? item.evidenceSpan : null,
        "llm",
      ]
    );
    counts.claimsWritten += 1;
  }
}

/**
 * Stored summaries for the survivor set, keyed by entity id. The ledger
 * row is authoritative for both name and description — the claim/describe
 * inputs read the DB, never the LLM's surface forms.
 */
async function loadStoredDescriptions(
  client: Queryable,
  ids: string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT id, coalesce(metadata->>'description', '') AS description
       FROM entities
      WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(
    rows
      .filter((r) => typeof r.id === "string" && r.description !== "")
      .map((r) => [r.id as string, r.description as string])
  );
}

/**
 * Validity window from the LLM's date strings. Unparseable bounds collapse
 * to NULL (open) — a time-bounded claim with no readable bound is still a
 * claim, and the open leg matches `triples.valid_window`'s `[start, NULL)`
 * forever convention. An inverted or empty window returns null: the ROW is
 * skipped rather than landing a range Postgres would reject.
 */
function resolveWindow(
  validFrom: string | null,
  validTo: string | null,
  startedAt: string
): { start: string; end: string | null } | null {
  const from = parseInstant(validFrom);
  const to = parseInstant(validTo);
  const start = from ?? startedAt;
  if (to === null) return { start, end: null };
  if (to <= start) return null;
  return { start, end: to };
}

function parseInstant(value: string | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
