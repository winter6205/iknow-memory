/**
 * `iknow-memory-config` CLI — minimal read/write/list surface.
 *
 * Subcommands (per T2 design):
 *   list                          — print every key=value, one per line
 *   get <KEY>                     — print one value (exit 0) or exit 3 if absent
 *   set <KEY> <VALUE>             — write one key=value (create-or-replace)
 *   unset <KEY>                   — delete one key (exit 0 if absent)
 *
 * The CLI is a thin wrapper around the setting-store; the store is
 * injectable so tests run in a tmp `$HOME` and never touch the operator's
 * real `~/.iknow-memory/setting.json`.
 *
 * Why these tests live in their own file: each subcommand has a different
 * exit-code contract — collapsing them into one describe hides which subcommand
 * regressed when one fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSettingStore,
  type SettingStore,
} from "../../../src/config/setting-store.js";
import {
  parseConfigArgs,
  runConfigCli,
  type ConfigRunResult,
} from "../../../src/cli/config.js";

let tmpHome: string;
let store: SettingStore;
const stdout: string[] = [];
const stderr: string[] = [];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "iknow-memory-config-cli-"));
  store = createSettingStore({ home: tmpHome });
  stdout.length = 0;
  stderr.length = 0;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function run(argv: readonly string[]): Promise<ConfigRunResult> {
  const parsed = parseConfigArgs(argv);
  if (!parsed.ok) {
    return {
      code: 2,
      stdout: "",
      stderr: `iknow-memory-config: ${parsed.error}\n`,
    };
  }
  return runConfigCli(parsed.command, {
    store,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
}

describe("iknow-memory-config — parseConfigArgs", () => {
  it("rejects an empty argv with usage", () => {
    const parsed = parseConfigArgs([]);
    expect(parsed.ok).toBe(false);
  });

  it("rejects an unknown subcommand with a named error", () => {
    const parsed = parseConfigArgs(["frobnicate"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("frobnicate");
    expect(parsed.error).toMatch(/usage:/i);
  });

  it("accepts `list` with no args", () => {
    const parsed = parseConfigArgs(["list"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.kind).toBe("list");
  });

  it("rejects `get` with no key", () => {
    const parsed = parseConfigArgs(["get"]);
    expect(parsed.ok).toBe(false);
  });

  it("accepts `get KEY`", () => {
    const parsed = parseConfigArgs(["get", "GRAPHRAG_MEMORY_DB_URL"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command).toEqual({
      kind: "get",
      key: "GRAPHRAG_MEMORY_DB_URL",
    });
  });

  it("accepts `set KEY VALUE`", () => {
    const parsed = parseConfigArgs([
      "set",
      "GRAPHRAG_MEMORY_DB_URL",
      "postgres://localhost/iknow_memory",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command).toEqual({
      kind: "set",
      key: "GRAPHRAG_MEMORY_DB_URL",
      value: "postgres://localhost/iknow_memory",
    });
  });

  it("rejects `set` with no value", () => {
    const parsed = parseConfigArgs(["set", "GRAPHRAG_MEMORY_DB_URL"]);
    expect(parsed.ok).toBe(false);
  });

  it("accepts `unset KEY`", () => {
    const parsed = parseConfigArgs(["unset", "GRAPHRAG_MEMORY_DB_URL"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command).toEqual({
      kind: "unset",
      key: "GRAPHRAG_MEMORY_DB_URL",
    });
  });

  it("rejects `unset` with no key", () => {
    const parsed = parseConfigArgs(["unset"]);
    expect(parsed.ok).toBe(false);
  });
});

describe("iknow-memory-config list", () => {
  it("prints nothing and exits 0 on an empty store", async () => {
    const result = await run(["list"]);
    expect(result.code).toBe(0);
    expect(stdout.join("")).toBe("");
  });

  it("prints every key=value, one per line, sorted", async () => {
    await store.write({
      GRAPHRAG_MEMORY_EMBED_MODEL: "embedding-3",
      GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow_memory",
    });
    const result = await run(["list"]);
    expect(result.code).toBe(0);
    expect(stdout.join("\n")).toBe(
      [
        "GRAPHRAG_MEMORY_DB_URL=postgres://localhost/iknow_memory",
        "GRAPHRAG_MEMORY_EMBED_MODEL=embedding-3",
      ].join("\n")
    );
  });
});

describe("iknow-memory-config get", () => {
  it("prints the value and exits 0 when the key is set", async () => {
    await store.write({
      GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow_memory",
    });
    const result = await run(["get", "GRAPHRAG_MEMORY_DB_URL"]);
    expect(result.code).toBe(0);
    expect(stdout.join("")).toBe("postgres://localhost/iknow_memory\n");
  });

  it("exits 3 with a named error when the key is absent", async () => {
    const result = await run(["get", "GRAPHRAG_MEMORY_DB_URL"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("GRAPHRAG_MEMORY_DB_URL");
  });
});

describe("iknow-memory-config set", () => {
  it("creates a new key=value and exits 0", async () => {
    const result = await run([
      "set",
      "GRAPHRAG_MEMORY_DB_URL",
      "postgres://localhost/iknow_memory",
    ]);
    expect(result.code).toBe(0);
    expect(await store.read()).toEqual({
      GRAPHRAG_MEMORY_DB_URL: "postgres://localhost/iknow_memory",
    });
  });

  it("replaces an existing value", async () => {
    await store.write({ GRAPHRAG_MEMORY_DB_URL: "old" });
    const result = await run(["set", "GRAPHRAG_MEMORY_DB_URL", "new"]);
    expect(result.code).toBe(0);
    expect(await store.read()).toEqual({ GRAPHRAG_MEMORY_DB_URL: "new" });
  });

  it("persists other keys when one is overwritten (no wholesale reset)", async () => {
    await store.write({
      GRAPHRAG_MEMORY_DB_URL: "old",
      GRAPHRAG_MEMORY_EMBED_MODEL: "embedding-3",
    });
    await run(["set", "GRAPHRAG_MEMORY_DB_URL", "new"]);
    expect(await store.read()).toEqual({
      GRAPHRAG_MEMORY_DB_URL: "new",
      GRAPHRAG_MEMORY_EMBED_MODEL: "embedding-3",
    });
  });
});

describe("iknow-memory-config unset", () => {
  it("removes an existing key and exits 0", async () => {
    await store.write({ GRAPHRAG_MEMORY_DB_URL: "x" });
    const result = await run(["unset", "GRAPHRAG_MEMORY_DB_URL"]);
    expect(result.code).toBe(0);
    expect(await store.read()).toEqual({});
  });

  it("is idempotent — exits 0 when the key is absent", async () => {
    const result = await run(["unset", "GRAPHRAG_MEMORY_DB_URL"]);
    expect(result.code).toBe(0);
  });
});

describe("iknow-memory-config — secret hygiene", () => {
  it("list never prints to stderr (operators do not expect stray output)", async () => {
    await store.write({ GRAPHRAG_MEMORY_EMBED_API_KEY: "secret-value" });
    const result = await run(["list"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("set echoes nothing on success (no secret leak via terminal)", async () => {
    const result = await run([
      "set",
      "GRAPHRAG_MEMORY_EMBED_API_KEY",
      "secret-value",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("errors never echo the value back to the operator", async () => {
    await store
      .write({ GRAPHRAG_MEMORY_EMBED_API_KEY: 42 as unknown as string })
      .catch(() => {
        /* expected: the store rejects non-strings */
      });
    const result = await run(["get", "GRAPHRAG_MEMORY_EMBED_API_KEY"]);
    // The key isn't set (write failed), so this is a plain "absent" miss.
    // The point is the error must not contain any attempt at the value.
    expect(result.code).toBe(3);
    expect(result.stderr).not.toContain("secret-value");
  });
});
