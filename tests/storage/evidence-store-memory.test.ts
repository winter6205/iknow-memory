/**
 * MemoryBackend against the shared evidence-store contract.
 *
 * The in-memory store is a real implementation of the capability, not a stub:
 * it enforces the same occurrence identity, the same 365-day lifetime and the
 * same denial reasons as PostgreSQL, which is what lets tests without a
 * database say anything about the contract. The same body runs against a live
 * Postgres in evidence-store-pg.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { supportsEvidenceStore } from "../../src/core/storage/backend.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type { EvidenceStore } from "../../src/core/types.js";
import { runEvidenceStoreContract } from "./evidence-store-contract.js";

const TEST_DIM = 8;

describe("MemoryBackend evidence store", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend(TEST_DIM);
  });

  it("is reachable through the capability guard, not by convention", () => {
    // The guard's own coverage of `EvidenceStore` is a compile-time Record in
    // backend.ts; what this pins is that it accepts a real store and rejects a
    // chunk-only object.
    expect(supportsEvidenceStore(backend)).toBe(true);
    // A chunk-only backend must still fail closed on the guard.
    expect(supportsEvidenceStore({ upsert: () => {}, search: () => {} })).toBe(
      false
    );
    expect(supportsEvidenceStore(null)).toBe(false);
    expect(supportsEvidenceStore(undefined)).toBe(false);
  });

  it("fails closed on a partial store rather than a missing one", () => {
    // A store that can mint a grant but cannot read one back is exactly the
    // half-implementation the guard exists to reject.
    const partial = {
      ...backend,
      readGrant: undefined,
    } as unknown;
    expect(supportsEvidenceStore(partial)).toBe(false);
  });

  it("exposes a narrowed store the guard accepts as one", async () => {
    const candidate: unknown = backend;
    expect(supportsEvidenceStore(candidate)).toBe(true);
    const store: EvidenceStore = candidate as EvidenceStore;
    const err = await store
      .recordSupport({
        subject: "entity",
        result_id: "r",
        source_ref: "s",
        source_version: "v",
        location: { document_id: "d", version: "f", unit: 1 },
        extraction_ref: "e",
        extractedAt: "2026-01-01T00:00:00.000Z",
      })
      .then(() => null, (caught) => caught as { failureToken?: string });
    expect(err?.failureToken).toBe("unsupported_source_binding");
  });
});

runEvidenceStoreContract("MemoryBackend", async () => new MemoryBackend(TEST_DIM));
