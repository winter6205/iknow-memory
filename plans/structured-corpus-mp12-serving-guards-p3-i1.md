# P3-I1 — MP12 serving guards

Status: implementation plan (architecture gate passed)
Branch: `feat/p3-mp12-guards`, from `5ee8950` (`feat/structured-p1-query-production`)
Authority: `specs/structured-corpus-maintenance.md:320-323`; ticket P3-I1 in
`plans/structured-corpus-maintenance-gc-p3.md`
Target acceptance: driver cases **M13** and **M19**
Independent of: MP13 (collector), MP14 (mark), MP15-17 (deletion) — this branch
stacks on nothing and can merge on its own.

## The one sentence

Before outbox reconciliation, no hit from a withdrawn or sole-purged source may be
returned or cited; a source that still has a current support stays visible; and a
source whose lifecycle state cannot be read refuses serving with a typed status
rather than serving whatever the derived index happens to hold.

## What this branch does NOT assume

A previous reading of the ticket said the attribution join "cannot be built",
because `projection_outbox` records a `subject` uuid with no `source_ref`. That is
true of the outbox and irrelevant here: `chunks` itself carries `source_ref`
(`schema-*`, and it is selected by `buildVectorSearchQuery`), and `source_versions`
carries both `source_ref` and the three lifecycle stamps. The join is a real
join between two tables that both already exist. No new attribution surface is
needed, and none is built here.

## The predicate, and why it is this shape

A source is *served* when it has not been withdrawn **and** at least one of its
versions still has a payload that has not been collected. Those are two
independent facts, and neither can stand in for the other:

- **Withdrawn** — recorded as `structured_publication_sources.active = false`.
  `withdraw()` writes that column and nothing else: it never retires a version
  and never stamps a collection, so an un-collected withdrawn source is
  indistinguishable from a live one to a payload rule alone. Phrased as
  `NOT EXISTS (withdrawn)`, NOT as `EXISTS (active = true)`: a source that was
  ingested but never published has no publication row at all, and the `EXISTS`
  form would fail-close every such source even though nothing withdrew it.
- **Sole-purged** — every version's `payload_collected_at` is set. Written as a
  positive test (a version must exist and be un-collected), so a source the
  store cannot account for fails closed rather than serving on absence.
- **A current remaining support** — one version with `payload_collected_at IS NULL`
  keeps the whole source visible, which is what the ticket demands and what a
  per-chunk `retired_at` predicate would get wrong by hiding a live version
  because a sibling version was retired. Both tests are therefore per-SOURCE
  aggregates (`bool_or` over versions), not per-chunk predicates.

The check is on **live** source versions, not on the chunk's own validity window:
`valid_from`/`valid_until` decide whether a *row* is current, and a purged
payload's chunks can still sit inside a valid window — which is the whole hazard.

## Fail-closed, and what "fail-closed" costs

`maintenance_status_unavailable` already exists in the closed
`STRUCTURED_ERROR_CODES` vocabulary (`src/core/structured/errors.ts:45`) and is
already marked retryable. If the lifecycle read cannot be completed, this returns
that refusal rather than an unfiltered result set. The cost is real and stated
here: a lifecycle read failure takes vector search down rather than degrading it,
which is the ticket's instruction and the spec's rule for a missing dependency.

## Files

affects:
- src/core/structured/serving-guard.ts
- src/core/storage/serving-guard-pg.ts
- src/core/storage/serving-guard-memory.ts
- src/core/storage/pgvector-backend.ts (the vector predicate, and — graph tier —
  `ENTITY_CHUNKS_SQL`)
- tests/structured/serving-guard.unit.test.ts
- tests/storage/serving-guard-memory.test.ts
- tests/acceptance/maintenance-mp12-guards-pg.test.ts
- plans/structured-corpus-mp12-serving-guards-p3-i1.md

`pgvector-backend.ts` is in scope for the predicates alone. Lexical adoption is NOT
in this branch: it lives in Elasticsearch while both lifecycle facts live in Postgres,
so it needs an architecture decision (recorded above), not a clause. The graph tier IS
in this branch, via the one query that emits graph-tier chunk text.

## Architecture review verdicts

bounded-context-guardian: yes — one pure decision, one storage pair, and one predicate change; no new directory, no cross-repo import, no import from fin.
input-contract-tests: yes — empty candidate set, unknown source ref, every lifecycle combination, unreadable lifecycle state, and a store that throws.
error-handling-enforcer: yes — every refusal reuses the existing closed `STRUCTURED_ERROR_CODES`; no new code, no empty catch, no success on a failed path.
complexity-anti-drift: yes — the decision is a pure function of a facts object; the SQL is one named clause; storage is one function per lane.
minimal-change-verifier: yes — one ticket, one predicate, one guard. The lexical/graph adoption is deliberately excluded and named rather than half-done.

