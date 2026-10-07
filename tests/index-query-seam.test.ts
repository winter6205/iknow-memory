/**
 * The Query seam in `src/index.ts`: who it mints for, what it cites, and what
 * it refuses.
 *
 * Written against the seam's own contract rather than against the storage
 * layer's, with the reader a stand-in and the grant store a recorder. The
 * properties under test are the three that live in the seam and nowhere else:
 *
 *   - a returned row is cited by a reference the evidence store minted FOR THAT
 *     ROW, rather than by a field this file could have filled in itself;
 *   - the missing-reference refusal comes from the storage projection, checked
 *     here through the CODE it raises rather than by proving the seam cannot
 *     hand-project on its own — a hand projection that refused with the same
 *     code would pass, so this is a contract on the refusal, not on the
 *     delegation;
 *   - two CONNECTIONS with two host-injected identities get two identities and
 *     cannot read each other's subjects, because B1 binds identity per
 *     connection with no process-level fallback;
 *   - a page's references are issued as one write, so a failure part way through
 *     leaves nothing committed, and an issuance failure leaves as a typed
 *     envelope rather than as prose.
 *
 * The first two are the H1/M3 defect and the third is M1; M2 (an absent count
 * coerced to a factual zero) is pinned here too, because the coercion lived in
 * the same three lines.
 *
 * Unit tier: no Postgres, no network, no child process. The real `issueGrantRows`
 * write path — a reference committing together with the dependencies it pins —
 * is proven separately against a cluster in
 * `tests/acceptance/structured-query-pg.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { buildStructuredQueryReader } from "../src/index.js";
import { StructuredQueryError } from "../src/core/structured/errors.js";
import type { ValidatedStructuredQuery } from "../src/core/structured/request.js";
import type {
  StructuredMaintenanceRecord,
  StructuredSupportRecord,
} from "../src/core/structured/result.js";
import type {
  StructuredQueryEntityRowPlan,
  StructuredQueryGrantPlan,
  StructuredQueryReadPlan,
  StructuredQueryStorage,
} from "../src/core/storage/structured-query-reads.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeContextInput,
  AuthorizedScopeUnitOfWork,
  ScopeTransactionOwner,
} from "../src/core/storage/structured-scope-types.js";
import type {
  EvidenceGrantRecord,
  EvidenceStore,
  GrantRequest,
  ScopeRevisionFence,
} from "../src/core/types.js";
import { normalizeGrantRequest } from "../src/core/storage/evidence-store.js";
import { structuredErrorEnvelope } from "../src/core/structured/errors.js";
import type { QueryScopeIdentity } from "../src/core/storage/structured-query-scope.js";

const OWNER_SCOPE = "scope-query-seam";
const READER = "reader-query-seam";
const SOURCE_REF = "docs/query-seam.md";
const AUTHORIZATION_REVISION = "auth-query-seam-1";
const ISSUANCE_FENCE: ScopeRevisionFence = Object.freeze({
  scope_binding: OWNER_SCOPE,
  authorization_revision: AUTHORIZATION_REVISION,
  purge_revision: "purge-query-seam-1",
});
const QUERIED_AT = "2026-02-03T04:05:06Z";
const READ_REVISION = "42";
const QUERY_DIGEST = "sha256:0f".padEnd(71, "a");

function uuid(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function support(ordinal: number): StructuredSupportRecord {
  return {
    supportId: uuid(ordinal),
    sourceRef: SOURCE_REF,
    sourceVersion: "v1",
    location: { documentId: `doc-${ordinal}`, version: "v1", unit: 1 },
    extractionRef: `extraction/${ordinal}`,
  };
}

/**
 * A summary whose two dimensions sum to `sourcesInScope`, which is the
 * producer's own consistency check — a plan whose receipt is malformed here
 * would fail a later stage than the one under test.
 */
const MAINTENANCE: StructuredMaintenanceRecord = {
  maintenanceRevision: "mrev-7",
  sourcesInScope: 1,
  publishedSources: 1,
  desiredIndex: { pending: 0, running: 0, ready: 1, failed: 0, stale: 0 },
  conflictChecks: { pending: 0, running: 0, ready: 1, failed: 0, stale: 0 },
  rulesetRevision: "rrev-3",
};

