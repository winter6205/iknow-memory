/**
 * The invalidation outbox against a real PostgreSQL (register §1.1, ADR 0097
 * §2.1/§2.5/§2.6/§4.2).
 *
 * Why this suite exists as a real-Postgres file rather than unit tests over a
 * fake client. Every property it proves is a property of the DATABASE, not of
 * TypeScript: a CHECK that refuses a value, a counter whose increment rolls back
 * with its transaction, two real concurrent transactions contending on one row.
 * A fake `query` cannot assert any of them, because a fake would have to
 * re-implement the constraint it is supposed to be testing. The rollback case is
 * the sharpest of these — it is exactly the behaviour that disqualified a
 * `SEQUENCE` (non-transactional `nextval` burns a value) and it is invisible
 * without a real transaction manager.
 *
 * Sibling of `structured-withdrawal-pg.test.ts` rather than a section of it:
 * that file owns the withdrawal projection's schema and its own harness schema,
 * and this one owns a different pair of tables with a different set of proofs.
 *
 * `requiresVector: true` because the bootstrap this file drives creates the
 * whole schema, and the graph tables in it carry `vector` columns. The DSN
 * points at a scratch schema, never at a store anyone reads.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import {
  allocateInvalidationSeq,
  readInvalidationCursor,
} from "../../src/core/storage/invalidation-outbox.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  type PgIntegrationHarness,
} from "../integration/pg-test-harness.js";

// EXIT: this driver never skips. The opt-in marker and the DSN must both be
// present or the module refuses at load, and an absent or unreachable database
// is a named non-zero failure rather than a skip.
const OPT_IN = process.env.IK_STRUCTURED_INVALIDATION_OUTBOX_PG;
if (OPT_IN !== "1") {
  throw new Error(
    "structured-invalidation-outbox-pg.test.ts requires IK_STRUCTURED_INVALIDATION_OUTBOX_PG=1; it never skips"
  );
}
const DSN = process.env.GRAPHRAG_MEMORY_DB_URL;
if (typeof DSN !== "string" || DSN.trim() === "") {
  throw new Error(
    "structured-invalidation-outbox-pg.test.ts requires GRAPHRAG_MEMORY_DB_URL to be set; it never skips"
  );
}

const SCHEMA_PREFIX = "p3_inval_outbox";
const CONSUMER = "fin-consumer";
/** Small, like the withdrawal suite's: nothing here embeds anything. */
const DIMENSIONS = 8;

const harness: PgIntegrationHarness = await createPgIntegrationHarness({
  schemaPrefix: SCHEMA_PREFIX,
  defaultConnectionString: DSN,
  requiresVector: true,
  testPath: "tests/acceptance/structured-invalidation-outbox-pg.test.ts",
  label: "P3 invalidation outbox",
  expectedCommand:
    "IK_STRUCTURED_INVALIDATION_OUTBOX_PG=1 GRAPHRAG_MEMORY_DB_URL=<dsn> vitest run tests/acceptance/structured-invalidation-outbox-pg.test.ts",
});

const reachability = await probePostgres(DSN, true);
if (!reachability.available) {
  throw new Error(
    "structured-invalidation-outbox-pg.test.ts requires a reachable PostgreSQL with pgvector " +
      "at the configured DSN; it reports an unreachable database as this failure " +
      "rather than skipping"
  );
}

let admin: pg.Client;

/**
 * A CONNECTED client on the harness schema.
 *
 * `pg` 8 will not run a query on an unconnected `Client` — it queues forever —
 * so every client this file makes is connected here. Written once so no case
 * can forget, and so the "connect in `beforeAll`" half is not restated eight
 * times.
 */
async function connectedClient(): Promise<pg.Client> {
  const client = harness.createClient(harness.schemaConnectionString);
  await client.connect();
  return client;
}

beforeAll(async () => {
  admin = await connectedClient();
  await harness.resetSchema(admin);
  // The whole-schema bootstrap, not the two tables alone: what is under test is
  // that `upSchemaBootstrap` reaches them, and a suite that created its own
  // tables first would pass on a bootstrap that never calls this module. The
  // generous timeout is the same one the withdrawal suite gives its bootstrap,
  // which creates the same graph tables.
  const lease = await connectedClient();
  try {
    // `dimensions` is the bootstrap's own required argument for the graph tables
    // it also creates, not an environment read: the two invalidation tables carry
    // no vector, so this value only has to be a width pgvector accepts.
    await upSchemaBootstrap(lease, DIMENSIONS);
  } finally {
    await lease.end();
  }
}, 180_000);

