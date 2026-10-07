/**
 * MP16 explicit purge against a real PostgreSQL (fin
 * `specs/structured-corpus-maintenance.md` §Physical collection, M16/M17/M20;
 * register §1.2 / §1b.4; ADR 0097 §4.1/§4.2).
 *
 * Every case here asserts a property of the DATABASE, never of a mock. That is
 * the whole reason this is a separate file rather than more cases in a unit
 * suite, and it is not a stylistic preference:
 *
 * 1. **Lease visibility is MVCC.** A purge can only wait on a reader whose lease
 *    row COMMITTED in another connection. A row written inside the read's own
 *    transaction would be invisible, and a `Map` twin has no visibility rule at
 *    all — so this file registers a lease on one connection and proves a second
 *    one sees it and waits on it.
 * 2. **The fence is a row.** A running attempt's token is refused by the ledger's
 *    own heartbeat and settle against the committed row, not by a spy.
 * 3. **Atomicity is a commit.** Four writes either all exist or none does, which
 *    is only observable after a real COMMIT — and the retry case proves the
 *    opposite of atomicity too: a second purge allocates no second `seq`, so the
 *    per-consumer stream stays gapless across a crash.
 * 4. **The bound terminates.** A lease that has expired stops holding the wait
 *    with no reaper running, because expiry is a filter over a committed row.
 *
 * The acceptance contract, deliberately never green-skipped:
 *
 *      STRUCTURED_PURGE_ACCEPTANCE=1 GRAPHRAG_MEMORY_DB_URL=<dsn> \
 *        npx vitest run tests/acceptance/structured-purge-pg.test.ts
 *
 *   - marker absent: the suite is inert and the run exits 0.
 *   - marker set, database unreachable: the module load throws, so the run exits
 *     NON-ZERO naming the blocking issue instead of reporting a skipped lane.
 *   - marker set, database live: every case runs.
 *
 * `MAINTENANCE_ACCEPTANCE=1` is accepted as an equivalent switch so the
 * maintenance program's own lane command runs this one too; the dedicated marker
 * exists because no other acceptance file claims it.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimNextWork,
  settleWork,
  type MaintenanceWorkDeps,
} from "../../src/core/maintenance/service.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import { lockScopeRevisions } from "../../src/core/storage/evidence-pg.js";
import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { withStructuredReadLease } from "../../src/core/storage/structured-purge-pg.js";
import {
  PgStructuredPurgeStore,
  type StructuredPurgePool,
} from "../../src/core/storage/structured-purge-pg.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
  type PgIntegrationHarness,
} from "../integration/pg-test-harness.js";

const EXPECTED_COMMAND =
  "STRUCTURED_PURGE_ACCEPTANCE=1 GRAPHRAG_MEMORY_DB_URL=<dsn> npx vitest run tests/acceptance/structured-purge-pg.test.ts";
const DEDICATED_MARKER = "STRUCTURED_PURGE_ACCEPTANCE";
const PROGRAM_MARKER = "MAINTENANCE_ACCEPTANCE";
/** Small, like the outbox lane's: nothing here embeds anything. */
const DIMENSIONS = 8;

const REQUIRED =
  process.env[DEDICATED_MARKER] === "1" || process.env[PROGRAM_MARKER] === "1";
const CONNECTION_STRING = resolvePgConnectionString(
  "postgresql://postgres@localhost/postgres"
);

const harness: PgIntegrationHarness = await createPgIntegrationHarness({
  label: "MP16 explicit purge",
  testPath: "tests/acceptance/structured-purge-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  schemaPrefix: "mp16_purge",
  defaultConnectionString: CONNECTION_STRING,
  requiresVector: true,
});

