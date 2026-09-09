/**
 * Dev orchestrator: start dashboard-api and the vite SPA with one command
 * (`npm run dashboard`). Either child exiting, or Ctrl-C, tears down the
 * full process tree so ports 4174 / 18868 are not left occupied.
 *
 * Zero-config: when no storage env is set, the API child boots memory mode
 * with graph + rerank explicitly off so ADR-0006 fail-start does not fire.
 */
import { spawn, type ChildProcess } from "node:child_process";
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

const children: ChildProcess[] = [];
let shuttingDown = false;

export function isStorageConfigured(env: NodeJS.ProcessEnv): boolean {
  return STORAGE_ENV_KEYS.some((key) => {
    const raw = env[key];
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
  inherited: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const next = isStorageConfigured(inherited)
    ? { ...inherited }
    : {
        ...inherited,
        GRAPHRAG_MEMORY_STORAGE: "memory",
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "8",
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "8",
        GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "false",
        GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
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
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[dashboard] ${spec.name} exited (code=${code} signal=${signal}), stopping all`
    );
    shutdown(code === 0 ? 0 : (code ?? 1));
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

  const env = buildDashboardChildEnv(process.env);
  if (!isStorageConfigured(process.env)) {
    console.error(
      "[dashboard] no GRAPHRAG_MEMORY_* storage env set — starting dashboard-api in memory mode (empty store; Neo4j graph routes stay optional / error until configured)"
    );
  }
  for (const spec of dashboardChildSpawns(DASHBOARD_ROOT)) {
    start(spec, env);
  }
}
