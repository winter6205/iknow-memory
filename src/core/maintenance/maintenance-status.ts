/**
 * `M-STATUS`: the bounded maintenance summary a query returns beside its rows.
 *
 * Everything here is a pure function of one authorized read's own rows. There is
 * no second transaction, no cache and no adapter-private map, because the
 * specification's contract is that rows, count and this summary come from one
 * consistent authorized read snapshot — a summary assembled from a later read
 * could report a bucket the rows it accompanies were never counted against.
 *
 * The ten buckets are closed by the specification: `pending`, `running`,
 * `ready`, `failed` and `stale` for `desired_index`, and the same five for
 * `conflict_checks`. They are the durable-work vocabulary unchanged, because a
 * bucket is a job lifecycle observed against a source's current desired pair.
 */
import { StructuredScopeError } from "../storage/structured-scope-types.js";
import type {
  MaintenanceDependency,
  MaintenanceWorkKind,
  MaintenanceWorkStatus,
} from "./types.js";

/** The five buckets of the `desired_index` family. */
export const MAINTENANCE_DESIRED_INDEX_BUCKETS = [
  "pending",
  "running",
  "ready",
  "failed",
  "stale",
] as const;

export type MaintenanceBucket =
  (typeof MAINTENANCE_DESIRED_INDEX_BUCKETS)[number];

/** The five buckets of the `conflict_checks` family. */
export const MAINTENANCE_CONFLICT_CHECK_BUCKETS =
  MAINTENANCE_DESIRED_INDEX_BUCKETS;

/**
 * The closed normative structural ruleset and the coverage it can honestly
 * claim. Screening finds alternatives; it never adjudicates semantic truth and
 * never claims extraction completeness, so this coverage is the only one a
 * status may report.
 */
export const MAINTENANCE_RULESET_REVISION = "structural-alternatives:1";
export const MAINTENANCE_STRUCTURAL_COVERAGE = "structural_candidates_only";

export type MaintenanceBucketCounts = Readonly<
  Record<MaintenanceBucket, number>
>;

/**
 * The status object.
 *
 * `readRevision` is carried beside `maintenanceRevision` because the
 * specification gives them different jobs — progress moves only the maintenance
 * revision, while a change to current data, a decision or access moves the read
 * revision — and a reader cannot honour a cursor without being able to tell the
 * two apart on the object itself.
 */
export interface MaintenanceStatus {
  readonly maintenanceRevision: string;
  readonly readRevision: string;
  readonly sourcesInScope: number;
  readonly publishedSources: number;
  readonly desiredIndex: MaintenanceBucketCounts;
  readonly conflictChecks: MaintenanceBucketCounts;
  readonly rulesetRevision: string;
  readonly coverage: string;
}

/** One source row as the status needs it, shaped from the store's own rows. */
export interface MaintenanceStatusSource {
  readonly sourceRef: string;
  readonly sourceVersion: string | null;
  readonly active: boolean;
  readonly generation: number;
  readonly desired: {
    readonly sourceVersion: string;
    readonly extractionRevision: number;
    readonly configRevision?: string;
  } | null;
  readonly published: {
    readonly sourceVersion: string;
    readonly extractionRevision: number;
  } | null;
}

/** One work-ledger row as the status needs it, shaped from the store's rows. */
export interface MaintenanceStatusWork {
  readonly sourceRef: string;
  readonly workKind: MaintenanceWorkKind;
  readonly sourceVersion: string;
  readonly sourceGeneration: number;
  readonly configRevision: string;
  readonly status: MaintenanceWorkStatus;
  readonly dependencies: readonly MaintenanceDependency[];
}

/** One persisted structural check record this scope actually holds. */
export interface MaintenanceScreeningRecord {
  readonly sourceRef: string;
  readonly rulesetRevision: string;
  readonly coverage: string;
  /**
   * How many supports behind this source's checks an explicit decision made
   * non-current. Membership rows are private to the publication lane, so this is
   * how a retirement reaches a bucket without the status reading another lane's
   * private table.
   */
  readonly retiredSupports: number;
}

/** The authorized read a status is computed from, in one consistent snapshot. */
export interface MaintenanceStatusSnapshot {
  readonly maintenanceRevision: number;
  readonly readRevision: number;
  readonly sources: readonly MaintenanceStatusSource[];
  readonly work: readonly MaintenanceStatusWork[];
}

export interface MaintenanceStatusInputs {
  readonly snapshot: MaintenanceStatusSnapshot;
  readonly screening: readonly MaintenanceScreeningRecord[];
}

function statusUnavailable(detail: string): StructuredScopeError {
  return new StructuredScopeError(
    "maintenance_status_unavailable",
    `maintenance status is unavailable: ${detail}`
  );
}

function emptyCounts(): Record<MaintenanceBucket, number> {
  return { pending: 0, running: 0, ready: 0, failed: 0, stale: 0 };
}

function safeCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    // EXIT: a counter reached a value outside the safe integer range. The status
    // refuses rather than reporting a total a reader could not page against.
    throw statusUnavailable(`${field} is outside the safe integer range`);
  }
  return value;
}

/**
 * Whether the source's published pair IS its current desired pair.
 *
 * `published_sources` counts any usable published version, but a desired bucket
 * is about the desired pair specifically: a source that published v1 and then
 * declared v2 holds a usable published version and is still not ready.
 */
function coversDesired(source: MaintenanceStatusSource): boolean {
  const desired = source.desired;
  const published = source.published;
  if (desired === null || published === null) return false;
  return (
    published.sourceVersion === desired.sourceVersion &&
    published.extractionRevision === desired.extractionRevision
  );
}

/** The config/ruleset revision the source's current row carries, when it has one. */
function currentConfigRevision(source: MaintenanceStatusSource): string | null {
  const revision = source.desired?.configRevision;
  return typeof revision === "string" && revision !== "" ? revision : null;
}

/**
 * Whether a ledger record addresses the source's current desired pair.
 *
 * The job key already binds source version, generation, input revision and
 * config revision, so a record for an older pair is a different row that
 * survives beside the current one. Comparing the bound fields is what keeps a
 * settled `ready` record from being read as the current desired pair's status.
 */
function targetsDesiredPair(
  record: MaintenanceStatusWork,
  source: MaintenanceStatusSource
): boolean {
  const desired = source.desired;
  if (desired === null) return false;
  if (record.sourceVersion !== desired.sourceVersion) return false;
  if (record.sourceGeneration !== source.generation) return false;
  const config = currentConfigRevision(source);
  return config === null || record.configRevision === config;
}

/**
 * Whether a check record addresses the source's current published pair and its
 * current affected dependencies. The dependency entry naming this source is what
 * ties the check to the published extraction revision it actually screened.
 */
function targetsPublishedPair(
  record: MaintenanceStatusWork,
  source: MaintenanceStatusSource
): boolean {
  const published = source.published;
  if (published === null) return false;
  if (record.sourceVersion !== published.sourceVersion) return false;
  if (record.sourceGeneration !== source.generation) return false;
  const config = currentConfigRevision(source);
  if (config !== null && record.configRevision !== config) return false;
  return record.dependencies.some(
    (dependency) =>
      dependency.sourceRef === source.sourceRef &&
      dependency.generation === source.generation &&
      dependency.extractionRevision === published.extractionRevision
  );
}

/**
 * The record of one work kind that addresses the current target.
 *
 * The kind is part of the lookup rather than a filter applied afterwards: an
 * `extract_publish` record and a `conflict_check` record answer different
 * questions, so counting one of them as evidence about the other would make a
 * source with no check at all read as holding a stale one.
 */
function currentRecord(
  records: readonly MaintenanceStatusWork[],
  workKind: MaintenanceWorkKind,
  targets: (
    record: MaintenanceStatusWork,
    source: MaintenanceStatusSource
  ) => boolean,
  source: MaintenanceStatusSource
): { readonly current: MaintenanceStatusWork | null; readonly total: number } {
  const forSource = records.filter(
    (record) =>
      record.workKind === workKind && record.sourceRef === source.sourceRef
  );
  return {
    current: forSource.find((record) => targets(record, source)) ?? null,
    total: forSource.length,
  };
}

/**
 * The source's desired-index bucket: readiness of canonical structured
 * extraction and publication for its current desired pair.
 *
 * Only `extract_publish` records speak to extraction readiness — a rebuild is
 * not extraction, and a conflict check is not extraction — and a source with no
 * such record at all is genuinely pending, which is the specification's own
 * first-ingest-without-scheduled-work case.
 */
function desiredIndexBucket(
  source: MaintenanceStatusSource,
  records: readonly MaintenanceStatusWork[]
): MaintenanceBucket {
  if (source.desired === null) {
    // EXIT: an active scoped source carries no desired pair at all. The status
    // refuses rather than guessing a pending bucket for input nobody declared.
    throw statusUnavailable(
      `active source ${source.sourceRef} has no desired input to report`
    );
  }
  const { current, total } = currentRecord(
    records,
    "extract_publish",
    targetsDesiredPair,
    source
  );
  if (current === null) {
    return total === 0
      ? coversDesired(source)
        ? "ready"
        : "pending"
      : "stale";
  }
  if (current.status !== "ready") return current.status;
  // A record that settled ready while the source's desired pair is still not
  // published does not describe current state, so it reads stale rather than
  // reporting a readiness nothing is serving.
  return coversDesired(source) ? "ready" : "stale";
}

/**
 * The source's conflict-check bucket: checks targeting the current desired pair
 * and current affected dependencies.
 *
 * A check can only target a desired pair that reached readiness, so while the
 * desired bucket is anything else this stays pending — including when an older
 * published pair has a completed check behind it. That is what stops a pending
 * desired input from inheriting an old ready screen.
 */
