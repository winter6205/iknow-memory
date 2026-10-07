/**
 * The behaviour both evidence stores must agree on.
 *
 * Written once and run against MemoryBackend and PgvectorBackend in the two
 * `evidence-store-*.test.ts` files: a capability whose two implementations
 * disagree on occurrence identity, a lifetime or a denial reason is worse than
 * one with no capability, because the difference only shows up as a wrong
 * citation much later. Every case names the contract clause it pins.
 *
 * Not a `.test.ts` file: vitest's include glob only picks up test files, so
 * this is the shared body its two callers run.
 */
import { describe as vitestDescribe, expect, it } from "vitest";

import { GraphragError, failureTokenOf } from "../../src/core/errors.js";
import {
  EVIDENCE_DENIAL_REASON,
  EVIDENCE_FAILURE,
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
  type CompanySourceLocator,
  type EvidenceStore,
  type EvidenceSupportRef,
  type GrantRequest,
  type NewSourceVersion,
  type SourceVersionRecord,
  type SupportOccurrence,
  type SupportRecord,
} from "../../src/core/types.js";
import { contentDigestOf } from "../../src/core/storage/evidence-source.js";
import {
  GRANT_LIFETIME_DAYS,
  MAX_EVIDENCE_BYTES,
} from "../../src/core/storage/evidence-store.js";

const MS_PER_DAY = 86_400_000;
const DAY_MS = GRANT_LIFETIME_DAYS * MS_PER_DAY;
const QUERIED_AT = "2026-03-01T12:00:00.000Z";
const LATER = "2026-04-01T00:00:00.000Z";

/** Distinct per case, so a store shared across cases cannot cross-talk. */
let caseCounter = 0;

function uniqueCase(): string {
  caseCounter += 1;
  return `c${caseCounter}`;
}

async function refusal(promise: Promise<unknown>): Promise<GraphragError> {
  try {
    await promise;
  } catch (err) {
    expect(err, "expected a typed refusal, got a plain throw").toBeInstanceOf(
      GraphragError
    );
    return err as GraphragError;
  }
  throw new Error("expected a typed refusal; the call resolved instead");
}

interface SeededSource {
  readonly version: SourceVersionRecord;
  readonly locator: CompanySourceLocator;
}

async function seedSourceVersion(
  store: EvidenceStore,
  caseId: string,
  patch: Partial<NewSourceVersion> = {}
): Promise<SeededSource> {
  const { record } = await store.registerSourceVersion({
    source_ref: `${caseId}-source`,
    source_version: "v1",
    content_digest: contentDigestOf(`${caseId}-content`),
    origin_object_ref: `objects/${caseId}/original.pdf`,
    parser_revision: "parser-v1",
    unit_manifest: { units: 3 },
    created_at: "2026-02-01T00:00:00.000Z",
    ...patch,
  });
  const locator: CompanySourceLocator = {
    document_id: `${caseId}-doc`,
    version: "frozen-v1",
    unit: 1,
  };
  await store.bindSourceLocator({
    source_version_id: record.source_version_id,
    ...locator,
  });
  return { version: record, locator };
}

function occurrenceFor(
  seed: SeededSource,
  caseId: string,
  patch: Partial<SupportOccurrence> = {}
): SupportOccurrence {
  return {
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    result_id: `${caseId}-result`,
    source_ref: seed.version.source_ref,
    source_version: seed.version.source_version,
    location: seed.locator,
    span: null,
    extraction_ref: `${caseId}-extraction-1`,
    extractedAt: LATER,
    ...patch,
  };
}

function admit(store: EvidenceStore, caseId: string): Promise<unknown> {
  return store.setScopeRevisions(`${caseId}-scope`, {
    authorizationRevision: "auth-1",
    purgeRevision: "purge-1",
  });
}

function rowGrant(
  caseId: string,
  supports: readonly EvidenceSupportRef[],
  patch: Partial<GrantRequest> = {}
): GrantRequest {
  return {
    kind: EVIDENCE_GRANT_KIND.ROW,
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    operation: "list",
    queryDigest: `${caseId}-query`,
    scopeBinding: `${caseId}-scope`,
    readRevision: "read-1",
    queriedAt: QUERIED_AT,
    context: { coverage: "stored_structured_subjects" },
    value: { entity_id: `${caseId}-result`, name: "某公司" },
    supports,
    ...patch,
  } as GrantRequest;
}

