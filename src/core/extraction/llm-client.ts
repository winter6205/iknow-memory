/**
 * LLM client abstraction for the offline extraction pipeline (T2).
 *
 * `LLMClient` is the one-method contract the extraction pipeline consumes.
 * `AnthropicLLMClient` is the production adapter (calls `@anthropic-ai/sdk`),
 * `FakeLLMClient` is the test double. The SDK is injected via constructor so
 * tests can stub the network without a live API key — DI is the single seam
 * the rest of the pipeline cares about.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { type ExtractionOutput, type ExtractionResponse } from "./types.js";

/** Public contract — every adapter implements this one method. */
export interface LLMClient {
  extract(chunkText: string): Promise<ExtractionResponse>;
}

// ─── Retry classification (#4 D4) ────────────────────────────────────────
const MAX_5XX_ATTEMPTS = 3; // 5xx/network: 3 attempts before mark-and-continue (#4 D4)
const BASE_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 2000;

// ─── System prompt (sent once per extract call) ───────────────────────────
// Per the spec's "Schema validation: zod" — the LLM must emit a JSON array of
// ExtractionOutput objects; the client re-validates before returning kind:"ok".
const SYSTEM_PROMPT = [
  "You extract structured fact triples from the given chunk.",
  "Output ONLY a JSON array. Each element has exactly these keys:",
  "head, headType, relationRaw, relationNorm, tail, tailType,",
  "description, evidenceSpan, confidence.",
  "Rules:",
  "- description is mandatory and must be a non-empty sentence.",
  "- evidenceSpan must be a verbatim substring of the chunk.",
  "- confidence is a number in [0, 1].",
  "- relationNorm may be 'UNMAPPED' if no vocabulary match applies.",
  "Emit no prose outside the JSON array.",
].join(" ");

/** Zod schema mirrors ExtractionOutput; runtime parse step before returning ok. */
const ExtractionOutputSchema = z.object({
  head: z.string().min(1),
  headType: z.string().min(1),
  relationRaw: z.string().min(1),
  relationNorm: z.string().min(1),
  tail: z.string().min(1),
  tailType: z.string().min(1),
  description: z.string().min(1),
  evidenceSpan: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const ExtractionOutputsSchema = z.array(ExtractionOutputSchema);

interface MessageLike {
  content: Array<{ type: string; text?: string }>;
}

interface AnthropicLike {
  messages: {
    create: (params: unknown) => Promise<MessageLike>;
  };
}

export interface AnthropicLLMClientOpts {
  /** Model id forwarded as `model:` on each `messages.create` call. */
  model: string;
  /** Bearer token for the Anthropic SDK; ignored when `anthropic` is injected. */
  apiKey: string;
  /** Base URL for the Anthropic-compatible endpoint. */
  baseUrl: string;
  /**
   * Injected Anthropic SDK client. Required for tests; defaults to a fresh
   * `new Anthropic({...})`. Tests should always supply this to avoid the
   * constructor touching the network or env at construction time.
   */
  anthropic?: AnthropicLike;
  /**
   * Backoff sleep, injected so tests can run deterministically without real
   * delays. Defaults to `setTimeout`-backed `Promise` resolution.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Production adapter — calls an Anthropic-compatible endpoint via the SDK.
 *
 * Retry policy (#4 D4):
 *   - 5xx/network → 3 attempts with exponential backoff (100, 200, 400 ms, cap 2 s).
 *   - 4xx → no retry; single attempt surfaces as `{kind:"4xx",...}`.
 *   - format failure → 1 retry of the LLM call (2 total), then `{kind:"format",...}`.
 *
 * The SDK already auto-retries 429/529 internally; this class layers our
 * application-level retry on top. A re-thrown 429 from the SDK after its
 * retries is bucketed as "5xx" so mark-and-continue still surfaces it.
 */
export class AnthropicLLMClient implements LLMClient {
  private readonly model: string;
  private readonly anthropic: AnthropicLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AnthropicLLMClientOpts) {
    this.model = opts.model;
    this.anthropic =
      opts.anthropic ??
      (new Anthropic({
        apiKey: opts.apiKey,
        baseURL: opts.baseUrl,
      }) as unknown as AnthropicLike);
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async extract(chunkText: string): Promise<ExtractionResponse> {
    // HTTP path: 5xx/network get up to 3 attempts, 4xx fails fast (#4 D4).
    const http = await this.callWithHttpRetries(chunkText);
    if (http.kind !== "ok") return http;

    // First parse attempt.
    const parsed = tryParseOutputs(http.message);
    if (parsed.ok) return { kind: "ok", outputs: parsed.outputs };

    // Format retry (#4 D4: 1 retry on bad JSON). Single LLM call — a fresh
    // 5xx/4xx during the retry is classified and returned as-is so the
    // batch policy still marks the chunk appropriately.
    const retry = await this.callOnce(chunkText);
    if (retry.kind !== "ok") return retry;
    const retryParsed = tryParseOutputs(retry.message);
    if (retryParsed.ok) return { kind: "ok", outputs: retryParsed.outputs };
    return { kind: "format", message: retryParsed.error };
  }

  /** 5xx/network → 3 attempts with backoff; 4xx → fail fast. */
  private async callWithHttpRetries(
    chunkText: string
  ): Promise<
    | { kind: "ok"; message: MessageLike }
    | { kind: "4xx" | "5xx"; message: string }
  > {
    for (let attempt = 1; attempt <= MAX_5XX_ATTEMPTS; attempt += 1) {
      const result = await this.callOnce(chunkText);
      if (result.kind === "ok") return result;
      if (result.kind === "4xx") return result; // #4 D4: no retry on 4xx.
      if (attempt < MAX_5XX_ATTEMPTS) {
        await this.sleep(backoffMs(attempt));
        continue;
      }
      return result;
    }
    return { kind: "5xx", message: "exhausted retries" };
  }

  /** Single LLM call → classified into ok / 4xx / 5xx / format-neutral. */
  private async callOnce(
    chunkText: string
  ): Promise<
    | { kind: "ok"; message: MessageLike }
    | { kind: "4xx" | "5xx"; message: string }
  > {
    try {
      // max_tokens 4096 + thinking disabled (T10 smoke): thinking-capable
      // models (deepseek-v4-flash-free etc.) burn a 1024-token budget on
      // reasoning alone, so text never appears and extraction fails `format`.
      // Structured extraction needs no extended thinking — disable it and give
      // the JSON array room to complete.
      const message = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: chunkText }],
      });
      return { kind: "ok", message };
    } catch (err) {
      return { kind: classifyError(err), message: errorMessage(err) };
    }
  }
}

