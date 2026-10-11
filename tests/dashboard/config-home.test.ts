/**
 * Dashboard host and port follow the same layered precedence as loadEnv.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setSettingHomeForTests } from "../../src/config.js";
import { readDashboardConfig } from "../../src/dashboard-api/config.js";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "iknow-dashboard-cfg-"));
  homes.push(home);
  return home;
}

function writeSetting(osHome: string, map: Record<string, string>): void {
  const dir = join(osHome, ".iknow-memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "setting.json"), JSON.stringify(map));
}

afterEach(() => {
  setSettingHomeForTests(null);
  delete process.env.GRAPHRAG_MEMORY_DASHBOARD_HOST;
  delete process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

describe("readDashboardConfig layered precedence", () => {
  it("uses a host or port that is set only in setting.json", () => {
    const home = tempHome();
    writeSetting(home, {
      GRAPHRAG_MEMORY_DASHBOARD_HOST: "127.0.0.1",
      GRAPHRAG_MEMORY_DASHBOARD_PORT: "4175",
    });
    setSettingHomeForTests(home);
    delete process.env.GRAPHRAG_MEMORY_DASHBOARD_HOST;
    delete process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT;

    expect(readDashboardConfig()).toEqual({ host: "127.0.0.1", port: 4175 });
  });

  it("lets a non-blank env port win over setting.json", () => {
    const home = tempHome();
    writeSetting(home, { GRAPHRAG_MEMORY_DASHBOARD_PORT: "4175" });
    setSettingHomeForTests(home);
    process.env.GRAPHRAG_MEMORY_DASHBOARD_PORT = "4176";

    expect(readDashboardConfig().port).toBe(4176);
  });
});
