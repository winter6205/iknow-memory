/**
 * The MP11 derived-projection-rebuild contract both lanes run.
 *
 * Every expectation here comes from the T23 ticket text and from the inherited
 * specification's "Rebuild versus re-extract" section, never from a backend's
 * observed output:
 *
 *   - "projection_rebuild consumes persisted accepted extraction, supports, and
 *     recorded decisions. It preserves assertion/source identity and cannot
 *     silently run a new extraction model."
 *   - "Every derived generation carries dependencies and publication revision."
 *   - "If complete dependencies are missing, that generation is not eligible to
 *     serve."
 *   - M12: "Projection rebuild preserves extraction identity and performs no new
 *     extraction."
 *
 * The port exposes each lane's REAL stores and maps only fixture construction
 * into backend calls, so a case can never pass against a fake.
 */
import { describe, expect, it } from "vitest";

import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
} from "../../src/core/maintenance/types.js";
import type { ProjectionRebuildResult } from "../../src/core/maintenance/publication-types.js";
import type { AuthorizedScopeContext } from "../../src/core/storage/structured-scope-types.js";

/** One scope the cases drive, named by what it holds rather than by its rows. */
export interface ProjectionRebuildScope {
  readonly context: AuthorizedScopeContext;
  readonly scopeBinding: string;
  readonly sourceRef: string;
  readonly generation: number;
  /** The dependency vector a rebuild of this scope must be bound to. */
  readonly dependencies: readonly MaintenanceDependency[];
}

/**
 * The stable-history evidence the Inherits clause forbids a rebuild to change.
 *
 * "cannot change stable source history or identity" is asserted over the whole
 * set, not just the support ids: the source version ids, the source generation,
 * the identity ids, the extraction ids and the extraction revision are all read
 * separately so a change to any one of them is visible by name.
 */
export interface StableHistoryFingerprint {
  readonly sourceVersionIds: readonly string[];
  readonly sourceVersionNames: readonly string[];
  readonly sourceGenerations: readonly number[];
  readonly identityIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly supportIds: readonly string[];
  readonly extractionIds: readonly string[];
  readonly extractionRevisions: readonly number[];
  readonly membershipSupportIds: readonly string[];
}

/** What the derived projection actually contains after a rebuild. */
export interface DerivedProjectionObservation {
  readonly subjects: readonly string[];
  readonly dependencyRevision: string;
  readonly dependencies: readonly MaintenanceDependency[];
  readonly publicationRevision: string;
  /** Pending outbox intents, as `kind:id` — the projector re-reads from these. */
  readonly pendingIntents: readonly string[];
}

