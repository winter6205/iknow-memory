/**
 * Strict PostgreSQL driver for the structured publication integration slice.
 *
 * Normal `npm test` skips this driver. With STRUCTURED_PUBLICATION_ACCEPTANCE=1
 * it requires a real PostgreSQL + pgvector instance and uses one random schema
 * for this test run; the schema is the only database object this driver drops.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgStructuredIdentityStore } from "../../src/core/structured/identity-store.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
} from "../integration/pg-test-harness.js";
import {
  createPublicationTestClock,
  describeContract,
  expectFailure,
  prepareNearExpiryAttempt,
  startAttempt,
  stage,
  type PublicationTestPort,
} from "../storage/publication-contract.js";

const EXPECTED_COMMAND =
  "STRUCTURED_PUBLICATION_ACCEPTANCE=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-publication-pg.test.ts";
const ACCEPTANCE_ENV = "STRUCTURED_PUBLICATION_ACCEPTANCE";
const REQUIRED = process.env[ACCEPTANCE_ENV] === "1";
const CONNECTION_STRING = resolvePgConnectionString(
  "postgresql://postgres@localhost/postgres"
);
const DIMENSIONS = 8;

const pgHarness = await createPgIntegrationHarness({
  label: "structured-publication-acceptance-pg",
  testPath: "tests/acceptance/structured-publication-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  schemaPrefix: "structured_publication_acceptance",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});

const { schemaConnectionString: SCHEMA_URL, createClient } = pgHarness;
const describeAcceptance = REQUIRED ? pgHarness.describePg : describe.skip;

let backend: PgvectorBackend;
let pool: pg.Pool;
let admin: pg.Client;
let faultSerial = 0;

interface PgPublicationTestPort extends PublicationTestPort {
  delayNextStageWrite(milliseconds: number): Promise<void>;
}

async function delayNextInsert(
  table: "projection_outbox" | "structured_publication_stages",
  milliseconds: number
): Promise<void> {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > 10_000
  ) {
    throw new Error("test delay must be between 1 and 10000ms");
  }
  faultSerial += 1;
  const suffix = `publication_delay_${faultSerial}`;
  const sequence = `${pgHarness.schema}.${suffix}_sequence`;
  const triggerName = `${suffix}_trigger`;
  const seconds = (milliseconds / 1000).toFixed(3);
  await pool.query(
    `CREATE SEQUENCE "${pgHarness.schema}"."${suffix}_sequence"`
  );
  await pool.query(`
    CREATE FUNCTION "${pgHarness.schema}"."${suffix}_function"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $publication_delay$
    BEGIN
      IF nextval('${sequence}'::regclass) = 1 THEN
        PERFORM pg_sleep(${seconds});
      END IF;
      RETURN NEW;
    END;
    $publication_delay$`);
  await pool.query(`
    CREATE TRIGGER "${triggerName}"
    BEFORE INSERT ON "${pgHarness.schema}"."${table}"
    FOR EACH ROW EXECUTE FUNCTION "${pgHarness.schema}"."${suffix}_function"()`);
}

async function openPgPublicationPort(): Promise<PgPublicationTestPort> {
  const publicationBackend = backend as PgvectorBackend & {
    structuredPublication?: PublicationTestPort["publication"];
  };
  const authoritativePublication = publicationBackend.structuredPublication;
  if (!authoritativePublication) {
    throw new Error("PgvectorBackend does not expose structuredPublication");
  }
  const ownedSourceRefs = new Set<string>();
  const publication: PublicationTestPort["publication"] = {
    async declareDesired(input) {
      ownedSourceRefs.add(input.sourceRef);
      return authoritativePublication.declareDesired(input);
    },
    stageAttempt(input) {
      return authoritativePublication.stageAttempt(input);
    },
    publish(input) {
      return authoritativePublication.publish(input);
    },
    withdraw(input) {
      return authoritativePublication.withdraw(input);
    },
    readSnapshot(input) {
      return authoritativePublication.readSnapshot(input);
    },
  };

  return {
    publication,
    evidence: backend,
    identity: new PgStructuredIdentityStore(pool),
    work: new PgMaintenanceWorkStore(pool),
    clock: createPublicationTestClock(),
    async seedGraphEntities(entityIds) {
      for (const entityId of entityIds) {
        await pool.query(
          `INSERT INTO entities (id, canonical_name, type, embedding, metadata, retired)
           VALUES ($1, $2, 'organization', NULL, '{}'::jsonb, false)
           ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type`,
          [entityId, `publication test entity ${entityId}`]
        );
      }
    },
    async failNextOutboxWrite() {
      faultSerial += 1;
      const suffix = `publication_fault_${faultSerial}`;
      const sequence = `${pgHarness.schema}.${suffix}_sequence`;
      const triggerName = `${suffix}_trigger`;
      await pool.query(
        `CREATE SEQUENCE "${pgHarness.schema}"."${suffix}_sequence"`
      );
      await pool.query(`
        CREATE FUNCTION "${pgHarness.schema}"."${suffix}_function"()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $publication_fault$
        BEGIN
          IF nextval('${sequence}'::regclass) = 1 THEN
            RAISE EXCEPTION 'injected publication outbox failure'
              USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END;
        $publication_fault$`);
      await pool.query(`
        CREATE TRIGGER "${triggerName}"
        BEFORE INSERT ON projection_outbox
        FOR EACH ROW EXECUTE FUNCTION "${pgHarness.schema}"."${suffix}_function"()`);
    },
    async delayNextOutboxWrite(milliseconds) {
      await delayNextInsert("projection_outbox", milliseconds);
    },
    async delayNextStageWrite(milliseconds) {
      await delayNextInsert("structured_publication_stages", milliseconds);
    },
    async readOutboxCount(_scopeBinding) {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM projection_outbox"
      );
      return Number(result.rows[0]?.count ?? "0");
    },
    async close() {
      const sourceRefs = [...ownedSourceRefs];
      if (sourceRefs.length === 0) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE maintenance_job_attempts
              SET finished_at = clock_timestamp(),
                  failure_code = 'input_stale', reclaimed = false
            WHERE finished_at IS NULL
              AND job_key IN (
                SELECT job_key FROM maintenance_jobs
                 WHERE source_ref = ANY($1::text[]) AND status = 'running'
              )`,
          [sourceRefs]
        );
        await client.query(
          `UPDATE maintenance_jobs
              SET status = 'stale', last_failure_code = 'input_stale',
                  next_attempt_at = NULL, fencing_token = NULL,
                  lease_expires_at = NULL, attempt_started_at = NULL,
                  updated_at = clock_timestamp()
            WHERE source_ref = ANY($1::text[]) AND status = 'running'`,
          [sourceRefs]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

if (REQUIRED) {
  const probe = await probePostgres(CONNECTION_STRING, true);
  if (!probe.available) {
    throw new Error(
      [
        "Validation:",
        "- Not run: structured publication acceptance requires real PostgreSQL + pgvector.",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Blocking issue: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`,
        "- Start it with: docker compose up -d --wait postgres",
      ].join("\n")
    );
  }
}

describeAcceptance(
  "structured publication acceptance — real PostgreSQL",
  () => {
    beforeAll(async () => {
      admin = createClient(SCHEMA_URL);
      await admin.connect();
      await pgHarness.resetSchema(admin);
      backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, {
        annMaxDimensions: 2000,
      });
      await backend.initialize();
      pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 6 });
    }, 120_000);

    afterAll(async () => {
      try {
        if (admin) await pgHarness.dropSchema(admin);
      } finally {
        await pool?.end();
        await backend?.close();
        await admin?.end();
      }
    });

    describeAcceptance("PostgreSQL stage lease fence", () => {
      it("rolls back a stage write that crosses the live lease deadline", async () => {
        const port = await openPgPublicationPort();
        try {
          const fixture = await prepareNearExpiryAttempt(
            port,
            "stage-expiry",
            2_500
          );
          const before = await port.publication.readSnapshot({
            scopeBinding: fixture.scopeBinding,
          });
          const outboxBefore = await port.readOutboxCount(fixture.scopeBinding);
          expect(Date.now()).toBeLessThan(fixture.leaseExpiresAt);
          await port.delayNextStageWrite(3_000);

          await expectFailure(
            stage(
              port,
              fixture.scopeBinding,
              fixture.sourceRef,
              fixture.attempt,
              "extract-v1",
              [fixture.fact]
            ),
            "lease_lost"
          );

          expect(Date.now()).toBeGreaterThanOrEqual(fixture.leaseExpiresAt);
          const after = await port.publication.readSnapshot({
            scopeBinding: fixture.scopeBinding,
          });
          expect(after.readRevision).toBe(before.readRevision);
          expect(after.maintenanceRevision).toBe(before.maintenanceRevision);
          expect(after.subjects).toEqual(before.subjects);
          expect(
            await port.work.getJob(fixture.attempt.guard.jobKey)
          ).toMatchObject({
            status: "running",
          });
          expect(await port.readOutboxCount(fixture.scopeBinding)).toBe(
            outboxBefore
          );
          const stageRows = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM structured_publication_stages
              WHERE scope_binding = $1 AND source_ref = $2`,
            [fixture.scopeBinding, fixture.sourceRef]
          );
          expect(Number(stageRows.rows[0]?.count ?? "0")).toBe(0);

          const cleanupAt = new Date(Date.now() + 1);
          const reclaimed = await port.work.reclaimExpiredWork(cleanupAt);
          expect(
            reclaimed.some(
              (entry) => entry.jobKey === fixture.attempt.guard.jobKey
            )
          ).toBe(true);
          const replacementGuard = await port.work.claimWork(cleanupAt);
          if (!replacementGuard) {
            throw new Error("could not claim stage-fence cleanup attempt");
          }
          expect(replacementGuard.jobKey).toBe(fixture.attempt.guard.jobKey);
          expect(
            await port.work.settleWork(
              replacementGuard,
              { status: "failed", failureCode: "invalid_input" },
              fixture.attempt.live,
              cleanupAt
            )
          ).toMatchObject({
            result: "settled",
            record: { status: "failed" },
          });
        } finally {
          await port.close();
        }
      }, 15_000);
    });

    describeAcceptance("PostgreSQL publication migration parity", () => {
      it("refuses an unbound revision that conflicts with retained legacy display", async () => {
        const port = await openPgPublicationPort();
        try {
          const fixture = await prepareNearExpiryAttempt(
            port,
            "legacy-display-parity",
            60_000
          );
          await stage(
            port,
            fixture.scopeBinding,
            fixture.sourceRef,
            fixture.attempt,
            "extract-v1",
            [fixture.fact]
          );
          await port.publication.publish({
            scopeBinding: fixture.scopeBinding,
            sourceRef: fixture.sourceRef,
            guard: fixture.attempt.guard,
            at: fixture.eventAt,
          });
          const published = await port.publication.readSnapshot({
            scopeBinding: fixture.scopeBinding,
          });
          const supportId = published.subjects.find(
            (subject) => subject.resultId === fixture.fact.occurrence.result_id
          )?.supportIds[0];
          expect(supportId).toEqual(expect.any(String));

          const removedBinding = await pool.query(
            `DELETE FROM structured_publication_extraction_bindings
              WHERE scope_binding = $1 AND source_ref = $2
                AND source_version = $3 AND extraction_revision = 1`,
            [fixture.scopeBinding, fixture.sourceRef, "v1"]
          );
          expect(removedBinding.rowCount).toBe(1);
          const changedDisplay = await pool.query(
            `UPDATE structured_publication_display
                SET canonical_name = 'Legacy-mutated name'
              WHERE scope_binding = $1 AND source_ref = $2
                AND support_id = $3 AND extraction_revision = 1`,
            [fixture.scopeBinding, fixture.sourceRef, supportId]
          );
          expect(changedDisplay.rowCount).toBe(1);

          const generation = await port.publication.declareDesired({
            scopeBinding: fixture.scopeBinding,
            authorizedSourceRefs: [fixture.sourceRef],
            sourceRef: fixture.sourceRef,
            sourceVersion: fixture.version.record,
            locatorBindings: fixture.version.locatorBindings,
            desiredExtractionRevision: 1,
            configRevision: "extractor-v1",
          });
          const second = await startAttempt(
            port,
            fixture.sourceRef,
            "v1",
            generation.generation,
            "extractor-v1",
            1
          );
          await stage(
            port,
            fixture.scopeBinding,
            fixture.sourceRef,
            second,
            "extract-v1",
            [fixture.fact]
          );
          const beforeRefusal = await port.publication.readSnapshot({
            scopeBinding: fixture.scopeBinding,
          });
          expect(
            beforeRefusal.subjects.find(
              (subject) =>
                subject.resultId === fixture.fact.occurrence.result_id
            )?.displayValues
          ).toContainEqual(
            expect.objectContaining({
              extractionRevision: 1,
              canonicalName: "Legacy-mutated name",
            })
          );
          const outboxBefore = await port.readOutboxCount(fixture.scopeBinding);
          const bindingCountBefore = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM structured_publication_extraction_bindings
              WHERE scope_binding = $1 AND source_ref = $2
                AND source_version = $3 AND extraction_revision = 1`,
            [fixture.scopeBinding, fixture.sourceRef, "v1"]
          );
          expect(Number(bindingCountBefore.rows[0]?.count ?? "0")).toBe(0);
          const pointerBefore = await pool.query<{
            published_generation: string;
          }>(
            `SELECT published_generation::text AS published_generation
               FROM structured_publication_sources
              WHERE scope_binding = $1 AND source_ref = $2`,
            [fixture.scopeBinding, fixture.sourceRef]
          );

          await expectFailure(
            port.publication.publish({
              scopeBinding: fixture.scopeBinding,
              sourceRef: fixture.sourceRef,
              guard: second.guard,
              at: port.clock().toISOString(),
            }),
            "input_stale"
          );

          const afterRefusal = await port.publication.readSnapshot({
            scopeBinding: fixture.scopeBinding,
          });
          expect(afterRefusal).toEqual(beforeRefusal);
          expect(await port.readOutboxCount(fixture.scopeBinding)).toBe(
            outboxBefore
          );
          const bindingCountAfter = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM structured_publication_extraction_bindings
              WHERE scope_binding = $1 AND source_ref = $2
                AND source_version = $3 AND extraction_revision = 1`,
            [fixture.scopeBinding, fixture.sourceRef, "v1"]
          );
          expect(Number(bindingCountAfter.rows[0]?.count ?? "0")).toBe(0);
          const pointerAfter = await pool.query<{
            published_generation: string;
          }>(
            `SELECT published_generation::text AS published_generation
               FROM structured_publication_sources
              WHERE scope_binding = $1 AND source_ref = $2`,
            [fixture.scopeBinding, fixture.sourceRef]
          );
          expect(pointerAfter.rows[0]?.published_generation).toBe(
            pointerBefore.rows[0]?.published_generation
          );
          expect(
            await port.work.settleWork(
              second.guard,
              { status: "stale" },
              second.live,
              port.clock()
            )
          ).toMatchObject({
            result: "settled",
            record: { status: "stale" },
          });
        } finally {
          await port.close();
        }
      });
    });

    describeContract("PostgreSQL", openPgPublicationPort, describeAcceptance);
  }
);
