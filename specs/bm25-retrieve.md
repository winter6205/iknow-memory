# Spec: BM25 Retrieve + SQL Graph-Arm Cleanup

> **Status:** draft → ACR gate in this file (§Architecture Change Reviewer).
> **Source tickets:** winter6205/iknow-memory#62 (BM25 impl), #58 (SQL graph-arm off; **folded into this contract as cleanup**), #59 (BM25 shape), #57 (route reset), #60/#61 (research).
> **Wayfinder parent:** winter6205/iknow-memory#1.
> **Predecessor:** `specs/p0-integration.md`, `specs/p0-wiring-closure.md` (graph arm + RRF exist; this spec re-routes production retrieve).
> **Assumption gate:** confirmed 2026-08-26 (A1–A14 below), plus operator addendum: **SQL 图臂归档清理写进本契约**.

## Objective

Make production `retrieve` a **vector + BM25** hybrid (RRF), and **archive the Postgres SQL one-hop graph arm off the production path** so operators no longer get a silent “fake dual-arm” retrieval story.

**Who uses it:** MCP hosts calling `retrieve`; implementers following `plans/bm25-retrieve.md`.

**Success looks like:**

- Default production retrieve fuses vector + BM25; SQL graph arm does not run on the default server path.
- Entities/triples remain as the Postgres ledger; no Neo4j work in this spec.
- `npm test` green; MemoryBackend can exercise hybrid without Postgres score parity.

## Glossary

Exact copy / stage notes from `docs/CONTEXT.md` (SSOT) — not redefined here:

