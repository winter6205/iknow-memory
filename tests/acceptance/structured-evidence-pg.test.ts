import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { failureTokenOf } from "../../src/core/errors.js";
import { supportsEvidenceStore } from "../../src/core/storage/backend.js";
import { contentDigestOf } from "../../src/core/storage/evidence-source.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import {
  EVIDENCE_FAILURE,
  EVIDENCE_SUBJECT_KIND,
  type EvidenceStore,
  type NewSourceVersion,
  type SupportOccurrence,
} from "../../src/core/types.js";
import {
  openStrictPgDriver,
  requireFullyRunnable,
  warnNotRun,
  type NotRunCase,
} from "./strict-pg-driver.js";

const EXPECTED_COMMAND =
  "STRUCTURED_EVIDENCE_ACCEPTANCE=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-evidence-pg.test.ts";
const SCHEMA_PREFIX = "structured_evidence_acceptance";
const DIMENSIONS = 8;
const EXTRACTED_AT = "2026-03-02T00:00:00.000Z";
const E1_REFUSAL_SOURCE =
  "specs/structured-corpus-evidence.md E1 (mismatched binding refuses) with the refusal token fixed by the plan's EP1 acceptance as unsupported_source_binding; the token is not read back from the store and no backend-assigned id appears in the expectation";
const E1_RESOLVED_SOURCE =
  "the same identity tuple that did resolve is still accepted, so the two refusals above are refusals of the mismatch and not of every occurrence";
const E2_REUSE_SOURCE =
  "specs/structured-corpus-evidence.md E2 (the same occurrence extracted twice is one support with two extraction links) with occurrence identity fixed by the plan's EP1 acceptance as subject, result, source, version, location and span; both calls carry one identity tuple with a different extraction_ref and the expected result comes from the spec, never from a support id the store assigned";
const E2_DISTINCT_SOURCE =
  "specs/structured-corpus-evidence.md E2 (different versions or locations remain distinct): a distinct version and a distinct bound location are separate supports, not another extraction link on the first one";

const driver = await openStrictPgDriver({
  envName: "STRUCTURED_EVIDENCE_ACCEPTANCE",
  testPath: "tests/acceptance/structured-evidence-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  label: "structured-evidence-acceptance-pg",
  schemaPrefix: SCHEMA_PREFIX,
  dependency: "real PostgreSQL with pgvector",
});

const SCHEMA_URL = driver.schemaConnectionString;

const CLEANUP_CONTRACT =
  "one unique schema per run created by this lane's own resetSchema and dropped CASCADE by this run's afterAll behind the schemaPrefix assertion; no object outside that schema is created or removed";

interface FrozenCase {
  readonly id: string;
  readonly owner: string;
  readonly scenario: string;
  readonly scenarioSource: string;
  readonly boundary: string;
  readonly expectedSource: string;
  readonly cleanup: string;
  readonly notRun: NotRunCase;
}

function frozenCase(entry: {
  readonly id: string;
  readonly owner: string;
  readonly scenario: string;
  readonly scenarioSource: string;
  readonly boundary: string;
  readonly expectedSource: string;
  readonly cleanup: string;
  readonly notRun: readonly { claim: string; owner: string; reason: string }[];
}): FrozenCase {
  return {
    ...entry,
    notRun: {
      caseId: entry.id,
      expectedCommand: EXPECTED_COMMAND,
      owner: entry.owner,
      entries: entry.notRun,
    },
  };
}

