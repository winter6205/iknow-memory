# Plan: MCP tool surface

**Status（2026-09-05）：** PR [#185](https://github.com/winter6205/iknow-memory/pull/185) 已合入 `main`。T1–T3 闭合。

**Goal:** Hosts see exactly `ingest`, `push`, `invalidate`, `extract`, `retrieve`; extract reuses one core pipeline; echo and the `invalidation` name are gone.
**Approach:** Lift CLI-private extract persist into `src/core/extraction` first so the MCP tool cannot import `src/cli`. Catalog tidy (echo, ingest invalidate, rename) can run in parallel. Then register MCP `extract` on the lifted module.
**Spec link:** `specs/mcp-tool-surface.md`
**Tracker:** **local markdown fallback** — operator SSOT for this round is `specs/` + `plans/` in the work tree.
**ACR:** all-yes (architecture-change-reviewer · 2026-09-05, after lift patch)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch. End-of-round code-review after all bullets land.

## ACR

bounded-context-guardian: yes — assumption 14 and Does #2 lift `processChunk`/`persistOutputs`/scan into existing `src/core/extraction`; MCP extract calls that module never `src/cli`; SC13 forbids `src/tools`→`src/cli`; no new controllers/services tree.
defensive-contract-validator: yes — Testing Strategy names empty/negative/overflow/concurrent/exception; SC6–SC9 bind extract observables; concurrent inherits existing per-chunk isolation.
error-handling-enforcer: yes — xor/empty/over-limit selectors are input errors; missing LLM/embed creds are typed not FakeLLMClient; per-chunk failure is mark-and-continue; ingest/invalidate stay GraphragError-shaped.
complexity-anti-drift: yes — one persist/batch lift into core plus two thin wrappers (CLI flags/exit codes, MCP registration), ingest schema shrink, rename invalidate, unregister echo — not a second writer or a god `index.ts`.
minimal-change-verifier: yes — one MCP catalog slice including the lift it requires; first-slice/session/citations out; no new runtime dependency.

OVERALL: PASS — hand to writing-plans.

## Tasks (ordered by dependency)

1. **Lift extract batch/persist into core; CLI wraps it** — tag: `[implementation]`
   - **Inherits:** spec assumption 14, Does #2, SC10, SC13; same pending scan, per-chunk transaction, mark-and-continue, outbox emit, no FakeLLM persist; CLI flags (`--dry-run`, `--list-failed`, `--list-unmapped`, `--backfill-embeddings`) stay CLI-only.
   - **Surface:** existing `src/core/extraction` capability and `src/cli/extract.ts` as the flag/exit-code entry.
   - **Acceptance:** CLI extract behaviour tests still pass; persist/batch is callable from core without going through CLI argv; `src/cli/extract.ts` no longer owns a second persist implementation.
   - Status: [x] closed — PR #185

2. **[parallel] Catalog tidy: echo off, ingest write-only, `invalidate` name** — tag: `[implementation]`
   - **Inherits:** spec SC1 (minus `extract` until T3), SC2–SC5; `echo` and `invalidation` absent; ingest rejects invalidate action; `invalidate` keeps close-window / no delete / idempotent; `push` and `retrieve` contracts unchanged; Host-facing descriptions, no stage-0 / fin-port jargon.
   - **Surface:** existing MCP registry (`src/index.ts`, `src/tools`).
   - **Acceptance:** `tools/list` has no `echo` or `invalidation`; `ingest` + invalidate action is a validation error; `invalidate` matches today’s invalidation behaviour; existing push/retrieve/invalidation tests green under the new name; `npm test` exits 0.
   - Status: [x] closed — PR #185
   - [parallel]

3. **MCP `extract` on the lifted pipeline** — tag: `[implementation]`
   - **Inherits:** spec extract contract + SC6–SC9, SC13; `chunk_ids` xor `source_ref`; batch cap = ingest batch limit; zeros on empty pending `source_ref`; typed error if persist creds missing; first-slice **evidence span** gate if that persist path is already on the branch.
   - **Surface:** MCP tools + lifted `src/core/extraction` (T1). Must not import `src/cli`.
   - **Acceptance:** registry names are exactly `{ingest, push, invalidate, extract, retrieve}`; xor/empty/over-limit selectors error; one fail + one success in a batch does not abort; `src/tools` has zero `src/cli` imports; `npm test` and `npm run build` exit 0.
   - Status: [x] closed — PR #185
   - [blocks: T1]

## 待写入 (persist)

- ~~CONTEXT **iknow-memory**, **ingest**, **push**, **content invalidation**, **extract_triples**~~ flushed 2026-09-05 with SPECIFY persist. Plan persist: skip.

## End of round

After T1–T3 land: `arthurpower:code-review` then `arthurpower:verification-before-completion` on this slice. Do not mix `plans/graph-rerank-boot-and-evidence.md` commits into these bullets.
