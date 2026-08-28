/**
 * Dedicated HTTP retrieve-rerank adapter.
 *
 * The service receives the same query and candidate shape as the retrieval
 * port and returns `{ chunks: string[] }`, where the strings are candidate
 * ids in best-first order. Transport and response errors intentionally throw;
 * `applyRerank` owns the shared fail-open + degraded contract.
 */
import type { ChunkReranker, RerankCandidate } from "../retrieval/types.js";

export interface HttpChunkRerankerOptions {
  fetch?: typeof fetch;
}

interface RerankResponse {
  chunks?: unknown;
}

function responseIds(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") {
    throw new Error("rerank response must be an object with a chunks array");
  }
  const chunks = (payload as RerankResponse).chunks;
  if (!Array.isArray(chunks) || !chunks.every((id) => typeof id === "string")) {
    throw new Error("rerank response chunks must be an array of ids");
  }
  return chunks;
}

export function createHttpChunkReranker(
  url: string,
  options: HttpChunkRerankerOptions = {}
): ChunkReranker {
  const request = options.fetch ?? fetch;
  return {
    async permute(
      query: string,
      candidates: readonly RerankCandidate[]
    ): Promise<readonly string[]> {
      const response = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, chunks: candidates }),
      });
      if (!response.ok) {
        throw new Error(
          `rerank HTTP ${response.status}: ${response.statusText}`
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        throw new Error(
          `rerank response JSON parse failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      return responseIds(payload);
    },
  };
}
