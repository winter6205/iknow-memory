/**
 * 档 C arm — report-first community summaries (plans/search-mode-retrieve.md
 * T3; fin ADR-0070 "C searches community-report text with lexical and
 * vectors in parallel"; specs/search-mode-retrieve.md assumption 4, SC4).
 *
 * Shape of the answer:
 *   - the community-index readiness gate runs FIRST and fails closed: any
 *     state other than a READY/failure-free `community_index_state` row is
 *     the typed `community_summary_index_failure` exit — never a silent
 *     empty, never a silent fall through to B, never a healthy-looking
 *     miss. Readiness is a state-table fact only: a READY row vouches for
 *     its generation (the CLI swaps summaries atomically), so a ready
 *     generation with zero rows is a healthy C miss, while an unready one
 *     is typed even when stale summary rows physically exist.
 *   - the reports themselves are ranked by the EXISTING two arm kinds over
 *     the report corpus: `bm25` names the report-TEXT lexical arm (the ES
 *     precision seam, structurally probed), `vector` names the report
 *     embedding arm (the ledger's `searchCommunitySummaries`). Both run in
 *     parallel and fuse through the existing `rrfFuse` — the 档 reuses the
 *     assembler's ranker, it never brings a second one;
 *   - hits are the summary rows (metadata kind `community-summary`, shape
 *     shared with B's lead via `communitySummaryArmHit`);
 *   - with at least one report hit, the remaining `limit` slots drop to
 *     citable 抽图窗 by delegating to the full B assembler (same embedder
 *     memo, so the query is still embedded once per retrieve).
 *     `filters.c_drop_windows=0` skips the fill; windows never answer on
 *     their own — that would be exactly the "ES the windows and ignore
 *     reports" shape ADR-0070 forbids.
 *
 * Failure taxonomy, deliberately split (spec: B fail-open vs C typed):
 *   - not-ready state            → THROW `community_summary_index_failure`
 *     (the fin-pinned token, via the existing core-types constant);
 *   - an arm that ran and threw  → `community_report:attempted-and-failed`
 *     degraded envelope; the partner arm still answers;
 *   - neither report arm could
 *     run (no seams, no creds)  → `community_report:unattempted` — C is
 *     default-on for its own essence, this must not look like a stay;
 *   - the window fill throwing   → `window_fill:attempted-and-failed`; the
 *     earned reports still ship.
 */
import {
  ARM_CANDIDATE_POOL,
  assembleRetrievalResult,
  buildEnvelope,
  observation,
} from "./index.js";
import type { AssembleArgs, AssembleDeps } from "./index.js";
import { communitySummaryArmHit } from "./optional-arms.js";
import { rrfFuse } from "./rrf.js";
import type { SearchModeArm, SearchModeControl } from "./search-mode.js";
import {
  SEARCH_MODE_FILTER_KEY,
  cDropWindowsEnabled,
  stripCDropWindowsFilter,
} from "./wire-filters.js";
import {
  supportsCommunityIndexState,
  supportsCommunityReportLexical,
  supportsCommunitySummaries,
} from "../storage/backend.js";
import { GraphragError } from "../errors.js";
import { activeQueryEmbedder } from "../embed-slots.js";
import {
  COMMUNITY_INDEX_STATUS,
  COMMUNITY_SUMMARY_INDEX_FAILURE,
} from "../types.js";
import type { StorageBackend } from "../types.js";
import type { EmbeddingClient } from "../embedder.js";
import { DEFAULT_RETRIEVE_CONFIG } from "./types.js";
import type {
  ArmName,
  ArmResult,
  CapabilityObservation,
  CommunityIndexStateRow,
  CommunityReportLexicalStorage,
  CommunitySummaryRow,
  DegradedCapability,
  DegradedReason,
  FusedHit,
  RetrieveConfig,
  RetrieveOutputEnvelope,
} from "./types.js";

