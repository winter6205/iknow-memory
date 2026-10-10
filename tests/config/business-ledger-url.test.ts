/**
 * Business ledger URL configuration.
 *
 * `FIN_BUSINESS_LEDGER_URL` is the name the contract spec §9 uses for the
 * ledger DSN; it arrives only through the environment (or the operator
 * setting), and the secret it carries must never be echoed into an error
 * message or a log line. Absent is legal: the `sql` 档 then exits the
 * structured `real_db_not_wired` (not provisioned) — the server still
 * boots, so this is deliberately NOT a fail-start dependency.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUSINESS_LEDGER_URL_VAR,
  ConfigError,
  loadEnv,
  setSettingHomeForTests,
} from "../../src/config.js";

const SCRUB_KEYS = [
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "GRAPHRAG_MEMORY_VECTOR_API_KEY",
  "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
  "NINE_ROUTER_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED",
  BUSINESS_LEDGER_URL_VAR,
] as const;

function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => void
): void {
  const saved = new Map<string, string | undefined>();
  for (const key of SCRUB_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "32";
  process.env["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] = "2000";
  // Offline baseline: the arms and their fail-start switches are not what
  // these tests exercise (same explicit-off posture as config-t7).
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED"] = "false";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED"] = "false";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED"] = "false";
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // An empty setting home so a developer's ~/.iknow-memory cannot leak in.
  const settingHome = mkdtempSync(join(tmpdir(), "iknow-ledger-config-"));
  setSettingHomeForTests(settingHome);
  try {
    fn();
  } finally {
    setSettingHomeForTests(null);
    rmSync(settingHome, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("FIN_BUSINESS_LEDGER_URL", () => {
  it("is absent when unset — the sql 档 will exit not-provisioned", () => {
    withEnv({}, () => {
      expect(loadEnv().businessLedgerUrl).toBeUndefined();
    });
  });

  it("accepts a postgresql:// DSN and keeps the value out of the log surface", () => {
    const dsn =
      "postgresql://fin_sql_reader:unused-test-secret@ledger.invalid/fin_business";
    withEnv({ [BUSINESS_LEDGER_URL_VAR]: dsn }, () => {
      const env = loadEnv();
      expect(env.businessLedgerUrl).toBe(dsn);
      // The env block holds the DSN for the pool only; nothing here
      // stringifies it. This asserts the field round-trip, not a print.
      expect(JSON.stringify(Object.keys(env))).not.toContain("password");
    });
  });

  it("accepts the postgres:// alias", () => {
    const dsn = "postgres://fin_sql_reader@localhost:5434/fin_business";
    withEnv({ [BUSINESS_LEDGER_URL_VAR]: dsn }, () => {
      expect(loadEnv().businessLedgerUrl).toBe(dsn);
    });
  });

  it("refuses a non-postgres scheme naming the var, never echoing the value", () => {
    // The value can carry a password; a ConfigError goes to stderr and
    // must name the knob, not the credential.
    withEnv(
      { [BUSINESS_LEDGER_URL_VAR]: "https://user:hunter2@ledger.invalid/db" },
      () => {
        let thrown: unknown;
        try {
          loadEnv();
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(ConfigError);
        const message = (thrown as ConfigError).message;
        expect(message).toContain(BUSINESS_LEDGER_URL_VAR);
        expect(message).not.toContain("hunter2");
        expect(message).not.toContain("ledger.invalid");
      }
    );
  });
});
