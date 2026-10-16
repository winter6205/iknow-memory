/**
 * Review-lane actions over failed `extraction_records`.
 *
 * A judge failure seals a chunk as `failed` while keeping the FULL
 * proposal on the record (`proposed_payload`). The operator then has three
 * advances, all riding the same maintenance lane `listFailed()` shows:
 *
 *   - `promoteRecord`: replay the held proposal through the SAME
 *     `persistOutputs` + `emitProjectionIntents` functions the batch uses, in
 *     one transaction, and retire the record to `succeeded` — no extractor
 *     dial, the operator's "yes" IS the grounding decision.
 *   - `discardRecord`: stamp `discarded_at` so the row leaves the failed list
 *     while staying readable in the ledger. A status vocabulary entry was not
 *     chosen: `extraction_records.status` is a closed CHECK and re-writing it
 *     would reinterpret past runs; the nullable stamp column is additive.
 *   - re-extract: the existing `--only-failed` runner, unchanged — it simply
 *     never sees a discarded row and re-dials the judge for the rest.
 *
 * Both actions refuse typed (`INVALID_INPUT`) with zero writes when the
 * record is not a live failed proposal; the graph is never half-touched.
 */
import { GraphragError } from "../errors.js";
import { emitProjectionIntents } from "../storage/projection-outbox.js";
import {
  MergeBudgetError,
  type MergeEmbedBudget,
} from "../entities/merge-budget.js";
import {
  depsNow,
  deriveMergeEmbedCap,
  persistOutputs,
  type ExtractPersistDeps,
} from "./persist.js";
import { ProposalPayloadSchema } from "./judge.js";
import {
  commitSelfLoopRejection,
  demoteCommunityIndexState,
} from "./pipeline.js";
import {
  markSucceeded,
  SELF_LOOP_REJECTED_CODE,
  type Queryable,
} from "./records.js";

/** Typed refusal of a promote on a record that cannot advance. */
export class PromotionRefusedError extends GraphragError {
  constructor(message: string) {
    super(message, "INVALID_INPUT");
    this.name = "PromotionRefusedError";
  }
}

/** Typed refusal of a discard on a record that cannot be discarded. */
export class DiscardRefusedError extends GraphragError {
  constructor(message: string) {
    super(message, "INVALID_INPUT");
    this.name = "DiscardRefusedError";
  }
}

/** The by-id pre-read shape `discardRecord` guards on. */
interface DiscardProbe {
  id: string;
  status: string;
  discarded_at: string | null;
}

/**
 * Stamp a failed record as discarded: the ONLY write, idempotent, and the
 * graph (triples / outbox / Neo4j) stays exactly as it was — nothing is
 * replayed and nothing is deleted.
 */
export async function discardRecord(
  client: Queryable,
  recordId: string
): Promise<void> {
  const { rows } = await client.query(
    `SELECT id, status, discarded_at FROM extraction_records WHERE id = $1`,
    [recordId]
  );
  const row: DiscardProbe | undefined = rows[0];
  if (row === undefined) {
    throw new DiscardRefusedError(
      `extraction record not found: ${recordId}`
    );
  }
  // Already discarded: the operator said no once — a second --discard is a
  // no-op, not an error and not a second stamp.
  if (row.discarded_at !== null) return;
  if (row.status !== "failed") {
    throw new DiscardRefusedError(
      `only failed records can be discarded (record ${recordId} is '${row.status}')`
    );
  }
  // The WHERE guard closes the read-then-write race: a concurrent promote
  // that succeeded first makes this a no-op instead of discarding a
  // retired record.
  await client.query(
    `UPDATE extraction_records SET discarded_at = now() WHERE id = $1 AND discarded_at IS NULL`,
    [recordId]
  );
}

/** The locked record row `promoteRecord` reads before replaying. */
interface PromotionRecord {
  id: string;
  chunk_id: string | null;
  status: string;
  discarded_at: string | null;
  proposed_payload: unknown;
}

/**
 * Replay one sealed proposal into the graph.
 *
 * Transaction: BEGIN → SELECT … FOR UPDATE (the row lock serialises a
 * concurrent promote/discard against this same record row — a re-extract
 * inserts a NEW record and never contends here) → guards → `persistOutputs`
 * → `emitProjectionIntents` (+ C-state demotion when graph rows were
 * written) → markSucceeded → COMMIT. A throw anywhere rolls the whole thing
 * back and rethrows — the record stays `failed` and can be retried.
 *
 * Deliberate skips vs the batch path, all consequences of "the extractor is
 * never dialed": no enrichment (standard-run descriptions/claims need the
 * LLM), no method-version claim (the payload records what produced it), and
 * no ES precision mirror. NOT equivalent to a batch success: promoted facts
 * reach the graph/outbox only — the ES precision mirror catches up via the
 * existing `es:reindex` repair path.
 *
 * This is its own single-record lifecycle (ADR-0013): no extract stage, no
 * page loop, and no phase E — the sealed `proposed_payload` IS the pre-merge
 * population. It is budgeted by the SAME cap derivation with `N = 1`, armed
 * after the payload is parsed and before `persistOutputs` can resolve
 * anything. A breach rolls this transaction back and re-throws: it is a
 * retryable cost refusal, NOT the promotion's permanent SELF_LOOP_REJECTED.
 */
