/**
 * The all-owner purge completion record, the `ack` action and the retention
 * sweep, against a real PostgreSQL (ADR 0099 §2.1/§2.4, register §1.5 and §1.6).
 *
 * Why this suite exists as a real-Postgres file rather than unit tests over a
 * fake client. The properties under test are properties of the DATABASE and of the
 * transaction manager, not of TypeScript:
 *
 *  - **the guard is a join.** "Every configured owner has scrubbed" is a predicate
 *    over rows written by three different transactions. A fake would return
 *    whatever the test declared, and could not tell an absent owner row from a
 *    scrubbed one — which is the exact distinction ADR 0099 §2.4b turns on.
 *  - **monotonicity is a `WHERE` clause.** `UPDATE … WHERE acked_seq < $n` moves
 *    forward because PostgreSQL evaluates the predicate, and asserting that a
 *    TypeScript guard exists proves nothing about the second one.
 *  - **the retention clause is a deadline comparison against real timestamps**
 *    joined to a real grant row, so "unacknowledged and unexpired" is measured
 *    against stored data rather than against a fixture the test also wrote.
 *
 * Sibling of `structured-purge-pg.test.ts` rather than a section of it: that file
 * owns the purge transaction's own proofs, and this one owns everything after the
 * events are queued. It drives a REAL `PgStructuredPurgeStore.purge` rather than
 * seeding the completion tables directly, because the property under test on the
 * first transition is that `scheduled` is written by that transaction and not
 * beside it.
 *
 * **Each describe block owns a scope, and the cases inside one are ordered.** A
 * purge tombstones its source, so a case cannot re-purge it, and a completed
 * revision cannot be un-completed — so a case that needs a fresh starting state
 * declares its own scope rather than depending on a neighbour's cleanup. The one
 * case that DELETEs an owner row therefore runs against its own scope, where
 * deleting it cannot be confused with a record that was already complete.
 *
 * `requiresVector: true` because the bootstrap this file drives creates the whole
 * schema and the graph tables in it carry `vector` columns. The DSN points at a
 * scratch schema, never at a store anyone reads.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import {
  allocateInvalidationSeq,
  collectRetainedInvalidations,
  planInvalidationRetention,
  readRetainedInvalidations,
  type RetainedInvalidationEvent,
} from "../../src/core/storage/invalidation-outbox.js";
import {
  mintInvalidationCheckpoint,
  type InvalidationCheckpointKey,
} from "../../src/core/storage/evidence-invalidation-checkpoint.js";
import { PgEvidenceInvalidationStorage } from "../../src/core/storage/evidence-invalidation-read.js";
import { PgEvidenceInvalidationAckStore } from "../../src/core/storage/evidence-invalidation-ack.js";
import {
  PgPurgeCompletionReconciler,
  recordPayloadCollection,
} from "../../src/core/storage/structured-purge-completion.js";
import { PgStructuredPurgeStore } from "../../src/core/storage/structured-purge-pg.js";
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
  "IK_STRUCTURED_PURGE_COMPLETION_PG=1 npx vitest run tests/acceptance/structured-purge-completion-pg.test.ts";
const OPT_IN = process.env.IK_STRUCTURED_PURGE_COMPLETION_PG;
const REQUIRED = OPT_IN === "1";

const SCHEMA_PREFIX = "p3_purge_completion";
const DIMENSIONS = 8;
const SCOPE = "p3-completion-scope";
const SOURCE = "p3-completion-source";
const CONSUMER_A = "fin-owner-a";
const CONSUMER_B = "fin-owner-b";
/** Its own scope, so the case that deletes an owner row cannot disturb the others. */
const ORPHAN_SCOPE = "p3-completion-orphan-scope";
const ORPHAN_SOURCE = "p3-completion-orphan-source";
const ORPHAN_CONSUMER = "fin-owner-orphan";
/**
 * Its own scope again, for the case that needs every conjunct satisfied except
 * one owner's scrub. It cannot live on the main scope, where the "one owner short"
 * case blocks on the collection conjunct and therefore never exercises the owner
 * join.
 */
const SHORT_SCOPE = "p3-completion-short-scope";
const SHORT_SOURCE = "p3-completion-short-source";
const SHORT_OWNER_ACKED = "fin-short-acked";
const SHORT_OWNER_PENDING = "fin-short-pending";
/**
 * Its own scope, for the case where MP15's collection has already deleted every
 * grant row: the owners the purge froze must survive the deletion of the grants
 * that named them, which cannot share a scope with any case that keeps grants.
 */
const SWEPT_GRANTS_SCOPE = "p3-completion-swept-grants-scope";
const SWEPT_GRANTS_SOURCE = "p3-completion-swept-grants-source";
const SWEPT_GRANT_OWNER_A = "fin-swept-owner-a";
const SWEPT_GRANT_OWNER_B = "fin-swept-owner-b";
/**
 * Its own scope and consumer, for the retention/acknowledgement interaction: a
 * sweep inside an un-acked range must not wedge the consumer, and a genuinely
 * gapped one must still be refused.
 */
