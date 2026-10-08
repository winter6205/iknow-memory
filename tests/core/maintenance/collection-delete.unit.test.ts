/**
 * MP15 deletion plan — the ordered phase vocabulary, the terminal deadline
 * boundary and the closed refusal set, all proven at the boundary.
 *
 * Pure lane, on the same terms as MP13's eligibility and MP14's mark: a fake
 * instant and an injected fact set, no clock read, no storage. Every refusal is
 * asserted by its typed CODE and not by a message, because the code is what a
 * caller branches on and a message is what a future edit is free to reword.
 */
import { describe, expect, it } from "vitest";

import { COLLECTION_DAY_MS } from "../../../src/core/maintenance/collector-eligibility.js";
import {
  COLLECTION_DELETE_PHASES,
  isCollectionDeletePhase,
  planCollectionDelete,
  remainingDeletePhases,
  type CollectionDeleteFacts,
  type CollectionDeletePhase,
  type CollectionDeleteRequest,
} from "../../../src/core/maintenance/collection-delete.js";
import type { CollectionMark } from "../../../src/core/maintenance/collection-mark-types.js";

const DAY0 = new Date("2026-01-01T00:00:00.000Z");
const atDay = (count: number): Date =>
  new Date(DAY0.getTime() + count * COLLECTION_DAY_MS);

const SOURCE_VERSION_ID = "33333333-3333-4333-8333-333333333333";

const mark = (overrides: Partial<CollectionMark> = {}): CollectionMark => ({
  payloadClass: "retired_unreferenced",
  payloadRef: "s1",
  scopeBinding: "scope-a",
  sourceVersionId: SOURCE_VERSION_ID,
  expectedLifecycleRevision: "7",
  deadlineAt: atDay(97).toISOString(),
  markedAt: atDay(90).toISOString(),
  state: "marked",
  cancelledAt: null,
  cancelledReason: null,
  ...overrides,
});

const request = (
  overrides: Partial<CollectionDeleteRequest> = {}
): CollectionDeleteRequest => ({
  identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
  scopeBinding: "scope-a",
  purgeRevision: "purge-1",
  ...overrides,
});

const facts = (
  overrides: Partial<CollectionDeleteFacts> = {}
): CollectionDeleteFacts => ({
  mark: mark(),
  // The revision the mark recorded is still the scope's revision, so this mark
  // is NOT stale: nothing moved after it was taken (spec:307).
  lifecycleRevision: "7",
  bindingResolved: true,
  payloadCollected: false,
  liveRowGrants: [],
  now: atDay(98),
  ...overrides,
});

function refusalOf(
  outcome: ReturnType<typeof planCollectionDelete>
): { readonly code: string; readonly detail: string } {
  if (!outcome.refused) {
    throw new Error("expected a refusal, got a plan");
  }
  return { code: outcome.code, detail: outcome.detail };
}

describe("MP15 the deletion phase vocabulary", () => {
  it("lists exactly the spec's removable row sets, in dependency order", () => {
    // The order is the contract, not a convenience: each phase removes a row set
    // an earlier phase's FK RESTRICT/NOTHING would refuse to let go out of turn.
    expect(COLLECTION_DELETE_PHASES).toEqual([
      "dependent_supports",
      "extraction_payloads",
      "assertion_supports",
      "frozen_units",
      "superseded_caches",
    ]);
  });

  it("guards membership of the closed vocabulary", () => {
    for (const phase of COLLECTION_DELETE_PHASES) {
      expect(isCollectionDeletePhase(phase)).toBe(true);
    }
    expect(isCollectionDeletePhase("collected")).toBe(false);
    expect(isCollectionDeletePhase("source_versions")).toBe(false);
    expect(isCollectionDeletePhase(null)).toBe(false);
  });
});