export interface ProjectionRebuildTestPort {
  readonly label: string;
  /** One published source holding entity and assertion membership. */
  seedPublishedSource(label: string): Promise<ProjectionRebuildScope>;
  /**
   * A source that is active and authorized but was NEVER published, so its
   * accepted extraction does not exist. This is the spec's "complete
   * dependencies are missing": the dependency resolves, and what is missing is
   * the accepted state it names.
   */
  seedUnpublishedDependency(label: string): Promise<ProjectionRebuildScope>;
  /** Rebind a source to a new desired pair without publishing it. */
  moveSourceDesired(
    scope: ProjectionRebuildScope
  ): Promise<ProjectionRebuildScope>;
  /**
   * Withdraw the published source, leaving the attempt's dependency unmet.
   *
   * This moves the AUTHORIZATION surface as well as the dependency: a
   * withdrawal deactivates the source, so the shared seam refuses before the
   * rebuild's own completeness check is reached. The case therefore asserts the
   * seam's verdict, and the never-published case covers the rebuild's own.
   */
  withdrawPublishedSource(scope: ProjectionRebuildScope): Promise<void>;
  /**
   * Present a guard whose `inputRevision` disagrees with the ledger row it
   * names, WITHOUT moving any live source row.
   *
   * No production backdoor is involved: this is the adversarial input a caller
   * could actually hand the store, and it is the only way the scheduled
   * snapshot and its digest can come apart through the public surface.
   */
  desynchronizedGuard(
    scope: ProjectionRebuildScope,
    guard: MaintenanceAttemptGuard
  ): MaintenanceAttemptGuard;
  /**
   * Publish the same source version again under a NEW extraction revision, which
   * is what an explicit re-extraction looks like to the stable history.
   */
  republishWithNewExtraction(
    scope: ProjectionRebuildScope
  ): Promise<ProjectionRebuildScope>;
  /**
   * Claim a `projection_rebuild` attempt bound to the scope's dependencies, or
   * return the scope's EXISTING still-running attempt.
   *
   * The durable-work ledger releases no claim and re-opens no settled job key,
   * so a job key maps to exactly one attempt for the life of the store. That is
   * why the idempotence case reuses one guard rather than claiming twice: a
   * second claim of the same state is unreachable in this store, not merely
   * unnecessary.
   */
  claimRebuildAttempt(
    scope: ProjectionRebuildScope
  ): Promise<MaintenanceAttemptGuard>;
  rebuild(
    scope: ProjectionRebuildScope,
    guard: MaintenanceAttemptGuard
  ): Promise<ProjectionRebuildResult>;
  /**
   * The persisted derived generation, or `null` when this scope has none.
   *
   * `null` is an observation, not a failure: a scope where every rebuild was
   * refused has no generation, and a case asserting that must be able to see it.
   */
  observeDerived(
    scope: ProjectionRebuildScope
  ): Promise<DerivedProjectionObservation | null>;
  fingerprint(scope: ProjectionRebuildScope): Promise<StableHistoryFingerprint>;
  /** The source generation the scope's guard was bound to. */
  liveGeneration(scope: ProjectionRebuildScope): Promise<number | null>;
}

/** Assert two fingerprints are equal, naming the field that moved. */
export function expectUnchangedHistory(
  before: StableHistoryFingerprint,
  after: StableHistoryFingerprint,
  field: string
): void {
  expect(after, `${field} changed`).toEqual(before);
}

