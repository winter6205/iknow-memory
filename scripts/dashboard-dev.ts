/**
 * Dev orchestrator: start dashboard-api and the vite SPA with one command
 * (`npm run dashboard`). Either child exiting, or Ctrl-C, tears down the
 * full process tree so ports 4174 / 18868 are not left occupied.
 *
 * Zero-config: when no storage env is set, the API child boots memory mode
 * with graph + rerank + the ES precision layer explicitly off so the
 * ADR-0006 / ADR-0007 fail-start checks do not fire.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DASHBOARD_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);

export type ChildSpawnSpec = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
};

export type DashboardInstaller = (dashboardPrefix: string) => number;

const VITE_BIN_REL = "dashboard/node_modules/.bin/vite";

const MISSING_VITE_HINT =
  "dashboard Vite binary is missing. Run: npm install --prefix dashboard";

function defaultDashboardInstaller(dashboardPrefix: string): number {
  const result = spawnSync("npm", ["install", "--prefix", dashboardPrefix], {
    stdio: "inherit",
  });
  return result.status ?? 1;
}

export function ensureDashboardVite(
  root: string,
  installer: DashboardInstaller = defaultDashboardInstaller
): void {
  const vite = join(root, VITE_BIN_REL);
  if (existsSync(vite)) return;
  const status = installer(join(root, "dashboard"));
  if (status !== 0 || !existsSync(vite)) {
    throw new Error(MISSING_VITE_HINT);
  }
}

export type ChildLifecycleHooks = {
  isShuttingDown: () => boolean;
  shutdown: (exitCode: number) => void;
};

export function attachChildLifecycle(
  child: Pick<ChildProcess, "on">,
  spec: Pick<ChildSpawnSpec, "name">,
  hooks: ChildLifecycleHooks
): void {
  child.on("exit", (code, signal) => {
    if (hooks.isShuttingDown()) return;
    console.error(
      `[dashboard] ${spec.name} exited (code=${code} signal=${signal}), stopping all`
    );
    hooks.shutdown(code === 0 ? 0 : (code ?? 1));
  });
  child.on("error", (err) => {
    if (hooks.isShuttingDown()) return;
    console.error(`[dashboard] ${spec.name} failed to start: ${String(err)}`);
    hooks.shutdown(1);
  });
}

export function dashboardChildSpawns(root: string): ChildSpawnSpec[] {
  return [
    {
      name: "dashboard-api",
      command: process.execPath,
      args: ["--import", "tsx", join(root, "src/dashboard-api/main.ts")],
      cwd: root,
    },
    {
      name: "dashboard:dev",
      command: join(root, "dashboard/node_modules/.bin/vite"),
      args: [],
      cwd: join(root, "dashboard"),
    },
  ];
}

const STORAGE_ENV_KEYS = [
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_NEO4J_URI",
] as const;

function stripQuotes(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted ? value.slice(1, -1) : value;
}

/** Parse one `.env.local` line into a storage key/value pair, or null. */
function parseStorageLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  if (!STORAGE_ENV_KEYS.includes(key as (typeof STORAGE_ENV_KEYS)[number])) {
    return null;
  }
  const value = stripQuotes(trimmed.slice(eq + 1).trim());
  if (value.startsWith("<") && value.endsWith(">")) return null;
  return [key, value];
}

export function readStorageFileEnv(root: string): NodeJS.ProcessEnv {
  const path = join(root, ".env.local");
  if (!existsSync(path)) return {};
  const out: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const parsed = parseStorageLine(line);
    if (parsed === null) continue;
    const [key, value] = parsed;
    out[key] = value;
  }
  return out;
}

const children: ChildProcess[] = [];
let shuttingDown = false;

export function isStorageConfigured(
  env: NodeJS.ProcessEnv,
  fileEnv: NodeJS.ProcessEnv = {}
): boolean {
  return STORAGE_ENV_KEYS.some((key) => {
    const raw = Object.prototype.hasOwnProperty.call(env, key)
      ? env[key]
      : fileEnv[key];
    return raw !== undefined && raw.trim() !== "";
  });
}