const MIDSWEEP_SCOPE = "p3-completion-midsweep-scope";
const MIDSWEEP_SOURCE = "p3-completion-midsweep-source";
const MIDSWEEP_CONSUMER = "fin-midsweep-owner";
const GAPPED_SCOPE = "p3-completion-gapped-scope";
const GAPPED_SOURCE = "p3-completion-gapped-source";
const GAPPED_CONSUMER = "fin-gapped-owner";
const AUTH_REV = "auth-rev-1";
const NOW_ISO = "2026-10-08T00:00:00.000Z";
const FUTURE_ISO = "2027-10-08T00:00:00.000Z";
const PAST_ISO = "2026-10-07T00:00:00.000Z";
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
  testPath: "tests/acceptance/structured-purge-completion-pg.test.ts",
  label: "P3 purge completion",
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
        `- Not run: tests/acceptance/structured-purge-completion-pg.test.ts`,
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
let purge: PgStructuredPurgeStore;
let drain: PgEvidenceInvalidationStorage;
let acknowledger: PgEvidenceInvalidationAckStore;
let reconciler: PgPurgeCompletionReconciler;
const PURGE_REVISION = "purge-rev-completion";
const ORPHAN_REVISION = "purge-rev-orphan";

async function connectedClient(): Promise<pg.Client> {
  const client = harness.createClient(SCHEMA_URL);
  await client.connect();
  return client;
}

/** The authorized context of one scope — the ack's scope comes from here, never
 * from a request. */
function contextFor(scope: string, source: string): AuthorizedScopeContext {
  return authority.createAuthorizedContext({
    actorId: "p3-completion-actor",
    ownerScopeBinding: scope,
    readerBinding: "p3-completion-reader",
    authorizedSourceRefs: [source],
    authorizationRevision: AUTH_REV,
    deadlineAt: DEADLINE,
  });
}

function context(): AuthorizedScopeContext {
  return contextFor(SCOPE, SOURCE);
}

/**
 * One scope, one active source and its admission row, plus the version id a
 * support must point at.
 *
 * Idempotent per `(scope, source)` because `source_versions` carries a unique
 * index on `(source_ref, source_version)`: a second insert of the same pair is a
 * constraint violation, not a reset, so a caller that re-seeds has to READ the
 * existing version rather than replace it.
 */
async function ensureScope(scope: string, source: string): Promise<string> {
  await admin.query(
    `INSERT INTO structured_publication_scopes (scope_binding)
     VALUES ($1) ON CONFLICT DO NOTHING`,
    [scope]
  );
  await admin.query(
    `INSERT INTO evidence_scope_revisions
       (scope_binding, authorization_revision, purge_revision)
     VALUES ($1, $2, 'purge-rev-0') ON CONFLICT DO NOTHING`,
    [scope, AUTH_REV]
  );
  const existing = await admin.query<{ source_version_id: string }>(
    `SELECT source_version_id FROM source_versions
      WHERE source_ref = $1 AND source_version = 'v1'`,
    [source]
  );
  // The lifecycle row carries an FK to the version it desires, so the version has
  // to exist before the source that names it.
  const versionId =
    existing.rows[0]?.source_version_id ??
    (
      await admin.query<{ source_version_id: string }>(
        `INSERT INTO source_versions
           (source_version_id, source_ref, source_version, content_digest,
            origin_object_ref, parser_revision, unit_manifest, created_at)
         VALUES ($1, $2, 'v1', $3, 'origin-1', 'parser-1', '[]'::jsonb, now())
         RETURNING source_version_id`,
        [randomUUID(), source, `digest-${source}`]
      )
    ).rows[0]!.source_version_id;
  await admin.query(
    `INSERT INTO structured_publication_sources
       (scope_binding, source_ref, active, generation,
        desired_source_version, desired_extraction_revision, desired_config_revision)
     VALUES ($1, $2, true, 0, 'v1', 1, 'cfg-1') ON CONFLICT DO NOTHING`,
    [scope, source]
  );
  return versionId;
}

/**
 * A row grant whose support reaches `source`, so the purge names it as affected.
 *
 * `expiresAt` is a parameter because the retention clause is a comparison against
 * this column, and a fixture that hard-coded one instant would make the sweep's
 * two arms the same case.
 */
async function seedGrant(input: {
  scope?: string;
  source?: string;
  versionId: string;
  evidenceRef: string;
  consumerId: string;
  expiresAt?: string;
}): Promise<void> {
  const scope = input.scope ?? SCOPE;
  const source = input.source ?? SOURCE;
  const supportId = randomUUID();
  await admin.query(
    `INSERT INTO assertion_supports
       (support_id, subject, result_id, source_ref, source_version,
        source_version_id, document_id, unit_version, unit, created_at)
     VALUES ($1, 'entity', $2, $3, 'v1', $4, 'doc-1', '1', 1, now())`,
    [supportId, input.evidenceRef, source, input.versionId]
  );
  await admin.query(
    `INSERT INTO evidence_grants
       (evidence_ref, grant_kind, subject, operation, query_digest, scope_binding,
        read_revision, authorization_revision, purge_revision, queried_at,
        expires_at, context, value, result_count, authorization_receipt_id,
        consumer_id)
     VALUES ($1, 'row', 'entity', 'list', 'digest-q', $2, '0', $3, 'purge-rev-0',
             $4::timestamptz, $5::timestamptz, '{}'::jsonb, '{}'::jsonb,
             NULL, NULL, $6)`,
    [
      input.evidenceRef,
      scope,
      AUTH_REV,
      NOW_ISO,
      input.expiresAt ?? FUTURE_ISO,
      input.consumerId,
    ]
  );
  await admin.query(
    `INSERT INTO evidence_grant_supports (evidence_ref, support_id, role)
     VALUES ($1, $2, 'occurrence')`,
    [input.evidenceRef, supportId]
  );
}