export async function promoteRecord(
  deps: ExtractPersistDeps,
  client: Queryable,
  recordId: string
): Promise<void> {
  await client.query("BEGIN", []);
  // Read by the completion / breach log lines; null until the chunk answers.
  let promoteSourceRef: string | null = null;
  let promoteBudget: MergeEmbedBudget | null = null;
  try {
    const { rows } = await client.query(
      `SELECT id, chunk_id, status, discarded_at, proposed_payload FROM extraction_records WHERE id = $1 FOR UPDATE`,
      [recordId]
    );
    const record: PromotionRecord | undefined = rows[0];
    if (record === undefined) {
      throw new PromotionRefusedError(
        `extraction record not found: ${recordId}`
      );
    }
    if (record.status !== "failed") {
      throw new PromotionRefusedError(
        `only failed records can be promoted (record ${recordId} is '${record.status}')`
      );
    }
    if (record.discarded_at !== null) {
      throw new PromotionRefusedError(
        `record ${recordId} was discarded; re-extract the chunk instead`
      );
    }
    if (record.proposed_payload === null || record.proposed_payload === undefined) {
      throw new PromotionRefusedError(
        `record ${recordId} has no proposed_payload to replay (only judge-sealed failures carry one)`
      );
    }
    const parsed = ProposalPayloadSchema.safeParse(record.proposed_payload);
    if (!parsed.success) {
      throw new PromotionRefusedError(
        `record ${recordId} has an unreadable proposed_payload: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`
      );
    }
    if (record.chunk_id === null) {
      throw new PromotionRefusedError(
        `the chunk of record ${recordId} no longer exists (its row was deleted)`
      );
    }
    const chunkRows = await client.query(
      `SELECT id, content, source_ref FROM chunks c WHERE c.id = $1`,
      [record.chunk_id]
    );
    const chunk:
      | { id: string; content: string; source_ref: string | null }
      | undefined = chunkRows.rows[0];
    if (chunk === undefined) {
      throw new PromotionRefusedError(
        `the chunk of record ${recordId} no longer exists (its row was deleted)`
      );
    }
    // One lifecycle, one cap, armed before the first merge resolution. Same
    // formula and same derivation as the extract lifecycle — N = 1 because
    // this commits exactly the one chunk it read.
    promoteSourceRef = chunk.source_ref;
    promoteBudget = deps.mergeBudget.fork();
    promoteBudget.arm(deriveMergeEmbedCap(parsed.data.triples, 1).embedCap);
    const counts = await persistOutputs(
      { ...deps, mergeBudget: promoteBudget },
      client,
      chunk.id,
      chunk.content,
      parsed.data.triples,
      depsNow(deps)
    );
    if (counts.allSelfLoop) {
      // The payload replays into zero graph edges — that is the batch's
      // permanent-reject outcome, so it lands here too: SELF_LOOP_REJECTED
      // keeps the row out of listFailed / --only-failed instead of faking a
      // zero-triple success.
      await commitSelfLoopRejection(client, recordId, deps.logger, {
        name: "promote-record-rejected",
        fields: {
          record: recordId,
          chunk: chunk.id,
          code: SELF_LOOP_REJECTED_CODE,
        },
      });
      return;
    }
    // Same transaction as the ledger rows they describe (SC3 posture): the
    // projector must never be told to sync rows this commit may roll back.
    await emitProjectionIntents(client, counts.projected);
    if (counts.projected.length > 0) {
      await demoteCommunityIndexState(client);
    }
    await markSucceeded(client, recordId, {
      triplesCount: counts.triples,
      unmappedCount: counts.unmapped,
    });
    await client.query("COMMIT", []);
    const budget = promoteBudget?.snapshot() ?? { embedCap: null, embedCalls: 0 };
    deps.logger.info("promote-record-complete", {
      record: recordId,
      chunk: chunk.id,
      triples: counts.triples,
      unmapped: counts.unmapped,
      // The same three fields the extract lifecycle logs, so one reader
      // parses a cap on a run that did not breach (ADR-0013 Decision 7).
      source_ref: chunk.source_ref,
      embed_cap: budget.embedCap,
      embed_calls: budget.embedCalls,
    });
  } catch (err) {
    await client.query("ROLLBACK", []);
    if (err instanceof MergeBudgetError) {
      const budget = promoteBudget?.snapshot() ?? {
        embedCap: null,
        embedCalls: 0,
      };
      deps.logger.error("entity-merge-embed-limit", {
        source_ref: promoteSourceRef,
        embed_calls: budget.embedCalls,
        embed_cap: budget.embedCap,
      });
    }
    throw err;
  }
}
