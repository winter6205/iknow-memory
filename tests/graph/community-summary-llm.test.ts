import { describe, expect, it } from "vitest";
import {
  AnthropicCommunitySummaryClient,
  type CommunitySummaryClient,
} from "../../src/core/graph/community-summary-llm.js";

describe("community summary LLM adapter", () => {
  it("sends entity names and returns the plain-text summary", async () => {
    const requests: unknown[] = [];
    const client: CommunitySummaryClient = new AnthropicCommunitySummaryClient({
      apiKey: "test",
      model: "model",
      baseUrl: "https://example.test",
      anthropic: {
        messages: {
          async create(params) {
            requests.push(params);
            return {
              content: [{ type: "text", text: "  shared topic  " }],
            };
          },
        },
      },
    });

    await expect(client.summarize(["Postgres", "pgvector"])).resolves.toBe(
      "shared topic"
    );
    expect(requests[0]).toMatchObject({
      model: "model",
      messages: [
        {
          role: "user",
          content: "Community entities:\n- Postgres\n- pgvector",
        },
      ],
    });
  });

  it("rejects an empty model response", async () => {
    const client = new AnthropicCommunitySummaryClient({
      apiKey: "test",
      model: "model",
      baseUrl: "https://example.test",
      anthropic: {
        messages: {
          async create() {
            return { content: [{ type: "text", text: " \n" }] };
          },
        },
      },
    });

    await expect(client.summarize(["Postgres"])).rejects.toThrow(
      "community summary LLM returned no text"
    );
  });

  it("sends the API key as x-api-key without inheriting bearer auth", async () => {
    let requestHeaders: Headers | undefined;
    const client = new AnthropicCommunitySummaryClient({
      apiKey: "minimax-key",
      model: "model",
      baseUrl: "https://example.test",
      fetch: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            id: "message-id",
            type: "message",
            role: "assistant",
            model: "model",
            content: [{ type: "text", text: "topic" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });

    await expect(client.summarize(["Postgres"])).resolves.toBe("topic");
    expect(requestHeaders?.get("x-api-key")).toBe("minimax-key");
    expect(requestHeaders?.get("authorization")).toBeNull();
  });
});
