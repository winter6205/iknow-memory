/**
 * Temporary retrieve rerank adapter — Anthropic messages.create over the
 * extract credential trio (specs/retrieve-rerank-llm.md).
 *
 * Lives outside `src/core/retrieval/` so the server entry can construct it
 * without importing the retrieval bounded context. One-shot: LLM throw
 * surfaces to the retrieve helper, which fail-opens. Extract's 5xx retry
 * is intentionally not reused.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { RerankConfig } from "../../config.js";

export interface RerankPermuteInput {
  id: string;
  content: string;
}

export interface AnthropicChunkReranker {
  permute(
    query: string,
    candidates: readonly RerankPermuteInput[]
  ): Promise<readonly string[]>;
}

interface MessageLike {
  content: Array<{ type: string; text?: string }>;
}

interface AnthropicLike {
  messages: {
    create: (params: unknown) => Promise<MessageLike>;
  };
}

const SYSTEM_PROMPT = [
  "You reorder retrieval chunks for a query.",
  "Return a JSON array of the given chunk ids in best-first order.",
  "Use each id exactly once. Emit raw JSON only — no prose, no markdown fences.",
].join(" ");

const IdListSchema = z.array(z.string().min(1));
const RERANK_REQUEST_TIMEOUT_MS = 8_000;
const MIN_RERANK_MAX_TOKENS = 1_024;
const TOKENS_PER_RERANK_CANDIDATE = 64;

/**
 * The extraction client uses a 4096-token output budget because fixed budgets
 * can truncate structured output. Rerank emits only ids, so scale a smaller
 * budget with the candidate count while retaining a safe floor.
 */
function maxTokensForCandidates(candidateCount: number): number {
  return Math.max(
    MIN_RERANK_MAX_TOKENS,
    candidateCount * TOKENS_PER_RERANK_CANDIDATE
  );
}

function textOf(message: MessageLike): string {
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

function parseIdList(raw: string): string[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error("rerank response was not a JSON array");
  }
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  return IdListSchema.parse(parsed);
}

export function createAnthropicChunkReranker(
  creds: Pick<RerankConfig, "apiKey" | "model" | "baseUrl">,
  opts: { anthropic?: AnthropicLike } = {}
): AnthropicChunkReranker {
  const anthropic =
    opts.anthropic ??
    (new Anthropic({
      apiKey: creds.apiKey,
      baseURL: creds.baseUrl,
      timeout: RERANK_REQUEST_TIMEOUT_MS,
    }) as unknown as AnthropicLike);
  return {
    async permute(query, candidates) {
      const message = await anthropic.messages.create({
        model: creds.model,
        max_tokens: maxTokensForCandidates(candidates.length),
        system: SYSTEM_PROMPT,
        thinking: { type: "disabled" },
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              query,
              chunks: candidates.map((c) => ({
                id: c.id,
                content: c.content,
              })),
            }),
          },
        ],
      });
      return parseIdList(textOf(message));
    },
  };
}