/** One report arm's outcome: what it returned, whether it ran, whether it failed. */
interface ReportArmRun {
  rows: CommunitySummaryRow[];
  ran: boolean;
  failed: boolean;
}

const NOT_RAN: ReportArmRun = { rows: [], ran: false, failed: false };

export const modeCReportFirstArm: SearchModeArm = async function assembleModeCReports(
  args: AssembleArgs,
  deps: AssembleDeps,
  control?: SearchModeControl
): Promise<RetrieveOutputEnvelope> {
  // EXIT (typed): readiness first — nothing below may run on an unproven
  // report generation, and no embedding cost is spent before the gate.
  await requireCommunityIndexReady(deps.storage);

  // The wire path delivers the drop switch as the typed control value —
  // the dispatcher is the single strip point for every 档 (review I2),
  // so args.filters arriving through it never carries the key. Direct
  // arm callers still hand it in filters, exactly as the B assembler and
  // the A arm are called directly in tests; parsing it here through the
  // same wire-filters function keeps ONE meaning for the key.
  const dropWindows =
    control?.cDropWindows ?? cDropWindowsEnabled(args.filters);

  // One embed per retrieve (the assembler's standing contract): the memo
  // lets the drop call reuse the vector the report arm already produced.
  // T3: that one vector belongs to the ledger's ACTIVE generation — the
  // same binding the B assembler applies to its own query embed.
  const embedder = memoizeQueryEmbedder(
    activeQueryEmbedder({
      embedder: deps.embedder,
      slotEmbedding: deps.slotEmbedding,
      state: deps.storage.getGenerationState?.() ?? null,
    }),
    args.query
  );
  const pool = Math.max(args.limit, ARM_CANDIDATE_POOL);

  // Parallel by construction: the ES arm starts before the embedding is
  // awaited, so neither report arm waits on the other's provider.
  const lexicalStarted = runReportLexical(
    pickReportLexical(deps),
    args.query,
    pool
  );
  const embedding = await resolveQueryVector(embedder, args.query);
  const vectorRun = await runReportVectors(
    supportsCommunitySummaries(deps.storage)
      ? deps.storage.communitySummaries
      : undefined,
    embedding,
    pool
  );
  const outcome = collectReportArms(
    await lexicalStarted,
    vectorRun,
    deps.retrieveConfig,
    args.limit
  );
  if (outcome.reports.length === 0) {
    // Either the arms found no report (healthy C stay — READY vouches the
    // generation is complete) or none could run (named unattempted). The
    // observations say which; only readiness itself is the typed exit.
    return buildEnvelope([], outcome.observations, undefined);
  }

  if (!dropWindows) {
    return buildEnvelope(outcome.reports, outcome.observations, undefined);
  }

  const dropped = await fillWindows(args, deps, embedder);
  return buildEnvelope(
    mergeLeadReports(outcome.reports, dropped.hits, args.limit),
    [...outcome.observations, ...dropped.observations],
    undefined
  );
};

/** Fused report hits plus the observations the two arms earned. */
interface ReportOutcome {
  reports: FusedHit[];
  observations: CapabilityObservation[];
}

function collectReportArms(
  lexicalRun: ReportArmRun,
  vectorRun: ReportArmRun,
  config: RetrieveConfig | undefined,
  limit: number
): ReportOutcome {
  const observations: CapabilityObservation[] = [];
  if (lexicalRun.failed || vectorRun.failed) {
    observations.push(observation("community_report", "attempted-and-failed"));
  } else if (!lexicalRun.ran && !vectorRun.ran) {
    // C-ready but NO report arm could run — naming it beats the
    // healthy-empty look the spec forbids for this 档.
    observations.push(observation("community_report", "unattempted"));
  }
  const arms: ArmResult[] = [];
  if (lexicalRun.rows.length > 0)
    arms.push(toReportArm("bm25", lexicalRun.rows));
  if (vectorRun.rows.length > 0)
    arms.push(toReportArm("vector", vectorRun.rows));
  return {
    // A C call without an operator config fuses on the shared default —
    // the arm must not invent weights; it borrows the tool's (review I1).
    reports: rrfFuse(arms, config ?? DEFAULT_RETRIEVE_CONFIG, limit),
    observations,
  };
}

