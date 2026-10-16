/**
 * Persist-layer wiring of the gray-zone merge judge: `ExtractPersistDeps.mergeJudge`
 * travels into the merge context, and the three verdicts settle differently on
 * the ledger — merge writes `merged_into`, reject leaves two live entities,
 * human leaves two live entities AND surfaces the pair on `mergeHolds`.
 */
import { describe, it, expect } from "vitest";

import type { Logger } from "../../src/logging.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import {
  deriveMergeEmbedCap,
  persistOutputs,
} from "../../src/core/extraction/persist.js";
import {
  createMergeEmbedBudget,
  MergeBudgetUnarmedError,
  type MergeEmbedBudget,
} from "../../src/core/entities/merge-budget.js";
import type { Queryable } from "../../src/core/extraction/records.js";
import type { ExtractionOutput } from "../../src/core/extraction/types.js";
import type {
  GrayZoneJudge,
  GrayZoneJudgeInput,
  GrayZoneVerdict,
} from "../../src/core/entities/types.js";

const SILENT_LOGGER: Logger = {
  level: "error",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Distinct texts → orthogonal basis vectors; equal texts → cosine 1. */
class OrthogonalEmbedder implements EmbeddingClient {
  private readonly slots = new Map<string, number>();
  /** Requests issued, so a refusal can be shown to precede every one. */
  requests = 0;
  constructor(private readonly dimensions: number) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.requests += 1;
    return texts.map((text) => {
      if (!this.slots.has(text)) this.slots.set(text, this.slots.size);
      const vector = new Array<number>(this.dimensions).fill(0);
      vector[this.slots.get(text)! % this.dimensions] = 1;
      return vector;
    });
  }
}

interface EntityRow {
  id: string;
  canonical_name: string;
  type: string;
  embedding: string | null;
  description: string;
  merged_into: string | null;
  aliases: Array<{ alias: string; alias_type: string }>;
}

/**
 * Minimal ledger fake: entity SELECT/INSERT, alias INSERT, merged_into
 * UPDATE, and the no-row answers the triple upsert and generation reads
 * expect. Anything else throws so new SQL cannot hide behind a catch-all.
 */
class FakeLedger implements Queryable {
  entities: EntityRow[] = [];
  queries: Array<{ text: string; values: unknown[] }> = [];

  async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
    this.queries.push({ text, values });
    if (text.includes("FROM embedding_generation")) return { rows: [] };
    if (text.includes("FROM entities WHERE retired = false")) {
      return {
        rows: this.entities.map((e) => ({
          id: e.id,
          canonical_name: e.canonical_name,
          type: e.type,
          embedding: e.embedding,
          description: e.description,
        })),
      };
    }
    if (text.includes("SELECT merged_into FROM entities WHERE id = $1")) {
      const row = this.entities.find((e) => e.id === values[0]);
      return { rows: row ? [{ merged_into: row.merged_into }] : [] };
    }
    if (text.includes("INSERT INTO entities")) {
      const metadata = JSON.parse(values[4] as string) as {
        description?: string;
      };
      this.entities.push({
        id: values[0] as string,
        canonical_name: values[1] as string,
        type: values[2] as string,
        embedding: null,
        description: metadata.description ?? "",
        merged_into: null,
        aliases: [],
      });
      return { rows: [] };
    }
    if (text.includes("INSERT INTO entity_aliases")) {
      const row = this.entities.find((e) => e.id === values[1]);
      row?.aliases.push({
        alias: values[2] as string,
        alias_type: values[3] as string,
      });
      return { rows: [] };
    }
    if (text.includes("UPDATE entities SET merged_into")) {
      const row = this.entities.find((e) => e.id === values[0]);
      if (row && row.merged_into === null) row.merged_into = values[1] as string;
      return { rows: [] };
    }
    if (
      text.includes("FROM triples") ||
      text.includes("INSERT INTO triples") ||
      text.includes("UPDATE triples")
    ) {
      return { rows: [] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [] };
    throw new Error(`unexpected query: ${text}`);
  }

