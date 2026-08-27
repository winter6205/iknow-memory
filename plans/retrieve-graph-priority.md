# Plan: Retrieve graph-priority ranking

**Goal:** Host `retrieve` `chunks[]` leads with Neo4j graph-arm hits when that arm returns any chunks; otherwise (and for leftover `limit` slots) vector+BM25 RRF — no equal-weight three-arm vote.
**Approach:** CONTEXT already records the ranking; this plan changes only `assembleRetrievalResult` fusion and tests that locked the old RRF order. Seed → PPR → `source_chunk_id` stays as shipped. Rerank (`plans/retrieve-rerank-llm.md`) is a later slice on top of this order.
**Spec link:** `specs/retrieve-graph-priority.md`
**Tracker:** **local markdown fallback** — remote cannot rely on GitHub issues. Operator index: `docs/handoff/wayfinder-tickets/retrieve-graph-priority.md`.
**ACR:** all-yes (copied from spec)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

bounded-context-guardian: yes — stays in retrieval capability; no new controllers/services tree; projection/extract untouched.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception; SC1–SC5 bind observables.
error-handling-enforcer: yes — skip / empty / throw paths already typed in neo4j-graph-arm; this spec keeps EXIT: fail-open vs skip vs fallback-rank; no new empty catch.
complexity-anti-drift: yes — declared split: compose `assembleRetrievalResult` from graph result + `rrfFuse(vector, bm25)` remainder/fallback, not one inlined three-arm vote; no god-file intent.
minimal-change-verifier: yes — one logical task (Host ranking graph-priority); CONTEXT flush is glossary persist for the same decision; no GC/rerank mixed in.

## Tasks (ordered by dependency)

1. **Record graph-priority Host ranking** — tag: `[decision]`
   - **Inherits:** spec assumptions 1–8; production ranking is graph-priority, not 0.7/0.15/0.15 three-arm RRF; ADR-0001 unchanged.
   - **Surface:** `docs/CONTEXT.md` ranking terms; `specs/retrieve-graph-priority.md`.
   - **Acceptance:** CONTEXT **hybrid retrieval** / **retrieve** / **Neo4j graph arm** / **RRF fusion** describe graph-priority; no new ADR.
   - Status: [x] done (flushed 2026-08-27 with the spec)
   - [blocks: none]

2. **Graph hits lead; empty graph falls back; remainder fills** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC7, SC9–SC10: non-empty graph arm order occupies the front of `chunks[]`; leftover `limit` slots from vector+BM25 `rrfFuse` (k=60), deduped by chunk id; empty graph (no seeds / empty PPR / no mapped chunks, not thrown) equals vector+BM25 RRF with **no** graph vote and **no** `degraded`; skip URI / `graphEnabled=false` unchanged (not degraded); graph throw → `degraded` + fallback RRF; envelope still `{ chunks[] }` (+ optional `degraded`); `w_graph` does not vote against vector when graph hits exist; SQL arm stays archived; levers `entityLinkTopK` / `candidateCap` / default `limit` unchanged.
   - **Surface:** retrieval orchestrator (`assembleRetrievalResult`); existing `rrfFuse` for vector+BM25 only; tests under retrieval / retrieve-graph / defensive retrieval that currently lock three-arm Host order.
   - **Acceptance:** unit tests on the assembler demonstrate SC1 (graph order beats vector), SC2 (fill + dedupe), SC3 (empty graph = dual RRF, not degraded), SC4–SC6 (skip / fail-open / disable), SC7 (envelope keys); `limit` ≤ 0 still empty; graph list longer than `limit` is truncated before fill so output length ≤ `limit`; vector ∥ BM25 ∥ graph still start together when enabled; `npm test` and `npm run build` exit 0 without live Neo4j.
   - Status: [ ] pending
   - [blocks: T1]

3. **Eval harness records arm set, not a three-arm vote** — tag: `[implementation]`
   - **Inherits:** spec SC8: `npm run eval:retrieve` still scores through `assembleRetrievalResult`; gold shape unchanged; CLI records which arms ran without requiring graph as an RRF voter.
   - **Surface:** eval retrieve CLI / its unit tests (`tests/cli/eval-retrieve.unit.test.ts` and related).
   - **Acceptance:** eval unit tests pass against graph-priority assembler output; a run with a wired graph ranker is allowed to report graph in `armSet` without asserting 0.7/0.15/0.15 fused order; `npm test` includes those tests green.
   - Status: [ ] pending
   - [blocks: T2]

## 待写入 (persist)

- (empty) — CONTEXT ranking terms already flushed with the spec.

## End of round

After T2–T3 land: code-review (Standards + Spec) on the impl diff, then verification-before-completion. Do **not** mix `plans/retrieve-rerank-llm.md` T2–T3 into these commits. Recommended product order: this plan **before** LLM rerank implementation (rerank permutes the list this plan defines).
