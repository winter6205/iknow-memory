# SQL graph arm — archived off production retrieve

**Status:** archived 2026-08-26 (route reset, cleanup, BM25).
**Applies to:** `retrieve` on the default `createServer` path.

## What changed

Production `retrieve` no longer runs the Postgres one-hop graph arm. The
default server wiring hands the retrieve tool no `graphConfig`, and
`assembleRetrievalResult` gates the arm on that key, so the stock server
takes the vector path (vector + BM25) and returns the
plain `{ chunks: [...] }` envelope.

Nothing was deleted. `src/core/retrieval/graph-arm.ts` still compiles,
`PgvectorBackend.graphArmSeed` still exists, and unit and integration
tests that inject `graphConfig` themselves still exercise the arm
end-to-end. The archive is an absence in one wiring function, which is
also why it is cheap to reverse.

## Why

The arm was a single JOIN from seed entities through `triples` to
`chunks`. That is entity-filtered SQL recall, not graph traversal — no
multi-hop, no PPR, no community structure — so it gave operators a
"dual-arm GraphRAG" story the implementation did not back. Worse, it was
load-bearing on the default path: with the ledger populated it could be
the _only_ contributor to a retrieve response, and an empty ledger set
`degraded: true` on every call.

Real graph retrieval is a Neo4j projection concern (ADR: Postgres
authoritative, Neo4j read-only projection). Keeping the SQL arm wired
would have made that migration look like a regression rather than the
first real implementation. Lexical BM25 is the near-term recall partner
for vector search instead.

## What is retained

- The ledger tables — `entities`, `entity_aliases`, `triples`,
  `extraction_records` — are untouched. `upSchemaP0` still creates them
  and the extraction CLI still writes them. No migration drops anything.
- `graphArmSeed` on `PgvectorBackend`, and both of its SQL statements.
- The graph-arm unit and integration suites.

## Guardrails

- `tests/index.test.ts` → `buildRetrieveDeps` must not carry a
  `graphConfig` key. Runs without Postgres, so it gates every PR.
- `tests/cli/extract-e2e-graph.test.ts` Case 4 → a real pgvector server
  holding traversable graph data returns exactly `{ chunks: [] }` when
  the vector arm is filtered empty, and the ledger survives the run.

## Reversing this

Pass a `RetrieveConfig` as `graphConfig` in `buildRetrieveDeps`
(`src/index.ts`). Both guardrail tests above will fail, which is the
point: re-enabling the SQL arm as a product arm is a spec decision, not a
wiring tweak. Route it through `specs/` first.