/** One real row of the revision-level completion record. */
async function readOutcomeRow(scope: string, revision: string): Promise<{
  collection_state: string;
  completed_at: Date | null;
  collected_at: Date | null;
} | null> {
  const { rows } = await admin.query(
    `SELECT collection_state, completed_at, collected_at
       FROM structured_purge_outcomes
      WHERE scope_binding = $1 AND purge_revision = $2`,
    [scope, revision]
  );
  return rows[0] ?? null;
}

/** One real owner row, keyed exactly as the reconciler joins it. */
async function readAckRow(
  scope: string,
  revision: string,
  consumerId: string
): Promise<{
  ack_state: string;
  covered_seq: string;
  acked_checkpoint: string | null;
  scrubbed_at: Date | null;
} | null> {
  const { rows } = await admin.query(
    `SELECT ack_state, covered_seq, acked_checkpoint, scrubbed_at
       FROM structured_purge_ack_states
      WHERE scope_binding = $1 AND purge_revision = $2 AND consumer_id = $3`,
    [scope, revision, consumerId]
  );
  return rows[0] ?? null;
}

/** Drain this consumer's whole stream and return the checkpoint it handed over. */
async function drainAndTakeCheckpoint(
  scope: string,
  source: string,
  consumerId: string
): Promise<string> {
  const batch = await drain.drainInvalidations(
    contextFor(scope, source),
    consumerId,
    { action: "invalidations" as never, checkpoint: null, limit: 20 }
  );
  return batch.next_checkpoint;
}

async function ack(
  scope: string,
  source: string,
  consumerId: string,
  checkpoint: string
): Promise<void> {
  await acknowledger.acknowledgeInvalidations(
    contextFor(scope, source),
    consumerId,
    { action: "ack" as never, checkpoint }
  );
}

