/**
 * MP17's derivations and its closed contract surfaces, with no database in the
 * way: the acknowledgement decision, the retention decision, the `ack` request
 * parse, and ADR 0099 §2.4a's writer separation.
 *
 * Companion to `tests/acceptance/structured-purge-completion-pg.test.ts`, which
 * proves the same guards against real rows inside a real transaction. Everything
 * HERE is a property of the TypeScript in front of the client — and each one is
 * the kind of bug that looks like an empty stream, a stale cursor or an absent
 * scrub when it reaches the real store rather than a wrong answer, which is why
 * none of it is left to the database lane alone.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVIDENCE_FAILURE } from "../../src/core/types.js";
import { planAckAdvance } from "../../src/core/storage/evidence-invalidation-ack.js";
import {
  EVIDENCE_ACTION,
  EVIDENCE_REFUSAL_REASON,
  EvidenceRefusalError,
  parseEvidenceRequest,
  readPrivateEvidence,
  type EvidenceAckRequest,
} from "../../src/core/storage/evidence-read.js";
import {
  planInvalidationRetention,
  type RetainedInvalidationEvent,
} from "../../src/core/storage/invalidation-outbox.js";
import {
  PURGE_ACK_STATES,
  PURGE_COLLECTION_STATES,
} from "../../src/core/storage/schema-structured-completion.js";
import {
  mintAuthorizedScopeContext,
  type AuthorizedScopeContext,
} from "../../src/core/storage/structured-scope-types.js";

const CONSUMER = "fin-consumer";
const NOW = "2026-10-08T00:00:00.000Z";
const FUTURE = "2027-10-08T00:00:00.000Z";
const PAST = "2026-10-07T00:00:00.000Z";

function retained(
  overrides: Partial<RetainedInvalidationEvent> & { readonly eventId: string }
): RetainedInvalidationEvent {
  return {
    seq: 1,
    ackedSeq: null,
    grantExpiresAt: FUTURE,
    ...overrides,
  };
}

describe("deciding an acknowledgement", () => {
  it("advances over a range whose earliest retained event still opens it", () => {
    // Three events, one cursor row that has acknowledged none of them: the ack
    // covers seq 3 and the stream still opens at 1, so every event in the range
    // was handed to this consumer.
    expect(
      planAckAdvance({
        coveredSeq: 3,
        cursor: {
          consumer_id: CONSUMER,
          acked_checkpoint: "",
          acked_seq: 0,
          acked_at: NOW,
          last_allocated_seq: 3,
        },
        firstRetainedSeq: 1,
      })
    ).toEqual({ state: "advance", coveredSeq: 3 });
  });

  it("advances over a range whose first rows were collected by the retention sweep", () => {
    // The offline-owner case the retention clause exists for: a sweep collected
    // the earliest un-acked rows (grant expired, ADR 0099 §2.3), so the window
    // now opens at 4. Under the old coveredRows comparison this acknowledgement
    // was refused forever; the floor test sees the range still holds its own
    // beginning (the row at ackedSeq+1) and advances. Nothing un-judged is lost —
    // the positions below the floor were the sweep's own verdict, not a skip.
    expect(
      planAckAdvance({
        coveredSeq: 6,
        cursor: {
          consumer_id: CONSUMER,
          acked_checkpoint: "",
          acked_seq: 3,
          acked_at: NOW,
          last_allocated_seq: 6,
        },
        firstRetainedSeq: 4,
      })
    ).toEqual({ state: "advance", coveredSeq: 6 });
  });

  it("advances on an empty stream, where a sweep has left no floor at all", () => {
    // Every event of the range collected by retention, so the window is gone
    // entirely. `null` is the same "lost to the sweep, not skipped" fact.
    expect(
      planAckAdvance({
        coveredSeq: 6,
        cursor: {
          consumer_id: CONSUMER,
          acked_checkpoint: "",
          acked_seq: 3,
          acked_at: NOW,
          last_allocated_seq: 6,
        },
        firstRetainedSeq: null,
      })
    ).toEqual({ state: "advance", coveredSeq: 6 });
  });

  it("refuses a position past anything this stream handed out", () => {
    // The signature says this deployment minted it; the watermark says it did not
    // mint it at a position that exists. The watermark has to win, because a
    // signature proves authorship, not existence.
    const plan = planAckAdvance({
      coveredSeq: 11,
      cursor: {
        consumer_id: CONSUMER,
        acked_checkpoint: "",
        acked_seq: 0,
        acked_at: NOW,
        last_allocated_seq: 10,
      },
      firstRetainedSeq: 1,
    });
    expect(plan.state).toBe("refused");
    expect(plan.state === "refused" && plan.reason).toBe(
      EVIDENCE_REFUSAL_REASON.ACK_CHECKPOINT_NEVER_ISSUED
    );
  });

  it("refuses a position that would move the stored one backwards", () => {
    const plan = planAckAdvance({
      coveredSeq: 4,
      cursor: {
        consumer_id: CONSUMER,
        acked_checkpoint: "",
        acked_seq: 7,
        acked_at: NOW,
        last_allocated_seq: 10,
      },
      // An intact floor on purpose: the range IS contiguous, so only the
      // direction can be the fault, and this proves the two refusals do not
      // overlap.
      firstRetainedSeq: 8,
    });
    expect(plan.state).toBe("refused");
    expect(plan.state === "refused" && plan.reason).toBe(
      EVIDENCE_REFUSAL_REASON.ACK_WOULD_MOVE_BACKWARDS
    );
  });

  it("treats the position already acknowledged as idempotent, not as a fault", () => {
    // fin's two-phase split means a crash between its scrub commit and its own
    // record re-presents a token the backend already accepted. Refusing that would
    // make recovery impossible.
    expect(
      planAckAdvance({
        coveredSeq: 7,
        cursor: {
          consumer_id: CONSUMER,
          acked_checkpoint: "",
          acked_seq: 7,
          acked_at: NOW,
          last_allocated_seq: 10,
        },
        firstRetainedSeq: 8,
      })
    ).toEqual({ state: "already_acknowledged", coveredSeq: 7 });
  });

  it("accepts a first acknowledgement of position zero on an empty stream", () => {
    // A drain of a stream with nothing pending mints a checkpoint covering 0. That
    // is a real acknowledgement and must not be refused as a no-op backwards move.
    expect(
      planAckAdvance({
        coveredSeq: 0,
        cursor: null,
        firstRetainedSeq: null,
      })
    ).toEqual({ state: "already_acknowledged", coveredSeq: 0 });
  });

  it("refuses a range that has lost its own beginning", () => {
    // The earliest retained event sits ABOVE ackedSeq+1, so the row the range
    // must open with is gone and the backend cannot say by what — no later
    // acknowledgement can repair that, so it is refused rather than assumed.
    const plan = planAckAdvance({
      coveredSeq: 3,
      cursor: {
        consumer_id: CONSUMER,
        acked_checkpoint: "",
        acked_seq: 0,
        acked_at: NOW,
        last_allocated_seq: 3,
      },
      firstRetainedSeq: 2,
    });
    expect(plan.state).toBe("refused");
    expect(plan.state === "refused" && plan.reason).toBe(
      EVIDENCE_REFUSAL_REASON.ACK_RANGE_NOT_CONTIGUOUS
    );
  });
});

describe("planning the retention sweep", () => {
  it("retains an unacknowledged event whose grant is still unexpired", () => {
    // The clause register §1.6 exists for: the owner may never come back, but the
    // grant has not expired, so dropping the event now would destroy the only
    // record that fin was ever told about this reference.
    const plan = planInvalidationRetention(
      [retained({ eventId: "e1", seq: 1, ackedSeq: null, grantExpiresAt: FUTURE })],
      NOW
    );
    expect(plan.retainedEventIds).toEqual(["e1"]);
    expect(plan.collectedEventIds).toEqual([]);
  });

  it("collects an unacknowledged event once its grant has expired", () => {
    // Evidence spec `:265`: expiry lets both stores collect payloads without
    // depending on acknowledgements. The event is NOT marked acknowledged — the
    // sweep has no business writing that fact.
    const plan = planInvalidationRetention(
      [retained({ eventId: "e1", seq: 1, ackedSeq: null, grantExpiresAt: PAST })],
      NOW
    );
    expect(plan.collectedEventIds).toEqual(["e1"]);
    expect(plan.retainedEventIds).toEqual([]);
  });

  it("collects an acknowledged event even on an unexpired grant", () => {
    // The other half of the same rule: an event the consumer acknowledged has
    // served its purpose, and the drain resumes above that position rather than
    // from it, so retaining it protects nothing.
    const plan = planInvalidationRetention(
      [retained({ eventId: "e1", seq: 2, ackedSeq: 5, grantExpiresAt: FUTURE })],
      NOW
    );
    expect(plan.collectedEventIds).toEqual(["e1"]);
  });

  it("retains an event ABOVE the acknowledged position on an unexpired grant", () => {
    // The direction matters: acknowledging through seq 2 says nothing about seq 3.
    const plan = planInvalidationRetention(
      [
        retained({ eventId: "acked", seq: 2, ackedSeq: 2, grantExpiresAt: FUTURE }),
        retained({ eventId: "pending", seq: 3, ackedSeq: 2, grantExpiresAt: FUTURE }),
      ],
      NOW
    );
    expect(plan.collectedEventIds).toEqual(["acked"]);
    expect(plan.retainedEventIds).toEqual(["pending"]);
  });

  it("collects an event whose grant row is gone", () => {
    // A collected grant does not REMAIN unexpired, so the retention clause no
    // longer applies to it — which is the case MP15's deletion creates.
    const plan = planInvalidationRetention(
      [retained({ eventId: "e1", seq: 1, ackedSeq: null, grantExpiresAt: null })],
      NOW
    );
    expect(plan.collectedEventIds).toEqual(["e1"]);
  });

  it("treats a consumer with no cursor row as having acknowledged nothing", () => {
    const plan = planInvalidationRetention(
      [retained({ eventId: "e1", seq: 1, ackedSeq: null, grantExpiresAt: FUTURE })],
      NOW
    );
    expect(plan.retainedEventIds).toEqual(["e1"]);
  });

  it("refuses to plan against an unreadable instant rather than guessing", () => {
    expect(() =>
      planInvalidationRetention([retained({ eventId: "e1" })], "not-a-time")
    ).toThrowError(/readable timestamp/);
  });
});

describe("the ack request surface", () => {
  const base = {
    schema: "iknow.evidence_request",
    schema_version: 1,
    action: "ack",
    checkpoint: "token",
  };

  it("accepts exactly the documented request", () => {
    const parsed = parseEvidenceRequest(base) as EvidenceAckRequest;
    expect(parsed).toEqual({ action: "ack", checkpoint: "token" });
  });

  it("requires a position, and refuses every spelling of its absence", () => {
    // The asymmetry with `invalidations` is the contract: a drain may start from
    // nowhere, while an acknowledgement with no position has nothing to do. Each
    // case is spelled as a WHOLE body rather than a spread over `base`, because a
    // spread cannot delete a key and would silently leave the present one in place
    // — which is how "absent is refused" passes while never testing absence.
    const bodies = [
      { schema: "iknow.evidence_request", schema_version: 1, action: "ack" },
      { ...base, checkpoint: null },
      { ...base, checkpoint: "" },
      { ...base, checkpoint: "   " },
    ];
    for (const body of bodies) {
      expect(() => parseEvidenceRequest(body)).toThrowError(EvidenceRefusalError);
    }
  });

  it("refuses a non-text checkpoint", () => {
    for (const value of [7, {}, [], true]) {
      expect(() =>
        parseEvidenceRequest({ ...base, checkpoint: value })
      ).toThrowError(/non-empty checkpoint/);
    }
  });

  it("refuses an asserted identity, because the transport supplies the consumer", () => {
    for (const key of ["consumer_id", "trusted_consumer", "actor_id", "scope_binding"]) {
      expect(() =>
        parseEvidenceRequest({ ...base, [key]: "someone-else" })
      ).toThrowError(/accepts only/);
    }
  });

  it("refuses evidence_ref and limit, which are the other actions' fields", () => {
    expect(() => parseEvidenceRequest({ ...base, evidence_ref: "ref" })).toThrowError(
      /accepts only/
    );
    expect(() => parseEvidenceRequest({ ...base, limit: 5 })).toThrowError(
      /accepts only/
    );
  });

  it("still refuses an unimplemented envelope version", () => {
    try {
      parseEvidenceRequest({ ...base, schema_version: 2 });
      throw new Error("schema_version 2 was accepted");
    } catch (error) {
      expect((error as EvidenceRefusalError).code).toBe(
        EVIDENCE_FAILURE.UNSUPPORTED_CONTRACT
      );
    }
  });

  it("refuses ack on the grant read rather than opening a read-only unit of work", async () => {
    // A genuinely MINTED context, so the refusal under test is the mis-route and
    // not the earlier authority check.
    const authority = {} as never;
    const context = mintAuthorizedScopeContext(
      {
        actorId: "actor",
        ownerScopeBinding: "scope",
        readerBinding: "reader",
        authorizedSourceRefs: ["source-a"],
        authorizationRevision: "rev-1",
        deadlineAt: NOW,
      },
      authority
    );
    await expect(
      readPrivateEvidence(
        authority,
        context,
        parseEvidenceRequest(base),
        NOW
      )
    ).rejects.toThrowError(/answered by the invalidation acknowledgement store/);
  });
});

describe("ADR 0099 §2.4a's writer separation", () => {
  const storageDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../src/core/storage"
  );

  /**
   * The source with its comments removed.
   *
   * Necessary rather than pedantic: the property under test is about STATEMENTS,
   * and these modules' docblocks legitimately discuss the column by name — the
   * purge's says in as many words that it never sets it. Scanning the prose would
   * make the test fail on the documentation of the rule it enforces.
   *
   * The `//` pattern is anchored to a line start so a `//` inside a string is not
   * mistaken for a comment; no statement in this storage layer contains one.
   */
  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
  }

  it("gives completed_at exactly one writer in the storage layer", () => {
    // The claim under test is a schema-and-code-shape property, so it is checked
    // as one: a second module that writes the column at all is a second candidate
    // writer, whether or not its statement is reachable today.
    const offenders = readdirSync(storageDir)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) =>
        withoutComments(readFileSync(join(storageDir, name), "utf8")).includes(
          "completed_at"
        )
      )
      .filter((name) => name !== "schema-structured-completion.ts")
      .filter((name) => name !== "structured-purge-completion.ts");
    expect(offenders).toEqual([]);
  });

  it("updates completed_at in exactly one statement, in the reconciler", () => {
    const source = withoutComments(
      readFileSync(join(storageDir, "structured-purge-completion.ts"), "utf8")
    );
    const updates = source.match(/UPDATE structured_purge_outcomes/g) ?? [];
    // Two in total: the guarded completion and `recordPayloadCollection`, which
    // sets `collection_state` and never `completed_at`. A third would be a writer.
    expect(updates).toHaveLength(2);
    const completionUpdates = source.match(
      /UPDATE structured_purge_outcomes o\n\s+SET completed_at = now\(\)/g
    );
    expect(completionUpdates).toHaveLength(1);
  });

  it("has no writer for completed_at outside the reconciler module", () => {
    // The other half of the same property, stated as code rather than as shape:
    // the purge, the acknowledgement and the drain must contain no statement that
    // sets it.
    for (const module of [
      "structured-purge-pg.ts",
      "evidence-invalidation-ack.ts",
      "evidence-invalidation-read.ts",
    ]) {
      const source = withoutComments(
        readFileSync(join(storageDir, module), "utf8")
      );
      expect(source).not.toMatch(/SET[^;]*completed_at/);
    }
  });
});

