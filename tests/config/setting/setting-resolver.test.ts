/**
 * Operator-setting resolver — per-key precedence:
 *   process.env (even blank, wins) → setting.json → undefined.
 *
 * T2 inherits: missing file is not an error, no block on start. The
 * resolver is the bridge between `~/.iknow-memory/setting.json` and the
 * existing env-reading surface (`readEnv` / `readRawEnv` in src/config.ts).
 * The resolution API must be a pure function over an injected store +
 * process.env-shaped bag so tests stay deterministic.
 *
 * Why these tests live in their own file: precedence is the entire
 * contract for this module — anything less than exhaustive coverage
 * here lets a future refactor silently flip the order, which would be
 * an operator-visible "my exported env var stopped winning" bug.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSettingStore,
  type SettingStore,
} from "../../../src/config/setting-store.js";
import { resolveSettingValue } from "../../../src/config/setting-resolver.js";

/** Shape a test passes instead of touching real process.env. */
type EnvBag = Record<string, string | undefined>;

let tmpHome: string;
let store: SettingStore;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "iknow-memory-setting-resolver-"));
  store = createSettingStore({ home: tmpHome });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function seedSetting(payload: string | object): void {
  mkdirSync(join(tmpHome, ".iknow-memory"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".iknow-memory", "setting.json"),
    typeof payload === "string" ? payload : JSON.stringify(payload)
  );
}

describe("resolveSettingValue — precedence (process.env > file > absent)", () => {
  it("returns the process.env value when it is set and non-blank", async () => {
    await store.write({ GRAPHRAG_MEMORY_DB_URL: "file-value" });
    const env: EnvBag = { GRAPHRAG_MEMORY_DB_URL: "shell-value" };
    expect(
      await resolveSettingValue("GRAPHRAG_MEMORY_DB_URL", env, store)
    ).toBe("shell-value");
  });

  it("returns the file value when process.env is absent", async () => {
    await store.write({ GRAPHRAG_MEMORY_DB_URL: "file-value" });
    const env: EnvBag = {};
    expect(
      await resolveSettingValue("GRAPHRAG_MEMORY_DB_URL", env, store)
    ).toBe("file-value");
  });

  it("returns undefined when both process.env and the file are absent", async () => {
    expect(
      await resolveSettingValue("GRAPHRAG_MEMORY_DB_URL", {}, store)
    ).toBeUndefined();
  });

  it("returns undefined when both are present-but-blank (process.env blank wins → undefined)", async () => {
    // Empty-string value in file is preserved as '' because the file is the
    // operator's explicit setting; but process.env blank must win because
    // the convention is "process.env present (even blank) is explicit".
    await store.write({ GRAPHRAG_MEMORY_DB_URL: "" });
    const env: EnvBag = { GRAPHRAG_MEMORY_DB_URL: "" };
    expect(
      await resolveSettingValue("GRAPHRAG_MEMORY_DB_URL", env, store)
    ).toBeUndefined();
  });

  it("returns the file value when process.env holds a blank string and the file has a value", async () => {
    // A blank shell export must NOT be confused with "unset"; this matches
    // the existing readEnv contract used by loadEnv (a present blank key
    // falls through as undefined and the file value takes its place).
    await store.write({ GRAPHRAG_MEMORY_DB_URL: "file-value" });
    const env: EnvBag = { GRAPHRAG_MEMORY_DB_URL: "" };
    expect(
      await resolveSettingValue("GRAPHRAG_MEMORY_DB_URL", env, store)
    ).toBe("file-value");
  });

  it("returns the file value when process.env has whitespace-only", async () => {
    await store.write({ GRAPHRAG_MEMORY_DB_URL: "file-value" });
    const env: EnvBag = { GRAPHRAG_MEMORY_DB_URL: "   " };
    // Whitespace in process.env is treated as explicit blank → undefined,
    // so the file value wins (matching existing readEnv normalization).
    expect(
      await resolveSettingValue("GRAPHRAG_MEMORY_DB_URL", env, store)
    ).toBe("file-value");
  });

  it("does not let an unrelated env entry shadow the file value", async () => {
    await store.write({ GRAPHRAG_MEMORY_DB_URL: "file-value" });
    const env: EnvBag = { GRAPHRAG_MEMORY_LOG_LEVEL: "debug" };
    expect(
      await resolveSettingValue("GRAPHRAG_MEMORY_DB_URL", env, store)
    ).toBe("file-value");
  });

  it("does not let the file value leak into an unrelated key", async () => {
    await store.write({ GRAPHRAG_MEMORY_DB_URL: "file-value" });
    expect(
      await resolveSettingValue("GRAPHRAG_MEMORY_EMBED_BASE_URL", {}, store)
    ).toBeUndefined();
  });

  it("treats a missing setting.json as 'absent' (no thrown error)", async () => {
    // tmpHome has no .iknow-memory/ yet — store.read() returns {} and the
    // resolver must not throw.
    expect(
      await resolveSettingValue("GRAPHRAG_MEMORY_DB_URL", {}, store)
    ).toBeUndefined();
  });

  it("propagates a malformed-file read error (named so operators can fix it)", async () => {
    seedSetting("{ not json");
    await expect(
      resolveSettingValue("GRAPHRAG_MEMORY_DB_URL", {}, store)
    ).rejects.toThrow(/setting\.json/);
  });
});

describe("resolveSettingValue — secret hygiene", () => {
  it("does not include the resolved value in any thrown error", async () => {
    // The store rejects a non-string value with a typed error; that error
    // must NOT echo the secret back. This guards against an operator
    // leaking their API key via `iknow-memory-config list` after a
    // write-time bug.
    seedSetting({ GRAPHRAG_MEMORY_EMBED_API_KEY: 42 });
    let caught: unknown;
    try {
      await resolveSettingValue("GRAPHRAG_MEMORY_EMBED_API_KEY", {}, store);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("42");
  });
});
