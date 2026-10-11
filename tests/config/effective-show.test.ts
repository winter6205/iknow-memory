/**
 * Effective config show + home directory (tracer T3).
 *
 * Precedence is non-blank process env, then setting.json, then
 * `.env.local` under the memory home, then the documented default.
 * `cwd/.env.local` is never applied. Secrets render as configured or unset.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfigArgs, runConfigCli } from "../../src/cli/config.ts";
import {
  ConfigError,
  describeRuntimeEffectiveConfig,
  loadEnv,
  setSettingHomeForTests,
} from "../../src/config.ts";
import { effectClassSchema } from "../../src/config/key-registry.ts";
import { createSettingStore } from "../../src/config/setting-store.ts";
import {
  describeEffectiveConfig,
  formatEffectiveConfig,
} from "../../src/config/effective-config.ts";
import { baselineFilePath } from "../../src/core/extraction-eval/baseline.ts";

const SECRET = "fake-secret-t3-do-not-print";
const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "iknow-effective-"));
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
  "GRAPHRAG_MEMORY_JEV_API_KEY",
  "TYPESAFE_API_KEY",
  "NINE_ROUTER_KEY",
  "FIN_BUSINESS_LEDGER_URL",
  "GRAPHRAG_MEMORY_NEO4J_URI",
  "GRAPHRAG_MEMORY_NEO4J_USER",
  "GRAPHRAG_MEMORY_NEO4J_PASSWORD",
  "GRAPHRAG_MEMORY_ES_URL",
  "GRAPHRAG_MEMORY_ES_NODE",
  "GRAPHRAG_MEMORY_ES_PASSWORD",
  "GRAPHRAG_MEMORY_ES_API_KEY",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL",
  "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED",
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
  for (const key of SCRUB) process.env[key] = "";
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

describe("effective config", () => {
  it("lets env override setting and names the shadowed setting key", () => {
    const home = tempHome();
    writeSetting(home, { GRAPHRAG_MEMORY_LOG_LEVEL: "from-setting" });
    setSettingHomeForTests(home);
    withBoot({ GRAPHRAG_MEMORY_LOG_LEVEL: "warn" }, () => {
      expect(loadEnv().logLevel).toBe("warn");
      const report = describeRuntimeEffectiveConfig();
      const entry = report.keys.find(
        (row) => row.key === "GRAPHRAG_MEMORY_LOG_LEVEL"
      );
      expect(entry).toMatchObject({
        value: "warn",
        layer: "env",
        effect: "restart",
      });
      expect(report.shadowedSettingKeys).toContain("GRAPHRAG_MEMORY_LOG_LEVEL");
      const text = formatEffectiveConfig(report);
      expect(text).toContain("shadowed setting: GRAPHRAG_MEMORY_LOG_LEVEL");
      expect(text).not.toContain("from-setting");
    });
  });

  it("names an unknown GRAPHRAG_MEMORY_* key and loadEnv still returns", () => {
    const home = tempHome();
    writeSetting(home, { GRAPHRAG_MEMORY_NOT_A_REAL_KEY: "from-file" });
    setSettingHomeForTests(home);
    withBoot({ GRAPHRAG_MEMORY_ALSO_UNKNOWN: "from-env" }, () => {
      expect(loadEnv().storage).toBe("memory");
      const report = describeRuntimeEffectiveConfig();
      expect(report.unknownKeys).toEqual([
        "GRAPHRAG_MEMORY_ALSO_UNKNOWN",
        "GRAPHRAG_MEMORY_NOT_A_REAL_KEY",
      ]);
      const text = formatEffectiveConfig(report);
      expect(text).toContain("unknown: GRAPHRAG_MEMORY_ALSO_UNKNOWN");
      expect(text).toContain("unknown: GRAPHRAG_MEMORY_NOT_A_REAL_KEY");
      expect(text).not.toContain("from-env");
      expect(text).not.toContain("from-file");
    });
  });

  it("does not apply cwd .env.local and names that file when it is present", () => {
    const home = tempHome();
    const cwd = tempHome();
    writeFileSync(join(cwd, ".env.local"), "GRAPHRAG_MEMORY_LOG_LEVEL=error\n");
    setSettingHomeForTests(home);
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      withBoot({ GRAPHRAG_MEMORY_LOG_LEVEL: undefined }, () => {
        expect(loadEnv().logLevel).toBe("info");
        const report = describeRuntimeEffectiveConfig();
        expect(report.cwdEnvLocalPresent).toBe(true);
        const entry = report.keys.find(
          (row) => row.key === "GRAPHRAG_MEMORY_LOG_LEVEL"
        );
        expect(entry?.layer).toBe("default");
        expect(formatEffectiveConfig(report)).toContain(
          "cwd .env.local: not in effect"
        );
      });
    } finally {
      process.chdir(previous);
    }
  });

  it("applies home .env.local when env and setting lack the key", () => {
    const home = tempHome();
    const dir = join(home, ".iknow-memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env.local"), "GRAPHRAG_MEMORY_LOG_LEVEL=debug\n");
    setSettingHomeForTests(home);
    withBoot({ GRAPHRAG_MEMORY_LOG_LEVEL: "" }, () => {
      expect(loadEnv().logLevel).toBe("debug");
      const entry = describeRuntimeEffectiveConfig().keys.find(
        (row) => row.key === "GRAPHRAG_MEMORY_LOG_LEVEL"
      );
      expect(entry).toMatchObject({
        value: "debug",
        layer: "home-env-file",
        effect: "restart",
      });
    });
  });

  it("marks embed model, dimensions, and base URL as rotate and extract and summary models as next-extraction", () => {
    const report = describeEffectiveConfig({
      env: {},
      setting: {},
      homeEnv: {},
      cwdEnvLocalPresent: false,
    });
    expect(effectClassSchema.parse("next-extraction")).toBe("next-extraction");
    const effectOf = (key: string) =>
      report.keys.find((row) => row.key === key)?.effect;
    expect(effectOf("GRAPHRAG_MEMORY_EMBED_MODEL")).toBe("rotate");
    expect(effectOf("GRAPHRAG_MEMORY_EMBED_DIMENSIONS")).toBe("rotate");
    expect(effectOf("GRAPHRAG_MEMORY_EMBED_BASE_URL")).toBe("rotate");
    expect(effectOf("GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL")).toBe(
      "next-extraction"
    );
    expect(effectOf("GRAPHRAG_MEMORY_LLM_SUMMARY_MODEL")).toBe(
      "next-extraction"
    );
    expect(effectOf("GRAPHRAG_MEMORY_LLM_RERANK_MODEL")).toBe("restart");
    expect(effectOf("GRAPHRAG_MEMORY_LOG_LEVEL")).toBe("restart");
  });

  it("show and list do not print a secret value, and get prints configured", async () => {
    const home = tempHome();
    const store = createSettingStore({ home });
    await store.write({
      GRAPHRAG_MEMORY_EMBED_API_KEY: SECRET,
      GRAPHRAG_MEMORY_LOG_LEVEL: "info",
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps = {
      store,
      env: { GRAPHRAG_MEMORY_EMBED_API_KEY: SECRET },
      cwd: home,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    };

    stdout.length = 0;
    const shown = await runConfigCli({ kind: "show" }, deps);
    const showText = stdout.join("\n");
    expect(shown.code).toBe(0);
    expect(showText).toContain("GRAPHRAG_MEMORY_EMBED_API_KEY=configured");
    expect(showText).not.toContain(SECRET);

    stdout.length = 0;
    const listed = await runConfigCli({ kind: "list" }, deps);
    const listText = stdout.join("\n");
    expect(listed.code).toBe(0);
    expect(listText).toContain("GRAPHRAG_MEMORY_EMBED_API_KEY=configured");
    expect(listText).toContain("GRAPHRAG_MEMORY_LOG_LEVEL=info");
    expect(listText).not.toContain(SECRET);

    stdout.length = 0;
    const got = await runConfigCli(
      { kind: "get", key: "GRAPHRAG_MEMORY_EMBED_API_KEY" },
      deps
    );
    expect(got.code).toBe(0);
    expect(stdout.join("")).toContain("configured");
    expect(stdout.join("")).not.toContain(SECRET);
    expect(stderr.join("")).not.toContain(SECRET);
  });

  it("redacts database URL userinfo in show, list, and get", async () => {
    const home = tempHome();
    const store = createSettingStore({ home });
    const password = "db-pass-not-shown";
    const raw = `postgresql://owner:${password}@db.internal:5432/iknow_memory?sslmode=require`;
    const redacted =
      "postgresql://db.internal:5432/iknow_memory?sslmode=require";
    await store.write({ GRAPHRAG_MEMORY_DB_URL: raw });
    const stdout: string[] = [];
    const deps = {
      store,
      env: { GRAPHRAG_MEMORY_DB_URL: raw },
      cwd: home,
      stdout: (line: string) => stdout.push(line),
      stderr: () => {},
    };

    stdout.length = 0;
    const shown = await runConfigCli({ kind: "show" }, deps);
    const showText = stdout.join("\n");
    expect(shown.code).toBe(0);
    expect(showText).toContain(`GRAPHRAG_MEMORY_DB_URL=${redacted}`);
    expect(showText).not.toContain(password);
    expect(showText).not.toContain("owner");
    expect(showText).not.toContain("GRAPHRAG_MEMORY_DB_URL=configured");

    stdout.length = 0;
    const listed = await runConfigCli({ kind: "list" }, deps);
    const listText = stdout.join("\n");
    expect(listed.code).toBe(0);
    expect(listText).toContain(`GRAPHRAG_MEMORY_DB_URL=${redacted}`);
    expect(listText).not.toContain(password);
    expect(listText).not.toContain("owner");

    stdout.length = 0;
    const got = await runConfigCli(
      { kind: "get", key: "GRAPHRAG_MEMORY_DB_URL" },
      deps
    );
    expect(got.code).toBe(0);
    expect(stdout.join("")).toBe(`${redacted}\n`);
    expect(stdout.join("")).not.toContain(password);
  });

  it("leaves a database URL without userinfo unchanged in show, list, and get", async () => {
    const home = tempHome();
    const store = createSettingStore({ home });
    const raw = "postgres://db.internal:5432/iknow_memory";
    await store.write({ GRAPHRAG_MEMORY_DB_URL: raw });
    const stdout: string[] = [];
    const deps = {
      store,
      env: { GRAPHRAG_MEMORY_DB_URL: raw },
      cwd: home,
      stdout: (line: string) => stdout.push(line),
      stderr: () => {},
    };

    stdout.length = 0;
    await runConfigCli({ kind: "show" }, deps);
    expect(stdout.join("\n")).toContain(`GRAPHRAG_MEMORY_DB_URL=${raw}`);

    stdout.length = 0;
    await runConfigCli({ kind: "list" }, deps);
    expect(stdout.join("\n")).toContain(`GRAPHRAG_MEMORY_DB_URL=${raw}`);

    stdout.length = 0;
    const got = await runConfigCli(
      { kind: "get", key: "GRAPHRAG_MEMORY_DB_URL" },
      deps
    );
    expect(got.code).toBe(0);
    expect(stdout.join("")).toBe(`${raw}\n`);
  });

  it("rejects a known secret with ConfigError that omits the value", () => {
    const home = tempHome();
    setSettingHomeForTests(home);
    withBoot(
      { FIN_BUSINESS_LEDGER_URL: `mysql://user:${SECRET}@localhost/db` },
      () => {
        expect(() => loadEnv()).toThrow(ConfigError);
        try {
          loadEnv();
        } catch (err) {
          expect((err as Error).message).not.toContain(SECRET);
          expect((err as Error).message).toContain("FIN_BUSINESS_LEDGER_URL");
        }
      }
    );
  });

  it("redirects the setting path when IKNOW_MEMORY_HOME is set", async () => {
    const directed = tempHome();
    const decoy = tempHome();
    const previous = process.env.IKNOW_MEMORY_HOME;
    process.env.IKNOW_MEMORY_HOME = directed;
    setSettingHomeForTests(decoy);
    try {
      const store = createSettingStore();
      expect(store.path).toBe(join(directed, "setting.json"));
      await store.write({ GRAPHRAG_MEMORY_LOG_LEVEL: "error" });
      expect(store.path.startsWith(decoy)).toBe(false);
      setSettingHomeForTests(null);
      withBoot({ GRAPHRAG_MEMORY_LOG_LEVEL: undefined }, () => {
        expect(loadEnv().logLevel).toBe("error");
      });
    } finally {
      if (previous === undefined) delete process.env.IKNOW_MEMORY_HOME;
      else process.env.IKNOW_MEMORY_HOME = previous;
      setSettingHomeForTests(null);
    }
  });

  it("writes new eval output under IKNOW_MEMORY_HOME", () => {
    const directed = tempHome();
    const previous = process.env.IKNOW_MEMORY_HOME;
    const previousGold = process.env.GOLD_SET_DIR;
    delete process.env.GOLD_SET_DIR;
    process.env.IKNOW_MEMORY_HOME = directed;
    try {
      expect(baselineFilePath("")).toBe(
        join(directed, "gold-set", "baseline.json")
      );
      expect(baselineFilePath("custom-dir")).toBe(
        join("custom-dir", "baseline.json")
      );
    } finally {
      if (previous === undefined) delete process.env.IKNOW_MEMORY_HOME;
      else process.env.IKNOW_MEMORY_HOME = previous;
      if (previousGold === undefined) delete process.env.GOLD_SET_DIR;
      else process.env.GOLD_SET_DIR = previousGold;
    }
  });
});

describe("iknow-memory-config show argv", () => {
  it("accepts show with no args", () => {
    const parsed = parseConfigArgs(["show"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command).toEqual({ kind: "show" });
  });
});
