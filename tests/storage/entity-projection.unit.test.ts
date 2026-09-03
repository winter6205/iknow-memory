/**
 * Entity projection — T5 SSOT (specs/es-precision-layer.md §SC-10,
 * plans/es-precision-layer.md T5, docs/runbooks/es-precision-layer.md).
 *
 * The precision layer's entity index mirrors Postgres, but the canonical
 * name + alias projection is the single read shape both the extract CLI
 * (per-chunk) and the es-reindex CLI (full sweep) MUST agree on. Any
 * divergence here becomes a stale-entity class of bug — a lexical seed
 * lookup that resolves to a row the ledger no longer answers for.
 *
 * The tests below drive the SQL through an in-memory fake and assert
 * (a) the column set + WHERE clause the helper emits, (b) the row shape
 * the precision layer sees, and (c) the alias de-duplication rule that
 * prevents a multi-merge survivor from being indexed twice under the
 * same surface form.
 */
import { describe, expect, it } from "vitest";

import {
  ENTITY_PROJECTION_PAGE_SQL,
  fetchEntityProjection,
  fetchEntityProjectionPage,
  projectEntityIndexRecords,
  type EntityProjectionPageRow,
} from "../../src/core/storage/entity-projection.js";

interface CapturedQuery {
  text: string;
  values: unknown[];
}

class FakeClient {
  /** Either pre-set the next response or override per-query via rowsOverride. */
  rowsOverride: unknown[] = [];
  captured: CapturedQuery[] = [];

  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.captured.push({ text, values: values ?? [] });
    return { rows: this.rowsOverride };
  }
}

describe("ENTITY_PROJECTION_PAGE_SQL", () => {
  it("filters retired AND merged-away rows, joins the full alias set", () => {
    // The string is a contract: the where-clause and the LEFT JOIN are
    // the single point where "live entity + all aliases" is decided.
    // Both tombstone kinds are excluded — a soft-merge loser the extract
    // CLI deleted from the index must not be resurrected by a reindex.
    expect(ENTITY_PROJECTION_PAGE_SQL).toContain("FROM entities e");
    expect(ENTITY_PROJECTION_PAGE_SQL).toContain(
      "LEFT JOIN entity_aliases a ON a.entity_id = e.id"
    );
    expect(ENTITY_PROJECTION_PAGE_SQL).toContain("e.retired = false");
    expect(ENTITY_PROJECTION_PAGE_SQL).toContain("e.merged_into IS NULL");
    expect(ENTITY_PROJECTION_PAGE_SQL).toContain("array_agg(a.alias)");
    expect(ENTITY_PROJECTION_PAGE_SQL).toContain("ORDER BY e.id");
  });
});

describe("fetchEntityProjectionPage", () => {
  it("returns the projected row set with the full alias list", async () => {
    const client = new FakeClient();
    client.rowsOverride = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        canonical_name: "Alice Smith",
        type: "person",
        retired: false,
        aliases: ["Alice", "Al", "alice@corp"],
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        canonical_name: "Acme",
        type: "system",
        retired: false,
        aliases: [],
      },
    ];

    const rows = await fetchEntityProjectionPage(
      client,
      "00000000-0000-0000-0000-000000000000",
      50
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.canonical_name).toBe("Alice Smith");
    expect(rows[0]?.aliases).toEqual(["Alice", "Al", "alice@corp"]);
    expect(rows[1]?.aliases).toEqual([]);
    expect(client.captured[0]?.values).toEqual([
      "00000000-0000-0000-0000-000000000000",
      50,
    ]);
  });

  it("coerces driver-typed columns into the documented page-row shape", async () => {
    const client = new FakeClient();
    client.rowsOverride = [
      {
        id: "id-1",
        canonical_name: "name-1",
        type: "person",
        retired: false,
        aliases: ["a"],
      },
    ];

    const rows = await fetchEntityProjectionPage(client, "0", 10);

    const row0 = rows[0];
    if (row0 === undefined) throw new Error("expected row 0");
    expect(typeof row0.id).toBe("string");
    expect(typeof row0.canonical_name).toBe("string");
    expect(typeof row0.type).toBe("string");
    expect(typeof row0.retired).toBe("boolean");
    expect(Array.isArray(row0.aliases)).toBe(true);
  });
});

