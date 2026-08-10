# Plan: P0 Integration — Graph-Arm Retrieve + Extraction CLI End-to-End (spec 3 of 3)

**Goal:** Wire the P0 entity + triple layer (produced by spec 2) into the
stage-1 `retrieve` MCP tool as a parallel graph arm, fuse both arms with RRF,
and ship a CLI-driven end-to-end loop `ingest → extract → retrieve` that
proves the data path round-trips through real Postgres — without touching
Neo4j, without changing the `retrieve` MCP tool contract, and without
re-opening spec-1 or spec-2 boundaries.
**Architecture:** One new bounded context `src/core/retrieval/` (read-only,
pure-function-first). One additive change to `StorageBackend` (optional
`graphArmSeed` method). One additive change to `src/tools/retrieve.ts`
(graph-arm call + RRF fusion + optional `degraded` envelope field). No new
runtime dependencies. No schema change. Neo4j not touched (ADR-0001).
**Tech Stack:** TypeScript strict ESM + `pg` + `vitest` + existing
`EmbeddingClient` / `StorageBackend` interfaces; no new client / ORM.
**Spec link:** `specs/p0-integration.md`
**ACR verdict:** 5/5 yes (2026-08-07; verdict block embedded below).
**Blocked by:** spec 1 (`specs/p0-schema.md` / PR winter6205/iknow-memory#11) +
spec 2 (`specs/p0-extraction.md` / PR #27) — both merged. Implementation
tickets may be written before #14 resolves, but the real-Postgres
integration suite (T6) requires both spec-1 DDL and spec-2 tables.

## architecture-change-reviewer verdict

1. bounded-context-guardian: yes (new read-only `src/core/retrieval/`; graph-arm takes injected `GraphArmStorage` seam; isolation guard: `index.ts` / `tools/ingest.ts` / `cli/extract.ts` must not import `src/core/retrieval/*`)
2. defensive-contract-validator: yes (all 5 boundary classes named for `runGraphArm`, `rrfFuse`, retrieve graph-arm path; `RetrieveConfig` startup validation crisp)
3. error-handling-enforcer: yes (`*Error` suffix mandated; fail-open policy `error → degraded:true + warn log`, never propagate; CLI exit codes 0/1/2 preserved)
4. complexity-anti-drift: yes (function ≤40 target / cyclomatic ≤10 hard / nesting ≤2 / params ≤4 / file ≤500 target ≤1000 hard — inherited from spec-2 envelope; decomposed helpers in `graph-arm.ts` / `query-builder.ts` / `index.ts`)
5. minimal-change-verifier: yes (1 new bounded context; additive `StorageBackend.graphArmSeed`; additive `retrieve.ts` envelope; no new runtime dep; no schema change; no Neo4j client)

→ spec advances; planning proceeds.

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: vertical slice, one tag, one commit,
binary acceptance. The spec locked the data contract, gate semantics, and
complexity envelope; bullets below test behaviors, not internal
decomposition. The per-ticket loop line is mandatory and verbatim (ADR-0012).

### T1. `[decision]` Resolve the spec's Open Questions

- **Affects:** `specs/p0-integration.md` (Open Questions section updated;
  answers optionally folded into the spec body where they unblock concrete
  behavior); no production code.
- **Acceptance:** the spec's Open Questions section is empty (or annotated
  "deferred to `<reason>`") for each of: (a) `graphArmSeed` interface
  placement (optional method on `StorageBackend` vs. separate injection on
  `retrieve.ts`); (b) CLI `extraction_records` cleanup SQL (archive table
  vs. `DELETE` vs. PG partition); (c) `RetrieveConfig` source of truth
  (extend `GraphragEnv` vs. introduce `cli.retrieval.*` env names);
  (d) T-007 end-to-end smoke harness convergence. The commit message body
  records all answers.
- **Why [decision]:** T2–T8 consume these answers; without them the code
  would either pick a wrong default or block waiting for input.
- **Commit:** 1 commit = this 1 task.

### T2. `[implementation]` Retrieval types + `rrfFuse` pure function + unit tests

- **Affects:** `src/core/retrieval/types.ts` (new — `ArmHit`, `ArmResult`,
  `FusedHit`, `RetrieveConfig`, error classes); `src/core/retrieval/rrf.ts`
  (new — pure RRF fusion: `score = w / (k + rank)`, k=60, w_vec=1, w_graph=1,
  tie-break vec-first then graph, deterministic on `chunk.id`);
  `tests/retrieval/rrf.test.ts` (new — k=60 math; 1:1 weights; tie-break;
  `limit` truncation; empty arms; double-count same `chunk.id`).
- **Acceptance:** `npx vitest run tests/retrieval/rrf.test.ts` exits 0; every
  fusion branch (vec-only / graph-only / both-arms / same-id / empty-vec /
  empty-graph / limit-truncation) is exercised by at least one test; the
  pure function is importable from `index.ts`/`tools/retrieve.ts` and from
  no other entry point (no leakage into `cli/extract.ts`).
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** T5
- **Commit:** 1 commit = this 1 task.

### T3. `[implementation]` Graph-arm pure logic + `query-builder` SQL composition + unit tests

- **Affects:** `src/core/retrieval/graph-arm.ts` (new — `runGraphArm()` pure
  orchestration: top-K seed entities → one-hop triples → chunks; honors
  `entityLinkTopK` / `candidateCap`; emits `ArmResult` with debug payload);
  `src/core/retrieval/query-builder.ts` (new — pure SQL string composition
  for the seed-entities + one-hop-triples queries; parameterized via
  `sql-template-tag`-free string with `$1..$N` placeholders; no live DB);
  `tests/retrieval/graph-arm.unit.test.ts` (new — `FakeEmbedder` +
  `FakePool` seam; top-K; candidate cap; valid_window both-side filter;
  soft-merge survivor-only; empty K).
- **Acceptance:** `npx vitest run tests/retrieval/graph-arm.unit.test.ts`
  exits 0; the SQL emitted by `query-builder.ts` for one-hop traversal is
  asserted to contain exactly one `JOIN chunks` (single-hop hard limit) and
  no recursive CTE / no second hop (`Success Criterion #8`); the unit tests
  do not require a live Postgres.
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** T4, T5
- **Commit:** 1 commit = this 1 task.

### T4. `[implementation]` `StorageBackend.graphArmSeed` (optional) + `PgvectorBackend` JOIN implementation

- **Affects:** `src/core/storage/backend.ts` (add OPTIONAL
  `graphArmSeed?: GraphArmStorage` to the interface — additive, never a
  breaking change); `src/core/storage/pgvector-backend.ts` (implement
  `graphArmSeed` with two SQL helpers: `seedEntitiesByEmbedding(embedding,
topK)` reusing `entities.embedding` cosine + `chunksByOneHopFromEntities(
seedIds, validAt, limit)` joining `triples` → `chunks` filtered by
  `triples.valid_window @> $validAt` AND `chunks.valid_window @> $validAt`);
  `tests/storage/graph-arm-pg.unit.test.ts` (new — verifies the SQL string
  emitted by `pgvector-backend` against the assertions in T3, plus
  parameter binding shape).
- **Acceptance:** `npm run typecheck` exits 0; `npx vitest run tests/storage/`
  exits 0; `grep -r 'neo4j\|neo4j-driver' dist/` returns 0 lines
  (`Success Criterion #14`); `MemoryBackend` continues to work unchanged
  (the optional method is not implemented, callers tolerate `undefined`).
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** T5
- **Commit:** 1 commit = this 1 task.

### T5. `[implementation]` `retrieve.ts` graph-arm wiring + RRF fusion + `degraded` envelope

- **Affects:** `src/core/retrieval/index.ts` (new — `assembleRetrievalResult()`
  orchestrator: vector arm → graph arm → RRF → emit `RetrieveOutputEnvelope`);
  `src/tools/retrieve.ts` (modified — additive envelope: optional `degraded`
  flag, optional `debug` payload gated on `DEBUG=1`; **input shape and
  `chunks[]` shape unchanged**); `src/core/config.ts` (extend `GraphragEnv`
  or add a `RetrieveConfig` sub-struct per T1 answer; startup validation per
  spec §Boundaries: reject negative / non-finite weights, `entityLinkTopK ≤
0`, `candidateCap < entityLinkTopK`, `graphArmFloor ≤ 0` with
  `ConfigError`); `tests/tools/retrieve-graph.test.ts` (new — contract
  preservation on empty P0 DB; `degraded=true` when graph arm < floor;
  `degraded=false` when ≥ floor; vector-only fallback when `graphArmSeed`
  is `undefined`).
- **Acceptance:** `npx vitest run tests/tools/retrieve-graph.test.ts` exits 0;
  `npm test` exits 0 (no regression in spec-1 9 / spec-2 15 / stage-1 6);
  `npm run build` produces `dist/cli/extract.js` + `dist/index.js` with
  neither importing the other; against an empty P0 DB the tool returns
  _exactly_ `{ chunks: [...] }` with no `degraded` / `debug` keys
  (`Success Criterion #4`).
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** T6, T7, T8
- **Commit:** 1 commit = this 1 task.

### T6. `[implementation]` Real Postgres integration tests

- **Affects:** `tests/integration/retrieval-pg.test.ts` (new — against a
  real Postgres 16 with spec-1 schema; reuses spec-2
  `search_path` isolation; covers: graph-arm JOIN path; `valid_window @>`
  on `triples`; `valid_window @>` on `chunks`; one-hop limit; soft-merge
  survivor-only (`Success Criterion #13`); 100 entities / 500 triples /
  1000 chunks fixture for latency-budget probe).
- **Acceptance:** `npx vitest run tests/integration/retrieval-pg.test.ts`
  exits 0 against a reachable Postgres; if Postgres is unreachable, the
  suite loudly skips with the project's documented Validation block (no
  silent skip); the latency probe (`Success Criterion #17`, +30% threshold)
  captures actual p95 numbers into the run summary (operator records in PR
  body if the threshold is approached).
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** none (terminal)
- **Commit:** 1 commit = this 1 task.

