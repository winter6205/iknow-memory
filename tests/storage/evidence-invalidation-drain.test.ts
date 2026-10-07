/**
 * The drain's derivations and the contract parse, with no database in the way.
 *
 * Companion to `tests/acceptance/structured-invalidation-drain-pg.test.ts`: that
 * file proves the drain answers from real rows inside one real transaction, and
 * everything HERE is a property of the TypeScript in front of the client — the
 * gap verdicts, the resume position, the closed request surface, and the version
 * refusal. Those are reachable with values alone, which is exactly why they are
 * not left to the real-PostgreSQL lane: a bad verdict there would look like an
 * empty stream rather than like the bug it is.
 */
import { describe, expect, it } from "vitest";

import { EVIDENCE_FAILURE } from "../../src/core/types.js";
import {
  DEFAULT_INVALIDATION_LIMIT,
  EVIDENCE_ACTION,
  EVIDENCE_REFUSAL_REASON,
  EvidenceRefusalError,
  MAX_INVALIDATION_LIMIT,
  parseEvidenceRequest,
  readPrivateEvidence,
  type EvidenceInvalidationsRequest,
} from "../../src/core/storage/evidence-read.js";
import {
  INVALIDATION_EVENT_FIELDS,
  planInvalidationDrain,
  renderInvalidationBatch,
} from "../../src/core/storage/evidence-invalidation-read.js";
import {
  mintInvalidationCheckpoint,
  decodeInvalidationCheckpoint,
  type InvalidationCheckpointKey,
} from "../../src/core/storage/evidence-invalidation-checkpoint.js";
import type { EvidenceInvalidationCursor } from "../../src/core/storage/invalidation-outbox.js";
import {
  mintAuthorizedScopeContext,
  type AuthorizedScopeContext,
} from "../../src/core/storage/structured-scope-types.js";

const KEY: InvalidationCheckpointKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8"
);
const CONSUMER = "fin-consumer";

/** A cursor whose allocation watermark is the only fact these cases need. */
function cursor(lastAllocatedSeq: number): EvidenceInvalidationCursor {
  return {
    consumer_id: CONSUMER,
    acked_checkpoint: "",
    acked_seq: 0,
    acked_at: "2026-10-08T00:00:00.000Z",
    last_allocated_seq: lastAllocatedSeq,
  };
}

function plan(
  overrides: {
    checkpoint?: string | null;
    firstRetainedSeq?: number | null;
    cursor?: EvidenceInvalidationCursor | null;
    decode?: (raw: string, owner: string) => { readonly s: number } | null;
  } = {}
): { startSeq: number; gap: boolean } {
  return planInvalidationDrain({
    consumerId: CONSUMER,
    checkpoint: overrides.checkpoint ?? null,
    cursor: overrides.cursor === undefined ? cursor(10) : overrides.cursor,
    firstRetainedSeq:
      overrides.firstRetainedSeq === undefined ? 1 : overrides.firstRetainedSeq,
    decode:
      overrides.decode ??
      ((raw, owner) => decodeInvalidationCheckpoint(raw, owner, KEY)),
  });
}

function row(seq: number, reason = "purged"): Record<string, unknown> {
  return {
    seq: String(seq),
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    evidence_ref: `ref-${seq}`,
    reason,
    occurred_at: "2026-10-08T00:00:07.482Z",
  };
}