  mergedIntoWrites(): Array<{ text: string; values: unknown[] }> {
    return this.queries.filter((q) =>
      q.text.includes("UPDATE entities SET merged_into")
    );
  }
}

const SHARED_DESC =
  "Alice Smith works at Acme Corp on the billing platform";

const OUTPUT: ExtractionOutput = {
  head: "Alicia Smith",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "RELATED_TO",
  tail: "Acme Corp",
  tailType: "organization",
  description: SHARED_DESC,
  evidenceSpan: "Alice Smith works at Acme Corp",
  confidence: 0.9,
};

function seedAlice(ledger: FakeLedger): EntityRow {
  const row: EntityRow = {
    id: "alice-1",
    canonical_name: "Alice Smith",
    type: "person",
    embedding: null,
    description: SHARED_DESC,
    merged_into: null,
    aliases: [{ alias: "Alice Smith", alias_type: "name" }],
  };
  ledger.entities.push(row);
  return row;
}

function makeJudge(
  verdict: GrayZoneVerdict | "throw"
): { judge: GrayZoneJudge; inputs: GrayZoneJudgeInput[] } {
  const inputs: GrayZoneJudgeInput[] = [];
  const judge: GrayZoneJudge = async (input) => {
    inputs.push(input);
    if (verdict === "throw") throw new Error("judge down");
    return verdict;
  };
  return { judge, inputs };
}

/** A budget armed with the cap its single population implies (ADR-0013). */
function armedBudget(
  outputs: ExtractionOutput[] = [OUTPUT]
): MergeEmbedBudget {
  const mergeBudget = createMergeEmbedBudget();
  mergeBudget.arm(deriveMergeEmbedCap(outputs, 1).embedCap);
  return mergeBudget;
}

async function runPersist(
  ledger: FakeLedger,
  mergeJudge?: GrayZoneJudge,
  mergeBudget: MergeEmbedBudget = armedBudget()
) {
  const counts = await persistOutputs(
    {
      embedder: new OrthogonalEmbedder(8),
      logger: SILENT_LOGGER,
      now: () => "2026-01-01T00:00:00.000Z",
      mergeBudget,
      ...(mergeJudge ? { mergeJudge } : {}),
    },
    ledger,
    "chunk-1",
    "Alicia heard that Alice Smith works at Acme Corp this quarter.",
    [OUTPUT],
    "2026-01-01T00:00:00.000Z"
  );
  return { counts };
}