## Graph tier — the same guard on `ENTITY_CHUNKS_SQL`

### Why this query is the whole graph tier

`neo4j-graph-arm.ts:1-17` documents the three-step pipeline. Steps 1 (`seedEntitiesSql`)
and 2 (`buildPprCypher`, `neo4j-ppr.ts:109`) read no chunk text: the seed query selects
`id, canonical_name, score`, and PPR returns only `entityId, score` (`neo4j-ppr.ts:125`).
Step 3 is the single choke point where the graph tier emits chunk **content**, because
chunks never enter the graph (ADR-0001). So guarding `ENTITY_CHUNKS_SQL`
(`ENTITY_CHUNKS_SQL` in `pgvector-backend.ts`) covers the graph tier completely — `neo4j-graph-arm.ts`
needs no change at all, and the `source_ref` the clause matches on is already selected
at `:295` and mapped to the hit at `neo4j-graph-arm.ts:261`.

### The clause is reparametrized, not copied

`SERVING_GUARD_CLAUSE` hardcodes `chunks.source_ref`, and this query aliases the table
as `c`. The clause becomes a function of the local alias
(`servingGuardClause(alias)` in `serving-guard-pg.ts`), with `SERVING_GUARD_CLAUSE`
kept as its `chunks` instantiation. One definition, two call sites: the two tiers
cannot drift in polarity the way two hand-written copies would.

Both lifecycle tables index the join key — `UNIQUE (source_ref, source_version)`
(`schema-evidence.ts:73-74`) and `UNIQUE (source_ref)` (`schema-publication.ts:25`) —
so both correlated halves are index lookups rather than scans.

The `count(*) > 0` form is kept verbatim rather than "simplified" to `EXISTS`. That
shape exists for the planner, and the two are only semantically identical, never
planner-identical; see the `SERVING_GUARD_CLAUSE` doc comment. There is no ANN index
on this path to protect (`ORDER BY array_position(...), c.id` + `LIMIT`, no
`ORDER BY embedding <=>`), but the form is not re-litigated per call site — it is
carried by the single definition, and the HNSW regression stays pinned by
`tests/integration/vector-index-pg.test.ts`.

### The archived one-hop twin is deliberately NOT guarded

`buildOneHopChunksSql` (`query-builder.ts:46`) mirrors `ONE_HOP_CHUNKS_SQL`
(`ONE_HOP_CHUNKS_SQL` in `pgvector-backend.ts`) and stays unguarded, on two grounds that are facts about
the code rather than convenience:

