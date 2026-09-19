/**
 * LLM client abstraction for the offline extraction pipeline (T2).
 *
 * `LLMClient` is the contract the extraction pipeline consumes: the
 * mandatory `extract` triple call, plus the OPTIONAL T3 enrichment calls
 * (`describeEntities` / `extractClaims`) the standard method runs after
 * canonical merge. `AnthropicLLMClient` is the production adapter (calls
 * `@anthropic-ai/sdk`), `FakeLLMClient` is the test double. The SDK is
 * injected via constructor so tests can stub the network without a live
 * API key — DI is the single seam the rest of the pipeline cares about.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  buildClaimsPrompt,
  buildDescribePrompt,
  buildExtractionPrompt,
} from "./prompt.js";
import {
  type ClaimOutput,
  type ClaimsInput,
  type ClaimsResponse,
  type DescribeInput,
  type DescribeResponse,
  type EntityDescriptionDraft,
  type ExtractionOutput,
  type ExtractionResponse,
} from "./types.js";

/** Public contract — every adapter implements `extract`; the T3 enrichment
 * methods are OPTIONAL: a client without them never runs the standard
 * describe/claims leg (the pipeline skips it), which keeps test doubles and
 * legacy callers source-compatible. `AnthropicLLMClient` implements all
 * three, so the production standard job always has them. */
export interface LLMClient {
  extract(chunkText: string): Promise<ExtractionResponse>;
  /**
   * Summarize each survivor's merged description list into one string
   * (ADR 0069, graph-index-standard-fast T3). Never throws on an LLM-level
   * failure — a failed leg is a sealed `{kind:"failed"}` skip.
   */
  describeEntities?(input: DescribeInput): Promise<DescribeResponse>;
  /**
   * Extract time-bounded claims about the given survivor entities from one
   * chunk (ADR 0071, T3). Same sealed-failure posture as describeEntities.
   */
  extractClaims?(input: ClaimsInput): Promise<ClaimsResponse>;
  /**
   * Model id surfaced for process logs (SC10). Optional so test doubles and
   * unwired stubs stay source-compatible; production adapters set it.
   */
  readonly modelId?: string;
}

// ─── Retry classification (#4 D4) ────────────────────────────────────────
const MAX_5XX_ATTEMPTS = 3; // 5xx/network: 3 attempts before mark-and-continue (#4 D4)
const BASE_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 2000;

// ─── System prompt (sent once per extract call) ───────────────────────────
// Role only. The vocabulary (PROMPT_HINT), the field rules and the output
// schema all live in `buildExtractionPrompt`, which composes the user message
// — one source of format truth per request, so system and user never instruct
// two different output shapes (G3).
const SYSTEM_PROMPT = [
  "You extract structured fact triples from the chunk given in the user message.",
  "Follow the allowed relation vocabulary and the output schema stated there exactly.",
  "Emit raw JSON only — no prose, no markdown fences.",
].join(" ");

/** Role line for the describe call (T3) — the schema lives in the user prompt. */
const DESCRIBE_SYSTEM = [
  "You consolidate per-entity description lists into one concise entity description.",
  "Follow the output schema stated in the user message exactly.",
  "Emit raw JSON only — no prose, no markdown fences.",
].join(" ");