describe("planning a drain", () => {
  it("starts a first drain at the earliest retained row, with no gap", () => {
    // No checkpoint is not a gap: nothing has been missed, so the consumer must
    // not be told to revalidate a window it never had.
    expect(plan({ firstRetainedSeq: 1 })).toEqual({ startSeq: 1, gap: false });
    expect(plan({ firstRetainedSeq: 41 })).toEqual({ startSeq: 41, gap: false });
    // An empty stream has no floor and therefore no window that could be lost.
    expect(plan({ firstRetainedSeq: null })).toEqual({ startSeq: 1, gap: false });
  });

  it("resumes strictly above a retained checkpoint", () => {
    const checkpoint = mintInvalidationCheckpoint(4, CONSUMER, KEY);
    expect(plan({ checkpoint, firstRetainedSeq: 1 })).toEqual({
      startSeq: 5,
      gap: false,
    });
  });

  it("reports a gap for a checkpoint it cannot authenticate", () => {
    expect(plan({ checkpoint: "not-a-token" })).toEqual({
      startSeq: 1,
      gap: true,
    });
  });

  it("reports a gap for a checkpoint minted for another consumer", () => {
    const foreign = mintInvalidationCheckpoint(2, "someone-else", KEY);
    expect(plan({ checkpoint: foreign })).toEqual({ startSeq: 1, gap: true });
  });

  it("reports a gap for a position past the stream's own watermark", () => {
    // The backend allocated only 10, so a checkpoint claiming 11 was never
    // issued — and ADR 0097 §2.7 makes that the BACKEND's verdict to declare,
    // never the consumer's to infer from the batch it did not get.
    const ahead = mintInvalidationCheckpoint(11, CONSUMER, KEY);
    expect(plan({ checkpoint: ahead, cursor: cursor(10) })).toEqual({
      startSeq: 1,
      gap: true,
    });
    expect(
      plan({ checkpoint: mintInvalidationCheckpoint(10, CONSUMER, KEY), cursor: cursor(10) })
    ).toEqual({ startSeq: 11, gap: false });
  });

  it("reports a gap when the covered position precedes the retained window", () => {
    const stale = mintInvalidationCheckpoint(2, CONSUMER, KEY);
    expect(plan({ checkpoint: stale, firstRetainedSeq: 7 })).toEqual({
      startSeq: 7,
      gap: true,
    });
    // Exactly one retained row above the covered position is contiguity, not a
    // hole: the boundary case is what makes `+ 1` load-bearing.
    expect(
      plan({ checkpoint: stale, firstRetainedSeq: 3 })
    ).toEqual({ startSeq: 3, gap: false });
  });

  it("never reports a gap when the consumer has no cursor row yet", () => {
    expect(
      plan({ checkpoint: mintInvalidationCheckpoint(0, CONSUMER, KEY), cursor: null })
    ).toEqual({ startSeq: 1, gap: false });
  });
});

describe("rendering a batch", () => {
  it("emits the five closed event fields of ADR 0097 §2.1", () => {
    const batch = renderInvalidationBatch([row(1)], {
      consumerId: CONSUMER,
      coveredSeq: 0,
      key: KEY,
    });
    expect(Object.keys(batch.events[0]).sort()).toEqual(
      [...INVALIDATION_EVENT_FIELDS].sort()
    );
    // No `schema_version` on the event: ADR 0097's amendment withdrew it, and a
    // consumer's closed-key parser refuses an unexpected key rather than
    // dropping it.
    expect(batch.events[0]).not.toHaveProperty("schema_version");
    expect(batch.events[0]).not.toHaveProperty("consumer_id");
  });

  it("renders occurred_at in the contract's whole-second Z form", () => {
    const batch = renderInvalidationBatch([row(1)], {
      consumerId: CONSUMER,
      coveredSeq: 0,
      key: KEY,
    });
    // Truncated, not rounded: 00:00:07.482 is the 7th second, and rounding
    // would name the 8th — an instant the producer never wrote.
    expect(batch.events[0].occurred_at).toBe("2026-10-08T00:00:07Z");
  });

  it("keeps seq gapless and never renumbers or compacts", () => {
    const batch = renderInvalidationBatch([row(3), row(4), row(7)], {
      consumerId: CONSUMER,
      coveredSeq: 2,
      key: KEY,
    });
    expect(batch.events.map((event) => event.seq)).toEqual([3, 4, 7]);
    // The hole is still a hole on the wire: a consumer's own contiguity check is
    // what turns it into a refusal, and it cannot if the rows were rewritten.
    const covered = decodeInvalidationCheckpoint(
      batch.next_checkpoint,
      CONSUMER,
      KEY
    );
    expect(covered?.s).toBe(7);
  });

  it("mints the position it was given when the batch is empty", () => {
    const empty = renderInvalidationBatch([], {
      consumerId: CONSUMER,
      coveredSeq: 9,
      key: KEY,
    });
    expect(empty.events).toEqual([]);
    expect(decodeInvalidationCheckpoint(empty.next_checkpoint, CONSUMER, KEY)?.s).toBe(9);
  });

  it("raises a typed store fault rather than emitting an unknown reason", () => {
    expect(() =>
      renderInvalidationBatch([row(1, "expired")], {
        consumerId: CONSUMER,
        coveredSeq: 0,
        key: KEY,
      })
    ).toThrowError(/closed vocabulary/);
  });
});

