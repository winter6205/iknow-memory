import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseStdioEntry } from "../../src/cli/stdio-entry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..", "..");

/**
 * Plan D0 I-T3: `iknow-memory` must be a real, launchable MCP stdio entry
 * that matches fin's `DEFAULT_MCP_COMMAND = ("iknow-memory",)` to the
 * letter. The argv parser rejects anything other than `[]` or
 * `["serve"]`, so an operator who fat-fingers `iknow-memory retrive`
 * sees a named failure rather than a silent stdio hang.
 */
describe("parseStdioEntry", () => {
  it("accepts an empty argv as the default stdio entry", () => {
    const result = parseStdioEntry([]);
    expect(result).toEqual({ ok: true, mode: "stdio" });
  });

  it("accepts 'serve' as a stdio alias", () => {
    const result = parseStdioEntry(["serve"]);
    expect(result).toEqual({ ok: true, mode: "stdio" });
  });

  it("rejects an unknown subcommand with a named error", () => {
    const result = parseStdioEntry(["retrive"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("retrive");
    expect(result.error).toMatch(/usage:/i);
  });

  it("rejects a positional arg that names another CLI", () => {
    // extract / consolidate / eval each have their own bin entries; they
    // must NOT be silently accepted by the stdio entry, which would
    // mask operator typos as MCP hangs.
    const result = parseStdioEntry(["extract"]);
    expect(result.ok).toBe(false);
  });

  it("rejects `config` as a subcommand (operator-console T2)", () => {
    // The setting CLI lives on its own bin (`iknow-memory-config`).
    // Operators must NOT be able to invoke it as `iknow-memory config`;
    // that would either hang the stdio transport (silently treated as
    // an unknown subcommand) or shadow the real config CLI by mistake.
    // Acceptance: `iknow-memory` CLI/stdio rejects `config`.
    const result = parseStdioEntry(["config"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("config");
  });

  it("rejects `iknow-memory-config` as a positional subcommand for the same reason", () => {
    const result = parseStdioEntry(["iknow-memory-config"]);
    expect(result.ok).toBe(false);
  });
});

describe("iknow-memory bin entry", () => {
  it("bin/iknow-memory.js exists at the package root", () => {
    const binPath = path.join(pkgRoot, "bin", "iknow-memory.js");
    expect(existsSync(binPath)).toBe(true);
  });

  it("bin/iknow-memory.js is a shebang wrapper that resolves dist/index.js", () => {
    const binPath = path.join(pkgRoot, "bin", "iknow-memory.js");
    const body = readFileSync(binPath, "utf8");
    // Same shape as bin/extract.js (which the existing console consumers
    // already rely on): shebang + dynamic import of the compiled entry.
    expect(body.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(body).toMatch(/dist\/index\.js/);
  });

  it("package.json `bin.iknow-memory` matches the bin script path", () => {
    const pkgPath = path.join(pkgRoot, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      bin?: Record<string, string>;
    };
    expect(pkg.bin?.["iknow-memory"]).toBe("bin/iknow-memory.js");
  });
});

describe("iknow-memory-config bin entry (operator-console T2)", () => {
  it("bin/iknow-memory-config.js exists at the package root", () => {
    const binPath = path.join(pkgRoot, "bin", "iknow-memory-config.js");
    expect(existsSync(binPath)).toBe(true);
  });

  it("bin/iknow-memory-config.js is a shebang wrapper that resolves dist/cli/config.js", () => {
    const binPath = path.join(pkgRoot, "bin", "iknow-memory-config.js");
    const body = readFileSync(binPath, "utf8");
    expect(body.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(body).toMatch(/dist\/cli\/config\.js/);
  });

  it("package.json `bin.iknow-memory-config` matches the bin script path", () => {
    const pkgPath = path.join(pkgRoot, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      bin?: Record<string, string>;
    };
    expect(pkg.bin?.["iknow-memory-config"]).toBe("bin/iknow-memory-config.js");
  });
});
