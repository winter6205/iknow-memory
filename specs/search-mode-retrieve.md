# Spec: search-mode retrieve (档 consumption)

> **Superseded in part (2026-09-21) by** [`search-mode-graph-global.md`](search-mode-graph-global.md):
> the wire **token set** and its **default** are owned there —
> `filters.search_mode` ∈ `A|graph|global|D`, missing key → **`graph`**, and
> `B`/`C` are migration aliases only. What each 档 **consumes** (below) stays
> authoritative here and is deliberately not restated there.
>
> **Status:** assumption gate confirmed 2026-09-17 (two-repo sync with fin spec 3 of 4).
> **Sibling spec (fin):** [`../../fin/specs/search-mode-retrieve.md`](../../fin/specs/search-mode-retrieve.md)
> **Index write path:** [`graph-index-standard-fast.md`](graph-index-standard-fast.md)
> **Plan:** later slot (`writing-plans` after `architecture-change-reviewer`).

## Objective

Make MCP **retrieve** **consume** index artifacts according to **检索档** A/B/C/D **after** the host has already chosen **grounded** and a search mode. Ranking stays in this repo (`assembleRetrievalResult` / graph-priority + ES/BM25/vectors). Fin does not re-rank and does not add four retrieve tools.

**Who:** MCP **host** fin; operators querying a **资料集合**.

Quoted from this repo `docs/CONTEXT.md` (exact copy, not redefinition):

- **hybrid retrieval**: production Host ranking is graph-priority (`specs/retrieve-graph-priority.md`): non-empty **Neo4j graph arm** hits occupy the front of `chunks[]`; remaining `limit` slots (and the whole list when the graph arm contributes nothing) are vector+BM25 **RRF fusion (k=60)**.
- **retrieve**: the read pipeline: … exposed as MCP tool `retrieve` … wire stays `{ chunks[] }` (+ optional `degraded` / `degraded_reasons`).
- **community**: Entity-graph clusters from **hierarchical Leiden** at index time (ADR-0011), each with a ledger-stored summary. Retrieve may return those summaries as Host `chunks[]` when topic / **检索档** C is enabled; map-reduce of a final answer stays on the **host**.
- **chunk**: a derived index row for one fin-cut slice of a **资料**.

Fin CONTEXT **检索档** / **抽图窗** / **父子分块** / **具名失败** apply as the joint product names; this spec does not redefine them.

## Confirmed assumptions (gate)

1. Two-repo sync 2026-09-17: this is iknow **spec 3**. Host cascade is fin `search-mode-host.md`.
2. A: lexical-first on **children**, return parent window text (fin 抽图窗 / parent payload already on push).
3. B: existing **graph-priority** then vector∥BM25 fill (default today’s retrieve).
4. C: community **report** text ES ∥ report vectors; then optional drop to citable windows. C not-ready if community-summary job failed (index spec). Do not C-search windows while ignoring reports.
5. D: typed **真库未接** until a business SQL path exists; document tables stay B.
6. Host passes **检索档** as MCP `retrieve` **`filters.search_mode`** ∈ `A|B|C|D`. Missing key defaults to **B**. Invalid value is a typed negative (do not invent a fourth MCP tool).
7. `npm test` without live ES/GDS when those arms are faked; default tests do not require fin.
8. Envelope stays `{ chunks[] }` (+ optional `degraded`). Map-reduce stays on the host.

## Boundaries

- **Does:**
  - Assemble `chunks[]` per 档 using existing indexes (ES precision layer, vectors, Neo4j graph arm, ledger community summaries).
  - Named empty/not-ready: C when summaries missing; D when SQL unwired; do not collapse into one `chunks: []` with no reason when the 档 is closed.
  - Tests: empty (no summaries / no children); negative (C while not-ready; D unwired); overflow (`limit`); concurrent retrieve; exception (ledger read — parent fail-open vs C not-ready: C must not look like a healthy miss).

- **Confirms with human:** none remaining for search-mode wire field (pinned `filters.search_mode`). Public copy strings may still share fin tokens: `corpus_not_ready`, `mapping_drop`, `tier_not_open`, `real_db_not_wired`, `community_summary_index_failure`.

- **Out of this spec:** extract/Leiden jobs (graph-index spec); fin choice window; citation verifier; four Host retrieve nodes; re-chunking.

## Success Criteria

1. `npm run typecheck` and `npm test` exit 0.
2. 档 B on a graph-priority fixture still prefixes non-empty graph-arm hits (parent retrieve-graph-priority contract).
3. 档 A: a child lexical hit contributes the **parent** window/body to `chunks[]`, not the child as the sole citable body.
4. 档 C: hits are community **summary** rows when C-ready; ES and summary vectors are both eligible; C not-ready is a typed miss, not silent empty with `degraded` unset solely from “no reports.”
5. 档 D: unwired SQL → typed 真库未接 (or documented equivalent), not fake SQL over document chunks.
6. No second ranker in the dashboard; MCP retrieve and dashboard query share `assembleRetrievalResult` (existing corpus-ready contract).
7. Host still generates the user-visible answer; this server does not map-reduce C.

## Open Questions

(none — `filters.search_mode`; C drop default on after a report hit, `filters.c_drop_windows=0` to skip; A cite = parent body + optional child span metadata; codes aligned with fin `named_failures` + `community_summary_index_failure`.)

## Inherits / Changes

**Inherits:** `specs/retrieve-graph-priority.md`; `specs/es-precision-layer.md`; `specs/bm25-retrieve.md`; `specs/corpus-ready-retrieve.md`; community ledger reads from `specs/retrieve-community.md` (fail-open on **read** throw for B path).

**Changes:** retrieve **must** honor 档 A/C/D as distinct arms, not only “topic switch may append summaries.” C is report-first (fin ADR 0070). Topic-only mode-bundle is not the product 档 router (fin host assigns 档).

## 待写入 (persist after ACR)

empty unless Open Question 1 forces a CONTEXT **retrieve** input field.

## architecture-change-reviewer

Affected surfaces: `src/tools/retrieve.ts`, `src/core/retrieval/index.ts` (`assembleRetrievalResult`), ES/community ledger reads.

bounded-context-guardian: yes — ranking stays retrieve capability; no fourth MCP tool.
input-contract-tests: yes — Boundaries name all five classes including invalid `filters.search_mode`.
error-handling-enforcer: yes — missing mode → B; invalid typed; C/D named codes; B fail-open vs C not-ready.
complexity-anti-drift: yes — per-档 arms reuse assembler; no second dashboard ranker.
minimal-change-verifier: yes — consume-档 only; D is typed 未接 not SQL.

OVERALL: PASS — 2026-09-17 ACR (second pass after wire-field pin). Next: writing-plans.