function entityRow(ordinal: number): StructuredQueryEntityRowPlan {
  return {
    subject: "entity",
    id: uuid(100 + ordinal),
    canonicalName: `Entity ${ordinal}`,
    type: "organization",
    displaySupportId: uuid(ordinal),
    displayDisagreement: false,
    supports: [support(ordinal)],
  };
}

/** The grant a row's citation is issued from — field-for-field the grant request. */
function rowGrant(row: StructuredQueryEntityRowPlan): StructuredQueryGrantPlan {
  return {
    kind: "row",
    subject: "entity",
    operation: "list",
    queryDigest: QUERY_DIGEST,
    scopeBinding: OWNER_SCOPE,
    readRevision: READ_REVISION,
    queriedAt: QUERIED_AT,
    context: {
      query_digest: QUERY_DIGEST,
      scope_binding: OWNER_SCOPE,
      read_revision: READ_REVISION,
    },
    value: { ...row },
    supports: row.supports.map((each) => ({
      support_id: each.supportId,
      role: "occurrence" as const,
    })),
    count: null,
  };
}

function listPlan(
  rows: readonly StructuredQueryEntityRowPlan[]
): StructuredQueryReadPlan {
  return {
    kind: "list",
    subject: "entity",
    operation: "list",
    queryDigest: QUERY_DIGEST,
    scopeBinding: OWNER_SCOPE,
    readerBinding: READER,
    authorizationRevision: AUTHORIZATION_REVISION,
    readRevision: READ_REVISION,
    issuanceFence: ISSUANCE_FENCE,
    queriedAt: QUERIED_AT,
    maintenance: MAINTENANCE,
    rows,
    nextCursor: null,
    count: null,
    grants: rows.map(rowGrant),
  };
}

function countPlan(count: number | null): StructuredQueryReadPlan {
  return {
    kind: "count",
    subject: "entity",
    operation: "count",
    queryDigest: QUERY_DIGEST,
    scopeBinding: OWNER_SCOPE,
    readerBinding: READER,
    authorizationRevision: AUTHORIZATION_REVISION,
    readRevision: READ_REVISION,
    issuanceFence: ISSUANCE_FENCE,
    queriedAt: QUERIED_AT,
    maintenance: MAINTENANCE,
    rows: [],
    nextCursor: null,
    count,
    grants: [
      {
        kind: "count",
        subject: "entity",
        operation: "count",
        queryDigest: QUERY_DIGEST,
        scopeBinding: OWNER_SCOPE,
        readRevision: READ_REVISION,
        queriedAt: QUERIED_AT,
        context: {
          query_digest: QUERY_DIGEST,
          scope_binding: OWNER_SCOPE,
          read_revision: READ_REVISION,
        },
        // The bounded receipt, not the membership: a count grant retains no ids.
        value: {
          subject: "entity",
          count,
          query_digest: QUERY_DIGEST,
          scope_binding: OWNER_SCOPE,
          read_revision: READ_REVISION,
        },
        supports: [],
        count,
      },
    ],
  };
}

const LIST: ValidatedStructuredQuery = {
  subject: "entity",
  operation: "list",
  filters: [],
  limit: 20,
} as ValidatedStructuredQuery;

const COUNT: ValidatedStructuredQuery = {
  subject: "entity",
  operation: "count",
  filters: [],
} as ValidatedStructuredQuery;

/**
 * An authority that records every mint and hands the reader back the identity it
 * was asked for. The transaction halves throw rather than pretend: this seam
 * must reach the store through `resolveQueryScope`'s mint, never by running a
 * transaction of its own.
 */
function recordingAuthority(): {
  readonly authority: AuthorizedScopeUnitOfWork & ScopeTransactionOwner;
  readonly minted: AuthorizedScopeContextInput[];
} {
  const minted: AuthorizedScopeContextInput[] = [];
  const unreachable = (): never => {
    throw new Error(
      "the seam reached a transaction instead of the injected reader"
    );
  };
  return {
    minted,
    authority: {
      createAuthorizedContext: (input) => {
        minted.push(input);
        return { ...input };
      },
      withAuthorizedScope: unreachable,
      runTransaction: unreachable,
    },
  };
}

/** A stand-in reader that records the context each call was handed. */
function recordingReader(plan: StructuredQueryReadPlan): {
  readonly reader: StructuredQueryStorage;
  readonly seen: AuthorizedScopeContext[];
} {
  const seen: AuthorizedScopeContext[] = [];
  return {
    seen,
    reader: {
      readStructuredQuery: async (context) => {
        seen.push(context);
        return plan;
      },
    },
  };
}

