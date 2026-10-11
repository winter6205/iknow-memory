import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runConfigCli } from "../../src/cli/config.js";
import {
  describeEffectiveConfig,
  formatEffectiveConfig,
} from "../../src/config/effective-config.js";
import {
  computeProcessFingerprints,
  readHttpRerankModel,
  writeProcessReport,
  type ProcessFingerprintInput,
} from "../../src/config/process-fingerprint.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import {
  INDEX_JOB_STATUS,
  type IndexJobRecord,
  type SourceDocRecord,
} from "../../src/core/types.js";
import { createRetrieveHandler } from "../../src/tools/retrieve.js";

const homes: string[] = [];

afterEach(() => {
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

function baseInput(
  overrides: Partial<ProcessFingerprintInput> = {}
): ProcessFingerprintInput {
  return {
    generationId: "1",
    searchMode: "graph",
    neighborWidth: 1,
    rerankAdapter: "llm",
    rerankModel: "rerank-a",
    rerankBaseUrl: "https://llm.example/v1",
    extractProtocol: "anthropic",
    extractModel: "extract-a",
    extractBaseUrl: "https://extract.example/v1",
    apiKey: "secret-a",
    dashboardPort: 4174,
    ...overrides,
  };
}

function job(id: string, sourceRef: string): IndexJobRecord {
  return {
    job_id: id,
    source_ref: sourceRef,
    content_identity: "content-1",
    status: INDEX_JOB_STATUS.IN_PROGRESS,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    failure_code: null,
  };
}

function source(sourceRef: string): SourceDocRecord {
  return {
    id: sourceRef,
    source_ref: sourceRef,
    title: null,
    content: `body ${sourceRef}`,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("process fingerprints", () => {
  it("a secret change does not change either fingerprint", () => {
    const first = computeProcessFingerprints(baseInput({ apiKey: "secret-a" }));
    const second = computeProcessFingerprints(
      baseInput({ apiKey: "secret-b" })
    );
    expect(first.retrieval).toBe(second.retrieval);
    expect(first.extraction).toBe(second.extraction);
  });

  it("a dashboard port change does not change the retrieval fingerprint", () => {
    const first = computeProcessFingerprints(
      baseInput({ dashboardPort: 4174 })
    );
    const second = computeProcessFingerprints(
      baseInput({ dashboardPort: 5000 })
    );
    expect(first.retrieval).toBe(second.retrieval);
  });

  it("a rerank model change changes the retrieval fingerprint only", () => {
    const first = computeProcessFingerprints(
      baseInput({ rerankModel: "rerank-a" })
    );
    const second = computeProcessFingerprints(
      baseInput({ rerankModel: "rerank-b" })
    );
    expect(second.retrieval).not.toBe(first.retrieval);
    expect(second.extraction).toBe(first.extraction);
  });

  it("keeps rerank URL text out of the fingerprint output", () => {
    const url = "http://rerank-secret-host.example:9999/private/rerank";
    const sameHost = computeProcessFingerprints(
      baseInput({
        rerankAdapter: "http",
        rerankModel: "bge-m3",
        rerankBaseUrl: url,
      })
    );
    const otherPath = computeProcessFingerprints(
      baseInput({
        rerankAdapter: "http",
        rerankModel: "bge-m3",
        rerankBaseUrl: "http://rerank-secret-host.example:9999/other",
      })
    );
    const otherHost = computeProcessFingerprints(
      baseInput({
        rerankAdapter: "http",
        rerankModel: "bge-m3",
        rerankBaseUrl: "http://other-rerank.example/rerank",
      })
    );
    const text = JSON.stringify(sameHost);
    expect(otherPath.retrieval).toBe(sameHost.retrieval);
    expect(otherHost.retrieval).not.toBe(sameHost.retrieval);
    expect(text).not.toContain(url);
    expect(text).not.toContain("rerank-secret-host.example");
    expect(text).not.toContain("/private/rerank");
  });

  it("changing the extract model changes extraction only and leaves the lexical epoch", () => {
    const first = computeProcessFingerprints(
      baseInput({ extractModel: "extract-a" })
    );
    const second = computeProcessFingerprints(
      baseInput({ extractModel: "extract-b" })
    );
    expect(second.extraction).not.toBe(first.extraction);
    expect(second.retrieval).toBe(first.retrieval);
    expect(second.epoch).toBe(first.epoch);
  });

  it("reads the HTTP rerank model from origin /health and names unresolved when health does not answer", async () => {
    const url = "http://rerank-secret-host.example:9999/private/rerank";
    const model = await readHttpRerankModel(url, async (requested) => {
      expect(String(requested)).toBe(
        "http://rerank-secret-host.example:9999/health"
      );
      expect(String(requested)).not.toContain("/private/rerank");
      return new Response(JSON.stringify({ model: "bge-m3" }), { status: 200 });
    });
    expect(model).toBe("bge-m3");

    const unresolved = await readHttpRerankModel(url, async () => {
      throw new Error("health down");
    });
    expect(unresolved).toBe("unresolved");
    const fingerprints = computeProcessFingerprints(
      baseInput({
        rerankAdapter: "http",
        rerankModel: unresolved,
        rerankBaseUrl: url,
      })
    );
    expect(fingerprints.gaps).toContain("rerank model unresolved");
    const text = formatEffectiveConfig(
      describeEffectiveConfig({
        env: {},
        setting: {},
        homeEnv: {},
        cwdEnvLocalPresent: false,
        gaps: fingerprints.gaps,
      })
    );
    expect(text).toContain("gap: rerank model unresolved");
    expect(text).not.toContain(url);
    expect(text).not.toContain("rerank-secret-host.example");
  });
});

describe("extraction fingerprint rows", () => {
  it("a new index job stores an extraction fingerprint and a second model leaves the first row unchanged and the summary says mixed", async () => {
    const firstPrint = computeProcessFingerprints(
      baseInput({ extractModel: "extract-a" })
    );
    const secondPrint = computeProcessFingerprints(
      baseInput({ extractModel: "extract-b" })
    );
    expect(secondPrint.retrieval).toBe(firstPrint.retrieval);
    expect(secondPrint.epoch).toBe(firstPrint.epoch);

    const backend = new MemoryBackend(8);
    await backend.upsertSourceDoc(source("src-a"));
    await backend.insertJobOrJoin(job("job-a", "src-a"));
    await backend.stampExtractionFingerprint({
      jobId: "job-a",
      sourceRef: "src-a",
      fingerprint: firstPrint.extraction,
    });
    await backend.upsertSourceDoc(source("src-b"));
    await backend.insertJobOrJoin(job("job-b", "src-b"));
    await backend.stampExtractionFingerprint({
      jobId: "job-b",
      sourceRef: "src-b",
      fingerprint: secondPrint.extraction,
    });

    await backend.stampExtractionFingerprint({
      jobId: "job-a",
      sourceRef: "src-a",
      fingerprint: secondPrint.extraction,
    });
    const kept = await backend.upsertSourceDoc({
      ...source("src-a"),
      extraction_fingerprint: secondPrint.extraction,
    });
    const other = await backend.upsertSourceDoc(source("src-b"));
    const stored = await backend.getJob("job-a");

    expect(stored?.extraction_fingerprint).toBe(firstPrint.extraction);
    expect(kept.extraction_fingerprint).toBe(firstPrint.extraction);
    expect(JSON.stringify(stored)).not.toContain("lexical_epoch");
    const text = formatEffectiveConfig(
      describeEffectiveConfig({
        env: {},
        setting: {},
        homeEnv: {},
        cwdEnvLocalPresent: false,
        sourceExtractionFingerprints: [
          kept.extraction_fingerprint ?? null,
          other.extraction_fingerprint ?? null,
        ],
      })
    );
    expect(text).toContain("mixed");
  });
});

describe("show process reports and embed freeze", () => {
  it("names a recorded process fingerprint that differs from the current process", async () => {
    const home = mkdtempSync(join(tmpdir(), "iknow-fp-"));
    homes.push(home);
    await writeProcessReport(home, "mcp", {
      retrieval: "recorded-retrieval",
      extraction: "same-extraction",
      generationId: "1",
      epoch: "epoch-1",
    });
    const writes: string[] = [];
    const stdout: string[] = [];
    await runConfigCli(
      { kind: "show" },
      {
        store: {
          path: join(home, "setting.json"),
          read: async () => ({}),
          write: async () => {
            writes.push("write");
          },
        },
        stdout: (line) => stdout.push(line),
        stderr: () => {},
        env: {
          GRAPHRAG_MEMORY_EMBED_MODEL: "effective-model",
          GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        },
        cwd: home,
        currentFingerprints: {
          retrieval: "current-retrieval",
          extraction: "same-extraction",
        },
        recordedGeneration: { model: "stored-model", dimensions: 8 },
      }
    );
    const text = stdout.join("\n");
    expect(text).toContain("process report mismatch: mcp");
    expect(text).toContain("process report gap: dashboard");
    expect(text).toContain("process report gap: index-worker");
    expect(text).not.toContain("process report match");
    expect(text).toContain("embed generation mismatch: model");
    expect(text).toContain("embed generation mismatch: dimensions");
    expect(writes).toEqual([]);
  });
});

describe("retrieve envelope", () => {
  it("returns the retrieval fingerprint, generation id, and epoch", async () => {
    const embedder = new FakeEmbedder(8);
    const storage = new MemoryBackend(8);
    const [vec] = await embedder.embed(["alpha marker"]);
    await storage.upsert([
      {
        id: "a",
        content: "alpha marker",
        embedding: vec!,
        source_ref: "docs/a.md",
        metadata: {},
        valid_from: "2024-01-01T00:00:00.000Z",
        valid_until: null,
        created_at: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const handler = createRetrieveHandler({
      embedder,
      storage,
      retrievalIdentity: {
        retrievalFingerprint: "fp-retrieval",
        generationId: "1",
        epoch: "epoch-hash",
      },
    });
    const result = await handler({ query: "alpha marker" });
    const body = JSON.parse(result.content[0]?.text ?? "{}") as Record<
      string,
      unknown
    >;
    expect(Object.keys(body)).toEqual([
      "chunks",
      "retrieval_fingerprint",
      "generation_id",
      "epoch",
    ]);
    expect(body.retrieval_fingerprint).toBe("fp-retrieval");
    expect(body.generation_id).toBe("1");
    expect(body.epoch).toBe("epoch-hash");
  });
});
