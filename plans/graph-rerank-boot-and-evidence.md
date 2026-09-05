# Plan: Graph / rerank fail-start, process logs, evidence span persist

**Status（2026-09-05）：** PR [#184](https://github.com/winter6205/iknow-memory/pull/184) 已合入 `main`。T1–T4 闭合。

**Goal:** Default-on graph and rerank refuse to start without deps; eval shares that config; extract persists only grounded evidence spans; extract/embed emit secret-free process logs.
**Approach:** Config boot first so server and eval tell the same truth; schema+gate as a parallel write path; logs as a parallel observability path. MCP catalog is out (`specs/mcp-tool-surface.md`).
**Spec link:** `specs/graph-rerank-boot-and-evidence.md`
**Tracker:** **local markdown fallback** — operator SSOT for this round is `specs/` + `plans/` in the work tree (GitHub map issues for this upgrade were closed; do not reopen).
**ACR:** all-yes (copied from architecture-change-reviewer · 2026-09-05)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch. End-of-round code-review after all bullets land.

## ACR

bounded-context-guardian: yes — work stays in existing slices (`src/config.ts`, `src/cli/eval-retrieve.ts`, `src/core/extraction` persist / `dedup.ts`, `src/core/storage/schema-p0.ts` triples DDL, `src/logging.ts`); no `controllers/`/`services/`/`repositories/` tree; schema stays on Postgres `triples`; persist applies the substring gate in extraction rather than reverse-importing `extraction-eval`.
defensive-contract-validator: yes — spec Testing Strategy names empty / negative / overflow / concurrent / exception, bound to SC1–SC10.
error-handling-enforcer: yes — boot missing graph/rerank deps is typed `ConfigError` via `loadEnv()`; retrieve-time Neo4j/rerank throw stays fail-open + `degraded`; ungrounded triple is reject + mark-and-continue, not empty catch or null row.
complexity-anti-drift: yes — declared split is a config fail-start helper, persist grounding + `evidence_span` column plumbing, and a small log field whitelist on `createLogger`; reuse the `isGrounded` predicate rather than a second substring algorithm or a god rewrite of `loadEnv`/`extract`.
minimal-change-verifier: yes — one SPECIFY slice (honest default-on + evidence persist + process logs); MCP catalog, F1 lock, session memory, and Host citations are out; tracer-bullet commits belong here.

OVERALL: PASS — hand to writing-plans.

## Tasks (ordered by dependency)

1. **Fail-start when graph or rerank is on and deps are missing** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC3, SC6, assumption 13; ADR-0006; ADR-0005 rules 2–4 unchanged; explicit off still starts; retrieve-time throw still fail-open + `degraded`. Vector / BM25 / ES boot contracts unchanged.
   - **Surface:** existing `loadEnv()` / `GraphragEnv` (`src/config.ts`) and server construct (`src/index.ts` already maps `ConfigError` to process exit).
   - **Acceptance:** default-on with no Neo4j URI → `loadEnv()` throws `ConfigError`; default-on with production rerank deps missing → same; `graphEnabled=false` without Neo4j → load succeeds; `npm test` exits 0 without live Neo4j.
   - Status: [x] closed — PR #184

2. **Eval retrieve uses the same `loadEnv()` switches** — tag: `[implementation]`
   - **Inherits:** spec SC4–SC5; P@5 / R@5 ruler is the default-on path; gold size unchanged; no MRR/nDCG gate; no hardcoded `graphEnabled: false` / `rerankEnabled: false`.
   - **Surface:** existing `eval:retrieve` CLI (same `loadEnv()` family as the server).
   - **Acceptance:** that CLI source does not assign those two flags false; a default-on env keeps both true; missing graph/rerank deps fail the CLI the same way as the server; existing gold harness shape still writes `eval/baseline/retrieve-p5.json` when deps are present.
   - Status: [x] closed — PR #184
   - [blocks: T1]

3. **[parallel] Persist grounded evidence spans on triples** — tag: `[implementation]`
   - **Inherits:** spec SC7–SC9, assumptions 10–12; substring gate only (`chunkText.includes(evidenceSpan)` and non-empty); other `filterTriple` reasons stay eval-only; merge does not overwrite survivor `evidence_span`; retrieve envelope has no span on Host `chunks[]`.
   - **Surface:** existing triples schema + extract persist/upsert (`src/core/storage` P0 schema and `src/core/extraction` write path).
   - **Acceptance:** ungrounded / empty span does not insert; grounded insert stores `triples.evidence_span`; one ungrounded sibling in a batch does not block a grounded one; `retrieve` success JSON has no evidence field on chunks; existing DBs gain the column via additive DDL.
   - Status: [x] closed — PR #184
   - [parallel]

4. **[parallel] Structured extract and embed process logs** — tag: `[implementation]`
   - **Inherits:** spec SC10, assumption 9; fields: time, chunk id, model id, latency, success/fail, counts; whitelist; no secrets; no raw chunk text; `redactDiagnostic` stays URL/credential redaction, not an ingest-body scanner; do not mask stored chunk text.
   - **Surface:** existing `createLogger` / extract CLI and embed call sites (ingest and extract).
   - **Acceptance:** one extract chunk and one embed call emit those fields; payload has no API key and no chunk body; `npm test` and `npm run build` exit 0.
   - Status: [x] closed — PR #184
   - [parallel]

## 待写入 (persist)

- ~~CONTEXT terms + ADR-0006 + ADR-0005 rule-1 exception~~ flushed 2026-09-05 with SPECIFY persist (domain-modeling). Plan persist: skip.

## End of round

After T1–T4 land: `arthurpower:code-review` then `arthurpower:verification-before-completion` on the whole slice. Do not start `specs/mcp-tool-surface.md` until the catalog is confirmed.