/** A grant store that validates each request and records what it minted. */
function recordingGrants(
  mint: (request: GrantRequest, ordinal: number) => string = (_r, ordinal) =>
    uuid(500 + ordinal)
): {
  readonly grants: Pick<EvidenceStore, "issueGrants">;
  readonly issued: GrantRequest[];
  readonly fences: (ScopeRevisionFence | undefined)[];
} {
  const issued: GrantRequest[] = [];
  const fences: (ScopeRevisionFence | undefined)[] = [];
  return {
    issued,
    fences,
    grants: {
      issueGrants: async (requests, expectedScopeRevisionFence) => {
        fences.push(expectedScopeRevisionFence);
        // `normalizeGrantRequest` FIRST, so this double enforces the same
        // arm-exclusivity the real store does. Without it the double accepted a
        // request no store would take, which is exactly how forwarding a count
        // grant's empty `supports` stayed green here while
        // `normalizeGrantRequest` refused it as `MALFORMED_CONTRACT` in
        // production.
        const plans = requests.map(normalizeGrantRequest);
        return plans.map((plan, ordinal) => {
          const request = requests[ordinal] as GrantRequest;
          const evidenceRef = mint(request, issued.length);
          issued.push(request);
          return {
            evidence_ref: evidenceRef,
            kind: plan.kind,
            subject: plan.subject,
            operation: plan.operation,
            query_digest: plan.query_digest,
            scope_binding: plan.scope_binding,
            read_revision: plan.read_revision,
            authorization_revision: AUTHORIZATION_REVISION,
            purge_revision: "purge-1",
            queried_at: plan.queried_at,
            expires_at: "2027-02-03T04:05:06Z",
            context: { ...plan.context },
            value: plan.value,
            result_count: plan.count,
            authorization_receipt_id: plan.kind === "count" ? uuid(900) : null,
          };
        });
      },
    },
  };
}

/**
 * A grant store whose page write refuses on the `failsAt`th request, having
 * already COMMITTED the ones before it unless it is asked to behave as a real
 * batch. Two modes, because the property under test is the difference:
 *
 *   - `atomic: true` — every request is proved before any is written, so a
 *     refusal leaves nothing behind (what both real backends do);
 *   - `atomic: false` — each request commits as it is reached, which is what
 *     looping `issueGrant` did and what the negative case below needs in order to
 *     show the assertion can fail.
 */
function throwingGrants(
  failsAt: number,
  atomic: boolean
): {
  readonly grants: Pick<EvidenceStore, "issueGrants">;
  readonly committed: string[];
} {
  const committed: string[] = [];
  return {
    committed,
    grants: {
      issueGrants: async (requests) => {
        if (atomic) {
          requests.forEach((_request, ordinal) => {
            if (ordinal === failsAt) {
              throw new Error(
                "row grant names support 00000000-0000-4000-8000-000000000009, " +
                  "whose source version stopped accepting obligations at 2026-02-03T04:05:06.000Z"
              );
            }
          });
          const refs = requests.map((_request, ordinal) => {
            const ref = uuid(500 + ordinal);
            committed.push(ref);
            return ref;
          });
          return refs.map((evidence_ref, ordinal) =>
            grantRecord(requests[ordinal] as GrantRequest, evidence_ref)
          );
        }
        const out: EvidenceGrantRecord[] = [];
        for (const [ordinal, request] of requests.entries()) {
          if (ordinal === failsAt) {
            throw new Error(
              "row grant names support 00000000-0000-4000-8000-000000000009, " +
                "whose source version stopped accepting obligations at 2026-02-03T04:05:06.000Z"
            );
          }
          const evidence_ref = uuid(500 + ordinal);
          committed.push(evidence_ref);
          out.push(grantRecord(request, evidence_ref));
        }
        return out;
      },
    },
  };
}

/** The stored shape a store answers one issued request with. */
function grantRecord(
  request: GrantRequest,
  evidence_ref: string
): EvidenceGrantRecord {
  return {
    evidence_ref,
    kind: request.kind,
    subject: request.subject,
    operation: request.operation,
    query_digest: request.queryDigest,
    scope_binding: request.scopeBinding,
    read_revision: request.readRevision,
    authorization_revision: AUTHORIZATION_REVISION,
    purge_revision: "purge-1",
    queried_at: request.queriedAt,
    expires_at: "2027-02-03T04:05:06Z",
    context: { ...request.context },
    value: request.value,
    result_count: request.kind === "count" ? request.count : null,
    authorization_receipt_id: request.kind === "count" ? uuid(900) : null,
  };
}

