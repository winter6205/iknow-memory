/**
 * `iknow-memory-config` CLI — minimal read/write/list surface for the
 * operator setting file at `~/.iknow-memory/setting.json`.
 *
 * Subcommands (operator-console T2):
 *   list                   — print every key=value, one per line
 *   get <KEY>              — print one value (exit 0) or exit 3 if absent
 *   set <KEY> <VALUE>      — write one key=value (create-or-replace)
 *   unset <KEY>            — delete one key (exit 0 if absent; idempotent)
 *
 * Exit codes:
 *   0  success
 *   1  unexpected fatal (e.g. write failure)
 *   2  usage error (unknown subcommand / missing args)
 *   3  `get` for an absent key — named "no value", not a crash
 *
 * Why this lives in its own bin (`iknow-memory-config`) and not as a
 * subcommand of `iknow-memory`: the spec freezes `iknow-memory` as
 * stdio-only with no subcommands (`parseStdioEntry` in
 * `src/cli/stdio-entry.ts` rejects anything but `[]` / `["serve"]`).
 * A second bin keeps the MCP server's argv parser unchanged and gives
 * hosts a stable `("iknow-memory",)` to wire into MCP without
 * accidentally shadowing the setting CLI.
 *
 * No secrets are echoed. Errors name the offending key but never the
 * value (see tests/config/setting/config-cli.test.ts).
 */
import {
  createSettingStore,
  type SettingMap,
  type SettingStore,
} from "../config/setting-store.js";

/** Tagged command the parser emits. */
export type ConfigCommand =
  | { kind: "list" }
  | { kind: "get"; key: string }
  | { kind: "set"; key: string; value: string }
  | { kind: "unset"; key: string };

export type ParsedConfigArgs =
  { ok: true; command: ConfigCommand } | { ok: false; error: string };

const USAGE =
  "usage: iknow-memory-config <list | get KEY | set KEY VALUE | unset KEY>";

/**
 * Parse argv into a tagged command. The contract is intentionally small:
 * no flags, no `--help` (operators learn it from the usage line printed
 * on a usage error); expanding the surface later is a deliberate change.
 */
export function parseConfigArgs(argv: readonly string[]): ParsedConfigArgs {
  const [head, ...rest] = argv;
  if (head === undefined) return { ok: false, error: USAGE };
  if (head === "list") {
    if (rest.length !== 0) return { ok: false, error: USAGE };
    return { ok: true, command: { kind: "list" } };
  }
  if (head === "get") {
    if (rest.length !== 1) return { ok: false, error: USAGE };
    return { ok: true, command: { kind: "get", key: rest[0]! } };
  }
  if (head === "set") {
    if (rest.length !== 2) return { ok: false, error: USAGE };
    return {
      ok: true,
      command: { kind: "set", key: rest[0]!, value: rest[1]! },
    };
  }
  if (head === "unset") {
    if (rest.length !== 1) return { ok: false, error: USAGE };
    return { ok: true, command: { kind: "unset", key: rest[0]! } };
  }
  return { ok: false, error: `unknown subcommand "${head}" (${USAGE})` };
}

export interface ConfigRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ConfigRunDeps {
  store: SettingStore;
  /** Stream the operator sees on stdout. Per-call so the test can capture. */
  stdout: (line: string) => void;
  /** Same for stderr — error / usage lines only. */
  stderr: (line: string) => void;
}

/**
 * Dispatch a parsed command. Pure over `deps` (no `console.log` /
 * `process.exit` here) so the bin wrapper (`bin/iknow-memory-config.js`)
 * owns the exit-code plumbing and the tests can assert on captured
 * stdout/stderr.
 */
export async function runConfigCli(
  command: ConfigCommand,
  deps: ConfigRunDeps
): Promise<ConfigRunResult> {
  switch (command.kind) {
    case "list": {
      const map = await deps.store.read();
      const keys = Object.keys(map).sort();
      for (const k of keys) {
        deps.stdout(`${k}=${map[k]}`);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    case "get": {
      const map = await deps.store.read();
      const v = map[command.key];
      if (v === undefined) {
        const msg = `iknow-memory-config: ${command.key}: no value set\n`;
        deps.stderr(msg);
        return { code: 3, stdout: "", stderr: msg };
      }
      deps.stdout(`${v}\n`);
      return { code: 0, stdout: "", stderr: "" };
    }
    case "set": {
      const prev = await deps.store.read();
      const next: SettingMap = { ...prev, [command.key]: command.value };
      await deps.store.write(next);
      return { code: 0, stdout: "", stderr: "" };
    }
    case "unset": {
      // Idempotent — `unset` on an absent key is a no-op, exit 0.
      const prev = await deps.store.read();
      if (command.key in prev) {
        const next: Record<string, string> = { ...prev };
        delete next[command.key];
        await deps.store.write(next);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  }
}

/**
 * Top-level entry: parse argv, dispatch, exit. Uses the operator's
 * real `$HOME` — the bin wrapper just calls this and propagates the
 * exit code.
 */
export async function main(argv?: readonly string[]): Promise<void> {
  const args = argv ?? process.argv.slice(2);
  const parsed = parseConfigArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`iknow-memory-config: ${parsed.error}\n`);
    process.exit(2);
    return;
  }
  const store = createSettingStore();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runConfigCli(parsed.command, {
    store,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  if (stdout.length > 0) process.stdout.write(stdout.join("\n") + "\n");
  if (stderr.length > 0) process.stderr.write(stderr.join(""));
  process.exit(result.code);
}

// Run only when invoked directly.
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return arg1.endsWith("cli/config.ts") || arg1.endsWith("cli/config.js");
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(
      `iknow-memory-config fatal: ${(err as Error).message ?? err}\n`
    );
    process.exit(1);
  });
}
