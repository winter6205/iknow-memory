/**
 * Nested operator setting projects onto the registry names loadEnv already reads.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runConfigCli, type ConfigCommand } from "../../../src/cli/config.js";
import { ConfigError, loadEnv, setSettingHomeForTests } from "../../../src/config.js";
import { createSettingStore, type SettingStore } from "../../../src/config/setting-store.js";

const SECRET = "test-key-not-a-real-secret";
const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "iknow-readable-setting-"));
  homes.push(home);
  return home;
}

function writeSetting(home: string, payload: unknown): void {
  const dir = join(home, ".iknow-memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "setting.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

const SCRUB = [
  "GRAPHRAG_MEMORY_LOG_LEVEL",
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "GRAPHRAG_MEMORY_VECTOR_API_KEY",
  "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GRAPHRAG_MEMORY_ANTHROPIC_MODEL",
  "GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL",
  "GRAPHRAG_MEMORY_JEV_API_KEY",
  "GRAPHRAG_MEMORY_JEV_MODEL",
  "GRAPHRAG_MEMORY_JEV_BASE_URL",
  "TYPESAFE_API_KEY",
  "TYPESAFE_DEFAULT_MODEL",
  "TYPESAFE_BASE_URL",
  "GRAPHRAG_MEMORY_RERANK_API_KEY_ENV",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL",
  "GRAPHRAG_MEMORY_NEO4J_URI",
  "GRAPHRAG_MEMORY_ES_URL",
  "GRAPHRAG_MEMORY_ES_NODE",
  "GRAPHRAG_MEMORY_LLM_EXTRACT_PROTOCOL",
  "GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL",
  "GRAPHRAG_MEMORY_LLM_EXTRACT_BASE_URL",
  "GRAPHRAG_MEMORY_LLM_EXTRACT_API_KEY_ENV",
  "GRAPHRAG_MEMORY_LLM_SUMMARY_PROTOCOL",
  "GRAPHRAG_MEMORY_LLM_SUMMARY_MODEL",
  "GRAPHRAG_MEMORY_LLM_SUMMARY_BASE_URL",
  "GRAPHRAG_MEMORY_LLM_SUMMARY_API_KEY_ENV",
  "GRAPHRAG_MEMORY_LLM_RERANK_PROTOCOL",
  "GRAPHRAG_MEMORY_LLM_RERANK_MODEL",
  "GRAPHRAG_MEMORY_LLM_RERANK_BASE_URL",
  "GRAPHRAG_MEMORY_LLM_RERANK_API_KEY_ENV",
  "IKNOW_TEST_OPERATOR_KEY",
  "IKNOW_TEST_EMBED_KEY",
] as const;

const BOOT: Record<string, string> = {
  GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "32",
  GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
  GRAPHRAG_MEMORY_STORAGE: "memory",
  GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "false",
  GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
  GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "false",
};

function withBoot(patch: Record<string, string | undefined>, fn: () => void): void {
  const keys = new Set<string>([...SCRUB, ...Object.keys(BOOT), ...Object.keys(patch)]);
  const saved = new Map<string, string | undefined>();
  for (const key of keys) saved.set(key, process.env[key]);
  for (const key of SCRUB) delete process.env[key];
  for (const [key, value] of Object.entries(BOOT)) process.env[key] = value;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(() => {
  setSettingHomeForTests(null);
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

describe("readable operator setting", () => {
  it("loads extract, summary, rerank, and jev from a nested setting document", () => {
    const home = tempHome();
    writeSetting(home, {
      llm: {
        extract: {
          model: "extract-model",
          baseUrl: "https://extract.example/anthropic",
          protocol: "anthropic",
          apiKey: "${IKNOW_TEST_OPERATOR_KEY}",
        },
        summary: {
          model: "summary-model",
          baseUrl: "https://summary.example/anthropic",
          protocol: "anthropic",
          apiKey: "${IKNOW_TEST_OPERATOR_KEY}",
        },
        rerank: {
          model: "rerank-model",
          baseUrl: "https://rerank.example/anthropic",
          protocol: "anthropic",
          apiKey: "${IKNOW_TEST_OPERATOR_KEY}",
        },
      },
      jev: {
        model: "jev-model",
        baseUrl: "https://jev.example",
        apiKey: "${IKNOW_TEST_OPERATOR_KEY}",
      },
    });
    setSettingHomeForTests(home);
    withBoot({ IKNOW_TEST_OPERATOR_KEY: SECRET }, () => {
      const env = loadEnv();
      expect(env.llm.extract).toMatchObject({
        model: "extract-model",
        baseUrl: "https://extract.example/anthropic",
        apiKey: SECRET,
      });
      expect(env.llm.summary).toMatchObject({
        model: "summary-model",
        baseUrl: "https://summary.example/anthropic",
        apiKey: SECRET,
      });
      expect(env.llm.rerank).toMatchObject({
        model: "rerank-model",
        baseUrl: "https://rerank.example/anthropic",
        apiKey: SECRET,
      });
      expect(env.jev).toMatchObject({
        model: "jev-model",
        baseUrl: "https://jev.example",
        apiKey: SECRET,
      });
    });
  });

  it("shows the extract model from the nested file as layer=setting", async () => {
    const home = tempHome();
    writeSetting(home, {
      llm: { extract: { model: "extract-model" } },
    });
    const text = await showText(createSettingStore({ home }), home);
    expect(text).toContain(
      "GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL=extract-model layer=setting effect=next-extraction"
    );
  });

  it("prints a ${NAME} api key name and masks a raw api key", async () => {
    const home = tempHome();
    writeSetting(home, {
      llm: { extract: { apiKey: "${IKNOW_TEST_OPERATOR_KEY}" } },
      embed: { apiKey: SECRET },
      jev: { apiKey: "${IKNOW_TEST_JEV_KEY}" },
    });
    const store = createSettingStore({ home });
    const listed = await listText(store);
    expect(listed).toContain(
      "GRAPHRAG_MEMORY_LLM_EXTRACT_API_KEY_ENV=IKNOW_TEST_OPERATOR_KEY"
    );
    expect(listed).toContain("GRAPHRAG_MEMORY_EMBED_API_KEY=configured");
    expect(listed).toContain("GRAPHRAG_MEMORY_JEV_API_KEY=IKNOW_TEST_JEV_KEY");
    expect(listed).not.toContain(SECRET);
    expect(listed).not.toContain("${IKNOW_TEST_JEV_KEY}");

    const shown = await showText(store, home);
    expect(shown).toContain(
      "GRAPHRAG_MEMORY_LLM_EXTRACT_API_KEY_ENV=IKNOW_TEST_OPERATOR_KEY layer=setting"
    );
    expect(shown).toContain(
      "GRAPHRAG_MEMORY_EMBED_API_KEY=configured layer=setting"
    );
    expect(shown).toContain(
      "GRAPHRAG_MEMORY_JEV_API_KEY=IKNOW_TEST_JEV_KEY layer=setting"
    );
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain("${IKNOW_TEST_JEV_KEY}");
  });

  it("resolves embed.apiKey ${NAME} into the embed api key and prints the name", async () => {
    const home = tempHome();
    writeSetting(home, {
      embed: {
        model: "embedding-3",
        baseUrl: "https://embed.example/v1",
        apiKey: "${IKNOW_TEST_EMBED_KEY}",
      },
    });
    setSettingHomeForTests(home);
    withBoot({ IKNOW_TEST_EMBED_KEY: SECRET }, () => {
      expect(loadEnv().embedApiKey).toBe(SECRET);
    });
    const store = createSettingStore({ home });
    const listed = await listText(store);
    const shown = await showText(store, home);
    expect(listed).toContain("GRAPHRAG_MEMORY_EMBED_API_KEY=IKNOW_TEST_EMBED_KEY");
    expect(shown).toContain(
      "GRAPHRAG_MEMORY_EMBED_API_KEY=IKNOW_TEST_EMBED_KEY layer=setting"
    );
    expect(listed).not.toContain(SECRET);
    expect(shown).not.toContain(SECRET);
  });

  it("resolves embed.apiKey from the projected embed model when that name is unset in process env", () => {
    const home = tempHome();
    writeSetting(home, {
      embed: {
        model: "embedding-3",
        baseUrl: "https://embed.example/v1",
        apiKey: "${GRAPHRAG_MEMORY_EMBED_MODEL}",
      },
    });
    setSettingHomeForTests(home);
    withBoot(
      {
        IKNOW_TEST_EMBED_KEY: undefined,
        IKNOW_ABSENT_EMBED_POINTER: undefined,
        GRAPHRAG_MEMORY_EMBED_MODEL: undefined,
        GRAPHRAG_MEMORY_EMBED_API_KEY: undefined,
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "IKNOW_ABSENT_EMBED_POINTER",
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("embedding-3");
      }
    );
  });

  it("resolves a raw llm api key without putting the secret on the display map", () => {
    const home = tempHome();
    writeSetting(home, {
      llm: { extract: { model: "extract-model", apiKey: SECRET } },
    });
    setSettingHomeForTests(home);
    withBoot({}, () => {
      expect(loadEnv().llm.extract.apiKey).toBe(SECRET);
    });
    return createSettingStore({ home })
      .read()
      .then((map) => {
        expect(Object.values(map)).not.toContain(SECRET);
        expect(map).not.toHaveProperty("__IKNOW_FILE_LLM_EXTRACT_API_KEY");
        expect(map.GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL).toBe("extract-model");
      });
  });

  it("lets process env override the same registry key from the nested file", () => {
    const home = tempHome();
    writeSetting(home, {
      llm: { extract: { model: "file-model" } },
    });
    setSettingHomeForTests(home);
    withBoot({ GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL: "env-model" }, () => {
      expect(loadEnv().llm.extract.model).toBe("env-model");
    });
  });

  it("projects a storage-only document onto GRAPHRAG_MEMORY_STORAGE", () => {
    const home = tempHome();
    writeSetting(home, { storage: "pgvector" });
    setSettingHomeForTests(home);
    withBoot(
      {
        GRAPHRAG_MEMORY_STORAGE: undefined,
        GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow",
      },
      () => {
        expect(loadEnv().storage).toBe("pgvector");
      }
    );
  });

  it("still loads a flat GRAPHRAG_MEMORY_* file without expanding ${}", () => {
    const home = tempHome();
    writeSetting(home, {
      GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL: "flat-model",
      GRAPHRAG_MEMORY_LLM_EXTRACT_BASE_URL: "${FOO}",
    });
    setSettingHomeForTests(home);
    withBoot({ FOO: "expanded-should-not-apply" }, () => {
      const env = loadEnv();
      expect(env.llm.extract.model).toBe("flat-model");
      expect(env.llm.extract.baseUrl).toBe("${FOO}");
    });
  });

  it("names an unknown field in ConfigError", async () => {
    const home = tempHome();
    const store = createSettingStore({ home });
    writeSetting(home, { llm: { extract: { extra: "nope" } } });
    await expect(store.read()).rejects.toBeInstanceOf(ConfigError);
    await expect(store.read()).rejects.toThrow(/llm\.extract\.extra/);
  });

  it("names a non-string leaf in ConfigError", async () => {
    const home = tempHome();
    const store = createSettingStore({ home });
    writeSetting(home, { llm: { extract: { model: 1 } } });
    await expect(store.read()).rejects.toBeInstanceOf(ConfigError);
    await expect(store.read()).rejects.toThrow(/llm\.extract\.model/);
  });

  it("names the file when the root mixes a section and a flat key", async () => {
    const home = tempHome();
    const store = createSettingStore({ home });
    writeSetting(home, {
      llm: { extract: { model: "extract-model" } },
      GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow",
    });
    await expect(store.read()).rejects.toBeInstanceOf(ConfigError);
    await expect(store.read()).rejects.toThrow(store.path);
  });

  it("names the path when ${ is not a whole-string placeholder", async () => {
    const home = tempHome();
    const store = createSettingStore({ home });
    writeSetting(home, {
      llm: { extract: { baseUrl: "https://example/${HOST}" } },
    });
    await expect(store.read()).rejects.toBeInstanceOf(ConfigError);
    await expect(store.read()).rejects.toThrow(/llm\.extract\.baseUrl/);
  });

  it("treats a missing file as an empty map and does not throw", () => {
    const home = tempHome();
    setSettingHomeForTests(home);
    withBoot({}, () => {
      expect(() => loadEnv()).not.toThrow();
    });
    return expect(createSettingStore({ home }).read()).resolves.toEqual({});
  });

  it("keeps a nested file nested when set and unset change a leaf", async () => {
    const home = tempHome();
    writeSetting(home, {
      llm: {
        extract: {
          model: "old-model",
          baseUrl: "https://extract.example/anthropic",
          apiKey: "${IKNOW_TEST_OPERATOR_KEY}",
        },
        summary: { model: "summary-model" },
      },
    });
    const store = createSettingStore({ home });
    expect((await run(store, home, { kind: "set", key: "GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL", value: "new-model" })).code).toBe(0);
    expect((await run(store, home, {
      kind: "set",
      key: "GRAPHRAG_MEMORY_LLM_SUMMARY_API_KEY_ENV",
      value: "IKNOW_TEST_OPERATOR_KEY",
    })).code).toBe(0);
    const setDisk = readDocument(home);
    expect(setDisk).toMatchObject({
      llm: {
        extract: {
          model: "new-model",
          baseUrl: "https://extract.example/anthropic",
          apiKey: "${IKNOW_TEST_OPERATOR_KEY}",
        },
        summary: {
          model: "summary-model",
          apiKey: "${IKNOW_TEST_OPERATOR_KEY}",
        },
      },
    });
    expect(Object.keys(setDisk).some((key) => key.startsWith("GRAPHRAG_MEMORY_"))).toBe(false);

    expect((await run(store, home, { kind: "unset", key: "GRAPHRAG_MEMORY_ANTHROPIC_MODEL" })).code).toBe(0);
    const unsetDisk = readDocument(home);
    expect(unsetDisk.llm).toMatchObject({
      extract: { baseUrl: "https://extract.example/anthropic" },
      summary: { model: "summary-model" },
    });
    expect((unsetDisk.llm as { extract: { model?: string } }).extract.model).toBeUndefined();
    expect(typeof unsetDisk.llm).toBe("object");

    expect((await run(store, home, { kind: "unset", key: "GRAPHRAG_MEMORY_EMBED_MODEL" })).code).toBe(0);
  });

  it("does not throw when a ${NAME} target or its env var is unset", () => {
    const home = tempHome();
    writeSetting(home, {
      llm: {
        extract: {
          model: "extract-model",
          apiKey: "${IKNOW_ABSENT_OPERATOR_KEY}",
        },
      },
      jev: { apiKey: "${IKNOW_ABSENT_OPERATOR_KEY}" },
      database: { url: "${IKNOW_ABSENT_OPERATOR_KEY}" },
    });
    setSettingHomeForTests(home);
    withBoot({ IKNOW_ABSENT_OPERATOR_KEY: undefined }, () => {
      expect(() => loadEnv()).not.toThrow();
      const env = loadEnv();
      expect(env.llm.extract.model).toBe("extract-model");
      expect(env.llm.extract.apiKey).toBeUndefined();
      expect(env.jev).toBeUndefined();
    });
  });

  it("refuses a registry key with no short name on a nested file", async () => {
    const home = tempHome();
    writeSetting(home, { llm: { extract: { model: "extract-model" } } });
    const store = createSettingStore({ home });
    const before = readFileSync(settingPath(home), "utf8");
    await expect(store.setKey("GRAPHRAG_MEMORY_DASHBOARD_PORT", "9")).rejects.toBeInstanceOf(
      ConfigError
    );
    await expect(store.setKey("GRAPHRAG_MEMORY_DASHBOARD_PORT", "9")).rejects.toThrow(
      /GRAPHRAG_MEMORY_DASHBOARD_PORT/
    );
    expect(readFileSync(settingPath(home), "utf8")).toBe(before);
  });
});

function settingPath(home: string): string {
  return join(home, ".iknow-memory", "setting.json");
}

function readDocument(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingPath(home), "utf8")) as Record<string, unknown>;
}

async function capture(
  store: SettingStore,
  home: string,
  command: ConfigCommand
): Promise<string[]> {
  const lines: string[] = [];
  await runConfigCli(command, {
    store,
    env: {},
    cwd: home,
    stdout: (line) => lines.push(line),
    stderr: () => {},
  });
  return lines;
}

async function showText(store: SettingStore, home: string): Promise<string> {
  return (await capture(store, home, { kind: "show" })).join("\n");
}

async function listText(store: SettingStore): Promise<string> {
  return (await capture(store, store.path, { kind: "list" })).join("\n");
}

async function run(
  store: SettingStore,
  home: string,
  command: ConfigCommand
): Promise<{ code: number }> {
  return runConfigCli(command, {
    store,
    env: {},
    cwd: home,
    stdout: () => {},
    stderr: () => {},
  });
}
