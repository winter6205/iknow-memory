/**
 * In-memory lane for the MP13 collector eligibility read.
 *
 * It answers the same questions the Postgres lane answers about WHICH facts the
 * read finds — a current generation, a published scope, a staged attempt, a live
 * job, a row reference, a count grant, a lease — without a database, and then runs
 * the day-90/day-365 boundaries through the twin's own rows. The boundary
 * arithmetic itself is `collector-eligibility.ts`, which both lanes call, so a
 * disagreement between lanes can only be about fact gathering.
 */
import { describe, expect, it } from "vitest";

import {
  COLLECTION_DAY_MS,
  decideCollectionEligibility,
  readCollectionEligibility,
} from "../../src/core/maintenance/collector-eligibility.js";
import type {
  CollectionCandidate,
  CollectionEligibility,
  CollectionPayloadClass,
} from "../../src/core/maintenance/collector-types.js";
import {
  InMemoryCollectionEligibilityReader,
  type InMemoryCollectionSeed,
} from "../../src/core/storage/collector-eligibility-memory.js";

const DAY0 = new Date("2026-01-01T00:00:00.000Z");
const atDay = (count: number): Date =>
  new Date(DAY0.getTime() + count * COLLECTION_DAY_MS);
const iso = (value: Date): string => value.toISOString();

const SOURCE_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const SUPPORT_ID = "22222222-2222-4222-8222-222222222222";

/** One retired source version with one support — the minimum a read needs. */
const retiredSource: InMemoryCollectionSeed = {
  sourceVersions: [
    {
      sourceRef: "s1",
      sourceVersion: "v1",
      sourceVersionId: SOURCE_VERSION_ID,
      retiredAt: iso(DAY0),
      payloadCollectedAt: null,
    },
  ],
  supports: [{ supportId: SUPPORT_ID, sourceVersionId: SOURCE_VERSION_ID }],
  grantSupports: [{ evidenceRef: "grant-1", supportId: SUPPORT_ID }],
};

const candidate = (
  payloadClass: CollectionPayloadClass,
  overrides: Partial<CollectionCandidate> = {}
): CollectionCandidate => ({
  payloadClass,
  payloadRef: "s1",
  source: { sourceRef: "s1", sourceVersion: "v1", sourceGeneration: 1 },
  anchorAt: iso(DAY0),
  ...overrides,
});

async function decide(
  seed: InMemoryCollectionSeed,
  payload: CollectionCandidate,
  now: Date
): Promise<CollectionEligibility> {
  const outcome = await readCollectionEligibility(
    { reader: new InMemoryCollectionEligibilityReader(seed), clock: () => now },
    payload
  );
  if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
  return outcome.eligibility;
}

async function factsOf(seed: InMemoryCollectionSeed, now: Date) {
  return new InMemoryCollectionEligibilityReader(seed).readCollectionFacts(
    candidate("retired_unreferenced"),
    now
  );
}

