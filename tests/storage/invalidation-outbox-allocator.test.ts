/**
 * The allocator's refusal contracts, with no database in the way.
 *
 * Companion to `tests/acceptance/structured-invalidation-outbox-pg.test.ts`:
 * that file proves what only a real PostgreSQL can prove (the blocking row lock,
 * the rollback burning nothing, the CHECK constraints), and everything HERE is a
 * property of the TypeScript in front of the client — that a failed allocation is
 * a typed fault a caller can branch on, and that an unreadable int8 is refused
 * rather than silently coerced. Both are reachable with a fake `query`, which is
 * precisely why they must not be left to the real-PostgreSQL suite: a fake is
 * evidence for what this module does with the row it is handed.
 *
 * Sibling of `invalidation-consumer-binding.test.ts` rather than a section of it:
 * that file is about WHERE a consumer id comes from, and these cases are about
 * what the allocator does with the numbers the database returns.
 */
import { describe, expect, it } from "vitest";

import {
  allocateInvalidationSeq,
  readInvalidationCursor,
  type InvalidationOutboxClient,
} from "../../src/core/storage/invalidation-outbox.js";
import {
  MAX_CONSUMER_ID_CHARS,
  isBoundedConsumerId,
} from "../../src/core/storage/evidence-store.js";

/** A client that answers every statement with the same canned result. */
function clientReturning(rows: unknown[]): InvalidationOutboxClient {
  return {
    query: async () => ({ rows }),
  };
}

/** A client that fails the test if the allocator reaches the database at all. */
function unreachableClient(): InvalidationOutboxClient {
  return {
    query: async () => {
      throw new Error("the allocator queried a blank consumer id");
    },
  };
}

/** A cursor row as `pg` hands an int8 column back: text, not number. */
function cursorRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    consumer_id: "fin-consumer",
    acked_checkpoint: "ckpt-1",
    acked_seq: "7",
    acked_at: "2026-02-03T04:05:06.000Z",
    last_allocated_seq: "9",
    ...overrides,
  };
}

describe("a lost allocation write is a typed storage fault", () => {
  it("throws GraphragError with STORAGE_ERROR, not a bare Error", async () => {
    // The branch is unreachable against a real `INSERT … RETURNING`, which is
    // exactly why it needs a fake: a caller that must branch on the code cannot
    // get one from an untyped throw, and `structuredErrorEnvelope` builds the
    // host payload from the code alone.
    await expect(
      allocateInvalidationSeq(clientReturning([]), "fin-consumer")
    ).rejects.toMatchObject({
      name: "GraphragError",
      code: "STORAGE_ERROR",
    });
  });

  it("names the consumer whose allocation was lost", async () => {
    await expect(
      allocateInvalidationSeq(clientReturning([]), "lost-consumer")
    ).rejects.toThrow(/lost-consumer/);
  });
});

describe("an unreadable int8 is refused, never coerced to NaN", () => {
  it("refuses a last_allocated_seq that is not an integer", async () => {
    // `Number("not-a-number")` is NaN, and a NaN sequence would sail through
    // every comparison a drain makes — including "has this consumer already
    // passed it" — so the failure has to be a refusal a caller can see.
    await expect(
      allocateInvalidationSeq(
        clientReturning([{ last_allocated_seq: "not-a-number" }]),
        "fin-consumer"
      )
    ).rejects.toThrow(/last_allocated_seq/);
  });

  it("refuses a negative allocated seq, which the schema forbids", async () => {
    await expect(
      allocateInvalidationSeq(
        clientReturning([{ last_allocated_seq: "-1" }]),
        "fin-consumer"
      )
    ).rejects.toThrow(/last_allocated_seq/);
  });

  it("reads a well-formed text int8 as the number it spells", async () => {
    // The positive half of the same conversion: `pg` returns int8 as text, so
    // the value really does arrive as "9" and must come back as 9.
    expect(
      await allocateInvalidationSeq(
        clientReturning([{ last_allocated_seq: "9" }]),
        "fin-consumer"
      )
    ).toBe(9);
  });

  it("refuses an unreadable acked_seq on the cursor read", async () => {
    await expect(
      readInvalidationCursor(
        clientReturning([cursorRow({ acked_seq: "seven" })]),
        "fin-consumer"
      )
    ).rejects.toThrow(/acked_seq/);
  });

  it("refuses an unreadable last_allocated_seq on the cursor read", async () => {
    await expect(
      readInvalidationCursor(
        clientReturning([cursorRow({ last_allocated_seq: "nine" })]),
        "fin-consumer"
      )
    ).rejects.toThrow(/last_allocated_seq/);
  });

  it("reads both halves of the position as numbers", async () => {
    const cursor = await readInvalidationCursor(
      clientReturning([cursorRow()]),
      "fin-consumer"
    );
    expect(cursor?.acked_seq).toBe(7);
    expect(cursor?.last_allocated_seq).toBe(9);
  });

  it("still answers null for a consumer with no row", async () => {
    // The refusal above is for an unreadable POSITION, not for an absent one:
    // an absent cursor is an ordinary state every fresh consumer is in.
    expect(
      await readInvalidationCursor(clientReturning([]), "never-seen")
    ).toBeNull();
  });
});

describe("a blank consumer id is refused before it can mint a stream", () => {
  // Without this guard `allocateInvalidationSeq("")` returns 1 and
  // `allocateInvalidationSeq("   ")` returns 1 again — two cursor rows, each a
  // private stream nobody drains, which is exactly the cross-consumer confusion
  // ADR 0097 §2.1's STORED `consumer_id` exists to prevent. The DDL half of the
  // same rule is proven against real PostgreSQL in
  // tests/acceptance/structured-invalidation-outbox-pg.test.ts, because a fake
  // cannot assert a CHECK.
  for (const blank of ["", "   ", "\t\n "]) {
    it(`refuses ${JSON.stringify(blank)} without querying the database`, async () => {
      await expect(
        allocateInvalidationSeq(unreachableClient(), blank)
      ).rejects.toMatchObject({ name: "GraphragError", code: "STORAGE_ERROR" });
    });
  }

  it("refuses an over-long consumer id with the same typed fault", async () => {
    await expect(
      allocateInvalidationSeq(
        unreachableClient(),
        "c".repeat(MAX_CONSUMER_ID_CHARS + 1)
      )
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("accepts an id exactly at the bound, so the rule is a bound and not a ban", async () => {
    expect(
      await allocateInvalidationSeq(
        clientReturning([{ last_allocated_seq: "1" }]),
        "c".repeat(MAX_CONSUMER_ID_CHARS)
      )
    ).toBe(1);
  });

  it("shares one rule with the grant store", () => {
    // Two enforcement points, one predicate: a rule written twice is a rule the
    // second copy will forget, so the allocator and the grant store must agree
    // on which strings are consumers.
    expect(isBoundedConsumerId("fin-consumer")).toBe(true);
    expect(isBoundedConsumerId("")).toBe(false);
    expect(isBoundedConsumerId("   ")).toBe(false);
    expect(isBoundedConsumerId("c".repeat(MAX_CONSUMER_ID_CHARS))).toBe(true);
    expect(isBoundedConsumerId("c".repeat(MAX_CONSUMER_ID_CHARS + 1))).toBe(
      false
    );
  });
});
