/**
 * Durable maintenance work — pure key derivation, retry schedule, and attempt
 * fencing (specs/maintenance-durable-work.md).
 *
 * Everything here is a function of its arguments plus an injected instant: no
 * `Date.now()`, no storage, no I/O. That is what lets the store implement the
 * same rule for Postgres and the memory twin, and what lets a fake clock prove
 * the 5s/30s retry ladder and the 5-minute lease without sleeping.
 */
import { createHash } from "node:crypto";

import {
  MAINTENANCE_WORK_KINDS,
  MAX_AUTO_ATTEMPTS,
  RETRY_DELAY_MS,
  WORK_ABSOLUTE_LIMIT_MS,
  WORK_LEASE_MS,
  type MaintenanceAttemptGuard,
  type MaintenanceDependency,
  type MaintenanceGuardVerdict,
  type MaintenanceLiveInputs,
  type MaintenanceWorkRequest,
  type MaintenanceWorkFailureCode,
  type MaintenanceWorkStatus,
  type MaintenanceSettleOutcome,
} from "./types.js";

/**
 * Digest of the canonical sorted dependency vector.
 *
 * Sorting by source ref and then by the rest of the tuple makes the revision a
 * property of the SET of dependencies, not of the order a caller happened to
 * pass them in; relation buckets are sorted and deduplicated for the same
 * reason. A missing extraction revision stays `null` rather than collapsing to
 * `0`, because "no accepted extraction yet" and "extraction revision zero" are
 * different worlds and must not share a revision.
 */
export function canonicalDependencyRevision(
  dependencies: readonly MaintenanceDependency[]
): string {
  const canonical = dependencies
    .map((dependency) => ({
      sourceRef: dependency.sourceRef,
      generation: dependency.generation,
      extractionRevision: dependency.extractionRevision,
      relationBuckets: [...new Set(dependency.relationBuckets)].sort(),
    }))
    .sort((left, right) => {
      if (left.sourceRef !== right.sourceRef) {
        return left.sourceRef < right.sourceRef ? -1 : 1;
      }
      if (left.generation !== right.generation) return left.generation - right.generation;
      const leftExtraction = left.extractionRevision ?? -1;
      const rightExtraction = right.extractionRevision ?? -1;
      if (leftExtraction !== rightExtraction) return leftExtraction - rightExtraction;
      return compareStrings(left.relationBuckets, right.relationBuckets);
    });

  return digest(canonical);
}

