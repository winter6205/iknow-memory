import { describe, expect, it, vi } from "vitest";

import * as errors from "../../src/core/errors.js";
import { GraphragError } from "../../src/core/errors.js";
import { MaintenanceStoreError } from "../../src/core/maintenance/store-error.js";
import type { MaintenanceWorkRequest } from "../../src/core/maintenance/types.js";
import { inEvidenceTransaction } from "../../src/core/storage/evidence-pg.js";
import {
  PgMaintenanceWorkStore,
  type MaintenanceWorkLease,
  type MaintenanceWorkPool,
} from "../../src/core/storage/maintenance-work-pg.js";

type SuppressedFailure = { name: string; code?: string };

function suppressionContextOf(
  primary: unknown
): readonly SuppressedFailure[] | undefined {
  const api = errors as unknown as {
    getSuppressedFailureContext?: (
      error: unknown
    ) => readonly SuppressedFailure[];
  };
  expect(api.getSuppressedFailureContext).toBeTypeOf("function");
  return api.getSuppressedFailureContext?.(primary);
}

function withSqlState(error: Error, code: string): Error {
  Object.defineProperty(error, "code", { value: code });
  return error;
}

describe("transaction rollback failures", () => {
  it("preserves the evidence write failure and records only safe rollback metadata", async () => {
    const primary = new GraphragError("evidence-primary", "STORAGE_ERROR");
    const rollback = withSqlState(new Error("rollback-secret-evidence"), "XX000");
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "ROLLBACK") throw rollback;
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    await expect(
      inEvidenceTransaction(async () => client, async () => {
        throw primary;
      })
    ).rejects.toBe(primary);

    const context = suppressionContextOf(primary);
    if (!context) return;
    expect(context).toEqual([{ name: "Error", code: "XX000" }]);
    expect(JSON.stringify(context)).not.toContain("rollback-secret-evidence");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("preserves the maintenance write failure and records only safe rollback metadata", async () => {
    const primary = new MaintenanceStoreError(
      "maintenance-primary",
      "backend_unavailable"
    );
    const rollback = withSqlState(new Error("rollback-secret-maintenance"), "XX001");
    const lease: MaintenanceWorkLease = {
      async query(sql: string) {
        if (sql === "ROLLBACK") throw rollback;
        if (sql.startsWith("INSERT INTO maintenance_jobs")) throw primary;
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const pool: MaintenanceWorkPool = { connect: async () => lease };
    const request: MaintenanceWorkRequest = {
      workKind: "extract_publish",
      sourceRef: "source",
      sourceVersion: "v1",
      sourceGeneration: 1,
      configRevision: "rules-1",
      dependencies: [
        {
          sourceRef: "source",
          generation: 1,
          extractionRevision: null,
          relationBuckets: [],
        },
      ],
    };

    await expect(
      new PgMaintenanceWorkStore(pool).scheduleWork(request, new Date("2026-10-03T10:00:00.000Z"))
    ).rejects.toBe(primary);

    const context = suppressionContextOf(primary);
    if (!context) return;
    expect(context).toEqual([{ name: "Error", code: "XX001" }]);
    expect(JSON.stringify(context)).not.toContain("rollback-secret-maintenance");
    expect(lease.release).toHaveBeenCalledOnce();
  });
});