describe("persistOutputs — gray-zone merge judge verdicts", () => {
  it("no judge configured: gray pair leaves two live entities and no merged_into", async () => {
    const ledger = new FakeLedger();
    const alice = seedAlice(ledger);
    const { counts } = await runPersist(ledger);
    expect(ledger.mergedIntoWrites()).toHaveLength(0);
    expect(counts.mergeHolds).toEqual([]);
    const names = ledger.entities.map((e) => e.canonical_name);
    expect(names).toContain("Alice Smith");
    expect(names).toContain("Alicia Smith");
    expect(alice.merged_into).toBeNull();
  });

  it("judge merge verdict materializes the loser and writes merged_into", async () => {
    const ledger = new FakeLedger();
    seedAlice(ledger);
    const { judge, inputs } = makeJudge("merge");
    const { counts } = await runPersist(ledger, judge);
    expect(inputs).toHaveLength(1);
    const writes = ledger.mergedIntoWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values[1]).toBe("alice-1");
    expect(counts.mergedLoserIds).toHaveLength(1);
    expect(counts.mergeHolds).toEqual([]);
  });

  it("judge reject verdict keeps both entities live with no merged_into", async () => {
    const ledger = new FakeLedger();
    seedAlice(ledger);
    const { judge } = makeJudge("reject");
    const { counts } = await runPersist(ledger, judge);
    expect(ledger.mergedIntoWrites()).toHaveLength(0);
    expect(counts.mergeHolds).toEqual([]);
    expect(counts.mergedLoserIds).toEqual([]);
    const names = ledger.entities.map((e) => e.canonical_name);
    expect(names).toContain("Alice Smith");
    expect(names).toContain("Alicia Smith");
  });

  it("judge human verdict keeps both live and collects the pair into mergeHolds", async () => {
    const ledger = new FakeLedger();
    seedAlice(ledger);
    const { judge } = makeJudge("human");
    const { counts } = await runPersist(ledger, judge);
    expect(ledger.mergedIntoWrites()).toHaveLength(0);
    expect(counts.mergedLoserIds).toEqual([]);
    const incomingRow = ledger.entities.find(
      (e) => e.canonical_name === "Alicia Smith"
    );
    expect(incomingRow).toBeDefined();
    expect(incomingRow!.aliases).toEqual([
      { alias: "Alicia Smith", alias_type: "name" },
    ]);
    expect(counts.mergeHolds).toEqual([
      {
        incomingName: "Alicia Smith",
        incomingType: "person",
        candidateId: "alice-1",
        observedCosine: 0,
      },
    ]);
  });

  it("judge-down (throw) behaves exactly like reject: no merge, no hold", async () => {
    const ledger = new FakeLedger();
    seedAlice(ledger);
    const { judge, inputs } = makeJudge("throw");
    const { counts } = await runPersist(ledger, judge);
    expect(inputs).toHaveLength(1);
    expect(ledger.mergedIntoWrites()).toHaveLength(0);
    expect(counts.mergeHolds).toEqual([]);
  });
});

describe("persistOutputs — the merge embed budget is mandatory", () => {
  const CHUNK_CONTENT =
    "Alicia heard that Alice Smith works at Acme Corp this quarter.";

  it("counts one resolution for the gray pair this fixture reaches", async () => {
    // Guards the row below from passing vacuously: with the same inputs an
    // armed budget IS charged, so the unarmed refusal is a real gate.
    const ledger = new FakeLedger();
    seedAlice(ledger);
    const embedder = new OrthogonalEmbedder(8);
    const mergeBudget = createMergeEmbedBudget();
    mergeBudget.arm(deriveMergeEmbedCap([OUTPUT], 1).embedCap);
    await persistOutputs(
      {
        embedder,
        logger: SILENT_LOGGER,
        now: () => "2026-01-01T00:00:00.000Z",
        mergeBudget,
      },
      ledger,
      "chunk-1",
      CHUNK_CONTENT,
      [OUTPUT],
      "2026-01-01T00:00:00.000Z"
    );
    expect(embedder.requests).toBeGreaterThanOrEqual(1);
    // One resolution charged even though the gate issued several requests:
    // the counter counts resolutions, never raw calls (ADR-0013 Decision 2A).
    expect(mergeBudget.snapshot().embedCalls).toBe(1);
    expect(mergeBudget.snapshot().embedCalls).toBeLessThanOrEqual(
      embedder.requests
    );
  });

  it("throws the typed unarmed error before the first merge-gate resolution", async () => {
    const ledger = new FakeLedger();
    seedAlice(ledger);
    const embedder = new OrthogonalEmbedder(8);
    // Never armed: no caller can reach a merge with no declared cap.
    const mergeBudget = createMergeEmbedBudget();
    await expect(
      persistOutputs(
        {
          embedder,
          logger: SILENT_LOGGER,
          now: () => "2026-01-01T00:00:00.000Z",
          mergeBudget,
        },
        ledger,
        "chunk-1",
        CHUNK_CONTENT,
        [OUTPUT],
        "2026-01-01T00:00:00.000Z"
      )
    ).rejects.toBeInstanceOf(MergeBudgetUnarmedError);
    expect(embedder.requests).toBe(0);
    expect(ledger.mergedIntoWrites()).toEqual([]);
  });
});
