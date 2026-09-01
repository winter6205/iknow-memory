/**
 * extract-merged-into-pg: SC6 of `specs/retrieve-graph-quality.md` — slice 4 of
 * the soft-merge persistence contract (Q-T5).
 *
 *   SC6: Merge survivor/loser → loser row has `merged_into` = survivor;
 *        second extract is idempotent on that pointer.
 *
 * The CLI integration in `extract-persist-pg.test.ts` (SC9/T5) already proves
 * the end-to-end story: chunk 1 creates a survivor, chunk 2 merges through L3
 * and materializes a loser, chunk 3 re-extracts the same surface form and no
 * second loser row appears. This file targets the *persistence primitive*
 * directly so the WHERE-clause idempotency guard is pinned to real Postgres
 * rows (not inferred from a no-op at the CLI level):
 *
 *   - L3 merge persists `merged_into` via `linkMergedEntity`.
 *   - A second `linkMergedEntity` call with the SAME survivor is a no-op.
 *   - A second call with a DIFFERENT survivor is also a no-op — the pointer
 *     is permanent for this round by design (the WHERE-clause guard).
 *   - `resolveCanonicalId` walks a multi-hop `merged_into` chain against
 *     real rows to the head.
 *
 * Isolation: the per-file schema is dropped on teardown so this suite cannot
 * race extract-persist-pg's parallel worker over `public.entities`. Postgres
 * unavailability triggers the standard loud-skip (describe.skip + Validation
 * block) per `docs/.claude/rules/test.md`.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { linkMergedEntity } from "../../src/cli/extract.js";
import { resolveCanonicalId } from "../../src/core/entities/resolve.js";
import { upSchemaP0 } from "../../src/core/storage/schema-p0.js";
import { warnPgUnavailable } from "./pg-test-harness.js";

/** Embedding width for the entities.embedding column; mirrors the suite scope. */
const DIM = 256;

const BASE_DB_URL = "postgresql://postgres@localhost/postgres";
const SCHEMA = `extract_merged_into_${randomUUID().slice(0, 8)}`;

// Loud skip when Postgres is unreachable (describe.skip + Validation block).
let PG_AVAILABLE = false;
try {
  const probe = new pg.Client({ connectionString: BASE_DB_URL });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  PG_AVAILABLE = true;
} catch (err) {
  warnPgUnavailable({
    label: "extract-merged-into-pg",
    testPath: "tests/integration/extract-merged-into-pg.test.ts",
    expectedCommand:
      "npx vitest run tests/integration/extract-merged-into-pg.test.ts",
    connectionString: BASE_DB_URL,
    error: err,
    requiresVector: false,
  });
}
const describePg = PG_AVAILABLE ? describe : describe.skip;

