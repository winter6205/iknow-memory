/**
 * The SQL clause's binding contract, for the one thing the real-Postgres
 * acceptance lane cannot cheaply isolate: WHICH column the clause matches on.
 *
 * The clause is parametrized by the query's local alias for `chunks`, and that
 * parameter is interpolated as a bare SQL identifier. Two failure modes follow
 * from it, and neither is a semantic bug Postgres would report: an alias that
 * silently matched nothing (the guard passes, the tier serves stale rows), and
 * an alias carrying SQL rather than a name. The first is why every emitted
 * string here is asserted to name the alias the caller passed, and the second
 * is why the alias is refused rather than escaped.
 *
 * The clause's BOOLEAN meaning is proven against real rows in
 * tests/acceptance/maintenance-mp12-guards-pg.test.ts, once for the vector tier
 * and once for the graph tier. This file needs no database.
 */
import { describe, expect, it } from "vitest";

import {
  SERVING_GUARD_CLAUSE,
  servingGuardClause,
} from "../../src/core/storage/serving-guard-pg.js";
import { GraphragError } from "../../src/core/errors.js";

describe("MP12 SQL clause — alias binding", () => {
  it("matches the caller's alias in BOTH halves, not just the first", () => {
    // One half bound and one half left on the bare table name would pass a
    // test that only looked for the alias, and would fail-closed every row on
    // a query that aliases `chunks`.
    const clause = servingGuardClause("c");
    expect(clause).toContain("sv.source_ref = c.source_ref");
    expect(clause).toContain("ps.source_ref = c.source_ref");
    expect(clause).not.toMatch(/= chunks\.source_ref/);
  });

  it("keeps SERVING_GUARD_CLAUSE as the un-aliased instantiation the vector query uses", () => {
    // The vector tier reads `FROM chunks` with no alias. If this constant
    // stopped being that instantiation, the vector tier would silently guard
    // against a column name it does not have.
    expect(SERVING_GUARD_CLAUSE).toBe(servingGuardClause("chunks"));
  });

  it("keeps the aggregate payload half rather than an EXISTS the planner pulls up", () => {
    // `EXISTS` here is pulled into a hash semi-join below the `ORDER BY
    // <=>`, which demotes the chunk HNSW index to a sequential scan — pinned by
    // tests/integration/vector-index-pg.test.ts. Same boolean, different plan.
    expect(SERVING_GUARD_CLAUSE).toMatch(/\(SELECT count\(\*\)/);
    expect(SERVING_GUARD_CLAUSE).toContain("NOT EXISTS (");
  });

  it("refuses an alias that is not a bare SQL identifier", () => {
    for (const alias of ["c; DROP TABLE chunks", "c.source_ref", "", "1c"]) {
      expect(() => servingGuardClause(alias)).toThrow(GraphragError);
    }
  });
});