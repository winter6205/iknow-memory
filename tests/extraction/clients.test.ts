/**
 * Credential guards for the lifted extract pipeline client builders
 * (`src/core/extraction/clients.ts`).
 *
 * The SC contract (specs/mcp-tool-surface.md SC9, inherited from the CLI's
 * CR High #1 / #3 fixes): a run whose output PERSISTS (real extraction, or
 * any path writing vectors) must fail with a typed `ConfigError` when the
 * credentials it needs are missing — never silently fall back to
 * `FakeLLMClient` / `FakeEmbedder`. Keyless operation stays legal only for
 * runs that persist nothing.
 *
 * These tests target the core surface directly so both callers (CLI today,
 * MCP extract in T3) share the same guard without going through CLI argv.
 */
import { describe, it, expect } from "vitest";

import { ConfigError } from "../../src/config.js";
import {
  buildLlmClient,
  buildEmbedderClient,
} from "../../src/core/extraction/clients.js";
import {
  AnthropicLLMClient,
  FakeLLMClient,
} from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder, NineRouterEmbedder } from "../../src/core/embedder.js";

describe("buildLlmClient credential guard", () => {
  it("refuses a real extraction without ANTHROPIC_AUTH_TOKEN with ConfigError", () => {
    expect(() =>
      buildLlmClient({ authToken: undefined }, { extraction: true })
    ).toThrow(ConfigError);
    expect(() =>
      buildLlmClient({ authToken: undefined }, { extraction: true })
    ).toThrow(/refusing to run real extraction without ANTHROPIC_AUTH_TOKEN/);
  });

  it("treats a whitespace-only token as missing on a real extraction", () => {
    expect(() =>
      buildLlmClient({ authToken: "   " }, { extraction: true })
    ).toThrow(ConfigError);
  });

  it("falls back to a keyless FakeLLMClient when the run persists no LLM output", async () => {
    const llm = buildLlmClient({ authToken: undefined }, { extraction: false });
    expect(llm).toBeInstanceOf(FakeLLMClient);
    const response = await llm.extract("Alice works at Acme.");
    // Canned ok so a keyless dry-run has deterministic output; the fake never
    // reaches a real write path because extraction intent was false.
    expect(response.kind).toBe("ok");
    if (response.kind !== "ok") return;
    expect(response.outputs).toHaveLength(1);
    expect(response.outputs[0]!.head).toBe("Alice");
  });

  it("builds AnthropicLLMClient when a token is set, applying model defaults", () => {
    const llm = buildLlmClient(
      { authToken: "tok", baseUrl: "https://api.example.com/" },
      { extraction: true }
    );
    expect(llm).toBeInstanceOf(AnthropicLLMClient);
    expect(llm.modelId).toBe("MiniMax-M3");
  });

  it("honours an explicit model over the default", () => {
    const llm = buildLlmClient(
      { authToken: "tok", model: "test-model" },
      { extraction: true }
    );
    expect(llm.modelId).toBe("test-model");
  });
});

describe("buildEmbedderClient credential guard", () => {
  const CREDENTIALS = {
    apiKey: "k",
    baseUrl: "https://embed.example.com",
    model: "embedding-3",
  };

  it("refuses a vector-persisting run without credentials with ConfigError", () => {
    expect(() =>
      buildEmbedderClient(
        { ...CREDENTIALS, apiKey: undefined, dimensions: 8 },
        { persistsEmbeddings: true }
      )
    ).toThrow(ConfigError);
    expect(() =>
      buildEmbedderClient(
        { ...CREDENTIALS, apiKey: undefined, dimensions: 8 },
        { persistsEmbeddings: true }
      )
    ).toThrow(/refusing to persist embeddings without embedding credentials/);
  });

  it("refuses when only some of the credential triple is present", () => {
    expect(() =>
      buildEmbedderClient(
        {
          apiKey: "k",
          baseUrl: undefined,
          model: "embedding-3",
          dimensions: 8,
        },
        { persistsEmbeddings: true }
      )
    ).toThrow(ConfigError);
    expect(() =>
      buildEmbedderClient(
        { apiKey: "k", baseUrl: "https://e", model: undefined, dimensions: 8 },
        { persistsEmbeddings: true }
      )
    ).toThrow(ConfigError);
  });

  it("returns a FakeEmbedder for a read-only keyless run", async () => {
    const embedder = buildEmbedderClient(
      {
        apiKey: undefined,
        baseUrl: undefined,
        model: undefined,
        dimensions: 8,
      },
      { persistsEmbeddings: false }
    );
    expect(embedder).toBeInstanceOf(FakeEmbedder);
    const vectors = await embedder.embed(["text"]);
    expect(vectors[0]).toHaveLength(8);
  });

  it("returns a NineRouterEmbedder when credentials are complete", () => {
    const embedder = buildEmbedderClient(
      { ...CREDENTIALS, dimensions: 8 },
      { persistsEmbeddings: true }
    );
    expect(embedder).toBeInstanceOf(NineRouterEmbedder);
  });
});