afterAll(async () => {
  try {
    if (harness !== undefined && admin !== undefined) {
      await harness.dropSchema(admin);
    }
  } finally {
    if (admin !== undefined) await admin.end();
  }
}, 120_000);

describe("invalidating outbox DDL on a real PostgreSQL", () => {
  it("creates both tables and the evidence_ref index", async () => {
    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name IN ('evidence_invalidation_outbox',
                             'evidence_invalidation_cursors')`,
      [harness.schema]
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      "evidence_invalidation_cursors",
      "evidence_invalidation_outbox",
    ]);

    const indexes = await admin.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1
          AND indexname = 'evidence_invalidation_outbox_evidence_ref_idx'`,
      [harness.schema]
    );
    expect(indexes.rows).toHaveLength(1);
  });

  it("gives the outbox exactly the six scalars of ADR 0097 §2.1 and no payload", async () => {
    // ADR 0097 §2.5's content prohibition as an executable assertion: the claim
    // is that the table HAS nowhere to put content, so the column set is the
    // proof and a missing `payload` is as much a failure as a present one.
    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'evidence_invalidation_outbox'`,
      [harness.schema]
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      "consumer_id",
      "event_id",
      "evidence_ref",
      "occurred_at",
      "reason",
      "seq",
    ]);
  });

  it("gives the cursor the five columns of ADR 0097 §4.1", async () => {
    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'evidence_invalidation_cursors'`,
      [harness.schema]
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      "acked_at",
      "acked_checkpoint",
      "acked_seq",
      "consumer_id",
      "last_allocated_seq",
    ]);
  });

  it("refuses a reason outside the closed vocabulary (ADR 0097 §2.6)", async () => {
    // `expired` is the value the ADR names as the one that must never become an
    // event: expiry is a read-time decision on a grant, not a change to
    // announce. The CHECK has to be what refuses it, not a caller.
    await expect(
      admin.query(
        `INSERT INTO "${harness.schema}".evidence_invalidation_outbox
           (consumer_id, seq, event_id, evidence_ref, reason, occurred_at)
         VALUES ($1, 1, $2, $3, 'expired', now())`,
        ["probe-consumer", randomUUID(), "ref-probe"]
      )
    ).rejects.toThrow(/reason_check/);
  });

  it("refuses an evidence_ref longer than ADR 0097 §2.1's 128 chars", async () => {
    await expect(
      admin.query(
        `INSERT INTO "${harness.schema}".evidence_invalidation_outbox
           (consumer_id, seq, event_id, evidence_ref, reason, occurred_at)
         VALUES ($1, 1, $2, $3, 'purged', now())`,
        ["probe-consumer", randomUUID(), "x".repeat(129)]
      )
    ).rejects.toThrow(/ref_check/);
  });

  it("refuses a seq below 1", async () => {
    await expect(
      admin.query(
        `INSERT INTO "${harness.schema}".evidence_invalidation_outbox
           (consumer_id, seq, event_id, evidence_ref, reason, occurred_at)
         VALUES ($1, 0, $2, $3, 'purged', now())`,
        ["probe-consumer", randomUUID(), "ref-probe"]
      )
    ).rejects.toThrow(/seq_check/);
  });
});

