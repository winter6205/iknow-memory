import { describe, expect, it } from "vitest";

import {
  computeContentIdentity,
  createIngestHandler,
  type IngestDeps,
} from "../src/tools/ingest.js";
import { FakeEmbedder } from "../src/core/embedder.js";
import { GraphragError } from "../src/core/errors.js";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";
import type { StorageBackend } from "../src/core/types.js";

const TEST_DIM = 32;
const SOURCE_REF = "t5/idempotency";
const CONTENT = "same pushed content";
const VALID_AT = "2099-01-01T00:00:00.000Z";

function makeDeps(): IngestDeps & {
  embedder: FakeEmbedder;
  storage: MemoryBackend;
} {
  const embedder = new FakeEmbedder(TEST_DIM);
  const storage = new MemoryBackend(TEST_DIM);
  return { embedder, storage };
}

function chunkIdsOf(result: { content: unknown }): string[] {
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return (JSON.parse(text) as { chunk_ids: string[] }).chunk_ids;
}

async function storedCount(
  deps: IngestDeps & { embedder: FakeEmbedder; storage: MemoryBackend }
): Promise<number> {
  const [queryEmbedding] = await deps.embedder.embed([CONTENT]);
  return (
    await deps.storage.search(queryEmbedding!, {
      limit: 100,
      validAt: VALID_AT,
    })
  ).length;
}

describe("T5 ingest idempotency", () => {
  it("hashes text and every version component deterministically", () => {
    const versions = {
      normalizationRuleVersion: "normalization-v1",
      parseRuleVersion: "parse-v1",
      parameterTableVersion: "parameters-v1",
    };
    const identity = computeContentIdentity(CONTENT, versions);

    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentIdentity(CONTENT, versions)).toBe(identity);
    expect(
      computeContentIdentity(CONTENT, {
        ...versions,
        normalizationRuleVersion: "normalization-v2",
      })
    ).not.toBe(identity);
    expect(
      computeContentIdentity(CONTENT, {
        ...versions,
        parseRuleVersion: "parse-v2",
      })
    ).not.toBe(identity);
    expect(
      computeContentIdentity(CONTENT, {
        ...versions,
        parameterTableVersion: "parameters-v2",
      })
    ).not.toBe(identity);
    expect(computeContentIdentity(`${CONTENT}!`, versions)).not.toBe(identity);
  });

  it("repeating the same push three times returns one stable id and adds zero rows", async () => {
    const deps = makeDeps();
    const ingest = createIngestHandler(deps);

    const ids = [
      chunkIdsOf(await ingest({ content: CONTENT, source_ref: SOURCE_REF })),
      chunkIdsOf(await ingest({ content: CONTENT, source_ref: SOURCE_REF })),
      chunkIdsOf(await ingest({ content: CONTENT, source_ref: SOURCE_REF })),
    ];

    expect(ids[0]).toHaveLength(1);
    expect(ids[1]).toEqual(ids[0]);
    expect(ids[2]).toEqual(ids[0]);
    expect(await storedCount(deps)).toBe(1);
  });

  it("treats a changed content-identity version as a different key", async () => {
    const deps = makeDeps();
    const first = createIngestHandler({
      ...deps,
      identityVersions: {
        normalizationRuleVersion: "normalization-v1",
        parseRuleVersion: "parse-v1",
        parameterTableVersion: "parameters-v1",
      },
    });
    const second = createIngestHandler({
      ...deps,
      identityVersions: {
        normalizationRuleVersion: "normalization-v2",
        parseRuleVersion: "parse-v1",
        parameterTableVersion: "parameters-v1",
      },
    });

    const firstId = chunkIdsOf(
      await first({ content: CONTENT, source_ref: SOURCE_REF })
    );
    const secondId = chunkIdsOf(
      await second({ content: CONTENT, source_ref: SOURCE_REF })
    );

    expect(secondId).not.toEqual(firstId);
    expect(await storedCount(deps)).toBe(2);
  });

  it("keeps concurrent identical pushes on one row with the same id set", async () => {
    const deps = makeDeps();
    const ingest = createIngestHandler(deps);

    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        ingest({ content: CONTENT, source_ref: SOURCE_REF })
      )
    );
    const idSets = results.map(chunkIdsOf);

    for (const idSet of idSets) expect(idSet).toEqual(idSets[0]);
    expect(await storedCount(deps)).toBe(1);
  });

  it("does not count an empty content failure as an idempotent push", async () => {
    const deps = makeDeps();
    const ingest = createIngestHandler(deps);

    await expect(
      ingest({ content: "", source_ref: SOURCE_REF })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await storedCount(deps)).toBe(0);
  });

  it("preserves a typed storage exception instead of returning a false success", async () => {
    const embedder = new FakeEmbedder(TEST_DIM);
    const storage: StorageBackend = {
      upsert: async () => {
        throw new GraphragError("storage unavailable", "STORAGE_ERROR");
      },
      search: async () => [],
      close: async () => {},
    };

    await expect(
      createIngestHandler({ embedder, storage })({
        content: CONTENT,
        source_ref: SOURCE_REF,
      })
    ).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
  });
});