const API_PORT_ENV = "GRAPHRAG_MEMORY_DASHBOARD_PORT";
const DEFAULT_API_PORT = 4174;
const SPA_PORT = 18868;

export function resolveDashboardApiPort(env: NodeJS.ProcessEnv): number {
  const raw = env[API_PORT_ENV]?.trim();
  const port = raw === undefined || raw === "" ? DEFAULT_API_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `${API_PORT_ENV} must be an integer in [0, 65535], got "${raw ?? ""}"`
    );
  }
  if (port === SPA_PORT) {
    throw new Error(
      `${API_PORT_ENV} must not be ${SPA_PORT} (reserved for the SPA)`
    );
  }
  return port;
}

export function buildDashboardChildEnv(
  inherited: NodeJS.ProcessEnv,
  fileEnv: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const next = isStorageConfigured(inherited, fileEnv)
    ? { ...inherited }
    : {
        ...inherited,
        GRAPHRAG_MEMORY_STORAGE: "memory",
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "8",
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "8",
        GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "false",
        GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
        // ADR-0007: the precision layer is default-on and there is no ES
        // address in memory mode, so take the explicit-off escape hatch —
        // the dashboard reads the ledger, never the lexical arm.
        GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "false",
      };
  return {
    ...next,
    [API_PORT_ENV]: String(resolveDashboardApiPort(next)),
  };
}

export function terminateChildGroup(
  pid: number,
  kill: typeof process.kill = process.kill,
  signal: NodeJS.Signals = "SIGTERM"
): void {
  try {
    kill(-pid, signal);
  } catch {
    // EXIT: process group already gone (crashed child or prior SIGTERM).
  }
}

function start(spec: ChildSpawnSpec, env: NodeJS.ProcessEnv): ChildProcess {
  // Own process group per child so SIGTERM to -pid reaches vite/tsx
  // grandchildren. npm-as-parent does not forward signals reliably.
  const child = spawn(spec.command, spec.args, {
    stdio: "inherit",
    env,
    cwd: spec.cwd,
    detached: true,
  });
  children.push(child);
  attachChildLifecycle(child, spec, {
    isShuttingDown: () => shuttingDown,
    shutdown,
  });
  console.error(`[dashboard] started ${spec.name} (pid ${child.pid})`);
  return child;
}

function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.pid !== undefined) {
      terminateChildGroup(child.pid);
    }
  }
  const finish = (): void => {
    process.exit(exitCode);
  };
  const pending = children.filter(
    (child) => child.exitCode === null && child.signalCode === null
  );
  if (pending.length === 0) {
    finish();
    return;
  }
  let remaining = pending.length;
  const force = setTimeout(() => {
    for (const child of pending) {
      if (child.pid !== undefined) {
        terminateChildGroup(child.pid, process.kill, "SIGKILL");
      }
    }
    finish();
  }, 2000);
  for (const child of pending) {
    child.once("exit", () => {
      remaining -= 1;
      if (remaining <= 0) {
        clearTimeout(force);
        finish();
      }
    });
  }
}

function isMain(): boolean {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return (
    arg1.endsWith("scripts/dashboard-dev.ts") ||
    arg1.endsWith("scripts/dashboard-dev.js")
  );
}

if (isMain()) {
  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));
  process.on("SIGHUP", () => shutdown(129));

  const fileEnv = readStorageFileEnv(DASHBOARD_ROOT);
  const env = buildDashboardChildEnv(process.env, fileEnv);
  if (!isStorageConfigured(process.env, fileEnv)) {
    console.error(
      "[dashboard] no GRAPHRAG_MEMORY_* storage env set — starting dashboard-api in memory mode (empty store; Neo4j graph routes stay optional / error until configured)"
    );
  }
  ensureDashboardVite(DASHBOARD_ROOT);
  for (const spec of dashboardChildSpawns(DASHBOARD_ROOT)) {
    start(spec, env);
  }
}
