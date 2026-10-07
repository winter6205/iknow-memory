/**
 * M13/M19 acceptance — the MP12 serving guard on the real boundary.
 *
 * The clause is a join between `chunks` and `source_versions`, and a join can be
 * syntactically fine and semantically wrong. Everything here runs against a real
 * PostgreSQL with real lifecycle rows, because the case that matters — a source
 * whose every version is collected while a sibling source stays live — is
 * exactly the one a mocked query would get right by accident.
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
import {
  guardCandidateSources,
  readSourceLifecycleFacts,
} from "../../src/core/storage/serving-guard-pg.js";

const EXPECTED_COMMAND =
  "MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-mp12-guards-pg.test.ts";
const REQUIRED = process.env.MAINTENANCE_ACCEPTANCE === "1";
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
}, 180_000);

interface SeedSource {
  readonly sourceRef: string;
  readonly versions: ReadonlyArray<{
    readonly sourceVersion: string;
    readonly retiredAt: string | null;
    readonly payloadCollectedAt: string | null;
  }>;
}

async function seed(sources: readonly SeedSource[]): Promise<void> {
  for (const source of sources) {
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
    // The case a naive aggregate gets wrong: two versions, one collected. A
    // `bool_and(payload_collected_at IS NULL)` is right; a per-row filter or a
    // `bool_and` over the wrong column would drop the live one too.
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