if (REQUIRED) {
  // EXIT: the marker is set, so this run CLAIMS to be acceptance evidence. An
  // unreachable database is therefore this named failure, never a skip.
  const reachability = await probePostgres(CONNECTION_STRING, true);
  if (!reachability.available) {
    throw new Error(
      [
        "Validation:",
        "- Not run: MP16 explicit purge acceptance requires a real Postgres 16 + pgvector.",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Markers: ${DEDICATED_MARKER}=1 or ${PROGRAM_MARKER}=1 were set.`,
        `- Blocking issue: ${
          reachability.error instanceof Error
            ? reachability.error.message
            : String(reachability.error)
        }`,
        "- A skipped lane is not acceptance evidence, so this run exits non-zero.",
      ].join("\n")
    );
  }
}

const describeAcceptance = REQUIRED ? describe : describe.skip;

const SCOPE = "purge-scope";
const SOURCE = "purge-src-1";
const OTHER_SOURCE = "purge-src-2";
const CONSUMER = "fin-purge-consumer";
const NOW_ISO = "2026-10-08T00:00:00.000Z";
/** `NOW_ISO` as an instant, so a test can shift it without string-appending. */
const at = (offsetMs: number): Date => new Date(Date.parse(NOW_ISO) + offsetMs);
const LEASE_MS = 60_000;

let admin: pg.Client;
let pool: pg.Pool;
let store: PgStructuredPurgeStore;
let work: PgMaintenanceWorkStore;

/** A CONNECTED client. `pg` 8 queues forever on an unconnected one. */
async function connected(): Promise<pg.Client> {
  const client = harness.createClient(harness.schemaConnectionString);
  await client.connect();
  return client;
}

/** A store whose every transaction is this ONE client, so a case can hold a
 * transaction open and observe what another connection can and cannot see. */
function storeOver(client: pg.Client): PgStructuredPurgeStore {
  const leased = {
    connect: async () => ({
      query: (text: string, values?: unknown[]) =>
        client.query(text, values) as unknown as Promise<{ rows: unknown[] }>,
      // `pg.Client` owns its connection for its lifetime, so a lease that wraps
      // one has nothing to hand back. Returning it would close the very
      // connection the transaction is still using.
      release: () => undefined,
    }),
  };
  return new PgStructuredPurgeStore(leased as unknown as StructuredPurgePool);
}

/** The scope, one active source, and the admission row a purge writes. */
async function seedScope(): Promise<void> {
  await admin.query(
    `INSERT INTO structured_publication_scopes (scope_binding)
     VALUES ($1) ON CONFLICT DO NOTHING`,
    [SCOPE]
  );
  await admin.query(
    `INSERT INTO evidence_scope_revisions
       (scope_binding, authorization_revision, purge_revision)
     VALUES ($1, 'auth-1', 'purge-0') ON CONFLICT DO NOTHING`,
    [SCOPE]
  );
  for (const sourceRef of [SOURCE, OTHER_SOURCE]) {
    // The lifecycle row carries an FK to the version it desires, so the version
    // has to exist before the source that names it.
    await admin.query(
      `INSERT INTO source_versions
         (source_version_id, source_ref, source_version, content_digest,
          origin_object_ref, parser_revision, unit_manifest, created_at)
       VALUES ($1, $2, 'v1', $3, 'origin-1', 'parser-1', '[]'::jsonb, now())`,
      [randomUUID(), sourceRef, `digest-${sourceRef}`]
    );
    await admin.query(
      `INSERT INTO structured_publication_sources
         (scope_binding, source_ref, active, generation,
          desired_source_version, desired_extraction_revision, desired_config_revision)
       VALUES ($1, $2, true, 0, 'v1', 1, 'cfg-1')
       ON CONFLICT DO NOTHING`,
      [SCOPE, sourceRef]
    );
  }
}

/**
 * A row grant whose support reaches `sourceRef`, plus a count grant on the same
 * scope. The count grant carries no support link at all — that is the arm the
 * purge has to name by kind rather than by join.
 */
async function seedGrants(
  sourceRef: string,
  consumerId: string,
  evidenceRef: string
): Promise<void> {
  const versionId = (
    await admin.query<{ source_version_id: string }>(
      `SELECT source_version_id FROM source_versions
        WHERE source_ref = $1 AND source_version = 'v1'`,
      [sourceRef]
    )
  ).rows[0]!.source_version_id;
  const supportId = randomUUID();
  await admin.query(
    `INSERT INTO assertion_supports
       (support_id, subject, result_id, source_ref, source_version,
        source_version_id, document_id, unit_version, unit, created_at)
     VALUES ($1, 'entity', 'entity-1', $2, 'v1', $3, 'doc-1', '1', 1, now())`,
    [supportId, sourceRef, versionId]
  );
  await admin.query(
    `INSERT INTO evidence_grants
       (evidence_ref, grant_kind, subject, operation, query_digest, scope_binding,
        read_revision, authorization_revision, purge_revision, queried_at,
        expires_at, context, value, result_count, authorization_receipt_id,
        consumer_id)
     VALUES ($1, 'row', 'entity', 'list', 'digest-q', $2, '0', 'auth-1',
             'purge-0', $3::timestamptz, $4::timestamptz, '{}'::jsonb,
             '{}'::jsonb, NULL, NULL, $5)`,
    [evidenceRef, SCOPE, NOW_ISO, "2027-10-08T00:00:00.000Z", consumerId]
  );
  await admin.query(
    `INSERT INTO evidence_grant_supports (evidence_ref, support_id, role)
     VALUES ($1, $2, 'occurrence')`,
    [evidenceRef, supportId]
  );
}

async function seedCountGrant(
  evidenceRef: string,
  consumerId: string
): Promise<void> {
  const receiptId = randomUUID();
  await admin.query(
    `INSERT INTO evidence_authorization_receipts
       (receipt_id, scope_binding, authorization_revision, purge_revision, created_at)
     VALUES ($1, $2, 'auth-1', 'purge-0', now())`,
    [receiptId, SCOPE]
  );
  await admin.query(
    `INSERT INTO evidence_grants
       (evidence_ref, grant_kind, subject, operation, query_digest, scope_binding,
        read_revision, authorization_revision, purge_revision, queried_at,
        expires_at, context, value, result_count, authorization_receipt_id,
        consumer_id)
     VALUES ($1, 'count', 'entity', 'count', 'digest-c', $2, '0', 'auth-1',
             'purge-0', $3::timestamptz, $4::timestamptz, '{}'::jsonb,
             '{"subject":"entity","count":3}'::jsonb, 3, $5, $6)`,
    [
      evidenceRef,
      SCOPE,
      NOW_ISO,
      "2027-10-08T00:00:00.000Z",
      receiptId,
      consumerId,
    ]
  );
}

/** One row of observable state, read straight back from the database. */
async function scopeState(): Promise<{
  readonly purgeRevision: string;
  readonly active: boolean;
  readonly generation: string;
  readonly tombstones: number;
  readonly events: number;
  readonly lastAllocatedSeq: string;
}> {
  const row = await admin.query(
    `SELECT (SELECT purge_revision FROM evidence_scope_revisions
              WHERE scope_binding = $1) AS purge_revision,
            (SELECT active FROM structured_publication_sources
              WHERE scope_binding = $1 AND source_ref = $2) AS active,
            (SELECT generation FROM structured_publication_sources
              WHERE scope_binding = $1 AND source_ref = $2) AS generation,
            (SELECT count(*) FROM structured_purge_tombstones
              WHERE scope_binding = $1 AND source_ref = $2) AS tombstones,
            (SELECT count(*) FROM evidence_invalidation_outbox) AS events,
            (SELECT last_allocated_seq FROM evidence_invalidation_cursors
              WHERE consumer_id = $3) AS last_allocated_seq`,
    [SCOPE, SOURCE, CONSUMER]
  );
  const found = row.rows[0] as Record<string, unknown>;
  return {
    purgeRevision: String(found.purge_revision),
    active: found.active === true,
    generation: String(found.generation),
    tombstones: Number(found.tombstones),
    events: Number(found.events),
    lastAllocatedSeq: String(found.last_allocated_seq ?? "0"),
  };
}

const purgeRequest = (purgeRevision: string) => ({
  scopeBinding: SCOPE,
  sourceRef: SOURCE,
  purgeRevision,
});

beforeAll(async () => {
  admin = await connected();
  await harness.resetSchema(admin);
  const lease = await connected();
  try {
    await upSchemaBootstrap(lease, DIMENSIONS);
  } finally {
    await lease.end();
  }
  pool = new pg.Pool({ connectionString: harness.schemaConnectionString, max: 6 });
  store = new PgStructuredPurgeStore(pool as unknown as StructuredPurgePool);
  work = new PgMaintenanceWorkStore(pool as never);
}, 180_000);

beforeEach(async () => {
  // One case per corpus: the purge reads and writes rows every other case also
  // reads, and a leftover tombstone would make the next case look already-applied.
  await admin.query(
    `TRUNCATE structured_purge_tombstones, structured_read_leases,
              evidence_invalidation_outbox, evidence_invalidation_cursors,
              evidence_grant_supports, evidence_grants,
              evidence_authorization_receipts, assertion_supports, source_versions,
              maintenance_job_attempts, maintenance_jobs
     CASCADE`
  );
  await admin.query(`DELETE FROM structured_publication_scopes WHERE scope_binding = $1`, [
    SCOPE,
  ]);
  await admin.query(`DELETE FROM evidence_scope_revisions WHERE scope_binding = $1`, [
    SCOPE,
  ]);
  await seedScope();
});

afterAll(async () => {
  try {
    await harness.dropSchema(admin);
  } finally {
    await admin?.end();
    await pool?.end();
    await work?.close();
  }
}, 120_000);

describeAcceptance("MP16 — the purge transaction on a real PostgreSQL", () => {
  it("bootstraps both tables and the active-lease index", async () => {
    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name IN ('structured_read_leases',
                             'structured_purge_tombstones')`,
      [harness.schema]
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      "structured_purge_tombstones",
      "structured_read_leases",
    ]);
    const indexes = await admin.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'structured_read_leases_active_idx'`,
      [harness.schema]
    );
    expect(indexes.rows).toHaveLength(1);
  });

  it("refuses a lease that expires at or before it was taken", async () => {
    await expect(
      admin.query(
        `INSERT INTO "${harness.schema}".structured_read_leases
           (lease_id, scope_binding, source_ref, reader_kind, purge_revision,
            acquired_at, expires_at)
         VALUES ($1, $2, $3, 'query', 'purge-0', now(), now())`,
        [randomUUID(), SCOPE, SOURCE]
      )
    ).rejects.toThrow(/structured_read_leases_expiry_check/);
  });

  it("refuses a reader kind outside the closed vocabulary", async () => {
    await expect(
      admin.query(
        `INSERT INTO "${harness.schema}".structured_read_leases
           (lease_id, scope_binding, source_ref, reader_kind, purge_revision,
            acquired_at, expires_at)
         VALUES ($1, $2, $3, 'replica', 'purge-0', now(),
                 now() + interval '1 minute')`,
        [randomUUID(), SCOPE, SOURCE]
      )
    ).rejects.toThrow(/reader_kind/);
  });

  it("commits the tombstone, the revision, the lifecycle and the event together", async () => {
    await seedGrants(SOURCE, CONSUMER, "ref-row-1");
    await seedCountGrant("ref-count-1", CONSUMER);

    const outcome = await store.purge(purgeRequest("purge-1"));

    // Observable state, not "purge was called": four separate tables carry the
    // one commit, and a transaction that committed only some of them would show
    // up here as a row count that does not add up.
    const state = await scopeState();
    expect(state.tombstones).toBe(1);
    expect(state.purgeRevision).toBe("purge-1");
    expect(state.active).toBe(false);
    expect(state.generation).toBe("1");
    expect(state.events).toBe(2);
    // Both events ride the SAME consumer's counter, and the counter ends at 2 —
    // the gapless per-consumer stream ADR 0097 §4.2 requires.
    expect(state.lastAllocatedSeq).toBe("2");
    const reasons = await admin.query<{ reason: string; seq: string }>(
      `SELECT reason, seq FROM evidence_invalidation_outbox
        ORDER BY seq ASC`
    );
    expect(reasons.rows.map((row) => row.reason)).toEqual(["purged", "purged"]);
    expect(reasons.rows.map((row) => row.seq)).toEqual(["1", "2"]);

    expect(outcome.applied).toBe(true);
    expect(outcome.invalidatedRefs.sort()).toEqual([
      "ref-count-1",
      "ref-row-1",
    ]);
    expect(outcome.unpublishedRefs).toEqual([]);
    expect(outcome.generation).toBe(1);

    // The grant rows still carry the PRE-purge revision while the scope has moved
    // on: that mismatch is exactly what `decideGrantRead` refuses on, which is
    // how the purge denies reads with no new mechanism.
    const stale = await admin.query<{ purge_revision: string }>(
      `SELECT purge_revision FROM evidence_grants WHERE evidence_ref = 'ref-row-1'`
    );
    expect(stale.rows[0]?.purge_revision).toBe("purge-0");
  });

  it("names no grant that does not reach the purged source", async () => {
    await seedGrants(OTHER_SOURCE, CONSUMER, "ref-other-source");
    await store.purge(purgeRequest("purge-1"));
    const emitted = await admin.query<{ evidence_ref: string }>(
      `SELECT evidence_ref FROM evidence_invalidation_outbox`
    );
    expect(emitted.rows).toHaveLength(0);
  });

  it("reports a grant with no drainable consumer instead of dropping it", async () => {
    await seedGrants(SOURCE, "", "ref-no-consumer");
    const outcome = await store.purge(purgeRequest("purge-1"));
    expect(outcome.unpublishedRefs).toEqual(["ref-no-consumer"]);
    expect(outcome.invalidatedRefs).toEqual([]);
    // No cursor row either: a blank consumer must not mint a stream nobody drains.
    const cursors = await admin.query(
      `SELECT count(*) AS n FROM evidence_invalidation_cursors WHERE consumer_id = ''`
    );
    expect(Number((cursors.rows[0] as { n: string }).n)).toBe(0);
  });

  it("is idempotent: a retry advances nothing and allocates no second seq", async () => {
    await seedGrants(SOURCE, CONSUMER, "ref-row-1");
    const first = await store.purge(purgeRequest("purge-1"));
    const afterFirst = await scopeState();

    const retry = await store.purge(purgeRequest("purge-1"));

    expect(first.applied).toBe(true);
    expect(retry.applied).toBe(false);
    const afterRetry = await scopeState();
    // A second seq here would be a GAP in fin's stream, which its contiguity rule
    // refuses. That is the whole reason the tombstone is read before allocating.
    expect(afterRetry.lastAllocatedSeq).toBe(afterFirst.lastAllocatedSeq);
    expect(afterRetry.events).toBe(afterFirst.events);
    expect(afterRetry.tombstones).toBe(afterFirst.tombstones);
    expect(afterRetry.purgeRevision).toBe("purge-1");
    expect(afterRetry.generation).toBe("1");
  });

  it("fences a running attempt, and the ledger then refuses its stale token", async () => {
    const deps: MaintenanceWorkDeps = { store: work, clock: () => at(0) };
    const scheduled = await work.scheduleWork(
      {
        workKind: "extract_publish",
        sourceRef: SOURCE,
        sourceVersion: "v1",
        sourceGeneration: 0,
        inputRevision: "in-1",
        configRevision: "cfg-1",
        dependencies: [],
      },
      at(0)
    );
    if ("refused" in scheduled) throw new Error(scheduled.detail);
    const claimed = await claimNextWork(deps);
    const guard = claimed.guard;
    if (guard === null) throw new Error("no job was claimed");

    // Before the purge the attempt owns its lease.
    expect(
      await work.heartbeatWork(guard, at(1_000))
    ).toBe(true);

    const outcome = await store.purge(purgeRequest("purge-1"));
    expect(outcome.fencedJobKeys).toContain(guard.jobKey);

    // The stale token is now refused by the ledger's own writes, against the
    // committed row. Both are the observable verdicts a worker branches on.
    expect(
      await work.heartbeatWork(guard, at(2_000))
    ).toBe(false);
    const settled = await settleWork(
      deps,
      guard,
      { status: "ready" },
      { dependencies: [], configRevision: "cfg-1" }
    );
    expect(settled).toEqual({ result: "lease_lost" });

    // The attempt is closed with the fence code, and the job is not claimable.
    const attempt = await work.listAttempts(guard.jobKey);
    expect(attempt).toHaveLength(1);
    expect(attempt[0]?.failureCode).toBe("lease_lost");
    expect(attempt[0]?.finishedAt).not.toBeNull();
    const row = await admin.query<{ status: string; fencing_token: string | null }>(
      `SELECT status, fencing_token FROM maintenance_jobs WHERE job_key = $1`,
      [guard.jobKey]
    );
    expect(row.rows[0]?.status).toBe("stale");
    expect(row.rows[0]?.fencing_token).toBeNull();
  });

  it("sees a reader's COMMITTED lease from another connection and waits for it", async () => {
    // THE case this lane exists for. The lease is written and committed on one
    // connection; the purge's wait runs on another. Nothing here would be
    // observable without real MVCC: a lease written inside the read's own
    // transaction would be invisible, and the purge would remove payloads
    // underneath a live reader.
    //
    // The lease is short-lived so the wait is observable inside a test. That
    // changes nothing about the property: what is proven is that one connection
    // SEES the committed row and that the wait ends on the row's own expiry.
    const reader = await connected();
    const purgeSide = storeOver(await connected());
    try {
      await reader.query("BEGIN");
      await withStructuredReadLease(
        { runTransaction: (body) => body(reader as never) },
        {
          scopeBinding: SCOPE,
          sourceRefs: [SOURCE],
          readerKind: "query",
          ttlMs: 400,
        },
        async () => {
          // Uncommitted: the purge side finds nothing and does not wait.
          expect(
            await purgeSide.awaitActiveReads({
              scopeBinding: SCOPE,
              sourceRefs: [SOURCE],
            })
          ).toBe(0);
          await reader.query("COMMIT");
          // Committed and still held: the purge side sees the reader and waits it
          // out rather than proceeding underneath it.
          expect(
            await purgeSide.awaitActiveReads({
              scopeBinding: SCOPE,
              sourceRefs: [SOURCE],
            })
          ).toBe(1);
        }
      );
      const outcome = await purgeSide.purge(purgeRequest("purge-1"));
      expect(outcome.applied).toBe(true);
      expect(outcome.activeReadLeases).toBe(0);
    } finally {
      await reader.end();
    }
  });

  it("waits out a lease that has expired, with no reaper running", async () => {
    // Termination is the TTL invariant. The row is inserted with a lifetime no
    // read path would choose, precisely so the wait can be observed without a
    // 60-second test: nothing deletes this row, and the wait still ends.
    await admin.query(
      `INSERT INTO structured_read_leases
         (lease_id, scope_binding, source_ref, reader_kind, purge_revision,
          acquired_at, expires_at)
       VALUES ($1, $2, $3, 'query', 'purge-0', now(),
               now() + interval '400 milliseconds')`,
      [randomUUID(), SCOPE, SOURCE]
    );
    const startedAt = Date.now();
    const waited = await store.awaitActiveReads({
      scopeBinding: SCOPE,
      sourceRefs: [SOURCE],
    });
    const elapsed = Date.now() - startedAt;
    expect(waited).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(350);
    // And the purge that follows is not delayed by a reader that is already gone.
    const outcome = await store.purge(purgeRequest("purge-1"));
    expect(outcome.applied).toBe(true);
    expect(outcome.activeReadLeases).toBe(0);
  });

  it("releases a lease whose row is already gone, instead of failing the read", async () => {
    // `DELETE … RETURNING` with no row is the normal shape of a second release
    // and of a reader whose row was reaped. Treating it as a failure would fail a
    // read that has already answered.
    const reader = await connected();
    try {
      const answer = await withStructuredReadLease(
        { runTransaction: (body) => body(reader as never) },
        {
          scopeBinding: SCOPE,
          sourceRefs: [SOURCE],
          readerKind: "query",
          ttlMs: LEASE_MS,
        },
        async () => {
          await admin.query(`DELETE FROM structured_read_leases`);
          return "answered";
        }
      );
      expect(answer).toBe("answered");
    } finally {
      await reader.end();
    }
  });

  it("blocks a second purge behind a real transaction holding the admission row", async () => {
    // Two real connections, two real transactions, neither aware of the other.
    // The first holds `evidence_scope_revisions` FOR UPDATE; the purge must WAIT,
    // because that row is the state it is about to change.
    const holder = await connected();
    try {
      await holder.query("BEGIN");
      const locked = await lockScopeRevisions(holder as never, SCOPE);
      expect(locked?.purge_revision).toBe("purge-0");

      let settled = false;
      const purging = store
        .purge(purgeRequest("purge-1"))
        .then((outcome) => {
          settled = true;
          return outcome;
        });
      // Give the purge a real chance to reach the lock before asserting it has
      // not passed it; a race-free assertion is not the property under test.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      await holder.query("ROLLBACK");
      const outcome = await purging;
      expect(outcome.applied).toBe(true);
    } finally {
      await holder.end();
    }
  }, 20_000);

  it("applies exactly one of two concurrent purges of the same revision", async () => {
    await seedGrants(SOURCE, CONSUMER, "ref-row-1");
    const leftClient = await connected();
    const rightClient = await connected();
    const left = storeOver(leftClient);
    const right = storeOver(rightClient);
    try {
      const [a, b] = await Promise.all([
        left.purge(purgeRequest("purge-1")),
        right.purge(purgeRequest("purge-1")),
      ]);
      // Whoever went second joined the committed tombstone. Both applied would be
      // two purges for one request, and one of them burned a `seq` for nothing.
      expect([a.applied, b.applied].filter(Boolean)).toHaveLength(1);
      const state = await scopeState();
      expect(state.tombstones).toBe(1);
      expect(state.events).toBe(1);
      expect(state.lastAllocatedSeq).toBe("1");
      expect(state.generation).toBe("1");
    } finally {
      await leftClient.end();
      await rightClient.end();
    }
  }, 20_000);

  it("refuses a purge of a source the scope does not own", async () => {
    await expect(
      store.purge({
        scopeBinding: SCOPE,
        sourceRef: "never-published-source",
        purgeRevision: "purge-1",
      })
    ).rejects.toMatchObject({ code: "access_denied" });
    // And nothing was written on the refusal path.
    expect((await scopeState()).tombstones).toBe(0);
  });

  it("refuses a blank purge revision before touching the database", async () => {
    await expect(store.purge(purgeRequest("   "))).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect((await scopeState()).tombstones).toBe(0);
    expect((await scopeState()).purgeRevision).toBe("purge-0");
  });
});