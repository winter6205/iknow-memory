/**
 * The entity-merge embedding budget: one lifecycle's handle on how many
 * merge-gate resolutions may embed (ADR-0013).
 *
 * The handle is three-state — unarmed, armed with a cap, counting — so an
 * owner that cannot pre-compute a cap value (the dashboard's maintenance lane)
 * can still thread one. `countResolution()` throws while unarmed, which is what
 * makes "no caller can run a merge with no budget" enforced rather than
 * intended: the counter is the only gate, and it refuses an undeclared one.
 *
 * `fork()` is how a long-lived deps object still yields per-lifecycle
 * counters: the handle on the deps owns budgets, each lifecycle takes its own,
 * so two concurrent runs never share `embed_calls` (no module state, no row).
 */
import { GraphragError } from "../errors.js";
import type { EmbeddingClient } from "../embedder.js";

/**
 * The public failure literal, already branched on by the seed classifier. A
 * cost breach and a staging-scope refusal share it: both ask the operator for
 * the same action, so the classifier needs one code.
 */
export const ENTITY_MERGE_EMBED_LIMIT = "ENTITY_MERGE_EMBED_LIMIT";

/** Base of the budget's typed refusals; `failureCode` is the wire literal. */
export class MergeBudgetError extends GraphragError {
  readonly failureCode = ENTITY_MERGE_EMBED_LIMIT;

  constructor(message: string) {
    // STORAGE_ERROR, never INVALID_INPUT: a budget refusal is the system
    // declining on cost, and the dashboard's shared map sends that to 503.
    super(message, "STORAGE_ERROR");
    this.name = "MergeBudgetError";
  }
}

/** A merge-gate resolution reached a budget that was never armed. */
export class MergeBudgetUnarmedError extends MergeBudgetError {
  constructor(message: string) {
    super(
      `${message}: a merge-gate resolution ran with an unarmed ` +
        `budget, so no cap was declared for this lifecycle`
    );
    this.name = "MergeBudgetUnarmedError";
  }
}

/** The (cap + 1)-th merge-gate resolution of one lifecycle. */
export class MergeEmbedLimitError extends MergeBudgetError {
  constructor(
    message: string,
    readonly embedCalls: number,
    readonly embedCap: number
  ) {
    super(message);
    this.name = "MergeEmbedLimitError";
  }
}

/** Phase E staged more output bytes than the lifecycle is allowed to hold. */
export class MergeStageScopeError extends MergeBudgetError {
  constructor(
    message: string,
    readonly stagedBytes: number,
    readonly stageMaxBytes: number
  ) {
    super(message);
    this.name = "MergeStageScopeError";
  }
}

export interface MergeEmbedBudgetSnapshot {
  /** null while the handle is unarmed. */
  readonly embedCap: number | null;
  readonly embedCalls: number;
}

export interface MergeEmbedBudget {
  /** Declare this lifecycle's cap. Legal at any time; it zero-counts. */
  arm(embedCap: number): void;
  /** Charge one merge-gate resolution; throws unarmed or past the cap. */
  countResolution(): void;
  /** What the log lines report. */
  snapshot(): MergeEmbedBudgetSnapshot;
  /** An independent budget for one lifecycle. */
  fork(): MergeEmbedBudget;
  /**
   * The per-resolution counting proxy handed to the merge context: one proxy
   * per resolution charges at most once, on its first `embed()`.
   */
  countingProxy(embedder: EmbeddingClient): EmbeddingClient;
}

export function createMergeEmbedBudget(): MergeEmbedBudget {
  let embedCap: number | null = null;
  let embedCalls = 0;
  const budget: MergeEmbedBudget = {
    arm(nextCap: number): void {
      embedCap = nextCap;
      embedCalls = 0;
    },
    countResolution(): void {
      if (embedCap === null) {
        throw new MergeBudgetUnarmedError("entity merge budget");
      }
      if (embedCalls >= embedCap) {
        throw new MergeEmbedLimitError(
          `entity-merge embed cap reached: ` +
            `embed_calls=${embedCalls} embed_cap=${embedCap}`,
          embedCalls,
          embedCap
        );
      }
      embedCalls += 1;
    },
    snapshot(): MergeEmbedBudgetSnapshot {
      return { embedCap, embedCalls };
    },
    fork(): MergeEmbedBudget {
      return createMergeEmbedBudget();
    },
    countingProxy(embedder: EmbeddingClient): EmbeddingClient {
      let charged = false;
      return {
        available: embedder.available,
        modelId: embedder.modelId,
        async embed(texts: string[]): Promise<number[][]> {
          if (!charged) {
            charged = true;
            // Charged before the request leaves, so a request that then fails
            // still counts and nothing is ever refunded.
            budget.countResolution();
          }
          return await embedder.embed(texts);
        },
      };
    },
  };
  return budget;
}
