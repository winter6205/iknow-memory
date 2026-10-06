/**
 * The same-snapshot M-STATUS parity contract both lanes run.
 *
 * The port is deliberately thin: it exposes the lane's real scope authority and
 * its real stores, and maps only fixture construction into backend calls. Every
 * expectation below comes from the T17 ticket text, from the inherited
 * specification's Response status block, and from the pinned screening plan's S4
 * section — never from a backend's observed output.
 *
 * The bucket expectations are asserted as an exact SET of names and as a
 * non-empty total per bucket, because a summary that returns six of the ten
 * buckets is the exact failure mode this contract exists to close.
 */
import { describe, expect, it } from "vitest";

import {
  MAINTENANCE_CONFLICT_CHECK_BUCKETS,
  MAINTENANCE_DESIRED_INDEX_BUCKETS,
  MAINTENANCE_RULESET_REVISION,
  MAINTENANCE_STRUCTURAL_COVERAGE,
  type MaintenanceBucketCounts,
  type MaintenanceStatus,
} from "../../src/core/maintenance/maintenance-status.js";
import type { AuthorizedScopeContext } from "../../src/core/storage/structured-scope-types.js";

/** One scope the cases drive, named by what it holds rather than by its rows. */
export interface MaintenanceStatusScope {
  readonly context: AuthorizedScopeContext;
  readonly scopeBinding: string;
  /** Source references in the trusted authorized set, in stable order. */
  readonly authorizedSourceRefs: readonly string[];
}

/** What each lane supplies so one contract drives either backend. */
export interface MaintenanceStatusTestPort {
  readonly label: string;
  /** Nine sources occupying all ten buckets across both families. */
  seedFullMatrix(label: string): Promise<MaintenanceStatusScope>;
  /** One published source with no accepted membership, plus one never published. */
  seedZeroHitAndUnpublished(label: string): Promise<MaintenanceStatusScope>;
  /** An active published source the trusted set does not name. */
  seedHiddenSource(
    label: string
  ): Promise<{ readonly scope: MaintenanceStatusScope; readonly hidden: string }>;
  /** A source published at v1 with a settled ready screen, then re-declared at v2. */
  seedPendingOverOldReady(label: string): Promise<MaintenanceStatusScope>;
  /** An authorized source whose required row is removed behind the store's back. */
  seedMissingRequiredState(label: string): Promise<MaintenanceStatusScope>;
  readStatus(scope: MaintenanceStatusScope): Promise<MaintenanceStatus>;
  /** A source whose extract attempt settled ready but whose publication never landed. */
  seedUnlandedPublication(label: string): Promise<MaintenanceStatusScope>;
  /** A scope whose authorization revision moved after the context was minted. */
  seedMovedAuthorization(label: string): Promise<MaintenanceStatusScope>;
  /** A maintenance-only advance: job progress with no query-visible effect. */
  advanceProgressOnly(scope: MaintenanceStatusScope): Promise<void>;
  /** A query-visible advance: current data or access changed. */
  advanceVisibility(scope: MaintenanceStatusScope): Promise<void>;
}

/**
 * Assert the exact bucket set, that every bucket is a non-negative safe integer,
 * and that the family total equals the number of scoped sources.
 */
export function expectCompleteBucketFamily(
  observed: MaintenanceBucketCounts,
  expected: Readonly<Record<string, number>>,
  sourcesInScope: number,
  field: string
): void {
  // The conflict family names its own closed set, so both families are checked
  // against a declared vocabulary rather than against whatever arrived.
  const declared =
    field === "conflict_checks"
      ? MAINTENANCE_CONFLICT_CHECK_BUCKETS
      : MAINTENANCE_DESIRED_INDEX_BUCKETS;
  expect(Object.keys(observed).sort()).toEqual([...declared].sort());
  expect(Object.keys(observed).sort()).toEqual(
    Object.keys(expected).sort()
  );
  for (const bucket of Object.keys(expected)) {
    expect(
      Number.isSafeInteger(observed[bucket as keyof MaintenanceBucketCounts]),
      `${field}.${bucket} must be a safe integer`
    ).toBe(true);
    expect(
      observed[bucket as keyof MaintenanceBucketCounts],
      `${field}.${bucket} must not be negative`
    ).toBeGreaterThanOrEqual(0);
    expect(observed[bucket as keyof MaintenanceBucketCounts]).toBe(
      expected[bucket]
    );
  }
  expect(bucketTotal(observed), `${field} totals must equal sources_in_scope`).toBe(
    sourcesInScope
  );
}

