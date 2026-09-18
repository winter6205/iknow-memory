/**
 * Unit tests for the standard post-merge enrichment half of T3
 * (`src/core/extraction/enrich.ts`) — entity description summarization
 * (ADR 0069) + claim extraction (ADR 0071), run after canonical merge and
 * before the projection outbox emit / Leiden (specs/graph-index-standard-fast.md).
 *
 * No live Postgres and no live LLM: a FakeQueryable records SQL text +
 * bind values, and the enrichment LLM surface is driven by FakeLLMClient
 * queues / scripted fakes (the Fake/no-live-GDS harness rule of the spec).
 *
 * Boundary classes covered here (input-contract-tests, 5 classes):
 *   - normal: merged survivors get one summarized description + claims land
 *   - empty: zero survivors → zero LLM calls, zero queries
 *   - negative/miss: one describe miss skips that entity, never the chunk;
 *     a failed claims call leaves the previous per-chunk rows untouched
 *   - repeat/idempotency: a second run re-states the chunk's claims
 *     (DELETE before every successful INSERT batch)
 *   - exception: a THROWING enrichment client is sealed into a skipped
 *     count — no UPDATE/DELETE/INSERT is emitted for that leg
 *   - capability absence: an LLM client without the optional enrichment
 *     methods runs the standard chunk with zero enrichment writes (fast T4
 *     and the existing no-enrichment tests share this leg)
 */
import { describe, it, expect, vi } from "vitest";

import type { Queryable } from "../../src/core/extraction/records.js";
import {
  enrichStandardChunk,
  LLM_EXCEPTION_ENRICH_CODE,
  type SurvivorRef,
} from "../../src/core/extraction/enrich.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import type { Logger } from "../../src/logging.js";

/** Recording fake Queryable; rows are chosen per SQL text (and binds). */
class FakeQueryable implements Queryable {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  rowsFor: (text: string, values: unknown[]) => any[] = () => [];

  async query(text: string, values: unknown[] = []) {
    this.queries.push(text);
    this.valuesList.push(values);
    return { rows: this.rowsFor(text, values) };
  }

  /** Index of the first query containing `fragment`, or -1. */
  indexOf(fragment: string): number {
    return this.queries.findIndex((q) => q.includes(fragment));
  }

  /** Indexes of every query containing `fragment`. */
  indexesOf(fragment: string): number[] {
    const out: number[] = [];
    this.queries.forEach((q, i) => {
      if (q.includes(fragment)) out.push(i);
    });
    return out;
  }
}

const SILENT_LOGGER: Logger = {
  level: "error",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CHUNK = { id: "chunk-1", content: "Alice works at Acme since 2024." };

const SURVIVORS: SurvivorRef[] = [
  { entityId: "e1", canonicalName: "Alice", description: "Alice works at Acme." },
  { entityId: "e1", canonicalName: "Alice", description: "Alice leads the Acme team." },
  { entityId: "e2", canonicalName: "Acme", description: "Acme employs Alice." },
];

function makeDeps(llm: FakeLLMClient) {
  return { llm, logger: SILENT_LOGGER };
}

/** FakeLLMClient that carries the enrichment methods the pipeline sees. */
function makeEnrichLLM(opts: {
  describeQueue?: any[];
  claimsQueue?: any[];
  scriptedDescribe?: any;
  scriptedClaims?: any;
}) {
  return new FakeLLMClient({
    // extract() is never called by enrichStandardChunk, but the base fake
    // still requires one mode; an empty queue turns any misuse into a
    // loud "queue exhausted" throw.
    queue: [],
    ...opts,
  });
}

describe("enrichStandardChunk — entity description (ADR 0069)", () => {
  it("summarizes each survivor's merged description list and UPDATEs the survivor row", async () => {
    const client = new FakeQueryable();
    const scriptedDescribe = vi.fn(async (input: any) => ({
      kind: "ok",
      descriptions: input.entities.map((e: any) => ({
        canonicalName: e.canonicalName,
        description: `summary of ${e.canonicalName}`,
      })),
    }));
    const llm = makeEnrichLLM({ scriptedDescribe });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    // One grouped call per survivor — the duplicate Alice description
    // collapses into one entity with two (distinct) descriptions.
    expect(scriptedDescribe).toHaveBeenCalledTimes(1);
    const input = scriptedDescribe.mock.calls[0]![0];
    const byName = new Map(
      input.entities.map((e: any) => [e.canonicalName, e.descriptions])
    );
    expect([...byName.keys()].sort()).toEqual(["Acme", "Alice"]);
    expect(byName.get("Alice")).toEqual([
      "Alice works at Acme.",
      "Alice leads the Acme team.",
    ]);

    expect(counts.described).toBe(2);
    expect(counts.describeSkipped).toBe(0);
    // One UPDATE per survivor id — never a per-description UPDATE.
    const updates = client.indexesOf("UPDATE entities");
    expect(updates).toHaveLength(2);
    expect(client.valuesList[updates[0]!]![1]).toBe("summary of Acme");
    expect(client.valuesList[updates[1]!]![1]).toBe("summary of Alice");
  });

  it("prepends the survivor's stored description to the summarize input", async () => {
    const client = new FakeQueryable();
    client.rowsFor = (text) =>
      text.includes("coalesce(metadata->>'description'")
        ? [{ id: "e2", description: "Acme Corporation, founded 1994." }]
        : [];
    const scriptedDescribe = vi.fn(async () => ({
      kind: "ok",
      descriptions: [],
    }));
    const llm = makeEnrichLLM({ scriptedDescribe });

    await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    const input = scriptedDescribe.mock.calls[0]![0];
    const acme = input.entities.find((e: any) => e.canonicalName === "Acme");
    expect(acme.descriptions).toEqual([
      "Acme Corporation, founded 1994.",
      "Acme employs Alice.",
    ]);
  });

  it("one describe miss skips that entity, never the whole run", async () => {
    const client = new FakeQueryable();
    // The response only carries Alice — Acme's summary is missing.
    const llm = makeEnrichLLM({
      describeQueue: [
        {
          kind: "ok",
          descriptions: [
            { canonicalName: "Alice", description: "Alice is an Acme engineer." },
          ],
        },
      ],
    });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts.described).toBe(1);
    expect(counts.describeSkipped).toBe(1);
    const updates = client.indexesOf("UPDATE entities");
    expect(updates).toHaveLength(1);
    expect(client.valuesList[updates[0]!]).toEqual([
      "e1",
      "Alice is an Acme engineer.",
    ]);
  });

  it("a failed describe response skips every survivor without writing", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM({
      describeQueue: [{ kind: "failed", errorCode: "5xx", errorMsg: "boom" }],
    });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts.described).toBe(0);
    expect(counts.describeSkipped).toBe(2);
    expect(client.indexOf("UPDATE entities")).toBe(-1);
  });

  it("a THROWING describe client is sealed into the skip count (exception class)", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM({
      scriptedDescribe: async () => {
        throw new Error("socket hang up");
      },
    });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts.described).toBe(0);
    expect(counts.describeSkipped).toBe(2);
    expect(client.indexOf("UPDATE entities")).toBe(-1);
    // The seal code is the shared LLM-exception code, never a bare rethrow.
    expect(counts.lastDescribeErrorCode).toBe(LLM_EXCEPTION_ENRICH_CODE);
  });
});

