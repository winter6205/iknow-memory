/**
 * T14 EP4 — a row grant's `supports` request reaches the continuation through the
 * private Evidence read.
 *
 * The dispatch layer is where the selector stops being a request field and starts
 * being a decision, and nothing else in the tree covered that: the action layer is
 * proven in `evidence-continuation-transaction.test.ts` and against real
 * PostgreSQL in `evidence-continuation-pg.test.ts`, while this file proves the two
 * are actually joined — that a listed selector is forwarded rather than dropped,
 * that both the grant facts and the pinned extraction links are read on the scope's
 * own client inside the scope's own BEGIN, and that every fault below the seam
 * still leaves as a typed refusal with a code from the closed evidence set.
 *
 * It runs on a recording seam rather than a database for the same reason the frozen
 * transaction suite does: the properties here are which statements are issued, in
 * which bracket, and which token a refusal carries.
 */
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_ACTION,
  EVIDENCE_REFUSAL_REASON,
  EvidenceRefusalError,
  parseEvidenceRequest,
  readPrivateEvidence,
  type EvidenceEnvelope,
  type EvidenceRefusalReason,
  type EvidenceScope,
  type EvidenceSupportsRequest,
  type EvidenceSupportsResult,
} from "../../src/core/storage/evidence-read.js";
import { SUPPORT_CONTRACT_VIOLATION } from "../../src/core/storage/evidence-continuation.js";
import { MAX_EVIDENCE_BYTES } from "../../src/core/storage/evidence-store.js";
import {
  mintAuthorizedScopeContext,
  StructuredScopeError,
  type AuthorizedScopeContext,
  type AuthorizedScopeContextInput,
  type AuthorizedScopeWork,
} from "../../src/core/storage/structured-scope-types.js";
import {
  EVIDENCE_DENIAL_REASON,
  EVIDENCE_FAILURE,
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
} from "../../src/core/types.js";

const GRANT_REF = "ref-supports-dispatch";
const SCOPE = "scope-supports-dispatch";
const QUERIED_AT = "2026-03-01T12:00:00.000Z";
const EXPIRES_AT = "2027-03-01T12:00:00.000Z";
const AT = "2026-10-06T00:00:00.000Z";
const SOURCE_REF = "source-supports-dispatch";
const DEADLINE_AT = "2026-10-06T00:10:00.000Z";
const SUPPORT_COUNT = 11;
const PAGE_SIZE = 8;

const CLOSED_FAILURE_CODES: readonly string[] = Object.values(EVIDENCE_FAILURE);
const CLOSED_REASONS: readonly string[] = [
  ...Object.values(EVIDENCE_DENIAL_REASON),
  ...Object.values(EVIDENCE_REFUSAL_REASON),
];

function supportId(index: number): string {
  return `00000000-0000-4000-9000-${index.toString().padStart(12, "0")}`;
}

