/**
 * The guarded-decision parity contract both lanes run.
 *
 * The port is deliberately thin: it exposes the lane's real decision storage
 * over its real screening store and real scope authority, and maps only fixture
 * construction into backend calls. Every expectation below comes from the
 * ticket text and the inherited specification's S3 section, never from a
 * backend's observed output, and no decision id, digest or candidate id is
 * copied from a run.
 */
import { describe, expect, it } from "vitest";

import type {
  ScreeningConflictFacts,
  ScreeningDecisionOutcomeRecord,
  ScreeningDecisionOutcome,
  ScreeningDecisionRecord,
  ScreeningDecisionRequest,
} from "../../src/core/maintenance/screening-decision.js";
import type { AuthorizedScopeContext } from "../../src/core/storage/structured-scope-types.js";

/** One support as the conflict's exact affected-ID set holds it. */
export interface ConflictSupport {
  readonly supportId: string;
  readonly assertionId: string;
}

/** What each lane supplies so one contract drives either backend. */
export interface ScreeningDecisionTestPort {
  readonly label: string;
  /**
   * Publish one conflict through the lane's real screening store, then report
   * the exact facts a decision about it must present. The expectation for a
   * decision is never taken from the request; it is validated against these.
   */
  seedConflict(label: string): Promise<{
    readonly context: AuthorizedScopeContext;
    readonly facts: ScreeningConflictFacts;
    readonly supports: readonly ConflictSupport[];
    readonly scopeBinding: string;
  }>;
  applyDecision(input: {
    readonly request: ScreeningDecisionRequest;
    readonly facts: ScreeningConflictFacts;
  }): Promise<ScreeningDecisionOutcomeRecord>;
  /** An identical resubmission of a recorded decision. */
  readDecisions(
    scopeBinding: string,
    candidateId?: string
  ): Promise<readonly ScreeningDecisionRecord[]>;
  /** Whether the conflict still reads as unresolved, by explicit decision. */
  readConflictResolution(
    scopeBinding: string,
    candidateId: string
  ): Promise<boolean>;
  /** The current visibility each support carries in the conflict. */
  readVisibility(
    scopeBinding: string,
    candidateId: string
  ): Promise<readonly { readonly supportId: string; readonly current: boolean }[]>;
  /**
   * A fingerprint of every authoritative store this decision can touch, read
   * from outside the transaction that refused or applied. Equal fingerprints
   * before and after are the only proof that a refusal changed nothing.
   */
  fingerprint(scopeBinding: string): Promise<string>;
  /** The scope's read and maintenance revisions as they currently read. */
  readRevisions(
    scopeBinding: string
  ): Promise<{ readonly read: number; readonly maintenance: number }>;
  /** The projection intents the outbox currently holds for this scope. */
  readIntents(scopeBinding: string): Promise<readonly string[]>;
  close(): Promise<void>;
}

let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

const REASON = "both sources state overlapping employment; reviewed by the owner";

/**
 * A complete, valid decision for one conflict, as a reviewer would state it.
 *
 * Every case starts from this and removes or contradicts exactly one thing, so
 * a refusal is attributable to that one thing rather than to a differently
 * shaped request.
 */
function validRequest(
  base: {
    readonly context: AuthorizedScopeContext;
    readonly facts: ScreeningConflictFacts;
    readonly supports: readonly ConflictSupport[];
  },
  overrides: {
    readonly decisionId?: string;
    readonly outcome?: ScreeningDecisionOutcome;
    readonly reason?: string;
    readonly retireSupportIds?: readonly string[];
    readonly retainSupportIds?: readonly string[];
    readonly assertionIds?: readonly string[];
    readonly expectedInputRevision?: string;
    readonly expectedRelationCatalogVersion?: number;
    readonly actorId?: string;
  } = {}
): ScreeningDecisionRequest {
  const outcome = overrides.outcome ?? "retire_support";
  const first = base.supports[0]!;
  const second = base.supports[1]!;
  const retireSupportIds =
    overrides.retireSupportIds ??
    (outcome === "retire_support" ? [first.supportId] : [first.supportId]);
  const retainSupportIds =
    overrides.retainSupportIds ??
    (outcome === "supersede_assertion" ? [second.supportId] : []);
  return {
    decisionId: overrides.decisionId ?? unique("t16-decision"),
    context:
      overrides.actorId === undefined
        ? base.context
        : { ...base.context, actorId: overrides.actorId },
    candidateId: base.facts.candidateId,
    outcome,
    reason: overrides.reason ?? REASON,
    retireSupportIds,
    retainSupportIds,
    assertionIds: overrides.assertionIds ?? base.supports.map((entry) => entry.assertionId),
    expectedInputRevision:
      overrides.expectedInputRevision ?? base.facts.inputRevision,
    expectedRelationCatalogVersion:
      overrides.expectedRelationCatalogVersion ??
      base.facts.relationCatalogVersion,
  };
}

