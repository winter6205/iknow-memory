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
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import pg from "pg";
import { loadEnv, type GraphragEnv } from "../config.js";
import {
  createSettingStore,
  type SettingMap,
  type SettingStore,
} from "../config/setting-store.js";
import { parseEnvFile } from "../config/env-file.js";
import { isSecretKey } from "../config/key-registry.js";
import {
  describeEffectiveConfig,
  formatEffectiveConfig,
  redactDatabaseUrlUserinfo,
  type RecordedEmbedGeneration,
} from "../config/effective-config.js";
import {
  describeStoredProcessReports,
  fingerprintsFromEnv,
  readHttpRerankModel,
} from "../config/process-fingerprint.js";

/** Tagged command the parser emits. */
export type ConfigCommand =
  | { kind: "list" }
  | { kind: "show" }
  | { kind: "get"; key: string }
  | { kind: "set"; key: string; value: string }
  | { kind: "unset"; key: string };

export type ParsedConfigArgs =
  { ok: true; command: ConfigCommand } | { ok: false; error: string };

const USAGE =
  "usage: iknow-memory-config <list | show | get KEY | set KEY VALUE | unset KEY>";

function parseZeroArgConfigCommand(
  kind: "list" | "show",
  rest: readonly string[]
): ParsedConfigArgs {
  if (rest.length !== 0) return { ok: false, error: USAGE };
  return { ok: true, command: { kind } };
}

function parseKeyConfigCommand(
  kind: "get" | "unset",
  rest: readonly string[]
): ParsedConfigArgs {
  if (rest.length !== 1) return { ok: false, error: USAGE };
  return { ok: true, command: { kind, key: rest[0]! } };
}

function parseSetConfigCommand(rest: readonly string[]): ParsedConfigArgs {
  if (rest.length !== 2) return { ok: false, error: USAGE };
  return {
    ok: true,
    command: { kind: "set", key: rest[0]!, value: rest[1]! },
  };
}

function parseNamedConfigCommand(
  head: string,
  rest: readonly string[]
): ParsedConfigArgs | undefined {
  if (head === "list" || head === "show") {
    return parseZeroArgConfigCommand(head, rest);
  }
  if (head === "get" || head === "unset") {
    return parseKeyConfigCommand(head, rest);
  }
  if (head === "set") return parseSetConfigCommand(rest);
  return undefined;
}

/**
 * Parse argv into a tagged command. The contract is intentionally small:
 * no flags, no `--help` (operators learn it from the usage line printed
 * on a usage error); expanding the surface later is a deliberate change.
 */
export function parseConfigArgs(argv: readonly string[]): ParsedConfigArgs {
  const [head, ...rest] = argv;
  if (head === undefined) return { ok: false, error: USAGE };
  const command = parseNamedConfigCommand(head, rest);
  if (command === undefined) {
    return { ok: false, error: `unknown subcommand "${head}" (${USAGE})` };
  }
  return command;
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
  /** Defaults to `process.env`. Tests pass a closed bag. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /** Fingerprint of this show process. Absent skips mismatch lines. */
  currentFingerprints?: { retrieval: string; extraction: string };
  /** Singleton model and dimensions. Absent skips the embed freeze check. */
  recordedGeneration?: RecordedEmbedGeneration | null;
  sourceExtractionFingerprints?: readonly (string | null)[];
  gaps?: readonly string[];
  /** Read-only catalog. A throw is reported as `embed generation not read`. */
  readCatalog?: ShowCatalogReader;
}

export interface ShowCatalogSnapshot {
  recordedGeneration: RecordedEmbedGeneration | null;
  sourceExtractionFingerprints: readonly (string | null)[];
}

export type ShowCatalogReader = () => Promise<ShowCatalogSnapshot>;

const EMBED_GENERATION_SELECT =
  "SELECT active_model, active_dimensions FROM embedding_generation WHERE id = 1";
const EXTRACTION_FINGERPRINT_SELECT =
  "SELECT extraction_fingerprint, COUNT(*)::int AS source_count FROM source_documents GROUP BY extraction_fingerprint";

export const PROCESS_FINGERPRINTS_NOT_READ = "process fingerprints not read";
export const EMBED_GENERATION_NOT_READ = "embed generation not read";

/**
 * Dispatch a parsed command. Pure over `deps` (no `console.log` /
 * `process.exit` here) so the bin wrapper (`bin/iknow-memory-config.js`)
 * owns the exit-code plumbing and the tests can assert on captured
 * stdout/stderr.
 */
function maskStoredValue(key: string, value: string): string {
  if (isSecretKey(key)) return value.trim() === "" ? "unset" : "configured";
  if (key === "GRAPHRAG_MEMORY_DB_URL") return redactDatabaseUrlUserinfo(value);
  return value;
}

async function emitList(deps: ConfigRunDeps): Promise<void> {
  const map = await deps.store.read();
  for (const k of Object.keys(map).sort()) {
    deps.stdout(`${k}=${maskStoredValue(k, map[k] ?? "")}`);
  }
}

async function catalogForShow(deps: ConfigRunDeps): Promise<{
  recordedGeneration: RecordedEmbedGeneration | null | undefined;
  sourceExtractionFingerprints: readonly (string | null)[] | undefined;
  gaps: string[];
}> {
  if (deps.readCatalog === undefined) {
    return {
      recordedGeneration: deps.recordedGeneration,
      sourceExtractionFingerprints: deps.sourceExtractionFingerprints,
      gaps: [],
    };
  }
  try {
    const snapshot = await deps.readCatalog();
    return {
      recordedGeneration: snapshot.recordedGeneration,
      sourceExtractionFingerprints: snapshot.sourceExtractionFingerprints,
      gaps: [],
    };
  } catch {
    return {
      recordedGeneration: undefined,
      sourceExtractionFingerprints: undefined,
      gaps: [EMBED_GENERATION_NOT_READ],
    };
  }
}

