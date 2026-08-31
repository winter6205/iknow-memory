import { describe, expect, it } from "vitest";

import { GraphragError } from "../../src/core/errors.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import type {
  GraphArmStorage,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../../src/core/types.js";
import {
  createRetrieveHandler,
  InputValidationFailureCounter,
  RetrieveInputSchema,
} from "../../src/tools/retrieve.js";

const NOW = "2026-08-31T00:00:00.000Z";

const CFG: RetrieveConfig = {
  preset: "balanced",
  w_vec: 1,
  w_bm25: 1,
  w_graph: 1,
  bm25Enabled: true,
  graphEnabled: false,
  rerankEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  neighborWidth: 0,
  graphArmFloor: 3,
};

class FixedEmbedder implements EmbeddingClient {
  async embed(_texts: string[]): Promise<number[][]> {
    return [[1]];
  }
}

function retrieved(id: string): RetrievedChunk {
  return {
    id,
    content: `content-${id}`,
    source_ref: `source/${id}`,
    valid_window: [NOW, null],
    score: 1,
  };
}

class PartialFailureBackend implements StorageBackend {
  readonly graphArmSeed: GraphArmStorage = {
    seedEntitiesByEmbedding: async () => [],
    chunksByOneHopFromEntities: async () => [],
  };

  constructor(
    private readonly vectorFailure?: GraphragError,
    private readonly lexicalFailure?: GraphragError,
    private readonly lexicalHits: RetrievedChunk[] = []
  ) {}

  async upsert(_chunks: ChunkRecord[]): Promise<string[]> {
    return [];
  }

  async search(
    _embedding: number[],
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    if (this.vectorFailure !== undefined) throw this.vectorFailure;
    return [];
  }

  async searchLexical(
    _query: string,
    _opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    if (this.lexicalFailure !== undefined) throw this.lexicalFailure;
    return this.lexicalHits;
  }

  async close(): Promise<void> {}
}

describe("T9 partial-failure semantics", () => {
  it("releases successful lexical hits when the vector arm fails and marks only vector", async () => {
    const backend = new PartialFailureBackend(
      new GraphragError("vector store unavailable", "STORAGE_ERROR"),
      undefined,
      [retrieved("lexical-hit")]
    );

    const result = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder: new FixedEmbedder(),
        storage: backend,
        retrieveConfig: CFG,
      }
    );

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["lexical-hit"]);
    expect(result.degraded).toBe(true);
    expect(result.degraded_reasons).toEqual(["vector:attempted-and-failed"]);
  });

  it("returns a typed all-arms-failed error instead of an empty or partial result", async () => {
    const backend = new PartialFailureBackend(
      new GraphragError("vector store unavailable", "STORAGE_ERROR"),
      new GraphragError("lexical index unavailable", "STORAGE_ERROR")
    );

    const error = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder: new FixedEmbedder(),
        storage: backend,
        retrieveConfig: CFG,
      }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "STORAGE_ERROR" });
    expect((error as GraphragError).message).toMatch(
      /all retrieval arms failed.*vector.*bm25/
    );
  });

  it("treats vector failure with no graph hit as all arms failing", async () => {
    const backend = new PartialFailureBackend(
      new GraphragError("vector store unavailable", "STORAGE_ERROR")
    );

    const error = await assembleRetrievalResult(
      { query: "q", validAt: NOW, limit: 10 },
      {
        embedder: new FixedEmbedder(),
        storage: backend,
        graphConfig: { ...CFG, bm25Enabled: false },
      }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "STORAGE_ERROR" });
    expect((error as GraphragError).message).toMatch(
      /all retrieval arms failed.*vector/
    );
  });
});

describe("T9 invalid query versus legal empty result", () => {
  it("rejects whitespace input and distinguishes it from a legal empty result in one run", async () => {
    const counter = new InputValidationFailureCounter();
    const handler = createRetrieveHandler({
      embedder: new FixedEmbedder(),
      storage: new PartialFailureBackend(),
      inputValidationFailureCounter: counter,
    });

    counter.reset();
    for (const query of ["", " \t\n"]) {
      const invalidError = await handler({ query }).catch(
        (caught: unknown) => caught
      );
      expect(invalidError).toBeInstanceOf(GraphragError);
      expect(invalidError).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(counter.count).toBeGreaterThan(0);

    counter.reset();
    const legalEmpty = await handler({ query: "syntactically legal no-match" });
    const body = JSON.parse(legalEmpty.content[0]!.text) as {
      chunks: RetrievedChunk[];
      degraded?: boolean;
    };
    expect(body.chunks).toEqual([]);
    expect(legalEmpty.isError).not.toBe(true);
    expect(body).not.toHaveProperty("degraded");
    expect(counter.count).toBe(0);
  });

  it("rejects whitespace-only queries at the tool schema boundary", () => {
    expect(RetrieveInputSchema.safeParse({ query: "   " }).success).toBe(false);
  });
});