describe("MP15 the deletion plan", () => {
  it("plans every phase for a live, in-scope, past-deadline retired payload", () => {
    const outcome = planCollectionDelete(request(), facts());
    if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);

    expect(outcome.plan.sourceVersionId).toBe(SOURCE_VERSION_ID);
    expect(outcome.plan.scopeBinding).toBe("scope-a");
    expect(outcome.plan.purgeRevision).toBe("purge-1");
    expect(outcome.plan.deadlineAt).toBe(atDay(97).toISOString());
    expect(outcome.plan.phases).toEqual([...COLLECTION_DELETE_PHASES]);
  });

  it("refuses a payload class MP15 does not own", () => {
    // Only the retired-unreferenced class is MP15's. The protected class clears
    // through grant expiry, the object-scoped classes through their own slices —
    // accepting one here would delete rows whose retention clock has not run.
    const outcome = planCollectionDelete(
      request({
        identity: { payloadClass: "retired_evidence_protected", payloadRef: "s1" },
      }),
      facts()
    );
    expect(refusalOf(outcome).code).toBe("invalid_input");
  });

  it("refuses blank tokens and a malformed instant before any fact is consulted", () => {
    for (const overrides of [
      { identity: { payloadClass: "retired_unreferenced" as const, payloadRef: "  " } },
      { scopeBinding: "" },
      { purgeRevision: "   " },
    ]) {
      const outcome = planCollectionDelete(request(overrides), facts());
      expect(refusalOf(outcome).code).toBe("invalid_input");
    }
    const badInstant = planCollectionDelete(request(), facts({ now: new Date("nope") }));
    expect(refusalOf(badInstant).code).toBe("invalid_input");
  });

  it("refuses a mark held by a different scope", () => {
    const outcome = planCollectionDelete(
      request({ scopeBinding: "scope-b" }),
      facts()
    );
    expect(refusalOf(outcome).code).toBe("access_denied");
  });

  it("refuses a missing mark and a cancelled one", () => {
    expect(refusalOf(planCollectionDelete(request(), facts({ mark: null }))).code).toBe(
      "input_stale"
    );
    const cancelled = planCollectionDelete(
      request(),
      facts({ mark: mark({ state: "cancelled" }) })
    );
    expect(refusalOf(cancelled).code).toBe("input_stale");
  });

  it("refuses a mark whose identity names a different payload", () => {
    const outcome = planCollectionDelete(
      request(),
      facts({ mark: mark({ payloadRef: "someone-else" }) })
    );
    expect(refusalOf(outcome).code).toBe("input_stale");
  });

  it("refuses an unresolvable source binding", () => {
    const outcome = planCollectionDelete(
      request(),
      facts({ bindingResolved: false })
    );
    expect(refusalOf(outcome).code).toBe("unsupported_source_binding");
  });

  it("refuses an already-collected payload", () => {
    const outcome = planCollectionDelete(
      request(),
      facts({ payloadCollected: true })
    );
    expect(refusalOf(outcome).code).toBe("input_stale");
  });

  it("refuses a payload a live row grant still protects", () => {
    // spec:278 — an unexpired row-evidence content dependency holds the payload.
    // input_stale, not invalid_input: the grant list is store-read, so the world
    // moved rather than the request being malformed.
    const outcome = planCollectionDelete(
      request(),
      facts({ liveRowGrants: ["ref-row-1"] })
    );
    expect(refusalOf(outcome).code).toBe("input_stale");
    expect(refusalOf(outcome).detail).toContain("ref-row-1");
  });

  it("refuses a mark the scope has moved past", () => {
    // spec:307 — never delete against an earlier scan. The observed revision is
    // the scope's live one; a mark recorded against another is stale.
    const outcome = planCollectionDelete(
      request(),
      facts({ lifecycleRevision: "8" })
    );
    expect(refusalOf(outcome).code).toBe("input_stale");
  });

  it("refuses before the grace deadline has passed", () => {
    const justBefore = planCollectionDelete(
      request(),
      facts({ now: new Date(atDay(97).getTime() - 1) })
    );
    expect(refusalOf(justBefore).code).toBe("input_stale");

    // The deadline instant itself is inside the window: `>=`, matching the
    // durable-work fence and MP14's own `recheckCollectionMark`.
    const atDeadline = planCollectionDelete(
      request(),
      facts({ now: atDay(97) })
    );
    expect(atDeadline.refused).toBe(false);
  });

  it("refuses a source-bound mark that names no source version", () => {
    const outcome = planCollectionDelete(
      request(),
      facts({ mark: mark({ sourceVersionId: null }) })
    );
    expect(refusalOf(outcome).code).toBe("invalid_input");
  });
});

describe("MP15 the resumable phase set", () => {
  it("returns every phase when nothing has committed yet", () => {
    expect(remainingDeletePhases([])).toEqual([...COLLECTION_DELETE_PHASES]);
  });

  it("skips the phases a previous attempt recorded", () => {
    expect(
      remainingDeletePhases(["dependent_supports", "extraction_payloads"])
    ).toEqual(["assertion_supports", "frozen_units", "superseded_caches"]);
  });

  it("stops at an inclusive bound so a caller can run bounded steps", () => {
    expect(remainingDeletePhases([], "assertion_supports")).toEqual([
      "dependent_supports",
      "extraction_payloads",
      "assertion_supports",
    ]);
    // The bound still skips what committed: a bounded step is a step, not a reset.
    expect(
      remainingDeletePhases(["dependent_supports"], "assertion_supports")
    ).toEqual(["extraction_payloads", "assertion_supports"]);
  });

  it("returns nothing once every phase is recorded", () => {
    const all: readonly CollectionDeletePhase[] = [...COLLECTION_DELETE_PHASES];
    expect(remainingDeletePhases(all)).toEqual([]);
  });
});
