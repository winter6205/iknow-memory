/**
 * SC10 process logs for the embed call sites (specs/graph-rerank-boot-and-evidence.md,
 * assumption 9): one `embedder.embed(...)` call emits ONE structured log with
 * { time | modelId | itemCount | latencyMs | outcome } — not per item — and on
 * failure the log fires before the original GraphragError rethrows, so the
 * handler's error contract is unchanged.
 */
import { describe, it, expect } from "vitest";

import {
  createIngestHandler,
  type IngestDeps,
} from "../../src/tools/ingest.js";
import { createPushHandler, type PushDeps } from "../../src/tools/push.js";
import { FakeEmbedder, type EmbeddingClient } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import type { Logger } from "../../src/logging.js";

const TEST_DIM = 1536;

interface LoggedLine {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

function recordingLogger(): { logger: Logger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = [];
  const logger: Logger = {
    level: "info",
    debug: () => {},
    info: (msg, fields) => void lines.push({ level: "info", msg, fields }),
    warn: (msg, fields) => void lines.push({ level: "warn", msg, fields }),
    error: (msg, fields) => void lines.push({ level: "error", msg, fields }),
  };
  return { logger, lines };
}

function embedderWithModel(modelId: string): EmbeddingClient {
  const inner = new FakeEmbedder(TEST_DIM);
  return { modelId, embed: (texts) => inner.embed(texts) };
}

function throwingEmbedder(message: string): EmbeddingClient {
  return {
    embed: async () => {
      throw new GraphragError(message, "EMBEDDING_FAILED");
    },
  };
}

const CANARY_CONTENT = "CANARY-EMBED-BODY should never be logged";

describe("ingest embed process log (SC10)", () => {
  it("a successful embed emits one embed call with modelId, itemCount and latencyMs", async () => {
    const { logger, lines } = recordingLogger();
    const deps: IngestDeps = {
      embedder: embedderWithModel("test-embed-model"),
      storage: new MemoryBackend(TEST_DIM),
      logger,
    };
    const handler = createIngestHandler(deps);

    await handler({
      content: [CANARY_CONTENT, "second item"],
      source_ref: "docs/logs.md",
    });

    const embeds = lines.filter((l) => l.msg === "embed");
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.fields).toMatchObject({
      modelId: "test-embed-model",
      itemCount: 2,
      outcome: "ok",
    });
    expect(typeof embeds[0]!.fields!.time).toBe("string");
    expect(typeof embeds[0]!.fields!.latencyMs).toBe("number");
    expect(embeds[0]!.fields!.latencyMs as number).toBeGreaterThanOrEqual(0);
    // The whitelist: content text never travels with the log line.
    expect(JSON.stringify(lines)).not.toContain(CANARY_CONTENT);
  });

  it("a throwing embedder emits outcome=failed before the GraphragError rethrows", async () => {
    const { logger, lines } = recordingLogger();
    const deps: IngestDeps = {
      embedder: throwingEmbedder("embedding credentials are not configured"),
      storage: new MemoryBackend(TEST_DIM),
      logger,
    };
    const handler = createIngestHandler(deps);

    await expect(
      handler({
        content: CANARY_CONTENT,
        source_ref: "docs/logs.md",
      })
    ).rejects.toBeInstanceOf(GraphragError);

    const embeds = lines.filter((l) => l.msg === "embed");
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.level).toBe("error");
    expect(embeds[0]!.fields).toMatchObject({
      outcome: "failed",
      itemCount: 1,
    });
  });
});

describe("push embed process log (SC10)", () => {
  const item = {
    content: CANARY_CONTENT,
    source_ref: "docs/push-log.md",
    metadata: { kind: "test" },
    valid_from: "2024-01-01T00:00:00Z",
    valid_until: "2024-12-31T00:00:00Z",
  };

  it("a successful embed emits one embed call with modelId, itemCount and latencyMs", async () => {
    const { logger, lines } = recordingLogger();
    const deps: PushDeps = {
      embedder: embedderWithModel("test-embed-model"),
      storage: new MemoryBackend(TEST_DIM),
      logger,
    };
    const handler = createPushHandler(deps);

    await handler({ items: [item, { ...item, source_ref: "docs/other.md" }] });

    const embeds = lines.filter((l) => l.msg === "embed");
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.fields).toMatchObject({
      modelId: "test-embed-model",
      itemCount: 2,
      outcome: "ok",
    });
    expect(JSON.stringify(lines)).not.toContain(CANARY_CONTENT);
  });

  it("a throwing embedder emits outcome=failed before the GraphragError rethrows", async () => {
    const { logger, lines } = recordingLogger();
    const deps: PushDeps = {
      embedder: throwingEmbedder("embedding request failed: network down"),
      storage: new MemoryBackend(TEST_DIM),
      logger,
    };
    const handler = createPushHandler(deps);

    await expect(handler({ items: [item] })).rejects.toBeInstanceOf(
      GraphragError
    );

    const embeds = lines.filter((l) => l.msg === "embed");
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.level).toBe("error");
    expect(embeds[0]!.fields).toMatchObject({
      outcome: "failed",
      itemCount: 1,
    });
  });
});