describe("seq allocation is gapless per consumer", () => {
  it("counts each consumer's stream independently", async () => {
    const client = await connectedClient();
    try {
      const a = [
        await allocateInvalidationSeq(client, "gapless-a"),
        await allocateInvalidationSeq(client, "gapless-a"),
        await allocateInvalidationSeq(client, "gapless-a"),
      ];
      const b = [
        await allocateInvalidationSeq(client, "gapless-b"),
        await allocateInvalidationSeq(client, "gapless-b"),
      ];
      expect(a).toEqual([1, 2, 3]);
      expect(b).toEqual([1, 2]);
    } finally {
      await client.end();
    }
  });

  it("records the consumer's cursor row, and reads it back whole", async () => {
    const client = await connectedClient();
    try {
      await allocateInvalidationSeq(client, "cursor-probe");
      const cursor = await readInvalidationCursor(client, "cursor-probe");
      expect(cursor).not.toBeNull();
      expect(cursor?.consumer_id).toBe("cursor-probe");
      expect(cursor?.last_allocated_seq).toBe(1);
      // A freshly created counter has acknowledged nothing, and the two halves
      // are distinct columns because "handed out" is not "acknowledged".
      expect(cursor?.acked_seq).toBe(0);
      expect(cursor?.acked_checkpoint).toBe("");
    } finally {
      await client.end();
    }
  });

  it("returns null for a consumer with no cursor row", async () => {
    const client = await connectedClient();
    try {
      expect(await readInvalidationCursor(client, "never-seen")).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe("seq allocation is transactional, so a rollback burns nothing", () => {
  it("returns the same number again after a rolled-back allocation", async () => {
    // THE assertion of this suite. A SEQUENCE's `nextval` is non-transactional,
    // so a rolled-back purge would permanently skip this number and fin's drain —
    // which refuses a first seq beyond its watermark by more than one — would
    // have no self-heal path. Only a real rollback can prove it did not.
    const client = await connectedClient();
    try {
      const before = await allocateInvalidationSeq(client, "rollback-probe");
      await client.query("BEGIN");
      const burned = await allocateInvalidationSeq(client, "rollback-probe");
      await client.query("ROLLBACK");
      const after = await allocateInvalidationSeq(client, "rollback-probe");
      const next = await allocateInvalidationSeq(client, "rollback-probe");
      expect(burned).toBe(before + 1);
      expect(after).toBe(before + 1);
      expect(next).toBe(before + 2);
    } finally {
      await client.end();
    }
  });
});

describe("concurrent allocation for one consumer", () => {
  it("blocks a second transaction instead of duplicating the seq", async () => {
    const first = await connectedClient();
    const second = await connectedClient();
    try {
      const seed = await allocateInvalidationSeq(first, "concurrent-probe");
      // Two real connections, two real transactions, neither aware of the other.
      // `first` takes the counter row's lock and holds it; `second` must WAIT for
      // it. A SKIP LOCKED allocator would instead sail past and return the
      // in-flight number, leaving the (consumer_id, seq) unique constraint as the
      // only thing between a consumer and a permanently wedged drain.
      await first.query("BEGIN");
      const held = allocateInvalidationSeq(first, "concurrent-probe");
      const left = await held;
      await second.query("BEGIN");
      // NOT awaited before the commit below: that wait is the property under test
      // and it only ends when `first` commits, so awaiting it here would deadlock
      // the test against itself.
      const waiting = allocateInvalidationSeq(second, "concurrent-probe");
      const settled = await Promise.race([
        waiting.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 300)),
      ]);
      expect(settled).toBe("blocked");

      await first.query("COMMIT");
      const right = await waiting;
      await second.query("COMMIT");
      // Contiguous, not merely distinct: a duplicated or skipped number would
      // both satisfy `left !== right`, and only this pins the gapless claim.
      expect(left).toBe(seed + 1);
      expect(right).toBe(seed + 2);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it("rejects a second event claiming a (consumer_id, seq) already taken", async () => {
    const client = await connectedClient();
    try {
      const seq = await allocateInvalidationSeq(client, "uniqueness-probe");
      const insert = (eventId: string): Promise<unknown> =>
        client.query(
          `INSERT INTO "${harness.schema}".evidence_invalidation_outbox
             (consumer_id, seq, event_id, evidence_ref, reason, occurred_at)
           VALUES ($1, $2, $3, $4, 'access_revoked', now())`,
          ["uniqueness-probe", seq, eventId, `ref-${eventId.slice(0, 8)}`]
        );
      await insert(randomUUID());
      await expect(insert(randomUUID())).rejects.toThrow(
        /consumer_seq_key|unique/i
      );
    } finally {
      await client.end();
    }
  });

  it("accepts the same seq for a DIFFERENT consumer", async () => {
    // The N >= 2 property register §1b.3 is for: streams are independent, so the
    // per-consumer gapless ordering never has to be a global one.
    const client = await connectedClient();
    try {
      await client.query(
        `INSERT INTO "${harness.schema}".evidence_invalidation_outbox
           (consumer_id, seq, event_id, evidence_ref, reason, occurred_at)
         VALUES ($1, 1, $2, 'ref-shared', 'purged', now())`,
        ["stream-one", randomUUID()]
      );
      await expect(
        client.query(
          `INSERT INTO "${harness.schema}".evidence_invalidation_outbox
             (consumer_id, seq, event_id, evidence_ref, reason, occurred_at)
           VALUES ($1, 1, $2, 'ref-shared-2', 'purged', now())`,
          ["stream-two", randomUUID()]
        )
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });
});

describe("the FIRST allocation for a consumer, when no counter row exists", () => {
  it("blocks the second transaction, then hands out 1 and 2", async () => {
    // The concurrency case above seeds the counter row first, so it only ever
    // exercises the `ON CONFLICT` path. This one races the INSERT that CREATES
    // the row, which is the branch that can hand the same number to two
    // transactions if it does not contend: the second writer has to wait on the
    // speculative insertion of the same primary key, not sail past it.
    const first = await connectedClient();
    const second = await connectedClient();
    try {
      await first.query("BEGIN");
      const left = allocateInvalidationSeq(first, "first-allocation-probe");
      const leftSeq = await left;

      await second.query("BEGIN");
      // Not awaited before the commit below: the wait IS the property, and it
      // only ends when `first` commits, so awaiting it here would deadlock the
      // test against itself.
      const waiting = allocateInvalidationSeq(second, "first-allocation-probe");
      const settled = await Promise.race([
        waiting.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 300)),
      ]);
      expect(settled).toBe("blocked");

      await first.query("COMMIT");
      const rightSeq = await waiting;
      await second.query("COMMIT");
      // Gapless from the very first allocation: the creating transaction gets 1
      // and the blocked one gets 2, with nothing skipped in between and no row
      // left for the `UNIQUE (consumer_id, seq)` key to catch afterwards.
      expect(leftSeq).toBe(1);
      expect(rightSeq).toBe(2);
    } finally {
      await first.end();
      await second.end();
    }
  });
});

describe("an event id names exactly one invalidation", () => {
  it("refuses a second event reusing an event_id already in the stream", async () => {
    // ADR 0097 §2.1 makes `event_id` the idempotency key a redelivery is matched
    // on, so it must be UNIQUE on its own. The case deliberately uses a
    // DIFFERENT consumer and seq from the first insert: reusing the stream's
    // own (consumer_id, seq) key would trip the per-consumer constraint instead
    // and pass whether or not the event_id key existed at all.
    const client = await connectedClient();
    try {
      const eventId = randomUUID();
      const insert = (
        consumerId: string,
        seq: number,
        ref: string
      ): Promise<unknown> =>
        client.query(
          `INSERT INTO "${harness.schema}".evidence_invalidation_outbox
             (consumer_id, seq, event_id, evidence_ref, reason, occurred_at)
           VALUES ($1, $2, $3, $4, 'access_revoked', now())`,
          [consumerId, seq, eventId, ref]
        );
      await insert("event-key-owner", 1, "ref-event-key-1");
      await expect(
        insert("event-key-other", 1, "ref-event-key-2")
      ).rejects.toThrow(/event_key/);
    } finally {
      await client.end();
    }
  });
});

describe("the cursor table refuses a consumer that is not one", () => {
  it("refuses a blank consumer_id on a direct INSERT", async () => {
    // The DDL half of the rule `allocateInvalidationSeq` enforces in
    // TypeScript, proven against the database because a fake cannot assert a
    // CHECK. Without it a blank cursor is a private stream that mints, drains
    // nothing, and collides with every other blank one — the cross-consumer
    // confusion ADR 0097 §2.1's stored `consumer_id` exists to prevent.
    await expect(
      admin.query(
        `INSERT INTO "${harness.schema}".evidence_invalidation_cursors
           (consumer_id, acked_checkpoint, acked_seq, last_allocated_seq)
         VALUES ('   ', '', 0, 0)`
      )
    ).rejects.toThrow(/check|cursor/i);
  });

  it("still admits a well-formed consumer, so the CHECK is a rule and not a ban", async () => {
    await expect(
      admin.query(
        `INSERT INTO "${harness.schema}".evidence_invalidation_cursors
           (consumer_id, acked_checkpoint, acked_seq, last_allocated_seq)
         VALUES ('t13-accepting-consumer', '', 0, 0)`
      )
    ).resolves.toBeDefined();
  });

  it("refuses a blank consumer through the allocator too, without minting a row", async () => {
    const client = await connectedClient();
    try {
      await expect(allocateInvalidationSeq(client, "  ")).rejects.toThrow(
        /non-blank/
      );
      const cursors = await client.query<{ consumer_id: string }>(
        `SELECT consumer_id FROM "${harness.schema}".evidence_invalidation_cursors
          WHERE btrim(consumer_id) = ''`
      );
      expect(cursors.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
