/**
 * The narrow evidence surface MP15's memory-lane delete store drives.
 *
 * The surface deliberately reads like the PG statements it twins rather than
 * like the backend's own maps: every member names one statement family, and
 * every count a member returns is that statement's row count. The backend
 * implements it; the store composes it. Keeping the contract in its own module
 * keeps `memory-backend.ts` free of maintenance-vocabulary imports it would
 * otherwise carry only for these names, and keeps the deps object the store
 * takes expressible as one port instead of a bag of loose members.
 *
 * **Derivation stays inside the implementation.** Every member is keyed on
 * `source_version_id` alone — the store never passes support ids, digests or
 * refs it derived elsewhere, because a caller-derived intermediate can drift
 * from the row the statement actually sees. The PG statements twin this by
 * joining from `source_version_id` in their own WHERE clauses (plan §Shared-
 * object key: every statement keyed on the version id, never on a hash).
 *
 * **A throw, not a refusal value.** These calls run INSIDE the store's
 * serialization slice, after the plan has decided; the decision's refusals are
 * `planCollectionDelete`'s `{refused, code, detail}` values. A failure here
 * (a version that vanished between the plan and the stamp) is not a decision
 * the plan could have made differently — it is the world moving under a
 * committed-facts read, so the implementation throws
 * `CollectionDeleteEvidenceError` with a `MAINTENANCE_WORK_FAILURE_CODES`
 * token the store re-raises in its own vocabulary.
 */
import type { CollectionDeletePhase } from "../maintenance/collection-delete.js";

/**
 * The facts one delete decides from, read under the caller's serialization.
 *
 * `bindingResolved: false` stands in for the version row being absent — the
 * plan refuses `unsupported_source_binding` on it, so no other field needs a
 * nullable shape. `liveRowGrants` carries the evidence refs of unexpired row
 * grants whose pins reach this payload (kind `row` only; the schema's arm
 * CHECK makes a count grant name no dependency structurally), for the plan's
 * spec:278 refusal and its detail.
 */
export interface CollectionDeleteFacts {
  readonly bindingResolved: boolean;
  readonly payloadCollected: boolean;
  readonly liveRowGrants: readonly string[];
}

/** The input of the facts read. `now` fixes the grant-expiry comparison. */
export interface CollectionDeleteFactsInput {
  readonly sourceVersionId: string;
  readonly now: Date;
}

/**
 * The one interface the backend implements for MP15's memory lane.
 */
export interface CollectionDeleteEvidenceSurface {
  /** The facts read: version row, supports and live grant pins, one walk. */
  readCollectionDeleteFacts(
    input: CollectionDeleteFactsInput
  ): Promise<CollectionDeleteFacts>;

  /**
   * One phase's DELETE, as its PG statement's row count. An unknown phase is
   * the closed-vocabulary guard failing at the boundary: thrown, not counted
   * as zero, so a silent no-op cannot masquerade as an empty row set.
   */
  deleteCollectionPhase(
    phase: CollectionDeletePhase,
    input: { readonly sourceVersionId: string }
  ): Promise<number>;

  /**
   * The two spec:312 live-reference counts on the "original content" columns,
   * excluding this version itself. Reported, never gating.
   */
  countSharedVersionReferences(
    sourceVersionId: string
  ): Promise<CollectionDeleteSharedReferences>;

  /** The terminal stamp; called after the last phase, never before. */
  collectSourceVersionPayload(
    sourceVersionId: string,
    at: string
  ): Promise<void>;

  /**
   * The version row's `payload_collected_at` stamp, read from the backend the
   * surface is implemented against — never from a store-private copy. The
   * store's own resume story depends on this: a store that restarts and reads
   * a stamp a *previous* store instance wrote must see it, so the read goes to
   * the shared backend rather than to anything the delete store owns. Null
   * means not collected; the plan's `payloadCollected` fact and this read are
   * two views of the same column, so they cannot disagree.
   */
  readPayloadCollectedAt(sourceVersionId: string): Promise<string | null>;
}

/**
 * The evidence-side failure: a typed maintenance code on an exception, for
 * facts the plan cannot be asked to decide about.
 */
export class CollectionDeleteEvidenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CollectionDeleteEvidenceError";
  }
}

/** The per-phase row counts the delete outcome reports. */
export type CollectionDeletePhaseCounts = Record<CollectionDeletePhase, number>;

/** The exact live-reference counts spec:312's accounting reports. */
export interface CollectionDeleteSharedReferences {
  readonly contentDigestReferences: number;
  readonly originObjectReferences: number;
}
