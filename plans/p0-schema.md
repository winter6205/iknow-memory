# Plan: P0 Schema — entities / triples / entity_aliases / extraction_records

**Goal:** Ship the four Postgres tables and indexes that back the P0
entity/triple layer (consumed by spec 2 extraction+merge and spec 3
integration+evaluation).
**Architecture:** One new file `src/core/storage/schema-p0.ts` exporting
`upSchemaP0(client)`; one small wiring edit to `pgvector-backend.ts`'s
existing `ensureTable` init path. No new dependencies, no Neo4j runtime
(ADR-0001).
**Tech Stack:** TypeScript + node-postgres `pg` + Postgres/pgvector (already
provisioned). One helper per table + a thin orchestrator wrapping a single
BEGIN/COMMIT/ROLLBACK transaction.
**Spec link:** `specs/p0-schema.md`
**ACR verdict:** 5/5 yes (re-confirmed 2026-08-05 after complexity-anti-drift
revision; verdict block embedded below).

## architecture-change-reviewer verdict

1. bounded-context-guardian: yes
2. defensive-contract-validator: yes
3. error-handling-enforcer: yes
4. complexity-anti-drift: yes (helper-per-table + thin orchestrator)
5. minimal-change-verifier: yes

→ spec advances; planning proceeds.

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: vertical slice, one tag, one commit,
binary acceptance. The plan is intentionally light on code shape — the spec
already locked the DDL contract and complexity envelope; bullets below test
behaviors, not internal decomposition.

### T1. `[decision]` Resolve the three Open Questions in `specs/p0-schema.md`

- **Affects:** `specs/p0-schema.md` (Open Questions section updated; answers
  optionally folded into the spec body where they unblock concrete behavior);
  no production code.
- **Acceptance:** the spec's Open Questions section is empty (or annotated
  "deferred to <reason>") for each of: (a) UUID version — v4 or v7; (b) DB
  layer dedup for triples — yes-with-unique-partial-index or app-only;
  (c) migration mechanism — yes-with-schema_meta or none. The commit message
  body records all three answers.
- **Why [decision]:** T2–T5 consume these answers; without them the code in
  T2–T5 would either pick a wrong default or block waiting for input.
- **Commit:** 1 commit = this 1 task.

### T2. `[implementation]` Scaffold `schema-p0.ts` + idempotency probe

- **Affects:** `src/core/storage/schema-p0.ts` (new — exports `upSchemaP0`,
  the four table helpers, and the BEGIN/COMMIT/ROLLBACK wrapper); empty stub
  acceptable on intermediate commits but T2's commit must call `CREATE TABLE
