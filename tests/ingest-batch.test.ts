import { beforeEach, describe, expect, it } from "vitest";

import { INGEST_BATCH_LIMIT_VAR } from "../src/config.js";
import {
  createIngestHandler,
  type IngestDeps,
  type IngestInput,
} from "../src/tools/ingest.js";
import { FakeEmbedder } from "../src/core/embedder.js";
import { GraphragError } from "../src/core/errors.js";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";

const DIM = 32;
const SOURCE_REF = "t7/batch";
const VALID_AT = "2099-01-01T00:00:00.000Z";

type T7Deps = IngestDeps & { batchLimit?: number };

function makeDeps(batchLimit?: number): T7Deps {
  const deps: T7Deps = {
    embedder: new FakeEmbedder(DIM),
    storage: new MemoryBackend(DIM),
  };
  if (batchLimit !== undefined) deps.batchLimit = batchLimit;
  return deps;
}

function batchInput(contents: string[]): IngestInput {
  return {
    content: contents,
    source_ref: SOURCE_REF,
  };
}

function chunkIds(result: { content: unknown }): string[] {
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return (JSON.parse(text) as { chunk_ids: string[] }).chunk_ids;
}

async function storedCount(deps: T7Deps): Promise<number> {
  const [probe] = await deps.embedder.embed(["row-count probe"]);
  return (
    await (deps.storage as MemoryBackend).search(probe!, {
      limit: 100,
      validAt: VALID_AT,
    })
  ).length;
}

describe("T7 batch ingest", () => {
  let deps: T7Deps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("accepts a single item through the batch-capable ingest surface", async () => {
    const ingest = createIngestHandler(deps);

    const ids = chunkIds(await ingest(batchInput(["single item"])));

    expect(ids).toHaveLength(1);
    expect(await storedCount(deps)).toBe(1);
  });

  it("rejects an empty batch with INVALID_INPUT and writes zero rows", async () => {
    const ingest = createIngestHandler({
      ...deps,
      batchLimit: 3,
    });

    const error = await ingest(batchInput([])).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(await storedCount(deps)).toBe(0);
  });

  it("rejects a missing injected batch limit with ConfigError", async () => {
    const ingest = createIngestHandler({
      ...deps,
      batchLimit: undefined,
    });

    await expect(ingest(batchInput(["one item"]))).rejects.toMatchObject({
      name: "ConfigError",
    });
    expect(await storedCount(deps)).toBe(0);
  });

  it("uses the configured environment batch limit when no override is injected", async () => {
    const previous = process.env[INGEST_BATCH_LIMIT_VAR];
    process.env[INGEST_BATCH_LIMIT_VAR] = "1";
    try {
      const ingest = createIngestHandler(deps);
      const error = await ingest(batchInput(["first", "second"])).catch(
        (caught: unknown) => caught
      );

      expect(error).toMatchObject({
        code: "BATCH_LIMIT_EXCEEDED",
        name: "BatchLimitExceededError",
      });
      expect(await storedCount(deps)).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[INGEST_BATCH_LIMIT_VAR];
      else process.env[INGEST_BATCH_LIMIT_VAR] = previous;
    }
  });

  it("accepts a batch exactly at the configured limit", async () => {
    const limit = 3;
    const ingest = createIngestHandler({
      ...deps,
      batchLimit: limit,
    });

    const ids = chunkIds(
      await ingest(batchInput(["first", "second", "third"]))
    );

    expect(ids).toHaveLength(limit);
    expect(await storedCount(deps)).toBe(limit);
  });

  it("returns a named overflow error for limit plus one without truncating or writing", async () => {
    const limit = 3;
    const ingest = createIngestHandler({
      ...deps,
      batchLimit: limit,
    });

    const error = await ingest(
      batchInput(["first", "second", "third", "tail"])
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({
      code: "BATCH_LIMIT_EXCEEDED",
      name: "BatchLimitExceededError",
    });
    expect((error as Error).message).toContain("actual count 4");
    expect((error as Error).message).toContain("limit 3");
    expect(await storedCount(deps)).toBe(0);
  });

  it("re-submits an idempotency-identical batch without adding rows", async () => {
    const ingest = createIngestHandler({
      ...deps,
      batchLimit: 3,
    });
    const contents = ["same first", "same second", "same third"];

    const first = chunkIds(await ingest(batchInput(contents)));
    const second = chunkIds(await ingest(batchInput(contents)));

    expect(second).toEqual(first);
    expect(await storedCount(deps)).toBe(contents.length);
  });

  it("keeps concurrent identical batch submissions on the same rows", async () => {
    const ingest = createIngestHandler({
      ...deps,
      batchLimit: 2,
    });
    const contents = ["parallel first", "parallel second"];

    const results = await Promise.all(
      Array.from({ length: 16 }, () => ingest(batchInput(contents)))
    );
    const idSets = results.map(chunkIds);

    expect(idSets[0]).toHaveLength(contents.length);
    for (const ids of idSets) expect(ids).toEqual(idSets[0]);
    expect(await storedCount(deps)).toBe(contents.length);
  });

  it("rejects an invalid item before writing any part of the batch", async () => {
    const ingest = createIngestHandler({
      ...deps,
      batchLimit: 3,
    });

    const error = await ingest(batchInput(["valid", ""])).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(GraphragError);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(await storedCount(deps)).toBe(0);
  });
});
