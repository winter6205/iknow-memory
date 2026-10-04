/**
 * Maintenance work application layer (specs/maintenance-durable-work.md).
 *
 * Policy lives here, persistence lives in the store: which requests are valid,
 * which failures may retry, and what a worker does after losing its attempt.
 * Both store implementations are therefore interchangeable, and the rules are
 * provable against the memory twin without a database.
 */
import {
  canonicalDependencyRevision,
  computeMaintenanceJobKey,
  hasInitiatingDependency,
  isMaintenanceWorkKind,
} from "./durable-work.js";
import {
  type MaintenanceAttemptGuard,
  type MaintenanceFailure,
  type MaintenanceJobRecord,
  type MaintenanceWorkFailureCode,
  type MaintenanceLiveInputs,
  type MaintenanceReclaimOutcome,
  type MaintenanceScheduleOutcome,
  type MaintenanceSettleOutcome,
  type MaintenanceSettleResult,
  type MaintenanceWorkDeps,
  type MaintenanceWorkRequest,
} from "./types.js";

/** Who asked for the work. An unnamed actor is refused, never guessed. */
export interface MaintenanceCaller {
  readonly actorId: string;
}

/**
 * Validate and schedule one job.
 *
 * Refusal is a typed value rather than a thrown error, because a bad request is
 * an expected outcome of a public entry: the caller must be able to tell
 * `invalid_input` from `access_denied` without parsing a message. Nothing here
 * writes anything on the refusal path — an invalid request leaves canonical
 * state unchanged.
 */
export async function scheduleWork(
  deps: MaintenanceWorkDeps,
  caller: MaintenanceCaller,
  request: MaintenanceWorkRequest
): Promise<MaintenanceScheduleOutcome> {
  if (caller.actorId.trim().length === 0) {
    return { refused: "access_denied", detail: "actorId is required" };
  }
  const invalid = findInvalidField(request);
  if (invalid) {
    return { refused: "invalid_input", detail: invalid };
  }
  return deps.store.scheduleWork(request, deps.clock());
}

/**
 * The worker loop step: reclaim whatever lost its lease, then take the oldest
 * claimable job. Reclaim runs first and separately because a claim must never
 * race the reclaim that invalidates the old token — otherwise two workers could
 * both consider themselves the owner of a job whose previous attempt died.
 */
export async function claimNextWork(
  deps: MaintenanceWorkDeps
): Promise<{
  readonly guard: MaintenanceAttemptGuard | null;
  readonly reclaimed: readonly MaintenanceReclaimOutcome[];
}> {
  const now = deps.clock();
  const reclaimed = await deps.store.reclaimExpiredWork(now);
  const guard = await deps.store.claimWork(now);
  return { guard, reclaimed };
}

/**
 * Publish a terminal outcome, or report that this worker no longer owns the
 * attempt. A `lease_lost` verdict must never be converted into a reported
 * success by the caller; it is returned so the caller stops.
 */
export async function settleWork(
  deps: MaintenanceWorkDeps,
  guard: MaintenanceAttemptGuard,
  outcome: MaintenanceSettleOutcome,
  live: MaintenanceLiveInputs
): Promise<MaintenanceSettleResult | MaintenanceFailure> {
  if (!Array.isArray(live?.dependencies)) {
    return refused("invalid_input", "live.dependencies must be an array");
  }
  if (typeof live.configRevision !== "string" || live.configRevision.length === 0) {
    return refused("invalid_input", "live.configRevision is required");
  }
  return deps.store.settleWork(guard, outcome, live, deps.clock());
}

/**
 * Operator retry: a new attempt with a fresh automatic budget, history intact.
 *
 * A job that is not `failed` or `stale` is refused as `invalid_input` rather
 * than answered with the unchanged row, so "retry did nothing" can never be
 * mistaken for "retry happened".
 */
export async function retryWork(
  deps: MaintenanceWorkDeps,
  jobKey: string
): Promise<MaintenanceJobRecord | MaintenanceFailure | null> {
  if (typeof jobKey !== "string" || jobKey.trim().length === 0) {
    return refused("invalid_input", "jobKey is required");
  }
  return deps.store.retryWork(jobKey, deps.clock());
}

function refused(code: MaintenanceWorkFailureCode, detail: string): MaintenanceFailure {
  return { refused: true, code, detail };
}

/** The bound inputs a worker must re-read before settling. */
export function liveInputsOf(
  configRevision: string,
  dependencies: MaintenanceWorkRequest["dependencies"]
): MaintenanceLiveInputs {
  return { configRevision, dependencies };
}

export { canonicalDependencyRevision, computeMaintenanceJobKey };

function findInvalidField(request: MaintenanceWorkRequest): string | null {
  const invalidIdentity = invalidIdentityField(request);
  if (invalidIdentity) return invalidIdentity;
  const invalidDependency = invalidDependencyField(request.dependencies);
  if (invalidDependency) return invalidDependency;
  return hasInitiatingDependency(
    request.dependencies,
    request.sourceRef,
    request.sourceGeneration
  )
    ? null
    : "dependencies must include the initiating sourceRef and sourceGeneration";
}

function invalidIdentityField(request: MaintenanceWorkRequest): string | null {
  if (!isMaintenanceWorkKind(request.workKind)) {
    return "workKind must be a supported maintenance work kind";
  }
  const empty = [
    [request.sourceRef, "sourceRef"],
    [request.sourceVersion, "sourceVersion"],
    [request.configRevision, "configRevision"],
  ].find(([value]) => String(value).trim().length === 0);
  if (empty) return `${empty[1]} is required`;
  if (!isNonNegativeInteger(request.sourceGeneration)) {
    return "sourceGeneration must be a non-negative integer";
  }
  return null;
}

function invalidDependencyField(
  dependencies: MaintenanceWorkRequest["dependencies"]
): string | null {
  if (!Array.isArray(dependencies) || dependencies.length === 0) {
    return "dependencies must list at least the initiating source";
  }
  for (const dependency of dependencies) {
    if (dependency.sourceRef.trim().length === 0) {
      return "dependency.sourceRef is required";
    }
    if (!isNonNegativeInteger(dependency.generation)) {
      return "dependency.generation must be a non-negative integer";
    }
    const invalid = invalidExtractionRevision(dependency.extractionRevision);
    if (invalid) return invalid;
    if (!Array.isArray(dependency.relationBuckets)) {
      return "dependency.relationBuckets must be an array";
    }
  }
  return null;
}

function invalidExtractionRevision(value: number | null): string | null {
  if (value === null) return null;
  return isNonNegativeInteger(value)
    ? null
    : "dependency.extractionRevision must be a non-negative integer or null";
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}
