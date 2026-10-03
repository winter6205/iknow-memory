/**
 * QP3 — persistent structured-result identity (pure layer).
 *
 * Two things are pinned here, and neither needs Postgres:
 *
 *   1. The exact-tuple identity rule. A relation assertion's persistent UUID
 *      identifies the exact normalized tuple `(canonical head entity UUID,
 *      relation_norm, canonical tail entity UUID, valid_window)`. The sharp
 *      case is a *differing but overlapping* valid_window: the existing
 *      write-layer dedup (`core/extraction/dedup.ts` `findOverlap`) merges
 *      those into one row, and the SPEC forbids that merge here. One exact
 *      tuple gets one ID; a changed tuple is a new corrected identity, never
 *      a similarity/recency merge.
 *
 *   2. The strict validity contract: whole-second UTC only, offset conversion
 *      only when lossless, nonzero fractional seconds refused rather than
 *      rounded, `from < until` when both endpoints are present, null
 *      endpoints preserved as unbounded.
 *
 * The DDL cases at the bottom drive the real `upSchemaBootstrap` against a
 * recording fake client (the harness `tests/storage/bootstrap-columns.test.ts`
 * established), so the identity tables and the constant-derived entity-type
 * CHECK are pinned without a database. The Postgres-free proof deliberately
 * does NOT assert idempotency by replay: that is the pg suite's job
 * (`tests/structured/identity-store-pg.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { ENTITY_TYPES } from "../../src/core/extraction/entity-type.js";
import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import {
  deriveRelationAssertionId,
  normalizeEntityId,
  normalizeRelationNorm,
  normalizeRelationAssertion,
  normalizeValidWindow,
  readUuidShape,
  RELATION_ASSERTION_IDENTITY_VERSION,
  requireEntityType,
  serializeRelationAssertionTuple,
  StructuredIdentityError,
  type NormalizedValidWindow,
  type RelationAssertionTuple,
} from "../../src/core/structured/identity.js";
import {
  InMemoryStructuredIdentityStore,
  type RelationAssertionInput,
} from "../../src/core/structured/identity-store.js";

const HEAD = "11111111-1111-4111-8111-111111111111";
const TAIL = "22222222-2222-4222-8222-222222222222";

function tupleFor(
  overrides: Partial<RelationAssertionTuple> = {}
): RelationAssertionTuple {
  return {
    headEntityId: HEAD,
    relationNorm: "works_for",
    tailEntityId: TAIL,
    validWindow: { from: "2024-01-01T00:00:00Z", until: null },
    identityVersion: RELATION_ASSERTION_IDENTITY_VERSION,
    ...overrides,
  };
}

function refusalFor(run: () => unknown, field: string): StructuredIdentityError {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected a refusal naming "${field}"`).toBeInstanceOf(
    StructuredIdentityError
  );
  const error = caught as StructuredIdentityError;
  // A refusal must name the offending field so an operator-facing handler can
  // act on it; an anonymous throw would be indistinguishable from a bug.
  expect(error.field).toBe(field);
  return error;
}

describe("strict whole-second UTC validity normalization", () => {
  it("accepts from < until and preserves the canonical encoding", () => {
    const window = normalizeValidWindow({
      from: "2024-01-01T00:00:00Z",
      until: "2024-12-31T23:59:59Z",
    });
    expect(window).toEqual({
      from: "2024-01-01T00:00:00Z",
      until: "2024-12-31T23:59:59Z",
    });
  });

  it("preserves a null unbounded endpoint instead of inventing a bound", () => {
    expect(
      normalizeValidWindow({
        from: "2024-01-01T00:00:00Z",
        until: null,
      })
    ).toEqual({ from: "2024-01-01T00:00:00Z", until: null });
    expect(normalizeValidWindow({ from: null, until: null })).toEqual({
      from: null,
      until: null,
    });
    // Half-open: an assertion that is valid forever carries no upper bound, so
    // `null` is the unbounded case on EITHER side and both must survive.
    expect(
      normalizeValidWindow({ from: null, until: "2024-01-01T00:00:00Z" })
    ).toEqual({ from: null, until: "2024-01-01T00:00:00Z" });
  });

  it("rejects nonzero fractional seconds rather than rounding them", () => {
    // Rounding .999Z down to the second would equate an assertion that never
    // held with one that did — invented equivalence, which the SPEC forbids.
    for (const fractional of [
      "2024-01-01T10:00:00.5Z",
      "2024-01-01T10:00:00.500Z",
      "2024-01-01T10:00:00.001Z",
      "2024-01-01T10:00:00.000001Z",
    ]) {
      refusalFor(
        () => normalizeValidWindow({ from: fractional, until: null }),
        "valid_window.from"
      );
    }
  });

  it("accepts a zero fractional part as a lossless encoding of the same second", () => {
    // `.000` names the same whole second as no fraction at all, so rejecting it
    // would refuse a value the canonical form already admits.
    expect(
      normalizeValidWindow({
        from: "2024-01-01T10:00:00.000Z",
        until: null,
      })
    ).toEqual({ from: "2024-01-01T10:00:00Z", until: null });
  });

  it("converts a whole-minute offset to UTC when the conversion is lossless", () => {
    const window = normalizeValidWindow({
      from: "2024-01-01T10:00:00+02:00",
      until: "2024-06-30T23:59:59+05:30",
    });
    expect(window).toEqual({
      from: "2024-01-01T08:00:00Z",
      until: "2024-06-30T18:29:59Z",
    });
  });

  it("refuses a non-whole-minute offset as a lossy conversion", () => {
    // A sub-minute offset lands the UTC instant between two whole seconds, so
    // the canonical whole-second form cannot represent it losslessly.
    refusalFor(
      () =>
        normalizeValidWindow({
          from: "2024-01-01T10:00:00+05:30:30",
          until: null,
        }),
      "valid_window.from"
    );
  });

  it("names the offending ENDPOINT on each side of the window", () => {
    // `field` is what an operator-facing handler acts on, so a refusal raised
    // while normalizing the `until` endpoint must not be reported as a `from`
    // problem — the handler would send the caller to fix the wrong bound. The
    // two sides are symmetric, so the offsets are the sharpest probe: they
    // fail AFTER the regex matched, in the offset reader.
    for (const offset of ["+05:30:30", "+99:00", "-99:00"]) {
      refusalFor(
        () =>
          normalizeValidWindow({
            from: `2024-01-01T00:00:00${offset}`,
            until: null,
          }),
        "valid_window.from"
      );
      refusalFor(
        () =>
          normalizeValidWindow({
            from: null,
            until: `2024-01-01T00:00:00${offset}`,
          }),
        "valid_window.until"
      );
    }
  });

  it("refuses an UNDEFINED endpoint instead of widening the window to unbounded", () => {
    // `ValidWindowInput` declares `string | null`, so `undefined` is already
    // outside the contract. Coercing it to null would silently turn a LOST
    // endpoint into an unbounded one and derive a DIFFERENT persistent id for
    // the same assertion — a scope widening with no refusal.
    refusalFor(
      () =>
        normalizeValidWindow({
          from: undefined as unknown as string | null,
          until: null,
        }),
      "valid_window.from"
    );
    refusalFor(
      () =>
        normalizeValidWindow({
          from: null,
          until: undefined as unknown as string | null,
        }),
      "valid_window.until"
    );
  });

  it("keeps a null endpoint unbounded while refusing an undefined one", () => {
    expect(normalizeValidWindow({ from: null, until: null })).toEqual({
      from: null,
      until: null,
    });
    expect(
      normalizeValidWindow({ from: null, until: "2024-01-01T00:00:00Z" })
    ).toEqual({ from: null, until: "2024-01-01T00:00:00Z" });
    expect(
      normalizeValidWindow({ from: "2024-01-01T00:00:00Z", until: null })
    ).toEqual({ from: "2024-01-01T00:00:00Z", until: null });
  });

  it("refuses a leap second as non-representable", () => {
    // `:60` is a real leap second, not a whole second in the POSIX timeline;
    // rounding it to `:00` would name a different instant.
    refusalFor(
      () => normalizeValidWindow({ from: "2016-12-31T23:59:60Z", until: null }),
      "valid_window.from"
    );
  });

  it("refuses from == until as an empty interval", () => {
    const error = refusalFor(
      () =>
        normalizeValidWindow({
          from: "2024-01-01T00:00:00Z",
          until: "2024-01-01T00:00:00Z",
        }),
      "valid_window"
    );
    expect(error.message).toMatch(/empty|equal/i);
  });

  it("refuses from > until as a reversed interval", () => {
    refusalFor(
      () =>
        normalizeValidWindow({
          from: "2024-12-31T00:00:00Z",
          until: "2024-01-01T00:00:00Z",
        }),
      "valid_window"
    );
  });

  it("refuses a calendar date that does not exist rather than rolling it over", () => {
    // `Date` would silently turn 2024-02-30 into 2024-03-01; the acceptance rule
    // is "lossless or refused", so the rollover must never be produced.
    refusalFor(
      () => normalizeValidWindow({ from: "2024-02-30T00:00:00Z", until: null }),
      "valid_window.from"
    );
    refusalFor(
      () => normalizeValidWindow({ from: "2023-02-29T00:00:00Z", until: null }),
      "valid_window.from"
    );
  });

  it("refuses a value outside the accepted YYYY-MM-DDTHH:mm:ss grammar", () => {
    // Date-only, minute-precision, missing the T separator and a bare local
    // time (no offset) are all outside the accepted encoding: each would have
    // to be widened by assumption before it can become whole-second UTC.
    for (const bad of [
      "2024-01-01",
      "2024-01-01T10:00Z",
      "2024-01-01 10:00:00Z",
      "2024-01-01T10:00:00",
      "2024-13-01T00:00:00Z",
      "2024-01-01T24:00:00Z",
    ]) {
      refusalFor(
        () => normalizeValidWindow({ from: bad, until: null }),
        "valid_window.from"
      );
    }
  });

  it("normalizes the lossless and the already-UTC spelling to one value", () => {
    const viaOffset = normalizeValidWindow({
      from: "2024-01-01T10:00:00+02:00",
      until: null,
    });
    const viaUtc = normalizeValidWindow({
      from: "2024-01-01T08:00:00Z",
      until: null,
    });
    expect(viaOffset).toEqual(viaUtc);
  });
});

describe("entity identity reuses the existing UUID boundary", () => {
  it("accepts a canonical UUID unchanged", () => {
    expect(normalizeEntityId(HEAD)).toBe(HEAD);
  });

  it("maps uppercase, braced and urn-prefixed forms onto the canonical identity", () => {
    // The extractor and external sources hand over non-canonical spellings of
    // the SAME entity. If these derived different identities, one entity would
    // be counted as several results.
    const canonical = normalizeEntityId(HEAD);
    expect(normalizeEntityId(HEAD.toUpperCase())).toBe(canonical);
    expect(normalizeEntityId(`{${HEAD.toUpperCase()}}`)).toBe(canonical);
    expect(normalizeEntityId(`urn:uuid:${HEAD}`)).toBe(canonical);
    expect(normalizeEntityId(`{${HEAD}}`)).toBe(canonical);
  });

  it("refuses a value that is not a UUID at all", () => {
    for (const bad of ["", "not-a-uuid", "alice", "  "]) {
      refusalFor(() => normalizeEntityId(bad), "entity_id");
    }
  });

  it("shares ONE UUID primitive whose case policy is an explicit input", () => {
    // The two boundaries validate the same shape and deliberately differ on
    // case, so the policy is a named input rather than a second function:
    //   `preserve`    — the request boundary. PG's `uuid` comparison is
    //                   case-insensitive, so a preserved-case id still matches
    //                   the stored row; folding it here would change what the
    //                   caller sent.
    //   `canonicalize` — the identity boundary. Every spelling of one entity
    //                   must derive ONE id, so folding is the whole point.
    // Collapse the two policies and one boundary silently changes meaning, so
    // both are pinned here on the shared primitive itself.
    expect(readUuidShape(HEAD, "preserve")).toBe(HEAD);
    expect(readUuidShape(HEAD, "canonicalize")).toBe(HEAD);
    expect(readUuidShape(HEAD.toUpperCase(), "preserve")).toBe(
      HEAD.toUpperCase()
    );
    expect(readUuidShape(HEAD.toUpperCase(), "canonicalize")).toBe(HEAD);
    // The shape is the strict 8-4-4-4-12 spelling on BOTH policies. Braced and
    // `urn:uuid:` forms are canonicalized by `normalizeEntityId` before the
    // check, so accepting them here would silently widen the request boundary
    // too.
    for (const bad of [
      "",
      "not-a-uuid",
      HEAD.replace(/-/g, ""),
      `{${HEAD}}`,
      `urn:uuid:${HEAD}`,
    ]) {
      expect(readUuidShape(bad, "preserve")).toBeUndefined();
      expect(readUuidShape(bad, "canonicalize")).toBeUndefined();
    }
  });

  it("refuses a UUID whose shape is wrong", () => {
    for (const bad of [
      `${HEAD}x`,
      HEAD.replace(/-/g, ""),
      HEAD.replace("1111-4111", "1111-411"),
      "zzzzzzzz-1111-4111-8111-111111111111",
    ]) {
      refusalFor(() => normalizeEntityId(bad), "entity_id");
    }
  });

  it("admits every member of the closed EntityType catalog", () => {
    for (const type of ENTITY_TYPES) {
      expect(requireEntityType(type)).toBe(type);
    }
  });

  it("refuses an entity type outside the closed catalog", () => {
    // The catalog is closed; a proposed type is refused here rather than
    // mapped, because identity must not re-map a value `entities.type` already
    // constrained.
    for (const bad of ["", "concept", "system", "robot", "PERSON "]) {
      refusalFor(() => requireEntityType(bad), "entity_type");
    }
  });
});

describe("relation_norm canonicalization", () => {
  it("folds case and surrounding whitespace onto one spelling", () => {
    // The extract path persists a trimmed, lowercased norm, and the LLM emits
    // capitalized/space-padded surface forms; both must name one identity.
    const canonical = normalizeRelationNorm("works_for");
    expect(normalizeRelationNorm("works_for")).toBe(canonical);
    expect(normalizeRelationNorm("  works_for  ")).toBe(canonical);
    expect(normalizeRelationNorm("WORKS_FOR")).toBe(canonical);
    expect(normalizeRelationNorm(" Works_For ")).toBe(canonical);
  });

  it("refuses an empty relation_norm", () => {
    for (const bad of ["", "   ", "\t\n"]) {
      refusalFor(() => normalizeRelationNorm(bad), "relation_norm");
    }
  });
});

describe("exact normalized tuple identity", () => {
  it("returns the same ID for the same tuple across repeated calls", () => {
    const first = deriveRelationAssertionId(tupleFor());
    for (let i = 0; i < 5; i += 1) {
      expect(deriveRelationAssertionId(tupleFor())).toBe(first);
    }
  });

  it("is a UUID, not a fresh random value", () => {
    expect(deriveRelationAssertionId(tupleFor())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it.each([
    ["head entity", { headEntityId: "33333333-3333-4333-8333-333333333333" }],
    ["relation_norm", { relationNorm: "member_of" }],
    ["tail entity", { tailEntityId: "44444444-4444-4444-8444-444444444444" }],
  ])("returns a different ID when the %s changes", (_label, overrides) => {
    expect(deriveRelationAssertionId(tupleFor(overrides))).not.toBe(
      deriveRelationAssertionId(tupleFor())
    );
  });

  it("returns a DIFFERENT ID for a differing-but-overlapping valid_window", () => {
    // The sharp case. `core/extraction/dedup.ts` `findOverlap` merges these
    // two rows into one (it matches on interval OVERLAP); the SPEC's exact-tuple
    // rule must keep them apart, because "works_for from 2020" and "works_for
    // from 2024" are different assertions, not corroboration of one.
    const earlier = tupleFor({
      validWindow: { from: "2020-01-01T00:00:00Z", until: null },
    });
    const later = tupleFor({
      validWindow: { from: "2024-01-01T00:00:00Z", until: null },
    });
    const bounded = tupleFor({
      validWindow: { from: "2020-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z" },
    });
    const unbounded = tupleFor({ validWindow: { from: null, until: null } });

    // The windows genuinely overlap pairwise, so this is not a disjoint case.
    expect(earlier.validWindow.from).not.toBe(later.validWindow.from);

    const ids = [earlier, later, bounded, unbounded].map(deriveRelationAssertionId);
    expect(new Set(ids).size).toBe(4);
  });

  it("gives one identity to every spelling of the same window", () => {
    // Stated through the real entry point: `deriveRelationAssertionId`
    // requires a NORMALIZED tuple, so the spelling collapse belongs to
    // `normalizeRelationAssertion`. A raw offset string fed straight to the
    // derivation is a different tuple, correctly.
    const canonical = normalizeRelationAssertion({
      headEntityId: HEAD,
      relationNorm: "works_for",
      tailEntityId: TAIL,
      validWindow: { from: "2024-01-01T08:00:00Z", until: null },
    });
    const viaOffset = normalizeRelationAssertion({
      headEntityId: HEAD,
      relationNorm: "works_for",
      tailEntityId: TAIL,
      validWindow: { from: "2024-01-01T10:00:00+02:00", until: null },
    });
    expect(viaOffset.validWindow).toEqual(canonical.validWindow);
    expect(deriveRelationAssertionId(viaOffset)).toBe(
      deriveRelationAssertionId(canonical)
    );
  });

  it("serializes with a length prefix, not a bare separator join", () => {
    // These two DIFFERENT tuples have byte-identical bare `|` joins: the `|`
    // embedded in one endpoint of each shifts every field boundary after it, so
    // the flat segment lists come out the same. A bare join would therefore
    // derive ONE id for two distinct assertions — exactly the silent merge the
    // exact-tuple rule forbids. The non-canonical values are the point: the
    // SERIALIZER must be unambiguous on its own, not because every field
    // happens to be validated, because a future tuple revision would silently
    // change which fields are safe.
    const early = tupleFor({
      validWindow: {
        from: "2024-01-01T00:00:00Z",
        until: "2030-01-01T00:00:00Z|extra",
      },
    });
    const shifted = tupleFor({
      validWindow: {
        from: "2024-01-01T00:00:00Z|2030-01-01T00:00:00Z",
        until: "extra",
      },
    });
    const naiveJoin = (t: RelationAssertionTuple): string =>
      [
        t.headEntityId,
        t.relationNorm,
        t.tailEntityId,
        t.validWindow.from ?? "",
        t.validWindow.until ?? "",
      ].join("|");
    // Pin the premise: the naive encoding really does collide on this pair.
    expect(naiveJoin(shifted)).toBe(naiveJoin(early));

    expect(serializeRelationAssertionTuple(shifted)).not.toBe(
      serializeRelationAssertionTuple(early)
    );
    expect(deriveRelationAssertionId(shifted)).not.toBe(
      deriveRelationAssertionId(early)
    );
  });

  it("gives a separator-bearing relation_norm its own stable identity", () => {
    // The realistic shape of the same hazard: an LLM-emitted norm carrying
    // punctuation. It must not collide with the norm without it.
    const punctuated = tupleFor({ relationNorm: "works_for:acme|labs" });
    const plain = tupleFor({ relationNorm: "works_for" });
    expect(deriveRelationAssertionId(punctuated)).not.toBe(
      deriveRelationAssertionId(plain)
    );
    expect(deriveRelationAssertionId(punctuated)).toBe(
      deriveRelationAssertionId(punctuated)
    );
  });

  it("derives a different identity when the identity version is bumped", () => {
    // A versioned identity correction must be able to create a NEW identity for
    // the same tuple rather than colliding with (or being refused as) the
    // already-registered v1 one.
    const v1 = deriveRelationAssertionId(
      tupleFor({ identityVersion: 1 })
    );
    const v2 = deriveRelationAssertionId(
      tupleFor({ identityVersion: RELATION_ASSERTION_IDENTITY_VERSION + 1 })
    );
    expect(v2).not.toBe(v1);
  });

  it("records the version in the serialization so the derivation is auditable", () => {
    expect(serializeRelationAssertionTuple(tupleFor())).toContain(
      `${RELATION_ASSERTION_IDENTITY_VERSION}`
    );
    expect(
      serializeRelationAssertionTuple(
        tupleFor({ identityVersion: RELATION_ASSERTION_IDENTITY_VERSION + 1 })
      )
    ).not.toBe(serializeRelationAssertionTuple(tupleFor()));
  });
});

describe("in-memory identity store", () => {
  function inputFor(
    overrides: Partial<RelationAssertionInput> = {}
  ): RelationAssertionInput {
    return {
      headEntityId: HEAD,
      relationNorm: "works_for",
      tailEntityId: TAIL,
      validWindow: { from: "2024-01-01T00:00:00Z", until: null },
      ...overrides,
    };
  }

  it("registers an entity identity without minting a new id", async () => {
    const store = new InMemoryStructuredIdentityStore();
    const registered = await store.registerEntity({
      entityId: HEAD.toUpperCase(),
      type: "person",
    });
    // The entity result id IS the existing entity UUID; the registry validates
    // and records it, it does not issue one.
    expect(registered.entityId).toBe(HEAD);
    expect(await store.findEntity(HEAD)).toEqual(registered);
  });

  it("refuses an entity type outside the closed catalog", async () => {
    const store = new InMemoryStructuredIdentityStore();
    await expect(
      store.registerEntity({ entityId: HEAD, type: "concept" })
    ).rejects.toBeInstanceOf(StructuredIdentityError);
  });

  it("re-registering the same tuple returns the same ID and keeps one row", async () => {
    const store = new InMemoryStructuredIdentityStore();
    const first = await store.registerRelationAssertion(inputFor());
    // Repeated support from a second source resolves to the same identity.
    const second = await store.registerRelationAssertion(inputFor());
    expect(second.assertionId).toBe(first.assertionId);
    expect(store.relationAssertionCount).toBe(1);
  });

  it("canonicalizes the input before deriving, so surface drift keeps one id", async () => {
    const store = new InMemoryStructuredIdentityStore();
    const first = await store.registerRelationAssertion(inputFor());
    const second = await store.registerRelationAssertion(
      inputFor({
        headEntityId: `{${HEAD.toUpperCase()}}`,
        relationNorm: "  WORKS_FOR ",
        validWindow: { from: "2024-01-01T02:00:00+02:00", until: null },
      })
    );
    expect(second.assertionId).toBe(first.assertionId);
    expect(store.relationAssertionCount).toBe(1);
  });

  it("records a changed tuple as a new corrected identity rather than merging", async () => {
    const store = new InMemoryStructuredIdentityStore();
    const original = await store.registerRelationAssertion(inputFor());
    const corrected = await store.registerRelationAssertion(
      inputFor({ relationNorm: "member_of" })
    );
    expect(corrected.assertionId).not.toBe(original.assertionId);
    // Both identities remain readable: a correction records a new truth, it
    // does not erase the historical one.
    expect(await store.findRelationAssertion(original.assertionId)).toEqual(
      original
    );
    expect(await store.findRelationAssertion(corrected.assertionId)).toEqual(
      corrected
    );
    expect(store.relationAssertionCount).toBe(2);
  });

  it("keeps an overlapping valid_window as a separate identity", async () => {
    const store = new InMemoryStructuredIdentityStore();
    const first = await store.registerRelationAssertion(
      inputFor({ validWindow: { from: "2020-01-01T00:00:00Z", until: null } })
    );
    const second = await store.registerRelationAssertion(
      inputFor({ validWindow: { from: "2024-01-01T00:00:00Z", until: null } })
    );
    expect(second.assertionId).not.toBe(first.assertionId);
    expect(store.relationAssertionCount).toBe(2);
  });

  it("refuses an invalid window before touching the store", async () => {
    const store = new InMemoryStructuredIdentityStore();
    await expect(
      store.registerRelationAssertion(
        inputFor({ validWindow: { from: "2024-01-01T00:00:00.500Z", until: null } })
      )
    ).rejects.toBeInstanceOf(StructuredIdentityError);
    await expect(
      store.registerRelationAssertion(
        inputFor({
          validWindow: { from: "2024-01-01T00:00:00Z", until: "2024-01-01T00:00:00Z" },
        })
      )
    ).rejects.toBeInstanceOf(StructuredIdentityError);
    expect(store.relationAssertionCount).toBe(0);
  });

  it("returns the normalized window it registered", async () => {
    const store = new InMemoryStructuredIdentityStore();
    const registered = await store.registerRelationAssertion(
      inputFor({
        validWindow: {
          from: "2024-01-01T10:00:00+02:00",
          until: null,
        },
      })
    );
    expect(registered.validWindow).toEqual<NormalizedValidWindow>({
      from: "2024-01-01T08:00:00Z",
      until: null,
    });
  });
});

interface RecordedQuery {
  sql: string;
}

/**
 * Drive the real `upSchemaBootstrap` against a recording fake and return the
 * SQL it emitted. Same harness shape as `tests/storage/bootstrap-columns.test.ts`
 * (a `pg`-shaped handle that answers the advisory-lock and readiness calls, so
 * the DDL path runs and is observable without a database).
 */