describe("projectEntityIndexRecords", () => {
  it("de-duplicates aliases so two surface forms do not appear twice in the index", () => {
    const rows: EntityProjectionPageRow[] = [
      {
        id: "id-1",
        canonical_name: "Alice",
        type: "person",
        retired: false,
        aliases: ["Alice", "Alice", "Al"],
      },
    ];

    const records = projectEntityIndexRecords(rows);

    expect(records[0]?.aliases).toEqual(["Alice", "Al"]);
  });

  it("always carries the FULL alias set, never a single-alias overwrite", () => {
    // The bug class this guards against: an alias row added by a later
    // merge must not silently replace the historical aliases; the
    // precision-layer doc is rebuilt from PG every time so the merged
    // set is the source of truth.
    const rows: EntityProjectionPageRow[] = [
      {
        id: "id-1",
        canonical_name: "Alice",
        type: "person",
        retired: false,
        aliases: ["canonical-A", "variant-B", "variant-C"],
      },
    ];

    const records = projectEntityIndexRecords(rows);

    expect(records[0]?.canonical_name).toBe("Alice");
    expect(records[0]?.aliases).toHaveLength(3);
    expect(records[0]?.aliases).toEqual(
      expect.arrayContaining(["canonical-A", "variant-B", "variant-C"])
    );
  });

  it("carries the retired flag so the bulk write can mark tombstones inactive", () => {
    const records = projectEntityIndexRecords([
      {
        id: "id-1",
        canonical_name: "Old",
        type: "person",
        retired: true,
        aliases: [],
      },
    ]);

    expect(records[0]?.retired).toBe(true);
  });
});

describe("fetchEntityProjection", () => {
  it("returns an empty array when given no ids (no SQL is issued)", async () => {
    const client = new FakeClient();
    const records = await fetchEntityProjection(client, []);
    expect(records).toEqual([]);
    expect(client.captured).toEqual([]);
  });

  it("binds the id array as a uuid[] so Postgres can ANY-compare", async () => {
    const client = new FakeClient();
    client.rowsOverride = [
      {
        id: "id-1",
        canonical_name: "Alice",
        type: "person",
        retired: false,
        aliases: ["Al"],
      },
    ];

    const records = await fetchEntityProjection(client, ["id-1", "id-2"]);

    expect(records).toHaveLength(1);
    expect(client.captured[0]?.text).toContain("$1::uuid[]");
    expect(client.captured[0]?.values).toEqual([["id-1", "id-2"]]);
  });

  it("de-duplicates aliases and returns the canonical name", async () => {
    const client = new FakeClient();
    client.rowsOverride = [
      {
        id: "id-1",
        canonical_name: "Alice Smith",
        type: "person",
        retired: false,
        aliases: ["Alice Smith", "Alice", "Alice Smith"],
      },
    ];

    const records = await fetchEntityProjection(client, ["id-1"]);

    expect(records[0]?.canonical_name).toBe("Alice Smith");
    expect(records[0]?.aliases).toEqual(["Alice Smith", "Alice"]);
  });

  it("excludes merged-away rows from the per-id projection (same live rule as the rebuild sweep)", async () => {
    const client = new FakeClient();
    const records = await fetchEntityProjection(client, ["id-1"]);

    expect(records).toEqual([]);
    // The per-id read carries BOTH tombstone filters so the chunk-time
    // projection and the full rebuild sweep can never disagree on what
    // is live.
    expect(client.captured[0]?.text).toContain("e.retired = false");
    expect(client.captured[0]?.text).toContain("e.merged_into IS NULL");
  });
});
