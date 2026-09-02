/**
 * Prod entry for the eval CLI (E-T8 / specs/p0-eval.md A13, SC12, SC14).
 *
 * `npm run gate:pr` / `gate:release` invoke `node dist/cli/eval.js`, which
 * sets argv[1] to the compiled file. Unit tests import the module under
 * vitest so they never hit that path. This file spawns the compiled binary.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI_PATH = join(process.cwd(), "dist/cli/eval.js");

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCompiledEval(args: string[]): Promise<ProcResult> {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `compiled CLI missing at ${CLI_PATH} — run \`npm run build\` first`
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe("prod eval entry (E-T8)", () => {
  it("--gate pr does not TDZ and exits 0 in the bootstrap period", async () => {
    const result = await runCompiledEval(["--gate", "pr"]);
    expect(result.stderr).not.toMatch(/Cannot access 'EvalConfigError'/);
    expect(result.stderr).not.toMatch(/ReferenceError/);
    expect(result.code).toBe(0);
  });

  it("--gate release refuses until lock without a ReferenceError", async () => {
    const result = await runCompiledEval(["--gate", "release"]);
    expect(result.stderr).not.toMatch(/Cannot access 'EvalConfigError'/);
    expect(result.stderr).not.toMatch(/ReferenceError/);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/config error:/);
  });
});
