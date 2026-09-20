/**
 * T3 regression, pg half — a batch carrying the same `source_ref` twice must
 * not answer with chunk ids whose rows it did not persist.
 *
 * The MemoryBackend half lives in tests/tools/push-duplicate-source-ref.test.ts.
 * This one runs the same input through the real `PgvectorBackend`, where the
 * pre-repair base failed LOUDLY (`duplicate key value violates unique
 * constraint "chunks_source_doc_id_ordinal_idx"`) and the per-envelope-write
 * repair turned that into a SILENT false success: 2 ids returned, 1 row
 * persisted. The assertion compares the response against what is actually
 * retrievable from Postgres — not the shape of the refusal — so it holds for
 * either fix shape (refuse or hoist).
 *
 * Skips loudly when Postgres is unavailable (tests/integration/pg-test-harness.ts).
 */
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeEmbedder } from "../../src/core/embedder.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createPushHandler } from "../../src/tools/push.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

const DIM = 8;
const pgHarness = await createPgIntegrationHarness({
  label: "push-duplicate-source-ref",
  testPath: "tests/integration/push-duplicate-source-ref-pg.test.ts",
  expectedCommand:
    "npx vitest run tests/integration/push-duplicate-source-ref-pg.test.ts",
  schemaPrefix: "push_dup_ref",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const { schemaConnectionString: SCHEMA_URL, describePg } = pgHarness;

function finItem(sourceRef: string, body: string): Record<string, unknown> {
  return {
    content: body,
    source_ref: sourceRef,
    chunks: [{ index: 0, content: body }],
    metadata: { fmt: "md", doc_type: "spec" },
    valid_from: "2024-01-01T00:00:00.000Z",
    valid_until: "9999-12-31T23:59:59.999Z",
  };
}

describePg(
  "push duplicate source_ref in one batch: live PgvectorBackend",
  () => {
    let client: pg.Client | undefined;
    let backend: PgvectorBackend | undefined;

    beforeAll(async () => {
      client = pgHarness.createClient(SCHEMA_URL);
      await client.connect();
      await pgHarness.resetSchema(client);
      backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
      await backend.initialize();
    });

    afterAll(async () => {
      if (backend) await backend.close();
      if (client) {
        await pgHarness.dropSchema(client);
        await client.end();
      }
    });

    it("never answers with ids whose rows it did not persist", async () => {
      const handler = createPushHandler({
        embedder: new FakeEmbedder(DIM),
        storage: backend!,
      });

      const outcome = await handler({
        items: [
          finItem("docs/pg-dup.md", "alpha body text"),
          finItem("docs/pg-dup.md", "beta body text"),
        ],
      })
        .then((result) => {
          const text = (result as ToolResult).content[0]?.text;
          if (typeof text !== "string") {
            throw new Error("expected text content in ToolResult");
          }
          const body = JSON.parse(text) as { chunk_ids?: string[] };
          return { refused: false as const, ids: body.chunk_ids ?? [] };
        })
        .catch(() => ({ refused: true as const }));

      const doc = await backend!.getSourceDoc("docs/pg-dup.md");
      if (outcome.refused) {
        expect(
          doc,
          "batch was refused, so no 资料 row may exist under that source_ref"
        ).toEqual({ ok: false, code: "NOT_FOUND" });
        return;
      }

      if (!doc.ok) throw new Error("expected source doc");
      const persisted = await backend!.listChunksBySourceDoc(doc.value.id);
      expect(
        [...outcome.ids].sort(),
        "returned chunk_ids must name exactly the rows that persisted in Postgres"
      ).toEqual(persisted.map((c) => c.id).sort());

      // The direct Postgres count is the ground truth the response has to
      // agree with: a chunk row whose id the response never named, or an id
      // the response named with no row behind it, both fail here.
      const count = await client!.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chunks WHERE source_doc_id = $1`,
        [doc.value.id]
      );
      expect(Number(count.rows[0]!.n)).toBe(outcome.ids.length);
    });

    it("accepts a same-ref re-push in a LATER call and rebuilds its rows", async () => {
      const handler = createPushHandler({
        embedder: new FakeEmbedder(DIM),
        storage: backend!,
      });
      await handler({
        items: [finItem("docs/pg-repush.md", "first body text")],
      });
      const second = await handler({
        items: [finItem("docs/pg-repush.md", "second body text")],
      });
      const text = (second as ToolResult).content[0]!.text!;
      const ids = (JSON.parse(text) as { chunk_ids: string[] }).chunk_ids;

      const doc = await backend!.getSourceDoc("docs/pg-repush.md");
      if (!doc.ok) throw new Error("expected source doc");
      const persisted = await backend!.listChunksBySourceDoc(doc.value.id);
      expect(persisted.map((c) => c.id).sort()).toEqual([...ids].sort());
      expect(persisted.map((c) => c.content)).toEqual(["second body text"]);
    });
  }
);