const CASES: readonly FrozenCase[] = [
  frozenCase({
    id: "E1",
    owner: "EP0, EP1, EP2, EP12",
    scenario:
      "source/version/unit binding resolves to the retained original and a mismatched binding refuses",
    scenarioSource:
      "specs/structured-corpus-evidence.md E1 via the frozen EP0 matrix row E1",
    boundary:
      "real PostgreSQL: the EvidenceStore capability on the bootstrapped pgvector schema, reached through registerSourceVersion, bindSourceLocator and recordSupport",
    expectedSource:
      "specs/structured-corpus-evidence.md E1 (mismatched binding refuses) with the refusal token fixed by the plan's EP1 acceptance (unsupported_source_binding); no backend-assigned id and no QP1 value is the expected result",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "frozen-corpus half",
        owner: "QP1, QP3, EP12",
        reason:
          "the frozen public corpus and its independently reviewed expected-locator oracle and the Q-ID identity registry do not exist, and backend-assigned ids are frozen only after the first real ingest (QP10), so no real corpus binding can be resolved here",
      },
    ],
  }),
  frozenCase({
    id: "E2",
    owner: "EP1, EP12",
    scenario:
      "the same occurrence extracted twice is one support with two extraction links, while a different version or location stays distinct",
    scenarioSource:
      "specs/structured-corpus-evidence.md E2 via the frozen EP0 matrix row E2",
    boundary:
      "real PostgreSQL: the EvidenceStore capability on the bootstrapped pgvector schema, reached through recordSupport, getSupport and listSupportExtractions",
    expectedSource:
      "specs/structured-corpus-evidence.md E2 (one support with two extraction links; different versions or locations remain distinct) with occurrence identity fixed by the plan's EP1 acceptance (subject, result, source, version, location, span); the support id is read back only to prove identity, never to form an expectation",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "frozen-corpus half",
        owner: "QP1, QP3, EP12",
        reason:
          "the frozen public corpus, its reviewed locator oracle and the Q-ID identity registry do not exist, so the real two-repository duplicate-occurrence pair cannot be exercised; the independent boundary claim above covers the same rule with an authored fixture",
      },
    ],
  }),
  frozenCase({
    id: "E3",
    owner: "EP1, EP4, EP12; M-PUBLISH",
    scenario:
      "one relation supported by two sources has one result identity and withdrawing one preserves the other and the old evidence",
    scenarioSource:
      "specs/structured-corpus-evidence.md E3 via the frozen EP0 matrix row E3",
    boundary:
      "real PostgreSQL: the EvidenceStore capability; the withdrawal half needs the M-PUBLISH accepted active set, which does not exist",
    expectedSource:
      "specs/structured-corpus-evidence.md E3; the plan's M-PUBLISH owns activation and retirement of accepted occurrences",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both halves",
        owner: "MP6, QP1, EP12",
        reason:
          "the M-PUBLISH accepted active set (MP6) and the frozen corpus (QP1) do not exist, so no second origin can be activated or withdrawn and neither the shared identity nor the preserved-after-withdrawal expectation has a runnable boundary",
      },
    ],
  }),
  frozenCase({
    id: "E4",
    owner: "EP6, EP7, EP12",
    scenario:
      "a v1 answer replays v1 while refresh receives v2 and replay issues no query",
    scenarioSource:
      "specs/structured-corpus-evidence.md E4 via the frozen EP0 matrix row E4",
    boundary:
      "the real corpus_evidence.read seam with the post-ingest backend-assigned identity map; neither exists",
    expectedSource:
      "specs/structured-corpus-evidence.md E4 with the replay-versus-refresh distinction fixed by the plan's EP6/EP7",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both halves",
        owner: "QP10, QP11, EP12",
        reason:
          "the post-ingest backend-assigned identity map (QP10) and the measured page and result bounds (QP11) do not exist, and backend-assigned ids are frozen only after the first real ingest, so a v1 replay and a v2 refresh cannot be driven",
      },
    ],
  }),
  frozenCase({
    id: "E5",
    owner: "EP5, EP6, EP12",
    scenario:
      "a row and a zero or nonzero count snapshot verify only fields received this turn, and invented fields refuse",
    scenarioSource:
      "specs/structured-corpus-evidence.md E5 via the frozen EP0 matrix row E5",
    boundary:
      "the fin host verifier that selects by subject, operation and result id over a real producer transport; that seam is outside this repository and this driver",
    expectedSource: "specs/structured-corpus-evidence.md E5 with the plan's EP5/EP6 host contract",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "QP8, EP5, EP6",
        reason:
          "the real producer transport (QP8) does not exist, and the verifier that grounds only inside the selected payload is a fin host concern reached through the graph.py retrieve-tool seam, which this iknow-memory PostgreSQL lane cannot open; the fin verifier's own focused tests are a separate lane",
      },
    ],
  }),
  frozenCase({
    id: "E6",
    owner: "EP2, EP3, EP4, EP7, EP12",
    scenario:
      "more than 8 supports continues in stable order within both limits, no incomplete flag appears without continuation, and expiry never renews",
    scenarioSource:
      "specs/structured-corpus-evidence.md E6 via the frozen EP0 matrix row E6",
    boundary:
      "real PostgreSQL: the EvidenceStore grant port (issueGrant, readGrant, listGrantSupports, listGrantPinnedExtractions); the continuation bounds are not measured",
    expectedSource:
      "specs/structured-corpus-evidence.md E6 (no incomplete flag without continuation; expiry never renews) with both size bounds and the continuation threshold fixed by QP11's measured limits",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "continuation and bounds",
        owner: "QP11, EP12",
        reason:
          "the measured page and result bounds (QP11) do not exist, so neither the continuation threshold nor the two size limits this case names is a citable expectation, and asserting one would invent a threshold",
      },
      {
        claim: "host and adapter side",
        owner: "EP3, EP4, EP7",
        reason:
          "the private MCP dispatch, the read and bounded supports actions and the real Fin retrieve adapter are EP3/EP4/T39 work, so the case's adapter half has no entry point in this storage lane",
      },
    ],
  }),
  frozenCase({
    id: "E7",
    owner: "EP5, EP12; EP0",
    scenario:
      "the Python and TypeScript canonical bytes and digest agree, and every refusal class holds",
    scenarioSource:
      "specs/structured-corpus-evidence.md E7 via the frozen EP0 matrix row E7",
    boundary:
      "a cross-language golden vector file consumed by both runtimes plus raw-byte decoder tests at an owned raw boundary; the TypeScript encoder is not committed at this ref",
    expectedSource: "specs/structured-corpus-evidence.md E7 with the vector set fixed by the plan's EP5",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both runtimes",
        owner: "EP5, EP12",
        reason:
          "the frozen EP0 matrix records the 12 vectors and 9 refusals as observed only in an uncommitted iknow-memory worktree, not against a committed ref, and the Python encoder lives in the fin repository; neither runtime can be pinned from this PostgreSQL lane",
      },
      {
        claim: "raw-byte decoder half",
        owner: "EP5",
        reason:
          "the raw decoder's owned raw boundary is a fin decode path, and no cross-language vector file is frozen at this ref",
      },
    ],
  }),
  frozenCase({
    id: "E8",
    owner: "EP3, EP4, EP8, EP9, EP10, EP12",
    scenario:
      "current access revocation or purge withholds an otherwise unexpired snapshot and its inline and continued supports",
    scenarioSource:
      "specs/structured-corpus-evidence.md E8 via the frozen EP0 matrix row E8",
    boundary:
      "real PostgreSQL: the EvidenceStore grant and scope-revision port; the M-PURGE backend deletion and the private dispatch consumer do not exist",
    expectedSource:
      "specs/structured-corpus-evidence.md E8 with the revision semantics fixed by the plan's EP2 (a permission change or explicit purge advances the corresponding revision and invalidates count receipts admitted under the previous one)",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both halves",
        owner: "MP16, EP3, EP4, EP10",
        reason:
          "M-PURGE backend deletion (MP16) does not exist and no private MCP dispatch or trusted consumer (EP3/EP4) exists, so a snapshot cannot be withheld at the real consumer boundary even though the storage-side revision seam is real",
      },
    ],
  }),
  frozenCase({
    id: "E9",
    owner: "EP2, EP11, EP12; MP15",
    scenario:
      "a fake clock crossing the 90 and 365 day boundaries protects retired source evidence only until its fixed deadline, and reading never extends it",
    scenarioSource:
      "specs/structured-corpus-evidence.md E9 via the frozen EP0 matrix row E9",
    boundary:
      "real PostgreSQL with an explicit read instant: the EvidenceStore grant port; the M-COLLECT physical collector does not exist",
    expectedSource:
      "specs/structured-corpus-evidence.md E9 with the 365 day nonrenewable lifetime fixed by the plan's EP2 acceptance",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both halves",
        owner: "MP15, EP12",
        reason:
          "the M-COLLECT physical collector (MP15) does not exist, so physical collection cannot be observed, and the adapter-side 90 day eligibility window has no host lane here; asserting either would invent a threshold the plan does not fix",
      },
    ],
  }),
  frozenCase({
    id: "E10",
    owner: "EP7, EP11, EP12",
    scenario:
      "an expired citation stays visibly unavailable with no redirection, and payload cleanup leaves only non-content audit data",
    scenarioSource:
      "specs/structured-corpus-evidence.md E10 via the frozen EP0 matrix row E10",
    boundary:
      "the fin host citation gate over a real grant; the EP7/EP11 state machine and the typed host transport (QP8) do not exist",
    expectedSource: "specs/structured-corpus-evidence.md E10 with the plan's EP7/EP11 state machine",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both halves",
        owner: "EP7, EP11, QP8",
        reason:
          "the typed host transport carrying structured_result (QP8) does not exist and the EP7/EP11 state machine is pending, so the real form of the case has no transport and cleanup audit can leave nothing behind to assert on",
      },
    ],
  }),
  frozenCase({
    id: "E11",
    owner: "EP2, EP3, EP5, EP6, EP12",
    scenario:
      "an oversized row or snapshot and a source-service failure yield typed errors, never truncation or success-shaped empty evidence",
    scenarioSource:
      "specs/structured-corpus-evidence.md E11 via the frozen EP0 matrix row E11",
    boundary:
      "the new action and host contract boundary; the storage-side bounded envelope is real in the EvidenceStore but is not this case's boundary",
    expectedSource: "specs/structured-corpus-evidence.md E11 with the plan's EP2/EP3/EP5/EP6",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "source-service-failure half",
        owner: "EP2, EP3",
        reason:
          "the source-service-failure half (backend_unavailable) has no coverage anywhere and belongs to the pending EP2 and EP3 storage seams, and the action boundary itself does not exist yet",
      },
      {
        claim: "host half",
        owner: "EP5, EP6",
        reason:
          "the fin action boundary that would raise the typed error is a separate lane; the frozen EP0 matrix records the oversized half as already covered on three fin paths",
      },
    ],
  }),
  frozenCase({
    id: "E12",
    owner: "EP6, EP7, EP12",
    scenario:
      "the legacy database-row, locator, visual-evidence, ADR 0092 digest and ADR 0093 conformance cases remain unchanged and pass",
    scenarioSource:
      "specs/structured-corpus-evidence.md E12 via the frozen EP0 matrix row E12",
    boundary:
      "the named existing regressions of the fin repository, which this iknow-memory PostgreSQL lane cannot open; the gate is preserved by not changing them",
    expectedSource:
      "specs/structured-corpus-evidence.md E12 with the command list recorded in the frozen EP0 matrix E12 section",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "legacy regressions",
        owner: "EP6, EP7, EP12",
        reason:
          "the case is proven by the named existing fin suites (tests/host/test_evidence_contract.py, test_citation_gate.py, test_evidence_admission.py, test_sql_row_evidence.py, test_evidence_replay_v0.py, test_visual_claims_wire.py and tests/retrieve/test_source_read.py under uv run --no-sync pytest -q) plus the ADR 0092 digest worksheet, all of which live in the fin repository; this lane may not run another repository's suite, and this driver changes no legacy file",
      },
    ],
  }),
  frozenCase({
    id: "E13",
    owner: "EP1, EP7, EP12; M-PUBLISH",
    scenario:
      "re-extracting an unchanged source with a new model retires omitted occurrences at successful publication, preserves shared support ids, and prior snapshots retain their original extraction attribution",
    scenarioSource:
      "specs/structured-corpus-evidence.md E13 via the frozen EP0 matrix row E13",
    boundary:
      "real PostgreSQL: the EvidenceStore grant-pinned extraction read; retirement of omitted occurrences is M-PUBLISH and does not exist",
    expectedSource:
      "specs/structured-corpus-evidence.md E13 with the plan's EP1 acceptance (a later extraction does not widen what a historical citation holds)",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both halves",
        owner: "MP6, EP7, EP12",
        reason:
          "omitted occurrences retire at successful publication, which is M-PUBLISH (MP6) and does not exist, and the Fin retrieve adapter that would replay a prior snapshot (EP7) is a separate lane",
      },
    ],
  }),
  frozenCase({
    id: "E14",
    owner: "EP2, EP3, EP6, EP11, EP12; Maintenance collector",
    scenario:
      "a zero-count receipt survives ordinary source replacement and unreferenced payload GC but scope revocation or purge withholds it immediately, with no raw source or full membership pin",
    scenarioSource:
      "specs/structured-corpus-evidence.md E14 via the frozen EP0 matrix row E14",
    boundary:
      "real PostgreSQL: the EvidenceStore count-grant and scope-revision port; the M-COLLECT physical collector and M-PURGE do not exist",
    expectedSource:
      "specs/structured-corpus-evidence.md E14 with the receipt-only retention fixed by the plan's EP2 acceptance (a count grant retains the receipt and the shared authorization receipt only)",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both halves",
        owner: "MP15, MP16, EP11",
        reason:
          "the M-COLLECT physical collector (MP15) and M-PURGE backend deletion (MP16) do not exist, so physical collection and purge-driven withholding cannot be observed at a real boundary",
      },
    ],
  }),
  frozenCase({
    id: "E15",
    owner: "EP3, EP4, EP8, EP9, EP10, EP12; MP16, MP17",
    scenario:
      "internal read and supports return the frozen authorized grant, invalidation scrubs the host payload before ack, and offline reconnect or gap recovery cannot expose a denied snapshot or report purge complete prematurely",
    scenarioSource:
      "specs/structured-corpus-evidence.md E15 via the frozen EP0 matrix row E15",
    boundary:
      "the private MCP dispatch, the trusted consumer and the persistent session owner with the Fin adapter; none exists",
    expectedSource:
      "specs/structured-corpus-evidence.md E15 with the plan's MP17 post-scrub all-owner completion",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both halves",
        owner: "MP16, MP17, T39, EP3, EP4",
        reason:
          "M-PURGE backend deletion (MP16), M-OWNER-COMPLETE post-scrub completion (MP17) and the private dispatch, trusted consumer and session owner (T39/EP3/EP4) do not exist, so scrub-before-ack and gap recovery have no real boundary",
      },
    ],
  }),
];

