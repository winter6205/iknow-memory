/**
 * The `ack` write transaction, over a recording client: register §1.5's
 * re-verification, ADR 0097 §4.5's three checks, and the two monotonicity
 * statements that make an acknowledgement irreversible.
 *
 * Companion to `tests/acceptance/structured-purge-completion-pg.test.ts`, which
 * proves the same guards against real rows. What ONLY this lane can see is the
 * transaction's SHAPE — that the acknowledgement opens a write transaction of its
 * own, that the identity is re-checked inside it, and that the two monotonic
 * guards are present in the statements themselves. Against a real database those
 * are invisible on the happy path: a split re-verification and an intact one
 * produce identical rows, so the only place the difference is observable is the
 * statement list.
 */
import { describe, expect, it } from "vitest";

import { EVIDENCE_FAILURE } from "../../src/core/types.js";
import { PgEvidenceInvalidationAckStore } from "../../src/core/storage/evidence-invalidation-ack.js";
import {
  mintInvalidationCheckpoint,
  type InvalidationCheckpointKey,
} from "../../src/core/storage/evidence-invalidation-checkpoint.js";
import {
  EVIDENCE_ACTION,
  EVIDENCE_REFUSAL_REASON,
  EvidenceRefusalError,
  type EvidenceAckRequest,
} from "../../src/core/storage/evidence-read.js";
import type { EvidenceInvalidationCursor } from "../../src/core/storage/invalidation-outbox.js";
import { structuredScopeError } from "../../src/core/storage/structured-scope-types.js";
import {
  mintAuthorizedScopeContext,
  type AuthorizedScopeContext,
  type AuthorizedScopeUnitOfWork,
  type ScopeTransactionClient,
  type ScopeTransactionOwner,
} from "../../src/core/storage/structured-scope-types.js";

const KEY: InvalidationCheckpointKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8"
);
const CONSUMER = "fin-consumer";
const OTHER_CONSUMER = "fin-consumer-other";
const SCOPE = "scope-a";
const DEADLINE = "2026-10-08T01:00:00.000Z";

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * A client that answers the three statements this path issues and records
 * everything, including the transaction bracket.
 *
 * The answers are keyed on the statement, not on a call order, so a reordering
 * cannot make a case pass for the wrong reason. `firstSeq` answers the
 * `readFirstRetainedSeq` query — the delivery fact the new contiguity test reads
 * from the stream rather than the row count the old one counted.
 */
function fakeClient(input: {
  authorizationRevision?: string | null;
  cursor?: EvidenceInvalidationCursor | null;
  firstSeq?: number | null;
  advancedTo?: number;
}): {
  client: ScopeTransactionClient;
  statements: Recorded[];
} {
  const statements: Recorded[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      statements.push({ text, values });
      if (text.includes("authorization_revision")) {
        return {
          rows:
            input.authorizationRevision === null
              ? []
              : [
                  {
                    authorization_revision:
                      input.authorizationRevision ?? "rev-1",
                  },
                ],
        };
      }
      if (text.includes("FROM evidence_invalidation_cursors")) {
        return { rows: input.cursor === null ? [] : [cursorRow(input.cursor)] };
      }
      if (text.includes("min(seq) AS first_seq")) {
        return {
          rows:
            input.firstSeq === null || input.firstSeq === undefined
              ? [{ first_seq: null }]
              : [{ first_seq: String(input.firstSeq) }],
        };
      }
      if (text.includes("UPDATE evidence_invalidation_cursors")) {
        return {
          rows:
            input.advancedTo === undefined
              ? []
              : [{ acked_seq: String(input.advancedTo) }],
        };
      }
      if (text.includes("UPDATE structured_purge_ack_states")) {
        return { rows: [{ purge_revision: "purge-rev-1" }] };
      }
      return { rows: [] };
    },
  } as unknown as ScopeTransactionClient;
  return { client, statements };
}

function cursorRow(cursor: EvidenceInvalidationCursor): Record<string, unknown> {
  return {
    consumer_id: cursor.consumer_id,
    acked_checkpoint: cursor.acked_checkpoint,
    acked_seq: String(cursor.acked_seq),
    acked_at: cursor.acked_at,
    last_allocated_seq: String(cursor.last_allocated_seq),
  };
}