describe("enrichStandardChunk — claims (ADR 0071)", () => {
  const CLAIMS_OK = {
    kind: "ok",
    claims: [
      {
        entity: "Alice",
        claim: "Alice works at Acme since 2024.",
        validFrom: "2024-01-15",
        validTo: null,
        confidence: 0.9,
        evidenceSpan: "Alice works at Acme",
      },
      {
        entity: "Ghost Corp",
        claim: "unmapped entity never lands",
        validFrom: null,
        validTo: null,
        confidence: 0.5,
        evidenceSpan: "",
      },
    ],
  };

  it("maps claims onto survivor ids: DELETE-then-INSERT inside the run", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM({ claimsQueue: [CLAIMS_OK] });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts.claimsWritten).toBe(1);
    expect(counts.claimsSkipped).toBe(1);

    const del = client.indexOf("DELETE FROM claims");
    const ins = client.indexOf("INSERT INTO claims");
    expect(del).toBeGreaterThanOrEqual(0);
    expect(ins).toBeGreaterThan(del);

    const values = client.valuesList[ins]!;
    expect(values).toContain("e1"); // survivor id from the name map
    expect(values).toContain("chunk-1");
    expect(values).toContain("Alice works at Acme since 2024.");
    // Date-only bounds normalize to ISO instants; open upper stays NULL.
    expect(values).toContain("2024-01-15T00:00:00.000Z");
    expect(values).toContain(0.9);
    expect(values).toContain("Alice works at Acme");
    expect(values).toContain("llm");
  });

  it("a repeat run re-states the chunk's claims (idempotent replace)", async () => {
    const client = new FakeQueryable();
    const deps = makeDeps(
      makeEnrichLLM({ claimsQueue: [CLAIMS_OK, CLAIMS_OK] })
    );

    await enrichStandardChunk(deps, client, CHUNK, SURVIVORS, "2026-01-01T00:00:00.000Z");
    const first = client.queries.length;
    await enrichStandardChunk(
      { ...deps, llm: makeEnrichLLM({ claimsQueue: [CLAIMS_OK] }) },
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    // Second run: exactly one DELETE then one INSERT again — the per-chunk
    // replace keeps the row set a pure function of the latest extraction.
    const dels = client
      .indexesOf("DELETE FROM claims")
      .filter((i) => i >= first);
    const inserts = client
      .indexesOf("INSERT INTO claims")
      .filter((i) => i >= first);
    expect(dels).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!).toBeGreaterThan(dels[0]!);
  });

  it("claims that invert their validity window are skipped row-by-row", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM({
      claimsQueue: [
        {
          kind: "ok",
          claims: [
            {
              entity: "Alice",
              claim: "inverted window",
              validFrom: "2025-06-01",
              validTo: "2024-01-01",
              confidence: 0.7,
              evidenceSpan: "",
            },
          ],
        },
      ],
    });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts.claimsWritten).toBe(0);
    expect(counts.claimsSkipped).toBe(1);
    // The replace still ran (successful call), no row INSERTed.
    expect(client.indexOf("DELETE FROM claims")).toBeGreaterThanOrEqual(0);
    expect(client.indexOf("INSERT INTO claims")).toBe(-1);
  });

  it("a successful zero-claim response replaces the chunk's rows with none", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM({ claimsQueue: [{ kind: "ok", claims: [] }] });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts.claimsWritten).toBe(0);
    expect(client.indexOf("DELETE FROM claims")).toBeGreaterThanOrEqual(0);
    expect(client.indexOf("INSERT INTO claims")).toBe(-1);
  });

  it("a failed claims call never deletes the previous per-chunk rows", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM({
      claimsQueue: [
        { kind: "failed", errorCode: "format", errorMsg: "bad json" },
      ],
    });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts.claimsWritten).toBe(0);
    expect(client.indexOf("DELETE FROM claims")).toBe(-1);
    expect(client.indexOf("INSERT INTO claims")).toBe(-1);
    expect(counts.lastClaimsErrorCode).toBe("format");
  });

  it("a THROWING claims client is sealed with the LLM_EXCEPTION code", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM({
      scriptedClaims: async () => {
        throw new Error("aborted");
      },
    });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts.claimsWritten).toBe(0);
    expect(counts.lastClaimsErrorCode).toBe(LLM_EXCEPTION_ENRICH_CODE);
    expect(client.indexOf("DELETE FROM claims")).toBe(-1);
  });

  it("unparseable dates fall back to the run window instead of rejecting the row", async () => {
    const client = new FakeQueryable();
    const llm = makeEnrichLLM({
      claimsQueue: [
        {
          kind: "ok",
          claims: [
            {
              entity: "Alice",
              claim: "dateless assertion",
              validFrom: "sometime last year",
              validTo: "???",
              confidence: 0.6,
              evidenceSpan: "",
            },
          ],
        },
      ],
    });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts.claimsWritten).toBe(1);
    const values = client.valuesList[client.indexOf("INSERT INTO claims")]!;
    // Garbage bounds collapse to [startedAt, NULL) — same open-leg
    // convention as triples.valid_window.
    expect(values).toContain("2026-01-01T00:00:00.000Z");
    expect(values[5]).toBeNull();
  });
});

