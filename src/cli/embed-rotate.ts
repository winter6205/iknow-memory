/**
 * embed-rotate CLI — drive the embedding-generation rotate lifecycle
 * (embedding generation rotate T4; specs/embedding-generation.md).
 *
 * Offline operator tool, never an MCP surface. One subcommand per run:
 *
 *   open --mode dual_write|downtime [--accept-downtime]
 *                                 add the incoming slot + index per class
 *                                 and record incoming_* (T1's openRotate);
 *                                 `downtime` refuses without the acceptance
 *                                 flag because it blanks vector retrieval
 *   fill [--batch-size N]         embed every row still missing the incoming
 *                                 vector, from stored ledger text
 *   cutover                       completeness-gated single pointer flip
 *   rollback                      swap back to the displaced generation
 *   drop                          DROP INDEX + DROP COLUMN for the inactive
 *                                 slot(s); a no-op when none is recorded
 *   status                        print the ledger singleton as JSON
 *
 * Exit-code map:
 *   0 success (incl. drop's documented no-op).
 *   1 config error or typed refusal (GraphragError) — message on stderr.
 *   2 usage error (unknown subcommand/flag, missing --mode, downtime
 *     without --accept-downtime, flags on flagless subcommands).
 */
import { Pool, type PoolClient } from "pg";

import {
  ConfigError,
  loadEnv,
  type GraphragEnv,
} from "../config.js";
import { createLogger, writeStderr, type Logger } from "../logging.js";
import { GraphragError } from "../core/errors.js";
import { buildEmbedderClient, type EmbedderClientEnv } from "../core/extraction/clients.js";
import {
  createSlotEmbeddingSource,
  type SlotEmbeddingSource,
} from "../core/embed-slots.js";
import {
  openRotate,
  readGenerationState,
  type DesiredEmbeddingGeneration,
} from "../core/storage/embedding-generation.js";
import {
  cutoverRotate,
  dropInactiveSlot,
  fillIncoming,
  rollbackRotate,
} from "../core/storage/embedding-rotate.js";
import type { SchemaBootstrapClient } from "../core/storage/schema-bootstrap.js";
import { isEmbedRotateMode, type EmbedRotateMode } from "../core/types.js";

const USAGE =
  "usage: embed-rotate open --mode dual_write|downtime [--accept-downtime]\n" +
  "       embed-rotate fill [--batch-size N]\n" +
  "       embed-rotate cutover | rollback | drop | status";

interface OpenCommand {
  command: "open";
  mode: EmbedRotateMode;
}
interface FillCommand {
  command: "fill";
  batchSize: number | undefined;
}
interface PlainCommand {
  command: "cutover" | "rollback" | "drop" | "status";
}
type RotateCommand = OpenCommand | FillCommand | PlainCommand;

type ParsedArgs =
  { ok: true; command: RotateCommand } | { ok: false; error: string };

/** Flags each subcommand accepts — anything else is a usage error, never a silently dropped flag. */
const ALLOWED_FLAGS: Record<RotateCommand["command"], readonly string[]> = {
  open: ["--mode", "--accept-downtime"],
  fill: ["--batch-size"],
  cutover: [],
  rollback: [],
  drop: [],
  status: [],
};

export function parseArgs(argv: string[]): ParsedArgs {
  const head = argv[0];
  if (
    head !== "open" &&
    head !== "fill" &&
    head !== "cutover" &&
    head !== "rollback" &&
    head !== "drop" &&
    head !== "status"
  ) {
    return { ok: false, error: `unknown subcommand: ${JSON.stringify(head ?? "")}` };
  }
  const rest = argv.slice(1);
  for (const arg of rest) {
    if (arg.startsWith("--") && !ALLOWED_FLAGS[head].includes(arg)) {
      return { ok: false, error: `unknown flag: "${arg}" for subcommand "${head}"` };
    }
  }
  if (head === "open") return parseOpen(rest);
  if (head === "fill") return parseFill(rest);
  if (rest.length > 0) {
    return { ok: false, error: `"${head}" takes no flags` };
  }
  return { ok: true, command: { command: head } };
}

function parseOpen(rest: string[]): ParsedArgs {
  let mode: string | undefined;
  let acceptDowntime = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--mode") {
      mode = rest[i + 1];
      i += 1;
    } else if (rest[i] === "--accept-downtime") {
      acceptDowntime = true;
    }
  }
  if (mode === undefined) {
    return { ok: false, error: `"open" requires --mode dual_write|downtime` };
  }
  if (!isEmbedRotateMode(mode)) {
    return {
      ok: false,
      error: `--mode must be dual_write or downtime, got "${mode}"`,
    };
  }
  if (mode === "downtime" && !acceptDowntime) {
    return {
      ok: false,
      error:
        "downtime rotates refuse ALL vector retrieval until cutover — " +
        "confirm you understand by passing --accept-downtime",
    };
    // EXIT: the acceptance flag is the operator's signature on the blind window.
  }
  return { ok: true, command: { command: "open", mode } };
}

