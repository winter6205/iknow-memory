/**
 * An empty IKNOW_MEMORY_HOME and HOME must not fall through to a root home.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigError,
  loadEnv,
  setSettingHomeForTests,
} from "../../src/config.ts";

afterEach(() => {
  setSettingHomeForTests(null);
});

describe("memory home required", () => {
  it("throws ConfigError when IKNOW_MEMORY_HOME and HOME are both empty", () => {
    const prevHome = process.env.HOME;
    const prevIknow = process.env.IKNOW_MEMORY_HOME;
    process.env.HOME = "";
    process.env.IKNOW_MEMORY_HOME = "";
    setSettingHomeForTests(null);
    try {
      expect(() => loadEnv()).toThrow(ConfigError);
      try {
        loadEnv();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toMatch(/IKNOW_MEMORY_HOME/);
        expect((err as Error).message).toMatch(/HOME/);
        expect((err as Error).message).not.toContain("/.iknow-memory");
      }
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevIknow === undefined) delete process.env.IKNOW_MEMORY_HOME;
      else process.env.IKNOW_MEMORY_HOME = prevIknow;
    }
  });
});
