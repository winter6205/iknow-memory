/**
 * Integration of the operator-setting resolver into `loadEnv()`.
 *
 * Acceptance bullet: "Loading setting.json with DSN + keys starts
 * dashboard-api without those keys exported in the shell. Exported env
 * wins when set."
 *
 * The single source of truth lives in src/config.ts — both MCP
 * (`createServer`) and dashboard-api (`src/dashboard-api/main.ts`) read
 * the same `loadEnv()`, so the test below pins the operator-visible
 * contract at exactly one place. Any future caller that bypasses
 * `loadEnv` is a deliberate choice, not a copy-paste.
 *
 * What this is NOT testing: every existing config boundary (those have
 * their own suites in tests/config.test.ts). Only the new resolution
 * layer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConfigError,
  loadEnv,
  setSettingHomeForTests,
} from "../../../src/config.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "iknow-memory-setting-int-"));
  setSettingHomeForTests(tmpHome);
});

afterEach(() => {
  setSettingHomeForTests(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

function seedSetting(payload: Record<string, string>): void {
  mkdirSync(join(tmpHome, ".iknow-memory"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".iknow-memory", "setting.json"),
    JSON.stringify(payload, null, 2)
  );
}

/**
 * The same env-hygiene scrub used by tests/config.test.ts — keeps these
 * tests order-independent within vitest's shared process model.
 */
const SCRUB_KEYS = [
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_VECTOR_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_NEO4J_URI",
  "GRAPHRAG_MEMORY_NEO4J_USER",
  "GRAPHRAG_MEMORY_NEO4J_PASSWORD",
  "GRAPHRAG_MEMORY_ES_URL",
  "GRAPHRAG_MEMORY_ES_NODE",
  "GRAPHRAG_MEMORY_RETRIEVAL_RRF_K",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_VEC",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_BM25",
  "GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "NINE_ROUTER_KEY",
  "GRAPHRAG_MEMORY_JEV_API_KEY",
  "GRAPHRAG_MEMORY_JEV_MODEL",
  "GRAPHRAG_MEMORY_JEV_BASE_URL",
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "TYPESAFE_DEFAULT_MODEL",
] as const;

