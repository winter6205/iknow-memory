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
import {
  contentDigestOf,
  normalizeOccurrence,
  supportIdOf,
} from "../../src/core/storage/evidence-source.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { EVIDENCE_SUBJECT_KIND, type EvidenceStore } from "../../src/core/types.js";
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

describe("support id derivation", () => {
  const seed = {
    source_ref: "derive-source",
    source_version: "v1",
    content_digest: contentDigestOf("derive-content"),
    origin_object_ref: "objects/derive/original.pdf",
    parser_revision: "parser-v1",
    unit_manifest: { units: 1 },
    created_at: "2026-02-01T00:00:00.000Z",
  };
  const locator = { document_id: "derive-doc", version: "frozen-v1", unit: 1 };
  const occurrence = {
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    result_id: "derive-result",
    source_ref: seed.source_ref,
    source_version: seed.source_version,
    location: locator,
    span: null,
    extraction_ref: "derive-extraction-1",
    extractedAt: "2026-02-02T00:00:00.000Z",
  } as const;

  const seeded = async (): Promise<MemoryBackend> => {
    const store = new MemoryBackend(TEST_DIM);
    const { record } = await store.registerSourceVersion(seed);
    await store.bindSourceLocator({
      source_version_id: record.source_version_id,
      ...locator,
    });
    return store;
  };

  it("derives one id per occurrence, without consulting any stored state", () => {
    const plan = normalizeOccurrence(occurrence);
    // Two independent calls over the same occurrence: a minted id could not be
    // recomputed offline to reconcile a row built on another path.
    expect(supportIdOf(plan)).toBe(supportIdOf(plan));
    const moved = normalizeOccurrence({
      ...occurrence,
      span: { start: 0, end: 4 },
    });
    expect(
      supportIdOf(moved),
      "a different occurrence is a different support"
    ).not.toBe(supportIdOf(plan));
  });

  it("mints the same id in independent stores and across both write paths", async () => {
    const viaRecordSupport = await (await seeded()).recordSupport(occurrence);
    const viaSecondStore = await (await seeded()).recordSupport(occurrence);
    const publication = (await seeded()).preparePublicationEvidence([
      occurrence,
    ]);
    const viaPublication = publication.supports[0]!;
    publication.commit();

    expect(viaSecondStore.support.support_id).toBe(
      viaRecordSupport.support.support_id
    );
    expect(viaPublication.support_id).toBe(viaRecordSupport.support.support_id);
  });
});

runEvidenceStoreContract("MemoryBackend", async () => new MemoryBackend(TEST_DIM));