export function describeProjectionRebuildContract(
  openLane: () => Promise<ProjectionRebuildTestPort>
): void {
  describe("MP11 rebuilds a derived generation without new extraction", () => {
    it("rebuilds from authoritative accepted state and reports no new extraction", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-basic");
      const guard = await port.claimRebuildAttempt(scope);
      const before = await port.fingerprint(scope);

      const result = await port.rebuild(scope, guard);
      const after = await port.fingerprint(scope);

      expect(result.subjects.length, "a rebuild produced no subjects").toBeGreaterThan(0);
      // The Inherits clause, asserted over the whole stable history rather than
      // only the ids the projection happens to touch.
      expectUnchangedHistory(before, after, "extraction ids after a rebuild");
      expect(
        after.extractionIds,
        "the rebuild changed the set of extraction ids"
      ).toEqual(before.extractionIds);
      expect(
        after.extractionRevisions,
        "the rebuild advanced an extraction revision"
      ).toEqual(before.extractionRevisions);
      expect(after.identityIds, "the rebuild changed identity ids").toEqual(
        before.identityIds
      );
      expect(after.assertionIds, "the rebuild changed assertion ids").toEqual(
        before.assertionIds
      );
      expect(after.supportIds, "the rebuild changed support ids").toEqual(
        before.supportIds
      );
    });

    it("preserves identity and support attribution across the rebuild", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-identity");
      const before = await port.fingerprint(scope);
      const guard = await port.claimRebuildAttempt(scope);

      await port.rebuild(scope, guard);
      const after = await port.fingerprint(scope);

      expect(after.supportIds, "support attribution moved").toEqual(
        before.supportIds
      );
      expect(after.membershipSupportIds, "membership attribution moved").toEqual(
        before.membershipSupportIds
      );
      expect(after.identityIds, "identity attribution moved").toEqual(
        before.identityIds
      );
      expect(after.assertionIds, "assertion attribution moved").toEqual(
        before.assertionIds
      );
      expect(
        after.sourceVersionIds,
        "the rebuild changed the source version identity"
      ).toEqual(before.sourceVersionIds);
      expect(
        after.sourceGenerations,
        "the rebuild changed the source generation"
      ).toEqual(before.sourceGenerations);
    });

    it("records the complete dependency vector and the publication revision before serving", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-dependencies");
      const guard = await port.claimRebuildAttempt(scope);

      const result = await port.rebuild(scope, guard);
      const observed = await port.observeDerived(scope);
      if (observed === null) {
        throw new Error("a successful rebuild recorded no derived generation");
      }

      // "Every derived generation carries dependencies and publication
      // revision": the record is complete, not a count and not a digest alone.
      expect(observed.dependencies, "the generation lost its dependency vector").toEqual(
        scope.dependencies
      );
      expect(
        observed.dependencyRevision,
        "the generation's dependency revision is empty"
      ).toMatch(/^[0-9a-f]{64}$/);
      expect(
        observed.publicationRevision,
        "the generation carries no publication revision"
      ).toMatch(/^\d+$/);
      expect(
        result.reusedGeneration,
        "a first rebuild reused a pre-existing generation row"
      ).toBe(false);
    });

    it("emits one pending intent per derived subject", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-intents");
      const guard = await port.claimRebuildAttempt(scope);

      const result = await port.rebuild(scope, guard);
      const observed = await port.observeDerived(scope);
      if (observed === null) {
        throw new Error("a successful rebuild recorded no derived generation");
      }

      expect(result.subjects.length, "the rebuild queued nothing").toBeGreaterThan(0);
      expect(
        [...observed.pendingIntents].sort(),
        "the pending intents do not match the derived subjects"
      ).toEqual([...result.subjects].map((subject) => `${subject.kind}:${subject.id}`).sort());
    });
  });

  describe("MP11 refuses when a dependency is missing or stale", () => {
    it("refuses with a typed code when a dependency was withdrawn", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-missing");
      const guard = await port.claimRebuildAttempt(scope);
      // The dependency's accepted state is removed behind the store's back, so
      // the generation's dependency revision no longer resolves against live
      // publication state. This is the spec's "if complete dependencies are
      // missing, that generation is not eligible to serve".
      await port.withdrawPublishedSource(scope);

      let code: string | undefined;
      let detail = "";
      try {
        await port.rebuild(scope, guard);
      } catch (error: unknown) {
        code = (error as { code?: unknown }).code as string | undefined;
        detail = error instanceof Error ? error.message : String(error);
      }
      expect(
        code,
        `a rebuild against a missing dependency did not refuse; detail: ${detail}`
      ).toBeDefined();
      // A withdrawal deactivates the source, so the shared seam's own activity
      // check refuses first, before the rebuild's completeness check runs. The
      // spec treats a withdrawal as INVALIDATION, which is exactly what the seam
      // types it as; the rebuild's own missing-dependency verdict is covered by
      // the never-published case below.
      expect(
        code,
        `a rebuild against a withdrawn dependency refused with an unexpected code; detail: ${detail}`
      ).toBe("input_stale");
    });

    it("refuses with maintenance_status_unavailable when a dependency was never published", async () => {
      const port = await openLane();
      const scope = await port.seedUnpublishedDependency("rebuild-never-published");
      const guard = await port.claimRebuildAttempt(scope);

      let code: string | undefined;
      let detail = "";
      try {
        await port.rebuild(scope, guard);
      } catch (error: unknown) {
        code = (error as { code?: unknown }).code as string | undefined;
        detail = error instanceof Error ? error.message : String(error);
      }
      // The dependency resolves to an ACTIVE, authorized source whose accepted
      // extraction does not exist. Only the rebuild's own completeness check can
      // refuse this: the shared seam's activity check passes.
      expect(
        code,
        `a rebuild against a never-published dependency did not refuse; detail: ${detail}`
      ).toBe("maintenance_status_unavailable");
    });

    it("refuses with a typed code when a dependency is stale", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-stale");
      const guard = await port.claimRebuildAttempt(scope);
      // The source is re-declared, which advances its generation. The attempt
      // is now bound to a generation that no longer exists.
      const moved = await port.moveSourceDesired(scope);
      expect(
        moved.generation,
        "the fixture did not advance the source generation"
      ).toBeGreaterThan(scope.generation);

      let code: string | undefined;
      let detail = "";
      try {
        await port.rebuild(scope, guard);
      } catch (error: unknown) {
        code = (error as { code?: unknown }).code as string | undefined;
        detail = error instanceof Error ? error.message : String(error);
      }
      expect(
        code,
        `a rebuild against a stale dependency did not refuse; detail: ${detail}`
      ).toBeDefined();
      // The spec calls a dependency change an INVALIDATION, and the shared seam
      // types that as `input_stale` — a different condition from a missing one.
      expect(
        code,
        `a stale dependency refused with an unexpected code; detail: ${detail}`
      ).toBe("input_stale");
    });

    it("refuses with a typed code when the scheduled dependency snapshot no longer matches its guard", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-desynced");
      const guard = await port.claimRebuildAttempt(scope);
      // The presented guard now claims an input revision the ledger never
      // issued. The LIVE sources still satisfy the real vector, so only the
      // digest comparison can catch this: an attempt rebuilding against a
      // snapshot nobody scheduled it for.
      const presented = port.desynchronizedGuard(scope, guard);
      const live = await port.liveGeneration(scope);
      expect(
        live,
        "the fixture moved the live source, so this case is not isolated to the digest"
      ).toBe(scope.generation);

      let code: string | undefined;
      let detail = "";
      try {
        await port.rebuild(scope, presented);
      } catch (error: unknown) {
        code = (error as { code?: unknown }).code as string | undefined;
        detail = error instanceof Error ? error.message : String(error);
      }
      // Both lanes refuse, and the names differ because the fences that fire
      // differ: the PostgreSQL store compares the scheduled snapshot's digest
      // itself (`backend_unavailable`), while the memory store's ledger owns the
      // attempt row and re-verifies the presented guard before the store ever
      // sees the vector (`input_stale`). What the case asserts is that NEITHER
      // lane rebuilds against a snapshot nobody issued.
      expect(
        ["backend_unavailable", "input_stale"],
        `a rebuild against a desynchronized snapshot refused with an unexpected code ${code}; detail: ${detail}`
      ).toContain(code);
    });

    it("records no generation and emits no intent for a refused rebuild", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-refused-atomic");
      const guard = await port.claimRebuildAttempt(scope);
      await port.moveSourceDesired(scope);
      const before = await port.observeDerived(scope);

      try {
        await port.rebuild(scope, guard);
      } catch {
        // The refusal itself is covered above; this case asserts the residue.
      }
      const after = await port.observeDerived(scope);

      // The whole point: a refused rebuild leaves NO trace — no generation, and
      // no intent that was not already queued before it was attempted.
      expect(
        after,
        "a refused rebuild recorded a derived generation"
      ).toBe(before);
      expect(
        after?.pendingIntents ?? [],
        "a refused rebuild left a pending intent behind"
      ).toEqual(before?.pendingIntents ?? []);
    });
  });

  describe("MP11 rebuild fences", () => {
    it("refuses lease_lost when the presented fencing token was never issued", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-forged-token");
      const guard = await port.claimRebuildAttempt(scope);
      // The job is genuinely running under a token this store issued; the
      // rebuild is simply handed a different one. A fence that compared the
      // stored token against itself would pass here.
      const before = await port.observeDerived(scope);
      expect(
        before,
        "the fixture recorded a generation before any rebuild ran"
      ).toBeNull();

      let code: string | undefined;
      try {
        await port.rebuild(scope, {
          ...guard,
          fencingToken: "00000000-0000-4000-8000-0000000000ff",
        });
      } catch (error: unknown) {
        code = (error as { code?: unknown }).code as string | undefined;
      }
      expect(
        code,
        "a rebuild with a forged fencing token was accepted"
      ).toBe("lease_lost");
      expect(
        await port.observeDerived(scope),
        "a refused rebuild recorded a derived generation"
      ).toBeNull();
    });
  });

  describe("MP11 rebuild is idempotent", () => {
    it("a second rebuild of the same state changes nothing and emits no duplicate intent", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-idempotent");
      const guard = await port.claimRebuildAttempt(scope);
      const first = await port.rebuild(scope, guard);
      const afterFirst = await port.observeDerived(scope);
      const historyAfterFirst = await port.fingerprint(scope);
      if (afterFirst === null) {
        throw new Error("a successful rebuild recorded no derived generation");
      }

      // The same attempt runs the rebuild again: same dependencies, same
      // accepted state, nothing changed in between.
      const second = await port.rebuild(scope, guard);
      const afterSecond = await port.observeDerived(scope);
      const historyAfterSecond = await port.fingerprint(scope);
      if (afterSecond === null) {
        throw new Error("the recorded generation vanished across a repeat rebuild");
      }

      expect(second.subjects, "the second rebuild derived different subjects").toEqual(
        first.subjects
      );
      expect(
        afterSecond.dependencyRevision,
        "the second rebuild changed the generation's dependency revision"
      ).toBe(afterFirst.dependencyRevision);
      expect(
        afterSecond.publicationRevision,
        "the second rebuild changed the generation's publication revision"
      ).toBe(afterFirst.publicationRevision);
      expect(
        [...afterSecond.pendingIntents].sort(),
        "the second rebuild duplicated or dropped an intent"
      ).toEqual([...afterFirst.pendingIntents].sort());
      expect(
        afterSecond.pendingIntents.length,
        "the second rebuild emitted a duplicate intent"
      ).toBe(afterFirst.pendingIntents.length);
      expect(
        second.reusedGeneration,
        "the second rebuild did not find its own generation row"
      ).toBe(true);
      expect(
        first.reusedGeneration,
        "the first rebuild reported reusing a generation row"
      ).toBe(false);
      expectUnchangedHistory(historyAfterFirst, historyAfterSecond, "history after a repeat rebuild");
    });

    it("a repeat rebuild is distinguishable from a new interpretation of the source", async () => {
      const port = await openLane();
      const scope = await port.seedPublishedSource("rebuild-distinguishable");
      const guard = await port.claimRebuildAttempt(scope);
      await port.rebuild(scope, guard);
      const afterRebuild = await port.fingerprint(scope);

      // A real re-extraction advances the extraction revision and adds an
      // extraction id; a rebuild must be distinguishable from that, so the
      // comparison is made against a source that actually moved.
      const moved = await port.republishWithNewExtraction(scope);
      const afterReExtraction = await port.fingerprint(moved);

      // A rebuild leaves this set EXACTLY as it was; an explicit re-extraction
      // rebinds the source to a new extraction ref, so the sets differ. Compared
      // as sets, not counts, because the published pair holds one ref at a time.
      expect(
        afterRebuild.extractionIds,
        "the fixture's re-extraction left the extraction ids unchanged"
      ).not.toEqual(afterReExtraction.extractionIds);
      expect(
        afterReExtraction.extractionRevisions,
        "the fixture's re-extraction did not advance an extraction revision"
      ).not.toEqual(afterRebuild.extractionRevisions);
    });
  });
}