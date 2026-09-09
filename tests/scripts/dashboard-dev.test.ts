/**
 * dashboard-dev orchestrator: zero-config must disable graph + rerank
 * (ADR-0006 fail-start) and tear down the child process group.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildDashboardChildEnv,
  dashboardChildSpawns,
  isStorageConfigured,
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
  });

  it("sets memory mode and disables graph and rerank when unconfigured", () => {
    const env = buildDashboardChildEnv({
      PATH: "/usr/bin",
      HOME: "/tmp",
    });
    assert.equal(env.GRAPHRAG_MEMORY_STORAGE, "memory");
    assert.equal(env.GRAPHRAG_MEMORY_EMBED_DIMENSIONS, "8");
    assert.equal(env.GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS, "8");
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED, "false");
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED, "false");
    assert.equal(env.PATH, "/usr/bin");
  });

  it("passes through operator storage env without forcing graph or rerank off", () => {
    const env = buildDashboardChildEnv({
      PATH: "/usr/bin",
      GRAPHRAG_MEMORY_STORAGE: "pgvector",
      GRAPHRAG_MEMORY_DB_URL: "postgresql://localhost/iknow_memory",
      GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "true",
      GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "true",
    });
    assert.equal(env.GRAPHRAG_MEMORY_STORAGE, "pgvector");
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED, "true");
    assert.equal(env.GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED, "true");
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
