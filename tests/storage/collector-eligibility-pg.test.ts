/**
 * What the Postgres collector read does with columns it cannot read.
 *
 * The rows here are hand-built rather than queried, because a real jsonb column
 * that cannot arrive is not reproducible: every malformed case here is a shape a
 * driver CAN return (a text-mode driver hands back the column as a string, an
 * unexpected NULL arrives as null, a value of the wrong jsonb type arrives as an
 * object). Each one asks the same question — does an unreadable fact reach the
 * decision as "nothing was there" — because that is the single reading which
 * collects a payload that is still protected.
 */
import { describe, expect, it } from "vitest";

import {
  COLLECTION_DAY_MS,
  decideCollectionEligibility,
} from "../../src/core/maintenance/collector-eligibility.js";
import type { CollectionCandidate } from "../../src/core/maintenance/collector-types.js";
import { MaintenanceStoreError } from "../../src/core/maintenance/store-error.js";
import { PgCollectionEligibilityReader } from "../../src/core/storage/collector-eligibility-pg.js";

const DAY0 = new Date("2026-01-01T00:00:00.000Z");
const atDay = (count: number): Date =>
  new Date(DAY0.getTime() + count * COLLECTION_DAY_MS);

const candidate: CollectionCandidate = {
  payloadClass: "retired_unreferenced",
  payloadRef: "s1",
  source: { sourceRef: "s1", sourceVersion: "v1", sourceGeneration: 1 },
  anchorAt: DAY0.toISOString(),
};

/** A row the statement would return if every column held its empty value. */
const emptyRow = (): Record<string, unknown> => ({
  binding_resolved: true,
  payload_collected: false,
  target_retired: true,
  current_dependencies: [],
  valid_leases: [],
  row_references: [],
  count_only_grants: [],
});

function readerOf(row: Record<string, unknown>): {
  reader: PgCollectionEligibilityReader;
  released: () => number;
} {
  let releases = 0;
  return {
    reader: new PgCollectionEligibilityReader({
      async connect() {
        return {
          async query() {
            return { rows: [row] };
          },
          release() {
            releases += 1;
          },
        };
      },
    }),
    released: () => releases,
  };
}

const NOW = atDay(100);

describe("postgres collector read — an unreadable fact never reads as absent", () => {
  it("keeps a lease whose expiry cannot be read, so it blocks as never expiring", async () => {
    const { reader, released } = readerOf({
      ...emptyRow(),
      // A driver that hands back a timestamptz as something other than an ISO
      // string. Dropping it would leave the payload with no lease at all.
      valid_leases: [{ kind: "job", holder: "job-1", expiresAt: null }],
    });

    const facts = await reader.readCollectionFacts(candidate, NOW);
    expect(facts.validLeases).toHaveLength(1);

    const outcome = decideCollectionEligibility(candidate, facts, NOW);
    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;
    expect(outcome.eligibility.blockingReasons).toContain("valid_lease");
    // No instant exists to reschedule against: only a re-read clears it.
    expect(outcome.eligibility.nextEvaluationAt).toBeNull();
    expect(released()).toBe(1);
  });

  it("raises on a row_references column that is not an entry list", async () => {
    const { reader, released } = readerOf({ ...emptyRow(), row_references: "{}" });

    await expect(reader.readCollectionFacts(candidate, NOW)).rejects.toBeInstanceOf(
      MaintenanceStoreError
    );
    expect(released()).toBe(1);
  });

  it("raises on row_references text a driver could not parse as json", async () => {
    const { reader } = readerOf({
      ...emptyRow(),
      row_references: "[{'evidenceRef':",
    });

    await expect(reader.readCollectionFacts(candidate, NOW)).rejects.toThrow(
      /row_references/
    );
  });

  it("raises on a current_dependencies column that is not an entry list", async () => {
    const { reader } = readerOf({ ...emptyRow(), current_dependencies: null });

    const failure = await reader
      .readCollectionFacts(candidate, NOW)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MaintenanceStoreError);
    // A dependency is what blocks, so "unreadable" must never become "none".
    expect((failure as MaintenanceStoreError).failureCode).toBe(
      "backend_unavailable"
    );
    expect((failure as Error).message).toContain("current_dependencies");
  });

  it("raises on count_only_grants that cannot be read rather than ignoring it", async () => {
    const { reader } = readerOf({ ...emptyRow(), count_only_grants: "not json" });

    await expect(reader.readCollectionFacts(candidate, NOW)).rejects.toBeInstanceOf(
      MaintenanceStoreError
    );
  });

  it("still reads a well-formed row through the same statement", async () => {
    const { reader } = readerOf({
      ...emptyRow(),
      row_references: [
        { evidenceRef: "row-1", expiresAt: atDay(200).toISOString() },
      ],
    });

    const facts = await reader.readCollectionFacts(candidate, NOW);

    expect(facts.rowReferences).toEqual([
      { evidenceRef: "row-1", expiresAt: atDay(200).toISOString() },
    ]);
    expect(facts.targetRetired).toBe(true);
    expect(DAY0.getTime() + 90 * COLLECTION_DAY_MS).toBeLessThan(NOW.getTime());
  });
});