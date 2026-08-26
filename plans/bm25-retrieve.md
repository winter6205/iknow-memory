# Plan: BM25 Retrieve + SQL Graph-Arm Cleanup

**Goal:** Production `retrieve` becomes vector+BM25 hybrid (RRF), and the
Postgres SQL one-hop graph arm is archived off the default server path
without dropping the entities/triples ledger.
**Approach:** First cleanup bullet kills default `graphConfig` wiring and
leaves an archive note (#58 / #61). Then expand RRF/config to N-arm + BM25
defaults, land Postgres `tsvector` + MemoryBackend lexical parity, and wire
the orchestrator with fail-open + integration proof. Coarse slices on
purpose — no T1–T9 micro-split. Out of scope stays out: Neo4j, #15 eval,
multi-granularity chunking, new BM25 npm libs, hard-deleting `graph-arm.ts`
(Ask-first).
**Spec link:** `specs/bm25-retrieve.md` (binding; SC = Success Criteria; A# = assumptions)
**ACR:** all-yes (2026-08-26; block pasted below)
**Per-ticket loop (all bullets):** tdd → typecheck+tests →
verification-before-completion → one commit on the ticket branch
(end-of-round code-review once before merge)
**Tracker:** GitHub main path — parent [#62](https://github.com/winter6205/iknow-memory/issues/62);
cleanup also closes [#58](https://github.com/winter6205/iknow-memory/issues/58) intent.
Child `ready-for-agent` issues listed under Tasks.

## architecture-change-reviewer verdict

Pasted from `specs/bm25-retrieve.md` §Architecture Change Reviewer
(gate run 2026-08-26):

bounded-context-guardian: yes — work stays in existing capability slices (`tools`, `core/retrieval`, `core/storage`, `config`); no new technical-layer package; SQL arm archive is a wiring/policy change inside retrieval, not a new context; ledger stays in storage.
defensive-contract-validator: yes — Testing Strategy allocates empty / negative / overflow / concurrent / exception; Success Criteria 4–10 bind observable checks including ConfigError and fail-open.
error-handling-enforcer: yes — BM25 failure is typed fail-open with `degraded` (EXIT: return vector envelope); embed failure remains hard fail; config invalid → `ConfigError`; no empty catch prescribed.
complexity-anti-drift: yes — declared structure splits cleanup wiring, RRF N-arm pure function, PG lexical index, MemoryBackend lexical, orchestrator fuse; no god-module intent; graph-arm archive-in-place avoids a wide delete refactor in the same logical task sequence (sequenced in plan).
minimal-change-verifier: yes — one logical product outcome (production retrieve = vector+BM25 with SQL fake-graph archived); scope matches #57/#58/#59; no new runtime deps; per-bullet 1-commit sequencing deferred to `writing-plans`.

OVERALL: PASS — proceed with tracer bullets.

## 待写入

- After impl: CONTEXT **graph arm** stage → archived off production retrieve (if still “fires on production”).
- No ADR open/reopen from this plan.

## Tasks (ordered by dependency)

1. **Archive SQL graph arm off production retrieve (cleanup)** — tag: `[implementation]`
   - **Inherits:** Spec Boundaries Does §1; SC1–SC3; A12; research #61 — minimal off = stop passing `graphConfig` from default server wiring; ledger tables retained; archive-in-place (do not hard-delete `graph-arm.ts` without Ask-first); #57 route reset.
   - **Surface:** `src/index.ts` / retrieve tool wiring; retrieval regression tests; short archive note under `docs/` (runbook or handoff pointer).
   - **Acceptance:** SC1 — default `createServer` path never supplies `graphConfig` (regression test); SC2 — schema-p0 ledger tables untouched; SC3 — archive note committed; closes #58 intent when merged.
   - Status: [x] done — `buildRetrieveDeps` withholds `graphConfig`; guards in `tests/index.test.ts` (no PG) + `extract-e2e-graph` Case 4 (real PG, ledger preserved); note at `docs/runbooks/sql-graph-arm-archived.md`
   - Tracker: https://github.com/winter6205/iknow-memory/issues/63

2. **N-arm RRF + RetrieveConfig BM25 defaults** — tag: `[implementation]`
   - **Inherits:** SC4, SC7; A6–A7; #59 weights 0.8/0.2; RRF k=60 algorithm unchanged; extend arm union with `"bm25"`; enable flag default on; invalid env → `ConfigError`.
   - **Surface:** `src/core/retrieval` types + `rrf.ts`; `src/config.ts` + config unit tests.
   - **Acceptance:** SC4 unit tests green for N-arm fusion; SC7 fresh env asserts `w_vec=0.8`, `w_bm25=0.2`, BM25 enabled; negative env cases throw `ConfigError`.
   - Status: [x] done — `rrfFuse(arms[], cfg, limit)` is N-arm at k=60; `RetrieveConfig` gains `w_bm25` + `bm25Enabled`; defaults 0.8 / 0.2 / on with `ConfigError` on bad weight or flag
   - [parallel] with T1 on outcome graph; same-branch sequence T1 then T2 if both touch config comments only — prefer T1 first.
   - Tracker: https://github.com/winter6205/iknow-memory/issues/64

3. **Postgres `content_tsv` + BM25 search + ingest/backfill** — tag: `[implementation]`
   - **Inherits:** SC5–SC6; A3–A5; #59 production = tsvector+rank; `simple` config; no new BM25 npm dep (SC11).
   - **Surface:** `PgvectorBackend` / schema helpers; real-Postgres integration suite (loud skip if unreachable).
   - **Acceptance:** SC5 distinctive-token retrieve hit; SC6 new upserts maintain tsv and backfill makes old rows searchable; SC11 `package.json` free of wink/lunr/minisearch/flexsearch.
   - Status: [x] done — `chunks.content_tsv` generated over `simple` + GIN, added by `ensureTable` so startup backfills old rows; `PgvectorBackend.searchLexical` ranks with `ts_rank_cd`; proof in `tests/integration/bm25-pg.test.ts` (12 cases, loud skip)
   - [blocks: T2] — needs config weights/types available for search limit wiring if shared
   - Tracker: https://github.com/winter6205/iknow-memory/issues/65

4. **MemoryBackend lexical + orchestrator vector∥BM25 + fail-open** — tag: `[implementation]`
   - **Inherits:** SC8–SC10; A8–A9; concurrent arms; disable → exact `{ chunks[] }`; BM25 throw → `degraded: true`; embed failure still hard-fail.
   - **Surface:** `MemoryBackend`; `assembleRetrievalResult` / retrieve tool; retrieval unit tests.
   - **Acceptance:** SC8–SC10 green; Testing Strategy concurrent + exception rows covered; production path uses BM25 when enabled and graph remains off (SC1 still holds).
   - Status: [ ] pending
   - [blocks: T1, T2, T3]
   - Tracker: https://github.com/winter6205/iknow-memory/issues/66

5. **Suite closure + CONTEXT graph-arm stage refresh** — tag: `[implementation]`
   - **Inherits:** SC12–SC13; persist note in spec 待写入; isolation / no Neo4j fence.
   - **Surface:** full `npm test` / `npm run build`; `docs/CONTEXT.md` graph-arm stage line; map/handoff one-line frontier pointer if needed.
   - **Acceptance:** SC12–SC13; CONTEXT no longer claims SQL graph arm fires on production retrieve.
   - Status: [ ] pending
   - [blocks: T4]
   - Tracker: https://github.com/winter6205/iknow-memory/issues/67
