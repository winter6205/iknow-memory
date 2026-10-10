/**
 * 档 A arm — lexical-first on in-window children, parent window is the
 * citable body (ADR-0060
 * "one window tree"; specs/search-mode-retrieve.md assumption 2, SC3).
 *
 * Shape of the answer:
 *   - ranking reuses the EXISTING lexical seam (`deps.lexical`, else a
 *     lexical-capable `deps.storage`) — the same BM25/ES precision layer B
 *     uses, so A never introduces a second ranker;
 *   - each ranked child resolves to its parent 抽图窗 through the ledger
 *     back-pointers (`chunks.source_doc_id` + `ordinal`, the single SoR
 *     per ADR-0010) via the optional `parentWindowsByChunkIds` seam. ES
 *     chunk docs stay parent-blind by design — the derived index needs no
 *     second copy of the pointer;
 *   - `chunks[]` carries the PARENT body keyed by the parent 资料 id; the
 *     contributing children survive only as span metadata (spec Open
 *     Question resolution: "A cite = parent body + optional child span
 *     metadata"), deduplicated to one entry per parent at the best child's
 *     rank (ADR-0060: the extract unit — the parent — is what enters the
 *     answer, not its search keys).
 *
 * Exit paths (never a child-only text masquerading as a parent):
 *   - no lexical seam at all        → `keyword_bm25:unattempted`;
 *   - lexical arm throws           → `keyword_bm25:attempted-and-failed`;
 *   - no parent seam               → `parent_window:unattempted`;
 *   - parent lookup throws         → `parent_window:attempted-and-failed`
 *     with an empty answer (no citable body can be produced);
 *   - some children unresolvable   → the resolvable parents still answer,
 *     marked `parent_window:attempted-and-failed` (fail-open partial, the
 *     same semantics `specs/retrieve-graph-priority.md` gives optional
 *     reads; a degraded envelope is how this repo names "ran and partly
 *     failed" while an error is how it names "no answer at all").
 *
 * `retrieveConfig.bm25Enabled` does NOT gate this arm: it switches the BM25
 * partner in B's hybrid fusion, whereas for A lexical search *is* the 档.
 */
import { ARM_CANDIDATE_POOL, buildEnvelope, observation } from "./index.js";
import type { AssembleArgs, AssembleDeps } from "./index.js";
import type { SearchModeArm } from "./search-mode.js";
import {
  supportsLexicalSearch,
  supportsParentWindows,
} from "../storage/backend.js";
import type { LexicalStorageBackend } from "../storage/backend.js";
import type { SearchOptions } from "../types.js";
import type { RetrievedChunk } from "../types.js";
import type {
  FusedHit,
  ParentWindowRow,
  RetrieveHitMetadata,
} from "./types.js";

/** The parent-window metadata member, narrowed for in-place accumulation. */
type ParentWindowMeta = Extract<
  RetrieveHitMetadata,
  { kind: "parent-window" }
>;

