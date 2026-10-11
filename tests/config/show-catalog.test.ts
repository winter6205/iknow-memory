/**
 * Operator `show` reads the embedding singleton and source extraction
 * fingerprints through an injected reader. No live Postgres.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentProcessFingerprints,
  main,
  readShowCatalog,
  runConfigCli,
  showCatalogReaderForEnv,
  type ShowCatalogReader,
} from "../../src/cli/config.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-show-catalog-"));
  homes.push(dir);
  return dir;
}

function deps(
  dir: string,
  extra: {
    readCatalog?: ShowCatalogReader;
    readFingerprints?: () => Promise<{
      fingerprints?: { retrieval: string; extraction: string };
      gaps: readonly string[];
    }>;
  }
) {
  const stdout: string[] = [];
  return {
    stdout,
    run: runConfigCli(
      { kind: "show" },
      {
        store: {
          path: join(dir, "setting.json"),
          read: async () => ({}),
          write: async () => {
            throw new Error("show must not write the setting file");
          },
        },
        stdout: (line) => stdout.push(line),
        stderr: () => {},
        env: {
          GRAPHRAG_MEMORY_EMBED_MODEL: "effective-model",
          GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "8",
        },
        cwd: dir,
        ...extra,
      }
    ),
  };
}

describe("iknow-memory-config show catalog", () => {
  it("prints mixed and an embed model mismatch from the reader", async () => {
    const captured = deps(home(), {
      readCatalog: async () => ({
        recordedGeneration: { model: "stored-model", dimensions: 8 },
        sourceExtractionFingerprints: ["extract-a", "extract-b"],
      }),
    });
    const result = await captured.run;
    expect(result.code).toBe(0);
    const text = captured.stdout.join("\n");
    expect(text).toContain("extraction fingerprints: mixed");
    expect(text).toContain("embed generation mismatch: model");
  });

  it("prints embed generation not read when the reader throws and still exits 0", async () => {
    const captured = deps(home(), {
      readCatalog: async () => {
        throw new Error("postgres down");
      },
    });
    const result = await captured.run;
    expect(result.code).toBe(0);
    expect(captured.stdout.join("\n")).toContain(
      "gap: embed generation not read"
    );
  });

  it("prints a gap when process fingerprints cannot be loaded", async () => {
    const compared = await currentProcessFingerprints(() => {
      throw new Error("env unusable");
    });
    const dir = home();
    const stdout: string[] = [];
    const result = await runConfigCli(
      { kind: "show" },
      {
        store: {
          path: join(dir, "setting.json"),
          read: async () => ({}),
          write: async () => {
            throw new Error("show must not write the setting file");
          },
        },
        stdout: (line) => stdout.push(line),
        stderr: () => {},
        env: {},
        cwd: dir,
        currentFingerprints: compared.fingerprints,
        gaps: compared.gaps,
      }
    );
    expect(result.code).toBe(0);
    expect(stdout.join("\n")).toContain("gap: process fingerprints not read");
  });

  it("reports source counts for each extraction fingerprint group and says mixed", async () => {
    const queries: string[] = [];
    const snapshot = await readShowCatalog(async (sql) => {
      queries.push(sql);
      if (sql.includes("source_documents")) {
        return {
          rows: [
            { extraction_fingerprint: "fp-a", source_count: 3 },
            { extraction_fingerprint: "fp-b", source_count: 1 },
          ],
        };
      }
      return { rows: [] };
    });
    const fingerprintSql = queries.find((sql) =>
      sql.includes("source_documents")
    );
    expect(fingerprintSql).toMatch(/^\s*SELECT\b/i);
    expect(fingerprintSql).toMatch(/COUNT\s*\(/i);
    expect(fingerprintSql).toMatch(/GROUP BY\s+extraction_fingerprint/i);
    expect(fingerprintSql).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER)\b/i);

    const captured = deps(home(), { readCatalog: async () => snapshot });
    const result = await captured.run;
    expect(result.code).toBe(0);
    expect(captured.stdout.join("\n")).toContain(
      "extraction fingerprints: mixed fp-a=3 fp-b=1"
    );
  });

  it("counts null and blank fingerprints as one group and does not call that mixed", async () => {
    const snapshot = await readShowCatalog(async (sql) => {
      if (sql.includes("source_documents")) {
        return {
          rows: [
            { extraction_fingerprint: "fp-a", source_count: 3 },
            { extraction_fingerprint: null, source_count: 2 },
            { extraction_fingerprint: "", source_count: 2 },
          ],
        };
      }
      return { rows: [] };
    });
    const captured = deps(home(), { readCatalog: async () => snapshot });
    const result = await captured.run;
    expect(result.code).toBe(0);
    const text = captured.stdout.join("\n");
    expect(text).toContain("extraction fingerprints: fp-a=3 empty=4");
    expect(text).not.toContain("extraction fingerprints: mixed");
  });

  it("still says mixed when null rows sit beside two non-empty fingerprint groups", async () => {
    const snapshot = await readShowCatalog(async (sql) => {
      if (sql.includes("source_documents")) {
        return {
          rows: [
            { extraction_fingerprint: "fp-a", source_count: 3 },
            { extraction_fingerprint: null, source_count: 2 },
            { extraction_fingerprint: "fp-b", source_count: 1 },
          ],
        };
      }
      return { rows: [] };
    });
    const captured = deps(home(), { readCatalog: async () => snapshot });
    const result = await captured.run;
    expect(result.code).toBe(0);
    expect(captured.stdout.join("\n")).toContain(
      "extraction fingerprints: mixed fp-a=3 fp-b=1 empty=2"
    );
  });

  it("adds embed generation not read when catalog setup throws", async () => {
    const dir = home();
    const previousHome = process.env.IKNOW_MEMORY_HOME;
    const previousStorage = process.env.GRAPHRAG_MEMORY_STORAGE;
    process.env.IKNOW_MEMORY_HOME = dir;
    process.env.GRAPHRAG_MEMORY_STORAGE = "not-a-storage";
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number
    ) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as typeof process.exit);
    try {
      await expect(main(["show"])).rejects.toThrow("process.exit:0");
      expect(chunks.join("")).toContain("gap: embed generation not read");
    } finally {
      write.mockRestore();
      exit.mockRestore();
      if (previousHome === undefined) delete process.env.IKNOW_MEMORY_HOME;
      else process.env.IKNOW_MEMORY_HOME = previousHome;
      if (previousStorage === undefined)
        delete process.env.GRAPHRAG_MEMORY_STORAGE;
      else process.env.GRAPHRAG_MEMORY_STORAGE = previousStorage;
    }
  });

  it("does not open a database when storage is not pgvector", () => {
    const opened: string[] = [];
    const reader = showCatalogReaderForEnv(
      { storage: "memory", dbUrl: "postgres://db.example/mem" },
      (dbUrl) => {
        opened.push(dbUrl);
        return async () => ({
          recordedGeneration: null,
          sourceExtractionFingerprints: [],
        });
      }
    );
    expect(reader).toBeUndefined();
    expect(opened).toEqual([]);
  });
});
