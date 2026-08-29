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
});
