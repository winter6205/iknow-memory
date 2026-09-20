/**
 * Embedding generation rotate T2 — the dual-write slot embed helper
 * (specs/embedding-generation.md, plans/embedding-generation.md T2).
 *
 * While a rotate is OPEN in `dual_write` mode every persisted vector must
 * exist in BOTH generations: each physical slot column holds a vector
 * embedded with ITS OWN (model, dimensions) pair, because two generations
 * can never share one cosine space. This module is the SSOT — one helper
 * computes the per-slot batches for a text set and the chunk, entity and
 * community-summary write paths all go through it.
 *
 * Embedder selection (spec assumption 6 + the boot guard's contract): the
 * env-configured embedder covers whichever pair matches env — the guard
 * only boots when desired == active or desired == incoming-of-an-open
 * rotate — and the OTHER slot's vectors come from a secondary embedder
 * built through `buildEmbedderClient` with that slot's recorded pair.
 *
 * Both-or-neither: every slot batch is computed BEFORE the caller writes a
 * single row, so a secondary embed failure (factory ConfigError, provider
 * EMBEDDING_FAILED) surfaces as a typed error with nothing half-written.
 * Refusing the write is preferred over a partial one: a row with an active
 * vector but a NULL incoming vector would silently never be picked up by
 * the cutover fill's "missing rows" scan target until a re-ingest, which
 * is exactly the drift T4's fill cannot be made to trust.
 */
import {
  buildEmbedderClient,
  type EmbedderClientEnv,
} from "./extraction/clients.js";
import type { Queryable } from "./extraction/records.js";
import { GraphragError } from "./errors.js";
import { embedWithLog } from "./embed-log.js";
import type { EmbeddingClient } from "./embedder.js";
import {
  assertEmbeddingSlotIdentifier,
  EMBEDDING_SLOT_BASE,
  readGenerationState,
  sameGenerationPair,
} from "./storage/embedding-generation.js";
import type { SchemaBootstrapClient } from "./storage/schema-bootstrap.js";
import type { Logger } from "../logging.js";
import type {
  EmbeddingGenerationPair,
  EmbeddingGenerationState,
} from "./types.js";

/** Where a dual-write caller gets an embedder for ANY generation pair. */
export interface SlotEmbeddingSource {
  /** The env-configured embedder (covers whichever pair matches `desired`). */
  embedder: EmbeddingClient;
  /** The env's (model, dimensions) pair, as the boot guard compared it. */
  desired: EmbeddingGenerationPair;
  /** Build the embedder for one recorded pair (the env factory seam). */
  buildEmbedder: (pair: EmbeddingGenerationPair) => EmbeddingClient;
}

/** Per-slot vectors for one text batch; `incoming` = dual-write only. */
export interface SlotVectorBatches {
  active: number[][];
  incoming: number[][] | null;
}

export interface SlotEmbedOptions {
  logger?: Logger;
  eventName?: string;
  itemCount?: number;
  now?: () => string;
  /** False on the backfill path: NULL-only repair never embeds the incoming slot. */
  includeIncoming?: boolean;
}

/** True while persist must write both physical slots. */
export function dualWriteOpen(
  state: EmbeddingGenerationState | null | undefined
): state is EmbeddingGenerationState & {
  incomingSlot: string;
  incoming: EmbeddingGenerationPair;
  rotateMode: "dual_write";
} {
  return (
    state != null &&
    state.incomingSlot !== null &&
    state.rotateMode === "dual_write"
  );
}

/** The DML slot columns for one write, validated as safe identifiers. */
export function slotWriteTargets(state: EmbeddingGenerationState | null): {
  activeSlot: string;
  incomingSlot: string | null;
} {
  const activeSlot = state?.activeSlot ?? EMBEDDING_SLOT_BASE;
  assertEmbeddingSlotIdentifier(activeSlot);
  const incomingSlot = dualWriteOpen(state) ? state.incomingSlot : null;
  if (incomingSlot !== null) assertEmbeddingSlotIdentifier(incomingSlot);
  return { activeSlot, incomingSlot };
}

/**
 * The physical column widths each slot's vector must match on write. Falls
 * back to the configured env width when no ledger row exists yet.
 */
export function slotWriteWidths(state: EmbeddingGenerationState | null, envDimensions: number): {
  activeDimensions: number;
  incomingDimensions: number | null;
} {
  return {
    activeDimensions: state?.active.dimensions ?? envDimensions,
    incomingDimensions: dualWriteOpen(state)
      ? (state.incoming?.dimensions ?? null)
      : null,
  };
}

/** One dual-write SQL statement's slot fragments (review repair B). */
export interface SlotWriteFragments {
  /** INSERT column-list piece: `embedding` / `embedding, embedding_g2`. */
  columns: string;
  /** VALUES piece with `::vector` casts on the caller's param indices. */
  valuePlaceholders: string;
  /** ON CONFLICT DO UPDATE piece copying EXCLUDED into each slot column. */
  excludedAssignments: string;
  /** UPDATE SET piece: `<slot> = $n::vector` per touched slot. */
  parameterizedAssignments: string;
}

