/**
 * M13/M19 acceptance — the MP12 serving guard on the real boundary.
 *
 * The guard has two implementations that fail independently, so this file has
 * two tiers. The `guardCandidateSources` cases prove the lifecycle read and the
 * pure decision against real rows. The `buildVectorSearchQuery` cases prove
 * `SERVING_GUARD_CLAUSE` — the one artifact that changes what production returns
 * — by executing the emitted SQL against real `chunks`, `source_versions` and
 * `structured_publication_sources` rows. A join can be syntactically fine and
 * semantically wrong, and it can be right in isolation yet unreachable in the
 * query that carries it, which is why the clause is run the way the vector query
 * actually runs it.
 *
 * Opt-in: `MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-mp12-guards-pg.test.ts`.
 * Under the marker an unreachable database throws and exits non-zero; without it
 * the suite is inert. A missing dependency is a named failure, never a skip.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import pg from "pg";

import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
} from "../integration/pg-test-harness.js";
import { createEvidenceTables } from "../../src/core/storage/schema-evidence.js";
import { upSchemaPublication } from "../../src/core/storage/schema-publication.js";
import { buildVectorSearchQuery } from "../../src/core/storage/pgvector-backend.js";
import { EMBEDDING_SLOT_BASE } from "../../src/core/storage/embedding-generation.js";
import {
  guardCandidateSources,
  readSourceLifecycleFacts,
} from "../../src/core/storage/serving-guard-pg.js";
import { MemoryServingGuard } from "../../src/core/storage/serving-guard-memory.js";

const EXPECTED_COMMAND =
  "MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-mp12-guards-pg.test.ts";
const REQUIRED = process.env.MAINTENANCE_ACCEPTANCE === "1";
const DIMENSIONS = 1536;
const VALID_AT = "2026-08-01T00:00:00.000Z";
const QUERY_EMBEDDING = new Array<number>(DIMENSIONS).fill(0);
const CONNECTION_STRING = resolvePgConnectionString(
  "postgresql://postgres@localhost/postgres"
);

const pgHarness = await createPgIntegrationHarness({
  label: "mp12-guards",
  testPath: "tests/acceptance/maintenance-mp12-guards-pg.test.ts",
  expectedCommand:
    "MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-mp12-guards-pg.test.ts",
  schemaPrefix: "mp12_guards",
  defaultConnectionString: "postgresql://postgres@localhost:5432/postgres",
  requiresVector: true,
});
const { schemaConnectionString: SCHEMA_URL, describePg } = pgHarness;

/**
 * The opt-in marker means the operator ASKED for this lane, so an unreachable
 * database is a named failure here rather than the harness's local loud-skip.
 *
 * The harness only hard-fails under `CI`, which is right for the general
 * integration suites and wrong for this one: someone who set the marker wants a
 * result, and a skipped suite that exits 0 is exactly the "it passed" they would
 * report. A file-level `beforeAll` cannot cover this — vitest does not run it
 * when every describe is skipped — so the probe happens at module scope.
 *
 * Without the marker this must stay INERT, not fatal: the file is collected by
 * the default `npm test` glob, and a module-scope throw there takes the whole
 * suite down over a lane nobody asked for.
 */
