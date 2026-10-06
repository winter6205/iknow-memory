/**
 * Structural screening contracts: the `structural-alternatives` ruleset, the
 * versioned relation catalog it screens against, and the candidate evidence it
 * publishes.
 *
 * Why these shapes are separate from any store: a candidate is immutable
 * evidence that a structural screen ran and found more than one tail for one
 * head and relation. It is deliberately NOT a verdict. Nothing here carries a
 * truth flag, a confidence score, a winner, or a rank, and no reader of this
 * module can derive one — a screen finds alternatives, and only an explicit
 * later decision may retire anything.
 */
import type {
  MaintenanceAttemptGuard,
  MaintenanceLiveInputs,
} from "./types.js";

/** The ruleset name the inherited specification fixes. */
export const STRUCTURAL_ALTERNATIVES_RULESET = "structural-alternatives";

/** The ruleset revision a candidate binds to its inputs. */
export const STRUCTURAL_ALTERNATIVES_REVISION = 1;

/**
 * The single normative spelling of "which ruleset produced this evidence".
 * Persistence and status both quote it, so a candidate can never be read back
 * without naming the ruleset that decided to publish it.
 */
export const SCREENING_RULESET_REVISION = `${STRUCTURAL_ALTERNATIVES_RULESET}:${STRUCTURAL_ALTERNATIVES_REVISION}`;

/**
 * What a published candidate does and does not cover. The value is fixed by the
 * inherited specification and is part of every candidate's identity: a reader
 * that sees it knows the candidate is structural screening only, with no
 * semantic adjudication, no extraction completeness and no routing verdict.
 */
export const SCREENING_COVERAGE = "structural_candidates_only";

/** The initial catalog version. The initial catalog is empty at this version. */
export const EMPTY_RELATION_CATALOG_VERSION = 0;

/**
 * What a relation catalog says about one relation. `unclassified` is the
 * absence of an entry, not an entry that says "unknown cardinality" — an
 * unclassified relation still yields potential alternatives.
 */
export type RelationCardinality = "multi_valued" | "exclusive";

/** One versioned catalog entry. The catalog itself is a whole version, never a row. */
export interface RelationCatalogEntry {
  readonly relationNorm: string;
  readonly cardinality: RelationCardinality;
}

/**
 * One immutable catalog version. A screen binds the version it screened with, so
 * a later catalog version cannot retroactively reclassify published evidence.
 */
export interface RelationCatalog {
  readonly version: number;
  readonly entries: readonly RelationCatalogEntry[];
}

/**
 * The catalog every screen starts from. It is empty by specification: no domain
 * cardinality is invented, so nothing is excluded by tail difference until an
 * explicit versioned entry says so.
 */
export function emptyRelationCatalog(): RelationCatalog {
  return Object.freeze({ version: EMPTY_RELATION_CATALOG_VERSION, entries: [] });
}

/**
 * A half-open validity interval `[lower, upper)`. A null bound is unknown and
 * unbounded in that direction; it is never read as zero and never as an
 * infinite value that could be compared arithmetically. Keeping the bound null
 * in the evidence is what preserves the uncertainty instead of resolving it.
 */
export interface ValidInterval {
  readonly lower: string | null;
  readonly upper: string | null;
}

/** One accepted relation assertion as the screen reads it. */
export interface ScreeningAssertion {
  /** The exact canonical head the grouping key uses; never a fuzzy match. */
  readonly headEntityId: string;
  /** The normalized relation; two spellings of one relation normalize here. */
  readonly relationNorm: string;
  /** The canonical tail entity identity. */
  readonly tailEntityId: string;
  /** The half-open validity interval; either bound may be null/unknown. */
  readonly interval: ValidInterval;
  /** The derived assertion identity this tuple registers. */
  readonly assertionId: string;
  /** The accepted supports currently publishing this assertion. */
  readonly supportIds: readonly string[];
  /** The extraction input revision each support's evidence came from. */
  readonly extractionRef: string;
  /** The published extraction revision the support is current at. */
  readonly extractionRevision: number;
  /** The input revision of the owning source, bound into candidate identity. */
  readonly inputRevision: string;
}

/**
 * Why a group produced no candidate. Every value is a structural fact about the
 * inputs; none of them is a claim about which assertion is correct.
 */
export const SCREENING_NON_CANDIDATE_REASONS = [
  "catalog_multi_valued",
  "identical_assertion",
  "single_distinct_tail",
  "disjoint_intervals",
  "adjacent_intervals",
] as const;

export type ScreeningNonCandidateReason =
  (typeof SCREENING_NON_CANDIDATE_REASONS)[number];

/**
 * The uncertainty a candidate records instead of resolving. A candidate whose
 * bounds are unknown says so; that is a stronger and more honest record than a
 * filled-in bound would be.
 */
export interface CandidateUncertainty {
  /** True when the contributing assertions have no known lower bound. */
  readonly unboundedLower: boolean;
  /** True when the contributing assertions have no known upper bound. */
  readonly unboundedUpper: boolean;
  /** The closed reason token bound into candidate identity. */
  readonly reason: string;
}

/**
 * The uncertainty reasons a screen can record. Both-null and one-null are
 * distinct records, because "no known start" and "no known end" are different
 * missing facts.
 */