describe("the four-state vocabularies", () => {
  it("closes the revision and owner states at the ADR 0099 §2.1 members", () => {
    // A vocabulary that gains a member would let a writer name a state no contract
    // defines, so the counts are asserted rather than the documentation.
    expect(PURGE_COLLECTION_STATES).toEqual(["scheduled", "collected"]);
    expect(PURGE_ACK_STATES).toEqual(["scheduled", "scrubbed"]);
  });

  it("names four actions, and none of them is outside the spec's union", () => {
    // The spec's table at `:220-227` is normative; this is the guard that a later
    // slice cannot quietly add a fifth action to `iknow.evidence_request`.
    expect(Object.values(EVIDENCE_ACTION).sort()).toEqual([
      "ack",
      "invalidations",
      "read",
      "supports",
    ]);
  });

  it("keeps the mis-route refusal tokens distinct", () => {
    expect(EVIDENCE_REFUSAL_REASON.ACK_NOT_A_GRANT_READ).not.toBe(
      EVIDENCE_REFUSAL_REASON.INVALIDATIONS_NOT_A_GRANT_READ
    );
  });

  it("names the four ack refusals in the shared vocabulary, typed into it", () => {
    // The tokens live in `EVIDENCE_REFUSAL_REASON` and `AckRefusalReason` is a
    // union of them, so the compiler checks every refusal instead of a cast
    // silencing it: a downstream `switch` on `EvidenceRefusal["reason"]` can no
    // longer fall through on an ack token. The file-level shape guard below
    // (`no writer for completed_at outside the reconciler module`) doubles as the
    // check that no parallel `ACK_REFUSAL_REASON` const has reappeared beside
    // this module's import surface — the union must point at the one vocabulary.
    expect(EVIDENCE_REFUSAL_REASON.ACK_CHECKPOINT_NOT_MINTED_HERE).toBe(
      "ack_checkpoint_not_minted_here"
    );
    expect(EVIDENCE_REFUSAL_REASON.ACK_CHECKPOINT_NEVER_ISSUED).toBe(
      "ack_checkpoint_never_issued"
    );
    expect(EVIDENCE_REFUSAL_REASON.ACK_WOULD_MOVE_BACKWARDS).toBe(
      "ack_would_move_backwards"
    );
    expect(EVIDENCE_REFUSAL_REASON.ACK_RANGE_NOT_CONTIGUOUS).toBe(
      "ack_range_not_contiguous"
    );
  });
});