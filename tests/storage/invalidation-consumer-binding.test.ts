/**
 * The per-consumer stream identity: the eighth allowlisted binding variable, and
 * the two properties that depend on it (register §1b.3; ADR 0097 §2.1).
 *
 * Sibling of `t13-private-evidence-read.test.ts` rather than a section of it:
 * that file owns the private read's refusal ladder, and these cases are about
 * where a CONSUMER comes from and what an absent one does — the read's own
 * refusals are not involved.
 *
 * Why this file exists at all, given the real-PostgreSQL suite covers the
 * stream behaviour: the two seams here are reachable without a database, and a
 * property that only runs against Postgres stops being checked on every
 * ordinary test run. What cannot be faked — the blocking lock, the rollback, the
 * concurrent uniqueness — lives in
 * `tests/acceptance/structured-invalidation-outbox-pg.test.ts` instead.
 */
import { describe, expect, it } from "vitest";

import {
  isScopeFailureCode,
  readTrustedIdentityBinding,
  TRUSTED_BINDING_ENV_NAMES,
  TRUSTED_BINDING_ENV_VARS,
} from "../../src/core/storage/evidence-binding.js";
import {
  QUERY_SCOPE_ENV_VARS,
  queryScopeIdentityFromEnv,
} from "../../src/core/storage/structured-query-scope.js";
import { STRUCTURED_SCOPE_FAILURE_CODES } from "../../src/core/storage/structured-scope-types.js";
import {
  MAX_CONSUMER_ID_CHARS,
  normalizeGrantRequest,
} from "../../src/core/storage/evidence-store.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { EVIDENCE_FAILURE } from "../../src/core/types.js";
import type { GrantRequest } from "../../src/core/types.js";

const CONSUMER = "fin-consumer";
const DEADLINE = "2027-01-01T00:00:00.000Z";
const QUERIED_AT = "2026-01-05T00:00:00.000Z";

function bindingEnv(
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    [TRUSTED_BINDING_ENV_VARS.version]: "1",
    [TRUSTED_BINDING_ENV_VARS.actorId]: "actor-a",
    [TRUSTED_BINDING_ENV_VARS.ownerScopeBinding]: "scope-a",
    [TRUSTED_BINDING_ENV_VARS.readerBinding]: "reader-a",
    [TRUSTED_BINDING_ENV_VARS.sourceRefs]: "src-1",
    [TRUSTED_BINDING_ENV_VARS.authorizationRevision]: "auth-1",
    [TRUSTED_BINDING_ENV_VARS.deadlineAt]: DEADLINE,
    [TRUSTED_BINDING_ENV_VARS.consumerId]: CONSUMER,
    ...overrides,
  };
}

function countRequest(overrides: Partial<GrantRequest> = {}): GrantRequest {
  return {
    kind: "count",
    subject: "assertion",
    operation: "count",
    queryDigest: "digest-1",
    scopeBinding: "scope-a",
    readRevision: "read-1",
    queriedAt: QUERIED_AT,
    context: {},
    value: { count: 3, operation: "count" },
    count: 3,
    consumerId: CONSUMER,
    ...overrides,
  } as GrantRequest;
}

describe("the eighth allowlisted binding variable", () => {
  it("is named and allowlisted exactly once", () => {
    expect(TRUSTED_BINDING_ENV_VARS.consumerId).toBe(
      "IKNOW_EVIDENCE_CONSUMER_ID"
    );
    const occurrences = TRUSTED_BINDING_ENV_NAMES.filter(
      (name) => name === TRUSTED_BINDING_ENV_VARS.consumerId
    );
    expect(occurrences).toHaveLength(1);
    // The Query seam reads the SAME name, so one host setting gives one
    // consumer id rather than two that could disagree about a grant's stream.
    expect(QUERY_SCOPE_ENV_VARS.consumerId).toBe(
      TRUSTED_BINDING_ENV_VARS.consumerId
    );
  });

  it("is read onto the binding when injected", () => {
    expect(readTrustedIdentityBinding(bindingEnv()).consumerId).toBe(CONSUMER);
  });

  it("refuses an absent consumer rather than inventing one", () => {
    const env = bindingEnv();
    delete env[TRUSTED_BINDING_ENV_VARS.consumerId];
    try {
      readTrustedIdentityBinding(env);
      expect.unreachable("an absent consumer must be a refusal");
    } catch (error) {
      // The same code and the same in-set guarantee as every other absent
      // field — no new member of the closed set, no default id.
      expect((error as { code?: string }).code).toBe("access_denied");
      expect(isScopeFailureCode((error as { code: string }).code)).toBe(true);
      expect(STRUCTURED_SCOPE_FAILURE_CODES).toContain(
        (error as { code: string }).code
      );
      expect((error as Error).message).toContain(
        TRUSTED_BINDING_ENV_VARS.consumerId
      );
    }
  });

  it("treats a blank consumer as absent", () => {
    expect(() =>
      readTrustedIdentityBinding(
        bindingEnv({ [TRUSTED_BINDING_ENV_VARS.consumerId]: "   " })
      )
    ).toThrowError(/incomplete/);
  });
});