/** The one-based ordinal a support id names, so a row can be checked against itself. */
function supportIdIndex(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

function supportRow(index: number): Record<string, unknown> {
  return {
    support_id: supportId(index),
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    result_id: "result-supports-dispatch",
    source_ref: SOURCE_REF,
    source_version: "v1",
    source_version_id: "11111111-1111-4111-8111-111111111111",
    document_id: `doc-supports-dispatch-${index}`,
    unit_version: "frozen-v1",
    unit: index,
    // Half the membership carries a span and half spells it absent, so a first
    // page that mixes the two is the one place both arms of `spanOfColumns` are
    // observable at once.
    span_start: index % 2 === 1 ? -1 : index * 10,
    span_end: index % 2 === 1 ? -1 : index * 10 + 4,
    created_at: "2026-02-01T00:00:00.000Z",
  };
}

function grantRow(): Record<string, unknown> {
  return {
    evidence_ref: GRANT_REF,
    grant_kind: EVIDENCE_GRANT_KIND.ROW,
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    operation: "entity",
    query_digest: "query-supports-dispatch",
    scope_binding: SCOPE,
    read_revision: "read-1",
    authorization_revision: "auth-1",
    purge_revision: "purge-1",
    queried_at: QUERIED_AT,
    expires_at: EXPIRES_AT,
    context: { coverage: "stored_structured_subjects" },
    value: { entity_id: "result-supports-dispatch" },
    result_count: null,
    authorization_receipt_id: null,
  };
}

interface RecordingClient {
  readonly statements: string[];
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

function recordingClient(
  supportCount = SUPPORT_COUNT,
  extractionRef: (index: number) => string = (index) => `extraction-${index + 1}`
): RecordingClient {
  const statements: string[] = [];
  const rows = (sql: string): { rows: unknown[] } => {
    if (sql.includes("FROM evidence_grants")) return { rows: [grantRow()] };
    if (sql.includes("FROM evidence_scope_revisions")) {
      return {
        rows: [
          {
            scope_binding: SCOPE,
            authorization_revision: "auth-1",
            purge_revision: "purge-1",
          },
        ],
      };
    }
    if (sql.includes("count(*)::int")) {
      return { rows: [{ total: supportCount }] };
    }
    if (sql.includes("FROM evidence_grant_supports g")) {
      return {
        rows: Array.from({ length: supportCount }, (_, index) => ({
          ...supportRow(index + 1),
          role:
            index === supportCount - 1
              ? EVIDENCE_SUPPORT_ROLE.ENDPOINT_DISPLAY
              : EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
          obligations_stopped_at: null,
        })),
      };
    }
    if (sql.includes("FROM evidence_grant_extractions")) {
      return {
        rows: Array.from({ length: supportCount }, (_, index) => ({
          support_id: supportId(index + 1),
          extraction_ref: extractionRef(index),
        })),
      };
    }
    return { rows: [] };
  };
  return {
    statements,
    async query(sql: string) {
      statements.push(sql);
      return sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK"
        ? { rows: [] }
        : rows(sql);
    },
    release() {
      statements.push("RELEASE");
    },
  };
}

function contextInput(
  patch: Partial<AuthorizedScopeContextInput> = {}
): AuthorizedScopeContextInput {
  return {
    actorId: "actor-supports-dispatch",
    ownerScopeBinding: SCOPE,
    readerBinding: "reader-supports-dispatch",
    authorizedSourceRefs: [SOURCE_REF],
    authorizationRevision: "auth-1",
    deadlineAt: DEADLINE_AT,
    ...patch,
  };
}

/**
 * A seam that owns one transaction, exactly as the PostgreSQL unit of work does.
 *
 * The BEGIN, the COMMIT and the release are issued here and nowhere else, so a
 * statement list that shows a second bracket inside one run is a dispatch path
 * that opened a transaction of its own.
 */
function recordingScope(client: RecordingClient): EvidenceScope {
  const authority: EvidenceScope = {
    createAuthorizedContext(input: AuthorizedScopeContextInput) {
      return mintAuthorizedScopeContext(input, authority);
    },
    async withAuthorizedScope<R>(
      _context: AuthorizedScopeContext,
      callback: (work: AuthorizedScopeWork) => Promise<R>
    ): Promise<R> {
      await client.query("BEGIN");
      try {
        const value = await callback({
          client,
        } as unknown as AuthorizedScopeWork);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return authority;
}

function supportsRequest(
  patch: Partial<Omit<EvidenceSupportsRequest, "action" | "evidence_ref">> = {}
): EvidenceSupportsRequest {
  return parseEvidenceRequest({
    schema: "iknow.evidence_request",
    schema_version: 1,
    action: EVIDENCE_ACTION.SUPPORTS,
    evidence_ref: GRANT_REF,
    ...patch,
  }) as EvidenceSupportsRequest;
}

/**
 * The seam a caller of this module can observe.
 *
 * `client` is a parameter rather than an internal detail so that a case which
 * asserts on which statements were issued passes the very client the dispatch
 * runs against. A seam constructed here and dropped into a helper that builds
 * its own is a seam nothing is ever read from, and its statement list stays
 * empty no matter what the dispatch does.
 */
async function dispatch(
  request: EvidenceSupportsRequest,
  input: AuthorizedScopeContextInput = contextInput(),
  extractionRef?: (index: number) => string,
  client: RecordingClient = recordingClient(SUPPORT_COUNT, extractionRef)
): Promise<{
  readonly envelope: EvidenceEnvelope;
  readonly client: RecordingClient;
}> {
  const scope = recordingScope(client);
  const envelope = await readPrivateEvidence(
    scope,
    scope.createAuthorizedContext(input),
    request,
    AT
  );
  return { envelope, client };
}

/** The refusal a request earns, and the client the dispatch actually ran on. */
async function refusalOf(
  request: EvidenceSupportsRequest,
  input?: AuthorizedScopeContextInput,
  client?: RecordingClient
): Promise<{ readonly refused: EvidenceRefusalError; readonly client: RecordingClient }> {
  const observed = client ?? recordingClient(SUPPORT_COUNT);
  try {
    await dispatch(request, input, undefined, observed);
  } catch (error) {
    return { refused: error as EvidenceRefusalError, client: observed };
  }
  throw new Error("the dispatch granted a request this lane expects to be refused");
}

describe("T14 EP4 supports dispatch: the selector reaches the continuation", () => {
  it("grants a first page when the request names neither selector", async () => {
    const { envelope } = await dispatch(supportsRequest());
    const page = envelope as EvidenceSupportsResult;
    expect(page.schema).toBe("iknow.evidence_result");
    expect(page.evidence_ref).toBe(GRANT_REF);
    expect(page.expires_at).toBe(EXPIRES_AT);
    expect(page.total_supports).toBe(SUPPORT_COUNT);
    expect(page.supports.map((entry) => entry.support_id)).toEqual(
      Array.from({ length: PAGE_SIZE }, (_, index) => supportId(index + 1))
    );
    expect(page.selected).toBe(false);
    expect(page.next_cursor).not.toBeNull();
    expect(page.supports.map((entry) => entry.extraction_refs)).toEqual(
      Array.from({ length: PAGE_SIZE }, (_, index) => [`extraction-${index + 1}`])
    );
  });

  it("grants the page a cursor names, and the cursor is the one the first page minted", async () => {
    const first = (await dispatch(supportsRequest())).envelope as EvidenceSupportsResult;
    const { envelope } = await dispatch(
      supportsRequest({ cursor: first.next_cursor })
    );
    const page = envelope as EvidenceSupportsResult;
    expect(page.supports.map((entry) => entry.support_id)).toEqual(
      Array.from(
        { length: SUPPORT_COUNT - PAGE_SIZE },
        (_, index) => supportId(index + PAGE_SIZE + 1)
      )
    );
    expect(page.next_cursor).toBeNull();
    expect(page.selected).toBe(false);
  });

  it("grants one named support, from anywhere in the pinned membership", async () => {
    // The eleventh support is past the first page's prefix, so a selector that
    // only searched the page it would have returned could not find it.
    const { envelope } = await dispatch(
      supportsRequest({ support_id: supportId(SUPPORT_COUNT) })
    );
    const page = envelope as EvidenceSupportsResult;
    expect(page.selected).toBe(true);
    expect(page.supports.map((entry) => entry.support_id)).toEqual([
      supportId(SUPPORT_COUNT),
    ]);
    expect(page.next_cursor).toBeNull();
    expect(page.total_supports).toBe(SUPPORT_COUNT);
  });

  it("carries the support's own descriptor onto the wire, field by field", async () => {
    // `renderSupports` passes `page.supports` through whole and copies nothing, so
    // the only thing this file can prove about a descriptor is that each member
    // came off the row the membership statement returned. The fixture is built to
    // make a swap detectable: the roles differ (support 11 is the endpoint
    // display, 1-10 are occurrences) and the spans differ (odd supports spell the
    // span absent, even ones carry one), so a role or a span landing on the wrong
    // row -- or a descriptor rebuilt from the wrong row entirely -- shows up here
    // instead of on a caller's wire.
    const { envelope } = await dispatch(supportsRequest());
    const page = envelope as EvidenceSupportsResult;
    // The endpoint display is the eleventh support and the page is eight wide, so
    // the role that is not an occurrence is only reachable on a second envelope.
    // Checking the first page alone would never see it, and a `role` rebuilt from
    // the count rather than from the row would pass this case.
    const selected = (await dispatch(
      supportsRequest({ support_id: supportId(SUPPORT_COUNT) })
    )).envelope as EvidenceSupportsResult;
    const everyEntry = [...page.supports, ...selected.supports];
    expect(everyEntry).toHaveLength(PAGE_SIZE + 1);
    for (const entry of everyEntry) {
      const ordinal = supportIdIndex(entry.support_id);
      expect(entry.role, `support ${ordinal} role`).toBe(
        ordinal === SUPPORT_COUNT
          ? EVIDENCE_SUPPORT_ROLE.ENDPOINT_DISPLAY
          : EVIDENCE_SUPPORT_ROLE.OCCURRENCE
      );
      expect(entry.subject, `support ${ordinal} subject`).toBe(
        EVIDENCE_SUBJECT_KIND.ENTITY
      );
      expect(entry.result_id, `support ${ordinal} result_id`).toBe(
        "result-supports-dispatch"
      );
      expect(entry.source_ref, `support ${ordinal} source_ref`).toBe(SOURCE_REF);
      expect(entry.source_version, `support ${ordinal} source_version`).toBe("v1");
      expect(entry.source_version_id, `support ${ordinal} source_version_id`).toBe(
        "11111111-1111-4111-8111-111111111111"
      );
      expect(entry.location, `support ${ordinal} location`).toEqual({
        document_id: `doc-supports-dispatch-${ordinal}`,
        version: "frozen-v1",
        unit: ordinal,
      });
      // The absent span is spelled `null` on the wire, not as a half-open range
      // of -1..-1 and not omitted -- a caller cannot tell an absent span from a
      // zero-length one otherwise.
      expect(entry.span, `support ${ordinal} span`).toEqual(
        ordinal % 2 === 1
          ? null
          : { start: ordinal * 10, end: ordinal * 10 + 4 }
      );
    }
  });

  it("emits the endpoint display's role even when it is not the page's last member", async () => {
    // The page is eight supports wide and the endpoint display is the eleventh,
    // so the role that distinguishes an endpoint from an occurrence crosses the
    // page boundary here. A page built from the count rather than from the roles
    // would not carry it, and this case is the one that notices.
    const { envelope } = await dispatch(supportsRequest());
    const page = envelope as EvidenceSupportsResult;
    expect(page.supports.map((entry) => entry.role)).toEqual(
      Array.from({ length: PAGE_SIZE }, () => EVIDENCE_SUPPORT_ROLE.OCCURRENCE)
    );
    const last = (await dispatch(
      supportsRequest({ support_id: supportId(SUPPORT_COUNT) })
    )).envelope as EvidenceSupportsResult;
    expect(last.supports[0]?.role).toBe(EVIDENCE_SUPPORT_ROLE.ENDPOINT_DISPLAY);
  });

  it("reads a null and an empty selector as the same 'no selector' the absent one is", async () => {
    // `optionalSelector` has three returns -- `undefined`, `null` and the string --
    // and only the first two are "none" here. Both halves are pinned, because
    // neither is observable from the other:
    //
    //   * the three returns are pinned on the parsed request, which is the only
    //     place they differ. A `null` arm rewritten to return `""` still reaches
    //     the continuation as "absent", so the dispatch arm below cannot see it.
    //   * the fold that makes `null` and `""` and absent all answer with a first
    //     page is pinned on the envelope, which is the only place a fold that
    //     stopped treating a blank selector as absent would be visible.
    const absent = supportsRequest();
    expect(absent.cursor).toBeUndefined();
    expect(absent.support_id).toBeUndefined();
    const nulled = supportsRequest({ cursor: null, support_id: null });
    expect(nulled.cursor).toBeNull();
    expect(nulled.support_id).toBeNull();
    const blank = supportsRequest({ cursor: "", support_id: "" });
    expect(blank.cursor).toBe("");
    expect(blank.support_id).toBe("");

    for (const spelled of [null, ""]) {
      const { envelope } = await dispatch(supportsRequest({ cursor: spelled }));
      const page = envelope as EvidenceSupportsResult;
      expect(page.selected, `cursor ${JSON.stringify(spelled)}`).toBe(false);
      expect(page.supports.map((entry) => entry.support_id), "first page").toEqual(
        Array.from({ length: PAGE_SIZE }, (_, index) => supportId(index + 1))
      );
      expect(page.next_cursor, "a blank selector is not a position").not.toBeNull();
    }
    // The same holds for the other selector, and for a request that names one
    // blank and one real: only the real one is ever read.
    for (const spelled of [null, ""]) {
      const support = (await dispatch(
        supportsRequest({ support_id: spelled as string | null })
      )).envelope as EvidenceSupportsResult;
      expect(support.selected, `support_id ${JSON.stringify(spelled)}`).toBe(false);
    }
    const selected = (await dispatch(
      supportsRequest({ cursor: null, support_id: supportId(SUPPORT_COUNT) })
    )).envelope as EvidenceSupportsResult;
    expect(selected.selected).toBe(true);
    expect(selected.supports.map((entry) => entry.support_id)).toEqual([
      supportId(SUPPORT_COUNT),
    ]);
  });

  it("refuses a request carrying both selectors, and reads no extraction link for it", async () => {
    const first = (await dispatch(supportsRequest())).envelope as EvidenceSupportsResult;
    // EXIT: the selector pair is refused by the continuation, which `readPrivateEvidence`
    // calls *after* `readGrantFacts` has already run -- so this build's own order is
    // grant-then-continuation, and this test pins what that order actually does rather
    // than the grant-first wording the earlier revision of this case claimed.
    //
    // What the refusal does withhold is the membership: the continuation returns before
    // `selectPage` runs, so the pinned supports are never read even though the grant row
    // and its scope revisions were. The statement list below is the client the dispatch
    // really ran against, so an implementation that resolved the page before refusing
    // would leave `evidence_grant_supports` in it and fail here.
    const client = recordingClient();
    const { refused } = await refusalOf(
      supportsRequest({ cursor: first.next_cursor, support_id: supportId(1) }),
      undefined,
      client
    );
    expect(refused).toBeInstanceOf(EvidenceRefusalError);
    expect(refused.code).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
    expect(refused.message).toContain("mutually exclusive");
    expect(refused.message).not.toContain(SOURCE_REF);
    // The grant facts are read first, so this is not an "before any read" claim --
    // that correction is the whole reason the case is renamed.
    expect(
      client.statements.filter((sql) => sql.includes("FROM evidence_grants"))
    ).not.toEqual([]);
    // What the refusal does withhold is the extraction links: `resolveSelectors`
    // answers before `selectPage` and before the page's own reader is ever called,
    // so no page -- not even a partial one -- is assembled from the membership.
    // A continuation that resolved the page first and refused afterwards would
    // leave `evidence_grant_extractions` in this list and fail here.
    expect(
      client.statements.filter((sql) => sql.includes("FROM evidence_grant_extractions"))
    ).toEqual([]);
  });

  it("reads the grant, the membership and the extraction links on the scope's own client", async () => {
    const { client } = await dispatch(supportsRequest());
    // EXIT: one bracket, opened and closed by the seam. A dispatch that leased a
    // second connection would issue its own BEGIN/COMMIT/RELEASE inside this one.
    expect(
      client.statements.filter(
        (sql) => sql === "BEGIN" || sql === "COMMIT" || sql === "RELEASE"
      )
    ).toEqual(["BEGIN", "COMMIT", "RELEASE"]);
    const between = client.statements.slice(1, -2);
    const tables = [
      "FROM evidence_grants",
      "FROM evidence_scope_revisions",
      "FROM evidence_grant_supports g",
      "FROM evidence_grant_extractions",
    ];
    const seen: number[] = [];
    for (const table of tables) {
      const index = between.findIndex((sql) => sql.includes(table));
      expect(index, `no statement read ${table} inside the transaction`).toBeGreaterThanOrEqual(0);
      seen.push(index);
    }
    expect(seen).toEqual([...seen].sort((left, right) => left - right));
  });

  it("never emits the supports-not-read refusal, and answers each request as listed", async () => {
    const first = (await dispatch(supportsRequest())).envelope as EvidenceSupportsResult;
    const cases: readonly {
      readonly label: string;
      readonly request: EvidenceSupportsRequest;
      readonly reason: EvidenceRefusalReason | null;
    }[] = [
      { label: "no selector", request: supportsRequest(), reason: null },
      {
        label: "the cursor the first page minted",
        request: supportsRequest({ cursor: first.next_cursor }),
        reason: null,
      },
      {
        label: "the first support",
        request: supportsRequest({ support_id: supportId(1) }),
        reason: null,
      },
      {
        label: "the last support",
        request: supportsRequest({ support_id: supportId(SUPPORT_COUNT) }),
        reason: null,
      },
      {
        label: "a cursor this build did not mint",
        request: supportsRequest({ cursor: "not-a-cursor-this-build-mints" }),
        reason: EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      },
      {
        label: "a selector that is not a uuid",
        request: supportsRequest({ support_id: "not-a-uuid" }),
        reason: EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      },
      {
        label: "a support of another grant",
        request: supportsRequest({ support_id: "99999999-9999-4999-8999-999999999999" }),
        reason: EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      },
      {
        label: "both selectors at once",
        request: supportsRequest({ cursor: first.next_cursor, support_id: supportId(1) }),
        reason: EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      },
    ];
    for (const { label, request, reason } of cases) {
      let refused: EvidenceRefusalError | undefined;
      try {
        await dispatch(request);
      } catch (error) {
        refused = error as EvidenceRefusalError;
        expect(refused, label).toBeInstanceOf(EvidenceRefusalError);
        expect(CLOSED_FAILURE_CODES, label).toContain(refused.code);
      }
      if (reason === null) {
        expect(refused, `${label} was refused`).toBeUndefined();
        continue;
      }
      expect(refused?.reason, label).toBe(reason);
      expect(CLOSED_REASONS, label).toContain(refused?.reason);
      expect(refused?.reason).not.toBe(
        EVIDENCE_REFUSAL_REASON.SUPPORTS_CONTINUATION_NOT_READ
      );
    }
  });

  it("tells the three folded contract faults apart locally, on one wire token", async () => {
    const first = (await dispatch(supportsRequest())).envelope as EvidenceSupportsResult;
    const faults: readonly {
      readonly label: string;
      readonly request: EvidenceSupportsRequest;
      readonly contract: string;
    }[] = [
      {
        label: "a selector that is not a uuid",
        request: supportsRequest({ support_id: "not-a-uuid" }),
        contract: SUPPORT_CONTRACT_VIOLATION.SELECTOR_NOT_UUID,
      },
      {
        label: "two selectors at once",
        request: supportsRequest({ cursor: first.next_cursor, support_id: supportId(1) }),
        contract: SUPPORT_CONTRACT_VIOLATION.SELECTORS_MUTUALLY_EXCLUSIVE,
      },
      {
        label: "a selector outside the grant",
        request: supportsRequest({ support_id: "99999999-9999-4999-8999-999999999999" }),
        contract: SUPPORT_CONTRACT_VIOLATION.SELECTOR_NOT_A_MEMBER,
      },
    ];
    const seen = new Set<string>();
    for (const { label, request, contract } of faults) {
      const { refused } = await refusalOf(request);
      // The published token is one, and stays one: the frozen set is not widened
      // to separate these three.
      expect(refused.reason, label).toBe(EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD);
      expect(refused.contract, label).toBe(contract);
      seen.add(String(refused.contract));
    }
    expect(seen.size).toBe(faults.length);
  });

  it("bounds the envelope it emits, which is wider than the continuation's own bound", async () => {
    // EXIT: the continuation measures its granted payload, which carries an
    // internal `state` where the emitted envelope carries the wire schema and
    // version. The two bounds therefore differ by a constant, and there is a band
    // of pages that fit the continuation and still overrun the emitted envelope.
    // That band is the whole reach of this arm's own check, so it is measured here
    // rather than asserted: a filler one byte shorter must be granted, and the
    // refusal above it must name this arm's message, not the continuation's.
    const outcomeAt = async (
      filler: number
    ): Promise<
      | { readonly kind: "granted"; readonly bytes: number }
      | {
          readonly kind: "refused";
          readonly reason: EvidenceRefusalReason;
          readonly contract: string | undefined;
          readonly message: string;
        }
    > => {
      try {
        const { envelope } = await dispatch(
          supportsRequest(),
          contextInput(),
          (index) => (index === 0 ? "f".repeat(filler) : `extraction-${index + 1}`)
        );
        return { kind: "granted", bytes: Buffer.byteLength(JSON.stringify(envelope), "utf8") };
      } catch (error) {
        const refused = error as EvidenceRefusalError;
        return {
          kind: "refused",
          reason: refused.reason,
          contract: refused.contract,
          message: refused.message,
        };
      }
    };
    const dispatchOwns = (
      outcome: Awaited<ReturnType<typeof outcomeAt>>
    ): boolean =>
      outcome.kind === "refused" &&
      outcome.reason === EVIDENCE_REFUSAL_REASON.ENVELOPE_TOO_LARGE &&
      outcome.contract === undefined;
    let low = 0;
    let high = MAX_EVIDENCE_BYTES * 2;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((await outcomeAt(middle)).kind === "granted") low = middle + 1;
      else high = middle;
    }
    const lastGranted = low - 1;
    low = 0;
    high = lastGranted + 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (dispatchOwns(await outcomeAt(middle))) high = middle;
      else low = middle + 1;
    }
    const lastGrantedPage = await outcomeAt(lastGranted);
    const firstRefused = await outcomeAt(low);
    expect(lastGrantedPage.kind).toBe("granted");
    expect(
      (lastGrantedPage as { bytes: number }).bytes
    ).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
    expect(dispatchOwns(firstRefused)).toBe(true);
    expect(firstRefused.message).toContain("emitted support page");
    // Past the band the continuation's own measure is the one that refuses, and it
    // says so on the same folded token.
    let overLow = low;
    let overHigh = MAX_EVIDENCE_BYTES * 2;
    while (overLow < overHigh) {
      const middle = Math.floor((overLow + overHigh) / 2);
      const probe = await outcomeAt(middle);
      if (
        probe.kind === "refused" &&
        probe.contract === SUPPORT_CONTRACT_VIOLATION.ENVELOPE
      ) {
        overHigh = middle;
      } else {
        overLow = middle + 1;
      }
    }
    const overPage = await outcomeAt(overLow);
    expect(overPage.kind).toBe("refused");
    expect(
      overPage.kind === "refused" ? overPage.contract : undefined
    ).toBe(SUPPORT_CONTRACT_VIOLATION.ENVELOPE);
    expect(overPage.message).toContain("continuation page serializes to");
  });

  it("refuses a non-uuid support_id with an in-set code instead of throwing", async () => {
    const { refused } = await refusalOf(supportsRequest({ support_id: "not-a-uuid" }));
    expect(refused).toBeInstanceOf(EvidenceRefusalError);
    expect(refused.code).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
    expect(CLOSED_REASONS).toContain(refused.reason);
    expect(refused.message).toContain("uuid");
  });

  it("refuses a selector that is not text at the request contract", async () => {
    for (const forged of [{ cursor: 7 }, { support_id: { id: supportId(1) } }, { cursor: [] }]) {
      try {
        parseEvidenceRequest({
          schema: "iknow.evidence_request",
          schema_version: 1,
          action: EVIDENCE_ACTION.SUPPORTS,
          evidence_ref: GRANT_REF,
          ...forged,
        });
        expect.unreachable();
      } catch (error) {
        const refused = error as EvidenceRefusalError;
        expect(refused).toBeInstanceOf(EvidenceRefusalError);
        expect(refused.code).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
        expect(refused.reason).toBe(EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD);
        // EXIT: the continuation reads a selector as text, so a selector that is
        // not text has to be refused here or it leaves its entry point instead.
        expect(refused.message).toContain("must be a string when it is present");
      }
    }
  });

  it("cannot be handed an unbound caller, because the seam refuses to mint one", async () => {
    // EXIT: the continuation's blank-binding arm is a second line of defence here
    // rather than a live path: the scope that mints this layer's caller refuses to
    // mint a blank binding, and the request channel cannot name one at all.
    const scope = recordingScope(recordingClient());
    for (const forged of ["", "   "]) {
      expect(() =>
        scope.createAuthorizedContext(contextInput({ ownerScopeBinding: forged }))
      ).toThrowError(StructuredScopeError);
    }
    expect(() =>
      parseEvidenceRequest({
        schema: "iknow.evidence_request",
        schema_version: 1,
        action: EVIDENCE_ACTION.SUPPORTS,
        evidence_ref: GRANT_REF,
        caller: { scopeBinding: "" },
        scope_binding: SCOPE,
        actor_id: "forged",
      })
    ).toThrowError(/accepts only/);
  });

  it("still refuses an identity the caller's authorized subset does not cover", async () => {
    const { refused } = await refusalOf(
      supportsRequest(),
      contextInput({ authorizedSourceRefs: ["another-source"] })
    );
    expect(refused.code).toBe(EVIDENCE_FAILURE.ACCESS_DENIED);
    expect(refused.reason).toBe(EVIDENCE_REFUSAL_REASON.SOURCE_OUTSIDE_AUTHORIZED_SUBSET);
    expect(refused.message).not.toContain(SOURCE_REF);
  });
});