import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeWhenPostgresAvailable,
  resolvePgConnectionString,
} from "./integration/pg-test-harness.js";

const DB_URL_KEY = "GRAPHRAG_MEMORY_DB_URL";
const DEFAULT_URL = "postgresql://postgres@localhost/postgres";
const saved = process.env[DB_URL_KEY];
const savedCi = process.env.CI;

afterEach(() => {
  if (saved === undefined) {
    delete process.env[DB_URL_KEY];
  } else {
    process.env[DB_URL_KEY] = saved;
  }
  if (savedCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = savedCi;
  }
});

describe("resolvePgConnectionString", () => {
  it("uses process env when the URL is non-empty", () => {
    process.env[DB_URL_KEY] = "postgresql://compose@localhost/iknow_memory";
    expect(resolvePgConnectionString(DEFAULT_URL)).toBe(
      "postgresql://compose@localhost/iknow_memory"
    );
  });

  it("treats an explicit empty process env pin as absent, not a file fallback", async () => {
    process.env[DB_URL_KEY] = "";
    const dir = await mkdtemp(join(tmpdir(), "pg-harness-"));
    await writeFile(
      join(dir, ".env.local"),
      `${DB_URL_KEY}=postgresql://from-file/db\n`
    );
    expect(
      resolvePgConnectionString(DEFAULT_URL, {
        dotenvPath: join(dir, ".env.local"),
      })
    ).toBe(DEFAULT_URL);
  });

  it("reads GRAPHRAG_MEMORY_DB_URL from .env.local when process env is unset", async () => {
    delete process.env[DB_URL_KEY];
    const dir = await mkdtemp(join(tmpdir(), "pg-harness-"));
    await writeFile(
      join(dir, ".env.local"),
      `${DB_URL_KEY}=postgresql://from-file/iknow_memory\n`
    );
    expect(
      resolvePgConnectionString(DEFAULT_URL, {
        dotenvPath: join(dir, ".env.local"),
      })
    ).toBe("postgresql://from-file/iknow_memory");
  });
});

describe("describeWhenPostgresAvailable", () => {
  const warning = {
    label: "harness-unit",
    testPath: "tests/pg-test-harness.test.ts",
    expectedCommand: "npx vitest run tests/pg-test-harness.test.ts",
    connectionString: DEFAULT_URL,
    error: new Error("ECONNREFUSED"),
    requiresVector: false,
  };

  it("throws in CI when Postgres is unreachable instead of skipping", () => {
    process.env.CI = "true";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        describeWhenPostgresAvailable(
          { available: false, error: new Error("ECONNREFUSED") },
          warning
        )
      ).toThrow(/Postgres unreachable.*in CI/);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips locally when Postgres is unreachable", () => {
    delete process.env.CI;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const boundDescribe = describeWhenPostgresAvailable(
        { available: false, error: new Error("ECONNREFUSED") },
        warning
      );
      expect(boundDescribe).not.toBe(describe);
    } finally {
      warn.mockRestore();
    }
  });
});