/**
 * The C-ready gate. Everything short of a READY row without a failure code
 * throws the fin-pinned token; a throw (not an empty envelope) is what
 * keeps the exit from resembling B's fail-open empties or a healthy miss.
 */
async function requireCommunityIndexReady(
  storage: StorageBackend
): Promise<void> {
  if (!supportsCommunityIndexState(storage)) {
    throw communitySummaryNotReady("no community_index_state read seam");
  }
  let row: CommunityIndexStateRow | undefined;
  try {
    row = await storage.getCommunityIndexState();
  } catch {
    // A state read that cannot answer cannot vouch for readiness.
    throw communitySummaryNotReady("community_index_state read failed");
  }
  if (row === undefined) {
    throw communitySummaryNotReady("no community_index_state row yet");
  }
  if (row.status !== COMMUNITY_INDEX_STATUS.READY) {
    throw communitySummaryNotReady(`status "${row.status}"`);
  }
  if (row.failure_code !== null) {
    throw communitySummaryNotReady(`failure_code "${row.failure_code}"`);
  }
}

function communitySummaryNotReady(detail: string): GraphragError {
  return new GraphragError(
    `retrieve ${SEARCH_MODE_FILTER_KEY}=C is not ready: ` +
      `${COMMUNITY_SUMMARY_INDEX_FAILURE} (${detail})`,
    "STORAGE_ERROR"
  );
}

/**
 * The report-ES seam lives on whatever precision layer is wired (mirrors
 * the A arm's lexical pick order); a later ticket makes the ES layer
 * implement it and nothing here changes. `deps.storage` is probed too so a
 * ledger that can answer report text lexically is eligible by shape.
 */
function pickReportLexical(
  deps: AssembleDeps
): CommunityReportLexicalStorage | undefined {
  if (supportsCommunityReportLexical(deps.lexical)) return deps.lexical;
  if (supportsCommunityReportLexical(deps.storage)) return deps.storage;
  return undefined;
}

async function runReportLexical(
  seam: CommunityReportLexicalStorage | undefined,
  query: string,
  pool: number
): Promise<ReportArmRun> {
  if (seam === undefined) return NOT_RAN;
  try {
    return { rows: await seam.searchCommunitySummariesLexical(query, pool), ran: true, failed: false };
  } catch {
    return { rows: [], ran: true, failed: true };
  }
}

interface EmbeddingOutcome {
  vector?: number[];
  failed: boolean;
}

/**
 * Query embedding for the vector report arm. Missing credentials skip
 * (failed=false — the arm simply does not run); a configured provider that
 * throws or returns nothing usable is an attempted-and-failed vector arm.
 */
async function resolveQueryVector(
  embedder: EmbeddingClient,
  query: string
): Promise<EmbeddingOutcome> {
  if (embedder.available === false) return { failed: false };
  try {
    const [vector] = await embedder.embed([query]);
    if (vector === undefined || vector.length === 0)
      return { failed: true };
    return { vector, failed: false };
  } catch {
    return { failed: true };
  }
}

async function runReportVectors(
  seam:
    | {
        searchCommunitySummaries(
          embedding: number[],
          limit: number
        ): Promise<CommunitySummaryRow[]>;
      }
    | undefined,
  embedding: EmbeddingOutcome,
  pool: number
): Promise<ReportArmRun> {
  if (seam === undefined) return NOT_RAN;
  if (embedding.vector === undefined) {
    // The seam exists but the provider was unavailable (skip, not a
    // failure) or threw (that IS this arm failing).
    return { rows: [], ran: embedding.failed, failed: embedding.failed };
  }
  try {
    return {
      rows: await seam.searchCommunitySummaries(embedding.vector, pool),
      ran: true,
      failed: false,
    };
  } catch {
    return { rows: [], ran: true, failed: true };
  }
}

