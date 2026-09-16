# Plan: corpus-ready retrieve

**Goal:** Pushed chunks persist; retrieve returns them; 资料页 shows 就绪 four fields; empty store stays legal empty retrieve.
**Approach:** Fin cannot cite until this store has chunks. Reuse push + `assembleRetrievalResult`. Extend existing 资料 page. No C/D, no 中台 process.
**Spec link:** `specs/corpus-ready-retrieve.md`
**Sibling plan:** [`../../fin/plans/first-closed-loop.md`](../../fin/plans/first-closed-loop.md)
**ACR:** all-yes (copied from spec)

bounded-context-guardian: yes — this repo remains 库; no host/verifier; dashboard stays read facade over core.
defensive-contract-validator: yes — empty store, bad push, overflow limit, concurrent push, retrieve exception/`degraded`.
error-handling-enforcer: yes — empty ≠ degraded; failed push named on 资料 status.
complexity-anti-drift: yes — reuse `assembleRetrievalResult`; no second ranker in dashboard.
minimal-change-verifier: yes — 就绪+retrieve hits only; C/D not implemented.

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

## 待写入

empty — flushed 2026-09-16: CONTEXT **资料集合**.

## Tasks (ordered by dependency)

1. **Empty retrieve contract pinned** — tag: `[implementation]`
   - **Inherits:** spec SC4; glossary empty hits ≠ `degraded`.
   - **Surface:** MCP `retrieve` tool
   - **Acceptance:** Empty store retrieve returns `chunks: []` without setting `degraded` for emptiness; `npm test` still 0.
   - Status: [x] done — 既有 pinning 已在 `tests/retrieve.test.ts` / `tests/tools/retrieve-graph.test.ts`；本次补一条 harness 级回归（hybrid arms 打开、graph 臂关闭）`tests/retrieve.test.ts` d0ebd4d。注：`graphEnabled: true` 且 graph 臂未接线时 `graph_ppr:unattempted` 是既有约定降级（pins: `tests/retrieval/t10-graph-default.test.ts:153`、`tests/retrieval/degraded-envelope.test.ts:99`），不属于「空即降级」，故回归用例把 graph 臂关掉以隔离「空」这一变量；生产默认配置下 graph 臂打开，空库仍会因未接线而降级，这是既有策略而非本次改动。

2. **Fixture push then retrieve hits** — tag: `[implementation]`
   - **Inherits:** spec SC2–SC3; **chunk** byte-identical; `source_ref` on wire.
   - **Surface:** push + retrieve core
   - **Acceptance:** After fixture push ≥1 chunk, `retrieve` matching query returns `chunks.length ≥ 1` with `source_ref` and byte-identical text.
   - Status: [x] done — 根因修复 b061e0e：items 臂此前丢弃 `chunks[]`，整篇 body 落 1 行、只回 1 个 id；现按 slice 落 N 行并按序回 N 个 `chunk_id`。证据 `tests/tools/push-fin-wire.test.ts`（15 例，含 fin 真实 wire、跨 slice 字节一致、rebuild-on-repush 不累加）。边界：chunk id 由 (source_ref, content_identity) 派生，因此**文本相同的两个 slice 会并成一行**——响应仍是一 slice 一 id（fin 的 `block_ids` 与 slice 列表平行），但行数是**去重后**的 slice 数；已由 `collapses slices with identical text onto one row` 一例显式固定。
   - `[blocks: T1]`

3. **资料页 four fields** — tag: `[implementation]`
   - **Inherits:** spec SC5; extend existing dashboard 资料/chunks surface.
   - **Surface:** `iknow-memory dashboard` HTTP + SPA
   - **Acceptance:** Same fixture: page/API shows identity + status + successful chunk count 0 then ≥1; failed push visible as 失败.
   - Status: [x] done — 集合名/身份/状态/成功块数落在 `/api/sources`(`listSourceDocs`) 与 SPA 资料页；状态**持久化**在 `source_documents.status`（推进中/就绪/失败 + `failure_code`），计数由 `chunks.source_doc_id` 反查派生，未知 source_ref 的失败不建行。证据 `tests/storage/source-doc-status.test.ts`、`tests/tools/push-status.test.ts`、`tests/dashboard/sources.test.ts`、`tests/storage/storage-reads-pg.test.ts`、`dashboard/src/sources.test.tsx`。
   - `[blocks: T2]`
   - `[parallel]` with fin bind bullet once count exists