describe("the invalidations request surface", () => {
  const base = {
    schema: "iknow.evidence_request",
    schema_version: 1,
    action: "invalidations",
  };

  it("resolves an absent limit to the spec's documented default", () => {
    const parsed = parseEvidenceRequest(base) as EvidenceInvalidationsRequest;
    expect(parsed).toEqual({
      action: EVIDENCE_ACTION.INVALIDATIONS,
      checkpoint: null,
      limit: DEFAULT_INVALIDATION_LIMIT,
    });
  });

  it("treats absent and null checkpoint as the same first-drain position", () => {
    expect(
      (parseEvidenceRequest({ ...base, checkpoint: null }) as EvidenceInvalidationsRequest)
        .checkpoint
    ).toBeNull();
    expect(
      (parseEvidenceRequest({ ...base }) as EvidenceInvalidationsRequest).checkpoint
    ).toBeNull();
  });

  it("accepts the documented limit window", () => {
    for (const limit of [1, MAX_INVALIDATION_LIMIT]) {
      expect(
        (parseEvidenceRequest({ ...base, limit }) as EvidenceInvalidationsRequest).limit
      ).toBe(limit);
    }
  });

  it("refuses a limit outside the window rather than clamping it", () => {
    for (const limit of [0, -1, MAX_INVALIDATION_LIMIT + 1, 2.5, "20"]) {
      expect(() => parseEvidenceRequest({ ...base, limit })).toThrowError(
        EvidenceRefusalError
      );
      try {
        parseEvidenceRequest({ ...base, limit });
      } catch (error) {
        expect((error as EvidenceRefusalError).code).toBe(
          EVIDENCE_FAILURE.MALFORMED_CONTRACT
        );
        expect((error as EvidenceRefusalError).reason).toBe(
          EVIDENCE_REFUSAL_REASON.INVALIDATION_LIMIT_OUT_OF_RANGE
        );
      }
    }
  });

  it("refuses an identity asserted on the request channel", () => {
    // Structural rather than aspirational: there is no code path that copies an
    // unlisted key anywhere, and `consumer_id` is not on this action's key set.
    for (const key of ["consumer_id", "consumerId", "evidence_ref"]) {
      expect(() =>
        parseEvidenceRequest({ ...base, [key]: "fin-consumer" })
      ).toThrowError(/accepts only/);
    }
  });

  it("refuses a non-integer schema_version as malformed", () => {
    for (const schemaVersion of ["1", 1.5, null, undefined]) {
      try {
        parseEvidenceRequest({ ...base, schema_version: schemaVersion });
        throw new Error("a non-integer schema_version was accepted");
      } catch (error) {
        expect((error as EvidenceRefusalError).code).toBe(
          EVIDENCE_FAILURE.MALFORMED_CONTRACT
        );
      }
    }
  });

  it("refuses an unimplemented schema_version with its own token (register §1b.5)", () => {
    // The case this whole decision exists for: an integer this build does not
    // speak is `unsupported_evidence_contract`, never a silent read as version 1.
    for (const schemaVersion of [0, 2, 99, -1]) {
      try {
        parseEvidenceRequest({ ...base, schema_version: schemaVersion });
        throw new Error(`schema_version ${schemaVersion} was accepted`);
      } catch (error) {
        expect((error as EvidenceRefusalError).code).toBe(
          EVIDENCE_FAILURE.UNSUPPORTED_CONTRACT
        );
        expect((error as EvidenceRefusalError).reason).toBe(
          EVIDENCE_REFUSAL_REASON.UNSUPPORTED_CONTRACT_VERSION
        );
      }
    }
  });

  it("refuses the drain on the grant read rather than reading a grant", async () => {
    // A genuinely MINTED context, so the refusal under test is the drain's
    // mis-route and not the earlier authority check: `scopeAuthorityOf`
    // recognises a context by the identity of the seam that minted it.
    const authority = {} as never;
    const context = mintAuthorizedScopeContext(
      {
        actorId: "actor",
        ownerScopeBinding: "scope",
        readerBinding: "reader",
        authorizedSourceRefs: ["source-a"],
        authorizationRevision: "rev-1",
        deadlineAt: "2026-10-08T00:00:00.000Z",
      },
      authority
    );
    await expect(
      readPrivateEvidence(
        authority,
        context,
        parseEvidenceRequest(base),
        "2026-10-08T00:00:00.000Z"
      )
    ).rejects.toThrowError(EvidenceRefusalError);
    await expect(
      readPrivateEvidence(
        authority,
        context,
        parseEvidenceRequest(base),
        "2026-10-08T00:00:00.000Z"
      )
    ).rejects.toThrowError(/answered by the invalidation reader/);
  });
});