/** Role line for the claims call (T3) — the schema lives in the user prompt. */
const CLAIMS_SYSTEM = [
  "You extract time-bounded claims about the listed entities from the chunk.",
  "Follow the output schema stated in the user message exactly.",
  "Emit raw JSON only — no prose, no markdown fences.",
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

/** One describe item: `{entity, description}` — `entity` is the survivor name. */
const DescribeItemSchema = z.object({
  entity: z.string().min(1),
  description: z.string().min(1),
});

/**
 * One claim item (T3). `validFrom`/`validTo` are optional-or-null so a model
 * that omits an open bound parses the same as one that sends `null`;
 * `evidenceSpan` is optional because claims tolerate a span-less row (the
 * enrichment module stores NULL).
 */
const ClaimItemSchema = z.object({
  entity: z.string().min(1),
  claim: z.string().min(1),
  validFrom: z.string().nullable().optional(),
  validTo: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  evidenceSpan: z.string().optional(),
});

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
  /** API key sent by the SDK as `x-api-key`; ignored when injected. */
  apiKey: string;
  /** Base URL for the Anthropic-compatible endpoint. */
  baseUrl: string;
  /** Injectable transport for tests; defaults to the SDK's fetch. */
  fetch?: typeof globalThis.fetch;
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

  /** Exposed for the SC10 process-log field whitelist (never the API key). */
  readonly modelId: string;

  constructor(opts: AnthropicLLMClientOpts) {
    this.model = opts.model;
    this.modelId = opts.model;
    this.anthropic =
      opts.anthropic ??
      (new Anthropic({
        apiKey: opts.apiKey,
        // MiniMax authenticates this Anthropic-compatible endpoint with
        // x-api-key. Do not let ANTHROPIC_AUTH_TOKEN add a conflicting
        // Authorization header from the process environment.
        authToken: null,
        baseURL: opts.baseUrl,
        fetch: opts.fetch,
      }) as unknown as AnthropicLike);
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async extract(chunkText: string): Promise<ExtractionResponse> {
    // HTTP path: 5xx/network get up to 3 attempts, 4xx fails fast (#4 D4).
    const http = await this.callWithHttpRetries(
      buildExtractionPrompt(chunkText),
      SYSTEM_PROMPT
    );
    if (http.kind !== "ok") return http;

    // First parse attempt.
    const parsed = tryParseOutputs(http.message);
    if (parsed.ok) return { kind: "ok", outputs: parsed.outputs };

    // Format retry (#4 D4: 1 retry on bad JSON). Single LLM call — a fresh
    // 5xx/4xx during the retry is classified and returned as-is so the
    // batch policy still marks the chunk appropriately.
    const retry = await this.callOnce(
      buildExtractionPrompt(chunkText),
      SYSTEM_PROMPT
    );
    if (retry.kind !== "ok") return retry;
    const retryParsed = tryParseOutputs(retry.message);
    if (retryParsed.ok) return { kind: "ok", outputs: retryParsed.outputs };
    return { kind: "format", message: retryParsed.error };
  }

  /**
   * 5xx/network → 3 attempts with backoff; 4xx → fail fast.
   *
   * Takes the COMPOSED prompt + system role text so all three LLM surfaces
   * (extract, describe, claims) share one retry classifier — the T3
   * enrichment legs keep the #4 D4 transport posture without re-dialing on
   * a format miss (a format failure there is a sealed skip per ADR 0069 /
   * 0071, so no second billable call).
   */
  private async callWithHttpRetries(
    promptText: string,
    system: string
  ): Promise<
    | { kind: "ok"; message: MessageLike }
    | { kind: "4xx" | "5xx"; message: string }
  > {
    for (let attempt = 1; attempt <= MAX_5XX_ATTEMPTS; attempt += 1) {
      const result = await this.callOnce(promptText, system);
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
    promptText: string,
    system: string
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
        system,
        thinking: { type: "disabled" },
        // G3: the request body is the schema-guided prompt, so the vocabulary
        // and the chunk reach the model together while extract(chunkText)
        // stays frozen.
        messages: [{ role: "user", content: promptText }],
      });
      return { kind: "ok", message };
    } catch (err) {
      return { kind: classifyError(err), message: errorMessage(err) };
    }
  }

  /**
   * Batched survivor-description call (T3, ADR 0069). No format retry — a
   * parse miss is a sealed `{kind:"failed"}` skip the enrichment module
   * counts as skipped descriptions, never a chunk failure.
   */
  async describeEntities(input: DescribeInput): Promise<DescribeResponse> {
    const http = await this.callWithHttpRetries(
      buildDescribePrompt(input.entities),
      DESCRIBE_SYSTEM
    );
    if (http.kind !== "ok") {
      return { kind: "failed", errorCode: http.kind, errorMsg: http.message };
    }
    const parsed = tryParseEnvelope(
      http.message,
      "descriptions",
      DescribeItemSchema
    );
    if (!parsed.ok) {
      return { kind: "failed", errorCode: "format", errorMsg: parsed.error };
    }
    const descriptions: EntityDescriptionDraft[] = parsed.items.map((item) => ({
      canonicalName: item.entity,
      description: item.description,
    }));
    return { kind: "ok", descriptions };
  }

  /**
   * Per-chunk claim extraction (T3, ADR 0071). Same no-format-retry
   * posture as describeEntities; row-level validity (entity anchoring,
   * window ordering) is the enrichment module's gate, not the transport's.
   */
  async extractClaims(input: ClaimsInput): Promise<ClaimsResponse> {
    const http = await this.callWithHttpRetries(
      buildClaimsPrompt(input.chunkText, input.entities),
      CLAIMS_SYSTEM
    );
    if (http.kind !== "ok") {
      return { kind: "failed", errorCode: http.kind, errorMsg: http.message };
    }
    const parsed = tryParseEnvelope(http.message, "claims", ClaimItemSchema);
    if (!parsed.ok) {
      return { kind: "failed", errorCode: "format", errorMsg: parsed.error };
    }
    const claims: ClaimOutput[] = parsed.items.map((item) => ({
      entity: item.entity,
      claim: item.claim,
      validFrom: item.validFrom ?? null,
      validTo: item.validTo ?? null,
      confidence: item.confidence,
      evidenceSpan: item.evidenceSpan ?? "",
    }));
    return { kind: "ok", claims };
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
  const parsed = tryParseEnvelope(message, "outputs", ExtractionOutputSchema);
  return parsed.ok ? { ok: true, outputs: parsed.items } : parsed;
}

