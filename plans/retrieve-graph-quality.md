# Plan: Retrieve and graph quality stack

**Goal:** Ship the remaining in-protocol retrieve and graph-quality path as ordered slices: rerank, ledger/projection fidelity, presets, evidence, graph extras — without new MCP tools or Host assembly.
**Approach:** Slice 0 reuses `plans/retrieve-rerank-llm.md` (do not mix that plan’s commits into later slices). Later slices attach to the same retrieve hook, extract CLI, and drain path. `balanced` copies today’s RetrieveConfig levers; `conservative` / `tokenmax` only change window size and neighbor width relative to that copy — exact integers stay implementer headroom. #15, multi-granularity chunking, Neo4j node embeddings, and SQL graph-arm revival stay out.
**Spec link:** `specs/retrieve-graph-quality.md`
**Tracker:** **local markdown fallback** — a PR / cloud agent **must not** assume GitHub issues are readable (`gh issue view` may fail). SSOT for bullets is this file; operator index: `docs/handoff/wayfinder-tickets/retrieve-graph-quality.md`. Spec: `specs/retrieve-graph-quality.md`. Optional GitHub numbers (T1–T11 ≈ #106–#116, map #103) are hints only — never required to start a slice.
**ACR:** all-yes (copied from spec)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

bounded-context-guardian: yes — retrieval / extraction / projection stay capability slices; no Host context-assembly module; no technical-layer top-level dirs.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception for the stack; each slice adds tests before code (writing-plans).
error-handling-enforcer: yes — skip vs fail-open vs `ConfigError` named per slice; embed hard-fail unchanged; EXIT on skip/fail-open.
complexity-anti-drift: yes — each slice is a helper on the existing assembler or extract/drain CLI, not a god-file rewrite.
minimal-change-verifier: yes **for this spec as one contract**; implementation **must** be one logical task per tracer bullet (writing-plans). Do not land slices 0–10 in one commit.

## Tasks (ordered by dependency)

1. **Temporary LLM rerank (slice 0)** — tag: `[implementation]`
   - **Inherits:** `specs/retrieve-rerank-llm.md` SC1–SC6; spec slice 0; default off; skip without `degraded` when creds absent; LLM throw fail-open + `degraded`; not Host chat model.
   - **Surface:** `RetrieveConfig` / retrieve orchestrator; extract Anthropic adapter (same trio). Follow `plans/retrieve-rerank-llm.md` T2–T3; do not re-open dedicated HTTP here.
   - **Acceptance:** those SC pass; `npm test` and `npm run build` exit 0 without live Anthropic; envelope still `{ chunks[] }` (+ optional `degraded`).
   - Status: [x] done (#118 MERGED 2026-08-28)
   - [blocks: none]

2. **Dedicated rerank HTTP** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC3, slice 1: same retrieve hook as T1; default off; missing URL skip not `degraded`; throw fail-open + `degraded`; not Host chat model.
   - **Surface:** retrieve orchestrator rerank port; config/env for HTTP endpoint. Temporary LLM adapter remains until this bullet replaces it on the hook.
   - **Acceptance:** off → identical to post-T1 order; on + no URL → skip, no `degraded`; fake HTTP permutation then `limit`; no live HTTP in `npm test`.
   - Status: [ ] pending
   - [blocks: T1]

3. **[parallel] Projection GC** — tag: `[implementation]`
   - **Inherits:** spec SC4, slice 2: ledger delete/retire → drain removes projection by id; empty graph still backfill; no graph tombstone as primary scheme. ADR-0001: Neo4j not SoR.
   - **Surface:** projection outbox / drain CLI (existing graph projection path).
   - **Acceptance:** after ledger delete and drain, Neo4j has no node/edge for that id (same Neo4j test style as the graph-arm suite); backfill of an empty graph still works.
   - Status: [ ] pending
   - [parallel]

4. **[parallel] Self-loop extract reject** — tag: `[implementation]`
   - **Inherits:** spec SC5, slice 3: row-level reject; not `--only-failed` force re-extract; no orphan entity for discarded loops.
   - **Surface:** extract CLI / triple write path.
   - **Acceptance:** self-loop is recorded as reject, no graph edge, `--only-failed` does not require re-extract; `npm test` exit 0.
   - Status: [ ] pending
   - [parallel]

5. **[parallel] Persist `merged_into`** — tag: `[implementation]`
   - **Inherits:** spec SC6, slice 4; P0c soft-merge; triples FK unchanged; `resolveCanonicalId` is the production read path.
   - **Surface:** extract merge/write path; entities ledger.
   - **Acceptance:** loser row stores `merged_into` = survivor; second extract is idempotent on that pointer (Postgres test helper already used by extract tests).
   - Status: [ ] pending
   - [parallel]

6. **Mode bundles on retrieve** — tag: `[implementation]`
   - **Inherits:** spec SC7, slice 5: names `conservative` | `balanced` | `tokenmax`; env default + optional retrieve input; unknown name → `ConfigError` or typed tool error. **balanced** copies current RetrieveConfig (entityLinkTopK 8, candidateCap 50, w_vec 0.7, w_bm25 0.15, Host limit default 10). **conservative** narrower candidate window and neighbor N=0 vs balanced. **tokenmax** wider candidate window and neighbor N≥1 vs balanced. Exact conservative/tokenmax integers are implementer headroom inside that shape. Not a new MCP tool.
   - **Surface:** `RetrieveConfig` / retrieve tool input.
   - **Acceptance:** unknown preset rejected; default bundle is `balanced` and matches current levers; envelope unchanged.
   - Status: [ ] pending
   - [blocks: T1]

7. **Neighboring chunk evidence** — tag: `[implementation]`
   - **Inherits:** spec SC8, slice 6: ±N same `source_ref` from Postgres after ranking/rerank; default N from bundle (balanced 1); N=0 identity; chunks never enter Neo4j; still honor `limit` or a documented cap.
   - **Surface:** retrieve orchestrator; chunk ledger (Postgres).
   - **Acceptance:** three-chunk source, hit middle, N=1 can include neighbors; no Neo4j writes; N=0 unchanged order aside from existing ranking.
   - Status: [ ] pending
   - [blocks: T6]

8. **Node embedding in retrieve** — tag: `[implementation]`
   - **Inherits:** spec SC9, slice 7: optional seed/score from Postgres `entities.embedding`; throw → today’s graph-priority (or RRF fallback) + `degraded`; no Neo4j vector index / node embedding properties.
   - **Surface:** retrieve orchestrator; entities ledger embeddings (already used for merge).
   - **Acceptance:** fake store throw → pre-embedding ranking + `degraded`; path off → identical to post-T1 graph-priority retrieve.
   - Status: [ ] pending
   - [blocks: T1]

9. **Community summaries for topic retrieve** — tag: `[implementation]`
   - **Inherits:** spec SC10, slice 8: Louvain on GDS; summaries on Postgres ledger; retrieve may lead with summary chunks when the preset enables topic retrieve; failure fail-open (no summaries, retrieve still returns); Host still generates the answer.
   - **Surface:** graph projection / GDS; extract or a graph CLI for index-time summary; retrieve orchestrator.
   - **Acceptance:** community off or empty communities → order unchanged vs post-T8 (or post-T1 if T8 off); fail-open does not hard-fail retrieve; `npm test` without live Neo4j still exit 0 when the path is off.
   - Status: [ ] pending
   - [blocks: T6]

10. **Causal relations and fact supersession** — tag: `[implementation]`
    - **Inherits:** spec SC11, slice 9: causal `relation_norm` in vocabulary; extract may emit them; consolidate CLI dry-run default; apply writes `superseded_by` and closes `valid_window`; retrieve already filters `valid_at`.
    - **Surface:** extraction vocabulary; extract write; new or existing operator CLI beside extract; retrieve unchanged except temporal filter already there.
    - **Acceptance:** a superseded fact with `valid_until` before `valid_at` does not appear in graph-mapped chunks; dry-run apply does not write; apply does.
    - Status: [ ] pending
    - [blocks: T5]

11. **Optional projection wait** — tag: `[implementation]`
    - **Inherits:** spec SC12, slice 10: default off; on waits for drain up to timeout; timeout or drain error → fail-open + `degraded`; no transaction-internal Neo4j write.
    - **Surface:** retrieve config/input; drain/outbox.
    - **Acceptance:** wait off → no drain wait; wait on + timeout → pre-wait ranking + `degraded`; `npm test` without live Neo4j exit 0 when wait is off.
    - Status: [ ] pending
    - [blocks: T3]

## 待写入 (persist)

(none — CONTEXT flush already landed with the spec)

## End of round

After T1–T11 land: code-review (Standards + Spec) on the full impl diff vs this plan, then verification-before-completion. Do not mix #15 extraction F1 into these commits.