/**
 * DUAL-WRITE SQL FRAGMENTS — the SSOT for the slot triplet that the chunk
 * upsert, the entity insert, the entity re-embed UPDATE and the community
 * swap INSERT each used to hand-roll (review repair B). Every fragment is
 * built from the SAME two validated identifiers, so no statement can drift
 * into writing only one of the open slots. The `$n` indices come from the
 * caller because the parameter layouts differ: the chunk upsert keeps its
 * incoming vector LAST in the values array ($3/$11) while the INSERT sites
 * number the slots contiguously. Both identifiers are re-asserted here —
 * they land in the SQL as raw text, never as bind parameters.
 */
export function slotWriteFragments(args: {
  activeSlot: string;
  incomingSlot: string | null;
  /** 1-based `$n` of the active slot's vector parameter. */
  activeParam: number;
  /** 1-based `$n` of the incoming vector param; required while dual-writing. */
  incomingParam?: number;
}): SlotWriteFragments {
  assertEmbeddingSlotIdentifier(args.activeSlot);
  if (!Number.isInteger(args.activeParam) || args.activeParam < 1) {
    throw new GraphragError(
      `slotWriteFragments: activeParam must be a 1-based placeholder index, got ${args.activeParam}`,
      "INVALID_INPUT"
    );
    // EXIT: a bogus index would build SQL that binds the vector to nothing.
  }
  if (args.incomingSlot === null) {
    return {
      columns: args.activeSlot,
      valuePlaceholders: `$${args.activeParam}::vector`,
      excludedAssignments: `${args.activeSlot} = EXCLUDED.${args.activeSlot}`,
      parameterizedAssignments: `${args.activeSlot} = $${args.activeParam}::vector`,
    };
  }
  assertEmbeddingSlotIdentifier(args.incomingSlot);
  if (
    args.incomingParam === undefined ||
    !Number.isInteger(args.incomingParam) ||
    args.incomingParam < 1
  ) {
    throw new GraphragError(
      "slotWriteFragments: incomingParam is required (a 1-based placeholder " +
        "index) while a dual-write slot is open",
      "INVALID_INPUT"
    );
    // EXIT: silently dropping the incoming column here is exactly the
    // half-write the dual-write contract refuses.
  }
  return {
    columns: `${args.activeSlot}, ${args.incomingSlot}`,
    valuePlaceholders: `$${args.activeParam}::vector, $${args.incomingParam}::vector`,
    excludedAssignments:
      `${args.activeSlot} = EXCLUDED.${args.activeSlot}, ` +
      `${args.incomingSlot} = EXCLUDED.${args.incomingSlot}`,
    parameterizedAssignments:
      `${args.activeSlot} = $${args.activeParam}::vector, ` +
      `${args.incomingSlot} = $${args.incomingParam}::vector`,
  };
}

/**
 * Embed `texts` once per slot the write touches, each batch produced by
 * the embedder for THAT slot's pair. `state === null` (pre-ledger store or
 * memory mode) is today's single embed, unchanged.
 */
export async function embedSlotVectors(
  source: SlotEmbeddingSource,
  state: EmbeddingGenerationState | null,
  texts: string[],
  options: SlotEmbedOptions = {}
): Promise<SlotVectorBatches> {
  const log = slotLogArgs(options);
  if (state === null) {
    return {
      active: await embedWithLog(options.logger, source.embedder, texts, log),
      incoming: null,
    };
  }
  const active = await embedWithLog(
    options.logger,
    embedderForPair(source, state.active),
    texts,
    log
  );
  const incoming =
    options.includeIncoming !== false && dualWriteOpen(state)
      ? await embedWithLog(
          options.logger,
          embedderForPair(source, state.incoming),
          texts,
          log
        )
      : null;
  return { active, incoming };
}

/**
 * Write-site entry that keeps UNWIRED callers (memory mode, eval harnesses,
 * injected test deps) on the legacy single-embed behavior — but refuses
 * with a typed EMBEDDING_FAILED when a dual-write rotate is open and the
 * slot source was never wired, because a one-slot write would half-write
 * the rotate.
 */
export async function embedWithSlotFallback(args: {
  embedder: EmbeddingClient;
  slotEmbedding?: SlotEmbeddingSource;
  state: EmbeddingGenerationState | null;
  site: string;
  texts: string[];
} & SlotEmbedOptions): Promise<SlotVectorBatches> {
  const { embedder, slotEmbedding, state, site, texts, ...options } = args;
  if (slotEmbedding !== undefined) {
    return embedSlotVectors(slotEmbedding, state, texts, options);
  }
  if (dualWriteOpen(state)) {
    throw new GraphragError(
      `${site}: a dual-write embedding rotate is open but no slotEmbedding source is wired — refusing a one-slot write`,
      "EMBEDDING_FAILED"
    );
    // EXIT: half-writing the active slot would poison the cutover fill's
    // completeness target; refuse the batch instead (both-or-neither).
  }
  return {
    active: await embedWithLog(options.logger, embedder, texts, {
      ...slotLogArgs(options),
    }),
    incoming: null,
  };
}