export const modeAParentWindowArm: SearchModeArm = async function assembleModeAParentWindows(
  args: AssembleArgs,
  deps: AssembleDeps
) {
  const lexical = pickLexical(deps);
  if (lexical === undefined) {
    // EXIT: A is lexical-first; with no BM25 seam there is no arm to run.
    return buildEnvelope(
      [],
      [observation("keyword_bm25", "unattempted")],
      undefined
    );
  }

  // Fetch deeper than `limit` for the same reason the fused arms do: several
  // children collapse to one parent, so `limit` children could answer fewer
  // than `limit` parents. The cut to `args.limit` happens after dedup.
  const children = await rankChildren(lexical, args);
  if (children === undefined) {
    // EXIT: the lexical arm ran and threw — a named failure, not a crash.
    return buildEnvelope(
      [],
      [observation("keyword_bm25", "attempted-and-failed")],
      undefined
    );
  }
  if (children.length === 0) {
    // A found-nothing lexical miss is a healthy empty answer: the arm ran
    // and delivered (same rule as B's zero-hit BM25 arm).
    return buildEnvelope([], [], undefined);
  }

  if (!supportsParentWindows(deps.storage)) {
    // EXIT: without the ledger seam A can only cite children as parents —
    // exactly the failure ADR-0060 forbids. Name it, answer nothing.
    return buildEnvelope(
      [],
      [observation("parent_window", "unattempted")],
      undefined
    );
  }
  let rows: ParentWindowRow[];
  try {
    rows = await deps.storage.parentWindowsByChunkIds(
      children.map((child) => child.id)
    );
  } catch {
    // EXIT: the lookup itself failed — no parent body exists to return, so
    // an empty degraded envelope is the only honest shape.
    return buildEnvelope(
      [],
      [observation("parent_window", "attempted-and-failed")],
      undefined
    );
  }

  const { hits, missingParent } = collapseChildrenToParents(children, rows);
  return buildEnvelope(
    hits.slice(0, args.limit),
    missingParent
      ? [observation("parent_window", "attempted-and-failed")]
      : [],
    undefined
  );
};

/** Mirror B's arm selection: the wired precision layer wins over storage. */
function pickLexical(
  deps: AssembleDeps
): LexicalStorageBackend | undefined {
  if (deps.lexical !== undefined) return deps.lexical;
  return supportsLexicalSearch(deps.storage) ? deps.storage : undefined;
}

/**
 * Ranked children, or `undefined` when the arm was attempted and failed —
 * the caller maps both empty-vs-failed apart so a zero-hit stay un-degraded.
 */
async function rankChildren(
  lexical: LexicalStorageBackend,
  args: AssembleArgs
): Promise<RetrievedChunk[] | undefined> {
  const searchOpts: SearchOptions = {
    limit: Math.max(args.limit, ARM_CANDIDATE_POOL),
    validAt: args.validAt,
    ...(args.filters !== undefined ? { filters: args.filters } : {}),
  };
  try {
    return await lexical.searchLexical(args.query, searchOpts);
  } catch {
    return undefined;
  }
}

/**
 * Dedup children into one parent entry each, preserving child-rank order:
 * the first (best) child fixes the parent's position and score, later
 * children only add span metadata. Children whose parent row is missing are
 * skipped and flip `missingParent` — they never surface as child-only hits.
 */
function collapseChildrenToParents(
  children: readonly RetrievedChunk[],
  rows: readonly ParentWindowRow[]
): { hits: FusedHit[]; missingParent: boolean } {
  const rowByChild = new Map(rows.map((row) => [row.chunk_id, row]));
  const byParent = new Map<string, { hit: FusedHit; spans: ParentWindowMeta }>();
  let missingParent = false;

  for (const child of children) {
    const row = rowByChild.get(child.id);
    if (row === undefined) {
      missingParent = true;
      continue;
    }
    const span = {
      chunkId: child.id,
      ordinal: row.ordinal,
      score: child.score,
    };
    const existing = byParent.get(row.source_doc_id);
    if (existing !== undefined) {
      existing.spans.children.push(span);
      continue;
    }
    const metadata: ParentWindowMeta = {
      kind: "parent-window",
      sourceDocId: row.source_doc_id,
      children: [span],
    };
    byParent.set(row.source_doc_id, {
      hit: {
        // The citation key is the parent 资料 id (ADR-0060: "extract,
        // provenance, and the citable body after a hit all use that id").
        id: row.source_doc_id,
        content: row.content,
        // The child's locator and in-window slice are its own evidence
        // coordinates; the parent row carries no separate valid_from.
        source_ref: child.source_ref,
        valid_window: child.valid_window,
        rrfScore: child.score,
        arms: ["bm25"],
        metadata,
      },
      spans: metadata,
    });
  }

  return { hits: [...byParent.values()].map((entry) => entry.hit), missingParent };
}