function cursor(overrides: Partial<EvidenceInvalidationCursor> = {}): EvidenceInvalidationCursor {
  return {
    consumer_id: CONSUMER,
    acked_checkpoint: "",
    acked_seq: 0,
    acked_at: "2026-10-08T00:00:00.000Z",
    last_allocated_seq: 3,
    ...overrides,
  };
}

/**
 * The seam both halves, wired to the fake client.
 *
 * `runTransaction` reproduces the production bracket — the recorded BEGIN, the
 * callback, the COMMIT, and the default `fail` mapping — so a test asserting on
 * the statements sees the same sequence production issues.
 */
function fakeAuthority(client: ScopeTransactionClient): {
  authority: AuthorizedScopeUnitOfWork & ScopeTransactionOwner;
  statements: Recorded[];
} {
  const statements: Recorded[] = [];
  const original = client.query.bind(client);
  const recording = {
    query: async (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      return original(text, values);
    },
  } as unknown as ScopeTransactionClient;
  const authority = {
    createAuthorizedContext: (() => {
      throw new Error("the fake mints through mintAuthorizedScopeContext");
    }) as never,
    withAuthorizedScope: (() => {
      throw new Error("the ack store does not use the scope unit of work");
    }) as never,
    async runTransaction<R>(
      body: (c: ScopeTransactionClient) => Promise<R>,
      options?: { readonly readOnly?: boolean; readonly fail?: (e: unknown) => Error }
    ): Promise<R> {
      await recording.query(
        options?.readOnly
          ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
          : "BEGIN"
      );
      try {
        const result = await body(recording);
        await recording.query("COMMIT");
        return result;
      } catch (error) {
        throw options?.fail ? options.fail(error) : structuredScopeError(error);
      }
    },
  };
  return { authority: authority as unknown as AuthorizedScopeUnitOfWork & ScopeTransactionOwner, statements };
}

function context(authority: AuthorizedScopeUnitOfWork): AuthorizedScopeContext {
  return mintAuthorizedScopeContext(
    {
      actorId: "actor",
      ownerScopeBinding: SCOPE,
      readerBinding: "reader",
      authorizedSourceRefs: ["source-a"],
      authorizationRevision: "rev-1",
      deadlineAt: DEADLINE,
    },
    authority
  );
}

function ack(checkpoint: string): EvidenceAckRequest {
  return { action: EVIDENCE_ACTION.ACK, checkpoint };
}

/** Every statement matching a fragment, in order. */
function matching(statements: readonly Recorded[], fragment: string): Recorded[] {
  return statements.filter((statement) => statement.text.includes(fragment));
}

interface AckAttempt {
  readonly result: Awaited<
    ReturnType<PgEvidenceInvalidationAckStore["acknowledgeInvalidations"]>
  > | null;
  readonly statements: readonly Recorded[];
  readonly error: EvidenceRefusalError | Error | null;
}

/**
 * One acknowledgement, recording whatever it did or refused.
 *
 * The refusal is a VALUE here rather than a throw, because the property several
 * cases below test is what the transaction did BEFORE refusing — that a backwards
 * or unauthentic ack issues no write at all — and a throwing helper would have
 * thrown away the statements that prove it.
 */
async function attempt(input: {
  authorizationRevision?: string | null;
  cursor?: EvidenceInvalidationCursor | null;
  firstSeq?: number | null;
  advancedTo?: number;
  checkpoint: string;
  consumerId?: string;
}): Promise<AckAttempt> {
  const { client } = fakeClient({
    authorizationRevision: input.authorizationRevision,
    cursor: input.cursor === undefined ? cursor() : input.cursor,
    firstSeq: input.firstSeq,
    advancedTo: input.advancedTo,
  });
  const { authority, statements } = fakeAuthority(client);
  const store = new PgEvidenceInvalidationAckStore(authority, KEY);
  try {
    const result = await store.acknowledgeInvalidations(
      context(authority),
      input.consumerId ?? CONSUMER,
      ack(input.checkpoint)
    );
    return { result, statements, error: null };
  } catch (error) {
    return { result: null, statements, error: error as Error };
  }
}