1. It is production-unreachable. `graph-arm.ts:4-11` and `buildRetrieveDeps`
   (`index.ts:506-513`) both record that the stock server supplies no `graphConfig`,
   so `assembleRetrievalResult` never reaches the archived arm (#58 / #62).
2. It cannot be executed against production anyway. It filters
   `c.valid_window @> $2::timestamptz`, and the production `chunks` table has no
   `valid_window` column at all (the production `chunks` DDL in `PgvectorBackend.ensureTable` carries the
   `valid_from` / `valid_until` pair). Only the P0 test fixtures ever created a
   generated `valid_window`. Guarding SQL that cannot run would assert a protection
   nobody can observe.

Deliberately leaving it is recorded here rather than silently tolerated. If the
archived arm is ever revived, `ENTITY_CHUNKS_SQL` is the query to revive it from.

### Architecture gate — graph tier

bounded-context-guardian: yes — the guard stays in `serving-guard-pg.ts`; the change is one alias-parametrized builder in that module plus one clause appended in `pgvector-backend.ts`. No new module, no directory, no cross-store import, and no edit at all in `core/retrieval/`.
input-contract-tests: yes — the changed surface is emitted SQL, so the cases run against real Postgres: empty entity-id set (existing short-circuit in `PgvectorBackend.chunksByEntityIds`), live source, sole-purged source, withdrawn-but-uncollected source, ingested-but-unpublished source, and a source with no lifecycle row at all.
error-handling-enforcer: yes — the guard adds a `WHERE` predicate, so an unservable source yields zero rows (an ordinary empty result), not a throw. The existing `GraphragError` / `STORAGE_ERROR` wrapper in `PgvectorBackend.chunksByEntityIds` is untouched, and no new error code, magic string, or fallback branch is introduced.
complexity-anti-drift: yes — the alias is a call-site literal passed through a narrow identifier check mirroring `assertEmbeddingSlotIdentifier`, and the clause is one template literal; no touched function grows a branch or a parameter. Confirmed by `lint:s5` before commit, not assumed.
minimal-change-verifier: yes — one clause on one query. The lexical tier is documented as NOT done, three unguarded read paths are named as follow-ups rather than fixed, and the archived twin is left alone on stated grounds.

### The lexical tier is NOT DONE — decision, not implementation

The lexical arm lives in Elasticsearch (`buildPrecisionChunkQuery`,
`src/core/storage/elasticsearch-precision.ts:204`) while both lifecycle facts live in
Postgres. There is no SQL to append the clause to, so the two available routes are
both architecture decisions rather than guard changes:

**Option (i) — post-fetch `terms` filter on the returned `source_ref`s.**
Read the chunk rows, then drop the ones whose source is withdrawn or sole-purged.
Cheapest: no schema change, no second write path, roughly a dozen lines. But it is
exactly the shape MP12 rejected, and rejected for a stated reason: a post-filter still
*reads* the row, and MP12's promise is that a stale row is never **materialised**, not
merely never returned. It also races `withdraw()` — the fact is read after the rows,
so a withdrawal landing in that window is served once — and it gives Elasticsearch a
second, weaker answer to a question Postgres already answers authoritatively.

**Option (ii) — denormalise lifecycle state into the ES index, plus a write hook in
`withdraw()`.**
Guarantees the same never-materialised promise, because the index itself refuses the
row. Cost is real and lands outside this ticket: a new indexed field and its
backfill, a new `withdraw()` write path, and — the part that decides it — a genuine
cross-store consistency surface, since ES would now carry a second copy of a fact whose
SoR is Postgres, with a window where the two disagree. Every ES rebuild, reindex, and
partial-index path becomes a place the copy can go stale.

**Recommendation: (ii), but not here.** (i) is cheaper and actively wrong under MP12's
stated invariant, so it is not a real option. (ii) is the only shape that honours the
promise, and the consistency surface it creates is exactly the kind of one-way door
that belongs in its own slice with its own plan, its own backfill, and its own
acceptance lane — not appended to a guard branch whose claim is "the tier emits the
guard". Until that lands, **the lexical tier is unguarded and the register must say so.**

## Honest limits of the graph-tier slice

- **The lexical arm is unguarded.** See the decision above. It is NOT DONE here, and
  no artefact in this change may be read as covering it.
- Identified, deliberately NOT fixed in this change — unguarded chunk-emitting read
  paths, for the next slice to scope deliberately:
  - `src/core/storage/memory-backend.ts:216` — `MemoryBackend`, the in-memory
    `StorageBackend`. It has no lifecycle tables to join, so guarding it means
    deciding what a fake store claims about sources it never saw.
  - `src/core/storage/pgvector-backend.ts` — `NEIGHBOR_CHUNKS_SQL`, the
    same-source neighbour expansion used by the neighbouring-chunk arm.
  - `src/core/storage/pgvector-backend.ts` — `PARENT_WINDOWS_SQL`, the 档 A
    child→parent window read. It joins `source_documents` and does not select
    `chunks.source_ref` at all, so it needs a decision about whether the parent's
    source or the child's is the guard key before a clause can be written.

## Ordered work

1. `serving-guard.ts` — pure: candidate source refs + lifecycle facts → serve
   verdict, or a typed refusal when the facts are absent.
2. `serving-guard-pg.ts` — the live-source-ref read, and the SQL clause the
   vector predicate joins on.
3. `serving-guard-memory.ts` — the same decision over a seeded map.
4. `pgvector-backend.ts` — append the clause to `buildVectorSearchQuery`, and to
   `ENTITY_CHUNKS_SQL` for the graph tier.
5. Tests: unit, memory, and real PostgreSQL under `MAINTENANCE_ACCEPTANCE=1`.

## Honest limits of this branch

- The clause is proven against a real PostgreSQL: `SERVING_GUARD_CLAUSE` itself
  is executed through `buildVectorSearchQuery` against real `chunks`,
  `source_versions` and `structured_publication_sources` rows, not only through
  the guard's own fact read. The **graph tier** is proven the same way, through
  `ENTITY_CHUNKS_SQL`. It is **not** proven through the three-tier retrieval
  assembler, because the lexical arm does not consult the guard. This branch
  therefore does **not** yet satisfy M19's three-tier clause, and the register
  must not be flipped to claim otherwise.
- M19's two source-level halves — withdrawn and sole-purged — are both covered on
  the **vector** and **graph** arms. They are **not** covered on the lexical arm
  (see the decision above), and nothing here covers a citation that names a
  source without going through `chunks`.
- No tombstone exists (that is MP15/MP16). The payload half already refuses a
  purged source that has no version row at all, so a tombstone cannot
  reintroduce that leak; the withdrawal half is unaffected by tombstones either
  way, because a tombstoned source has no publication row to be withdrawn by.