### T7. `[implementation]` CLI subprocess e2e + defensive contract (5 boundary classes)

- **Affects:** `tests/cli/extract-e2e-graph.test.ts` (new — subprocess
  spawn of `dist/cli/extract.js` + `dist/index.js` via host harness:
  `--dry-run` / `--since` / `--only-failed` / `--list-unmapped` exit codes
  0/1/2 unchanged; new envelope `degraded` exposed only when graph arm is
  active; concurrent CLI safety — two CLIs different `batch_id`s no
  duplicate triples (`Success Criterion #12`));
  `tests/defensive/retrieval-defensive.test.ts` (new — 5 boundary classes
  for `runGraphArm` / `rrfFuse` / retrieve graph-arm path: empty K=0,
  negative K=-1, overflow K=1e9, concurrent two CLIs, PG exception
  mid-call → `degraded:true`).
- **Acceptance:** `npx vitest run tests/cli/extract-e2e-graph.test.ts
tests/defensive/retrieval-defensive.test.ts` exits 0; each of the 5
  boundary classes has at least one test per public function
  (`Success Criterion #16`); concurrent CLI test asserts both `batch_id`s
  appear in `extraction_records`.
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** none (terminal)
- **Commit:** 1 commit = this 1 task.

### T8. `[implementation]` End-to-end smoke runbook + docs

