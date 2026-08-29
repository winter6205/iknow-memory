# Plan: Retrieve community summaries

**Goal:** Index-time Louvain writes **community** summaries on the Postgres ledger; retrieve may **include** those summaries in `{ chunks[] }` when the mode-bundle topic-retrieve switch is on, without moving a non-empty graph-arm prefix.
**Approach:** Three vertical slices after quality-stack T6 (topic-retrieve switch exists): persist the ledger, run Louvain+summary as an operator job with typed EXIT, then read the ledger on retrieve (fake store in unit tests). Hyperparameters, summary prompt, metadata key spelling, and which presets default the switch on stay implementer headroom. No new MCP tools. Host still writes the answer.
**Spec link:** `specs/retrieve-community.md`
**Tracker:** **local markdown only** — operator 2026-08-30: do not `gh issue create` / `gh issue view`. SSOT for bullets is this file; parent slot remains `plans/retrieve-graph-quality.md` T9; operator index: `docs/handoff/wayfinder-tickets/retrieve-community.md`.
**ACR:** all-yes (copied from spec after 2026-08-30 review)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

bounded-context-guardian: yes — graph projection + retrieval hits; no Host assembly module; no technical-layer top-level dirs.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception.
error-handling-enforcer: yes — job: typed failure + EXIT (rerun); URI skip at job, not retrieve `degraded`; retrieve: off / empty identity; ledger read throw fail-open, no retrieve Louvain.
complexity-anti-drift: yes — Louvain/summary job and a retrieve read-helper, not inlined into a god assembler.
minimal-change-verifier: yes — one logical task per tracer bullet below; not mixed with quality T6/T7/T8/T10/T11 in those commits.

## Tasks (ordered by dependency)

External blocker: quality-stack **T6** (mode bundle + topic-retrieve **switch**). Do not ship retrieve hits before that switch exists (`specs/retrieve-community.md` A6).

1. **Persist community summary ledger** — tag: `[implementation]`
   - **Inherits:** spec A3, SC2: summaries are Postgres ledger rows; empty ledger with topic switch on → identity retrieve, no throw, no `degraded` solely from empty ledger. ADR-0001: Neo4j is not SoR for summary text. Chunks never enter Neo4j.
   - **Surface:** existing Postgres / P0 schema family and storage backend used by retrieve.
   - **Acceptance:** a summary row can be written and read by community id; empty ledger is a legal retrieve input; `npm test` path that covers this store does not require live GDS.
   - Status: [x] done (ae57170, 2026-08-29)
   - [blocks: quality T6]

2. **Index-time Louvain and summary job** — tag: `[implementation]`
   - **Inherits:** spec A2, A7, A11, SC5: Louvain via Neo4j GDS at **index time** only; typed job failure, no empty `catch`; EXIT: operator reruns the job; missing URI → skip Louvain (not retrieve `degraded`); retrieve never runs Louvain or summary LLM. Extract Anthropic trio may write summaries; not the Host chat model. Hyperparameters and prompt are open.
   - **Surface:** existing graph projection / GDS path and operator CLI family (extract-adjacent or graph CLI).
   - **Acceptance:** missing URI does not attempt Louvain; a thrown GDS or summary LLM fails the job with a typed error and non-zero or documented skip exit; successful run leaves ledger rows; retrieve unit tests still do not call this job.
   - Status: [x] done (bdf9391 + fbb07ca, 2026-08-29)
   - [blocks: T1]

3. **[parallel] Retrieve includes ledger summaries** — tag: `[implementation]`
   - **Inherits:** spec A4, A5, A8, SC1–SC4, SC6–SC7: gate is the topic-retrieve **switch** only (not a query-class detector); include summaries in `chunks[]` with a typed metadata flag; do **not** displace a non-empty graph-arm prefix; switch off → identical order to post-T8 (or post-graph-priority if node-embedding seeds are off); ledger **read** throw → fail-open, no Host throw, `degraded` not required this slice; envelope `{ chunks[] }` (+ optional `degraded`); `limit` holds. Which presets default the switch on is open (T6 headroom).
   - **Surface:** existing retrieve orchestrator / `RetrieveConfig` (same family as other retrieval flags).
   - **Acceptance:** unit tests with a fake ledger: off → identity; on + empty → identity; on + fixtures → at least one typed summary item and graph-arm hits still lead when present; read throw → pre-community list, no throw; `npm test` and `npm run build` exit 0 without live Neo4j GDS when the path is off.
   - Status: [x] done (9bd3ca6, 2026-08-29)
   - [parallel]
   - [blocks: T1, quality T6]

## 待写入 (persist)

(none — CONTEXT **community** already flushed with the parent quality spec. Optional later: **degraded=true** if retrieve read-fail should set the flag; **mode bundle** topic-retrieve switch once T6 names it.)

## End of round

After T1–T3 land: code-review (Standards + Spec) vs `specs/retrieve-community.md`, then verification-before-completion. Do not mix quality T7/T8/T10/T11 or #15 into these commits. Claim a bullet by flipping **Status** in this file. Do not open GitHub issues.