function parseFill(rest: string[]): ParsedArgs {
  let batchSize: number | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--batch-size") {
      const n = Number(rest[i + 1]);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, error: `--batch-size requires a positive integer` };
      }
      batchSize = n;
      i += 1;
    }
  }
  return { ok: true, command: { command: "fill", batchSize } };
}

export interface EmbedRotateDeps {
  /** Dedicated connection: open/cutover/rollback/drop run transactions on it. */
  client: SchemaBootstrapClient;
  /** The env-configured generation `open` rotates toward. */
  desired: DesiredEmbeddingGeneration;
  /** Only `fill` needs it; the env wiring builds it behind the credential guard. */
  source?: SlotEmbeddingSource;
  annMaxDimensions: number;
  logger: Logger;
  /** stdout seam for result lines. */
  out: (line: string) => void;
}

/** Top-level entry, testable: parse, dispatch, map refusals to exit codes. */
export async function runCli(
  argv: string[],
  deps: EmbedRotateDeps
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`${USAGE}\nembed-rotate: ${parsed.error}\n`);
    return 2;
  }
  try {
    return await dispatch(parsed.command, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeStderr(`embed-rotate: ${msg}\n`);
    deps.logger.error("embed-rotate-failed", { error: msg });
    return 1;
  }
}

async function dispatch(
  command: RotateCommand,
  deps: EmbedRotateDeps
): Promise<number> {
  switch (command.command) {
    case "open": {
      const state = await openRotate(
        deps.client,
        deps.desired,
        command.mode,
        deps.annMaxDimensions
      );
      deps.out(JSON.stringify(state));
      return 0;
    }
    case "fill": {
      if (deps.source === undefined) {
        throw new GraphragError(
          "fill needs an embedder but none was wired — check the embedding env block",
          "STORAGE_ERROR"
        );
        // EXIT: defensive — runCliFromEnv only omits `source` for non-fill runs.
      }
      const summary = await fillIncoming(deps.client, deps.source, {
        ...(command.batchSize !== undefined
          ? { batchSize: command.batchSize }
          : {}),
      });
      deps.out(JSON.stringify(summary));
      return 0;
    }
    case "cutover":
      deps.out(JSON.stringify(await cutoverRotate(deps.client)));
      return 0;
    case "rollback":
      deps.out(JSON.stringify(await rollbackRotate(deps.client)));
      return 0;
    case "drop":
      deps.out(JSON.stringify(await dropInactiveSlot(deps.client)));
      return 0;
    case "status":
      deps.out(JSON.stringify(await readGenerationState(deps.client)));
      return 0;
  }
}

/** Wire real deps from env and run; used by main(). */
export async function runCliFromEnv(argv: string[]): Promise<number> {
  let env: GraphragEnv;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`embed-rotate config error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (!env.dbUrl) {
    writeStderr(
      "embed-rotate config error: GRAPHRAG_MEMORY_DB_URL is required\n"
    );
    return 1;
  }
  let source: SlotEmbeddingSource | undefined;
  if (argv[0] === "fill") {
    // The credential guard runs only for fill: open/cutover/drop/status move
    // pointers and DDL, never vectors, so they stay usable keyless.
    try {
      source = fillSource(env);
    } catch (err) {
      if (err instanceof ConfigError) {
        writeStderr(`embed-rotate config error: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
  const pool = new Pool({ connectionString: env.dbUrl });
  try {
    const client: PoolClient = await pool.connect();
    try {
      return await runCli(argv, {
        client,
        desired: { model: env.embedModel, dimensions: env.embedDimensions },
        ...(source !== undefined ? { source } : {}),
        annMaxDimensions: env.pgvectorAnnMaxDimensions,
        logger: createLogger(env.logLevel),
        out: (line) => process.stdout.write(`${line}\n`),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeStderr(`embed-rotate fatal: ${msg}\n`);
    return 1;
  } finally {
    await pool.end();
  }
}

function fillSource(env: GraphragEnv): SlotEmbeddingSource {
  const embedderEnv: EmbedderClientEnv = {
    apiKey: env.embedApiKey,
    baseUrl: env.embedBaseUrl,
    model: env.embedModel,
    dimensions: env.embedDimensions,
  };
  // persistsEmbeddings: a fill writes REAL vectors toward the incoming
  // generation — a keyless fake there would poison the cutover target
  // (CR High #1 doctrine, same as the extract backfill path).
  const embedder = buildEmbedderClient(embedderEnv, {
    persistsEmbeddings: true,
  });
  return createSlotEmbeddingSource(embedderEnv, embedder);
}

/** Top-level entry: wire real deps, exit with the CLI exit code. */
export async function main(): Promise<void> {
  const code = await runCliFromEnv(process.argv.slice(2));
  process.exit(code);
}

// Run only when invoked directly. Mirrors src/cli/extract.ts isMain.
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return (
    arg1.endsWith("cli/embed-rotate.ts") || arg1.endsWith("cli/embed-rotate.js")
  );
})();

if (isMain) {
  main().catch((err) => {
    writeStderr(
      `embed-rotate fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}