async function emitShow(deps: ConfigRunDeps): Promise<void> {
  const map = await deps.store.read();
  const home = dirname(deps.store.path);
  const catalog = await catalogForShow(deps);
  const report = describeEffectiveConfig({
    env: deps.env ?? process.env,
    setting: map,
    homeEnv: parseEnvFile(join(home, ".env.local")),
    cwdEnvLocalPresent: existsSync(
      join(deps.cwd ?? process.cwd(), ".env.local")
    ),
    sourceExtractionFingerprints: catalog.sourceExtractionFingerprints,
    recordedGeneration: catalog.recordedGeneration,
    processReportLines: describeStoredProcessReports(
      home,
      deps.currentFingerprints
    ),
    gaps: [...(deps.gaps ?? []), ...catalog.gaps],
  });
  for (const line of formatEffectiveConfig(report).split("\n")) {
    if (line !== "") deps.stdout(line);
  }
}

export async function runConfigCli(
  command: ConfigCommand,
  deps: ConfigRunDeps
): Promise<ConfigRunResult> {
  switch (command.kind) {
    case "list":
      await emitList(deps);
      return { code: 0, stdout: "", stderr: "" };
    case "show":
      await emitShow(deps);
      return { code: 0, stdout: "", stderr: "" };
    case "get": {
      const map = await deps.store.read();
      const v = map[command.key];
      if (v === undefined) {
        const msg = `iknow-memory-config: ${command.key}: no value set\n`;
        deps.stderr(msg);
        return { code: 3, stdout: "", stderr: msg };
      }
      deps.stdout(`${maskStoredValue(command.key, v)}\n`);
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

type CatalogQuery = (
  sql: string
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

function fingerprintValue(entry: Record<string, unknown>): string | null {
  const raw = entry.extraction_fingerprint;
  if (typeof raw !== "string" || raw === "") return null;
  return raw;
}

function sourceCount(entry: Record<string, unknown>): number {
  if (entry.source_count === undefined) return 1;
  const raw = entry.source_count;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && /^[0-9]+$/.test(raw)) return Number(raw);
  return 0;
}

function expandFingerprintCounts(
  rows: ReadonlyArray<Record<string, unknown>>
): (string | null)[] {
  const values: (string | null)[] = [];
  for (const entry of rows) {
    const fingerprint = fingerprintValue(entry);
    const count = sourceCount(entry);
    for (let index = 0; index < count; index += 1) values.push(fingerprint);
  }
  return values;
}

function assertSelect(sql: string): void {
  const verb = sql.trim().split(/\s+/, 1)[0]?.toUpperCase();
  if (verb !== "SELECT") {
    throw new Error("show catalog query is not a SELECT");
  }
}

export async function readShowCatalog(
  query: CatalogQuery
): Promise<ShowCatalogSnapshot> {
  assertSelect(EMBED_GENERATION_SELECT);
  assertSelect(EXTRACTION_FINGERPRINT_SELECT);
  const generation = await query(EMBED_GENERATION_SELECT);
  const fingerprints = await query(EXTRACTION_FINGERPRINT_SELECT);
  const row = generation.rows[0];
  return {
    recordedGeneration: row
      ? {
          model: typeof row.active_model === "string" ? row.active_model : null,
          dimensions: Number(row.active_dimensions),
        }
      : null,
    sourceExtractionFingerprints: expandFingerprintCounts(fingerprints.rows),
  };
}

export async function openShowCatalog(
  dbUrl: string
): Promise<ShowCatalogSnapshot> {
  const client = new pg.Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    return await readShowCatalog(async (sql) => {
      const result = await client.query(sql);
      return { rows: result.rows as ReadonlyArray<Record<string, unknown>> };
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function showCatalogReaderForEnv(
  env: { storage: string; dbUrl?: string },
  open: (dbUrl: string) => ShowCatalogReader
): ShowCatalogReader | undefined {
  if (
    env.storage !== "pgvector" ||
    env.dbUrl === undefined ||
    env.dbUrl === ""
  ) {
    return undefined;
  }
  return open(env.dbUrl);
}

/**
 * Top-level entry: parse argv, dispatch, exit. Uses the operator's
 * real `$HOME` — the bin wrapper just calls this and propagates the
 * exit code.
 */
export async function currentProcessFingerprints(
  load: () => GraphragEnv = loadEnv
): Promise<{
  fingerprints?: { retrieval: string; extraction: string };
  gaps: readonly string[];
}> {
  try {
    const env = load();
    const rerankModel =
      env.rerankUrl !== undefined
        ? await readHttpRerankModel(env.rerankUrl)
        : env.llm.rerank.model;
    const fingerprints = fingerprintsFromEnv(env, rerankModel);
    return {
      fingerprints: {
        retrieval: fingerprints.retrieval,
        extraction: fingerprints.extraction,
      },
      gaps: fingerprints.gaps,
    };
  } catch {
    return { gaps: [PROCESS_FINGERPRINTS_NOT_READ] };
  }
}

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
  const compared = await currentProcessFingerprints();
  let readCatalog: ShowCatalogReader | undefined;
  const catalogGaps: string[] = [];
  try {
    const env = loadEnv();
    readCatalog = showCatalogReaderForEnv(
      env,
      (dbUrl) => () => openShowCatalog(dbUrl)
    );
  } catch {
    catalogGaps.push(EMBED_GENERATION_NOT_READ);
  }
  const result = await runConfigCli(parsed.command, {
    store,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    currentFingerprints: compared.fingerprints,
    gaps: [...compared.gaps, ...catalogGaps],
    readCatalog,
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