/**
 * Parse one LLM message into an array of `T` under the wrapper key the
 * prompt schema instructs (`{"outputs": [...]}`, `{"descriptions": [...]}`,
 * `{"claims": [...]}`) while accepting the bare-array shape smaller models
 * return anyway. The envelope unwrap + Zod gate have exactly one home here,
 * shared by all three LLM surfaces (extract, describe, claims).
 */
function tryParseEnvelope<T extends z.ZodTypeAny>(
  message: MessageLike,
  key: string,
  itemSchema: T
): { ok: true; items: z.infer<T>[] } | { ok: false; error: string } {
  const text = message.content.find((b) => b.type === "text")?.text ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `JSON parse: ${(err as Error).message}` };
  }
  const candidate =
    Array.isArray(raw) ||
    !(typeof raw === "object" && raw !== null && key in raw)
      ? raw
      : (raw as Record<string, unknown>)[key];
  const parsed = z.array(itemSchema).safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: `schema: ${parsed.error.message}` };
  }
  return { ok: true, items: parsed.data };
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
 *
 * T3 enrichment: `describeQueue` / `claimsQueue` (FIFO) or
 * `scriptedDescribe` / `scriptedClaims` configure the OPTIONAL enrichment
 * methods. Unconfigured → the method property stays ABSENT, so the pipeline
 * sees a client without the capability (exactly what the plain-fake tests
 * assert); configured but drained → throws "… queue exhausted".
 */
export interface FakeLLMClientOpts {
  queue?: ExtractionResponse[];
  scripted?: (chunkText: string) => Promise<ExtractionResponse>;
  /** Surfaced as `modelId` for the SC10 process-log assertions. */
  modelId?: string;
  describeQueue?: DescribeResponse[];
  scriptedDescribe?: (input: DescribeInput) => Promise<DescribeResponse>;
  claimsQueue?: ClaimsResponse[];
  scriptedClaims?: (input: ClaimsInput) => Promise<ClaimsResponse>;
}

export class FakeLLMClient implements LLMClient {
  private readonly queue: ExtractionResponse[];
  private readonly scripted:
    ((chunkText: string) => Promise<ExtractionResponse>) | undefined;
  private head = 0;
  private readonly describeQueue: DescribeResponse[] | undefined;
  private describeHead = 0;
  private readonly scriptedDescribe:
    ((input: DescribeInput) => Promise<DescribeResponse>) | undefined;
  private readonly claimsQueue: ClaimsResponse[] | undefined;
  private claimsHead = 0;
  private readonly scriptedClaims:
    ((input: ClaimsInput) => Promise<ClaimsResponse>) | undefined;

  /** Surfaced for the SC10 process-log field whitelist. */
  readonly modelId: string | undefined;

  /**
   * T3 enrichment legs — instance properties assigned only when configured,
   * so an unconfigured fake genuinely lacks the capability (the pipeline's
   * feature gate reads `typeof deps.llm.describeEntities`).
   */
  readonly describeEntities?: (input: DescribeInput) => Promise<DescribeResponse>;
  readonly extractClaims?: (input: ClaimsInput) => Promise<ClaimsResponse>;

  constructor(opts: FakeLLMClientOpts) {
    if (!opts.queue && !opts.scripted) {
      throw new Error("FakeLLMClient requires queue or scripted");
    }
    this.queue = opts.queue ?? [];
    this.scripted = opts.scripted;
    this.modelId = opts.modelId;
    this.describeQueue = opts.describeQueue;
    this.scriptedDescribe = opts.scriptedDescribe;
    this.claimsQueue = opts.claimsQueue;
    this.scriptedClaims = opts.scriptedClaims;
    if (opts.describeQueue || opts.scriptedDescribe) {
      this.describeEntities = async (input) => {
        if (this.scriptedDescribe) return this.scriptedDescribe(input);
        return this.take(this.describeQueue!, this.describeHead++, "describe");
      };
    }
    if (opts.claimsQueue || opts.scriptedClaims) {
      this.extractClaims = async (input) => {
        if (this.scriptedClaims) return this.scriptedClaims(input);
        return this.take(this.claimsQueue!, this.claimsHead++, "claims");
      };
    }
  }

  async extract(chunkText: string): Promise<ExtractionResponse> {
    if (this.scripted) return this.scripted(chunkText);
    return this.take(this.queue, this.head++, "");
  }

  /** Shared FIFO pop; the label keeps each queue's exhaustion message distinct. */
  private take<T>(queue: T[], headIndex: number, label: string): T {
    if (headIndex >= queue.length) {
      throw new Error(
        `FakeLLMClient ${label ? `${label} ` : ""}queue exhausted`
      );
    }
    const resp = queue[headIndex];
    if (resp === undefined) {
      throw new Error(
        `FakeLLMClient ${label ? `${label} ` : ""}queue exhausted`
      );
    }
    return resp;
  }
}