/** The six members of ONE connection's injected identity. */
function connectionIdentity(
  actorId: string,
  sourceRefs: string = SOURCE_REF
): QueryScopeIdentity {
  return {
    actorId,
    ownerScopeBinding: OWNER_SCOPE,
    readerBinding: READER,
    sourceRefs,
    authorizationRevision: AUTHORIZATION_REVISION,
    deadlineAt: "2099-01-01T00:00:00.000Z",
  };
}

/** Await the read and return the code it refused with. */
async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  return (await capturedStructuredError(run)).code;
}

/**
 * Await the read and return the refusal itself, message included.
 *
 * Split from `refusalCode` because a code alone cannot show WHAT was refused:
 * B1 requires the missing binding to be named, and `redactDiagnostic` would
 * rewrite nothing here — the message is what the operator reads.
 */
async function capturedStructuredError(
  run: () => Promise<unknown>
): Promise<StructuredQueryError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(StructuredQueryError);
    return error as StructuredQueryError;
  }
  throw new Error("expected the read to refuse, but it succeeded");
}

describe("the Query seam — issued evidence references (H1/M3)", () => {
  it("cites each returned row with the reference minted for that row", async () => {
    // The defect this pins: the merged base injected `evidenceRef: ""` on every
    // row, so the producer's `readEvidenceRef` refused and only a ZERO-ROW list
    // could succeed. A row the seam returns is therefore a row someone can cite.
    const rows = [entityRow(1), entityRow(2)];
    const { authority } = recordingAuthority();
    const { reader } = recordingReader(listPlan(rows));
    const { grants, issued, fences } = recordingGrants();

    const outcome = await buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a")
    ).readStructuredQuery(LIST);

    expect(outcome.kind).toBe("list");
    if (outcome.kind !== "list") throw new Error("expected a list");
    expect(issued).toHaveLength(rows.length);
    expect(fences).toEqual([ISSUANCE_FENCE]);
    expect(outcome.rows.map((row) => row.evidenceRef)).toEqual([
      uuid(500),
      uuid(501),
    ]);
    // The page's own context reference stands in for the page, and it is the
    // FIRST ROW's minted reference — not a value this file supplied.
    expect(outcome.context.evidenceRef).toBe(uuid(500));
  });

  it("issues the count receipt's grant so a count carries a real reference", async () => {
    // The other half of the same defect: count was non-functional even after the
    // row path was wired, because the seam never filled its reference.
    const { authority } = recordingAuthority();
    const { reader } = recordingReader(countPlan(7));
    const { grants, issued } = recordingGrants();

    const outcome = await buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a")
    ).readStructuredQuery(COUNT);

    expect(outcome.kind).toBe("count");
    if (outcome.kind !== "count") throw new Error("expected a count");
    expect(issued).toHaveLength(1);
    expect(issued[0]?.kind).toBe("count");
    // The MIRROR of the row arm's dropped count: a count grant retains no
    // membership, and `normalizeGrantRequest` refuses one that names supports as
    // `MALFORMED_CONTRACT`. The plan carries an empty support set on every
    // grant, so forwarding it is a live way to hand the store a request it will
    // not take — and the recording double now runs that same normalizer, so
    // dropping this assertion would let the drop pass again.
    expect(issued[0]).not.toHaveProperty("supports");
    expect(issued[0]?.count).toBe(7);
    expect(outcome.count).toBe(7);
    expect(outcome.context.evidenceRef).toBe(uuid(500));
  });

  it("keeps a zero count as a counted fact rather than a missing one", async () => {
    // Zero and absent are different facts. `count ?? 0` made them the same
    // value, so a count that measured nothing and a count nobody took both read
    // as "there is nothing here".
    const { authority } = recordingAuthority();
    const { reader } = recordingReader(countPlan(0));
    const { grants, issued } = recordingGrants();

    const outcome = await buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a")
    ).readStructuredQuery(COUNT);

    expect(outcome.kind).toBe("count");
    if (outcome.kind !== "count") throw new Error("expected a count");
    expect(outcome.count).toBe(0);
    expect(issued[0]?.kind).toBe("count");
  });

  it("refuses an empty page whose issuance fence names another scope", async () => {
    const { authority } = recordingAuthority();
    const { reader } = recordingReader({
      ...listPlan([]),
      issuanceFence: Object.freeze({
        ...ISSUANCE_FENCE,
        scope_binding: "another-scope",
      }),
    });
    const { grants, issued, fences } = recordingGrants();

    const error = await capturedStructuredError(() =>
      buildStructuredQueryReader(
        authority,
        grants,
        reader,
        connectionIdentity("session-a")
      ).readStructuredQuery(LIST)
    );

    expect(error.code).toBe("structured_search_unavailable");
    expect(fences).toHaveLength(0);
    expect(issued).toHaveLength(0);
  });

  it("refuses an empty page when its read plan has no issuance fence", async () => {
    const { authority } = recordingAuthority();
    const malformedPlan = {
      ...listPlan([]),
    } as Partial<StructuredQueryReadPlan>;
    delete malformedPlan.issuanceFence;
    const { reader } = recordingReader(
      malformedPlan as StructuredQueryReadPlan
    );
    const { grants, issued, fences } = recordingGrants();

    const error = await capturedStructuredError(() =>
      buildStructuredQueryReader(
        authority,
        grants,
        reader,
        connectionIdentity("session-a")
      ).readStructuredQuery(LIST)
    );

    expect(error.code).toBe("structured_search_unavailable");
    expect(fences).toHaveLength(0);
    expect(issued).toHaveLength(0);
  });

  it("mints a reference only for the authorized row this read returned", async () => {
    // spec/structured-corpus-evidence.md:147 — a model must never receive fields
    // derived solely from an unauthorized support. The reference is minted from
    // the plan's OWN row, so it cannot cite anything the read did not prove.
    const rows = [entityRow(1)];
    const { authority } = recordingAuthority();
    const { reader } = recordingReader(listPlan(rows));
    const { grants, issued } = recordingGrants();

    await buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a")
    ).readStructuredQuery(LIST);

    expect(issued[0]?.value).toEqual({ ...rows[0]! });
    expect(issued[0]?.scopeBinding).toBe(OWNER_SCOPE);
    expect(issued[0]?.kind).toBe("row");
    // The row arm names its dependencies and keeps no count: a grant that
    // retained both would be refused as a grant retaining what its kind may not.
    expect(issued[0]).not.toHaveProperty("count");
    expect(issued[0]?.kind === "row" ? issued[0].supports : []).toEqual([
      { support_id: uuid(1), role: "occurrence" },
    ]);
  });

  it("refuses through the storage projection when a reference was never issued", async () => {
    // M3: the seam used to hand-project, so the issuer-side `requireIssued` never
    // ran and safety rested on a producer-side length check. Here the store
    // returns nothing for the second row — a hand projection would emit it with
    // an empty reference and call the page a success.
    //
    // What this pins is the CODE, and that is deliberately weaker than a claim
    // about WHERE the refusal is raised: a hand projection that raised the same
    // code would pass. The delegation is pinned by observation instead — the
    // seam calls `structuredQueryReadOutcome` and nothing else builds the
    // outcome — which is a statement about the code, not a test.
    const rows = [entityRow(1), entityRow(2)];
    const { authority } = recordingAuthority();
    const { reader } = recordingReader(listPlan(rows));
    const { grants } = recordingGrants((_request, ordinal) =>
      ordinal === 1 ? "" : uuid(500 + ordinal)
    );

    const seam = buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a")
    );
    expect(await refusalCode(() => seam.readStructuredQuery(LIST))).toBe(
      "structured_search_unavailable"
    );
  });
});

