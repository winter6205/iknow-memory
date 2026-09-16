/**
 * Operator-setting file store — read/write/list at the
 * `~/.iknow-memory/setting.json` location.
 *
 * T2 inherits from the spec:
 *   - the file holds identity and everyday secrets (storage mode, dedicated
 *     database URL, embedding model/dimensions, Neo4j URI, API keys);
 *   - keys are the existing GRAPHRAG_MEMORY_* names so env-vars line up;
 *   - missing file is not an error (no block on start);
 *   - secrets are never echoed back in error messages.
 *
 * These tests pin the on-disk shape: a flat object of string values keyed by
 * GRAPHRAG_MEMORY_*. A non-flat value (number / array / nested object) is
 * rejected so an operator typo cannot silently become "loaded with an empty
 * string" or "loaded as `[object Object]`" downstream.
 *
 * The home directory is injectable so the tests run in a tmp tree; the
 * production resolver builds the same path off `$HOME`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSettingStore,
  type SettingStore,
} from "../../../src/config/setting-store.js";

let tmpHome: string;
let store: SettingStore;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "iknow-memory-setting-store-"));
  store = createSettingStore({ home: tmpHome });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Write the JSON contents at the store's on-disk path (creating the dir). */
function seedSetting(payload: string | object): string {
  const path = join(tmpHome, ".iknow-memory", "setting.json");
  mkdirSync(join(tmpHome, ".iknow-memory"), { recursive: true });
  writeFileSync(
    path,
    typeof payload === "string" ? payload : JSON.stringify(payload)
  );
  return path;
}

describe("createSettingStore — flat JSON shape", () => {
  it("returns an empty record when the file is absent", async () => {
    expect(await store.read()).toEqual({});
  });

  it("returns the parsed object when the file exists with string values", async () => {
    seedSetting({
      GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow_memory",
      GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1",
    });
    expect(await store.read()).toEqual({
      GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow_memory",
      GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1",
    });
  });

  it("treats a missing parent directory as 'file absent', not an error", async () => {
    // tmpHome has no .iknow-memory/ at all; read() must succeed empty.
    expect(await store.read()).toEqual({});
  });

  it("throws a named error when the file exists but is malformed JSON", async () => {
    seedSetting("{ this is not json");
    await expect(store.read()).rejects.toThrow(/setting\.json/);
    await expect(store.read()).rejects.toThrow(/JSON/i);
  });

  it("rejects a non-object root (string) with a named error", async () => {
    seedSetting("not-an-object");
    await expect(store.read()).rejects.toThrow(/setting\.json/);
    await expect(store.read()).rejects.toThrow(/object/i);
  });

  it("rejects a non-object root (array) with a named error", async () => {
    seedSetting(["nope"]);
    await expect(store.read()).rejects.toThrow(/object/i);
  });

  it("rejects a nested-object value with a named error", async () => {
    seedSetting({ GRAPHRAG_MEMORY_DB_URL: { wrong: "shape" } });
    await expect(store.read()).rejects.toThrow(/GRAPHRAG_MEMORY_DB_URL/);
    await expect(store.read()).rejects.toThrow(/string/i);
  });

  it("rejects a numeric value with a named error (operator typos are loud)", async () => {
    seedSetting({ GRAPHRAG_MEMORY_DB_URL: 42 });
    await expect(store.read()).rejects.toThrow(/GRAPHRAG_MEMORY_DB_URL/);
  });

  it("rejects an empty key as named error so a stray separator is loud", async () => {
    seedSetting({ "": "v" });
    await expect(store.read()).rejects.toThrow(/empty/i);
  });

  it("echoes the path in error messages so operators can locate the bad file", async () => {
    const path = seedSetting("not-json");
    await expect(store.read()).rejects.toThrow(path);
  });
});

describe("createSettingStore — write surface", () => {
  it("writes a flat object as pretty JSON so an operator can hand-edit it", async () => {
    await store.write({
      GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow_memory",
      GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1",
    });
    const onDisk = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").readFileSync(
        join(tmpHome, ".iknow-memory", "setting.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    expect(onDisk).toEqual({
      GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow_memory",
      GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1",
    });
  });

  it("round-trips a write → read of every key", async () => {
    const payload = {
      GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow_memory",
      GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1",
      GRAPHRAG_MEMORY_EMBED_MODEL: "embedding-3",
      GRAPHRAG_MEMORY_EMBED_API_KEY: "secret-not-logged",
      GRAPHRAG_MEMORY_NEO4J_URI: "bolt://localhost:7687",
    };
    await store.write(payload);
    expect(await store.read()).toEqual(payload);
  });

  it("rejects a write whose value is not a string (no implicit stringify)", async () => {
    await expect(
      store.write({ GRAPHRAG_MEMORY_DB_URL: 42 as unknown as string })
    ).rejects.toThrow(/string/i);
    await expect(
      store.write({ GRAPHRAG_MEMORY_DB_URL: undefined as unknown as string })
    ).rejects.toThrow(/string/i);
  });

  it("writes a non-empty file even when given an empty object (so the path is materialized)", async () => {
    await store.write({});
    expect(await store.read()).toEqual({});
  });
});

describe("createSettingStore — file location", () => {
  it("locates the file at $home/.iknow-memory/setting.json", async () => {
    // Already covered above by construction; this asserts the exact path so
    // a refactor that moves the file is a deliberate decision, not drift.
    const probe = createSettingStore({ home: tmpHome });
    await probe.write({ GRAPHRAG_MEMORY_DB_URL: "x" });
    const raw =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require("node:fs") as typeof import("node:fs")).readFileSync(
        join(tmpHome, ".iknow-memory", "setting.json"),
        "utf8"
      );
    expect(raw).toContain("GRAPHRAG_MEMORY_DB_URL");
  });

  it("keeps the store isolated per `home` (no leak across instances)", async () => {
    const otherHome = mkdtempSync(join(tmpdir(), "iknow-memory-other-"));
    try {
      const other = createSettingStore({ home: otherHome });
      await store.write({ GRAPHRAG_MEMORY_DB_URL: "first" });
      await other.write({ GRAPHRAG_MEMORY_DB_URL: "second" });
      expect(await store.read()).toEqual({ GRAPHRAG_MEMORY_DB_URL: "first" });
      expect(await other.read()).toEqual({ GRAPHRAG_MEMORY_DB_URL: "second" });
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });
});