/**
 * Classify a thrown SDK / network error into the RetryClass used by callers.
 * Status-bearing errors → status-based bucketing; status-less → "5xx" because
 * transport / network failures are transient and worth retrying (#4 D4).
 * 429 is bucketed as "5xx" — the SDK already auto-retries 429/529; once a
 * 429 escapes the SDK, our retry layer treats it as retriable.
 */
function classifyError(err: unknown): "4xx" | "5xx" {
  const status = (err as { status?: unknown })?.status;
  if (typeof status !== "number") return "5xx";
  if (status === 429 || status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  return "5xx";
}

function errorMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? "unknown LLM error";
}

function tryParseOutputs(
  message: MessageLike
): { ok: true; outputs: ExtractionOutput[] } | { ok: false; error: string } {
  const text = message.content.find((b) => b.type === "text")?.text ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `JSON parse: ${(err as Error).message}` };
  }
  const parsed = ExtractionOutputsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `schema: ${parsed.error.message}` };
  }
  return { ok: true, outputs: parsed.data };
}

function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test double — no network, no randomness.
 *
 * Queue mode: pass `{ queue: ExtractionResponse[] }`. Each `extract()` pops
 * the head and returns it. Throws "queue exhausted" if the queue drains.
 *
 * Scripted mode: pass `{ scripted: (chunkText) => Promise<ExtractionResponse> }`.
 * The function is called on every `extract()`.
 */
export interface FakeLLMClientOpts {
  queue?: ExtractionResponse[];
  scripted?: (chunkText: string) => Promise<ExtractionResponse>;
}

export class FakeLLMClient implements LLMClient {
  private readonly queue: ExtractionResponse[];
  private readonly scripted:
    ((chunkText: string) => Promise<ExtractionResponse>) | undefined;
  private head = 0;

  constructor(opts: FakeLLMClientOpts) {
    if (!opts.queue && !opts.scripted) {
      throw new Error("FakeLLMClient requires queue or scripted");
    }
    this.queue = opts.queue ?? [];
    this.scripted = opts.scripted;
  }

  async extract(chunkText: string): Promise<ExtractionResponse> {
    if (this.scripted) return this.scripted(chunkText);
    if (this.head >= this.queue.length) {
      throw new Error("FakeLLMClient queue exhausted");
    }
    const resp = this.queue[this.head];
    if (resp === undefined) {
      throw new Error("FakeLLMClient queue exhausted");
    }
    this.head += 1;
    return resp;
  }
}
