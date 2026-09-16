# Spec: corpus-ready retrieve (资料页 + nonempty retrieve)

> **Status:** assumption gate = fin 图 2 G-arrive 2026-09-16 + live MCP `retrieve` probe (empty `chunks`, no `degraded`).
> **Sibling spec (fin):** [`../../fin/specs/first-closed-loop.md`](../../fin/specs/first-closed-loop.md)
> **Landing list (fin tree):** [`../../fin/docs/wayfinder/闭环与分档-落计划-2026-09-16.md`](../../fin/docs/wayfinder/闭环与分档-落计划-2026-09-16.md)
> **Plan:** `plans/corpus-ready-retrieve.md`

## Objective

iknow-memory must **store** pushed **chunk**s from fin **入库推送** and **retrieve** them. Operators see 就绪 on the **existing** 资料/dashboard surface: collection name, 资料 identity, status (in progress / ready / failed), successful chunk count. Empty ledger retrieve stays a legal empty `chunks: []` (not a crash, not silent `degraded`). After a successful push of ≥1 chunk, `retrieve` for a query that matches that text returns those chunks with `source_ref` byte-stable to the push.

**Who:** local operator; **host** fin calls MCP `retrieve` / push tools.

Quoted from `docs/CONTEXT.md` (exact copy, not redefinition):

- **chunk**: pushed text is final text. fin is the sole chunking authority; iknow-memory stores and recalls the pushed text as-is.
- **retrieve**: the read pipeline … exposed as MCP tool `retrieve` … wire stays `{ chunks[] }` (+ optional `degraded` / `degraded_reasons`).
- **degraded=true** / **降级标记** semantics as in this glossary (attempted arm failure ≠ empty hits).
- **iknow-memory dashboard**: operator HTTP read facade over the same core as **MCP tool**s.
- **authoritative source**: Postgres holds chunk text and metadata.

## Confirmed assumptions (gate)

1. 阶段一 only: persist + 资料页 four fields + retrieve hits after push. C community/global and D SQL **connections** are later slots (do not implement here; do not delete the product names).
2. Default ranking stays current **graph-priority** retrieve (档 B). Do not switch the default to vector-only to “make it cheaper”.
3. Extend the **existing** 资料/chunks dashboard page; no new 数据中台 process.
4. Memory facts / pins stay off the 资料集合 retrieve list.
5. `storage=memory` empty ledger: empty 资料页 + empty retrieve, not 500.
6. `npm test` / `npm run typecheck` stay green without requiring fin.
7. Live compose (Postgres/ES/Neo4j) is how product retrieve was probed; tests may Fake/memory backend.

## Boundaries

- **Does:**
  - Accept fin push envelopes that include `chunks[]` (≥1) and persist **authoritative** rows + derived indexes per existing ingest/push contracts.
  - MCP `retrieve` after that push: nonempty `chunks` for a matching query; `source_ref` present; text byte-identical to pushed body.
  - 资料页 (existing SPA/HTTP): collection name, per-资料 identity, status, successful chunk count.
  - Empty hits: HTTP/MCP 200 + `chunks: []`, `degraded` unset.
  - Failed ingest/push: status **失败** countable; retrieve still only successful chunks.

- **Confirms with human:** whether v1 is one process-wide 资料集合 or many named collections (fin Open Question 2).

- **Out of this spec:** fin citation verifier; fin 工作台 bind chrome; C map-reduce; D business SQL; new 中台 service; rewriting chunk text; Host prompts.

## Success Criteria

1. `npm run typecheck` and `npm test` exit 0.
2. After a fixture push with ≥1 chunk (test or documented live), MCP `tools/call` `retrieve` with a query overlapping that text returns `chunks.length ≥ 1`.
3. Each returned chunk includes `source_ref` as pushed; chunk text equals pushed chunk text (byte-identical contract already in glossary).
4. Before any push (empty store): same retrieve query returns `chunks: []` and does not set `degraded` solely because of empty hits.
5. 资料页 (or its HTTP backing): shows chunk count 0 then ≥1 after the fixture push; status ready vs failed is visible for that 资料.
6. Dashboard retrieve/query surface, if used, calls the same `assembleRetrievalResult` as MCP retrieve (existing dashboard spec).
7. No maintenance write buttons added for 中台.

## Open Questions

1. One vs many 资料集合 in v1 (same as fin Q2).
2. Exact dashboard route/component to extend (implementer if only one 资料 list exists).

## Inherits / Changes

**Inherits:** push/no-rechunk ADRs; **retrieve** graph-priority; dashboard read-only round; MCP `retrieve` strictObject input.

**Changes:** 资料就绪 four fields are product acceptance, not diagnostics-only; empty live retrieve is expected until push; 阶段一 blocks fin cite loop.

## 待写入 (persist after ACR)

empty — flushed 2026-09-16: CONTEXT **资料集合**.

## architecture-change-reviewer

Affected surfaces: MCP retrieve/push tools, authoritative chunk store, dashboard 资料/chunks HTTP+SPA.

bounded-context-guardian: yes — this repo remains 库; no host/verifier; dashboard stays read facade over core.
defensive-contract-validator: yes — empty store, bad push, overflow limit, concurrent push, retrieve exception/`degraded`.
error-handling-enforcer: yes — empty ≠ degraded; failed push named on 资料 status.
complexity-anti-drift: yes — reuse `assembleRetrievalResult`; no second ranker in dashboard.
minimal-change-verifier: yes — 就绪+retrieve hits only; C/D not implemented.
