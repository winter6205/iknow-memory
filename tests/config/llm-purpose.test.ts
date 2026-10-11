/**
 * LLM purpose split (tracer T4).
 *
 * Purpose keys win when any of model, base URL, or API-key pointer is set.
 * Absent purpose keys resolve today's Anthropic block, then JEV. Summary
 * copies the resolved extract block. Show never prints the secret value.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runConfigCli } from "../../src/cli/config.ts";
import {
  ConfigError,
  loadEnv,
  setSettingHomeForTests,
  type GraphragEnv,
} from "../../src/config.ts";
import { createSettingStore } from "../../src/config/setting-store.ts";
import { buildPersistingExtractionClients } from "../../src/core/extraction/clients.ts";
import { AnthropicLLMClient } from "../../src/core/extraction/llm-client.ts";
import { buildExtractDeps } from "../../src/index.ts";
import { createLogger } from "../../src/logging.ts";

const SECRET = "purpose-secret-t4-do-not-print";
const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "iknow-llm-purpose-"));
  homes.push(home);
  return home;
}

function writeSetting(osHome: string, map: Record<string, string>): void {
  const dir = join(osHome, ".iknow-memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "setting.json"), JSON.stringify(map));
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
  "FIN_API_KEY",
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
  "IKNOW_EXTRACT_KEY_ONLY_IN_SETTING",
] as const;

const BOOT: Record<string, string> = {
  GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "32",
  GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
  GRAPHRAG_MEMORY_STORAGE: "memory",
  GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "false",
  GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
  GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "false",
};

function withBoot(
  patch: Record<string, string | undefined>,
  fn: () => void
): void {
  const keys = new Set<string>([
    ...SCRUB,
    ...Object.keys(BOOT),
    ...Object.keys(patch),
  ]);
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

describe("LLM purposes", () => {
  it("lets purpose keys override the old Anthropic model", () => {
    const home = tempHome();
    setSettingHomeForTests(home);
    withBoot(
      {
        GRAPHRAG_MEMORY_ANTHROPIC_MODEL: "old-anthropic-model",
        GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL: "https://old.example/anthropic",
        ANTHROPIC_AUTH_TOKEN: "old-anthropic-token",
        GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL: "purpose-extract-model",
      },
      () => {
        const env = loadEnv();
        expect(env.llm.extract.model).toBe("purpose-extract-model");
        expect(env.llm.extract.baseUrl).toBe("https://old.example/anthropic");
        expect(env.llm.extract.protocol).toBe("anthropic");
        expect(env.llm.summary.model).toBe("purpose-extract-model");
      }
    );
  });

  it("resolves the old Anthropic model when purpose keys are absent", () => {
    const home = tempHome();
    setSettingHomeForTests(home);
    withBoot(
      {
        GRAPHRAG_MEMORY_ANTHROPIC_MODEL: "old-anthropic-model",
        ANTHROPIC_AUTH_TOKEN: "old-anthropic-token",
        GRAPHRAG_MEMORY_JEV_API_KEY: "jev-key",
        GRAPHRAG_MEMORY_JEV_MODEL: "jev-model",
      },
      () => {
        const env = loadEnv();
        expect(env.llm.extract.model).toBe("old-anthropic-model");
        expect(env.llm.extract.apiKey).toBe("old-anthropic-token");
        expect(env.llm.summary).toEqual(env.llm.extract);
      }
    );
  });

  it("resolves the JEV model when purpose keys and the Anthropic block are absent", () => {
    const home = tempHome();
    setSettingHomeForTests(home);
    withBoot(
      {
        GRAPHRAG_MEMORY_JEV_API_KEY: "jev-key",
        GRAPHRAG_MEMORY_JEV_MODEL: "jev-model",
        GRAPHRAG_MEMORY_JEV_BASE_URL: "https://jev.example",
        FIN_API_KEY: "fin-key-must-not-be-used",
      },
      () => {
        const env = loadEnv();
        expect(env.llm.extract).toMatchObject({
          protocol: "anthropic",
          model: "jev-model",
          baseUrl: "https://jev.example",
          apiKey: "jev-key",
        });
        expect(env.llm.summary.model).toBe("jev-model");
      }
    );
  });

  it("throws ConfigError when protocol is openai", () => {
    const home = tempHome();
    setSettingHomeForTests(home);
    withBoot({ GRAPHRAG_MEMORY_LLM_EXTRACT_PROTOCOL: "openai" }, () => {
      expect(() => loadEnv()).toThrow(ConfigError);
      try {
        loadEnv();
      } catch (err) {
        expect((err as Error).message).toContain(
          "GRAPHRAG_MEMORY_LLM_EXTRACT_PROTOCOL"
        );
        expect((err as Error).message).not.toContain(SECRET);
      }
    });
  });

  it("reads an extract API key that exists only in setting.json", () => {
    const home = tempHome();
    writeSetting(home, {
      GRAPHRAG_MEMORY_LLM_EXTRACT_API_KEY_ENV:
        "IKNOW_EXTRACT_KEY_ONLY_IN_SETTING",
      IKNOW_EXTRACT_KEY_ONLY_IN_SETTING: SECRET,
    });
    setSettingHomeForTests(home);
    withBoot({}, () => {
      expect(process.env.IKNOW_EXTRACT_KEY_ONLY_IN_SETTING).toBeUndefined();
      expect(
        process.env.GRAPHRAG_MEMORY_LLM_EXTRACT_API_KEY_ENV
      ).toBeUndefined();
      expect(loadEnv().llm.extract.apiKey).toBe(SECRET);
    });
  });

  it("show output does not contain the secret and marks extract and summary models next-extraction", async () => {
    const home = tempHome();
    const store = createSettingStore({ home });
    await store.write({
      GRAPHRAG_MEMORY_LLM_EXTRACT_API_KEY_ENV:
        "IKNOW_EXTRACT_KEY_ONLY_IN_SETTING",
      IKNOW_EXTRACT_KEY_ONLY_IN_SETTING: SECRET,
      GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL: "purpose-extract-model",
      GRAPHRAG_MEMORY_LLM_SUMMARY_MODEL: "purpose-summary-model",
    });
    const stdout: string[] = [];
    const shown = await runConfigCli(
      { kind: "show" },
      {
        store,
        env: {},
        cwd: home,
        stdout: (line: string) => stdout.push(line),
        stderr: () => {},
      }
    );
    const text = stdout.join("\n");
    expect(shown.code).toBe(0);
    expect(text).toContain(
      "GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL=purpose-extract-model layer=setting effect=next-extraction"
    );
    expect(text).toContain(
      "GRAPHRAG_MEMORY_LLM_SUMMARY_MODEL=purpose-summary-model layer=setting effect=next-extraction"
    );
    expect(text).toContain(
      "GRAPHRAG_MEMORY_LLM_RERANK_MODEL=unset layer=default effect=restart"
    );
    expect(text).not.toContain(SECRET);
  });

  it("extract callers take the model from loadEnv().llm.extract, not process.env", () => {
    const previousToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const previousModel = process.env.GRAPHRAG_MEMORY_ANTHROPIC_MODEL;
    process.env.ANTHROPIC_AUTH_TOKEN = "process-token";
    process.env.GRAPHRAG_MEMORY_ANTHROPIC_MODEL = "process-model";
    const env = {
      embedApiKey: "embed-key",
      embedBaseUrl: "https://embed.example",
      embedModel: "embed-model",
      embedDimensions: 4,
      dbUrl: undefined,
      extractWriteTimeSupersede: true,
      rerank: {
        apiKey: "rerank-key",
        model: "rerank-model",
        baseUrl: "https://rerank.example",
      },
      llm: {
        extract: {
          protocol: "anthropic" as const,
          model: "purpose-extract-model",
          baseUrl: "https://extract.example",
          apiKey: "purpose-extract-key",
        },
        summary: {
          protocol: "anthropic" as const,
          model: "purpose-summary-model",
          baseUrl: "https://summary.example",
          apiKey: "purpose-summary-key",
        },
        rerank: {
          protocol: "anthropic" as const,
          model: "purpose-rerank-model",
          baseUrl: "https://purpose-rerank.example",
          apiKey: "purpose-rerank-key",
        },
      },
    } as GraphragEnv;
    try {
      const { llm } = buildPersistingExtractionClients(env);
      expect(llm).toBeInstanceOf(AnthropicLLMClient);
      expect((llm as AnthropicLLMClient).modelId).toBe("purpose-extract-model");
      const deps = buildExtractDeps(env, createLogger("info"));
      expect(deps.llmEnv).toEqual({
        authToken: "purpose-extract-key",
        baseUrl: "https://extract.example",
        model: "purpose-extract-model",
      });
    } finally {
      if (previousToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = previousToken;
      if (previousModel === undefined)
        delete process.env.GRAPHRAG_MEMORY_ANTHROPIC_MODEL;
      else process.env.GRAPHRAG_MEMORY_ANTHROPIC_MODEL = previousModel;
    }
  });
});