- **Affects:** `docs/runbooks/integration-smoke.md` (new — manual
  end-to-end smoke steps: fresh Postgres → `ingest` one chunk with known
  content → `node dist/cli/extract.js --batch-size 1 --since <ts>` →
  `retrieve` via host harness → assert returned chunk has `source_ref`
  matching the ingested chunk's `source_ref`; env var names only, no
  secrets); `.gitignore` (add any smoke scratch files); no production code
  change beyond what T2–T7 already landed.
- **Acceptance:** the runbook documents a runnable sequence against a live
  Postgres + a live MCP host; operator executes it once and records the
  output in the PR description (`Success Criterion #15`). Not in CI.
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** none (terminal)
- **Commit:** 1 commit = this 1 task.

## Dependency graph

```
T1 [decision]
 ├──▶ T2 (retrieval types + rrfFuse) ────────────────────┐
 └──▶ T3 (graph-arm + query-builder) ───────────────────┐│
                                                        │├──▶ T4 (StorageBackend.graphArmSeed) ──┐
                                                        ││                                       │
                                                        │└──▶ T5 (retrieve wiring + envelope) ──┐│
                                                        │                                       ││
                                                                                                │├──▶ T6 (PG integration)
                                                                                                │├──▶ T7 (CLI e2e + defensive)
                                                                                                │└──▶ T8 (smoke runbook)
```