export function describeScreeningDecisionContract(
  openPort: () => Promise<ScreeningDecisionTestPort>
): void {
  describe("guarded screening decisions S3 parity contract", () => {
    it("SD-01 an unresolved conflict stays queryable, and only a decision changes that", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd01");
      // With no decision the conflict reads as unresolved, and every support in
      // it is still current: an alternative is not a verdict, and nothing about
      // its being published resolves it.
      expect(await port.readConflictResolution(seeded.scopeBinding, seeded.facts.candidateId)).toBe(
        false
      );
      expect(await port.readDecisions(seeded.scopeBinding)).toEqual([]);
      expect(await port.readVisibility(seeded.scopeBinding, seeded.facts.candidateId)).toEqual([]);

      const applied = await port.applyDecision({
        request: validRequest(seeded, { outcome: "keep_both", retireSupportIds: [] }),
        facts: seeded.facts,
      });
      // Resolution is what changes the conflict's state, and keep_both resolves
      // it by changing nothing about which rows are current.
      expect(applied.decision.outcome).toBe("keep_both");
      expect(applied.effect.visibilityChanged).toBe(false);
      expect(
        await port.readConflictResolution(seeded.scopeBinding, seeded.facts.candidateId)
      ).toBe(true);
      const visibility = await port.readVisibility(
        seeded.scopeBinding,
        seeded.facts.candidateId
      );
      expect(visibility).toHaveLength(seeded.supports.length);
      expect(visibility.every((entry) => entry.current)).toBe(true);
    });

    it("SD-02 keep_both changes no current row and enqueues no projection intent", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd02");
      const revisionsBefore = await port.readRevisions(seeded.scopeBinding);
      const intentsBefore = await port.readIntents(seeded.scopeBinding);
      const applied = await port.applyDecision({
        request: validRequest(seeded, { outcome: "keep_both", retireSupportIds: [] }),
        facts: seeded.facts,
      });
      expect(applied.effect.visibilityChanged).toBe(false);
      expect(applied.effect.projectionIntentsEnqueued).toBe(false);
      const revisionsAfter = await port.readRevisions(seeded.scopeBinding);
      // A visibility change advances the read revision; keep_both changes no
      // visibility, so the read revision is untouched and only maintenance
      // moves.
      expect(revisionsAfter.read).toBe(revisionsBefore.read);
      expect(revisionsAfter.maintenance).toBe(revisionsBefore.maintenance + 1);
      expect(await port.readIntents(seeded.scopeBinding)).toEqual(intentsBefore);
    });

    it("SD-03 retire_support retires exactly the named support and keeps the other current", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd03");
      const first = seeded.supports[0]!;
      const second = seeded.supports[1]!;
      const revisionsBefore = await port.readRevisions(seeded.scopeBinding);
      const applied = await port.applyDecision({
        request: validRequest(seeded, {
          outcome: "retire_support",
          retireSupportIds: [first.supportId],
        }),
        facts: seeded.facts,
      });
      expect(applied.effect.visibilityChanged).toBe(true);
      expect(applied.effect.projectionIntentsEnqueued).toBe(true);
      const visibility = await port.readVisibility(
        seeded.scopeBinding,
        seeded.facts.candidateId
      );
      // Only the named support is retired. The other source's retained support
      // stays effective, which is what keeps this from being a silent
      // resolution of the whole conflict.
      expect(visibility.find((entry) => entry.supportId === first.supportId)!.current).toBe(
        false
      );
      expect(visibility.find((entry) => entry.supportId === second.supportId)!.current).toBe(
        true
      );
      const revisionsAfter = await port.readRevisions(seeded.scopeBinding);
      expect(revisionsAfter.read).toBe(revisionsBefore.read + 1);
      expect(revisionsAfter.maintenance).toBe(revisionsBefore.maintenance + 1);
      expect(await port.readIntents(seeded.scopeBinding)).toContain(
        seeded.facts.assertionIds[0]!
      );
    });

    it("SD-04 supersede_assertion names its replacement and records both supports", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd04");
      const first = seeded.supports[0]!;
      const second = seeded.supports[1]!;
      const applied = await port.applyDecision({
        request: validRequest(seeded, {
          outcome: "supersede_assertion",
          retireSupportIds: [first.supportId],
          retainSupportIds: [second.supportId],
        }),
        facts: seeded.facts,
      });
      expect(applied.decision.outcome).toBe("supersede_assertion");
      expect(applied.decision.retainSupportIds).toEqual([second.supportId]);
      // The replacement is recorded explicitly, never inferred: the persisted
      // decision names the support that survives.
      const [recorded] = await port.readDecisions(
        seeded.scopeBinding,
        seeded.facts.candidateId
      );
      expect(recorded!.outcome).toBe("supersede_assertion");
      expect(recorded!.retainSupportIds).toEqual([second.supportId]);
      expect(recorded!.retireSupportIds).toEqual([first.supportId]);
    });

    it("SD-05 every accepted decision records its actor, reason and named IDs in the store", async () => {
      const port = await openPort();
      for (const outcome of ["keep_both", "retire_support", "supersede_assertion"] as const) {
        const seeded = await port.seedConflict(`sd05-${outcome}`);
        const request = validRequest(seeded, {
          outcome,
          retireSupportIds: outcome === "keep_both" ? [] : [seeded.supports[0]!.supportId],
          retainSupportIds: outcome === "supersede_assertion" ? [seeded.supports[1]!.supportId] : [],
        });
        const applied = await port.applyDecision({ request, facts: seeded.facts });
        const [recorded] = await port.readDecisions(
          seeded.scopeBinding,
          seeded.facts.candidateId
        );
        // Provenance is stored, not returned only: a reader of the store can
        // see who decided, why, and exactly which IDs the decision covered.
        expect(recorded!.actorId).toBe(seeded.context.actorId);
        expect(recorded!.reason).toBe(REASON);
        expect(recorded!.decisionId).toBe(applied.decision.decisionId);
        expect(recorded!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(recorded!.retireSupportIds).toEqual(
          [...request.retireSupportIds].sort()
        );
        expect([...recorded!.assertionIds].sort()).toEqual(
          [...request.assertionIds].sort()
        );
        expect(recorded!.expectedInputRevision).toBe(seeded.facts.inputRevision);
      }
    });

    it("SD-06 a denied actor is refused and nothing is written", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd06");
      const before = await port.fingerprint(seeded.scopeBinding);
      // A context assembled structurally rather than minted by trusted
      // composition — here one carrying a blank actor — is refused by the
      // shared seam's own authority check with `access_denied`, before the
      // decision opens a unit of work. That seam is the fence; the decision
      // store deliberately adds no second actor check that could never fail.
      await expect(
        port.applyDecision({
          request: validRequest(seeded, { actorId: "   " }),
          facts: seeded.facts,
        })
      ).rejects.toMatchObject({ code: "access_denied" });
      expect(await port.fingerprint(seeded.scopeBinding)).toBe(before);
    });

    it("SD-07 a stale expected revision is refused and nothing is written", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd07");
      const before = await port.fingerprint(seeded.scopeBinding);
      await expect(
        port.applyDecision({
          request: validRequest(seeded, {
            expectedInputRevision: `${seeded.facts.inputRevision}-stale`,
          }),
          facts: seeded.facts,
        })
      ).rejects.toMatchObject({ code: "input_stale" });
      // A decision about inputs that no longer exist must not resolve anything:
      // the conflict is still open and still queryable.
      expect(
        await port.readConflictResolution(seeded.scopeBinding, seeded.facts.candidateId)
      ).toBe(false);
      expect(await port.fingerprint(seeded.scopeBinding)).toBe(before);

      const staleCatalog = await port.seedConflict("sd07-catalog");
      const beforeCatalog = await port.fingerprint(staleCatalog.scopeBinding);
      await expect(
        port.applyDecision({
          request: validRequest(staleCatalog, {
            expectedRelationCatalogVersion: seeded.facts.relationCatalogVersion + 7,
          }),
          facts: staleCatalog.facts,
        })
      ).rejects.toMatchObject({ code: "input_stale" });
      expect(await port.fingerprint(staleCatalog.scopeBinding)).toBe(beforeCatalog);
    });

    it("SD-08 an empty or whitespace-only reason is refused and nothing is written", async () => {
      const port = await openPort();
      for (const reason of ["", "   ", "\t\n "]) {
        const seeded = await port.seedConflict(`sd08-${JSON.stringify(reason).length}`);
        const before = await port.fingerprint(seeded.scopeBinding);
        await expect(
          port.applyDecision({ request: validRequest(seeded, { reason }), facts: seeded.facts })
        ).rejects.toMatchObject({ code: "invalid_input" });
        expect(await port.fingerprint(seeded.scopeBinding)).toBe(before);
      }
    });

    it("SD-09 an ambiguous target is refused: no inferred replacement, no unnamed origin", async () => {
      const port = await openPort();
      // A supersession with no named replacement would be exactly the inferred
      // replacement the specification rules out.
      const noReplacement = await port.seedConflict("sd09-no-replacement");
      const beforeNoReplacement = await port.fingerprint(noReplacement.scopeBinding);
      await expect(
        port.applyDecision({
          request: validRequest(noReplacement, {
            outcome: "supersede_assertion",
            retireSupportIds: [noReplacement.supports[0]!.supportId],
            retainSupportIds: [],
          }),
          facts: noReplacement.facts,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await port.fingerprint(noReplacement.scopeBinding)).toBe(beforeNoReplacement);

      // A changing outcome that retires nothing has not disclosed its origin.
      const noOrigin = await port.seedConflict("sd09-no-origin");
      const beforeNoOrigin = await port.fingerprint(noOrigin.scopeBinding);
      await expect(
        port.applyDecision({
          request: validRequest(noOrigin, { retireSupportIds: [] }),
          facts: noOrigin.facts,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await port.fingerprint(noOrigin.scopeBinding)).toBe(beforeNoOrigin);

      // A support that is both the retired origin and its own replacement names
      // no replacement at all.
      const selfSupersede = await port.seedConflict("sd09-self");
      const beforeSelf = await port.fingerprint(selfSupersede.scopeBinding);
      const selfId = selfSupersede.supports[0]!.supportId;
      await expect(
        port.applyDecision({
          request: validRequest(selfSupersede, {
            outcome: "supersede_assertion",
            retireSupportIds: [selfId],
            retainSupportIds: [selfId],
          }),
          facts: selfSupersede.facts,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await port.fingerprint(selfSupersede.scopeBinding)).toBe(beforeSelf);
    });

    it("SD-10 an unknown target is refused with zero partial effect", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd10");
      const known = seeded.supports[0]!.supportId;
      const unknownSupport = "00000000-0000-4000-8000-00000000dead";
      const before = await port.fingerprint(seeded.scopeBinding);
      // A support that does not exist, and one that exists but is not in this
      // conflict's set, are both refused rather than applied partially.
      await expect(
        port.applyDecision({
          request: validRequest(seeded, { retireSupportIds: [unknownSupport] }),
          facts: seeded.facts,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await port.fingerprint(seeded.scopeBinding)).toBe(before);

      const foreign = await port.seedConflict("sd10-foreign");
      const beforeForeign = await port.fingerprint(foreign.scopeBinding);
      await expect(
        port.applyDecision({
          request: validRequest(foreign, { retireSupportIds: [known] }),
          facts: foreign.facts,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
      // Zero partial effect: the known support in the foreign conflict was not
      // retired on the way to refusing the unknown one.
      expect(
        await port.readVisibility(foreign.scopeBinding, foreign.facts.candidateId)
      ).toEqual([]);
      expect(await port.fingerprint(foreign.scopeBinding)).toBe(beforeForeign);

      const unknownAssertion = await port.seedConflict("sd10-assertion");
      const beforeAssertion = await port.fingerprint(unknownAssertion.scopeBinding);
      await expect(
        port.applyDecision({
          request: validRequest(unknownAssertion, {
            assertionIds: [unknownSupport],
          }),
          facts: unknownAssertion.facts,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await port.fingerprint(unknownAssertion.scopeBinding)).toBe(beforeAssertion);
    });

    it("SD-11 an unknown conflict is refused and nothing is written", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd11");
      const before = await port.fingerprint(seeded.scopeBinding);
      await expect(
        port.applyDecision({
          request: {
            ...validRequest(seeded),
            candidateId: "00000000-0000-4000-8000-00000000beef",
          },
          facts: seeded.facts,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await port.fingerprint(seeded.scopeBinding)).toBe(before);
    });

    it("SD-12 a conflicting duplicate decision id is refused and the recorded decision stands", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd12");
      const decisionId = unique("t16-duplicate");
      const first = validRequest(seeded, { decisionId });
      await port.applyDecision({ request: first, facts: seeded.facts });
      const afterFirst = await port.fingerprint(seeded.scopeBinding);

      // The same id with different content is a different decision wearing an
      // existing id; it refuses rather than overwriting the evidence.
      await expect(
        port.applyDecision({
          request: validRequest(seeded, {
            decisionId,
            outcome: "keep_both",
            retireSupportIds: [],
          }),
          facts: seeded.facts,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await port.fingerprint(seeded.scopeBinding)).toBe(afterFirst);
      const [recorded] = await port.readDecisions(
        seeded.scopeBinding,
        seeded.facts.candidateId
      );
      expect(recorded!.outcome).toBe(first.outcome);
      expect(recorded!.reason).toBe(REASON);
    });

    it("SD-13 an identical resubmission is idempotent and applies its effect once", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd13");
      const request = validRequest(seeded);
      const first = await port.applyDecision({ request, facts: seeded.facts });
      const afterFirst = await port.fingerprint(seeded.scopeBinding);
      const second = await port.applyDecision({ request, facts: seeded.facts });
      // The retry is the same decision, so the store holds one of them and the
      // effect was applied exactly once.
      expect(second.idempotent).toBe(true);
      expect(second.decision.decisionId).toBe(first.decision.decisionId);
      expect(second.decision.contentDigest).toBe(first.decision.contentDigest);
      expect(await port.fingerprint(seeded.scopeBinding)).toBe(afterFirst);
      expect(await port.readDecisions(seeded.scopeBinding)).toHaveLength(1);
    });

    it("SD-14 two decisions on one conflict cannot both apply, and the loser changes nothing", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd14");
      const firstRequest = validRequest(seeded, { outcome: "retire_support" });
      const secondRequest = validRequest(seeded, {
        outcome: "keep_both",
        retireSupportIds: [],
      });
      // Both are presented together against the same expected revisions, which
      // is the concurrent-stale-decision case the completion clause names.
      const results = await Promise.allSettled([
        port.applyDecision({ request: firstRequest, facts: seeded.facts }),
        port.applyDecision({ request: secondRequest, facts: seeded.facts }),
      ]);
      const applied = results.filter((entry) => entry.status === "fulfilled");
      const refused = results.filter((entry) => entry.status === "rejected");
      expect(applied).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "input_stale",
      });
      // Exactly one decision exists, and the conflict resolved once.
      const recorded = await port.readDecisions(
        seeded.scopeBinding,
        seeded.facts.candidateId
      );
      expect(recorded).toHaveLength(1);
      expect(
        await port.readConflictResolution(seeded.scopeBinding, seeded.facts.candidateId)
      ).toBe(true);
    });

    it("SD-15 a later decision against an already-resolved conflict refuses", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd15");
      await port.applyDecision({
        request: validRequest(seeded, { outcome: "keep_both", retireSupportIds: [] }),
        facts: seeded.facts,
      });
      const afterFirst = await port.fingerprint(seeded.scopeBinding);
      // A second decision with its own id cannot apply over the first: the state
      // its author read — an unresolved conflict — no longer exists.
      await expect(
        port.applyDecision({
          request: validRequest(seeded, { outcome: "retire_support" }),
          facts: seeded.facts,
        })
      ).rejects.toMatchObject({ code: "input_stale" });
      expect(await port.fingerprint(seeded.scopeBinding)).toBe(afterFirst);
      expect(await port.readDecisions(seeded.scopeBinding)).toHaveLength(1);
    });

    it("SD-16 no newest-wins default: a later-arriving fact does not resolve the conflict", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd16");
      expect(
        await port.readConflictResolution(seeded.scopeBinding, seeded.facts.candidateId)
      ).toBe(false);
      // A second, later screen over the same inputs publishes no decision and
      // retires nothing: the earlier conflict is still open and still queryable.
      const rescreened = await port.seedConflict("sd16-later");
      expect(
        await port.readConflictResolution(rescreened.scopeBinding, rescreened.facts.candidateId)
      ).toBe(false);
      expect(await port.readDecisions(rescreened.scopeBinding)).toEqual([]);
      expect(
        await port.readVisibility(rescreened.scopeBinding, rescreened.facts.candidateId)
      ).toEqual([]);
      // Every support of the earlier conflict is still current, so the later
      // scope's arrival displaced nothing.
      expect(
        await port.readVisibility(seeded.scopeBinding, seeded.facts.candidateId)
      ).toEqual([]);
    });

    it("SD-17 the recorded decision reads back without any verdict field", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd17");
      await port.applyDecision({
        request: validRequest(seeded, { outcome: "retire_support" }),
        facts: seeded.facts,
      });
      const [recorded] = await port.readDecisions(
        seeded.scopeBinding,
        seeded.facts.candidateId
      );
      for (const key of Object.keys(recorded!)) {
        expect(key).not.toMatch(
          /truth|winner|score|confidence|rank|verdict|correct|preferred|best/i
        );
      }
      // A decision records visibility and provenance; it does not adjudicate.
      expect(recorded!.outcome).toBe("retire_support");
    });
    it("SD-18 an outcome outside the closed set is refused, not applied", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd18");
      const before = await port.fingerprint(seeded.scopeBinding);
      // The three outcomes are the whole vocabulary. A fourth action is a gap to
      // be reported, not one to be invented, so an unrecognised outcome refuses
      // rather than falling through to a default.
      await expect(
        port.applyDecision({
          request: {
            ...validRequest(seeded, { outcome: "retire_support" }),
            outcome: "pick_the_newer_one" as ScreeningDecisionOutcome,
          },
          facts: seeded.facts,
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await port.fingerprint(seeded.scopeBinding)).toBe(before);
    });

    it("SD-19 a refused decision preserves the exact prior state across the authoritative stores", async () => {
      const port = await openPort();
      const seeded = await port.seedConflict("sd19");
      // Resolve one conflict first, so the prior state is a resolved conflict
      // with real decisions, real visibility rows, real revisions and real
      // intents — not an empty scope where almost any write would show.
      await port.applyDecision({
        request: validRequest(seeded, { outcome: "retire_support" }),
        facts: seeded.facts,
      });
      const before = await port.fingerprint(seeded.scopeBinding);
      const revisionsBefore = await port.readRevisions(seeded.scopeBinding);
      const recordedBefore = await port.readDecisions(
        seeded.scopeBinding,
        seeded.facts.candidateId
      );
      expect(recordedBefore).toHaveLength(1);
      expect((await port.readVisibility(seeded.scopeBinding, seeded.facts.candidateId))
        .some((entry) => entry.current === false)).toBe(true);

      // A refusal of each class against that same non-trivial state.
      for (const refusal of [
        validRequest(seeded, { decisionId: unique("t19-stale"), reason: "   " }),
        validRequest(seeded, {
          decisionId: unique("t19-unknown"),
          retireSupportIds: ["00000000-0000-4000-8000-00000000dead"],
        }),
        validRequest(seeded, {
          decisionId: unique("t19-stale-rev"),
          expectedInputRevision: `${seeded.facts.inputRevision}-moved`,
        }),
      ]) {
        await expect(
          port.applyDecision({ request: refusal, facts: seeded.facts })
        ).rejects.toMatchObject({ code: expect.any(String) });
        // Equal fingerprints before and after each refusal: the decisions, the
        // visibility rows, the candidates, the membership, the outbox and both
        // revisions are all exactly as they were.
        expect(await port.fingerprint(seeded.scopeBinding)).toBe(before);
      }
      expect(await port.readRevisions(seeded.scopeBinding)).toEqual(revisionsBefore);
      expect(
        await port.readDecisions(seeded.scopeBinding, seeded.facts.candidateId)
      ).toHaveLength(1);
    });
  });
}
