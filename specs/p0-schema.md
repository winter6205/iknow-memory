# Spec: P0 Schema — entities / triples / entity_aliases / extraction_records

> Spec 1 of 3 for the P0 foundation (spec boundary decision B: schema standalone;
> extraction+merge combined; integration+evaluation combined).
> Upstream decisions: winter6205/iknow-memory#3 (D1–D6), #6 (Q1–Q2), #7 (Q1, Q3a, Q3b).
> Assumption gate: 26 assumptions surfaced 2026-08-05, all confirmed; items A3 / A15 / A21
> carried into Open Questions below.

## Objective

Pin down the concrete Postgres DDL — columns, constraints, indexes, and the
initialization path — for the four P0 tables that carry the entity/triple layer:
`entities`, `triples`, `entity_aliases`, `extraction_records`.

Why: the shape of these tables was decided in #3 D1–D6 (schema), #6 Q1–Q2
(entities.embedding + soft-merge columns), and #7 Q3a (extraction_records),
but the decisions deliberately left column-level detail to "downstream spec".
Three downstream workstreams — extraction CLI (#4), canonical merge (#6),
retrieve graph arm (#7) — all read and write these tables; they need one
authoritative DDL contract to build against.

Users: implementers of the extraction+merge spec and the integration+evaluation
spec, plus their reviewers. Success looks like: the four tables exist in
Postgres with the exact columns below, every FK/CHECK behavior is test-verified
against a real database, and no downstream spec needs to add a column.

## Architectural Constraints

- **ADR-0001** (`docs/adr/0001-postgres-authoritative-neo4j-projection.md`):
  Postgres is the sole system of record; Neo4j is a read-only projection;
  **P0 code does not connect to Neo4j at all** (#3 D1, #7 Q3b).
- **#3 D2**: entity id is UUID (opaque, merge-stable). UUID version is Open Question 1.
- **#3 D3**: relation carried twice — `relation_raw` (free text, audit/eval fidelity)
  and `relation_norm` (vocabulary term; graph traversal keys on it). The vocabulary
  is a git-managed code file owned by #4 D7; the DB does NOT enforce vocabulary
  membership. `relation_norm = 'UNMAPPED'` is a legal sentinel (#4 D5).
- **#3 D4**: `triples.source_chunk_id` is a hard FK to `chunks.id` with
  ON DELETE SET NULL — knowledge outlives its source.
- **#3 D5**: `triples.valid_window` is `tstzrange` with GiST index, filtered by `@>`;
  chunks keep their stage-1 two-column time model (deliberate asymmetry, #3 D5 rationale).
- **#3 D6**: Neo4j projection shape is documented here for P1 reference only;
  no runtime artifact in P0.
- **#6 Q1–Q2**: `entities.embedding` column (merge input + graph-arm entity linking,
  one vector two consumers); soft merge via `merged_into` pointer + `retired` flag.
- **#7 Q3a**: `extraction_records` is chunk-level rows with `batch_id` aggregation key
  (no separate batch rows — P0d prototype verdict item 7).
- **#7 Q1**: retrieve graph arm reads Postgres JOINs only in P0; index set below
  must serve one-hop triple lookup + `@>` time slice + entity linking.

## Glossary

Terms used in this spec are copied verbatim from `docs/CONTEXT.md` (SSOT; only
`domain-modeling` may redefine): **chunk**, **entity**, **triple**, **alias**,
**canonical entity**, **valid_window**, **valid_at**, **Neo4j sidecar**,
**ingest**, **extract_triples**. Flagged ambiguity in force: _Postgres
authoritative, Neo4j read-only projection_.

## Tech Stack

No new dependencies. Existing stack only:

- TypeScript, Node.js (as `package.json`)
- `pg` (node-postgres) via the existing `PgVectorBackend`
- Postgres + `pgvector` extension (already provisioned by stage 1)
- Postgres core features only: `tstzrange`, GiST, btree, CHECK, FK actions.
  No `btree_gin`, no `pg_trgm`, no exclusion constraints in P0.

Tech stack changes require a new assumption gate (per spec-driven-development).

## Commands

```
Build:     npm run build
Test:      npm test                                  # full suite (pre-commit runs this)
Test new:  npx vitest run tests/schema-p0.test.ts    # schema integration tests
Typecheck: npm run typecheck
```

DDL verification (manual, against the dev Postgres):

```
npm test                                              # idempotency + FK + @> tests run against real PG
psql "$DATABASE_URL" -c '\d entities'                 # column spot-check
psql "$DATABASE_URL" -c '\di'                         # index inventory
```

No Dev command: this spec ships no runtime behavior beyond table creation.

## Project Structure

```
src/core/storage/
  pgvector-backend.ts    # MODIFIED: existing init (chunks DDL) also calls schema-p0 up()
  schema-p0.ts           # NEW: the four-table DDL + indexes, single exported up function
tests/
  schema-p0.test.ts      # NEW: integration tests against a real Postgres
specs/
  p0-schema.md           # THIS FILE
docs/
  CONTEXT.md             # already aligned (commit d97176b)
  adr/0001-*.md          # already recorded (commit d97176b)
```

Tests live in `tests/` (project convention, flat). No new directories beyond `specs/`.

## Code Style

Follow `pgvector-backend.ts` conventions: DDL as template-literal SQL inside an
async init function, `CREATE TABLE IF NOT EXISTS` for idempotency, snake_case
columns, singular table names matching glossary terms. Comments explain WHY
(constraints, FK actions), not what the SQL does.

```ts
// schema-p0.ts — shape of the exported surface (decomposed by table)
//
// One small helper per table (CREATE TABLE + its indexes). Public up() is
// a thin orchestrator wrapping them in a single transaction. Each helper
// stays well under 40 lines; orchestrator stays under 20.

async function createEntities(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS entities (...)`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS entities_canonical_name_idx ...`
  );
}

async function createEntityAliases(client: PoolClient): Promise<void> {
  /* ... */
}
async function createTriples(client: PoolClient): Promise<void> {
  /* ... */
}
async function createExtractionRecords(client: PoolClient): Promise<void> {
  /* ... */
}

export async function upSchemaP0(
  client: PoolClient,
  dimensions: number
): Promise<void> {
  await client.query("BEGIN");
  try {
    await createEntities(client);
    await createEntityAliases(client);
    await createTriples(client);
    await createExtractionRecords(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
```

If the implementer prefers a single multi-statement transaction instead of the
helper decomposition, that shape is acceptable too — the helpers stay, the
SQL bodies just move inline. Either way, no function in this file exceeds 40
lines, no nesting beyond 2, no parameter beyond `client`.

Good output example — a passing FK-behavior test:

```
✓ deleting a chunk SET NULLs triples.source_chunk_id and keeps the triple row
✓ deleting a referenced entity is rejected (RESTRICT on head_id/tail_id)
```

## DDL Contract

### entities

| column           | type          | constraint                                                       | rationale                                                              |
| ---------------- | ------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `id`             | `uuid`        | PK                                                               | #3 D2; version per Open Question 1                                     |
| `canonical_name` | `text`        | NOT NULL                                                         | display + L0 merge lookup                                              |
| `type`           | `text`        | NOT NULL, CHECK IN (`'person'`,`'concept'`,`'system'`,`'event'`) | closed set in P0; extending = Ask-first DDL change                     |
| `embedding`      | `vector(N)`   | nullable                                                         | N = chunks embedding dim (single embedder, #6 Q1); no HNSW index in P0 |
| `metadata`       | `jsonb`       | nullable, default `'{}'`                                         | open-ended attributes                                                  |
| `merged_into`    | `uuid`        | nullable, FK → entities(id) ON DELETE SET NULL                   | #6 Q2 soft merge; SET NULL preserves rollback when survivor deleted    |
| `retired`        | `boolean`     | NOT NULL DEFAULT false                                           | fast liveness filter without chasing merged_into                       |
| `created_at`     | `timestamptz` | NOT NULL DEFAULT now()                                           | audit                                                                  |

Invariant (enforced in app layer, spec 2): `retired = true` ⇔ `merged_into IS NOT NULL`.

### entity_aliases

| column       | type          | constraint                                                 | rationale                                                   |
| ------------ | ------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| `id`         | `uuid`        | PK                                                         | row identity for deterministic unmerge (#6 P0c known limit) |
| `entity_id`  | `uuid`        | NOT NULL, FK → entities(id) ON DELETE CASCADE              | aliases die with their entity                               |
| `alias`      | `text`        | NOT NULL                                                   | surface form                                                |
| `alias_type` | `text`        | NOT NULL, CHECK IN (`'name'`,`'variant'`,`'abbreviation'`) | glossary: alias types                                       |
| `created_at` | `timestamptz` | NOT NULL DEFAULT now()                                     | audit                                                       |

No `embedding` column — entity-linking vectors live on `entities` only (#6 Q1,
confirmed A10).

### triples

| column            | type          | constraint                                     | rationale                                                              |
| ----------------- | ------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `id`              | `uuid`        | PK                                             |                                                                        |
| `head_id`         | `uuid`        | NOT NULL, FK → entities(id) ON DELETE RESTRICT | merge retires, never deletes                                           |
| `tail_id`         | `uuid`        | NOT NULL, FK → entities(id) ON DELETE RESTRICT | same                                                                   |
| `relation_raw`    | `text`        | NOT NULL                                       | #3 D3 fidelity (audit/eval)                                            |
| `relation_norm`   | `text`        | NOT NULL                                       | #3 D3; `'UNMAPPED'` sentinel legal; vocabulary enforced in app (#4 D7) |
| `confidence`      | `real`        | NOT NULL, CHECK 0..1                           |                                                                        |
| `source_chunk_id` | `uuid`        | nullable, FK → chunks(id) ON DELETE SET NULL   | #3 D4                                                                  |
| `valid_window`    | `tstzrange`   | NOT NULL                                       | #3 D5; `[from, until)`, null upper bound = forever                     |
| `created_at`      | `timestamptz` | NOT NULL DEFAULT now()                         |                                                                        |

No DB-level dedup key in P0 (see Open Question 2). The semantic dedup key
`(head_id, relation_norm, tail_id)` + valid_window overlap is enforced at the
extraction write layer (#4 D6) in spec 2.

### extraction_records

| column           | type          | constraint                                                | rationale                                               |
| ---------------- | ------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `id`             | `uuid`        | PK                                                        |                                                         |
| `batch_id`       | `uuid`        | NOT NULL                                                  | aggregation key; no separate batch rows (P0d verdict 7) |
| `chunk_id`       | `uuid`        | nullable, FK → chunks(id) ON DELETE SET NULL              | mirrors D4                                              |
| `status`         | `text`        | NOT NULL, CHECK IN (`'pending'`,`'succeeded'`,`'failed'`) | #4 D4 failure-queryable                                 |
| `error_code`     | `text`        | nullable                                                  |                                                         |
| `error_msg`      | `text`        | nullable                                                  |                                                         |
| `triples_count`  | `integer`     | NOT NULL DEFAULT 0                                        |                                                         |
| `unmapped_count` | `integer`     | NOT NULL DEFAULT 0                                        |                                                         |
| `started_at`     | `timestamptz` | NOT NULL                                                  |                                                         |
| `finished_at`    | `timestamptz` | nullable                                                  | null while pending                                      |
| `created_at`     | `timestamptz` | NOT NULL DEFAULT now()                                    | cleanup ordering (P0d verdict 6)                        |

### Indexes

| table                | index                                                        | serves                                                            |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `triples`            | GiST (`valid_window`)                                        | `@>` point + overlap queries (#3 D5)                              |
| `triples`            | btree (`head_id`), btree (`tail_id`)                         | one-hop graph arm JOIN (#7 Q1)                                    |
| `triples`            | btree (`source_chunk_id`)                                    | provenance back-map, idempotency scans (#4 D6)                    |
| `triples`            | btree (`relation_norm`)                                      | UNMAPPED review CLI (#4 D7)                                       |
| `entities`           | btree (`canonical_name`)                                     | L0 merge lookup support (#6)                                      |
| `entity_aliases`     | UNIQUE (`entity_id`, `alias`)                                | no duplicate alias per entity                                     |
| `entity_aliases`     | btree (`alias`)                                              | cross-entity L0 alias lookup (#6 L0)                              |
| `extraction_records` | btree (`chunk_id`), (`batch_id`), (`status`), (`created_at`) | listFailed / batch aggregate / cleanup (#7 Q3a, P0d verdicts 5–6) |

No HNSW on `entities.embedding` in P0 (data volume; Ask-first to add later).

### P1 reference only — Neo4j projection shape (#3 D6, no runtime in P0)

Node `(:Entity {id, canonical_name, type})` — no embedding. Edge
`[:RELATION {relation_norm, confidence, valid_from, valid_until}]`. Chunks do
not enter the graph. Sync mechanism (leading candidate: outbox) and
read-your-writes: P1 (#7 Q3b/Q3c).

## Testing Strategy

Framework: vitest (project convention). Location: `tests/schema-p0.test.ts`.
Level: **integration against a real Postgres** — DDL semantics cannot be
unit-tested. If no Postgres is reachable the suite must skip loudly with the
project's documented skip format (Validation block), never silently pass.

Coverage contract — each is a test:

1. Idempotency: `upSchemaP0()` twice in a row → no error, table/index counts unchanged.
2. FK SET NULL (chunks → triples.source_chunk_id): delete chunk, triple survives with NULL.
3. FK SET NULL (entities.merged_into survivor deleted): pointer NULLs, rollback path intact.
4. FK SET NULL (chunks → extraction_records.chunk_id).
5. FK RESTRICT (entities referenced as head_id/tail_id): delete fails.
6. FK CASCADE (entity deleted → its aliases vanish) — testable only via direct SQL since RESTRICT blocks entity delete while triples exist; document this ordering in the test.
7. CHECK rejections: bad entity type, bad alias_type, bad status, confidence > 1, confidence < 0.
8. `valid_window @> instant`: left-closed/right-open boundary probes (three probes incl. exact upper bound excluded), unbounded upper = forever.
9. Index inventory: every index in the table above exists (pg introspection).

No coverage target numbers beyond "every row above is a test"; DDL has no
branching logic to cover.

## Boundaries

- **Always do**: keep every statement idempotent; run the schema integration suite against a real Postgres before claiming done; keep DDL in one transaction per table-set up(); follow snake_case + glossary names; write the failing test first (TDD per project rules).
- **Ask first**: adding/removing/renaming any column; any new extension; exclusion or unique dedup constraints at the DB layer; HNSW index; any change to FK actions; anything touching `chunks`.
- **Never do**: introduce a Neo4j connection/driver in P0 code; add a migration framework (out of scope, Open Question 3); store embeddings in the graph projection; physically delete entities in application code (soft merge only); edit `docs/CONTEXT.md` or `docs/adr/` from any skill other than domain-modeling.

## Success Criteria

Binary — each maps to a command + expected output:

1. `npx vitest run tests/schema-p0.test.ts` exits 0 against a real Postgres (all 9 coverage-contract groups pass).
2. `upSchemaP0()` called twice produces no error and identical introspection output (idempotency).
3. Every FK action behaves as tabled: 3× SET NULL, 2× RESTRICT, 1× CASCADE, each proven by an actual DELETE.
4. `valid_window @>` point semantics match `docs/CONTEXT.md` valid_window entry (left-closed, right-open, null = forever) — three boundary probes pass.
5. All 7 CHECK constraints reject their invalid row (actual failed INSERTs asserted).
6. Index inventory introspection returns exactly the 12 tabled indexes.
7. `npm run typecheck` and `npm run build` exit 0; full `npm test` exits 0 (no regression in stage-1 suites).
8. Cross-spec contract: extraction+merge spec (spec 2) and integration+evaluation spec (spec 3) can reference every field they need by the names above — verified when those specs are drafted (no "missing column" findings).

## Open Questions

All three Open Questions were resolved on 2026-08-06 at the writing-plans
handoff (T1 of `plans/p0-schema.md`). Recorded here so downstream specs do
not re-litigate them:

1. **UUID version (A3) — RESOLVED: `uuid v4`.** Node's built-in
   `crypto.randomUUID()` provides a v4 UUID with zero new dependency.
   `chunks.id` (stage 1) already uses v4 and is not reopened. All four P0
   tables (`entities`, `entity_aliases`, `triples`, `extraction_records`)
   declare `id uuid PRIMARY KEY` and rely on the app to generate v4. The
   v7 trade-off (time-ordered, lower B-tree write amplification) is
   deferred to a future spec that may revisit the entire PK strategy at
   once.
2. **DB-layer dedup for triples (A15) — RESOLVED: app-level only.** No
   unique index, no exclusion constraint at the DB layer. The semantic
   dedup key `(head_id, relation_norm, tail_id)` + `valid_window` overlap
   is enforced at the extraction write layer in spec 2 (#4 D6). The P0b
   V4 known limitation (deleted chunk → orphan triple absorbs a
   re-extracted duplicate and drops the new chunk's provenance) is
   inherited by spec 2 and is spec 2's responsibility to address.
3. **Migration mechanism (A22) — RESOLVED: `CREATE TABLE IF NOT EXISTS`
   only.** No `schema_meta` table, no forward-migration framework, no
   version tracking. Future ALTERs are manual SQL applied outside the
   bootstrap path. Reopen only if an operator requests version tracking
   from day one.