describe("the Query seam — an absent count is never a zero (M2)", () => {
  it("refuses a count nobody measured instead of stating one", async () => {
    // `count: plan.count ?? 0` turned an absent count into a factual zero on a
    // receipt claiming `coverage: stored_structured_subjects`, dropping the
    // storage layer's own `count_unavailable` guard.
    const { authority } = recordingAuthority();
    const { reader } = recordingReader(countPlan(null));
    const { grants, issued } = recordingGrants();

    const seam = buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a")
    );
    expect(await refusalCode(() => seam.readStructuredQuery(COUNT))).toBe(
      "count_unavailable"
    );
    // Refused BEFORE anything was written: a count grant for an unmeasured count
    // would retain that false receipt for the grant's whole lifetime.
    expect(issued).toHaveLength(0);
  });
});

describe("the Query seam — per-connection identity (M1/B1)", () => {
  it("gives two connections in one process two identities, and neither can read the other's subjects", async () => {
    // B1's verification clause, verbatim: "Two sessions in the same host
    // process, given different injected identities, receive different
    // `authorizedSubset` values and cannot read each other's subjects."
    //
    // Built the way two connections actually arrive — two identities, two seams,
    // one process — rather than by mutating one shared object between calls. The
    // seam used to take a `process.env`-shaped argument and re-read it per call,
    // which made a mutation between calls look like a second session; no
    // production path does that, so the case went green against a seam that was
    // still process-level. Two connections differ in what the HOST hands the
    // seam, and that is the only thing this asserts.
    const { authority, minted } = recordingAuthority();
    const { reader, seen } = recordingReader(listPlan([entityRow(1)]));
    const { grants } = recordingGrants();
    const subjectA = "docs/session-a.md";
    const subjectB = "docs/session-b.md";

    const seamA = buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a", subjectA)
    );
    const seamB = buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-b", subjectB)
    );
    await seamA.readStructuredQuery(LIST);
    await seamB.readStructuredQuery(LIST);

    // The authorized subsets differ, which is the acceptance property itself:
    // `authorizedSubset` is what the reader narrows to, so two identical values
    // would mean the second connection inherited the first's authority.
    expect(minted.map((input) => input.authorizedSourceRefs)).toEqual([
      [subjectA],
      [subjectB],
    ]);
    expect(minted.map((input) => input.actorId)).toEqual([
      "session-a",
      "session-b",
    ]);
    // And each read was HANDED its own connection's context rather than merely
    // re-minting one: the reader's entry gate admits a context precisely because
    // this composition minted it, for that connection.
    expect(seen.map((context) => context.actorId)).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(seen[0]?.authorizedSourceRefs).toEqual([subjectA]);
    expect(seen[1]?.authorizedSourceRefs).toEqual([subjectB]);
    // The overlap is empty, so neither connection's read can see the other's
    // subject — stated as the absence of overlap rather than as inequality,
    // because that is the property a narrowing reader is supposed to have.
    const both = new Set([
      ...(seen[0]?.authorizedSourceRefs ?? []),
      ...(seen[1]?.authorizedSourceRefs ?? []),
    ]);
    expect(both.size).toBe(2);
  });

  it("keeps one connection's identity fixed across its own calls", async () => {
    // The complement of the case above, and the reason the seam does not mint a
    // second identity for a second REQUEST: the binding belongs to the
    // connection, so two reads on one connection are one actor. This is what
    // makes the previous case a statement about connections rather than about
    // call counts.
    const { authority, minted } = recordingAuthority();
    const { reader, seen } = recordingReader(listPlan([entityRow(1)]));
    const { grants } = recordingGrants();
    const seam = buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a")
    );

    await seam.readStructuredQuery(LIST);
    await seam.readStructuredQuery(LIST);

    expect(minted.map((input) => input.actorId)).toEqual([
      "session-a",
      "session-a",
    ]);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("refuses a connection the host bound no identity for, naming what is absent", async () => {
    // The reader is present because the backend CAN read; it refuses because this
    // connection was given nothing to read with. Same code as an absent reader,
    // and never a guessed owner or an empty source set. B1 requires the refusal
    // to NAME the missing binding, so the message is asserted here — a code alone
    // would leave the operator with nothing to inject.
    const { authority, minted } = recordingAuthority();
    const { reader, seen } = recordingReader(listPlan([entityRow(1)]));
    const { grants, issued } = recordingGrants();
    const identity = connectionIdentity("session-a");
    // Two absent members, so the refusal has to name which ones rather than
    // merely that something is missing.
    const incomplete: QueryScopeIdentity = {
      ...identity,
      authorizationRevision: undefined,
      deadlineAt: undefined,
    };

    const seam = buildStructuredQueryReader(
      authority,
      grants,
      reader,
      incomplete
    );
    const error = await capturedStructuredError(() =>
      seam.readStructuredQuery(LIST)
    );
    expect(error.code).toBe("structured_search_unavailable");
    expect(error.message).toContain("authorizationRevision");
    expect(error.message).toContain("deadlineAt");
    // Refused before anything was read or written, so an unbound connection
    // cannot cost a read or leave a reference behind.
    expect(minted).toHaveLength(0);
    expect(seen).toHaveLength(0);
    expect(issued).toHaveLength(0);
  });

  it("refuses an identity whose source set is empty instead of reporting an empty corpus", async () => {
    // Deliberately NOT `""`. A blank member is absent, so it is refused by the
    // missing-member branch above and would never reach this one; a value that is
    // present but names nothing — separators and spaces only — is what actually
    // separates an empty set from an absent one. An empty set would read as an
    // authorized empty result for a corpus the operator meant to expose.
    const { authority, minted } = recordingAuthority();
    const { reader, seen } = recordingReader(listPlan([entityRow(1)]));
    const { grants } = recordingGrants();
    const seam = buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a", " , , ")
    );

    const error = await capturedStructuredError(() =>
      seam.readStructuredQuery(LIST)
    );
    expect(error.code).toBe("structured_search_unavailable");
    expect(error.message).toContain("sourceRefs");
    // The message is the empty-set refusal, not the absent-member one, so the
    // member is named WITHOUT appearing in the absent list.
    expect(error.message).not.toContain("absent:");
    expect(minted).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });
});