const CASE_IDS = CASES.map((entry) => entry.id);

let admin: pg.Client;
let backend: PgvectorBackend;
let evidence: EvidenceStore;
let caseCounter = 0;

function uniqueCase(): string {
  caseCounter += 1;
  return `e${caseCounter}`;
}

async function seedSourceVersion(
  store: EvidenceStore,
  caseId: string
): Promise<{
  readonly sourceRef: string;
  readonly locator: { document_id: string; version: string; unit: number };
}> {
  const record: NewSourceVersion = {
    source_ref: `${caseId}-source`,
    source_version: "v1",
    content_digest: contentDigestOf(`${caseId}-content`),
    origin_object_ref: `objects/${caseId}/original.pdf`,
    parser_revision: "parser-v1",
    unit_manifest: { units: 3 },
    created_at: "2026-02-01T00:00:00.000Z",
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  };
  const { record: stored } = await store.registerSourceVersion(record);
  const locator = {
    document_id: `${caseId}-doc`,
    version: "frozen-v1",
    unit: 1,
  };
  await store.bindSourceLocator({
    source_version_id: stored.source_version_id,
    ...locator,
  });
  await store.bindSourceLocator({
    source_version_id: stored.source_version_id,
    ...locator,
    unit: 2,
  });
  return { sourceRef: stored.source_ref, locator };
}

