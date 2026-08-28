/**
 * Anthropic retrieve-rerank adapter — injected SDK, no live network.
 */
import { describe, it, expect } from "vitest";
import { createAnthropicChunkReranker } from "../../src/core/rerank/anthropic-reranker.js";

describe("createAnthropicChunkReranker", () => {
  it("parses a JSON id array from the model text", async () => {
    const reranker = createAnthropicChunkReranker(
      {
        apiKey: "test-key-not-a-real-secret",
        model: "claude-test",
        baseUrl: "https://example.invalid/v1",
      },
      {
        anthropic: {
          messages: {
            create: async () => ({
              content: [{ type: "text", text: '["b","a"]' }],
            }),
          },
        },
      }
    );
    await expect(
      reranker.permute("q", [
        { id: "a", content: "A" },
        { id: "b", content: "B" },
      ])
    ).resolves.toEqual(["b", "a"]);
  });

  it("scales max_tokens with candidate count and keeps the 1024 floor", async () => {
    const requests: Array<{ max_tokens?: number }> = [];
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      id: `candidate-${index}`,
      content: `Candidate ${index}`,
    }));
    const reranker = createAnthropicChunkReranker(
      {
        apiKey: "test-key-not-a-real-secret",
        model: "claude-test",
        baseUrl: "https://example.invalid/v1",
      },
      {
        anthropic: {
          messages: {
            create: async (params) => {
              requests.push(params as { max_tokens?: number });
              return { content: [{ type: "text", text: "[]" }] };
            },
          },
        },
      }
    );

    await reranker.permute("q", [{ id: "small", content: "Small" }]);
    await reranker.permute("q", candidates);

    expect(requests[0]?.max_tokens).toBe(1024);
    expect(requests[1]?.max_tokens).toBeGreaterThan(1024);
  });

  it("throws when the model returns non-array text", async () => {
    const reranker = createAnthropicChunkReranker(
      {
        apiKey: "test-key-not-a-real-secret",
        model: "claude-test",
        baseUrl: "https://example.invalid/v1",
      },
      {
        anthropic: {
          messages: {
            create: async () => ({
              content: [{ type: "text", text: "sorry" }],
            }),
          },
        },
      }
    );
    await expect(
      reranker.permute("q", [{ id: "a", content: "A" }])
    ).rejects.toThrow(/JSON array/);
  });

  it("propagates SDK throws so retrieve can fail-open", async () => {
    const reranker = createAnthropicChunkReranker(
      {
        apiKey: "test-key-not-a-real-secret",
        model: "claude-test",
        baseUrl: "https://example.invalid/v1",
      },
      {
        anthropic: {
          messages: {
            create: async () => {
              throw new Error("503");
            },
          },
        },
      }
    );
    await expect(
      reranker.permute("q", [{ id: "a", content: "A" }])
    ).rejects.toThrow("503");
  });
});