/** A `pg.Client` as the client-level write surface, for in-transaction calls. */
function asClient(client: pg.Client): { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } {
  return client as unknown as {
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
}

/**
 * Seed one event on a consumer's stream, through the store's OWN allocator,
 * naming a real grant reference.
 *
 * The cursor's watermark is therefore one the store produced, which is the value
 * the acknowledgement path compares against; and the reference is the GRANT's
 * own, because the retention sweep resolves an event's deadline by joining on
 * it — an event naming a reference no grant carries has no deadline at all, which
 * is a different case and would pass for the wrong reason.
 */
async function seedEvent(
  consumerId: string,
  evidenceRef: string
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const eventId = randomUUID();
    const seq = await allocateInvalidationSeq(asClient(client), consumerId);
    await client.query(
      `INSERT INTO evidence_invalidation_outbox
         (consumer_id, seq, event_id, evidence_ref, reason, occurred_at)
       VALUES ($1, $2, $3, $4, 'purged', now())`,
      [consumerId, seq, eventId, evidenceRef]
    );
    await client.query("COMMIT");
    return eventId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run one full retention-sweep pass over the whole outbox, through the store's
 * own read, plan and delete.
 *
 * A hand-written `DELETE` here would bypass the retention decision the cases are
 * about — that the sweep, not the test, judged these rows collectable.
 */
async function sweepOutbox(): Promise<readonly string[]> {
  const plan = planInvalidationRetention(
    await readRetainedInvalidations(asClient(admin)),
    NOW_ISO
  );
  return collectRetainedInvalidations(asClient(admin), plan);
}

beforeAll(async () => {
  admin = await connectedClient();
  await harness.resetSchema(admin);
  // The WHOLE bootstrap, not the two completion tables alone: what is under test
  // is that `upSchemaBootstrap` reaches them, and a suite that created its own
  // tables first would pass on a bootstrap that never calls this module.
  const lease = await connectedClient();
  try {
    await upSchemaBootstrap(lease, DIMENSIONS);
  } finally {
    await lease.end();
  }
  pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 6 });
  authority = new PgStructuredScopeUnitOfWork(async () => {
    const client = await pool.connect();
    return client as unknown as ScopeTransactionClient;
  });
  purge = new PgStructuredPurgeStore(pool as never);
  drain = new PgEvidenceInvalidationStorage(authority, KEY);
  acknowledger = new PgEvidenceInvalidationAckStore(authority, KEY);
  reconciler = new PgPurgeCompletionReconciler(authority);
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

describeLane("the purge seeds the completion record", () => {
  it("records scheduled and one owner row per configured owner, in the purge's own transaction", async () => {
    const versionId = await ensureScope(SCOPE, SOURCE);
    await seedGrant({ versionId, evidenceRef: "ref-a1", consumerId: CONSUMER_A });
    await seedGrant({ versionId, evidenceRef: "ref-a2", consumerId: CONSUMER_A });
    await seedGrant({ versionId, evidenceRef: "ref-b1", consumerId: CONSUMER_B });
    const outcome = await purge.purge({
      scopeBinding: SCOPE,
      sourceRef: SOURCE,
      purgeRevision: PURGE_REVISION,
    });
    expect(outcome.applied).toBe(true);

    const record = await readOutcomeRow(SCOPE, PURGE_REVISION);
    expect(record?.collection_state).toBe("scheduled");
    // No writer outside the reconciler may set this, so the purge leaving it null
    // IS the writer-separation property, observed on real rows.
    expect(record?.completed_at).toBeNull();

    // Both owners, from the derived `evidence_grants.consumer_id` set — not one
    // row for whichever happened to drain first.
    const { rows: owners } = await admin.query(
      `SELECT consumer_id, ack_state, covered_seq
         FROM structured_purge_ack_states
        WHERE scope_binding = $1 AND purge_revision = $2
        ORDER BY consumer_id`,
      [SCOPE, PURGE_REVISION]
    );
    expect(owners).toHaveLength(2);
    expect(owners.map((row) => row.consumer_id)).toEqual([CONSUMER_A, CONSUMER_B]);
    expect(owners.map((row) => row.ack_state)).toEqual(["scheduled", "scheduled"]);
    // covered_seq is the owner's allocation watermark reached AFTER emission:
    // A published two events, B published one.
    expect(owners.map((row) => Number(row.covered_seq))).toEqual([2, 1]);
  });

  it("leaves a retry idempotent rather than writing a second record", async () => {
    const retry = await purge.purge({
      scopeBinding: SCOPE,
      sourceRef: SOURCE,
      purgeRevision: PURGE_REVISION,
    });
    expect(retry.applied).toBe(false);
    const { rows } = await admin.query(
      `SELECT count(*)::bigint AS n FROM structured_purge_outcomes
        WHERE scope_binding = $1 AND purge_revision = $2`,
      [SCOPE, PURGE_REVISION]
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describeLane("no premature completion", () => {
  it("does not complete while one owner has acked and the other has not", async () => {
    // The negative case stated directly rather than inferred: ADR 0099 §2.4b's
    // all-owner join, exercised with exactly one owner short.
    await ack(
      SCOPE,
      SOURCE,
      CONSUMER_A,
      await drainAndTakeCheckpoint(SCOPE, SOURCE, CONSUMER_A)
    );
    expect((await readAckRow(SCOPE, PURGE_REVISION, CONSUMER_A))?.ack_state).toBe(
      "scrubbed"
    );
    expect((await readAckRow(SCOPE, PURGE_REVISION, CONSUMER_B))?.ack_state).toBe(
      "scheduled"
    );

    const verdict = await reconciler.reconcile({
      scopeBinding: SCOPE,
      purgeRevision: PURGE_REVISION,
    });
    expect(verdict.completed).toBe(false);
    expect(verdict.applied).toBe(false);
    expect((await readOutcomeRow(SCOPE, PURGE_REVISION))?.completed_at).toBeNull();
    // The owner set the guard actually evaluated, so this cannot pass because the
    // set came back empty.
    expect(verdict.evaluatedOwners).toEqual([CONSUMER_A, CONSUMER_B]);
  });

  it("does not complete with every owner scrubbed but nothing collected", async () => {
    // The local delete transaction's half of the conjunction: an all-owner scrub
    // is not backend collection.
    await ack(
      SCOPE,
      SOURCE,
      CONSUMER_B,
      await drainAndTakeCheckpoint(SCOPE, SOURCE, CONSUMER_B)
    );
    expect((await readAckRow(SCOPE, PURGE_REVISION, CONSUMER_B))?.ack_state).toBe(
      "scrubbed"
    );
    expect((await readOutcomeRow(SCOPE, PURGE_REVISION))?.collection_state).toBe(
      "scheduled"
    );

    const verdict = await reconciler.reconcile({
      scopeBinding: SCOPE,
      purgeRevision: PURGE_REVISION,
    });
    expect(verdict.completed).toBe(false);
    expect((await readOutcomeRow(SCOPE, PURGE_REVISION))?.completed_at).toBeNull();
  });

  it("completes only once collected and every owner scrubbed, and stays completed", async () => {
    // The `collected` half in the same transaction as a real payload removal —
    // the shape MP15 will call this from.
    const client = await connectedClient();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM evidence_grants WHERE evidence_ref = $1`, [
        "ref-b1",
      ]);
      await recordPayloadCollection(asClient(client), {
        scopeBinding: SCOPE,
        purgeRevision: PURGE_REVISION,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
    expect((await readOutcomeRow(SCOPE, PURGE_REVISION))?.collection_state).toBe(
      "collected"
    );

    const verdict = await reconciler.reconcile({
      scopeBinding: SCOPE,
      purgeRevision: PURGE_REVISION,
    });
    expect(verdict.applied).toBe(true);
    expect(verdict.completed).toBe(true);
    const completedAt = (await readOutcomeRow(SCOPE, PURGE_REVISION))?.completed_at;
    expect(completedAt).toBeInstanceOf(Date);

    // Re-running changes nothing: the guard refuses a record already completed,
    // so a sweep that runs twice cannot restamp the instant.
    const again = await reconciler.reconcile({
      scopeBinding: SCOPE,
      purgeRevision: PURGE_REVISION,
    });
    expect(again.applied).toBe(false);
    expect(again.completed).toBe(true);
    expect((await readOutcomeRow(SCOPE, PURGE_REVISION))?.completed_at?.getTime()).toBe(
      completedAt?.getTime()
    );
  });

  it("refuses a revision no purge ever scheduled", async () => {
    await expect(
      reconciler.reconcile({ scopeBinding: SCOPE, purgeRevision: "purge-never-ran" })
    ).rejects.toThrowError(/no purge completion record exists/);
  });
});

describeLane("a revision with no owner row is refused, not completed", () => {
  it("refuses reconcile when the revision's owner set is empty, and completes once an owner row exists", async () => {
    // The refactored contract, stated on real rows: the reconciler judges the
    // owner rows the purge FROZE (`structured_purge_ack_states`), never a set
    // re-derived from `evidence_grants`. A revision with zero owner rows has had
    // no scrub judged — the completion guard is written negatively, so an empty
    // set would satisfy it and complete the revision on `collected` alone — so
    // the reconciler refuses rather than answers. The earlier version of this
    // case expected a verdict here, which is exactly the vacuous completion the
    // repair removes.
    const versionId = await ensureScope(ORPHAN_SCOPE, ORPHAN_SOURCE);
    await seedGrant({
      scope: ORPHAN_SCOPE,
      source: ORPHAN_SOURCE,
      versionId,
      evidenceRef: "ref-orphan",
      consumerId: ORPHAN_CONSUMER,
    });
    await purge.purge({
      scopeBinding: ORPHAN_SCOPE,
      sourceRef: ORPHAN_SOURCE,
      purgeRevision: ORPHAN_REVISION,
    });
    const collected = await connectedClient();
    try {
      await collected.query("BEGIN");
      await recordPayloadCollection(asClient(collected), {
        scopeBinding: ORPHAN_SCOPE,
        purgeRevision: ORPHAN_REVISION,
      });
      await collected.query("COMMIT");
    } finally {
      await collected.end();
    }
    await admin.query(
      `DELETE FROM structured_purge_ack_states
        WHERE scope_binding = $1 AND purge_revision = $2`,
      [ORPHAN_SCOPE, ORPHAN_REVISION]
    );
    expect(await readAckRow(ORPHAN_SCOPE, ORPHAN_REVISION, ORPHAN_CONSUMER)).toBeNull();

    await expect(
      reconciler.reconcile({ scopeBinding: ORPHAN_SCOPE, purgeRevision: ORPHAN_REVISION })
    ).rejects.toThrowError(/records no owner/);
    expect(
      (await readOutcomeRow(ORPHAN_SCOPE, ORPHAN_REVISION))?.completed_at
    ).toBeNull();

    // The owner really does acknowledge — and the refusal stands, because ADR
    // 0099 §2.1 makes `scheduled` the PURGE transaction's write. An
    // acknowledgement advances a position; it does not invent an owner.
    await ack(
      ORPHAN_SCOPE,
      ORPHAN_SOURCE,
      ORPHAN_CONSUMER,
      await drainAndTakeCheckpoint(ORPHAN_SCOPE, ORPHAN_SOURCE, ORPHAN_CONSUMER)
    );
    expect(await readAckRow(ORPHAN_SCOPE, ORPHAN_REVISION, ORPHAN_CONSUMER)).toBeNull();
    await expect(
      reconciler.reconcile({ scopeBinding: ORPHAN_SCOPE, purgeRevision: ORPHAN_REVISION })
    ).rejects.toThrowError(/records no owner/);

    // With the row present and scrubbed, the same revision completes — so the
    // refusal above was the empty owner set and nothing else.
    await admin.query(
      `INSERT INTO structured_purge_ack_states
         (scope_binding, purge_revision, consumer_id, ack_state, covered_seq,
          acked_checkpoint, scrubbed_at)
       VALUES ($1, $2, $3, 'scrubbed', 1, $4, now())`,
      [
        ORPHAN_SCOPE,
        ORPHAN_REVISION,
        ORPHAN_CONSUMER,
        mintInvalidationCheckpoint(1, ORPHAN_CONSUMER, KEY),
      ]
    );
    const completed = await reconciler.reconcile({
      scopeBinding: ORPHAN_SCOPE,
      purgeRevision: ORPHAN_REVISION,
    });
    expect(completed.applied).toBe(true);
    expect(completed.completed).toBe(true);
    expect(completed.evaluatedOwners).toEqual([ORPHAN_CONSUMER]);
  });
});

describeLane("one owner acked and one not is never a completion", () => {
  it("refuses with every other conjunct satisfied", async () => {
    // The briefing's negative case stated in its sharpest possible form: the
    // revision IS collected and ONE of two owners has scrubbed, so the owner join
    // is the only conjunct left standing and its correctness is the whole result.
    // An earlier version of this case lived on the main scope, where the record
    // was not yet collected — and so passed identically whether or not the guard
    // checked `ack_state`, because the collection conjunct was doing the work.
    const revision = "purge-rev-short";
    const versionId = await ensureScope(SHORT_SCOPE, SHORT_SOURCE);
    await seedGrant({
      scope: SHORT_SCOPE,
      source: SHORT_SOURCE,
      versionId,
      evidenceRef: "ref-short-acked",
      consumerId: SHORT_OWNER_ACKED,
    });
    await seedGrant({
      scope: SHORT_SCOPE,
      source: SHORT_SOURCE,
      versionId,
      evidenceRef: "ref-short-pending",
      consumerId: SHORT_OWNER_PENDING,
    });
    await purge.purge({
      scopeBinding: SHORT_SCOPE,
      sourceRef: SHORT_SOURCE,
      purgeRevision: revision,
    });

    // Only the first owner acknowledges. The second never drains, so its owner row
    // stays `scheduled` — present, and NOT scrubbed.
    await ack(
      SHORT_SCOPE,
      SHORT_SOURCE,
      SHORT_OWNER_ACKED,
      await drainAndTakeCheckpoint(SHORT_SCOPE, SHORT_SOURCE, SHORT_OWNER_ACKED)
    );
    expect((await readAckRow(SHORT_SCOPE, revision, SHORT_OWNER_ACKED))?.ack_state).toBe(
      "scrubbed"
    );
    const pending = await readAckRow(SHORT_SCOPE, revision, SHORT_OWNER_PENDING);
    expect(pending?.ack_state).toBe("scheduled");
    expect(pending).not.toBeNull();

    const collected = await connectedClient();
    try {
      await collected.query("BEGIN");
      await recordPayloadCollection(asClient(collected), {
        scopeBinding: SHORT_SCOPE,
        purgeRevision: revision,
      });
      await collected.query("COMMIT");
    } finally {
      await collected.end();
    }

    const verdict = await reconciler.reconcile({
      scopeBinding: SHORT_SCOPE,
      purgeRevision: revision,
    });
    expect(verdict.evaluatedOwners).toEqual([SHORT_OWNER_ACKED, SHORT_OWNER_PENDING]);
    expect(verdict.completed).toBe(false);
    expect(verdict.applied).toBe(false);
    expect((await readOutcomeRow(SHORT_SCOPE, revision))?.collection_state).toBe(
      "collected"
    );
    expect((await readOutcomeRow(SHORT_SCOPE, revision))?.completed_at).toBeNull();

    // And the second owner acknowledging is what completes it — so the refusal
    // above was the missing scrub, not a revision that can never finish.
    await ack(
      SHORT_SCOPE,
      SHORT_SOURCE,
      SHORT_OWNER_PENDING,
      await drainAndTakeCheckpoint(SHORT_SCOPE, SHORT_SOURCE, SHORT_OWNER_PENDING)
    );
    const completed = await reconciler.reconcile({
      scopeBinding: SHORT_SCOPE,
      purgeRevision: revision,
    });
    expect(completed.applied).toBe(true);
    expect(completed.completed).toBe(true);
  });
});

describeLane("deleting the scope's grants does not erase a frozen owner", () => {
  it("completes with every owner scrubbed after MP15's collection removed every grant row", async () => {
    // ADR 0099 §2.3: an owner whose grant has gone is still `NULL` — never
    // "assumed scrubbed" — and §2.4b's guard judges owner ROWS, not a set
    // re-derived from `evidence_grants`. This is the hole the old derivation
    // opened: MP15's collection deletes from `evidence_grants`, so re-deriving
    // after collection would yield `[]`, and the old vacuous join would complete
    // the revision with zero owners scrubbed. On its own scope, because the
    // grant deletion is the state every other case must not inherit.
    const revision = "purge-rev-swept-grants";
    const versionId = await ensureScope(SWEPT_GRANTS_SCOPE, SWEPT_GRANTS_SOURCE);
    await seedGrant({
      scope: SWEPT_GRANTS_SCOPE,
      source: SWEPT_GRANTS_SOURCE,
      versionId,
      evidenceRef: "ref-swept-a",
      consumerId: SWEPT_GRANT_OWNER_A,
    });
    await seedGrant({
      scope: SWEPT_GRANTS_SCOPE,
      source: SWEPT_GRANTS_SOURCE,
      versionId,
      evidenceRef: "ref-swept-b",
      consumerId: SWEPT_GRANT_OWNER_B,
    });
    await purge.purge({
      scopeBinding: SWEPT_GRANTS_SCOPE,
      sourceRef: SWEPT_GRANTS_SOURCE,
      purgeRevision: revision,
    });

    // The local delete transaction's own shape: the payload removal and the
    // `collected` write in one commit, with the grant rows deleted inside it.
    const collected = await connectedClient();
    try {
      await collected.query("BEGIN");
      await collected.query(`DELETE FROM evidence_grants WHERE scope_binding = $1`, [
        SWEPT_GRANTS_SCOPE,
      ]);
      await recordPayloadCollection(asClient(collected), {
        scopeBinding: SWEPT_GRANTS_SCOPE,
        purgeRevision: revision,
      });
      await collected.query("COMMIT");
    } catch (error) {
      await collected.query("ROLLBACK");
      throw error;
    } finally {
      await collected.end();
    }
    const { rows: grantCount } = await admin.query(
      `SELECT count(*)::bigint AS n FROM evidence_grants WHERE scope_binding = $1`,
      [SWEPT_GRANTS_SCOPE]
    );
    expect(Number(grantCount[0]!.n)).toBe(0);
    expect((await readOutcomeRow(SWEPT_GRANTS_SCOPE, revision))?.collection_state).toBe(
      "collected"
    );

    // The frozen owner rows survived the deletion that emptied the derivation
    // table — and both owners still owe a scrub.
    await ack(
      SWEPT_GRANTS_SCOPE,
      SWEPT_GRANTS_SOURCE,
      SWEPT_GRANT_OWNER_A,
      await drainAndTakeCheckpoint(SWEPT_GRANTS_SCOPE, SWEPT_GRANTS_SOURCE, SWEPT_GRANT_OWNER_A)
    );
    await ack(
      SWEPT_GRANTS_SCOPE,
      SWEPT_GRANTS_SOURCE,
      SWEPT_GRANT_OWNER_B,
      await drainAndTakeCheckpoint(SWEPT_GRANTS_SCOPE, SWEPT_GRANTS_SOURCE, SWEPT_GRANT_OWNER_B)
    );
    expect(
      (await readAckRow(SWEPT_GRANTS_SCOPE, revision, SWEPT_GRANT_OWNER_A))?.ack_state
    ).toBe("scrubbed");
    expect(
      (await readAckRow(SWEPT_GRANTS_SCOPE, revision, SWEPT_GRANT_OWNER_B))?.ack_state
    ).toBe("scrubbed");

    const verdict = await reconciler.reconcile({
      scopeBinding: SWEPT_GRANTS_SCOPE,
      purgeRevision: revision,
    });
    expect(verdict.applied).toBe(true);
    expect(verdict.completed).toBe(true);
    expect(verdict.evaluatedOwners).toEqual([SWEPT_GRANT_OWNER_A, SWEPT_GRANT_OWNER_B]);
  });
});

describeLane("a mid-range retention sweep does not wedge the acknowledgement", () => {
  it("advances an ack whose un-acked range was swept from its middle", async () => {
    // The offline-owner case the retention clause exists for: the consumer acked
    // a prefix, then its grant expired for one later event and the sweep collected
    // it FROM THE MIDDLE of the un-acked range. The earliest retained event still
    // opens the range at ackedSeq+1, so the loss was the sweep's own judgement and
    // nothing un-judged was skipped. A row-count contiguity test refused this
    // acknowledgement forever (the covered range could never again match its
    // length); the floor test advances.
    const versionId = await ensureScope(MIDSWEEP_SCOPE, MIDSWEEP_SOURCE);
    await seedGrant({
      scope: MIDSWEEP_SCOPE,
      source: MIDSWEEP_SOURCE,
      versionId,
      evidenceRef: "ref-midsweep-kept",
      consumerId: MIDSWEEP_CONSUMER,
      expiresAt: FUTURE_ISO,
    });
    await seedGrant({
      scope: MIDSWEEP_SCOPE,
      source: MIDSWEEP_SOURCE,
      versionId,
      evidenceRef: "ref-midsweep-swept",
      consumerId: MIDSWEEP_CONSUMER,
      expiresAt: PAST_ISO,
    });
    // seq 1..2 are the acknowledged prefix.
    await seedEvent(MIDSWEEP_CONSUMER, "ref-midsweep-kept");
    await seedEvent(MIDSWEEP_CONSUMER, "ref-midsweep-kept");
    await ack(
      MIDSWEEP_SCOPE,
      MIDSWEEP_SOURCE,
      MIDSWEEP_CONSUMER,
      await drainAndTakeCheckpoint(MIDSWEEP_SCOPE, MIDSWEEP_SOURCE, MIDSWEEP_CONSUMER)
    );
    // seq 3..5 are the pending range; seq 4 names the expired grant and is the
    // row the sweep collects from its middle.
    await seedEvent(MIDSWEEP_CONSUMER, "ref-midsweep-kept");
    const sweptEventId = await seedEvent(MIDSWEEP_CONSUMER, "ref-midsweep-swept");
    await seedEvent(MIDSWEEP_CONSUMER, "ref-midsweep-kept");
    // The sweep also collects the acknowledged prefix (it has served its
    // purpose), but the retained window's floor STAYS at or below the position
    // the ack will be judged from — the range keeps its own beginning at 3.
    const collected = await sweepOutbox();
    expect(collected).toContain(sweptEventId);

    // The drain resumes from the stored position 2, finds the window still opens
    // at 3 (the swept row was at 4), and hands over a batch covering 5.
    const checkpoint = await drainAndTakeCheckpoint(
      MIDSWEEP_SCOPE,
      MIDSWEEP_SOURCE,
      MIDSWEEP_CONSUMER
    );
    await ack(MIDSWEEP_SCOPE, MIDSWEEP_SOURCE, MIDSWEEP_CONSUMER, checkpoint);
    const { rows } = await admin.query(
      `SELECT acked_seq FROM evidence_invalidation_cursors WHERE consumer_id = $1`,
      [MIDSWEEP_CONSUMER]
    );
    expect(Number(rows[0]!.acked_seq)).toBe(5);
  });

  it("still refuses an ack whose range has lost its beginning", async () => {
    // The counter-case: the sweep removed the EARLIEST un-acked row, so the
    // covered range no longer opens at ackedSeq+1 and no later acknowledgement can
    // show it was one contiguous handover. Advancing here would be the silent
    // event loss the refusal exists to prevent.
    const versionId = await ensureScope(GAPPED_SCOPE, GAPPED_SOURCE);
    await seedGrant({
      scope: GAPPED_SCOPE,
      source: GAPPED_SOURCE,
      versionId,
      evidenceRef: "ref-gapped-kept",
      consumerId: GAPPED_CONSUMER,
      expiresAt: FUTURE_ISO,
    });
    await seedGrant({
      scope: GAPPED_SCOPE,
      source: GAPPED_SOURCE,
      versionId,
      evidenceRef: "ref-gapped-swept",
      consumerId: GAPPED_CONSUMER,
      expiresAt: PAST_ISO,
    });
    await seedEvent(GAPPED_CONSUMER, "ref-gapped-kept");
    await seedEvent(GAPPED_CONSUMER, "ref-gapped-kept");
    await ack(
      GAPPED_SCOPE,
      GAPPED_SOURCE,
      GAPPED_CONSUMER,
      await drainAndTakeCheckpoint(GAPPED_SCOPE, GAPPED_SOURCE, GAPPED_CONSUMER)
    );
    // seq 3 is the earliest un-acked row and names the expired grant, so it is
    // the row the sweep collects — the one that opened the range. The full
    // sweep pass also lifts the acknowledged prefix; what is left opens ABOVE
    // the position the next ack is judged from.
    const sweptEventId = await seedEvent(GAPPED_CONSUMER, "ref-gapped-swept");
    await seedEvent(GAPPED_CONSUMER, "ref-gapped-kept");
    await seedEvent(GAPPED_CONSUMER, "ref-gapped-kept");
    const collected = await sweepOutbox();
    expect(collected).toContain(sweptEventId);

    const checkpoint = await drainAndTakeCheckpoint(
      GAPPED_SCOPE,
      GAPPED_SOURCE,
      GAPPED_CONSUMER
    );
    await expect(
      acknowledger.acknowledgeInvalidations(
        contextFor(GAPPED_SCOPE, GAPPED_SOURCE),
        GAPPED_CONSUMER,
        { action: "ack" as never, checkpoint }
      )
    ).rejects.toThrowError(/no longer begins/);
    // The refusal left the stored position exactly where the prefix put it.
    const { rows } = await admin.query(
      `SELECT acked_seq FROM evidence_invalidation_cursors WHERE consumer_id = $1`,
      [GAPPED_CONSUMER]
    );
    expect(Number(rows[0]!.acked_seq)).toBe(2);
  });
});

describeLane("acknowledgement monotonicity, against real rows", () => {
  it("refuses an acknowledgement below the stored position and leaves it alone", async () => {
    // The second, statement-level fence: the stored position moves only when the
    // guard lets it, so this is observed on the row rather than on a return value.
    await expect(
      acknowledger.acknowledgeInvalidations(context(), CONSUMER_A, {
        action: "ack" as never,
        checkpoint: mintInvalidationCheckpoint(1, CONSUMER_A, KEY),
      })
    ).rejects.toThrowError(/moves forward only/);
    const { rows } = await admin.query(
      `SELECT acked_seq FROM evidence_invalidation_cursors WHERE consumer_id = $1`,
      [CONSUMER_A]
    );
    expect(Number(rows[0]!.acked_seq)).toBe(2);
  });

  it("accepts the position already acknowledged as idempotent", async () => {
    const before = (await readAckRow(SCOPE, PURGE_REVISION, CONSUMER_A))?.scrubbed_at;
    await ack(
      SCOPE,
      SOURCE,
      CONSUMER_A,
      mintInvalidationCheckpoint(2, CONSUMER_A, KEY)
    );
    // The repeat moved nothing: same scrub instant, so the guarded update refused.
    expect((await readAckRow(SCOPE, PURGE_REVISION, CONSUMER_A))?.scrubbed_at).toEqual(
      before
    );
  });

  it("refuses a checkpoint minted for another consumer's stream", async () => {
    // Cross-consumer refusal is only observable with N ≥ 2, which is why the owner
    // set is derived rather than configured.
    await expect(
      acknowledger.acknowledgeInvalidations(context(), CONSUMER_B, {
        action: "ack" as never,
        checkpoint: mintInvalidationCheckpoint(2, CONSUMER_A, KEY),
      })
    ).rejects.toThrowError(/did not authenticate for this consumer/);
  });

  it("refuses a position past the stream's own watermark", async () => {
    await expect(
      acknowledger.acknowledgeInvalidations(context(), CONSUMER_B, {
        action: "ack" as never,
        checkpoint: mintInvalidationCheckpoint(99, CONSUMER_B, KEY),
      })
    ).rejects.toThrowError(/above the highest position/);
  });
});

describeLane("§1.6 retention of unacknowledged events", () => {
  /** The sweep's view of one event, straight from the real join. */
  async function retentionRow(eventId: string): Promise<RetainedInvalidationEvent | null> {
    const events = await readRetainedInvalidations(asClient(admin));
    return events.find((event) => event.eventId === eventId) ?? null;
  }

  async function sweep(
    events: readonly RetainedInvalidationEvent[]
  ): Promise<readonly string[]> {
    const plan = planInvalidationRetention(events, NOW_ISO);
    return collectRetainedInvalidations(asClient(admin), plan);
  }

  async function outboxCount(eventId: string): Promise<number> {
    const { rows } = await admin.query(
      `SELECT count(*)::bigint AS n FROM evidence_invalidation_outbox
        WHERE event_id = $1`,
      [eventId]
    );
    return Number(rows[0]!.n);
  }

  it("retains an unacknowledged event whose grant is still unexpired", async () => {
    const versionId = await ensureScope(SCOPE, SOURCE);
    const consumer = "fin-retain-live";
    await seedGrant({
      versionId,
      evidenceRef: "ref-retain-live",
      consumerId: consumer,
      expiresAt: FUTURE_ISO,
    });
    const eventId = await seedEvent(consumer, "ref-retain-live");

    const row = await retentionRow(eventId);
    expect(row).not.toBeNull();
    // Unacknowledged — the cursor row exists with nothing acknowledged on it.
    expect(row!.ackedSeq).toBe(0);
    expect(await sweep([row!])).toEqual([]);
    expect(await outboxCount(eventId)).toBe(1);
  });

  it("collects it once the grant has expired, without marking anything acknowledged", async () => {
    const versionId = await ensureScope(SCOPE, SOURCE);
    const consumer = "fin-retain-expired";
    await seedGrant({
      versionId,
      evidenceRef: "ref-retain-expired",
      consumerId: consumer,
      expiresAt: PAST_ISO,
    });
    const eventId = await seedEvent(consumer, "ref-retain-expired");

    expect(await sweep([await retentionRow(eventId)!])).toEqual([eventId]);
    expect(await outboxCount(eventId)).toBe(0);

    // ADR 0099 §2.3: an owner that was offline for the whole window is still
    // unacknowledged afterwards. The sweep collected a payload and claimed
    // nothing — so its purge can still only ever settle at `collected`.
    const { rows } = await admin.query(
      `SELECT acked_seq, acked_checkpoint FROM evidence_invalidation_cursors
        WHERE consumer_id = $1`,
      [consumer]
    );
    expect(Number(rows[0]!.acked_seq)).toBe(0);
    expect(rows[0]!.acked_checkpoint).toBe("");
  });
});