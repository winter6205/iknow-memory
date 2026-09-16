/**
 * dashboard-dev orchestrator: zero-config must disable graph + rerank
 * (ADR-0006 fail-start) and the ES precision layer (ADR-0007 fail-start),
 * and tear down the child process group.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachChildLifecycle,
  buildDashboardChildEnv,
  dashboardChildSpawns,
  ensureDashboardVite,
  isStorageConfigured,
  readOperatorSetting,
  readStorageFileEnv,
  resolveDashboardApiPort,
  terminateChildGroup,
} from "../../scripts/dashboard-dev.ts";

describe("dashboard-dev zero-config env", () => {
  it("treats missing and blank storage keys as unconfigured", () => {
    assert.equal(isStorageConfigured({}), false);
    assert.equal(isStorageConfigured({ GRAPHRAG_MEMORY_STORAGE: "" }), false);
    assert.equal(isStorageConfigured({ GRAPHRAG_MEMORY_DB_URL: "   " }), false);
    assert.equal(
      isStorageConfigured({ GRAPHRAG_MEMORY_STORAGE: "memory" }),
      true
    );
    assert.equal(
      isStorageConfigured({
        GRAPHRAG_MEMORY_NEO4J_URI: "bolt://127.0.0.1:7687",
      }),
      true
    );
    assert.equal(
      isStorageConfigured({}, { GRAPHRAG_MEMORY_STORAGE: "pgvector" }),
      true
    );
    assert.equal(
      isStorageConfigured(
        { GRAPHRAG_MEMORY_STORAGE: "" },
        { GRAPHRAG_MEMORY_STORAGE: "pgvector" }
      ),
      false
    );
  });

  it("reads only storage keys from .env.local and skips comments", () => {
    const root = mkdtempSync(join(tmpdir(), "iknow-dashboard-env-"));
    try {
      writeFileSync(
        join(root, ".env.local"),
        [
          "# comment",
          "GRAPHRAG_MEMORY_STORAGE=pgvector",
          "GRAPHRAG_MEMORY_EMBED_API_KEY=should-not-appear",
          "GRAPHRAG_MEMORY_DB_URL=postgresql://localhost/db",
        ].join("\n")
      );
      const fileEnv = readStorageFileEnv(root);
      assert.equal(fileEnv.GRAPHRAG_MEMORY_STORAGE, "pgvector");
      assert.equal(fileEnv.GRAPHRAG_MEMORY_DB_URL, "postgresql://localhost/db");
      assert.equal(fileEnv.GRAPHRAG_MEMORY_EMBED_API_KEY, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not force memory when .env.local already has operator storage", () => {
    const env = buildDashboardChildEnv(
      { PATH: "/usr/bin" },
      { GRAPHRAG_MEMORY_STORAGE: "pgvector" }
    );
    assert.equal(env.GRAPHRAG_MEMORY_STORAGE, undefined);
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED, undefined);
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED, undefined);
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED, undefined);
  });

  it("sets memory mode and disables graph, rerank, and the precision layer when unconfigured", () => {
    const env = buildDashboardChildEnv({
      PATH: "/usr/bin",
      HOME: "/tmp",
    });
    assert.equal(env.GRAPHRAG_MEMORY_STORAGE, "memory");
    assert.equal(env.GRAPHRAG_MEMORY_EMBED_DIMENSIONS, "8");
    assert.equal(env.GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS, "8");
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED, "false");
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED, "false");
    // ADR-0007: memory mode has no ES address, so the default-on precision
    // layer must be explicitly off or the API child refuses to boot.
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED, "false");
    assert.equal(env.PATH, "/usr/bin");
  });

  it("does not force memory when ~/.iknow-memory/setting.json has storage", () => {
    const home = join(tmpdir(), `iknow-setting-${process.pid}-${Date.now()}`);
    mkdirSync(join(home, ".iknow-memory"), { recursive: true });
    writeFileSync(
      join(home, ".iknow-memory", "setting.json"),
      JSON.stringify({
        GRAPHRAG_MEMORY_STORAGE: "pgvector",
        GRAPHRAG_MEMORY_DB_URL: "postgresql://localhost/iknow_memory",
      })
    );
    const setting = readOperatorSetting(home);
    assert.equal(setting.GRAPHRAG_MEMORY_STORAGE, "pgvector");
    assert.equal(isStorageConfigured({ HOME: home }, setting), true);
    const env = buildDashboardChildEnv(
      { PATH: "/usr/bin", HOME: home },
      setting
    );
    assert.equal(env.GRAPHRAG_MEMORY_STORAGE, undefined);
    assert.equal(env.GRAPHRAG_MEMORY_DB_URL, undefined);
  });

  it("passes through operator storage env without forcing graph, rerank, or BM25 off", () => {
    const env = buildDashboardChildEnv({
      PATH: "/usr/bin",
      GRAPHRAG_MEMORY_STORAGE: "pgvector",
      GRAPHRAG_MEMORY_DB_URL: "postgresql://localhost/iknow_memory",
      GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "true",
      GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "true",
      GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "true",
    });
    assert.equal(env.GRAPHRAG_MEMORY_STORAGE, "pgvector");
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED, "true");
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED, "true");
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED, "true");
    assert.equal(env.GRAPHRAG_MEMORY_EMBED_DIMENSIONS, undefined);
  });

  it("writes the resolved API port into child env for the Vite proxy", () => {
    assert.equal(resolveDashboardApiPort({}), 4174);
    assert.equal(
      resolveDashboardApiPort({ GRAPHRAG_MEMORY_DASHBOARD_PORT: "4199" }),
      4199
    );
    const defaulted = buildDashboardChildEnv({ PATH: "/usr/bin" });
    assert.equal(defaulted.GRAPHRAG_MEMORY_DASHBOARD_PORT, "4174");
    const overridden = buildDashboardChildEnv({
      PATH: "/usr/bin",
      GRAPHRAG_MEMORY_STORAGE: "memory",
      GRAPHRAG_MEMORY_DASHBOARD_PORT: "4199",
    });
    assert.equal(overridden.GRAPHRAG_MEMORY_DASHBOARD_PORT, "4199");
  });
});

describe("dashboard-dev process-tree shutdown", () => {
  it("signals the whole process group, not only the npm pid", () => {
    const sent: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fakeKill = ((pid: number, signal?: NodeJS.Signals) => {
      sent.push({ pid, signal: signal ?? "SIGTERM" });
      return true;
    }) as typeof process.kill;

    terminateChildGroup(4242, fakeKill);
    assert.deepEqual(sent, [{ pid: -4242, signal: "SIGTERM" }]);
  });

  it("spawns API and vite directly so the process group is the server tree", () => {
    const specs = dashboardChildSpawns("/repo");
    assert.equal(specs.length, 2);
    assert.equal(specs[0]?.name, "dashboard-api");
    assert.ok(
      specs[0]?.args.some((a) => a.endsWith("src/dashboard-api/main.ts"))
    );
    assert.equal(specs[1]?.name, "dashboard:dev");
    assert.equal(
      specs[1]?.command,
      join("/repo", "dashboard/node_modules/.bin/vite")
    );
    assert.equal(specs[1]?.cwd, join("/repo", "dashboard"));
  });

  it("swallows ESRCH when the group is already gone", () => {
    const fakeKill = (() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    }) as typeof process.kill;
    terminateChildGroup(1, fakeKill);
  });
});

describe("ensureDashboardVite after root-only npm install", () => {
  function tempRoot(): string {
    return mkdtempSync(join(tmpdir(), "iknow-dashboard-vite-"));
  }

  function writeViteBin(root: string): string {
    const binDir = join(root, "dashboard/node_modules/.bin");
    mkdirSync(binDir, { recursive: true });
    const vite = join(binDir, "vite");
    writeFileSync(vite, "");
    return vite;
  }

  it("does not run the installer when dashboard vite already exists", () => {
    const root = tempRoot();
    try {
      writeViteBin(root);
      let calls = 0;
      ensureDashboardVite(root, () => {
        calls += 1;
        return 0;
      });
      assert.equal(calls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs with --prefix <root>/dashboard when vite bin is missing", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "dashboard"), { recursive: true });
      let prefix = "";
      ensureDashboardVite(root, (dashboardPrefix) => {
        prefix = dashboardPrefix;
        writeViteBin(root);
        return 0;
      });
      assert.equal(prefix, join(root, "dashboard"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws telling the operator to npm install --prefix dashboard when install exits non-zero", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "dashboard"), { recursive: true });
      assert.throws(
        () => ensureDashboardVite(root, () => 1),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("npm install --prefix dashboard")
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws the same operator command when install succeeds but vite is still missing", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "dashboard"), { recursive: true });
      assert.throws(
        () => ensureDashboardVite(root, () => 0),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("npm install --prefix dashboard")
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard-dev spawn error teardown", () => {
  it("runs shutdown when a child emits spawn error so siblings are not orphaned", () => {
    const shutdownCodes: number[] = [];
    const child = new EventEmitter();
    attachChildLifecycle(
      child,
      { name: "dashboard:dev" },
      {
        isShuttingDown: () => false,
        shutdown: (code) => {
          shutdownCodes.push(code);
        },
      }
    );
    child.emit(
      "error",
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })
    );
    assert.deepEqual(shutdownCodes, [1]);
  });

  it("does not call shutdown again when already shutting down", () => {
    const shutdownCodes: number[] = [];
    const child = new EventEmitter();
    attachChildLifecycle(
      child,
      { name: "dashboard-api" },
      {
        isShuttingDown: () => true,
        shutdown: (code) => {
          shutdownCodes.push(code);
        },
      }
    );
    child.emit("error", new Error("spawn ENOENT"));
    child.emit("exit", 1, null);
    assert.deepEqual(shutdownCodes, []);
  });
});
