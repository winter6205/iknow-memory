import { describe, it, expect, vi } from "vitest";
import {
  AnthropicLLMClient,
  FakeLLMClient,
} from "../../src/core/extraction/llm-client.ts";
import { buildExtractionPrompt } from "../../src/core/extraction/prompt.ts";
import { ALLOWED, PROMPT_HINT } from "../../src/core/extraction/vocabulary.ts";
import type { ExtractionResponse } from "../../src/core/extraction/types.ts";

/**
 * Test double for the LLM contract.
 *
 * Two consumption modes (mutually exclusive per instance):
 *   1. **queue** — pass an ordered array of `ExtractionResponse` values;
 *      each `extract()` consumes the head and shifts it. Throws when the
 *      queue is exhausted (caller under-specified the script).
 *   2. **scripted** — pass a `(chunkText) => Promise<ExtractionResponse>`
 *      function; called on every `extract()`.
 *
 * The queue is consumed FIFO because tests are linear (no interleaving).
 */
describe("FakeLLMClient", () => {
  it("consumes the queue FIFO: first in, first out", async () => {
    const first: ExtractionResponse = { kind: "ok", outputs: [] };
    const second: ExtractionResponse = { kind: "5xx", message: "boom" };
    const client = new FakeLLMClient({ queue: [first, second] });

    expect(await client.extract("anything")).toEqual(first);
    expect(await client.extract("anything")).toEqual(second);
  });

  it("throws when the queue is exhausted", async () => {
    const client = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [] }],
    });
    await client.extract("once");
    await expect(client.extract("twice")).rejects.toThrow(/queue exhausted/i);
  });

  it("calls the scripted function for every extract", async () => {
    const scripted = vi
      .fn()
      .mockResolvedValueOnce({ kind: "ok", outputs: [] } as ExtractionResponse)
      .mockResolvedValueOnce({
        kind: "4xx",
        message: "bad",
      } as ExtractionResponse);
    const client = new FakeLLMClient({ scripted });
    expect(await client.extract("hello")).toMatchObject({ kind: "ok" });
    expect(await client.extract("world")).toMatchObject({ kind: "4xx" });
    expect(scripted).toHaveBeenCalledTimes(2);
    expect(scripted.mock.calls[0]?.[0]).toBe("hello");
  });

  it("throws when constructed with neither queue nor scripted", () => {
    expect(() => new FakeLLMClient({} as never)).toThrow();
  });
});

/**
 * AnthropicLLMClient retry classification (#4 D4):
 *   - 5xx/network → 3 attempts, then `{kind:"5xx",...}`
 *   - 4xx        → no retry, single attempt → `{kind:"4xx",...}`
 *   - format     → 1 retry, then `{kind:"format",...}`
 *   - ok         → `{kind:"ok",outputs:[...]}`
 *
 * `client.messages.create` is stubbed via DI — no network, no real key.
 */