if (REQUIRED) {
  const probe = await probePostgres(CONNECTION_STRING, true);
  if (!probe.available) {
    throw new Error(
      [
        "Validation:",
        "- Not run: the MP12 guard lane requires a real Postgres 16 + pgvector.",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Blocking issue: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`,
      ].join("\n")
    );
  }
}

const describeAcceptance = REQUIRED ? describePg : describePg.skip;

/** Created in `beforeAll`, never at module scope: a module-level client is
 *  constructed once per collection AND once per execution, which seeds twice. */
let client: pg.Client;
let admin: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: pgHarness.connectionString });
  await admin.connect();
  // A dropped schema, not a CREATE IF NOT EXISTS: the evidence tables are
  // created with IF NOT EXISTS, so a schema left over from an earlier run would
  // silently keep its rows and every seed would collide.
  await pgHarness.resetSchema(admin);
  client = new pg.Client({ connectionString: SCHEMA_URL });
  await client.connect();
  await createEvidenceTables(client);
  // Withdrawal lives on `structured_publication_sources`, so the guard cannot be
  // exercised against real rows without that table.
  await upSchemaPublication(client);
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  await client.query(`CREATE TABLE chunks (
    id uuid PRIMARY KEY,
    content text NOT NULL,
    embedding vector(${DIMENSIONS}) NOT NULL,
    valid_from timestamptz NOT NULL,
    valid_until timestamptz NULL,
    source_ref text NOT NULL,
    metadata jsonb NOT NULL,
    created_at timestamptz NOT NULL
  )`);
}, 180_000);

/** Register a source so it has a publication row to be withdrawn on. */
async function publish(
  sourceRef: string,
  active: boolean
): Promise<void> {
  await client.query(
    `INSERT INTO structured_publication_scopes (scope_binding)
     VALUES ('mp12-acceptance') ON CONFLICT DO NOTHING`
  );
  await client.query(
    `INSERT INTO structured_publication_sources (scope_binding, source_ref, active)
     VALUES ('mp12-acceptance', $1, $2)
     ON CONFLICT (scope_binding, source_ref) DO UPDATE SET active = EXCLUDED.active`,
    [sourceRef, active]
  );
}

/** Write one real `chunks` row, so the guard has a row to refuse or return. */
async function seedChunk(sourceRef: string): Promise<void> {
  await client.query(
    `INSERT INTO chunks
       (id, content, embedding, valid_from, valid_until, source_ref, metadata, created_at)
     VALUES ($1, $2, $3::vector, '2026-01-01T00:00:00.000Z', NULL, $4, '{}'::jsonb, now())`,
    [
      randomUUID(),
      `chunk for ${sourceRef}`,
      `[${QUERY_EMBEDDING.join(",")}]`,
      sourceRef,
    ]
  );
}

/** The `source_ref`s the production vector query actually returns. */
async function servedSourceRefs(): Promise<string[]> {
  const { sql, params } = buildVectorSearchQuery(
    QUERY_EMBEDDING,
    { validAt: VALID_AT, limit: 50 },
    EMBEDDING_SLOT_BASE
  );
  const result = await client.query(sql, params);
  return result.rows.map((row: { source_ref: string }) => row.source_ref);
}

interface SeedSource {
  readonly sourceRef: string;
  readonly versions: ReadonlyArray<{
    readonly sourceVersion: string;
    readonly retiredAt: string | null;
    readonly payloadCollectedAt: string | null;
  }>;
  /**
   * Absent means "no `structured_publication_sources` row at all", which is the
   * ingested-not-yet-published case and must keep serving.
   */
  readonly active?: boolean;
}

async function seed(sources: readonly SeedSource[]): Promise<void> {
  for (const source of sources) {
    if (source.active !== undefined) await publish(source.sourceRef, source.active);
    for (const version of source.versions) {
      await client.query(
        `INSERT INTO source_versions
           (source_version_id, source_ref, source_version, content_digest,
            origin_object_ref, parser_revision, unit_manifest, created_at,
            retired_at, payload_collected_at, obligations_stopped_at)
         VALUES ($1, $2, $3, $4, $5, 'p1', '[]'::jsonb, now(), $6::timestamptz, $7::timestamptz, NULL)`,
        [
          randomUUID(),
          source.sourceRef,
          version.sourceVersion,
          `digest-${source.sourceRef}-${version.sourceVersion}`,
          `origin-${source.sourceRef}-${version.sourceVersion}`,
          version.retiredAt,
          version.payloadCollectedAt,
        ]
      );
    }
  }
}

describeAcceptance("M13/M19 acceptance — serving guards on the real boundary", () => {
  it("serves a source with a live version and drops one whose every payload is collected", async () => {
    await seed([
      { sourceRef: "live", versions: [{ sourceVersion: "v1", retiredAt: null, payloadCollectedAt: null }] },
      {
        sourceRef: "purged",
        versions: [
          { sourceVersion: "v1", retiredAt: "2026-01-01T00:00:00.000Z", payloadCollectedAt: "2026-02-01T00:00:00.000Z" },
          { sourceVersion: "v2", retiredAt: "2026-01-02T00:00:00.000Z", payloadCollectedAt: "2026-02-02T00:00:00.000Z" },
        ],
      },
    ]);

    const facts = await readSourceLifecycleFacts(client, ["live", "purged"]);
    expect(facts).not.toBeNull();
    expect(facts?.get("live")?.payloadCollectedAt).toBeNull();
    expect(facts?.get("purged")?.payloadCollectedAt).not.toBeNull();

    const verdict = await guardCandidateSources(client, ["live", "purged"]);
    expect(verdict.served).toBe(true);
    if (!verdict.served) return;
    expect(verdict.dropped).toEqual(["purged"]);
  });

  it("keeps a source visible when ONE of its versions is still live", async () => {
    // The case a naive aggregate gets wrong: two versions, one collected. It
    // takes `bool_or(payload_collected_at IS NULL)`, because a source is
    // servable while ANY version still has an un-collected payload. `bool_and`
    // reads as the same sentence and drops a source whose current version is
    // perfectly healthy because an older one was purged.
    await seed([
      {
        sourceRef: "partial",
        versions: [
          { sourceVersion: "v1", retiredAt: "2026-01-01T00:00:00.000Z", payloadCollectedAt: "2026-02-01T00:00:00.000Z" },
          { sourceVersion: "v2", retiredAt: null, payloadCollectedAt: null },
        ],
      },
    ]);

    const verdict = await guardCandidateSources(client, ["partial"]);
    expect(verdict).toEqual({ served: true, dropped: [] });
  });

  it("keeps a retired-but-uncollected source visible, because retirement is not collection", async () => {
    await seed([
      { sourceRef: "retiredonly", versions: [{ sourceVersion: "v1", retiredAt: "2026-01-01T00:00:00.000Z", payloadCollectedAt: null }] },
    ]);

    expect(await guardCandidateSources(client, ["retiredonly"])).toEqual({
      served: true,
      dropped: [],
    });
  });

  it("refuses a source with no version row at all, the fail-closed direction", async () => {
    const verdict = await guardCandidateSources(client, ["never-registered"]);
    expect(verdict.served).toBe(false);
    if (verdict.served) return;
    expect(verdict.code).toBe("maintenance_status_unavailable");
    expect(verdict.detail).toContain("no lifecycle state");
  });

  it("drops a withdrawn source whose payload was never collected", async () => {
    // `withdraw()` sets `structured_publication_sources.active = false` and
    // never touches `source_versions`, so an un-collected withdrawn source is
    // indistinguishable from a live one to a payload-only predicate.
    await seed([
      {
        sourceRef: "withdrawn",
        active: false,
        versions: [{ sourceVersion: "v1", retiredAt: null, payloadCollectedAt: null }],
      },
    ]);

    const facts = await readSourceLifecycleFacts(client, ["withdrawn"]);
    expect(facts?.get("withdrawn")?.payloadCollectedAt).toBeNull();
    expect(facts?.get("withdrawn")?.active).toBe(false);

    const verdict = await guardCandidateSources(client, ["withdrawn"]);
    expect(verdict.served).toBe(true);
    if (!verdict.served) return;
    expect(verdict.dropped).toEqual(["withdrawn"]);
  });

  it("reports an ingested-but-unpublished source as active, because it is not withdrawn", async () => {
    await seed([
      {
        sourceRef: "ingested",
        versions: [{ sourceVersion: "v1", retiredAt: null, payloadCollectedAt: null }],
      },
    ]);

    const facts = await readSourceLifecycleFacts(client, ["ingested"]);
    // No `structured_publication_sources` row exists, so withdrawal cannot apply
    // — the polarity that keeps a source with chunks but no publication row
    // serving rather than fail-closing every unpublished source.
    expect(facts?.get("ingested")?.active).toBe(true);
    expect(await guardCandidateSources(client, ["ingested"])).toEqual({
      served: true,
      dropped: [],
    });
  });

  it("agrees with the memory lane on the facts it derives from the same rows", async () => {
    // Cross-lane assertion. `max(sv.retired_at)` and "the first non-null
    // retiredAt" are different aggregations, so the twin's fidelity is a
    // property that has to be asserted rather than assumed.
    const versions = [
      { sourceVersion: "v1", retiredAt: "2026-01-01T00:00:00.000Z", payloadCollectedAt: "2026-02-01T00:00:00.000Z" },
      { sourceVersion: "v2", retiredAt: "2026-03-01T00:00:00.000Z", payloadCollectedAt: null },
    ];
    await seed([{ sourceRef: "crosslane", versions, active: true }]);

    const pgFacts = await readSourceLifecycleFacts(client, ["crosslane"]);
    // Seeded oldest-first so a "first non-null retiredAt" read answers
    // 2026-01-01 while `max(sv.retired_at)` answers 2026-03-01. Seeding it the
    // other way round would make the two agree by luck and assert nothing.
    const memoryFacts = new MemoryServingGuard([
      { sourceRef: "crosslane", retiredAt: versions[0]!.retiredAt, payloadCollectedAt: versions[0]!.payloadCollectedAt },
      { sourceRef: "crosslane", retiredAt: versions[1]!.retiredAt, payloadCollectedAt: versions[1]!.payloadCollectedAt },
    ]).factsFor(["crosslane"]);

    expect(memoryFacts).toEqual(pgFacts);
  });

  it("returns a live chunk, and refuses the purged and withdrawn ones, through the real vector query", async () => {
    // The clause itself. Until this case existed, every acceptance test read
    // lifecycle facts through the guard's own helper, so the suite passed even
    // with the SQL completely wrong — and `SERVING_GUARD_CLAUSE` is the only
    // artifact here that changes what production serves.
    await seed([
      { sourceRef: "vector-live", active: true, versions: [{ sourceVersion: "v1", retiredAt: null, payloadCollectedAt: null }] },
      {
        sourceRef: "vector-purged",
        active: true,
        versions: [
          { sourceVersion: "v1", retiredAt: "2026-01-01T00:00:00.000Z", payloadCollectedAt: "2026-02-01T00:00:00.000Z" },
          { sourceVersion: "v2", retiredAt: null, payloadCollectedAt: "2026-02-02T00:00:00.000Z" },
        ],
      },
      { sourceRef: "vector-withdrawn", active: false, versions: [{ sourceVersion: "v1", retiredAt: null, payloadCollectedAt: null }] },
    ]);
    await seedChunk("vector-live");
    await seedChunk("vector-purged");
    await seedChunk("vector-withdrawn");

    const served = await servedSourceRefs();
    expect(served).toContain("vector-live");
    expect(served).not.toContain("vector-purged");
    expect(served).not.toContain("vector-withdrawn");
  });

  it("keeps an ingested-but-unpublished source serving through the real vector query", async () => {
    // The regression `NOT EXISTS (withdrawn)` polarity exists to prevent:
    // `AND EXISTS (SELECT 1 ... active)` would have fail-closed every source
    // that was ingested before it was ever published.
    await seed([
      { sourceRef: "vector-ingested", versions: [{ sourceVersion: "v1", retiredAt: null, payloadCollectedAt: null }] },
    ]);
    await seedChunk("vector-ingested");

    expect(await servedSourceRefs()).toContain("vector-ingested");
  });

  it("refuses a chunk whose source has no version row at all, the fail-closed direction", async () => {
    // The other half of the polarity: withdrawal is blocked by NOT EXISTS, but a
    // source the store cannot account for must still fail closed.
    await publish("vector-unknown", true);
    await seedChunk("vector-unknown");

    expect(await servedSourceRefs()).not.toContain("vector-unknown");
  });

  it("reports an unreadable lifecycle as unavailable rather than as everything-dead", async () => {
    const broken = {
      query: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    };
    // The distinction that matters: an empty map would read as "every source is
    // purged" and silently serve nothing; null reads as "nothing is known".
    const facts = await readSourceLifecycleFacts(broken, ["a"]);
    expect(facts).toBeNull();
    const verdict = await guardCandidateSources(broken, ["a"]);
    expect(verdict.served).toBe(false);
    if (verdict.served) return;
    expect(verdict.code).toBe("maintenance_status_unavailable");
  });
});

afterAll(async () => {
  try {
    if (admin !== undefined) await pgHarness.dropSchema(admin);
  } finally {
    await client?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  }
});
