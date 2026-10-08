/**
 * The `invalidations` drain read against a real PostgreSQL (register §1.3 and
 * §1.4; ADR 0097 §2.1/§2.2/§2.3/§2.6/§2.7/§4.4).
 *
 * Why this suite exists as a real-Postgres file rather than unit tests over a
 * fake client. Three of the properties under test are properties of the DATABASE
 * or of the transaction manager, not of TypeScript:
 *
 *  - **one unit of work.** The drain answers "where has this stream reached" and
 *    "which events exist" together; a fake client would hand back whatever the
 *    test told it to and could not show two reads arriving from two snapshots.
 *    This lane records the statements the drain actually issues and asserts the
 *    cursor read and the page read sit inside ONE `REPEATABLE READ READ ONLY`
 *    transaction, which fails the moment the read is split.
 *  - **the WHERE clause.** Consumer isolation and `seq` ordering are the index
 *    scan's behaviour, and a test that asserted "a function was called" would
 *    pass on a query that dropped `consumer_id` from the predicate.
 *  - **the stored shape.** The five event fields are asserted against rows the
 *    real DDL produced, so a schema and a renderer that disagree cannot both be
 *    right.
 *
 * Sibling of `structured-invalidation-outbox-pg.test.ts` rather than a section
 * of it: that file owns the outbox's DDL and allocation proofs, and this one
 * owns the read against the same two tables. `requiresVector: true` because the
 * bootstrap this file drives creates the whole schema and the graph tables in it
 * carry `vector` columns. The DSN points at a scratch schema, never at a store
 * anyone reads.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import {
  allocateInvalidationSeq,
  readInvalidationCursor,
} from "../../src/core/storage/invalidation-outbox.js";
import {
  decodeInvalidationCheckpoint,
  mintInvalidationCheckpoint,
  type InvalidationCheckpointKey,
} from "../../src/core/storage/evidence-invalidation-checkpoint.js";
import { PgEvidenceInvalidationStorage } from "../../src/core/storage/evidence-invalidation-read.js";
import {
  parseEvidenceRequest,
  type EvidenceInvalidationsRequest,
} from "../../src/core/storage/evidence-read.js";
import { PgStructuredScopeUnitOfWork } from "../../src/core/storage/structured-scope-uow.js";
import type {
  AuthorizedScopeContext,
  ScopeTransactionClient,
} from "../../src/core/storage/structured-scope-types.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
  type PgIntegrationHarness,
} from "../integration/pg-test-harness.js";

const EXPECTED_COMMAND =
  "IK_STRUCTURED_INVALIDATION_DRAIN_PG=1 npx vitest run tests/acceptance/structured-invalidation-drain-pg.test.ts";
const OPT_IN = process.env.IK_STRUCTURED_INVALIDATION_DRAIN_PG;
const REQUIRED = OPT_IN === "1";

const SCHEMA_PREFIX = "p3_inval_drain";
const DIMENSIONS = 8;
const CONSUMER = "fin-consumer";
const OTHER_CONSUMER = "fin-consumer-other";
/** Deliberately disjoint from either consumer label. See `publishEvents`. */
const PRIMARY_REF = "ref-alpha";
const SECONDARY_REF = "ref-beta";
const SCOPE = "p3-inval-drain-scope";
const SOURCE_REF = "p3-inval-drain-source";
const AUTH_REV = "auth-rev-1";
const AUTH_REV_MOVED = "auth-rev-2";
/** Live, because the seam reads it before it leases a connection. */
const DEADLINE = new Date(Date.now() + 600_000).toISOString();

const KEY: InvalidationCheckpointKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8"
);

const harness: PgIntegrationHarness = await createPgIntegrationHarness({
  schemaPrefix: SCHEMA_PREFIX,
  defaultConnectionString: resolvePgConnectionString(
    "postgresql://postgres@localhost/postgres"
  ),
  requiresVector: true,
  testPath: "tests/acceptance/structured-invalidation-drain-pg.test.ts",
  label: "P3 invalidation drain",
  expectedCommand: EXPECTED_COMMAND,
});