describe("AnthropicLLMClient retry classification", () => {
  function makeFakeAnthropic(impl: (params: unknown) => Promise<unknown>) {
    return {
      messages: {
        create: vi.fn(async (params: unknown) => impl(params)),
      },
    };
  }

  it("ok path: returns ExtractionResponse with parsed outputs", async () => {
    const okMessage = {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              head: "Alice",
              headType: "Person",
              relationRaw: "works at",
              relationNorm: "works_at",
              tail: "Acme",
              tailType: "Organization",
              description: "Alice works at Acme as a senior engineer.",
              evidenceSpan: "Alice works at Acme",
              confidence: 0.92,
            },
          ]),
        },
      ],
    };
    const fake = makeFakeAnthropic(async () => okMessage);
    const client = new AnthropicLLMClient({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      anthropic: fake as never,
      sleep: async () => {},
    });

    const result = await client.extract("Alice works at Acme");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("narrow");
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]?.head).toBe("Alice");
    expect(fake.messages.create).toHaveBeenCalledTimes(1);
  });

  it("5xx: makes 3 attempts then returns kind:'5xx'", async () => {
    const fake = makeFakeAnthropic(async () => {
      throw Object.assign(new Error("upstream 500"), { status: 500 });
    });
    const client = new AnthropicLLMClient({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      anthropic: fake as never,
      sleep: async () => {},
    });

    const result = await client.extract("any chunk");
    expect(result).toMatchObject({ kind: "5xx" });
    expect(fake.messages.create).toHaveBeenCalledTimes(3);
  });

  it("network error (no status): also treated as 5xx class, 3 attempts", async () => {
    const fake = makeFakeAnthropic(async () => {
      throw new Error("ECONNRESET");
    });
    const client = new AnthropicLLMClient({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      anthropic: fake as never,
      sleep: async () => {},
    });

    const result = await client.extract("any chunk");
    expect(result).toMatchObject({ kind: "5xx" });
    expect(fake.messages.create).toHaveBeenCalledTimes(3);
  });

  it("4xx: no retry — single attempt then returns kind:'4xx'", async () => {
    const fake = makeFakeAnthropic(async () => {
      throw Object.assign(new Error("bad request"), { status: 400 });
    });
    const client = new AnthropicLLMClient({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      anthropic: fake as never,
      sleep: async () => {},
    });

    const result = await client.extract("any chunk");
    expect(result).toMatchObject({ kind: "4xx" });
    expect(fake.messages.create).toHaveBeenCalledTimes(1);
  });

  it("format failure: 1 retry, then kind:'format' if still bad", async () => {
    const badMessage = {
      content: [{ type: "text", text: "{ this is not json" }],
    };
    const fake = makeFakeAnthropic(async () => badMessage);
    const client = new AnthropicLLMClient({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      anthropic: fake as never,
      sleep: async () => {},
    });

    const result = await client.extract("any chunk");
    expect(result).toMatchObject({ kind: "format" });
    // First call + 1 format retry = 2 total LLM calls.
    expect(fake.messages.create).toHaveBeenCalledTimes(2);
  });

  it("format failure recovers on retry: bad JSON then valid JSON returns ok", async () => {
    let n = 0;
    const fake = makeFakeAnthropic(async () => {
      n += 1;
      if (n === 1) {
        return { content: [{ type: "text", text: "not json" }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                head: "A",
                headType: "T",
                relationRaw: "r",
                relationNorm: "r",
                tail: "B",
                tailType: "T",
                description: "d",
                evidenceSpan: "e",
                confidence: 0.5,
              },
            ]),
          },
        ],
      };
    });
    const client = new AnthropicLLMClient({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      anthropic: fake as never,
      sleep: async () => {},
    });

    const result = await client.extract("any chunk");
    expect(result).toMatchObject({ kind: "ok" });
    expect(fake.messages.create).toHaveBeenCalledTimes(2);
  });

  it("backoff is invoked between 5xx attempts (not on 4xx or final attempt)", async () => {
    const sleep = vi.fn(async () => {});
    const fake = makeFakeAnthropic(async () => {
      throw Object.assign(new Error("upstream 502"), { status: 502 });
    });
    const client = new AnthropicLLMClient({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      anthropic: fake as never,
      sleep,
    });

    await client.extract("any chunk");
    // 3 attempts → 2 gaps between them.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fake.messages.create).toHaveBeenCalledTimes(3);
  });

  it("sends max_tokens 4096 so structured JSON survives thinking-capable models", async () => {
    const fake = makeFakeAnthropic(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              head: "Alice",
              headType: "person",
              relationRaw: "works at",
              relationNorm: "MEMBER_OF",
              tail: "Acme",
              tailType: "system",
              description: "Alice works at Acme",
              evidenceSpan: "Alice works at Acme",
              confidence: 0.9,
            },
          ]),
        },
      ],
    }));
    const client = new AnthropicLLMClient({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      anthropic: fake as never,
    });

    await client.extract("Alice works at Acme");

    const params = fake.messages.create.mock.calls[0]?.[0] as {
      max_tokens?: unknown;
      thinking?: unknown;
    };
    expect(params.max_tokens).toBe(4096);
  });

  it("disables extended thinking for deterministic structured output", async () => {
    const fake = makeFakeAnthropic(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify([]),
        },
      ],
    }));
    const client = new AnthropicLLMClient({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      anthropic: fake as never,
    });

    await client.extract("any chunk");

    const params = fake.messages.create.mock.calls[0]?.[0] as {
      thinking?: unknown;
    };
    expect(params.thinking).toEqual({ type: "disabled" });
  });

  it("sends the API key as x-api-key without inheriting bearer auth", async () => {
    let requestHeaders: Headers | undefined;
    const client = new AnthropicLLMClient({
      model: "test-model",
      apiKey: "minimax-key",
      baseUrl: "https://example.test",
      fetch: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            id: "message-id",
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [{ type: "text", text: "[]" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });

    await expect(client.extract("Alice works at Acme")).resolves.toEqual({
      kind: "ok",
      outputs: [],
    });
    expect(requestHeaders?.get("x-api-key")).toBe("minimax-key");
    expect(requestHeaders?.get("authorization")).toBeNull();
  });
});