function countGrant(
  caseId: string,
  count: number,
  patch: Partial<GrantRequest> = {}
): GrantRequest {
  return {
    kind: EVIDENCE_GRANT_KIND.COUNT,
    subject: EVIDENCE_SUBJECT_KIND.ASSERTION,
    operation: "count",
    queryDigest: `${caseId}-query`,
    scopeBinding: `${caseId}-scope`,
    readRevision: "read-1",
    queriedAt: QUERIED_AT,
    context: { coverage: "stored_structured_subjects" },
    value: { count, operation: "count" },
    count,
    ...patch,
  } as GrantRequest;
}

/**
 * `describeSuite` lets a caller pass the pg harness's own describe, so a
 * missing Postgres skips the whole body loudly instead of running it against
 * an uninitialized pool. It must be a top-level describe reference.
 */
export function runEvidenceStoreContract(
  label: string,
  open: () => Promise<EvidenceStore>,
  describeSuite: typeof vitestDescribe = vitestDescribe
): void {
  describeSuite(`${label}: immutable source and support identity`, () => {
    it("registers one source version per key and joins an identical repeat", async () => {
      const store = await open();
      const caseId = uniqueCase();
      const input = {
        source_ref: `${caseId}-source`,
        source_version: "v1",
        content_digest: contentDigestOf("original"),
        origin_object_ref: "objects/original.pdf",
        parser_revision: "parser-v1",
        unit_manifest: { units: 3 },
        created_at: "2026-02-01T00:00:00.000Z",
      };
      const first = await store.registerSourceVersion(input);
      const second = await store.registerSourceVersion(input);
      expect(first.created).toBe(true);
      expect(second.created, "an identical repeat is the same version").toBe(
        false
      );
      expect(second.record.source_version_id).toBe(
        first.record.source_version_id
      );
      expect(first.record.retired_at).toBeNull();
    });

    it("refuses a version key reused for different immutable content", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await seedSourceVersion(store, caseId);
      // Same bytes under a new parser is a new interpretation, not the version
      // that was already recorded.
      const err = await refusal(
        store.registerSourceVersion({
          source_ref: `${caseId}-source`,
          source_version: "v1",
          content_digest: contentDigestOf("original"),
          origin_object_ref: "objects/original.pdf",
          parser_revision: "parser-v2",
          unit_manifest: { units: 3 },
          created_at: "2026-02-01T00:00:00.000Z",
        })
      );
      expect(failureTokenOf(err)).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
    });

    it("refuses a changed unit manifest under the same key", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await seedSourceVersion(store, caseId);
      const err = await refusal(
        store.registerSourceVersion({
          source_ref: `${caseId}-source`,
          source_version: "v1",
          content_digest: contentDigestOf(`${caseId}-content`),
          origin_object_ref: `objects/${caseId}/original.pdf`,
          parser_revision: "parser-v1",
          unit_manifest: { units: 4 },
          created_at: "2026-02-01T00:00:00.000Z",
        })
      );
      expect(failureTokenOf(err)).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
    });

    it("refuses a support whose source version is not registered", async () => {
      const store = await open();
      const caseId = uniqueCase();
      const seed = await seedSourceVersion(store, caseId);
      const err = await refusal(
        store.recordSupport(
          occurrenceFor(seed, caseId, { source_version: "v-never-registered" })
        )
      );
      expect(failureTokenOf(err)).toBe(
        EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING
      );
    });

    it("refuses a support whose locator the source version does not bind", async () => {
      const store = await open();
      const caseId = uniqueCase();
      const seed = await seedSourceVersion(store, caseId);
      // The two version strings are separate namespaces and need not match —
      // an undeclared PAIRING is what is refused.
      const err = await refusal(
        store.recordSupport(
          occurrenceFor(seed, caseId, {
            location: {
              document_id: "other-doc",
              version: "frozen-v1",
              unit: 1,
            },
          })
        )
      );
      expect(failureTokenOf(err)).toBe(
        EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING
      );
    });

    it("reuses one support for a repeated occurrence and links a second extraction", async () => {
      const store = await open();
      const caseId = uniqueCase();
      const seed = await seedSourceVersion(store, caseId);
      const first = await store.recordSupport(occurrenceFor(seed, caseId));
      const second = await store.recordSupport(
        occurrenceFor(seed, caseId, {
          extraction_ref: `${caseId}-extraction-2`,
        })
      );
      expect(first.created).toBe(true);
      expect(
        second.created,
        "the same occurrence is not a second support"
      ).toBe(false);
      expect(second.support.support_id).toBe(first.support.support_id);
      expect(
        await store.listSupportExtractions(first.support.support_id)
      ).toHaveLength(2);
    });

    it("keeps a distinct version, location or span a distinct support", async () => {
      const store = await open();
      const caseId = uniqueCase();
      const seed = await seedSourceVersion(store, caseId);
      const { record: other } = await store.registerSourceVersion({
        source_ref: `${caseId}-source`,
        source_version: "v2",
        content_digest: contentDigestOf(`${caseId}-v2`),
        origin_object_ref: `objects/${caseId}/v2.pdf`,
        parser_revision: "parser-v1",
        unit_manifest: { units: 3 },
        created_at: "2026-02-02T00:00:00.000Z",
      });
      await store.bindSourceLocator({
        source_version_id: other.source_version_id,
        ...seed.locator,
      });
      await store.bindSourceLocator({
        source_version_id: seed.version.source_version_id,
        document_id: `${caseId}-doc`,
        version: "frozen-v1",
        unit: 2,
      });
      const base = await store.recordSupport(occurrenceFor(seed, caseId));
      const variants = [
        occurrenceFor(seed, caseId, { source_version: "v2" }),
        occurrenceFor(seed, caseId, {
          location: { ...seed.locator, unit: 2 },
        }),
        occurrenceFor(seed, caseId, { span: { start: 0, end: 42 } }),
      ];
      for (const variant of variants) {
        expect((await store.recordSupport(variant)).created).toBe(true);
      }
      const ids = new Set([
        base.support.support_id,
        ...(await Promise.all(
          variants.map(async (variant) => {
            const stored = await store.recordSupport(variant);
            return stored.support.support_id;
          })
        )),
      ]);
      expect(ids.size, "each distinct occurrence is its own support").toBe(4);
    });

    it("refuses an absent span, an empty interval and a locator off its unit", async () => {
      const store = await open();
      const caseId = uniqueCase();
      const seed = await seedSourceVersion(store, caseId);
      // Absent is legitimate: it is what makes structured evidence possible
      // without a quotation.
      const absent = await store.recordSupport(occurrenceFor(seed, caseId));
      expect(absent.support.span).toBeNull();
      for (const span of [
        { start: 5, end: 5 },
        { start: 9, end: 4 },
        { start: -1, end: 4 },
        { start: 0, end: 1.5 },
      ]) {
        const err = await refusal(
          store.recordSupport(
            occurrenceFor(seed, `${caseId}-${span.start}-${span.end}`, { span })
          )
        );
        expect(failureTokenOf(err)).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
      }
      for (const location of [
        { document_id: "", version: "frozen-v1", unit: 1 },
        { document_id: "d", version: "frozen-v1", unit: 0 },
        { document_id: "d", version: "frozen-v1", unit: true },
        { document_id: "d", version: "frozen-v1", unit: 1, page: 2 },
      ]) {
        const err = await refusal(
          store.recordSupport(
            occurrenceFor(seed, `${caseId}-${JSON.stringify(location)}`, {
              location: location as CompanySourceLocator,
            })
          )
        );
        expect(failureTokenOf(err)).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
      }
    });

    it("refuses empty and malformed source-version and support fields", async () => {
      const store = await open();
      const caseId = uniqueCase();
      const seed = await seedSourceVersion(store, caseId);
      const blank = {
        source_ref: "",
        source_version: "v1",
        content_digest: contentDigestOf("x"),
        origin_object_ref: "o",
        parser_revision: "p",
        unit_manifest: {},
        created_at: LATER,
      };
      for (const patch of [
        { source_ref: "" },
        { source_version: "   " },
        { origin_object_ref: "" },
        { content_digest: contentDigestOf("x").toUpperCase() },
        { content_digest: "abc" },
        { created_at: "2026-02-01" },
        { created_at: "not-a-date" },
        { source_version_id: "not-a-uuid" },
      ]) {
        const err = await refusal(
          store.registerSourceVersion({ ...blank, ...patch })
        );
        expect(failureTokenOf(err), JSON.stringify(patch)).toBe(
          EVIDENCE_FAILURE.MALFORMED_CONTRACT
        );
      }
      for (const patch of [
        { extraction_ref: "" },
        { result_id: "" },
        { extractedAt: "2026-02-01" },
        { subject: "chunk" },
      ]) {
        const err = await refusal(
          store.recordSupport(occurrenceFor(seed, caseId, patch))
        );
        expect(failureTokenOf(err), JSON.stringify(patch)).toBe(
          EVIDENCE_FAILURE.MALFORMED_CONTRACT
        );
      }
    });

    it("refuses a support id that resolves to nothing", async () => {
      const store = await open();
      expect(
        await store.getSupport("00000000-0000-4000-8000-000000000000")
      ).toBeNull();
      expect(
        await store.listSupportExtractions(
          "00000000-0000-4000-8000-000000000000"
        )
      ).toEqual([]);
    });

    it("refuses a binding to a source version it does not hold", async () => {
      const store = await open();
      const caseId = uniqueCase();
      const err = await refusal(
        store.bindSourceLocator({
          source_version_id: "00000000-0000-4000-8000-000000000000",
          document_id: `${caseId}-doc`,
          version: "frozen-v1",
          unit: 1,
        })
      );
      expect(failureTokenOf(err)).toBe(
        EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING
      );
    });

    it("refuses an id that is not a uuid, and an empty one", async () => {
      const store = await open();
      for (const id of ["", "not-a-uuid", "12345"]) {
        for (const call of [
          store.getSupport(id),
          store.listSupportExtractions(id),
          store.markSourceVersionRetired(id, LATER),
          store.stopAcceptingObligations(id, LATER),
        ]) {
          const err = await refusal(call);
          expect(
            failureTokenOf(err),
            `${JSON.stringify(id)} must be refused, not answered as a miss`
          ).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
        }
      }
    });
  });

  describeSuite(`${label}: finite row and count grants`, () => {
    it("replays a row grant's exact value with its support set and pinned links", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const seed = await seedSourceVersion(store, caseId);
      const support = (await store.recordSupport(occurrenceFor(seed, caseId)))
        .support;
      const endpoint = (
        await store.recordSupport(
          occurrenceFor(seed, caseId, {
            result_id: `${caseId}-endpoint`,
            extraction_ref: `${caseId}-extraction-endpoint`,
          })
        )
      ).support;
      const grant = await store.issueGrant(
        rowGrant(caseId, [
          {
            support_id: support.support_id,
            role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
          },
          {
            support_id: endpoint.support_id,
            role: EVIDENCE_SUPPORT_ROLE.ENDPOINT_DISPLAY,
          },
        ])
      );
      expect(grant.kind).toBe(EVIDENCE_GRANT_KIND.ROW);
      expect(grant.result_count).toBeNull();
      expect(grant.authorization_receipt_id).toBeNull();

      const replay = await store.readGrant(grant.evidence_ref, LATER);
      expect(replay.state).toBe("granted");
      if (replay.state !== "granted") return;
      expect(replay.grant.value).toEqual({
        entity_id: `${caseId}-result`,
        name: "某公司",
      });
      expect(
        replay.supports.map((entry: SupportRecord) => entry.support_id).sort()
      ).toEqual([support.support_id, endpoint.support_id].sort());
      expect(
        replay.authorization,
        "a row grant re-checks access per dependency"
      ).toBeNull();

      const dependencies = await store.listGrantSupports(grant.evidence_ref);
      expect(dependencies.map((entry) => entry.role).sort()).toEqual(
        [
          EVIDENCE_SUPPORT_ROLE.ENDPOINT_DISPLAY,
          EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
        ].sort()
      );
      // Ordered by support UUID, which is a store-assigned id: the contract
      // is the order, not which random id sorts first.
      expect(
        (await store.listGrantPinnedExtractions(grant.evidence_ref))
          .map((entry) => `${entry.support_id}|${entry.extraction_ref}`)
          .sort()
      ).toEqual(
        [
          `${support.support_id}|${caseId}-extraction-1`,
          `${endpoint.support_id}|${caseId}-extraction-endpoint`,
        ].sort()
      );
    });

    it("refuses a row grant whose support does not resolve", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const err = await refusal(
        store.issueGrant(
          rowGrant(caseId, [
            {
              support_id: "00000000-0000-4000-8000-000000000000",
              role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
            },
          ])
        )
      );
      expect(failureTokenOf(err)).toBe(
        EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING
      );
    });

    it("retains no membership for a count grant and shares one receipt", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const seed = await seedSourceVersion(store, caseId);
      const support = (await store.recordSupport(occurrenceFor(seed, caseId)))
        .support;
      const zero = await store.issueGrant(countGrant(caseId, 0));
      const later = await store.issueGrant(countGrant(caseId, 7));

      for (const grant of [zero, later]) {
        expect(grant.kind).toBe(EVIDENCE_GRANT_KIND.COUNT);
        expect(await store.listGrantSupports(grant.evidence_ref)).toEqual([]);
        expect(
          await store.listGrantPinnedExtractions(grant.evidence_ref)
        ).toEqual([]);
        const replay = await store.readGrant(grant.evidence_ref, LATER);
        expect(replay.state).toBe("granted");
        if (replay.state !== "granted") return;
        expect(replay.supports).toEqual([]);
        expect(replay.authorization).not.toBeNull();
        expect(replay.grant.value).toEqual(grant.value);
      }
      // The stored value is the receipt as supplied — no ids array added to it.
      expect(Object.keys(zero.value as object).sort()).toEqual([
        "count",
        "operation",
      ]);
      // One receipt serves every reference admitted under this scope/revision.
      expect(zero.authorization_receipt_id).toBe(
        later.authorization_receipt_id
      );
      // A support existed when the count was taken and still pins nothing.
      expect(await store.getSupport(support.support_id)).not.toBeNull();
      expect(zero.authorization_receipt_id).not.toBeNull();
    });

    it("expires exactly 365 days from queried_at and never renews", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const grant = await store.issueGrant(countGrant(caseId, 0));
      const expiry = Date.parse(QUERIED_AT) + DAY_MS;
      expect(Date.parse(grant.expires_at)).toBe(expiry);
      expect(grant.queried_at).toBe(QUERIED_AT);

      const lastLive = new Date(expiry - 1).toISOString();
      expect((await store.readGrant(grant.evidence_ref, lastLive)).state).toBe(
        "granted"
      );
      const expired = await store.readGrant(
        grant.evidence_ref,
        new Date(expiry).toISOString()
      );
      expect(expired).toEqual({
        state: "denied",
        failure: EVIDENCE_FAILURE.EXPIRED,
        reason: EVIDENCE_DENIAL_REASON.EXPIRED,
      });

      // Re-reading is not a renewal: the deadline is still the original one.
      await store.readGrant(grant.evidence_ref, lastLive);
      const reread = await store.readGrant(grant.evidence_ref, lastLive);
      expect(reread.state).toBe("granted");
      if (reread.state !== "granted") return;
      expect(Date.parse(reread.grant.expires_at)).toBe(expiry);
      expect(
        (
          await store.readGrant(
            grant.evidence_ref,
            new Date(expiry).toISOString()
          )
        ).state
      ).toBe("denied");
    });

    it("invalidates count replay on a permission change and on a purge", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const grant = await store.issueGrant(countGrant(caseId, 3));
      expect((await store.readGrant(grant.evidence_ref, LATER)).state).toBe(
        "granted"
      );

      await store.setScopeRevisions(`${caseId}-scope`, {
        authorizationRevision: "auth-2",
      });
      const revoked = await store.readGrant(grant.evidence_ref, LATER);
      expect(revoked).toEqual({
        state: "denied",
        failure: EVIDENCE_FAILURE.ACCESS_DENIED,
        reason: EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED,
      });

      const afterPurge = await store.issueGrant(countGrant(caseId, 3));
      await store.setScopeRevisions(`${caseId}-scope`, {
        purgeRevision: "purge-2",
      });
      const purged = await store.readGrant(afterPurge.evidence_ref, LATER);
      expect(purged).toEqual({
        state: "denied",
        failure: EVIDENCE_FAILURE.UNAVAILABLE,
        reason: EVIDENCE_DENIAL_REASON.PURGED,
      });
    });

    it("leaves a count receipt intact through publication and payload GC", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const seed = await seedSourceVersion(store, caseId);
      const support = (await store.recordSupport(occurrenceFor(seed, caseId)))
        .support;
      const count = await store.issueGrant(countGrant(caseId, 1));
      const row = await store.issueGrant(
        rowGrant(caseId, [
          {
            support_id: support.support_id,
            role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
          },
        ])
      );

      await store.markSourceVersionRetired(
        seed.version.source_version_id,
        LATER
      );
      await store.collectSourceVersionPayload(
        seed.version.source_version_id,
        LATER
      );

      const replay = await store.readGrant(count.evidence_ref, LATER);
      expect(replay.state, "a data revision is not a purge").toBe("granted");
      const rowReplay = await store.readGrant(row.evidence_ref, LATER);
      expect(rowReplay.state).toBe("granted");
      if (rowReplay.state !== "granted") return;
      expect(rowReplay.supports).toHaveLength(1);
    });

    it("issues no new grant once a purge candidate stops accepting obligations", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const seed = await seedSourceVersion(store, caseId);
      const support = (await store.recordSupport(occurrenceFor(seed, caseId)))
        .support;
      const deps = [
        {
          support_id: support.support_id,
          role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
        },
      ];
      const before = await store.issueGrant(rowGrant(caseId, deps));

      await store.stopAcceptingObligations(
        seed.version.source_version_id,
        "2026-05-01T00:00:00.000Z"
      );
      const err = await refusal(store.issueGrant(rowGrant(caseId, deps)));
      expect(failureTokenOf(err)).toBe(EVIDENCE_FAILURE.UNAVAILABLE);

      const replay = await store.readGrant(
        before.evidence_ref,
        "2026-05-02T00:00:00.000Z"
      );
      expect(replay).toEqual({
        state: "denied",
        failure: EVIDENCE_FAILURE.UNAVAILABLE,
        reason: EVIDENCE_DENIAL_REASON.OBLIGATIONS_STOPPED,
      });
      // A count grant holds no source dependency, so it is untouched.
      const count = await store.issueGrant(countGrant(caseId, 0));
      expect(
        (await store.readGrant(count.evidence_ref, "2026-05-02T00:00:00.000Z"))
          .state
      ).toBe("granted");
    });

    it("refuses a whole batch when one member cannot be issued, and leaves the scope issuing", async () => {
      // A read that returned three rows mints three references, and a caller
      // that never receives the page must not leave any behind it — each pins
      // its dependencies for the grant's whole lifetime. So the batch is one
      // write, not a loop over `issueGrant`.
      //
      // What this lane can observe is the REFUSAL and the store's own state, and
      // the refusal is the whole batch's: one member that cannot be issued takes
      // the batch with it, under the token that member earned. What it cannot
      // observe is the absence of the committed references, because the batch
      // mints them internally and no `EvidenceStore` member lists them — a
      // per-grant loop refuses identically here. So this case pins the shared,
      // observable half; the zero-committed half is proven where it IS
      // observable, against the cluster's own table, in
      // tests/acceptance/structured-query-pg.test.ts.
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const seed = await seedSourceVersion(store, caseId);
      const support = (await store.recordSupport(occurrenceFor(seed, caseId)))
        .support;
      const good = [
        {
          support_id: support.support_id,
          role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
        },
      ];
      const ABSENT = "00000000-0000-4000-8000-00000000dead";

      const err = await refusal(
        store.issueGrants([
          rowGrant(caseId, good),
          rowGrant(caseId, [
            { support_id: ABSENT, role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE },
          ]),
        ])
      );
      // The batch's own token, not a generic one and not the neighbour's: a
      // store that issued the first member and reported a later failure as a
      // partial success would answer differently.
      expect(failureTokenOf(err)).toBe(
        EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING
      );

      // The scope still issues, so the refusal was the batch's and not the
      // scope's: a poisoned or half-consumed scope would answer this with a
      // different token.
      const committed = await store.issueGrants([rowGrant(caseId, good)]);
      expect(committed).toHaveLength(1);
      const replay = await store.readGrant(committed[0]!.evidence_ref, LATER);
      expect(replay.state).toBe("granted");
    });

    it("issues a valid batch whole, one reference per request in order", async () => {
      // The twin of the case above: a batch that every member survives commits
      // every member, in the order given, so a page's references line up with
      // its rows rather than with a store's own iteration order.
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const seed = await seedSourceVersion(store, caseId);
      const support = (await store.recordSupport(occurrenceFor(seed, caseId)))
        .support;
      const deps = [
        {
          support_id: support.support_id,
          role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
        },
      ];
      const requests = [
        rowGrant(caseId, deps, { queryDigest: `${caseId}-q0` }),
        rowGrant(caseId, deps, { queryDigest: `${caseId}-q1` }),
        countGrant(caseId, 3, { queryDigest: `${caseId}-q2` }),
      ];

      const issued = await store.issueGrants(requests);

      expect(issued).toHaveLength(3);
      expect(issued.map((grant) => grant.query_digest)).toEqual([
        `${caseId}-q0`,
        `${caseId}-q1`,
        `${caseId}-q2`,
      ]);
      // Distinct handles: a batch that reused one reference would make two rows
      // cite the same receipt.
      expect(new Set(issued.map((grant) => grant.evidence_ref)).size).toBe(3);
      for (const grant of issued) {
        expect((await store.readGrant(grant.evidence_ref, LATER)).state).toBe(
          "granted"
        );
      }
    });

    it("checks the expected scope revisions before issuing, including an empty batch", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const expected = {
        scope_binding: `${caseId}-scope`,
        authorization_revision: "auth-1",
        purge_revision: "purge-1",
      };

      await store.setScopeRevisions(expected.scope_binding, {
        authorizationRevision: "auth-2",
      });
      const authChanged = await refusal(
        store.issueGrants([countGrant(caseId, 0)], expected)
      );
      expect(failureTokenOf(authChanged)).toBe(EVIDENCE_FAILURE.ACCESS_DENIED);

      const emptyBatch = await refusal(store.issueGrants([], expected));
      expect(failureTokenOf(emptyBatch)).toBe(EVIDENCE_FAILURE.ACCESS_DENIED);

      const purgeCase = uniqueCase();
      await admit(store, purgeCase);
      const purgeFence = {
        scope_binding: `${purgeCase}-scope`,
        authorization_revision: "auth-1",
        purge_revision: "purge-1",
      };
      await store.setScopeRevisions(purgeFence.scope_binding, {
        purgeRevision: "purge-2",
      });
      const purgeChanged = await refusal(
        store.issueGrants([countGrant(purgeCase, 0)], purgeFence)
      );
      expect(failureTokenOf(purgeChanged)).toBe(EVIDENCE_FAILURE.UNAVAILABLE);
    });

    it("rejects an expected revision fence for another scope", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const expected = {
        scope_binding: "another-scope",
        authorization_revision: "auth-1",
        purge_revision: "purge-1",
      };
      const err = await refusal(
        store.issueGrants([countGrant(caseId, 0)], expected)
      );
      expect(failureTokenOf(err)).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
    });

    it("refuses an unknown reference, an unknown scope and a malformed instant", async () => {
      const store = await open();
      const caseId = uniqueCase();
      expect(await store.readGrant("no-such-reference", LATER)).toEqual({
        state: "denied",
        failure: EVIDENCE_FAILURE.UNAVAILABLE,
        reason: EVIDENCE_DENIAL_REASON.UNKNOWN_REFERENCE,
      });

      const err = await refusal(store.issueGrant(countGrant(caseId, 1)));
      expect(failureTokenOf(err)).toBe(EVIDENCE_FAILURE.UNAVAILABLE);

      const seed = await seedSourceVersion(store, caseId);
      await store.recordSupport(occurrenceFor(seed, caseId));
      const badAt = await refusal(
        store.readGrant("no-such-reference", "yesterday")
      );
      expect(failureTokenOf(badAt)).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
    });

    it("refuses an empty, malformed, mismatched or oversized grant request", async () => {
      const store = await open();
      const caseId = uniqueCase();
      await admit(store, caseId);
      const seed = await seedSourceVersion(store, caseId);
      const support = (await store.recordSupport(occurrenceFor(seed, caseId)))
        .support;
      const deps = [
        {
          support_id: support.support_id,
          role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
        },
      ];

      const malformed: Array<[string, unknown]> = [
        ["empty operation", rowGrant(caseId, deps, { operation: "" })],
        ["empty query digest", rowGrant(caseId, deps, { queryDigest: "  " })],
        ["empty scope", rowGrant(caseId, deps, { scopeBinding: "" })],
        ["empty read revision", rowGrant(caseId, deps, { readRevision: "" })],
        ["absent value", rowGrant(caseId, deps, { value: undefined })],
        ["context not a record", rowGrant(caseId, deps, { context: "nope" })],
        ["bad queried_at", rowGrant(caseId, deps, { queriedAt: "2026-03-01" })],
        ["bad subject", rowGrant(caseId, deps, { subject: "chunk" })],
        ["bad kind", rowGrant(caseId, deps, { kind: "snapshot" })],
        ["row with no supports", rowGrant(caseId, [])],
        ["row with a count", { ...rowGrant(caseId, deps), count: 1 }],
        ["count with supports", { ...countGrant(caseId, 1), supports: deps }],
        [
          "bad role",
          rowGrant(caseId, [{ support_id: support.support_id, role: "pin" }]),
        ],
        [
          "empty support id",
          rowGrant(caseId, [
            { support_id: "", role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE },
          ]),
        ],
        [
          "support id is not a uuid",
          rowGrant(caseId, [
            { support_id: "nope", role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE },
          ]),
        ],
        ["negative count", countGrant(caseId, -1)],
        ["fractional count", countGrant(caseId, 1.5)],
        ["not-a-number count", countGrant(caseId, Number.NaN)],
        ["overflowing count", countGrant(caseId, Number.MAX_SAFE_INTEGER + 2)],
        [
          "oversized value",
          rowGrant(caseId, deps, {
            value: { blob: "x".repeat(MAX_EVIDENCE_BYTES + 1) },
          }),
        ],
      ];
      for (const [name, request] of malformed) {
        const err = await refusal(store.issueGrant(request as GrantRequest));
        expect(
          failureTokenOf(err),
          `${name} must be refused with a typed failure`
        ).toBeDefined();
        expect(
          [
            EVIDENCE_FAILURE.MALFORMED_CONTRACT,
            EVIDENCE_FAILURE.TOO_LARGE,
            EVIDENCE_FAILURE.UNAVAILABLE,
            EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
          ],
          `${name} refused as ${String(failureTokenOf(err))}`
        ).toContain(failureTokenOf(err));
      }

      // The two size/serialization cases carry their own token, so they are
      // pinned rather than lumped in with the malformed family above.
      const oversized = await refusal(
        store.issueGrant(
          rowGrant(caseId, deps, {
            value: { blob: "x".repeat(MAX_EVIDENCE_BYTES + 1) },
          })
        )
      );
      expect(failureTokenOf(oversized)).toBe(EVIDENCE_FAILURE.TOO_LARGE);
      const cyclic = { name: "cycle" } as Record<string, unknown>;
      cyclic["self"] = cyclic;
      const unserializable = await refusal(
        store.issueGrant(rowGrant(caseId, deps, { value: cyclic }))
      );
      expect(failureTokenOf(unserializable)).toBe(
        EVIDENCE_FAILURE.MALFORMED_CONTRACT
      );
    });

    it("refuses a scope revision write that would leave a dimension unknown", async () => {
      const store = await open();
      const caseId = uniqueCase();
      const first = await refusal(
        store.setScopeRevisions(`${caseId}-half`, {
          authorizationRevision: "auth-1",
        })
      );
      expect(failureTokenOf(first)).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
      const blank = await refusal(store.setScopeRevisions("  ", {}));
      expect(failureTokenOf(blank)).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);

      await admit(store, caseId);
      // Once both are on record, one dimension may move alone.
      const moved = await store.setScopeRevisions(`${caseId}-scope`, {
        purgeRevision: "purge-9",
      });
      expect(moved.authorization_revision).toBe("auth-1");
      expect(moved.purge_revision).toBe("purge-9");
    });

    it("refuses to stamp an unknown source version", async () => {
      const store = await open();
      for (const stamp of [
        store.markSourceVersionRetired,
        store.collectSourceVersionPayload,
        store.stopAcceptingObligations,
      ]) {
        const err = await refusal(
          stamp.call(store, "00000000-0000-4000-8000-000000000000", LATER)
        );
        expect(failureTokenOf(err)).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
      }
    });
  });
}
