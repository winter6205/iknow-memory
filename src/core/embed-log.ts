/**
 * SC10 embed process log — the ONE shared contract for every
 * `embedder.embed(...)` call site (src/tools/ingest.ts, src/tools/push.ts,
 * src/cli/extract.ts entity embedding).
 *
 * One structured entry per embed call (not per item), whitelist fields only.
 * Content text, entity SSOT text and embeddings never travel with the line;
 * `redactDiagnostic` in logging.ts stays URL/credential redaction, not a body
 * scanner, so it cannot rescue a body string passed as a field value.
 */
import type { EmbeddingClient } from "./embedder.js";
import type { Logger } from "../logging.js";

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