describe("enrichStandardChunk — empty / capability legs", () => {
  it("zero survivors run no queries and dial no LLM (empty class)", async () => {
    const client = new FakeQueryable();
    const scriptedDescribe = vi.fn();
    const scriptedClaims = vi.fn();
    const llm = makeEnrichLLM({ scriptedDescribe, scriptedClaims });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      [],
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts).toMatchObject({
      described: 0,
      describeSkipped: 0,
      claimsWritten: 0,
      claimsSkipped: 0,
    });
    expect(client.queries).toHaveLength(0);
    expect(scriptedDescribe).not.toHaveBeenCalled();
    expect(scriptedClaims).not.toHaveBeenCalled();
  });

  it("survivors whose descriptions are all empty are dropped and dial nothing", async () => {
    const client = new FakeQueryable();
    const scriptedClaims = vi.fn();
    const scriptedDescribe = vi.fn();
    const llm = makeEnrichLLM({ scriptedDescribe, scriptedClaims });

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      [
        { entityId: "e9", canonicalName: "Blank", description: "" },
        { entityId: "e9", canonicalName: "Blank", description: "   " },
      ],
      "2026-01-01T00:00:00.000Z"
    );

    // A survivor with no usable description list is dropped entirely — with
    // every survivor dropped the run collapses to the zero-survivor leg:
    // no queries, no LLM call.
    expect(counts).toMatchObject({
      described: 0,
      describeSkipped: 0,
      claimsWritten: 0,
      claimsSkipped: 0,
    });
    expect(client.queries).toHaveLength(0);
    expect(scriptedDescribe).not.toHaveBeenCalled();
    expect(scriptedClaims).not.toHaveBeenCalled();
  });

  it("an LLM client without the enrichment methods writes nothing (capability absent)", async () => {
    const client = new FakeQueryable();
    const llm = new FakeLLMClient({ queue: [] });
    expect(llm.describeEntities).toBeUndefined();
    expect(llm.extractClaims).toBeUndefined();

    const counts = await enrichStandardChunk(
      makeDeps(llm),
      client,
      CHUNK,
      SURVIVORS,
      "2026-01-01T00:00:00.000Z"
    );

    expect(counts.described).toBe(0);
    expect(counts.claimsWritten).toBe(0);
    expect(client.indexOf("UPDATE entities")).toBe(-1);
    expect(client.indexOf("INSERT INTO claims")).toBe(-1);
  });
});