- **BM25** — Okapi BM25 lexical ranking (k1=1.2, b=0.75) over tokenized chunk text; query↔chunk lexical relevance. Production shape: Postgres `tsvector`+rank at ingest; MemoryBackend same-contract lightweight inverted index; default on, configurable off, fail-open to vector-only. (_Stage: decided #59; this spec implements._)
- **hybrid retrieval** — multi-arm recall fused by RRF (k=60). Near-term production: vector + BM25 at 0.8 / 0.2. (_#59_)
- **RRF fusion (k=60)** — rank-based fusion; this spec extends the arm set (not the algorithm).
- **vector search** — cosine over chunk embeddings.
- **graph arm** — P0 SQL one-hop JOIN path. **This spec archives it off production retrieve** (route reset #57 / task #58); ledger tables stay.
- **degraded=true** — optional envelope flag when an optional arm fails or under-floors; vector results still returned.
- **RetrieveConfig** — frozen-on-read retrieval config from `GraphragEnv`.
- **chunk**, **valid_window** / **valid_at**, **retrieve**, **ingest** — as in CONTEXT.

## Confirmed assumptions (gate)

1. This PR delivers **`specs/bm25-retrieve.md` + `plans/bm25-retrieve.md`** (+ CONTEXT/map pointers as needed). Implementation lands in follow-up commits/PRs against the plan bullets — **except** the contract below is the buildable source of truth for both BM25 and SQL-arm cleanup.
2. Stack unchanged: TS strict ESM · Node ≥20 · Vitest · existing `pg.Pool` / `StorageBackend`. **No** wink/minisearch runtime deps.
3. Production BM25 = Postgres `tsvector` + `ts_rank` / `ts_rank_cd`. Okapi k1/b aligned when expressible; else document approximation in Success Criteria (not a fail).
4. Text config: built-in Postgres config, prefer **`simple`** (no `english` stem lock-in). **No** Chinese segmenter extension in this spec.
5. Index: `chunks` gains `content_tsv` (generated column or ingest-maintained) + GIN; maintained on ingest; existing rows backfilled via `ensureTable` / one-shot SQL. Retrieve does not full-scan to build the index.
6. Orchestrator: RRF / `ArmHit.arm` become **N-arm**-capable (`"vector" | "bm25"` required; `"graph"` type may remain for archived code / tests but **must not** drive default production retrieve).
7. Defaults: `w_vec=0.8`, `w_bm25=0.2`; BM25 **enabled by default**; env-configurable off → vector-only. Changing defaults post-ship is Ask-first.
8. BM25 fail-open → vector results; set `degraded=true` when BM25 was attempted and failed. Vector-only (BM25 disabled) must **not** set `degraded` solely for that reason.
9. MemoryBackend: same-contract lightweight BM25 for tests; score distribution need not match Postgres.
10. MCP wire: `retrieve` still primarily `{ chunks[] }`; no new tool; ingest public fields unchanged (storage may maintain tsv internally).
11. Out of scope: Neo4j, reopening SQL fake-graph as a product arm, #15 eval, multi-granularity chunking, cross-encoder rerank, cosine re-score polish.
12. **SQL graph-arm cleanup is in scope** (operator addendum + #58): production path must stop running the SQL one-hop arm; minimal proven approach from #61 is stop passing `graphConfig` at server wiring (or equivalent explicit default-off). Ledger (`entities` / `triples` / …) **retained**.
13. Tests: `npm test` green; RRF N-arm unit tests; MemoryBackend hybrid unit tests; ≥1 real Postgres integration test proving literal BM25 hit after ingest; no real LLM.
14. Branch/PR targets #62 (and references #58); artifacts at `specs/bm25-retrieve.md`, `plans/bm25-retrieve.md`.

## Boundaries

- **Does:**
  1. **Cleanup / archive SQL graph arm on production retrieve** (#58):
     - Default server path does **not** invoke SQL graph-arm fusion (research #61: stop passing `graphConfig` from `src/index.ts` / equivalent).
     - Document the SQL one-hop arm as **archived** (code comments + short runbook/note): kept only as non-default / test-facing residue until Neo4j true graph; not a product transition bridge.
     - Do **not** drop ledger tables; do **not** polish confidence ranking / candidateCap “fake graph” behavior.
     - Existing graph-arm unit tests may remain if they inject `graphConfig` explicitly; production default must be graph-off.
  2. **BM25 production arm** (#59/#62):
     - Ingest-maintained lexical index; retrieve BM25 arm; RRF fuse with vector; defaults and fail-open as assumed.
     - MemoryBackend parity for hybrid tests.
     - `RetrieveConfig` gains BM25 weight + enable switch; vector default weight becomes 0.8 when BM25 path is the production hybrid story (graph weights unused on default path).
- **Confirms with human:** changing default weights after ship; adding Chinese text-search extensions; deleting `graph-arm.ts` entirely (Ask-first — default is archive-in-place, not hard delete).
- **Out of this spec:** Neo4j projection/PPR; #15 eval; chunker multi-granularity; re-enabling SQL graph as product; new MCP tools; new npm BM25 libraries.

## Success Criteria

Binary; each maps to a command or measurable check.

1. **Production default has no SQL graph arm:** With stock `createServer` / `src/index.ts` wiring (no test-only `graphConfig` injection), a retrieve that would previously fuse graph+vector returns **vector-only or vector+BM25** — never graph-arm hits. Observable via unit/integration assert on envelope `debug`/arm contributions or by proving `graphConfig` is unset on the tool deps. `npm test` includes a regression that fails if default wiring reintroduces `graphConfig`.
2. **Ledger preserved:** After cleanup, `entities` / `triples` / `entity_aliases` / `extraction_records` still exist and extraction CLI still writes them (`ensureTable` / schema-p0 unchanged in intent). No migration drops those tables.
3. **Archive note present:** A short “SQL graph arm archived” note exists in-repo (runbook section or `docs/` pointer linked from map/CONTEXT) stating production retrieve no longer uses the SQL one-hop arm; Neo4j remains the future graph home.
4. **RRF is N-arm:** `rrfFuse` accepts vector + BM25 (and may ignore unused graph). Unit tests cover: BM25-only contribution ranks into fusion; dual-arm soft-merge on shared chunk ids; `limit<=0` → `[]`.
5. **Postgres BM25 path:** On real Postgres, ingest ≥1 chunk containing a distinctive token; retrieve with a query that is a poor semantic neighbor but shares that token returns that chunk among top results when BM25 is enabled (FakeEmbedder allowed). Exit 0; loud skip if Postgres unreachable (project convention).
6. **Ingest maintains tsv:** After upsert, `content_tsv` (or equivalent) is non-null for new chunks; backfill leaves pre-existing rows searchable without manual DBA steps beyond starting the backend (`ensureTable` or documented auto-backfill).
7. **Default hybrid weights:** Fresh env (no override) yields `w_vec=0.8`, `w_bm25=0.2`, BM25 enabled. Asserted in config unit tests.
8. **Disable BM25 → vector-only:** With BM25 disabled via config, envelope is exactly `{ chunks: [...] }` (no `degraded` solely from disable). Existing vector ranking behavior remains.
9. **BM25 fail-open:** Injected BM25 failure yields vector chunks + `degraded: true`; call does not throw.
10. **MemoryBackend hybrid:** Without Postgres, MemoryBackend retrieve with BM25 enabled returns fused results in unit tests (FakeEmbedder).
11. **No new runtime BM25 npm dependency:** `package.json` dependencies do not gain wink-bm25 / lunr / minisearch / flexsearch solely for this feature.
12. **Isolation / Neo4j fence unchanged:** `tests/cli/isolation*.test.ts` stay green; no Neo4j runtime link (`rg -il neo4j dist/` empty after build, same spirit as prior specs).
13. **Full suite:** `npm test` exits 0 on the implementation branch after all plan bullets.

## Open Questions

(none) — assumption gate + #59/#58 resolutions cleared forks. Residual implementer headroom (exact column DDL, `ts_rank` vs `ts_rank_cd`, whether `graph-arm.ts` stays imported only from tests) is left open under Boundaries → Confirms / headroom.

## Inherits / Changes

**Inherits:**

- Stack & commands: TypeScript strict ESM, Node ≥20, Vitest, `npm test` / `npm run build` (as in prior P0 specs).
- Storage: Postgres 16 + pgvector; `PgvectorBackend.ensureTable` + `schema-p0` ledger tables.
- Retrieval: existing `assembleRetrievalResult`, `rrfFuse`, `RetrieveConfig`, fail-open envelope pattern from `specs/p0-integration.md` / wiring-closure.
- Route decisions: #57 (off SQL graph → BM25 → Neo4j); #59 (BM25 shape); #61 (minimal off = stop `graphConfig`); #60 (must extend types+RRF+orchestrator).
- Hard contracts: TS strict ESM · env names not hardcoded as secrets · no iknow runtime import.

**Changes:**

- Production retrieve path: **archive SQL graph arm**; **add BM25 arm** as default hybrid partner to vector.
- `RetrieveConfig`: add `w_bm25` + BM25 enable flag; production default weights become vector 0.8 / BM25 0.2 (graph weight unused on default path).
- `chunks` storage: add lexical index column + GIN; ingest maintenance + backfill.
- `ArmHit.arm` / RRF: N-arm including `"bm25"`.
- `degraded` semantics: also applies to BM25 attempt-failure (not only graph floor).

## Tech Stack

| Layer    | Choice                                        | Reason                   |
| -------- | --------------------------------------------- | ------------------------ |
| Language | TypeScript strict ESM                         | Existing                 |
| Runtime  | Node ≥20                                      | `package.json#engines`   |
| Tests    | Vitest; FakeEmbedder; real Postgres for one   | Existing                 |
| Storage  | Postgres + pgvector; in-process MemoryBackend | Existing                 |
| Lexical  | PG `tsvector` / in-memory inverted index      | #59; no new npm BM25 lib |
| Graph    | SQL arm archived off prod; Neo4j out of scope | #57/#58                  |

## Commands

```bash
npm test
npm run build
# Real Postgres BM25 integration (loud skip if DB unreachable) — implemented under plans bullets
```

## Testing Strategy (5 boundary classes)

| Class      | Coverage in this spec                                                               |
| ---------- | ----------------------------------------------------------------------------------- |
| empty      | Empty query / empty BM25 hits → vector path still returns; disable-BM25 vector-only |
| negative   | Invalid weight / enable env → `ConfigError` at startup                              |
| overflow   | Large candidate lists truncated by retrieve `limit`; RRF `limit` slice              |
| concurrent | Vector ∥ BM25 arms run concurrently when both enabled (start-order or timing seam)  |
| exception  | BM25 throws → fail-open + `degraded`; embed failure still hard-fails before arms    |

## Architecture Change Reviewer

Planned blast radius (implementation; ≥3 files):

- `src/index.ts` — stop default `graphConfig` pass-through (SQL arm archive)
- `src/tools/retrieve.ts` / `src/core/retrieval/index.ts` — hybrid orchestration vector+BM25
- `src/core/retrieval/rrf.ts` + `types.ts` — N-arm + `bm25`
- `src/config.ts` — `w_bm25`, enable flag, default 0.8/0.2
- `src/core/storage/pgvector-backend.ts` (+ schema helpers) — `content_tsv` + search
- `src/core/storage/memory-backend.ts` — lightweight BM25
- tests under `tests/` for config, rrf, retrieval, pg integration
- docs note for SQL arm archive; CONTEXT stage lines if still stale after impl

### Verdict (pre-plan gate · 2026-08-26)

bounded-context-guardian: yes — work stays in existing capability slices (`tools`, `core/retrieval`, `core/storage`, `config`); no new technical-layer package; SQL arm archive is a wiring/policy change inside retrieval, not a new context; ledger stays in storage.
defensive-contract-validator: yes — Testing Strategy allocates empty / negative / overflow / concurrent / exception; Success Criteria 4–10 bind observable checks including ConfigError and fail-open.
error-handling-enforcer: yes — BM25 failure is typed fail-open with `degraded` (EXIT: return vector envelope); embed failure remains hard fail; config invalid → `ConfigError`; no empty catch prescribed.
complexity-anti-drift: yes — declared structure splits cleanup wiring, RRF N-arm pure function, PG lexical index, MemoryBackend lexical, orchestrator fuse; no god-module intent; graph-arm archive-in-place avoids a wide delete refactor in the same logical task sequence (sequenced in plan).
minimal-change-verifier: yes — one logical product outcome (production retrieve = vector+BM25 with SQL fake-graph archived); scope matches #57/#58/#59; no new runtime deps; per-bullet 1-commit sequencing deferred to `writing-plans`.

OVERALL: PASS — hand to `writing-plans`.

## 待写入 (persist)

- CONTEXT already updated for BM25/hybrid/RRF stage after #59; after implementation, refresh **graph arm** stage line to “archived off production retrieve (#58/#62)” if still saying it fires on production.
- No new ADR required for this contract (reversible archive-in-place + tsvector choice recorded in #59 + this spec).

## Hand-off

- Spec path: `specs/bm25-retrieve.md`
- Next: `writing-plans` → `plans/bm25-retrieve.md`
- Tracker parent: #62 (BM25); cleanup fulfills #58 intent inside the same plan