async function runBootstrapRecordingSql(): Promise<RecordedQuery[]> {
  const queries: RecordedQuery[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push({ sql });
      if (/AS ready/.test(sql)) return { rows: [{ ready: false }] };
      if (/current_schema\(\)/.test(sql)) {
        return { rows: [{ schema_name: "public" }] };
      }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] };
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  await upSchemaBootstrap(client, 1536, 2000);
  return queries;
}

describe("registered identity DDL", () => {
  it("creates both identity tables through the idempotent bootstrap", async () => {
    const sql = (await runBootstrapRecordingSql()).map((q) => q.sql);
    const created = sql.filter((s) =>
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+structured_/i.test(s)
    );
    expect(created.join("\n")).toMatch(
      /structured_entity_identities/i
    );
    expect(created.join("\n")).toMatch(
      /structured_relation_assertion_identities/i
    );
  });

  it("pins the assertion identity to the tuple with a UNIQUE digest index", async () => {
    const sql = (await runBootstrapRecordingSql()).map((q) => q.sql);
    const indexes = sql
      .filter((s) => /CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i.test(s))
      .join("\n");
    // Tuple equality is enforced in the database, keyed on the canonical
    // serialization's digest and scoped by identity version so a corrected
    // identity version can never collide with the one it corrects.
    expect(indexes).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+structured_relation_assertion_identities_tuple_idx/i
    );
    expect(indexes).toMatch(/identity_version,\s*tuple_digest/i);
  });

  it("derives the identity CHECKs from the closed EntityType constant", async () => {
    const sql = (await runBootstrapRecordingSql()).map((q) => q.sql);
    const identityChecks = sql
      .filter((s) => /structured_entity_identities/i.test(s))
      .join("\n");
    // The vocabulary must render from ENTITY_TYPES exactly as the `entities`
    // CHECK does, so the two vocabularies cannot drift apart.
    for (const type of ENTITY_TYPES) {
      expect(identityChecks).toContain(`'${type}'`);
    }
    expect(identityChecks).toMatch(
      /structured_entity_identities_type_check/i
    );
  });

  it("keeps the whole identity DDL replay-safe", async () => {
    const sql = (await runBootstrapRecordingSql()).map((q) => q.sql);
    const identityStatements = sql.filter((s) =>
      /structured_(entity|relation_assertion)_identities/i.test(s)
    );
    expect(identityStatements.length).toBeGreaterThan(0);
    for (const statement of identityStatements) {
      // Every replayable guard the bootstrap relies on: a second run must be a
      // no-op rather than a duplicate-object error.
      expect(statement).toMatch(
        /IF\s+NOT\s+EXISTS|ADD\s+CONSTRAINT|EXCEPTION/i
      );
    }
  });
});