function occurrenceFor(
  seed: { readonly sourceRef: string; readonly locator: { document_id: string; version: string; unit: number } },
  caseId: string,
  patch: Partial<SupportOccurrence> = {}
): SupportOccurrence {
  return {
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    result_id: `${caseId}-result`,
    source_ref: seed.sourceRef,
    source_version: "v1",
    location: seed.locator,
    span: null,
    extraction_ref: `${caseId}-extraction-1`,
    extractedAt: EXTRACTED_AT,
    ...patch,
  };
}

async function typedRefusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const token = failureTokenOf(error);
    if (token === undefined) {
      // EXIT: the call refused but carried no typed failure token. The case
      // throws, so an untyped refusal is never reported as the expected typed
      // refusal code.
      throw new Error(
        `the refusal carried no typed failure token, so it cannot be the expected refusal: ${String(error)}`
      );
    }
    return token;
  }
  // EXIT: a case expected a typed refusal and the call resolved. The case throws
  // naming the expectation, so a store that stopped refusing can never be
  // reported as a pass.
  throw new Error(
    "expected a typed refusal; the call resolved instead, so the absence of the refusal is itself a failure"
  );
}

const RUNNABLE_CLAIMS: Readonly<Record<string, () => Promise<void>>> = {
  E1: async () => {
    const caseId = uniqueCase();
    const seed = await seedSourceVersion(evidence, caseId);

    const unregisteredVersion = await typedRefusal(
      evidence.recordSupport(
        occurrenceFor(seed, caseId, { source_version: "v-never-registered" })
      )
    );
    expect(unregisteredVersion, E1_REFUSAL_SOURCE).toBe(
      EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING
    );

    const unboundLocator = await typedRefusal(
      evidence.recordSupport(
        occurrenceFor(seed, caseId, {
          location: { document_id: `${caseId}-other-doc`, version: "frozen-v1", unit: 1 },
        })
      )
    );
    expect(unboundLocator, E1_REFUSAL_SOURCE).toBe(
      EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING
    );

    const accepted = await evidence.recordSupport(occurrenceFor(seed, caseId));
    expect(accepted.created, E1_RESOLVED_SOURCE).toBe(true);
  },

  E2: async () => {
    const caseId = uniqueCase();
    const seed = await seedSourceVersion(evidence, caseId);

    const first = await evidence.recordSupport(occurrenceFor(seed, caseId));
    const second = await evidence.recordSupport(
      occurrenceFor(seed, caseId, { extraction_ref: `${caseId}-extraction-2` })
    );
    expect(first.created, E2_REUSE_SOURCE).toBe(true);
    expect(second.created, E2_REUSE_SOURCE).toBe(false);
    expect(second.support.support_id, E2_REUSE_SOURCE).toBe(
      first.support.support_id
    );
    const links = await evidence.listSupportExtractions(
      first.support.support_id
    );
    expect([...links].sort(), E2_REUSE_SOURCE).toEqual([
      `${caseId}-extraction-1`,
      `${caseId}-extraction-2`,
    ]);

    const { record: secondVersion } = await evidence.registerSourceVersion({
      source_ref: seed.sourceRef,
      source_version: "v2",
      content_digest: contentDigestOf(`${caseId}-content-v2`),
      origin_object_ref: `objects/${caseId}/original-v2.pdf`,
      parser_revision: "parser-v1",
      unit_manifest: { units: 3 },
      created_at: "2026-02-02T00:00:00.000Z",
      retired_at: null,
      payload_collected_at: null,
      obligations_stopped_at: null,
    });
    await evidence.bindSourceLocator({
      source_version_id: secondVersion.source_version_id,
      document_id: seed.locator.document_id,
      version: "frozen-v1",
      unit: 1,
    });
    const otherVersion = await evidence.recordSupport(
      occurrenceFor(seed, caseId, { source_version: "v2" })
    );
    expect(otherVersion.created, E2_DISTINCT_SOURCE).toBe(true);
    expect(otherVersion.support.support_id, E2_DISTINCT_SOURCE).not.toBe(
      first.support.support_id
    );

    const otherLocation = await evidence.recordSupport(
      occurrenceFor(seed, caseId, {
        location: { ...seed.locator, unit: 2 },
      })
    );
    expect(otherLocation.created, E2_DISTINCT_SOURCE).toBe(true);
    expect(otherLocation.support.support_id, E2_DISTINCT_SOURCE).not.toBe(
      first.support.support_id
    );
  },
};