describe("the Query seam — issuance is all-or-nothing and typed", () => {
  it("commits nothing when a request in the middle of the page fails", async () => {
    // The plan's no-partial-success clause. Looping `issueGrant` committed the
    // rows before the failing one and then refused the read, so the caller never
    // learned a reference existed while it pinned dependencies for 365 days.
    const rows = [entityRow(1), entityRow(2), entityRow(3)];
    const { authority } = recordingAuthority();
    const { reader } = recordingReader(listPlan(rows));
    const { grants, committed } = throwingGrants(1, true);

    const seam = buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a")
    );
    expect(await refusalCode(() => seam.readStructuredQuery(LIST))).toBe(
      "structured_search_unavailable"
    );
    expect(committed).toHaveLength(0);
  });

  it("would commit a prefix if the page were issued one reference at a time", async () => {
    // The negative control for the case above, and the reason it is here rather
    // than left to inspection: a store that behaves the way the pre-batch loop
    // behaved leaves two references committed behind a refused read, so
    // `committed` is a measurement that can fail.
    const rows = [entityRow(1), entityRow(2), entityRow(3)];
    const { authority } = recordingAuthority();
    const { reader } = recordingReader(listPlan(rows));
    const { grants, committed } = throwingGrants(1, false);

    const seam = buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a")
    );
    await refusalCode(() => seam.readStructuredQuery(LIST));
    expect(committed).toHaveLength(1);
  });

  it("refuses a page whose issuance fails in the evidence store's own vocabulary", async () => {
    // `issueGrant` throws `GraphragError` through `evidenceError`, never
    // `StructuredQueryError`, so an untranslated failure fell past the adapter's
    // `err instanceof StructuredQueryError` branch and left as the legacy
    // `{error, message}` shape — contradicting tools/retrieve.ts's promise that
    // every structured refusal is a typed envelope. Reachable in production
    // through the memory lane's `requireGrantable` when a support's source
    // version stopped accepting obligations.
    const rows = [entityRow(1)];
    const { authority } = recordingAuthority();
    const { reader } = recordingReader(listPlan(rows));
    const { grants } = throwingGrants(0, true);

    const seam = buildStructuredQueryReader(
      authority,
      grants,
      reader,
      connectionIdentity("session-a")
    );
    const error = await capturedStructuredError(() =>
      seam.readStructuredQuery(LIST)
    );
    expect(error.code).toBe("structured_search_unavailable");
    // What the host receives. `structuredErrorEnvelope` is built from the code
    // alone, so the internal detail is in the log and not on the wire — which is
    // the whole reason the raw message may stay on the error.
    const envelope = structuredErrorEnvelope(error);
    const toHost = JSON.stringify(envelope);
    expect(toHost).not.toContain("stopped accepting obligations");
    expect(toHost).not.toContain("00000000-0000-4000-8000-000000000009");
    expect(envelope).toEqual({
      schema: "iknow.structured_error",
      schema_version: 1,
      error: { code: "structured_search_unavailable", retryable: true },
    });
    // And the detail is still available to whoever reads the error itself.
    expect(error.message).toContain("stopped accepting obligations");
  });
});