function conflictCheckBucket(
  source: MaintenanceStatusSource,
  records: readonly MaintenanceStatusWork[],
  desiredBucket: MaintenanceBucket,
  retiredSupports: number
): MaintenanceBucket {
  if (desiredBucket !== "ready") return "pending";
  const { current, total } = currentRecord(
    records,
    "conflict_check",
    targetsPublishedPair,
    source
  );
  if (current === null) return total === 0 ? "pending" : "stale";
  if (current.status === "ready" && retiredSupports > 0) {
    // A decision retired support this check covered, so the check no longer
    // targets the current affected dependencies even though its ledger row is
    // still settled ready.
    return "stale";
  }
  return current.status;
}

/** The ruleset and coverage the persisted check records agree on, scope-wide. */
function observedRuleset(
  screening: readonly MaintenanceScreeningRecord[]
): { readonly rulesetRevision: string; readonly coverage: string } {
  const rulesets = new Set(screening.map((record) => record.rulesetRevision));
  const coverages = new Set(screening.map((record) => record.coverage));
  if (rulesets.size === 0) {
    // A scope that holds no check record has no observed ruleset; the status
    // reports the closed normative one, which is the ruleset this capability
    // runs under rather than a figure derived from a count.
    return {
      rulesetRevision: MAINTENANCE_RULESET_REVISION,
      coverage: MAINTENANCE_STRUCTURAL_COVERAGE,
    };
  }
  if (rulesets.size > 1 || coverages.size > 1) {
    // EXIT: two persisted check records in one authorized scope disagree on the
    // ruleset revision or the coverage. There is no single status that describes
    // both, so the status refuses instead of picking one.
    throw statusUnavailable(
      `persisted check records disagree: rulesets [${[...rulesets].sort().join(", ")}], coverages [${[...coverages].sort().join(", ")}]`
    );
  }
  return {
    rulesetRevision: [...rulesets][0]!,
    coverage: [...coverages][0]!,
  };
}

/** Retired supports per source, taken as any positive observation wins. */
function retiredSupportsBySource(
  screening: readonly MaintenanceScreeningRecord[]
): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const record of screening) {
    const observed = safeCount(record.retiredSupports, "retired support count");
    const held = totals.get(record.sourceRef) ?? 0;
    totals.set(record.sourceRef, Math.max(held, observed));
  }
  return totals;
}

function finalize(
  counts: Record<MaintenanceBucket, number>,
  sourcesInScope: number,
  field: string
): MaintenanceBucketCounts {
  const total = MAINTENANCE_DESIRED_INDEX_BUCKETS.reduce(
    (sum, bucket) => sum + counts[bucket],
    0
  );
  if (total !== sourcesInScope) {
    // EXIT: the bucket family does not account for exactly one bucket per
    // scoped source. The status refuses rather than serving a summary whose
    // totals disagree with the scope it describes.
    throw statusUnavailable(
      `${field} totals ${total} but the scope holds ${sourcesInScope} sources`
    );
  }
  return counts;
}

/**
 * Build the complete status from one authorized read.
 *
 * Each active scoped source contributes exactly one desired-index bucket and
 * exactly one conflict-check bucket, including a source with no indexed entities
 * and a source with no published version. An inactive or unauthorized source
 * contributes nothing, because it is not in the authorized active set at all.
 */
export function buildMaintenanceStatus(
  inputs: MaintenanceStatusInputs
): MaintenanceStatus {
  const { snapshot, screening } = inputs;
  const active = snapshot.sources.filter((source) => source.active);
  const visible = new Set(active.map((source) => source.sourceRef));
  const scopedWork = snapshot.work.filter((record) =>
    visible.has(record.sourceRef)
  );
  const scopedScreening = screening.filter((record) =>
    visible.has(record.sourceRef)
  );
  const retired = retiredSupportsBySource(scopedScreening);
  const desiredIndex = emptyCounts();
  const conflictChecks = emptyCounts();
  let publishedSources = 0;
  for (const source of active) {
    const desiredBucket = desiredIndexBucket(source, scopedWork);
    desiredIndex[desiredBucket] += 1;
    conflictChecks[
      conflictCheckBucket(
        source,
        scopedWork,
        desiredBucket,
        retired.get(source.sourceRef) ?? 0
      )
    ] += 1;
    if (source.published !== null) publishedSources += 1;
  }
  const ruleset = observedRuleset(scopedScreening);
  return Object.freeze({
    maintenanceRevision: String(snapshot.maintenanceRevision),
    readRevision: String(snapshot.readRevision),
    sourcesInScope: safeCount(active.length, "sources in scope"),
    publishedSources: safeCount(publishedSources, "published sources"),
    desiredIndex: finalize(desiredIndex, active.length, "desired_index"),
    conflictChecks: finalize(conflictChecks, active.length, "conflict_checks"),
    rulesetRevision: ruleset.rulesetRevision,
    coverage: ruleset.coverage,
  });
}