describe("structured corpus Evidence E1–E15 acceptance — PostgreSQL", () => {
  beforeAll(async () => {
    admin = driver.harness.createClient(SCHEMA_URL);
    await admin.connect();
    await driver.harness.resetSchema(admin);
    backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, {
      annMaxDimensions: 2000,
    });
    await backend.initialize();
    if (!supportsEvidenceStore(backend)) {
      // EXIT: the composed backend does not expose the EvidenceStore capability
      // this lane drives. The setup throws before any case runs, so no E case can
      // be reported against a storage surface the backend does not own.
      throw new Error(
        "PgvectorBackend composition must expose the EvidenceStore capability this driver drives"
      );
    }
    evidence = backend;
  }, 120_000);

  afterAll(async () => {
    try {
      await driver.dropOwnSchema(admin);
    } finally {
      await backend?.close();
      await admin?.end();
    }
  });

  for (const entry of CASES) {
    it(`${entry.id} ${entry.scenario} — owner ${entry.owner}`, async () => {
      warnNotRun(entry.notRun);
      const runnable = RUNNABLE_CLAIMS[entry.id];
      if (runnable !== undefined) {
        await runnable();
      }
      requireFullyRunnable(entry.notRun);
    });
  }

  it("carries the complete E1–E15 map with an owner, a real boundary, an expected-result source and a cleanup contract per case", () => {
    for (const entry of CASES) {
      expect(entry.owner, `${entry.id} has no owning ticket`).not.toBe("");
      expect(
        entry.scenarioSource,
        `${entry.id} has no scenario source`
      ).not.toBe("");
      expect(entry.boundary, `${entry.id} has no real boundary`).not.toBe("");
      expect(
        entry.expectedSource,
        `${entry.id} has no expected-result source`
      ).not.toBe("");
      expect(entry.cleanup, `${entry.id} has no cleanup contract`).not.toBe("");
      expect(
        entry.notRun.entries.length,
        `${entry.id} has no named absent claim`
      ).toBeGreaterThan(0);
      for (const claim of entry.notRun.entries) {
        expect(
          claim.owner,
          `${entry.id} ${claim.claim} has no owning ticket`
        ).not.toBe("");
        expect(
          claim.reason,
          `${entry.id} ${claim.claim} has no reason`
        ).not.toBe("");
      }
    }
    expect(CASE_IDS).toEqual([
      "E1",
      "E2",
      "E3",
      "E4",
      "E5",
      "E6",
      "E7",
      "E8",
      "E9",
      "E10",
      "E11",
      "E12",
      "E13",
      "E14",
      "E15",
    ]);
  });
});