/** The attempt that was refused, asserting the refusal rather than tolerating one. */
async function refusedAttempt(
  input: Parameters<typeof attempt>[0]
): Promise<{ readonly statements: readonly Recorded[]; readonly reason: string }> {
  const outcome = await attempt(input);
  expect(outcome.result).toBeNull();
  expect(outcome.error).toBeInstanceOf(EvidenceRefusalError);
  return {
    statements: outcome.statements,
    reason: (outcome.error as EvidenceRefusalError).reason,
  };
}

async function acknowledge(input: Parameters<typeof attempt>[0]) {
  const outcome = await attempt(input);
  if (outcome.error !== null) throw outcome.error;
  return { result: outcome.result!, statements: outcome.statements };
}

describe("the ack transaction's shape", () => {
  it("opens its OWN write transaction rather than the drain's read-only one", async () => {
    // Register §1.5 says "in its own write transaction". A `READ ONLY` bracket
    // would make the very write §1.5 re-verifies impossible, so the BEGIN itself
    // is asserted rather than assumed.
    const { statements } = await acknowledge({
      checkpoint: mintInvalidationCheckpoint(1, CONSUMER, KEY),
      firstSeq: 1,
      advancedTo: 1,
    });
    expect(statements[0]!.text).toBe("BEGIN");
    expect(matching(statements, "READ ONLY")).toHaveLength(0);
    expect(statements[statements.length - 1]!.text).toBe("COMMIT");
  });

  it("re-checks the identity INSIDE the transaction, before any stream read", async () => {
    // An identity validated before the transaction can be revoked before the
    // write; the placement is the fence, so the ORDER of the recorded statements
    // is the assertion.
    const { statements } = await acknowledge({
      checkpoint: mintInvalidationCheckpoint(1, CONSUMER, KEY),
      firstSeq: 1,
      advancedTo: 1,
    });
    const authorization = matching(statements, "authorization_revision")[0]!;
    const cursorRead = matching(statements, "FROM evidence_invalidation_cursors")[0]!;
    expect(statements.indexOf(authorization)).toBeGreaterThan(0);
    expect(statements.indexOf(authorization)).toBeLessThan(statements.indexOf(cursorRead));
  });

  it("refuses a revoked identity before it writes anything", async () => {
    await expect(
      acknowledge({
        authorizationRevision: "rev-2",
        checkpoint: mintInvalidationCheckpoint(1, CONSUMER, KEY),
        firstSeq: 1,
        advancedTo: 1,
      })
    ).rejects.toThrowError(/authorization changed/);
  });

  it("refuses a context this composition did not mint", async () => {
    const { client } = fakeClient({});
    const { authority } = fakeAuthority(client);
    const store = new PgEvidenceInvalidationAckStore(authority, KEY);
    const foreign = mintAuthorizedScopeContext(
      {
        actorId: "actor",
        ownerScopeBinding: SCOPE,
        readerBinding: "reader",
        authorizedSourceRefs: ["source-a"],
        authorizationRevision: "rev-1",
        deadlineAt: DEADLINE,
      },
      {} as AuthorizedScopeUnitOfWork
    );
    await expect(
      store.acknowledgeInvalidations(foreign, CONSUMER, ack("token"))
    ).rejects.toThrowError(/was not minted by this composition/);
  });

  it("refuses a transport consumer id it cannot resolve, and never defaults one", async () => {
    const { client } = fakeClient({});
    const { authority } = fakeAuthority(client);
    const store = new PgEvidenceInvalidationAckStore(authority, KEY);
    await expect(
      store.acknowledgeInvalidations(context(authority), "   ", ack("token"))
    ).rejects.toThrowError(/never defaulted/);
    await expect(
      store.acknowledgeInvalidations(context(authority), "x".repeat(513), ack("token"))
    ).rejects.toThrowError(/never defaulted/);
  });
});

