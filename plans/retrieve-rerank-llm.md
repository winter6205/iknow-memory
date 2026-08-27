# Plan: Retrieve LLM rerank (temporary main-model adapter)

**Goal:** Optional post-ranking reorder of retrieve chunks using the extract Anthropic main model, default off, fail-open, no Host chat model.
**Approach:** Record the temporary-adapter decision; add an enable gate that shares extract Anthropic credentials; wire a reorder step after `assembleRetrievalResult` ranking; keep envelope and skip/fail-open observable. Dedicated cross-encoder HTTP is out of this plan.
**Spec link:** `specs/retrieve-rerank-llm.md`
**Tracker:** **local markdown fallback** — remote session cannot rely on GitHub issues (`gh issue view`). SSOT for bullets is this file; operator index: `docs/handoff/wayfinder-tickets/retrieve-rerank-llm.md`.
**ACR:** all-yes (copied from spec)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

bounded-context-guardian: yes — retrieval + existing extract LLM adapter; no Host coupling; no technical-layer dirs.
defensive-contract-validator: yes — Testing Strategy covers empty / negative / overflow / concurrent / exception.
error-handling-enforcer: yes — skip (no creds) vs fail-open (throw) named; embed still hard-fail; EXIT on skip/fail-open.
complexity-anti-drift: yes — rerank is a helper after ranking, not inlined into a god `assembleRetrievalResult`.
minimal-change-verifier: yes — one logical task (temporary LLM rerank); not mixed with graph-priority impl or projection GC.

## Tasks (ordered by dependency)

1. **Record temporary main-model rerank** — tag: `[decision]`
   - **Inherits:** spec: extract Anthropic trio is the temporary reranker; not Host; not cross-encoder this slice; default off; fail-open on LLM failure; skip without `degraded` when enable-on but creds absent.
   - **Surface:** `docs/CONTEXT.md` **rerank** (persist already flushed this turn); this plan file.
   - **Acceptance:** CONTEXT **rerank** states the temporary adapter, default off, fail-open, and that a dedicated rerank transport is later; commit may be docs-only.
   - Status: [x] done (CONTEXT flush 2026-08-27)
   - [blocks: none]

2. **Rerank enable gate in retrieve config** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC2: off → no LLM; on without Anthropic trio → skip, not `degraded`.
   - **Surface:** existing `RetrieveConfig` / `src/config.ts` env load (same family as other `GRAPHRAG_MEMORY_RETRIEVAL_*` flags). Anthropic trio already used by extract CLI — reuse, do not invent a second product key.
   - **Acceptance:** config tests: default enable is false; enable true with missing key/model/base URL is a skip (server still starts); invalid enable flag is `ConfigError` if the project already treats retrieval booleans that way.
   - Status: [ ] pending
   - [blocks: T1]

3. **LLM permutation on retrieve candidates** — tag: `[implementation]`
   - **Inherits:** spec SC3–SC6: valid permutation applied then `limit`; throw/garbage → original order + `degraded`; envelope unchanged; tests without live Anthropic.
   - **Surface:** `src/core/retrieval` orchestrator (`assembleRetrievalResult`); extract `LLMClient` or a sibling port — implementer chooses, must not import Host.
   - **Acceptance:** fake LLM reorder is visible on `{ chunks[] }`; empty/negative limit paths do not call LLM; overflow only sends prefix W; two concurrent retrieves do not scramble each other’s order; `npm test` and `npm run build` exit 0.
   - Status: [ ] pending
   - [blocks: T2]

## 待写入 (persist)

- ~~CONTEXT **rerank** temporary Anthropic adapter~~ flushed 2026-08-27 with this plan.

## End of round

After T2–T3 land: code-review (Standards + Spec) on the impl diff, then verification-before-completion. Graph-priority ranking (`specs/retrieve-graph-priority.md`) is a **separate** plan; do not mix into these commits.