/**
 * G3 / SC7 — the production request must carry the vocabulary.
 *
 * `AnthropicLLMClient` composes its request from `buildExtractionPrompt`, so a
 * captured `messages.create` call contains every `ALLOWED` term (via
 * `PROMPT_HINT`) plus the chunk, while `extract(chunkText)` stays frozen.
 *
 * `buildExtractionPrompt` instructs the `{"outputs": [...]}` wrapper while the
 * legacy parser expected a bare array; the adapter resolves that by accepting
 * both shapes.
 */
describe("AnthropicLLMClient prompt wiring (G3)", () => {
  function makeFakeAnthropic(impl: (params: unknown) => Promise<unknown>) {
    return {
      messages: {
        create: vi.fn(async (params: unknown) => impl(params)),
      },
    };
  }

  function makeClient(fake: ReturnType<typeof makeFakeAnthropic>) {
    return new AnthropicLLMClient({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "https://api.test/v1",
      anthropic: fake as never,
      sleep: async () => {},
    });
  }

  function textMessage(text: string) {
    return { content: [{ type: "text", text }] };
  }

  const sampleOutput = {
    head: "Alice",
    headType: "person",
    relationRaw: "works at",
    relationNorm: "works_for",
    tail: "Acme",
    tailType: "system",
    description: "Alice works at Acme as a senior engineer.",
    evidenceSpan: "Alice works at Acme",
    confidence: 0.92,
  };

  /** Concatenated system + user text of the captured request. */
  function capturedRequestText(
    fake: ReturnType<typeof makeFakeAnthropic>,
    call = 0
  ): string {
    const params = fake.messages.create.mock.calls[call]?.[0] as {
      system?: unknown;
      messages?: Array<{ role: string; content: unknown }>;
    };
    const system = typeof params.system === "string" ? params.system : "";
    const user = (params.messages ?? [])
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    return `${system}\n${user}`;
  }

  it("SC7: captured messages.create request carries every ALLOWED term via PROMPT_HINT", async () => {
    const fake = makeFakeAnthropic(async () =>
      textMessage(JSON.stringify([sampleOutput]))
    );

    await makeClient(fake).extract("Alice works at Acme");

    const requestText = capturedRequestText(fake);
    expect(requestText).toContain(PROMPT_HINT);
    for (const term of ALLOWED) {
      expect(requestText).toContain(term);
    }
  });

  it("sends the buildExtractionPrompt composition as the user message, chunk included", async () => {
    const chunk = "the quick brown fox jumps over the lazy dog";
    const fake = makeFakeAnthropic(async () => textMessage(JSON.stringify([])));

    await makeClient(fake).extract(chunk);

    const params = fake.messages.create.mock.calls[0]?.[0] as {
      messages?: Array<{ role: string; content: unknown }>;
    };
    expect(params.messages).toHaveLength(1);
    expect(params.messages?.[0]?.role).toBe("user");
    expect(params.messages?.[0]?.content).toBe(buildExtractionPrompt(chunk));
  });

  it("carries the vocabulary on the format-retry call too", async () => {
    let n = 0;
    const fake = makeFakeAnthropic(async () => {
      n += 1;
      return n === 1
        ? textMessage("not json")
        : textMessage(JSON.stringify([sampleOutput]));
    });

    const result = await makeClient(fake).extract("Alice works at Acme");

    expect(result).toMatchObject({ kind: "ok" });
    expect(fake.messages.create).toHaveBeenCalledTimes(2);
    expect(capturedRequestText(fake, 1)).toContain(PROMPT_HINT);
  });

  it('parses the {"outputs": [...]} wrapper the prompt schema instructs', async () => {
    const fake = makeFakeAnthropic(async () =>
      textMessage(JSON.stringify({ outputs: [sampleOutput] }))
    );

    const result = await makeClient(fake).extract("Alice works at Acme");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("narrow");
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]?.relationNorm).toBe("works_for");
    expect(fake.messages.create).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty wrapper as a legal zero-output extraction", async () => {
    const fake = makeFakeAnthropic(async () =>
      textMessage(JSON.stringify({ outputs: [] }))
    );

    const result = await makeClient(fake).extract("nothing extractable here");

    expect(result).toEqual({ kind: "ok", outputs: [] });
    expect(fake.messages.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrapper whose outputs is not an array as kind:'format'", async () => {
    const fake = makeFakeAnthropic(async () =>
      textMessage(JSON.stringify({ outputs: sampleOutput }))
    );

    const result = await makeClient(fake).extract("Alice works at Acme");

    expect(result).toMatchObject({ kind: "format" });
    expect(fake.messages.create).toHaveBeenCalledTimes(2);
  });
});