function toReportArm(arm: ArmName, rows: CommunitySummaryRow[]): ArmResult {
  return {
    arm,
    hits: rows.map((row, i) => communitySummaryArmHit(row, arm, i + 1)),
    belowFloor: false,
  };
}

interface WindowFillOutcome {
  hits: FusedHit[];
  observations: CapabilityObservation[];
}

/**
 * The drop: the standard B assembly produces the citable windows. Its
 * throw only costs the fill — the reports already earned the answer — and
 * is named, not swallowed; its own degraded reasons ride along so a
 * partially failed fill stays observable through the same bounded codes.
 */
async function fillWindows(
  args: AssembleArgs,
  deps: AssembleDeps,
  embedder: EmbeddingClient
): Promise<WindowFillOutcome> {
  try {
    // The strip is idempotent for wire input (the dispatcher already
    // removed the key) and load-bearing for direct callers, whose
    // args.filters still carries it: the B window assembly must never
    // see the routing key as an exact-match term.
    const envelope = await assembleRetrievalResult(
      { ...args, filters: stripCDropWindowsFilter(args.filters) },
      {
        ...deps,
        embedder,
        // The embedder handed down is ALREADY the active-pair embedder
        // behind the query memo; clearing the source stops the B assembler
        // from re-resolving past the wrapper and re-embedding — the
        // one-embed-per-retrieve contract survives the C drop (T3).
        slotEmbedding: undefined,
      }
    );
    return {
      hits: envelope.chunks.map(toFusedFromWindowChunk),
      observations: (envelope.degraded_reasons ?? []).map(
        observationFromReason
      ),
    };
  } catch {
    return {
      hits: [],
      observations: [observation("window_fill", "attempted-and-failed")],
    };
  }
}

/** Reports lead; windows fill the rest; ids never repeat; the cap is hard. */
function mergeLeadReports(
  reports: readonly FusedHit[],
  windows: readonly FusedHit[],
  limit: number
): FusedHit[] {
  const seen = new Set<string>();
  const combined: FusedHit[] = [];
  for (const hit of [...reports, ...windows]) {
    if (combined.length >= limit) break;
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    combined.push(hit);
  }
  return combined;
}

function toFusedFromWindowChunk(
  chunk: RetrieveOutputEnvelope["chunks"][number]
): FusedHit {
  return {
    id: chunk.id,
    content: chunk.content,
    source_ref: chunk.source_ref,
    valid_window: chunk.valid_window,
    rrfScore: chunk.score,
    arms: [],
    ...(chunk.metadata !== undefined ? { metadata: chunk.metadata } : {}),
  };
}

/**
 * Invert `buildEnvelope`'s projection for reasons the B assembler already
 * bounded: every `DegradedReason` is by construction `<capability>:<state>`
 * over the registry keys, so the round trip cannot invent a reason.
 */
function observationFromReason(reason: DegradedReason): CapabilityObservation {
  const separator = reason.indexOf(":");
  return {
    capability: reason.slice(0, separator) as DegradedCapability,
    state: reason.slice(separator + 1) as CapabilityObservation["state"],
  };
}

/**
 * Single-slot memo for the one query text this arm embeds. Promise-cached,
 * so concurrent consumers share one provider call AND one failure — the
 * drop's B path sees the identical outcome instead of a second network
 * attempt. Other texts (none exist on this path) pass straight through.
 */
function memoizeQueryEmbedder(
  embedder: EmbeddingClient,
  query: string
): EmbeddingClient {
  let pending: Promise<number[][]> | undefined;
  return {
    ...(embedder.available === undefined
      ? {}
      : { available: embedder.available }),
    ...(embedder.modelId === undefined
      ? {}
      : { modelId: embedder.modelId }),
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 1 && texts[0] === query) {
        pending ??= embedder.embed(texts);
        return pending;
      }
      return embedder.embed(texts);
    },
  };
}