/** The ledger read through any values-required queryable (extraction paths). */
export function readSlotGenerationState(
  client: Queryable
): Promise<EmbeddingGenerationState | null> {
  const bootstrapClient: SchemaBootstrapClient = {
    query: (text: string, values?: unknown[]) => client.query(text, values ?? []),
  };
  return readGenerationState(bootstrapClient);
}

/**
 * Wire the env factory to the slot interface: the secondary embedder for a
 * pair is built from the SAME credentials with that pair's model/width
 * (persistsEmbeddings intent — a fake secondary must never enter a real
 * generation).
 */
export function createSlotEmbeddingSource(
  env: EmbedderClientEnv,
  embedder: EmbeddingClient
): SlotEmbeddingSource {
  return {
    embedder,
    desired: { model: env.model ?? null, dimensions: env.dimensions },
    buildEmbedder: (pair) =>
      buildEmbedderClient(
        {
          apiKey: env.apiKey,
          baseUrl: env.baseUrl,
          model: pair.model ?? undefined,
          dimensions: pair.dimensions,
        },
        { persistsEmbeddings: true }
      ),
  };
}

/**
 * The embedding slice of `GraphragEnv` this factory reads. Deliberately a
 * structural type: `config.ts` may import core modules, so importing it
 * back here would risk a cycle — the env object satisfies this shape
 * directly and TypeScript checks the field names at every wiring site.
 */
export interface GraphragEnvEmbedFields {
  embedApiKey: string | undefined;
  embedBaseUrl: string | undefined;
  embedModel: string | undefined;
  embedDimensions: number;
}

/**
 * Wiring SSOT (review repair C): build the slot source from the process's
 * GRAPHRAG_MEMORY_EMBED_* configuration. The passed embedder covers
 * whichever pair matches env (the boot guard's contract); secondary
 * embedders reuse the SAME credentials with each recorded pair. Five entry
 * points used to hand-roll the field mapping — this is now the one place.
 */
export function createSlotSourceFromGraphragEnv(
  env: GraphragEnvEmbedFields,
  embedder: EmbeddingClient
): SlotEmbeddingSource {
  return createSlotEmbeddingSource(
    {
      apiKey: env.embedApiKey,
      baseUrl: env.embedBaseUrl,
      model: env.embedModel,
      dimensions: env.embedDimensions,
    },
    embedder
  );
}

/**
 * Retrieve read binding (T3): the embedder for the QUERY vector, pinned to
 * the ledger's ACTIVE generation. The boot guard only lets a process run
 * with desired != active when a rotate is open and desired == incoming, so
 * the env embedder can target the INCOMING cosine space — the query must
 * then come from the active pair instead. `embedderForPair` returns the env
 * embedder UNCHANGED when desired == active, and a cached secondary for
 * the active pair otherwise. With no ledger state (pre-ledger store,
 * memory mode) or an unwired source the env embedder passes through —
 * today's behavior, unchanged.
 */
export function activeQueryEmbedder(args: {
  embedder: EmbeddingClient;
  slotEmbedding?: SlotEmbeddingSource;
  state: EmbeddingGenerationState | null;
}): EmbeddingClient {
  if (args.state === null || args.slotEmbedding === undefined) {
    return args.embedder;
  }
  return embedderForPair(args.slotEmbedding, args.state.active);
}

// One secondary embedder per (source, pair): persist batches several writes
// against the same foreign generation and must not rebuild the HTTP client
// per row.
const secondaryEmbedders = new WeakMap<
  SlotEmbeddingSource,
  Map<string, EmbeddingClient>
>();

function embedderForPair(
  source: SlotEmbeddingSource,
  pair: EmbeddingGenerationPair
): EmbeddingClient {
  if (sameGenerationPair(source.desired, pair)) return source.embedder;
  let byPair = secondaryEmbedders.get(source);
  if (byPair === undefined) {
    byPair = new Map();
    secondaryEmbedders.set(source, byPair);
  }
  const key = `${pair.model ?? "\u0000"}\u0000${pair.dimensions}`;
  const cached = byPair.get(key);
  if (cached !== undefined) return cached;
  const built = source.buildEmbedder(pair);
  byPair.set(key, built);
  return built;
}

function slotLogArgs(options: SlotEmbedOptions) {
  return {
    ...(options.eventName !== undefined
      ? { eventName: options.eventName }
      : {}),
    ...(options.itemCount !== undefined
      ? { itemCount: options.itemCount }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
}