IF NOT EXISTS` for at least one table so idempotency is real, not theoretical;
  `tests/schema-p0.test.ts` (new — at least one test exercising
  double-call-of-`upSchemaP0` against a real Postgres).
- **Acceptance:** `npx vitest run tests/schema-p0.test.ts -t 'idempotent'`
  exits 0 against a real Postgres; running `upSchemaP0` twice in the same
  transaction does not throw and does not change `pg_tables` row counts.
  If Postgres is unreachable, the test loudly skips with the project's
  documented Validation block.
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Commit:** 1 commit = this 1 task.
- **Status:** [ ] pending

### T3. `[implementation]` Land `entities` + `entity_aliases` tables and tests

- **Affects:** `src/core/storage/schema-p0.ts` (add `entities` and
  `entity_aliases` helpers — internal factorisation left to implementer);
  `tests/schema-p0.test.ts` (add tests covering both tables per the spec's
  DDL contract and Indexes table).
- **Acceptance:** after running `upSchemaP0` against a real Postgres, the
  following all hold (introspection queries in the test):
  1. both tables exist with the columns enumerated in `specs/p0-schema.md`;
  2. `pg_indexes` lists the indexes the spec assigns to these two tables
     (entity_canonical_name_idx; entity_aliases unique on (entity_id, alias);
     entity_aliases_alias_idx);
  3. CHECK constraint on `entities.type` rejects an invalid value (real
     `INSERT` assertion in the test);
  4. CHECK constraint on `entity_aliases.alias_type` rejects an invalid value;
  5. FK CASCADE on `entity_aliases.entity_id` behaves per the spec
     (entity delete cascade-removed its aliases; not testable while triples
     exist — test via raw SQL in a dedicated transaction that creates then
     tears down the entity cleanly).
     `npm run typecheck` exits 0; new tests pass; no regression in existing
     storage/ingest/retrieve suites.
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Commit:** 1 commit = this 1 task.
- **[blocks: T1, T2]**

### T4. `[implementation]` Land `triples` table and FK/CHECK/index tests

- **Affects:** `src/core/storage/schema-p0.ts` (add `triples` helper);
  `tests/schema-p0.test.ts` (add tests for `triples`).
- **Acceptance:** against a real Postgres:
  1. `triples` table exists with the spec columns;
  2. CHECK on `confidence BETWEEN 0 AND 1` rejects `-0.5` and `1.5`
     (two distinct probes);
  3. CHECK on `relation_norm NOT NULL` and on `relation_raw NOT NULL`
     (both probe INSERTs fail);
  4. FK `ON DELETE SET NULL` on `source_chunk_id`: deleting the referenced
     chunk nulls the column and keeps the triple row;
  5. FK `ON DELETE RESTRICT` on `head_id` and `tail_id`: deleting an entity
     that is referenced as head or tail fails with a PG FK violation (two
     probes);
  6. GiST index on `valid_window` present; btree indexes on `(head_id)`,
     `(tail_id)`, `(source_chunk_id)`, `(relation_norm)` present
     (`pg_indexes` introspection).
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Commit:** 1 commit = this 1 task.
- **[blocks: T3]**

### T5. `[implementation]` Land `extraction_records` table, boundary probes, and wire into `pgvector-backend.ts`

- **Affects:** `src/core/storage/schema-p0.ts` (add `extraction_records`
  helper); `tests/schema-p0.test.ts` (add tests for `extraction_records`,
  `valid_window @>` boundary semantics, full introspection sweep);
  `src/core/storage/pgvector-backend.ts` (one line addition inside the
  existing `ensureTable` transaction, calling `upSchemaP0(client)` after the
  existing `chunks` DDL — exact insertion point left to implementer per the
  existing try/catch shape).
- **Acceptance:** against a real Postgres:
  1. `extraction_records` exists with all spec columns;
  2. CHECK on `status IN ('pending','succeeded','failed')` rejects an
     invalid value;
  3. btree indexes on `(chunk_id)`, `(batch_id)`, `(status)`, `(created_at)`
     present (`pg_indexes` introspection);
  4. `valid_window @>` semantic probes per spec: a window `[t, t+1h)`
     contains `t`, contains `t+30min`, does NOT contain `t+1h` (right-open
     boundary); a window with `valid_until = NULL` contains a far-future
     instant (forever-valid);
  5. After wiring, `npm test` exits 0 — the existing stage-1 suites
     (ingest, retrieve, memory-backend, host-smoke) all still pass;
  6. `npm run build` and `npm run typecheck` both exit 0;
  7. pgvector-backend.ts changes are confined to the existing init
     transaction — no public API change to `StorageBackend` or any other
     exported surface.
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Commit:** 1 commit = this 1 task.
- **[blocks: T4]**

## Cross-references

- **ACR verdict:** see block above (5/5 yes).
- **Spec link:** `specs/p0-schema.md` is the binding contract; this plan only
  refers to behaviors, not to internal decomposition.
- **Affected S1–S6 skills:** S2 (defensive-contract — DDL boundary classes);
  S5 (complexity-anti-drift — helper decomposition); S6 (minimal-change —
  one file added, one line added, zero new deps).
- **Parallelization surface:** none — T3–T5 are strictly sequential because
  each adds a table that the next test relies on. T1 is independent (no
  code), so it could ship in parallel with T2 if a separate worktree branch
  were used; for this single-PR flow we keep them serial to preserve
  one-commit-per-task.
- **Out of scope (intentionally):** Neo4j connection; vocabulary enforcement
  (`relation_norm`); exclusion constraints; HNSW on `entities.embedding`;
  migration tooling; `chunks` schema change. Each is called out in the spec
  and revisited only via a future spec's own assumption gate.

## Open Questions gate

T1 must close all three Open Questions in `specs/p0-schema.md` before T2
starts. If T1 cannot answer one of them, that question is escalated back to
the operator (via PR comment or direct reply) and T2 is paused.