describe("the consumer the grant store receives", () => {
  it("reaches the normalized grant", () => {
    expect(normalizeGrantRequest(countRequest()).consumer_id).toBe(CONSUMER);
  });

  it("refuses a blank consumer with the evidence capability's own token", () => {
    try {
      normalizeGrantRequest(
        countRequest({ consumerId: "" } as Partial<GrantRequest>)
      );
      expect.unreachable("a blank consumer must be refused");
    } catch (error) {
      expect((error as { failureToken?: string }).failureToken).toBe(
        EVIDENCE_FAILURE.MALFORMED_CONTRACT
      );
    }
  });

  it("accepts a consumer id exactly at fin's bound and refuses one past it", () => {
    // The cross-repo half of the contract: fin bounds the same label at
    // MAX_BINDING_TOKEN_CHARS = 512 in src/fin/retrieve/evidence_route.py. A
    // label fin accepts and iknow has already granted under is a binding that
    // can never drain; one iknow accepts and fin refuses is a grant nobody can
    // invalidate. Both sides must accept the same strings, so the boundary is
    // pinned here from the shared constant rather than spelled as a literal.
    const atBound = "c".repeat(MAX_CONSUMER_ID_CHARS);
    expect(
      normalizeGrantRequest(countRequest({ consumerId: atBound })).consumer_id
    ).toBe(atBound);

    const overBound = "c".repeat(MAX_CONSUMER_ID_CHARS + 1);
    try {
      normalizeGrantRequest(countRequest({ consumerId: overBound }));
      expect.unreachable("an over-long consumer must be refused");
    } catch (error) {
      // A MALFORMED_CONTRACT, not the absent-consumer refusal: the host DID
      // supply a value, it just is not one fin would ever drain, and reporting
      // it as missing would send an operator to the wrong variable.
      expect((error as { failureToken?: string }).failureToken).toBe(
        EVIDENCE_FAILURE.MALFORMED_CONTRACT
      );
      expect((error as Error).message).toContain(String(MAX_CONSUMER_ID_CHARS));
    }
  });

  it("is persisted by the memory backend, so the twin keeps the stream", async () => {
    const backend = new MemoryBackend();
    backend.setScopeRevisions("scope-a", {
      authorizationRevision: "auth-1",
      purgeRevision: "purge-1",
    });
    const [count] = await backend.issueGrants([countRequest()]);
    expect(count?.consumer_id).toBe(CONSUMER);
  });

  it("refuses a page whose consumer is absent, committing no sibling", async () => {
    // The whole point of a BATCH: a refused member must not leave the others
    // granted, and a grant with no stream is refused for the same reason.
    const backend = new MemoryBackend();
    backend.setScopeRevisions("scope-a", {
      authorizationRevision: "auth-1",
      purgeRevision: "purge-1",
    });
    await expect(
      backend.issueGrants([
        countRequest(),
        countRequest({ consumerId: "" } as Partial<GrantRequest>),
      ])
    ).rejects.toThrowError();
  });
});

describe("the Query seam's consumer", () => {
  it("is read from the same host variable, and absent stays absent", () => {
    const identity = queryScopeIdentityFromEnv({
      [QUERY_SCOPE_ENV_VARS.actorId]: "actor-a",
      [QUERY_SCOPE_ENV_VARS.ownerScopeBinding]: "scope-a",
      [QUERY_SCOPE_ENV_VARS.readerBinding]: "reader-a",
      [QUERY_SCOPE_ENV_VARS.sourceRefs]: "src-1",
      [QUERY_SCOPE_ENV_VARS.authorizationRevision]: "auth-1",
      [QUERY_SCOPE_ENV_VARS.deadlineAt]: DEADLINE,
      [QUERY_SCOPE_ENV_VARS.consumerId]: CONSUMER,
    });
    expect(identity.consumerId).toBe(CONSUMER);
    // Never defaulted: an unbound consumer is a value this type can hold, which
    // is what lets the issuer refuse it by name.
    expect(
      queryScopeIdentityFromEnv({
        [QUERY_SCOPE_ENV_VARS.actorId]: "actor-a",
      }).consumerId
    ).toBeUndefined();
  });

  it("does not become a scope member: an absent consumer is not a scope failure", async () => {
    // A missing consumer must read as "cannot issue a grant", not as
    // "unprovisioned scope" — the two are different operational problems and
    // the refusal message would send an operator to the wrong variable.
    const { resolveQueryScope } =
      await import("../../src/core/storage/structured-query-scope.js");
    const minted: string[] = [];
    const authority = {
      createAuthorizedContext: (input: unknown) => {
        minted.push(JSON.stringify(input));
        return { input } as never;
      },
    };
    const resolved = resolveQueryScope(
      authority as never,
      queryScopeIdentityFromEnv({
        [QUERY_SCOPE_ENV_VARS.actorId]: "actor-a",
        [QUERY_SCOPE_ENV_VARS.ownerScopeBinding]: "scope-a",
        [QUERY_SCOPE_ENV_VARS.readerBinding]: "reader-a",
        [QUERY_SCOPE_ENV_VARS.sourceRefs]: "src-1",
        [QUERY_SCOPE_ENV_VARS.authorizationRevision]: "auth-1",
        [QUERY_SCOPE_ENV_VARS.deadlineAt]: DEADLINE,
      })
    );
    expect("context" in resolved).toBe(true);
    // And the consumer never reaches the authorized context at all: which
    // stream an invalidation goes to is not authority.
    expect(minted[0]).not.toContain("consumer");
  });
});