describe("in-memory collector read — which facts it finds", () => {
  it("finds no dependency, lease or grant on a clean retired source", async () => {
    const facts = await factsOf(retiredSource, atDay(90));

    expect(facts.bindingResolved).toBe(true);
    expect(facts.payloadCollected).toBe(false);
    expect(facts.currentDependencies).toEqual([]);
    expect(facts.validLeases).toEqual([]);
    expect(facts.rowReferences).toEqual([]);
  });

  it("finds a current generation of the same source as a dependency", async () => {
    const facts = await factsOf(
      {
        ...retiredSource,
        sourceVersions: [
          ...(retiredSource.sourceVersions ?? []),
          {
            sourceRef: "s1",
            sourceVersion: "v2",
            sourceVersionId: "33333333-3333-4333-8333-333333333333",
            retiredAt: null,
            payloadCollectedAt: null,
          },
        ],
      },
      atDay(90)
    );

    expect(facts.currentDependencies.map((dep) => dep.kind)).toEqual([
      "current_source_version",
    ]);
  });

  it("finds a published or desired scope row as a dependency", async () => {
    const facts = await factsOf(
      {
        ...retiredSource,
        publicationSources: [
          { sourceRef: "s1", desiredSourceVersion: "v1" },
        ],
      },
      atDay(90)
    );

    expect(facts.currentDependencies.map((dep) => dep.kind)).toEqual([
      "published_or_desired_scope",
    ]);
  });

  it("finds a staged attempt and a live job as dependencies", async () => {
    const facts = await factsOf(
      {
        ...retiredSource,
        stagedSourceRefs: ["s1"],
        jobs: [
          { jobKey: "job-1", sourceRef: "s1", status: "pending", leaseExpiresAt: null },
        ],
      },
      atDay(90)
    );

    expect(facts.currentDependencies.map((dep) => dep.kind).sort()).toEqual([
      "live_maintenance_job",
      "staged_publication",
    ]);
  });

  it("returns a running job's lease and no lease for a pending one", async () => {
    const facts = await factsOf(
      {
        ...retiredSource,
        jobs: [
          {
            jobKey: "job-1",
            sourceRef: "s1",
            status: "running",
            leaseExpiresAt: iso(atDay(95)),
          },
          {
            jobKey: "job-2",
            sourceRef: "s1",
            status: "pending",
            leaseExpiresAt: null,
          },
        ],
      },
      atDay(90)
    );

    expect(facts.validLeases).toEqual([
      { kind: "job", holder: "job-1", expiresAt: iso(atDay(95)) },
    ]);
  });

  it("separates a row reference from a count-only grant", async () => {
    const facts = await factsOf(
      {
        ...retiredSource,
        grantSupports: [
          { evidenceRef: "row-1", supportId: SUPPORT_ID },
          { evidenceRef: "count-1", supportId: SUPPORT_ID },
        ],
        grants: [
          { evidenceRef: "row-1", grantKind: "row", expiresAt: iso(atDay(200)) },
          {
            evidenceRef: "count-1",
            grantKind: "count",
            expiresAt: iso(atDay(300)),
            receiptId: "receipt-1",
          },
        ],
      },
      atDay(90)
    );

    expect(facts.rowReferences).toEqual([
      { evidenceRef: "row-1", expiresAt: iso(atDay(200)) },
    ]);
    expect(facts.countOnlyGrants).toEqual([
      { evidenceRef: "count-1", receiptId: "receipt-1", expiresAt: iso(atDay(300)) },
    ]);
  });

  it("reports an unresolvable source binding instead of an empty payload", async () => {
    const facts = await factsOf({}, atDay(90));

    expect(facts.bindingResolved).toBe(false);
    const outcome = decideCollectionEligibility(
      candidate("retired_unreferenced"),
      facts,
      atDay(90)
    );
    expect(outcome.refused).toBe(true);
  });

  it("reads no support-scoped grant for an object-scoped payload", async () => {
    const reader = new InMemoryCollectionEligibilityReader({
      ...retiredSource,
      grants: [{ evidenceRef: "row-1", grantKind: "row", expiresAt: iso(atDay(200)) }],
    });
    const facts = await reader.readCollectionFacts(
      candidate("job_detailed_logs", { payloadRef: "job-9", source: null }),
      atDay(90)
    );

    expect(facts.rowReferences).toEqual([]);
  });
});

describe("in-memory collector read — the day boundaries", () => {
  it("holds day 89 and releases day 90", async () => {
    const before = await decide(
      retiredSource,
      candidate("retired_unreferenced"),
      new Date(atDay(90).getTime() - 1)
    );
    expect(before.eligible).toBe(false);

    const after = await decide(
      retiredSource,
      candidate("retired_unreferenced"),
      atDay(90)
    );
    expect(after.eligible).toBe(true);
    expect(after.physicalPurgeNotBefore).toBe(iso(atDay(97)));
  });

  it("holds day 6 and releases day 7 for an attempt stage", async () => {
    const before = await decide(
      retiredSource,
      candidate("attempt_stage"),
      new Date(atDay(7).getTime() - 1)
    );
    expect(before.eligible).toBe(false);

    const after = await decide(retiredSource, candidate("attempt_stage"), atDay(7));
    expect(after.eligible).toBe(true);
  });

  it("extends a protected payload to day 200 and caps it at day 365", async () => {
    const withReference = (expiresAt: Date): InMemoryCollectionSeed => ({
      ...retiredSource,
      grants: [
        { evidenceRef: "grant-1", grantKind: "row", expiresAt: iso(expiresAt) },
      ],
    });
    const payload = candidate("retired_evidence_protected");

    const extended = await decide(withReference(atDay(200)), payload, atDay(200));
    expect(extended.earliestCandidateAt).toBe(iso(atDay(200)));
    expect(extended.eligible).toBe(true);

    const capped = await decide(withReference(atDay(400)), payload, atDay(365));
    expect(capped.earliestCandidateAt).toBe(iso(atDay(365)));
    expect(capped.eligible).toBe(true);

    const beforeCap = await decide(
      withReference(atDay(400)),
      payload,
      new Date(atDay(364).getTime())
    );
    expect(beforeCap.eligible).toBe(false);
  });

  it("ignores a count-only grant even when a support link names it", async () => {
    const withCount = await decide(
      {
        ...retiredSource,
        grantSupports: [{ evidenceRef: "count-1", supportId: SUPPORT_ID }],
        grants: [
          {
            evidenceRef: "count-1",
            grantKind: "count",
            expiresAt: iso(atDay(300)),
            receiptId: "receipt-1",
          },
        ],
      },
      candidate("retired_unreferenced"),
      atDay(90)
    );

    expect(withCount.eligible).toBe(true);
    expect(withCount.ignoredCountGrants).toEqual(["count-1"]);
  });

  it("counts a day as one elapsed 24-hour period", () => {
    expect(atDay(1).getTime() - atDay(0).getTime()).toBe(COLLECTION_DAY_MS);
  });
});