describe("§1.5's re-verification, as guards on the statements", () => {
  it("states the forward-only fence on the cursor write itself", async () => {
    // The plan decides monotonicity and the statement re-states it, so a plan that
    // were ever wrong could not move the stored position backwards. Only the
    // statement can carry that second fence.
    const { statements } = await acknowledge({
      checkpoint: mintInvalidationCheckpoint(3, CONSUMER, KEY),
      firstSeq: 1,
      advancedTo: 3,
    });
    const update = matching(statements, "UPDATE evidence_invalidation_cursors")[0]!;
    expect(update.text).toMatch(/acked_seq < \$3/);
  });

  it("states the owner-row fence as a scheduled row and a covered position", async () => {
    const { statements } = await acknowledge({
      checkpoint: mintInvalidationCheckpoint(3, CONSUMER, KEY),
      firstSeq: 1,
      advancedTo: 3,
    });
    const update = matching(statements, "UPDATE structured_purge_ack_states")[0]!;
    expect(update.text).toMatch(/ack_state = 'scheduled'/);
    expect(update.text).toMatch(/>= covered_seq/);
    // The scope comes from the trusted context, never from the request, so it is
    // a bound value rather than something the payload could name.
    expect(update.values[0]).toBe(SCOPE);
    expect(update.values[1]).toBe(CONSUMER);
    expect(update.values[2]).toBe(3);
    expect(update.values[3]).toBe(
      mintInvalidationCheckpoint(3, CONSUMER, KEY)
    );
  });

  it("refuses a checkpoint that did not authenticate for this consumer", async () => {
    // One refusal for both a forged and a cross-consumer token, because the spec
    // treats them identically and the caller has one recovery for each.
    for (const checkpoint of [
      "not-a-token",
      mintInvalidationCheckpoint(2, OTHER_CONSUMER, KEY),
    ]) {
      const outcome = await attempt({ checkpoint });
      expect(outcome.error).toBeInstanceOf(EvidenceRefusalError);
      expect((outcome.error as EvidenceRefusalError).reason).toBe(
        EVIDENCE_REFUSAL_REASON.ACK_CHECKPOINT_NOT_MINTED_HERE
      );
    }
  });

  it("writes nothing at all when the checkpoint never authenticates", async () => {
    const outcome = await attempt({ checkpoint: "not-a-token" });
    expect(matching(outcome.statements, "UPDATE evidence_invalidation_cursors")).toHaveLength(0);
    expect(matching(outcome.statements, "UPDATE structured_purge_ack_states")).toHaveLength(0);
  });

  it("refuses a backwards acknowledgement without writing anything", async () => {
    const { statements, reason } = await refusedAttempt({
      checkpoint: mintInvalidationCheckpoint(4, CONSUMER, KEY),
      cursor: cursor({ acked_seq: 7, last_allocated_seq: 10 }),
      firstSeq: 8,
      advancedTo: 7,
    });
    expect(reason).toBe(EVIDENCE_REFUSAL_REASON.ACK_WOULD_MOVE_BACKWARDS);
    expect(matching(statements, "UPDATE evidence_invalidation_cursors")).toHaveLength(0);
    expect(matching(statements, "UPDATE structured_purge_ack_states")).toHaveLength(0);
  });

  it("refuses a range that has lost its own beginning, without writing anything", async () => {
    const { statements, reason } = await refusedAttempt({
      // The earliest retained event sits at 2, above ackedSeq+1: the row the
      // covered range must open with is gone and nothing left in the stream can
      // say whether it was swept or skipped.
      checkpoint: mintInvalidationCheckpoint(3, CONSUMER, KEY),
      firstSeq: 2,
      advancedTo: 3,
    });
    expect(reason).toBe(EVIDENCE_REFUSAL_REASON.ACK_RANGE_NOT_CONTIGUOUS);
    expect(matching(statements, "UPDATE evidence_invalidation_cursors")).toHaveLength(0);
    expect(matching(statements, "UPDATE structured_purge_ack_states")).toHaveLength(0);
  });

  it("advances after a mid-range sweep, because the floor still opens the range", async () => {
    // The retention clause's own case: a sweep collected rows 4 and 5 above the
    // stored position 3, so the window now opens at 6. Under a row-count
    // comparison this acknowledgement would have been refused forever; the floor
    // still sits at ackedSeq+1, so the batch the checkpoint covers was one
    // contiguous handover and the advance is written.
    const { statements, result } = await acknowledge({
      checkpoint: mintInvalidationCheckpoint(6, CONSUMER, KEY),
      cursor: cursor({ acked_seq: 3, last_allocated_seq: 6 }),
      firstSeq: 4,
      advancedTo: 6,
    });
    expect(result.checkpoint).toBe(mintInvalidationCheckpoint(6, CONSUMER, KEY));
    const update = matching(statements, "UPDATE evidence_invalidation_cursors")[0]!;
    expect(update.values[2]).toBe(6);
  });

  it("reads the delivery fact from the stream, not from a remembered count", async () => {
    // The contiguity question is answered by the `min(seq)` read issued against
    // the outbox inside this transaction, so the statement — not a stored or
    // derived number — is the assertion.
    const { statements } = await acknowledge({
      checkpoint: mintInvalidationCheckpoint(3, CONSUMER, KEY),
      firstSeq: 1,
      advancedTo: 3,
    });
    const floorRead = matching(statements, "min(seq) AS first_seq")[0]!;
    expect(matching(statements, "FROM evidence_invalidation_cursors").length).toBe(1);
    expect(statements.indexOf(floorRead)).toBeGreaterThan(
      statements.indexOf(matching(statements, "FROM evidence_invalidation_cursors")[0]!)
    );
    expect(floorRead.values[0]).toBe(CONSUMER);
  });

  it("refuses a position past the stream's own watermark", async () => {
    const { reason } = await refusedAttempt({
      checkpoint: mintInvalidationCheckpoint(11, CONSUMER, KEY),
      cursor: cursor({ last_allocated_seq: 10 }),
      firstSeq: 1,
      advancedTo: 11,
    });
    expect(reason).toBe(EVIDENCE_REFUSAL_REASON.ACK_CHECKPOINT_NEVER_ISSUED);
  });

  it("types every refusal as a contract fact, never a transport one", async () => {
    const outcome = await attempt({ checkpoint: "not-a-token" });
    expect(outcome.error).toBeInstanceOf(EvidenceRefusalError);
    expect((outcome.error as EvidenceRefusalError).code).toBe(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT
    );
  });
});