export const SCREENING_UNCERTAINTY_REASONS = [
  "bounded_intervals",
  "null_lower_bound",
  "null_upper_bound",
  "null_validity_bounds",
] as const;

export type ScreeningUncertaintyReason =
  (typeof SCREENING_UNCERTAINTY_REASONS)[number];

/**
 * One published potential alternative.
 *
 * This record is deliberately verdict-free: it has no truth flag, no score, no
 * winner and no ordering between the tails beyond the sorted identity lists the
 * specification requires. Re-screening the same inputs yields the same
 * candidate id, and nothing in this shape can promote one tail over another.
 */
export interface StructuralCandidate {
  readonly candidateId: string;
  /** The screen that published this evidence. */
  readonly checkId: string;
  readonly rulesetRevision: string;
  readonly coverage: string;
  /** The exact canonical head all contributing assertions share. */
  readonly headEntityId: string;
  readonly relationNorm: string;
  /** Sorted assertion identities; part of the candidate's identity. */
  readonly assertionIds: readonly string[];
  /** The alternative tails, sorted; never ordered by preference. */
  readonly tailEntityIds: readonly string[];
  /** Sorted accepted supports that bind this candidate to real evidence. */
  readonly supportIds: readonly string[];
  /** Sorted `supportId@extractionRef` pairs: the support evidence revisions. */
  readonly supportRevisions: readonly string[];
  /** Sorted extraction revisions behind those supports. */
  readonly extractionRevisions: readonly number[];
  /** The per-assertion source input revisions the contributing rows were read at. */
  readonly assertionInputRevisions: readonly string[];
  /** The dependency-vector revision the screen was bound to. */
  readonly inputRevision: string;
  /** The catalog version the screen classified relations with. */
  readonly relationCatalogVersion: number;
  /** The retained uncertainty, never collapsed into a verdict. */
  readonly uncertainty: CandidateUncertainty;
  readonly publishedAt: string;
}

/** One structural fact explaining why a group produced no candidate. */
export interface ScreeningNonCandidate {
  readonly headEntityId: string;
  readonly relationNorm: string;
  readonly reason: ScreeningNonCandidateReason;
  /** The assertion identities that were screened and produced no candidate. */
  readonly assertionIds: readonly string[];
}

/** The immutable record of one completed structural check. */
export interface StructuralCheckRecord {
  readonly checkId: string;
  readonly scopeBinding: string;
  readonly jobKey: string;
  readonly sourceRef: string;
  readonly rulesetRevision: string;
  readonly coverage: string;
  readonly relationCatalogVersion: number;
  readonly relationBuckets: readonly string[];
  readonly inputRevision: string;
  readonly assertionCount: number;
  readonly candidateCount: number;
  readonly publishedAt: string;
}

/** The request that runs one structural screen under one guarded attempt. */
export interface StageStructuralScreenInput {
  /** The trusted authority this screen runs under; never parsed from input. */
  readonly context: AuthorizedScopeContextLike;
  /** The live `conflict_check` attempt that authorizes publishing. */
  readonly guard: MaintenanceAttemptGuard;
  /** The relation buckets this check covers, as scheduled. */
  readonly relationBuckets: readonly string[];
  /** The catalog version to classify relations with. */
  readonly relationCatalog: RelationCatalog;
  /**
   * An optional assertion-count ceiling for this check. The inherited
   * specification fixes no number, so none is defaulted: a deployment that has
   * a measured limit passes it, and a check that exceeds a supplied limit
   * refuses the whole check rather than publishing a partial result.
   */
  readonly maxAssertions?: number;
}

/**
 * The slice of the authorized-scope context this module needs. It is declared
 * structurally so the screening contract never imports a storage type, and the
 * runtime seam still rejects a context that trusted composition did not mint.
 */
export interface AuthorizedScopeContextLike {
  readonly actorId: string;
  readonly ownerScopeBinding: string;
  readonly readerBinding: string;
  readonly authorizedSourceRefs: readonly string[];
  readonly authorizationRevision: string;
  readonly deadlineAt: string;
}

/** The outcome of one completed screen. */
export interface StructuralScreenOutcome {
  readonly check: StructuralCheckRecord;
  /** Every alternative found; two or more tails each, and no winner. */
  readonly candidates: readonly StructuralCandidate[];
  readonly nonCandidates: readonly ScreeningNonCandidate[];
}

/** What a screen read before it published, kept for the fence verdicts. */
export interface ScreeningLiveFacts {
  /** The authoritative guard rebuilt from the live ledger row. */
  readonly actualGuard: MaintenanceAttemptGuard;
  /**
   * The fencing token the calling worker actually holds. It is a separate value
   * from the ledger row's token on purpose: a fence that compared the stored
   * token against itself would always pass, which is exactly what the fencing
   * token exists to prevent.
   */
  readonly presentedToken: string;
  /** The ledger's current status; only a running attempt may publish. */
  readonly jobStatus: string;
  /** Whether the attempt history row has already settled. */
  readonly attemptFinished: boolean;
  /** The live inputs the dependency vector is rebuilt from. */
  readonly liveInputs: MaintenanceLiveInputs;
  /** The instant the fences are evaluated at. */
  readonly now: Date;
}