export function bucketTotal(counts: MaintenanceBucketCounts): number {
  return MAINTENANCE_DESIRED_INDEX_BUCKETS.reduce(
    (sum, bucket) => sum + counts[bucket],
    0
  );
}

const EMPTY_FAMILY: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    MAINTENANCE_DESIRED_INDEX_BUCKETS.map((bucket) => [bucket, 0])
  )
);

/** Five non-zero buckets with named counts. */
export function family(
  counts: Readonly<Record<string, number>>
): Readonly<Record<string, number>> {
  return { ...EMPTY_FAMILY, ...counts };
}

export function describeMaintenanceStatusContract(
  openLane: () => Promise<MaintenanceStatusTestPort>
): void {
  describe("M-STATUS same-snapshot contract", () => {
    it("returns every one of the ten buckets with its own total for a scope that fills all of them", async () => {
      const port = await openLane();
      const scope = await port.seedFullMatrix("full-matrix");
      const status = await port.readStatus(scope);

      expect(status.sourcesInScope).toBe(9);
      // Five sources never reach a ready desired pair, so their conflict bucket
      // is pending whatever their ledger says; the four whose desired pair is
      // published are the ones that can move a conflict bucket at all. The two
      // running sources are one attempt that never settled and one whose older
      // ready record must not stand in for the current attempt.
      expectCompleteBucketFamily(
        status.desiredIndex,
        family({ pending: 1, running: 2, ready: 4, failed: 1, stale: 1 }),
        9,
        "desired_index"
      );
      expectCompleteBucketFamily(
        status.conflictChecks,
        family({ pending: 5, running: 1, ready: 1, failed: 1, stale: 1 }),
        9,
        "conflict_checks"
      );
      // Six sources hold a usable published version: the three that never
      // published do not, and the stale desired source and the superseded
      // source each keep their older pair.
      expect(status.publishedSources).toBe(6);
      expect(status.publishedSources).toBeLessThan(status.sourcesInScope);
      expect(status.maintenanceRevision).not.toBe("");
      expect(status.readRevision).not.toBe("");
    });

    it("counts a zero-hit source and an unpublished active source once per family each", async () => {
      const port = await openLane();
      const scope = await port.seedZeroHitAndUnpublished("zero-hit");
      const status = await port.readStatus(scope);

      expect(status.sourcesInScope).toBe(2);
      // The zero-hit source published its desired pair with an empty accepted
      // set, so it is ready with no rows behind it; the unpublished source has
      // scheduled no work at all, so it is genuinely pending.
      expectCompleteBucketFamily(
        status.desiredIndex,
        family({ pending: 1, ready: 1 }),
        2,
        "desired_index"
      );
      // Neither has a check targeting a published desired pair, so both are
      // pending once — not once per row and not dropped.
      expectCompleteBucketFamily(
        status.conflictChecks,
        family({ pending: 2 }),
        2,
        "conflict_checks"
      );
      expect(status.publishedSources).toBe(1);
    });

    it("keeps a source outside the trusted authorized set out of every total", async () => {
      const port = await openLane();
      const { scope, hidden } = await port.seedHiddenSource("hidden");
      const status = await port.readStatus(scope);

      expect(scope.authorizedSourceRefs).toHaveLength(1);
      expect(status.sourcesInScope).toBe(1);
      expect(status.publishedSources).toBe(1);
      expect(bucketTotal(status.desiredIndex)).toBe(1);
      expect(bucketTotal(status.conflictChecks)).toBe(1);
      expect(JSON.stringify(status)).not.toContain(hidden);
    });

    it("does not let a pending desired pair inherit an old ready status or an old ready screen", async () => {
      const port = await openLane();
      const scope = await port.seedPendingOverOldReady("pending-over-old-ready");
      const status = await port.readStatus(scope);

      expect(status.sourcesInScope).toBe(1);
      // The v1 record is real and settled ready, but v2 is the current desired
      // input and nothing is scheduled for it, so the source is not ready.
      expect(status.desiredIndex.ready).toBe(0);
      expect(status.desiredIndex.pending + status.desiredIndex.stale).toBe(1);
      // A completed check against the older published pair cannot make the
      // conflict bucket ready while the desired pair has not been published.
      expect(status.conflictChecks.ready).toBe(0);
      expect(status.conflictChecks.pending).toBe(1);
      // The older published version is still usable, which is what lets
      // published_sources be nonzero beside a non-ready desired bucket.
      expect(status.publishedSources).toBe(1);
    });

    it("does not report a ready bucket for a settled attempt whose publication never landed", async () => {
      const port = await openLane();
      const scope = await port.seedUnlandedPublication("unlanded");
      const status = await port.readStatus(scope);
      expect(status.sourcesInScope).toBe(1);
      // The ledger row is settled ready and genuinely current, but nothing is
      // serving it, so the desired pair has not reached readiness.
      expect(status.desiredIndex.ready).toBe(0);
      expect(status.desiredIndex.stale).toBe(1);
      expect(status.conflictChecks.ready).toBe(0);
      expect(status.conflictChecks.pending).toBe(1);
      // The older publication is still usable, so it counts even though the
      // current desired pair is not ready.
      expect(status.publishedSources).toBe(1);
    });

    it("refuses a scope whose authorization moved after the trusted context was minted", async () => {
      const port = await openLane();
      const scope = await port.seedMovedAuthorization("moved-authorization");
      await expect(port.readStatus(scope)).rejects.toMatchObject({
        code: "access_denied",
      });
    });

    it("moves only the maintenance revision for progress and the read revision for visibility", async () => {
      const port = await openLane();
      const scope = await port.seedFullMatrix("revision-kinds");
      const before = await port.readStatus(scope);

      await port.advanceProgressOnly(scope);
      const afterProgress = await port.readStatus(scope);
      expect(afterProgress.maintenanceRevision).not.toBe(
        before.maintenanceRevision
      );
      expect(afterProgress.readRevision).toBe(before.readRevision);
      expect(afterProgress.sourcesInScope).toBe(before.sourcesInScope);
      expect(afterProgress.desiredIndex).toEqual(before.desiredIndex);
      expect(afterProgress.conflictChecks).toEqual(before.conflictChecks);

      await port.advanceVisibility(scope);
      const afterVisibility = await port.readStatus(scope);
      expect(afterVisibility.readRevision).not.toBe(before.readRevision);
      expect(afterVisibility.maintenanceRevision).toBe(
        afterProgress.maintenanceRevision
      );
    });

    it("refuses maintenance_status_unavailable when a required state row is missing", async () => {
      const port = await openLane();
      const scope = await port.seedMissingRequiredState("missing-required");
      await expect(port.readStatus(scope)).rejects.toMatchObject({
        code: "maintenance_status_unavailable",
        name: "StructuredScopeError",
      });
    });

    it("refuses a requested source set wider than the trusted authorized set", async () => {
      const port = await openLane();
      const scope = await port.seedFullMatrix("wider-request");
      await expect(
        port.readStatus({
          ...scope,
          authorizedSourceRefs: [
            ...scope.authorizedSourceRefs,
            "not-authorized-source",
          ],
        })
      ).rejects.toMatchObject({ code: "access_denied" });
    });

    it("exposes the closed normative ruleset revision and structural coverage", async () => {
      const port = await openLane();
      const scope = await port.seedFullMatrix("ruleset-fields");
      const status = await port.readStatus(scope);
      expect(MAINTENANCE_RULESET_REVISION).toBe("structural-alternatives:1");
      expect(MAINTENANCE_STRUCTURAL_COVERAGE).toBe("structural_candidates_only");
      expect(status.rulesetRevision).toBe(MAINTENANCE_RULESET_REVISION);
      expect(status.coverage).toBe(MAINTENANCE_STRUCTURAL_COVERAGE);
    });
  });
}