// EXIT: a marker with no reachable database is a named non-zero failure, not a
// skip. A lane that quietly reported "skipped" under a marker the operator set
// would be indistinguishable from one that passed.
if (REQUIRED) {
  const probe = await probePostgres(harness.connectionString, true);
  if (!probe.available) {
    throw new Error(
      [
        "Validation:",
        `- Not run: tests/acceptance/structured-invalidation-drain-pg.test.ts`,
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Blocking issue: PostgreSQL with pgvector is unavailable at the configured DSN (${
          probe.error instanceof Error ? probe.error.message : String(probe.error)
        })`,
        `- ${OPT_IN}=1 was set, so this file refuses to run rather than skip.`,
      ].join("\n")
    );
  }
}

const describeLane = REQUIRED ? harness.describePg : harness.describePg.skip;

const SCHEMA_URL = harness.schemaConnectionString;

let admin: pg.Client;
let pool: pg.Pool;
let authority: PgStructuredScopeUnitOfWork;
let drain: PgEvidenceInvalidationStorage;
let statements: string[] = [];
let recording = false;

/** Every statement this drain issues, in order, so the bracket is observable. */
function recorded(): readonly string[] {
  return statements;
}

async function connectedClient(): Promise<pg.Client> {
  const client = harness.createClient(SCHEMA_URL);
  await client.connect();
  return client;
}

/** The context the drain is authorized under, and the consumer it drains for. */
function contextFor(authorizationRevision: string): AuthorizedScopeContext {
  return authority.createAuthorizedContext({
    actorId: "p3-inval-drain-actor",
    ownerScopeBinding: SCOPE,
    readerBinding: "p3-inval-drain-reader",
    authorizedSourceRefs: [SOURCE_REF],
    authorizationRevision,
    deadlineAt: DEADLINE,
  });
}

function request(overrides: Record<string, unknown> = {}): EvidenceInvalidationsRequest {
  return parseEvidenceRequest({
    schema: "iknow.evidence_request",
    schema_version: 1,
    action: "invalidations",
    ...overrides,
  }) as EvidenceInvalidationsRequest;
}

/**
 * Publish `count` events for one consumer, inside a real transaction.
 *
 * Uses the store's OWN allocator rather than a bare `INSERT` so the cursor row's
 * `last_allocated_seq` is what the allocator made it: the drain reads that column
 * as its "never issued" watermark, and a fixture that hand-wrote the cursor would
 * be testing a stream shape the store cannot produce.
 *
 * `refPrefix` is kept out of the consumer label on purpose — `evidence_ref` is an
 * opaque handle, and a fixture that embedded the consumer in it would make the
 * "the stream identity never travels" assertion pass or fail for the wrong
 * reason.
 */
async function publishEvents(
  consumerId: string,
  refPrefix: string,
  reasons: readonly ("purged" | "access_revoked")[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const reason of reasons) {
      const seq = await allocateInvalidationSeq(client, consumerId);
      await client.query(
        `INSERT INTO evidence_invalidation_outbox
           (consumer_id, seq, event_id, evidence_ref, reason, occurred_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp(1780000000 + $2::bigint))`,
        [consumerId, seq, randomUUID(), `${refPrefix}-${seq}`, reason]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  admin = await connectedClient();
  await harness.resetSchema(admin);
  // The WHOLE bootstrap, not the two invalidation tables alone: what is under
  // test is that `upSchemaBootstrap` reaches them, and a suite that created its
  // own tables first would pass on a bootstrap that never calls this module.
  const lease = await connectedClient();
  try {
    await upSchemaBootstrap(lease, DIMENSIONS);
  } finally {
    await lease.end();
  }
  pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 6 });
  // Wrapped once per client, not once per lease: a pooled client comes back for a
  // later transaction, and wrapping it again would capture the previous wrapper
  // as `original` and record every statement twice — which is the shape of a
  // reader that issues each query two times.
  const wrapped = new WeakSet<object>();
  authority = new PgStructuredScopeUnitOfWork(async () => {
    const client = await pool.connect();
    if (!wrapped.has(client)) {
      wrapped.add(client);
      const original = client.query.bind(client);
      client.query = ((text: unknown, ...rest: readonly unknown[]) => {
        if (recording && typeof text === "string") statements.push(text);
        return (original as (...args: unknown[]) => unknown)(text, ...rest);
      }) as typeof client.query;
    }
    return client as unknown as ScopeTransactionClient;
  });
  drain = new PgEvidenceInvalidationStorage(authority, KEY);
  // The scope row `assertCurrentAuthorization` re-reads inside the drain's own
  // transaction. Without it every case would refuse for the wrong reason.
  await admin.query(
    `INSERT INTO evidence_scope_revisions
       (scope_binding, authorization_revision, purge_revision)
     VALUES ($1, $2, 'purge-rev-0')`,
    [SCOPE, AUTH_REV]
  );
}, 180_000);

afterAll(async () => {
  try {
    if (harness !== undefined && admin !== undefined) {
      await harness.dropSchema(admin);
    }
  } finally {
    if (pool !== undefined) await pool.end();
    if (admin !== undefined) await admin.end();
  }
}, 120_000);

describeLane("the invalidations drain read", () => {
  it("returns the consumer's pending events in seq order as five content-free fields", async () => {
    await publishEvents(CONSUMER, PRIMARY_REF, ["purged", "access_revoked", "purged"]);
    const batch = await drain.drainInvalidations(
      contextFor(AUTH_REV),
      CONSUMER,
      request()
    );
    expect(batch.schema).toBe("iknow.evidence_result");
    expect(batch.schema_version).toBe(1);
    expect(batch.action).toBe("invalidations");
    expect(batch.gap).toBe(false);
    expect(batch.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(batch.events.map((event) => event.reason)).toEqual([
      "purged",
      "access_revoked",
      "purged",
    ]);
    for (const event of batch.events) {
      // The closed key set of ADR 0097 §2.1's amendment, asserted per row rather
      // than against a declared constant: a renderer that added `schema_version`
      // or `consumer_id` would be refused by fin's closed-key parser, and this
      // is where that becomes visible before fin is written.
      expect(Object.keys(event).sort()).toEqual([
        "event_id",
        "evidence_ref",
        "occurred_at",
        "reason",
        "seq",
      ]);
      // The contract's whole-second `Z` form. A millisecond spelling is refused
      // by fin rather than normalized, and `pg` hands `timestamptz` back as a
      // Date in local time, so this is the row's instant and not its text.
      expect(event.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  it("answers from one read-only transaction (register §1.4)", async () => {
    statements = [];
    recording = true;
    try {
      await drain.drainInvalidations(contextFor(AUTH_REV), CONSUMER, request());
    } finally {
      recording = false;
    }
    const issued = recorded();
    // Exactly one bracket. Two `BEGIN`s would mean the cursor and the events were
    // read in different snapshots, which is the failure §1.4 exists to prevent.
    const begins = issued.filter((text) =>
      text.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    );
    expect(begins).toHaveLength(1);
    expect(issued.filter((text) => text.trim() === "COMMIT")).toHaveLength(1);
    const beginAt = issued.indexOf(begins[0]);
    const commitAt = issued.indexOf("COMMIT");
    const bracket = issued.slice(beginAt, commitAt);
    // Both halves of the answer inside that one bracket: the per-consumer
    // cursor and the outbox page.
    expect(
      bracket.some((text) => text.includes("evidence_invalidation_cursors"))
    ).toBe(true);
    expect(
      bracket.some((text) => text.includes("evidence_invalidation_outbox"))
    ).toBe(true);
    // And the page is a bounded, ascending scan rather than an unbounded read.
    const page = bracket.find((text) =>
      text.includes("evidence_invalidation_outbox") && text.includes("ORDER BY seq")
    );
    expect(page).toBeDefined();
    expect(page).toContain("LIMIT");
    expect(page).toContain("consumer_id = $1");
  });

  it("never returns another consumer's events", async () => {
    await publishEvents(OTHER_CONSUMER, SECONDARY_REF, [
      "purged",
      "purged",
      "purged",
      "purged",
    ]);
    const batch = await drain.drainInvalidations(
      contextFor(AUTH_REV),
      CONSUMER,
      request()
    );
    expect(
      batch.events.every((event) => event.evidence_ref.startsWith(PRIMARY_REF))
    ).toBe(true);
    const other = await drain.drainInvalidations(
      contextFor(AUTH_REV),
      OTHER_CONSUMER,
      request({ limit: 2 })
    );
    expect(other.events.map((event) => event.seq)).toEqual([1, 2]);
    // The predicate is the assertion: a page query that dropped `consumer_id`
    // from its WHERE clause would leak this consumer's pending scrubs into the
    // other's batch, and only the rows can show that.
    expect(
      other.events.every((event) => event.evidence_ref.startsWith(SECONDARY_REF))
    ).toBe(true);
  });

  it("pages by limit and resumes above the returned checkpoint, gaplessly", async () => {
    for (let index = 0; index < 4; index += 1) {
      await publishEvents(CONSUMER, PRIMARY_REF, ["purged"]);
    }
    const first = await drain.drainInvalidations(
      contextFor(AUTH_REV),
      CONSUMER,
      request({ limit: 2 })
    );
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    const second = await drain.drainInvalidations(
      contextFor(AUTH_REV),
      CONSUMER,
      request({ limit: 2, checkpoint: first.next_checkpoint })
    );
    // `seq[n] == seq[n-1] + 1` is what the consumer checks before it
    // acknowledges; renumbering or compacting here would make that check
    // unreachable without any row being visibly wrong.
    expect(second.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(decodeInvalidationCheckpoint(second.next_checkpoint, CONSUMER, KEY)?.s).toBe(4);
    expect(second.gap).toBe(false);
  });

  it("echoes the checkpoint it was handed and never the stream's identity", async () => {
    const resume = mintInvalidationCheckpoint(4, CONSUMER, KEY);
    const batch = await drain.drainInvalidations(
      contextFor(AUTH_REV),
      CONSUMER,
      request({ checkpoint: resume, limit: 5 })
    );
    expect(batch.checkpoint).toBe(resume);
    // ADR 0097 §2.1: `consumer_id` identifies the stream, so it is stored and
    // never sent. The fixture's evidence refs are disjoint from the consumer
    // labels, so this is a whole-envelope assertion rather than a fixture
    // artefact — a backend that published the stream identity anywhere here
    // would be opening the channel §2.1 keeps closed.
    expect(JSON.stringify(batch)).not.toContain(CONSUMER);
    expect(JSON.stringify(batch)).not.toContain(OTHER_CONSUMER);
  });

  it("refuses a checkpoint minted for another consumer as a gap, not a page", async () => {
    // The spec requires a cross-consumer checkpoint to refuse; ADR 0097 §2.7
    // makes the backend's verdict for that refusal the `gap` flag, which is the
    // one signal the consumer's recovery branch is written against.
    const foreign = mintInvalidationCheckpoint(2, OTHER_CONSUMER, KEY);
    const batch = await drain.drainInvalidations(
      contextFor(AUTH_REV),
      CONSUMER,
      request({ checkpoint: foreign })
    );
    expect(batch.gap).toBe(true);
    expect(batch.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("reports a gap when the window above the checkpoint is no longer retained", async () => {
    // Retention is §1.6's obligation and is not built; the rows are removed here
    // to prove the READ notices their absence. A backend that restarted at 1
    // silently would hand back a batch that looks contiguous and is not.
    const before = await admin.query<{ count: string }>(
      `SELECT count(*) AS count FROM evidence_invalidation_outbox
        WHERE consumer_id = $1`,
      [OTHER_CONSUMER]
    );
    await admin.query(
      `DELETE FROM evidence_invalidation_outbox
        WHERE consumer_id = $1 AND seq <= $2`,
      [OTHER_CONSUMER, 2]
    );
    expect(before.rows[0]?.count).toBe("4");
    const batch = await drain.drainInvalidations(
      contextFor(AUTH_REV),
      OTHER_CONSUMER,
      request({ checkpoint: mintInvalidationCheckpoint(0, OTHER_CONSUMER, KEY) })
    );
    expect(batch.gap).toBe(true);
    expect(batch.events.map((event) => event.seq)).toEqual([3, 4]);
  });

  it("writes nothing: the drain never advances what was acknowledged", async () => {
    // §1.5's fence, asserted from the stored rows. A drain that advanced the
    // cursor would retire events the consumer never scrubbed, and nothing else
    // in this lane would notice.
    const before = await readInvalidationCursor({ query: admin.query.bind(admin) }, CONSUMER);
    await drain.drainInvalidations(contextFor(AUTH_REV), CONSUMER, request());
    const after = await readInvalidationCursor({ query: admin.query.bind(admin) }, CONSUMER);
    expect(after?.acked_seq).toBe(0);
    expect(after?.acked_checkpoint).toBe("");
    expect(after?.last_allocated_seq).toBe(before?.last_allocated_seq);
  });

  it("refuses the whole stream once the authorization moved", async () => {
    // The identity is re-checked INSIDE the read-only transaction, so a
    // revocation that committed before the drain lands cannot be raced past.
    // The move is committed by a separate client first, which is the ordering a
    // concurrent revocation produces.
    await admin.query(
      `UPDATE evidence_scope_revisions
          SET authorization_revision = $2
        WHERE scope_binding = $1`,
      [SCOPE, AUTH_REV_MOVED]
    );
    try {
      await expect(
        drain.drainInvalidations(contextFor(AUTH_REV), CONSUMER, request())
      ).rejects.toThrowError(/authorization changed/);
    } finally {
      await admin.query(
        `UPDATE evidence_scope_revisions
            SET authorization_revision = $2
          WHERE scope_binding = $1`,
        [SCOPE, AUTH_REV]
      );
    }
  });

  it("refuses a consumer id the store's own rule would refuse", async () => {
    // `isBoundedConsumerId` is the store's single predicate, reused rather than
    // re-implemented: a second bound would be a second rule that could drift,
    // and a defaulted stream would be one nobody drains.
    for (const consumerId of ["", "   ", "x".repeat(513)]) {
      await expect(
        drain.drainInvalidations(contextFor(AUTH_REV), consumerId, request())
      ).rejects.toThrowError(/never defaulted/);
    }
  });

  it("answers an empty stream with an empty batch rather than a refusal", async () => {
    const batch = await drain.drainInvalidations(
      contextFor(AUTH_REV),
      "fin-consumer-nothing-yet",
      request()
    );
    expect(batch.events).toEqual([]);
    expect(batch.gap).toBe(false);
    expect(batch.next_checkpoint.length).toBeGreaterThan(0);
  });
});