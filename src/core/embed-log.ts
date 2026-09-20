/**
 * The shared embed-boundary module.
 *
 * SC10 embed process log — the ONE shared contract for every
 * `embedder.embed(...)` call site (src/tools/ingest.ts, src/tools/push.ts,
 * src/cli/extract.ts entity embedding). Also hosts `embedTextForSlice`, the
 * chunk embed-input wrap (specs/contextual-wrap-embed.md), so wrap and log
 * stay one authoritative boundary the tools import from.
 *
 * One structured entry per embed call (not per item), whitelist fields only.
 * Content text, entity SSOT text and embeddings never travel with the line;
 * `redactDiagnostic` in logging.ts stays URL/credential redaction, not a body
 * scanner, so it cannot rescue a body string passed as a field value.
 */
import type { EmbeddingClient } from "./embedder.js";
import type { Logger } from "../logging.js";

/**
 * Contextual wrap for the CHUNK embed input (specs/contextual-wrap-embed.md):
 * a non-empty 资料 `title` is prepended to the slice text, `title\nslice`.
 * Null / empty / whitespace-only title → the slice verbatim.
 *
 * EMBED-INPUT ONLY — the stored chunk `content` and 资料 `content` stay the
 * pushed bytes, and the retrieve query side never calls this (raw query).
 * Pure string concat, not keyed on entity type; a wrap "failure" is
 * impossible, so the existing embed hard-fail stays the only failure path.
 */
export function embedTextForSlice(
  title: string | null | undefined,
  sliceContent: string
): string {
  if (title == null || title.trim() === "") {
    return sliceContent;
  }
  return `${title}\n${sliceContent}`;
}

/**
 * Emit the SC10 embed log around a single `embedder.embed(...)` call.
 *
 * `eventName` keeps the historical event names (tools emit "embed", the
 * extract CLI emits "entity-embed"); `now` lets the CLI honor its injectable
 * clock for the `time` field; `itemCount` is included only when the call
 * site carries a batch (the entity path embeds one text and omits it, as
 * its tests assert). `time`, `modelId` and `latencyMs` are always present.
 * On failure the log fires before the original error rethrows, so callers'
 * error contracts are unchanged.
 */
export async function embedWithLog(
  logger: Logger | undefined,
  embedder: EmbeddingClient,
  texts: string[],
  options: {
    eventName?: string;
    itemCount?: number;
    now?: () => string;
  } = {}
): Promise<number[][]> {
  const eventName = options.eventName ?? "embed";
  const latencyStart = Date.now();
  const fields = {
    time: options.now ? options.now() : new Date().toISOString(),
    modelId: embedder.modelId ?? null,
    ...(options.itemCount !== undefined
      ? { itemCount: options.itemCount }
      : {}),
  };
  try {
    const embeddings = await embedder.embed(texts);
    logger?.info(eventName, {
      ...fields,
      latencyMs: Date.now() - latencyStart,
      outcome: "ok",
    });
    return embeddings;
  } catch (err) {
    logger?.error(eventName, {
      ...fields,
      latencyMs: Date.now() - latencyStart,
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