describe("the ack success arm", () => {
  it("echoes the STORE's acknowledged checkpoint, not the presented one", async () => {
    // fin's recovery path reads the backend's answer rather than assuming its own
    // acknowledgement landed, so the field has to be the position the store holds.
    const stored = mintInvalidationCheckpoint(3, CONSUMER, KEY);
    const { result } = await acknowledge({
      checkpoint: mintInvalidationCheckpoint(3, CONSUMER, KEY),
      cursor: cursor({ acked_seq: 3, acked_checkpoint: stored, last_allocated_seq: 3 }),
      firstSeq: null,
    });
    expect(result).toEqual({
      schema: "iknow.evidence_result",
      schema_version: 1,
      action: "ack",
      checkpoint: stored,
    });
  });

  it("still scrubs the owner on the idempotent arm", async () => {
    // A first acknowledgement of position 0 — which is what a drain of an empty
    // stream mints — must still be able to scrub a revision whose covered
    // position for this owner is 0. Skipping the write on this arm would leave
    // that revision pending forever with nothing left to acknowledge.
    const { statements } = await acknowledge({
      checkpoint: mintInvalidationCheckpoint(0, CONSUMER, KEY),
      cursor: cursor({ last_allocated_seq: 0 }),
      firstSeq: null,
    });
    expect(matching(statements, "UPDATE structured_purge_ack_states")).toHaveLength(1);
    expect(
      matching(statements, "UPDATE evidence_invalidation_cursors")
    ).toHaveLength(0);
  });

  it("reports the presented token when the store has never acknowledged one", async () => {
    const presented = mintInvalidationCheckpoint(0, CONSUMER, KEY);
    const { result } = await acknowledge({
      checkpoint: presented,
      cursor: cursor({ last_allocated_seq: 0 }),
      firstSeq: null,
    });
    // The cursor row exists only because a seq was allocated, so its stored
    // checkpoint is empty. The presented token is server-minted for this consumer
    // and already the honest answer; inventing a second token here would mint one
    // that no other system holds.
    expect(result.checkpoint).toBe(presented);
  });

  it("keeps the action out of the grant read's envelope vocabulary", () => {
    expect(EVIDENCE_REFUSAL_REASON.ACK_NOT_A_GRANT_READ).toBe("ack_not_a_grant_read");
  });
});