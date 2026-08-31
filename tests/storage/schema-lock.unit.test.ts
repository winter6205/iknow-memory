import { describe, expect, it } from "vitest";

import { schemaBootstrapLockKey } from "../../src/core/storage/schema-lock.js";

describe("schema bootstrap advisory lock key", () => {
  it("returns a stable signed bigint for an empty schema name", () => {
    const key = schemaBootstrapLockKey("");

    expect(typeof key).toBe("bigint");
    expect(key).toBe(schemaBootstrapLockKey(""));
    expect(key).toBeGreaterThanOrEqual(-(1n << 63n));
    expect(key).toBeLessThanOrEqual((1n << 63n) - 1n);
  });

  it("supports unusual schema names using their UTF-8 representation", () => {
    const schemaName = `schema with spaces/'quotes-" ${"🚀"}`;
    const key = schemaBootstrapLockKey(schemaName);

    expect(typeof key).toBe("bigint");
    expect(key).toBe(schemaBootstrapLockKey(schemaName));
    expect(key).not.toBe(schemaBootstrapLockKey(""));
    expect(key).toBeGreaterThanOrEqual(-(1n << 63n));
    expect(key).toBeLessThanOrEqual((1n << 63n) - 1n);
  });
});