describe("loadEnv — operator setting resolution", () => {
  /**
   * Required defaults so a baseline boot can run without tripping the
   * parsers. The integration tests only assert the operator-setting
   * surface; the retrieval weights / dimensions etc. are scrubbed and
   * re-supplied so the only thing under test is what changed with the
   * setting-store wire-up.
   */
  const BASELINE_DEFAULTS: Record<string, string> = {
    GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "8",
    GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "8",
    GRAPHRAG_MEMORY_RETRIEVAL_RRF_K: "60",
    GRAPHRAG_MEMORY_RETRIEVAL_W_VEC: "0.7",
    GRAPHRAG_MEMORY_RETRIEVAL_W_BM25: "0.15",
    GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH: "0.15",
    GRAPHRAG_MEMORY_NEO4J_URI: "bolt://localhost:7687",
    GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL: "https://rerank.example.test/v1/",
    GRAPHRAG_MEMORY_ES_URL: "http://es.example.test:9200",
  };

  /** Save + scrub env keys, apply `patch`, run `fn`, restore. */
  function withEnv(
    patch: Record<string, string | undefined>,
    fn: () => void
  ): void {
    const saved = new Map<string, string | undefined>();
    for (const k of SCRUB_KEYS) {
      saved.set(k, process.env[k]);
      // Blank beats .env.local; delete would re-open that fallback.
      process.env[k] = "";
    }
    for (const [k, v] of Object.entries({
      ...BASELINE_DEFAULTS,
      ...patch,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  function writeSetting(payload: Record<string, string>): void {
    seedSetting(payload);
  }

  it("loads GRAPHRAG_MEMORY_DB_URL from setting.json when not exported in the shell", () => {
    withEnv({}, () => {
      writeSetting({
        GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow_memory",
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "8",
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "8",
      });
      const env = loadEnv();
      expect(env.dbUrl).toBe("postgres://localhost/iknow_memory");
      expect(env.embedDimensions).toBe(8);
    });
  });

  it("loads embedding key + base url + model from setting.json for the embedder block", () => {
    withEnv({}, () => {
      writeSetting({
        GRAPHRAG_MEMORY_EMBED_API_KEY: "file-only-secret",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://embed.example.invalid/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "embedding-3",
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "8",
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "8",
      });
      const env = loadEnv();
      expect(env.embedApiKey).toBe("file-only-secret");
      expect(env.embedBaseUrl).toBe("https://embed.example.invalid/v1");
      expect(env.embedModel).toBe("embedding-3");
    });
  });

  it("exported shell env wins over setting.json (precedence)", () => {
    withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY: "shell-secret",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://shell.example.invalid/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "shell-model",
      },
      () => {
        writeSetting({
          GRAPHRAG_MEMORY_EMBED_API_KEY: "file-secret",
          GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://file.example.invalid/v1",
          GRAPHRAG_MEMORY_EMBED_MODEL: "file-model",
          GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "8",
          GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "8",
        });
        const env = loadEnv();
        expect(env.embedApiKey).toBe("shell-secret");
        expect(env.embedBaseUrl).toBe("https://shell.example.invalid/v1");
        expect(env.embedModel).toBe("shell-model");
      }
    );
  });

  it("boots dashboard-api without keys exported in the shell when setting.json holds them", () => {
    // The exact acceptance bullet: a setting.json with DSN + keys is
    // enough to start the server, with NO shell export for those keys.
    withEnv({}, () => {
      writeSetting({
        GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow_memory",
        GRAPHRAG_MEMORY_EMBED_API_KEY: "secret-from-file",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://embed.example.invalid/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "embedding-3",
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "8",
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "8",
      });
      // No throw = the boot succeeded with no shell export for keys.
      expect(() => loadEnv()).not.toThrow();
    });
  });

  it("ConfigError names the offender but never the secret value", () => {
    // If loadEnv rejects a mis-set file value, the message must name the
    // env var, not echo the secret. Sanity check on the integration:
    // the file's EMBED_DIMENSIONS (9999) exceeds the file's ANN ceiling (8)
    // and the shell does NOT carry EMBED_DIMENSIONS, so the file value is
    // the one under validation. Result: ConfigError naming the offender,
    // never echoing the API key.
    withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://embed.example.invalid/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "embedding-3",
        // Override the baseline EMBED_DIMENSIONS to undefined so the file
        // value is the one the parser actually validates.
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: undefined,
      },
      () => {
        writeSetting({
          GRAPHRAG_MEMORY_EMBED_API_KEY: "file-only-secret-very-distinct",
          GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://embed.example.invalid/v1",
          GRAPHRAG_MEMORY_EMBED_MODEL: "embedding-3",
          GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "9999", // exceeds ANN ceiling
          GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "8",
        });
        let caught: unknown;
        try {
          loadEnv();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).message).not.toContain(
          "file-only-secret-very-distinct"
        );
      }
    );
  });

  it("loads GRAPHRAG_MEMORY_JEV_API_KEY from setting.json when not exported in the shell", () => {
    withEnv({}, () => {
      writeSetting({
        GRAPHRAG_MEMORY_JEV_API_KEY: "file-jev-secret",
        GRAPHRAG_MEMORY_JEV_MODEL: "jev-1.13.0",
        GRAPHRAG_MEMORY_JEV_BASE_URL: "https://api.typesafe.ai",
      });
      const env = loadEnv();
      expect(env.jev).toEqual({
        apiKey: "file-jev-secret",
        model: "jev-1.13.0",
        baseUrl: "https://api.typesafe.ai",
      });
    });
  });

  it("missing setting.json does not block start (no error, defaults applied)", () => {
    // tmpHome has no .iknow-memory/ — loadEnv should still work and
    // fall back to existing default-fallback behavior.
    withEnv({}, () => {
      expect(() => loadEnv()).not.toThrow();
      const env = loadEnv();
      expect(env.dbUrl).toBeUndefined();
      expect(env.embedApiKey).toBeUndefined();
    });
  });
});
