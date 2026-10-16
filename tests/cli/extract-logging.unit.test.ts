/**
 * SC10 process logs for the extract path (specs/graph-rerank-boot-and-evidence.md,
 * assumption 9): one extract chunk and one entity embed emit structured fields
 * { time | chunkId | modelId | latencyMs | outcome | counts } — and the payload
 * never carries chunk body text or an API key.
 *
 * The same fake-pool harness as tests/cli/extract.unit.test.ts keeps this a
 * unit test; the recording logger captures every leveled call so the exact
 * field set is assertable.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";

import {
  runCli,
  type CliClient,
  type CliPool,
  type CliDeps,
} from "../../src/cli/extract.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder, type EmbeddingClient } from "../../src/core/embedder.js";
import type { Logger } from "../../src/logging.js";

const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

beforeAll(() => {
  process.env[ANN_MAX_DIMENSIONS_VAR] = "2000";
});

afterAll(() => {
  if (savedAnnMaxDimensions === undefined)
    delete process.env[ANN_MAX_DIMENSIONS_VAR];
  else process.env[ANN_MAX_DIMENSIONS_VAR] = savedAnnMaxDimensions;
});

const CHUNK_ID = "00000000-0000-4000-8000-000000000000";
/**
 * Distinctive markers planted where a leak would show: the chunk body and an
 * API-key-shaped string. None of them may ever appear in a log payload.
 */
const CHUNK_CONTENT = "CANARY-CHUNK-BODY Alice Smith works at Acme Corp.";
const CANARY_KEY = "sk-canary-api-key-1234567890";

const ALICE_OUTPUT = {
  head: "Alice Smith",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "MEMBER_OF",
  tail: "Acme Corp",
  tailType: "organization",
  description: "Alice Smith works at Acme Corp",
  evidenceSpan: "Alice Smith works at Acme Corp",
  confidence: 0.9,
};

class FakeClient implements CliClient {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  async query(text: string, values?: unknown[]) {
    this.queries.push(text);
    this.valuesList.push(values ?? []);
    const chunk = { id: CHUNK_ID, content: `${CHUNK_CONTENT} ${CANARY_KEY}` };
    // Phase E stages outputs only, so the commit phase re-reads the chunk text
    // by id; and the caller's partition query names the source.
    if (text.includes("FROM chunks c WHERE c.id = $1")) return { rows: [chunk] };
    if (text.includes("SELECT c.id, c.source_ref FROM chunks c")) {
      return { rows: [{ id: CHUNK_ID, source_ref: "doc-1" }] };
    }
    return { rows: /FROM chunks c/.test(text) ? [chunk] : [] };
  }
  release(): void {}
}

function makePool(client: FakeClient): CliPool {
  return {
    async connect() {
      return client;
    },
    async end() {},
  };
}

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

/** FakeEmbedder wearing a model id, as production wiring would surface. */
function embedderWithModel(dim: number, modelId: string): EmbeddingClient {
  const inner = new FakeEmbedder(dim);
  return { modelId, embed: (texts) => inner.embed(texts) };
}

function makeDeps(
  client: FakeClient,
  llm: FakeLLMClient,
  logger: Logger,
  embedder: EmbeddingClient = embedderWithModel(8, "test-embed-model")
): CliDeps {
  return {
    pool: makePool(client),
    llm,
    embedder,
    dims: 8,
    logger,
    now: () => "2026-09-05T00:00:00.000Z",
  };
}

describe("extract chunk process logs (SC10)", () => {
  it("a successful chunk emits chunk-extracted with the whitelisted fields and no body", async () => {
    const client = new FakeClient();
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
      modelId: "test-llm-model",
    });
    const { logger, lines } = recordingLogger();

    const code = await runCli(
      ["--batch-size", "1"],
      makeDeps(client, llm, logger)
    );

    expect(code).toBe(0);
    const extracted = lines.find((l) => l.msg === "chunk-extracted");
    expect(extracted).toBeDefined();
    expect(extracted!.fields).toMatchObject({
      chunkId: CHUNK_ID,
      modelId: "test-llm-model",
      outcome: "ok",
      triples: 1,
      unmapped: 0,
      ungrounded: 0,
    });
    expect(typeof extracted!.fields!.time).toBe("string");
    expect(typeof extracted!.fields!.latencyMs).toBe("number");
    expect(extracted!.fields!.latencyMs as number).toBeGreaterThanOrEqual(0);
  });

  it("a failed chunk emits chunk-failed carrying modelId, latencyMs and outcome=failed", async () => {
    const client = new FakeClient();
    const llm = new FakeLLMClient({
      scripted: async () => ({
        kind: "5xx" as const,
        message: "upstream exploded",
      }),
      modelId: "test-llm-model",
    });
    const { logger, lines } = recordingLogger();

    const code = await runCli(
      ["--batch-size", "1"],
      makeDeps(client, llm, logger)
    );

    expect(code).toBe(0); // mark-and-continue: the batch still exits 0
    const failed = lines.find((l) => l.msg === "chunk-failed");
    expect(failed).toBeDefined();
    expect(failed!.fields).toMatchObject({
      chunkId: CHUNK_ID,
      modelId: "test-llm-model",
      outcome: "failed",
    });
    expect(typeof failed!.fields!.time).toBe("string");
    expect(typeof failed!.fields!.latencyMs).toBe("number");
    expect(failed!.fields!.latencyMs as number).toBeGreaterThanOrEqual(0);
  });

  it("entity embeds emit entity-embed with modelId, latencyMs and outcome=ok", async () => {
    const client = new FakeClient();
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
      modelId: "test-llm-model",
    });
    const { logger, lines } = recordingLogger();

    const code = await runCli(
      ["--batch-size", "1"],
      makeDeps(client, llm, logger)
    );

    expect(code).toBe(0);
    // head + tail, one embed call per created entity.
    const embeds = lines.filter((l) => l.msg === "entity-embed");
    expect(embeds).toHaveLength(2);
    for (const embed of embeds) {
      expect(embed.fields).toMatchObject({
        modelId: "test-embed-model",
        outcome: "ok",
      });
      expect(typeof embed.fields!.latencyMs).toBe("number");
      expect(embed.fields!.latencyMs as number).toBeGreaterThanOrEqual(0);
    }
  });

  it("the log payload never contains the chunk body or an API key", async () => {
    const client = new FakeClient();
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
      modelId: "test-llm-model",
    });
    const { logger, lines } = recordingLogger();

    await runCli(["--batch-size", "1"], makeDeps(client, llm, logger));

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("CANARY-CHUNK-BODY");
    expect(serialized).not.toContain(CANARY_KEY);
  });
});