describePg(
  "extract-merged-into-pg: SC6 merged_into persistence + idempotency (Q-T5)",
  () => {
    let client: pg.Client | undefined;

    beforeAll(async () => {
      if (!PG_AVAILABLE) return;
      client = new pg.Client({ connectionString: BASE_DB_URL });
      await client.connect();
      // The entities.embedding vector(N) column needs the pgvector extension
      // in the default `public` schema; per-test search_path resolves back here.
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await resetSchema(client);
    });

    afterAll(async () => {
      if (client) {
        await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await client.end();
      }
    });

    /**
     * Recreate the isolated schema with the production DDL. Each test resets
     * to a clean slate so the idempotency assertions are not contaminated by
     * leftover rows from a previous test.
     */
    async function resetSchema(c: pg.Client): Promise<void> {
      await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await c.query(`CREATE SCHEMA "${SCHEMA}"`);
      await c.query(`SET search_path TO "${SCHEMA}", public`);
      await upSchemaP0(c, DIM, 2000);
    }

    /**
     * Insert one entity row directly. `embedding` is left NULL — these tests
     * exercise the persistence primitive, not the embedding path, and the
     * column is nullable per the DDL.
     */
    async function insertEntityRow(
      c: pg.Client,
      canonicalName: string,
      type: string
    ): Promise<string> {
      const id = randomUUID();
      await c.query(
        `INSERT INTO entities (id, canonical_name, type) VALUES ($1, $2, $3)`,
        [id, canonicalName, type]
      );
      return id;
    }

    /** Read just the `merged_into` pointer for one row. */
    async function readMergedInto(
      c: pg.Client,
      id: string
    ): Promise<string | null> {
      const { rows } = await c.query<{ merged_into: string | null }>(
        `SELECT merged_into FROM entities WHERE id = $1`,
        [id]
      );
      return rows[0]?.merged_into ?? null;
    }

    // ---------------------------------------------------------------
    // SC6 (Q-T5): L3 merge persists merged_into = survivor via
    // linkMergedEntity. The survivor row stays unmerged (its own
    // merged_into column is NULL by design).
    // ---------------------------------------------------------------
    it("L3 merge persists merged_into = survivor via linkMergedEntity", async () => {
      const c = client!;
      await resetSchema(c);

      const survivorId = await insertEntityRow(c, "Alice Smith", "person");
      const loserId = await insertEntityRow(c, "Alicia Smith", "person");

      await linkMergedEntity(c, loserId, survivorId);

      expect(await readMergedInto(c, loserId)).toBe(survivorId);
      // The survivor's own pointer stays NULL — we never merge a survivor
      // into itself, so the WHERE merged_into IS NULL guard trivially holds.
      expect(await readMergedInto(c, survivorId)).toBeNull();
    });

    // ---------------------------------------------------------------
    // Idempotency: a SECOND linkMergedEntity call with the same
    // survivor is a no-op. The pointer is unchanged.
    // ---------------------------------------------------------------
    it("linkMergedEntity is idempotent on a repeat call with the same survivor", async () => {
      const c = client!;
      await resetSchema(c);

      const survivorId = await insertEntityRow(c, "Bob Jones", "person");
      const loserId = await insertEntityRow(c, "Robert Jones", "person");

      await linkMergedEntity(c, loserId, survivorId);
      expect(await readMergedInto(c, loserId)).toBe(survivorId);

      // Second call: same inputs. WHERE merged_into IS NULL no longer matches
      // (the row now has merged_into = survivorId), so UPDATE affects 0 rows
      // and the pointer stays as set on the first call.
      await linkMergedEntity(c, loserId, survivorId);
      expect(await readMergedInto(c, loserId)).toBe(survivorId);
    });

    // ---------------------------------------------------------------
    // Idempotency v2: a second call with a DIFFERENT survivor does NOT
    // flip the pointer. Once merged, the loser stays with its first
    // survivor for this round — re-merge to a new survivor would silently
    // rewrite a ledger row the extractor already committed, and SC6's
    // "permanent pointer for this round" invariant forbids it.
    // ---------------------------------------------------------------
    it("linkMergedEntity does NOT flip merged_into when re-called with a different survivor", async () => {
      const c = client!;
      await resetSchema(c);

      const originalSurvivorId = await insertEntityRow(
        c,
        "Charlie Brown",
        "person"
      );
      const newSurvivorId = await insertEntityRow(c, "Charles Brown", "person");
      const loserId = await insertEntityRow(c, "Chuck Brown", "person");

      await linkMergedEntity(c, loserId, originalSurvivorId);
      expect(await readMergedInto(c, loserId)).toBe(originalSurvivorId);

      // Attempt to re-link to a new survivor. Guard rejects the UPDATE.
      await linkMergedEntity(c, loserId, newSurvivorId);
      expect(await readMergedInto(c, loserId)).toBe(originalSurvivorId);
      expect(await readMergedInto(c, loserId)).not.toBe(newSurvivorId);
    });

    // ---------------------------------------------------------------
    // resolveCanonicalId is the production read path for the merged_into
    // chain. The test pins it to real rows (top -> mid -> head) so the
    // walker terminates at the head, where merged_into IS NULL.
    // ---------------------------------------------------------------
    it("resolveCanonicalId walks a multi-hop merged_into chain to the head", async () => {
      const c = client!;
      await resetSchema(c);

      // Chain: top -> mid -> head. head.merged_into IS NULL (the terminator).
      const headId = await insertEntityRow(c, "Head Entity", "person");
      const midId = await insertEntityRow(c, "Mid Entity", "person");
      const topId = await insertEntityRow(c, "Top Entity", "person");

      await linkMergedEntity(c, midId, headId);
      await linkMergedEntity(c, topId, midId);

      // Sanity: the SQL we wrote is the chain resolveCanonicalId will walk.
      expect(await readMergedInto(c, midId)).toBe(headId);
      expect(await readMergedInto(c, topId)).toBe(midId);
      expect(await readMergedInto(c, headId)).toBeNull();

      // Every starting point resolves to the same head.
      expect(await resolveCanonicalId(c, topId)).toBe(headId);
      expect(await resolveCanonicalId(c, midId)).toBe(headId);
      expect(await resolveCanonicalId(c, headId)).toBe(headId);
    });
  }
);