/** Whether a dependency vector contains the job's initiating source generation. */
export function hasInitiatingDependency(
  dependencies: readonly MaintenanceDependency[],
  sourceRef: string,
  sourceGeneration: number
): boolean {
  return dependencies.some(
    (dependency) =>
      dependency.sourceRef === sourceRef &&
      dependency.generation === sourceGeneration
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * Derive the job key. Every bound field of the request participates, so a
 * request that differs in work kind, source version, generation, dependency
 * vector, or config/ruleset revision addresses a different logical job and
 * cannot join an existing one.
 *
 * UUID-shaped like `computeChunkId`, for the same reason: a retry must address
 * the same row, so no random state may enter the derivation.
 */
export function computeMaintenanceJobKey(request: MaintenanceWorkRequest): string {
  const bytes = Buffer.from(
    JSON.stringify([
      request.workKind,
      request.sourceRef,
      request.sourceVersion,
      request.sourceGeneration,
      canonicalDependencyRevision(request.dependencies),
      request.configRevision,
    ]),
    "utf8"
  );
  const digestBytes = createHash("sha256").update(bytes).digest();
  digestBytes[6] = (digestBytes[6]! & 0x0f) | 0x40;
  digestBytes[8] = (digestBytes[8]! & 0x3f) | 0x80;
  const hex = digestBytes.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * Delay before the attempt that follows `attemptNumber`, or null when the
 * automatic budget is spent. The ladder is the spec's two fixed delays; an
 * attempt number outside `[1, MAX_AUTO_ATTEMPTS]` has no delay at all, so a
 * caller cannot buy extra retries by passing a larger number.
 */
export function nextRetryDelayMs(attemptNumber: number): number | null {
  if (!Number.isInteger(attemptNumber)) return null;
  if (attemptNumber < 1 || attemptNumber > MAX_AUTO_ATTEMPTS) return null;
  return RETRY_DELAY_MS[attemptNumber - 1] ?? null;
}

/**
 * Whether a failure may be retried automatically. Only backend unavailability
 * is transient here: validation and config failures must surface immediately,
 * and `resource_exhausted` stays a visible typed failure rather than being
 * retried into an empty result.
 */
export function isTransientFailureCode(
  code: string
): code is "backend_unavailable" {
  return code === "backend_unavailable";
}

export function leaseExpiryFrom(startedAt: string): string {
  return new Date(
    new Date(startedAt).getTime() + WORK_LEASE_MS
  ).toISOString();
}

export function absoluteDeadlineFrom(startedAt: string): string {
  return new Date(
    new Date(startedAt).getTime() + WORK_ABSOLUTE_LIMIT_MS
  ).toISOString();
}

/**
 * Decide whether this attempt still OWNS its job: the presented token must be
 * the live one, the lease must not have run out, and the absolute attempt bound
 * must not have passed.
 *
 * This is the half a heartbeat can check — a heartbeat carries no re-read of
 * canonical lifecycle state, so it verifies ownership and nothing more. The
 * bound-input half lives in `verifyAttemptGuard`.
 *
 * The absolute bound is checked before the lease expiry, and heartbeat clamps
 * the lease to that same deadline: without this order an attempt that ran its
 * full thirty minutes would report a reclaimed lease, when in fact nothing
 * reclaimed it and the attempt simply ran out of time.
 */
export function verifyAttemptOwnership(
  guard: MaintenanceAttemptGuard,
  now: Date,
  presentedToken: string
): MaintenanceGuardVerdict {
  const nowMs = now.getTime();
  const leaseMs = new Date(guard.leaseExpiresAt).getTime();
  const attemptStartMs = new Date(guard.attemptStartedAt).getTime();

  if (presentedToken !== guard.fencingToken) return { ok: false, code: "lease_lost" };
  if (attemptStartMs + WORK_ABSOLUTE_LIMIT_MS <= nowMs) {
    return { ok: false, code: "execution_timeout" };
  }
  // `>=`, matching the SQL's `lease_expires_at > $now`: the instant the lease
  // expires is already outside it, so the twins must not disagree at the
  // boundary.
  if (Number.isNaN(leaseMs) || nowMs >= leaseMs) return { ok: false, code: "lease_lost" };
  return { ok: true };
}

/**
 * Decide whether one write from this attempt is allowed, and if not, why.
 *
 * Ownership is checked before the inputs, because a worker that already lost its
 * attempt has no standing to judge staleness — the reclaiming worker owns that
 * job now. The absolute bound is checked before the lease expiry so a heartbeat
 * loop cannot extend an attempt past thirty minutes by renewing forever.
 *
 * `presentedToken` is required rather than defaulted: a fence that compares the
 * stored token against itself always passes, which is precisely the bug the
 * fencing token exists to prevent. The caller passes the token its worker
 * actually holds; the store passes the token the row currently carries.
 */
export function verifyAttemptGuard(
  guard: MaintenanceAttemptGuard,
  live: MaintenanceLiveInputs,
  now: Date,
  presentedToken: string
): MaintenanceGuardVerdict {
  const ownership = verifyAttemptOwnership(guard, now, presentedToken);
  if (!ownership.ok) return ownership;
  if (
    !hasInitiatingDependency(
      live.dependencies,
      guard.sourceRef,
      guard.sourceGeneration
    )
  ) {
    return { ok: false, code: "input_stale" };
  }
  if (live.configRevision !== guard.configRevision) {
    return { ok: false, code: "input_stale" };
  }
  if (canonicalDependencyRevision(live.dependencies) !== guard.inputRevision) {
    return { ok: false, code: "input_stale" };
  }
  return { ok: true };
}

/** Whether this request names a supported work kind. */
export function isMaintenanceWorkKind(
  value: string
): value is MaintenanceWorkRequest["workKind"] {
  return (MAINTENANCE_WORK_KINDS as readonly string[]).includes(value);
}

/**
 * What a settled attempt does to the job row.
 *
 * `status` is already the value to persist: a transient failure with budget left
 * promotes to `pending` here rather than in each store, so the two implementations
 * cannot disagree about when a failed attempt becomes a scheduled retry.
 */
export interface MaintenanceSettlePlan {
  readonly status: MaintenanceWorkStatus;
  /** Delay before the next automatic attempt, or null when none is scheduled. */
  readonly nextDelayMs: number | null;
  readonly lastFailureCode: MaintenanceWorkFailureCode | null;
}

/**
 * Decide a settled attempt's effect on the job row. Both store implementations
 * call this, so the retry ladder and the exhaustion rule cannot drift apart
 * between Postgres and the memory twin.
 *
 * A transient failure retries while the automatic budget holds and settles
 * `failed` once it does not; every other failure settles `failed` immediately,
 * because a validation or config failure must surface rather than loop.
 */
export function planSettle(
  autoAttemptCount: number,
  maxAttempts: number,
  outcome: MaintenanceSettleOutcome
): MaintenanceSettlePlan {
  if (outcome.status === "failed") {
    const retryable =
      isTransientFailureCode(outcome.failureCode) &&
      autoAttemptCount < maxAttempts;
    return {
      status: retryable ? "pending" : "failed",
      nextDelayMs: retryable ? nextRetryDelayMs(autoAttemptCount) : null,
      lastFailureCode: outcome.failureCode,
    };
  }
  return {
    status: outcome.status,
    nextDelayMs: null,
    lastFailureCode: null,
  };
}

/**
 * Element-wise comparison of two string lists.
 *
 * Joining the lists into one string and comparing that would let `["a","b"]`
 * and `["ab"]` compare equal, which would let two different bucket sets share a
 * revision digest. Comparing element by element cannot.
 */
function compareStrings(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.length - right.length;
}