**Parallelizable:** T2 ∥ T3 (both after T1; mutually independent).
T4 ∥ T5 are both blocked by T2 + T3 (T4 additionally waits for T3; T5 waits
for T2 + T3 + T4). T6 ∥ T7 ∥ T8 (all after T5; mutually independent
terminals).

## Cross-references

- **Spec:** `specs/p0-integration.md` (binding contract; ACR verdict 5/5 yes embedded).
- **Spec 1:** `specs/p0-schema.md` — the four-table DDL this plan's graph arm queries.
- **Spec 2:** `specs/p0-extraction.md` — the entities/triples/embeddings this plan reads.
- **Wayfinder:** winter6205/iknow-memory#14 T-P0-integration (parent ticket).
- **Decisions consumed:** wayfinder #3 (six), #4 (seven), #6 (six), #7 (five), #5 (five) — all closed.
- **ADR-0001:** storage authority (Postgres authoritative, Neo4j read-only projection).
- **Evaluator (#15):** this plan ships the data path the eval gate measures; the harness itself is a separate ticket.

## Open Questions gate

T1 must close all four Open Questions in `specs/p0-integration.md` before T2
starts. If T1 cannot answer one of them, that question is escalated back to
the operator (via PR comment or direct reply) and T2 is paused.

## Complexity envelope reminder

Every file in this plan stays within the spec-3 binding envelope (inherited
from spec-2 §Architectural Constraints): function ≤ 40 lines target /
cyclomatic ≤ 10 hard, nesting ≤ 2, params ≤ 4, file ≤ 500 lines target /
≤ 1000 hard. `graph-arm.ts`, `query-builder.ts`, `retrieve.ts`,
`index.ts` decompose into named helpers rather than one long function.

## Isolation guard

`src/index.ts`, `src/tools/ingest.ts`, `src/cli/extract.ts` must NOT import
from `src/core/retrieval/*`. The only consumers of `src/core/retrieval/*`
are `src/tools/retrieve.ts` and `src/core/retrieval/index.ts` itself
(internal). T5's acceptance covers the negative test via
`tests/tools/retrieve-graph.test.ts` and a grep assertion (mirrors spec-2
`tests/cli/isolation.test.ts`).

## Tracker links

PR: winter6205/iknow-memory#28 (draft, spec + plan)
Tracer-bullet issues (label `ready-for-agent`, native blocking edges rendered):

- T1 → winter6205/iknow-memory#29
- T2 → winter6205/iknow-memory#30
- T3 → winter6205/iknow-memory#31
- T4 → winter6205/iknow-memory#32
- T5 → winter6205/iknow-memory#33
- T6 → winter6205/iknow-memory#34
- T7 → winter6205/iknow-memory#35
- T8 → winter6205/iknow-memory#36

Blocking edges (per §Blocks annotations):
T1 → T2/T3/T4/T5; T3 → T4; T4 → T5; T5 → T6/T7/T8.
