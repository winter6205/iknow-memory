# Plan: search-mode retrieve (iknow assembler)

**Goal:** MCP `retrieve` honors **检索档** via `filters.search_mode` without a fourth tool or a second dashboard ranker.
**Approach:** Retokenized — the lasting closed set is `lexical|graph|global|sql` (landed #270, letters fully retired). Reuse `assembleRetrievalResult` with one arm per 档: lexical = parent-window (former 档 A), graph = graph-priority default fill (former B), global = report-first over community summaries (former C), sql = typed unwired refusal (former D). Global needs wave-2 summaries for live proof; Fake/unit can land earlier.
**Spec link:** `specs/search-mode-retrieve.md`
**Sibling:** [`../../fin/specs/search-mode-retrieve.md`](../../fin/specs/search-mode-retrieve.md)
**Program:** [`../../fin/plans/extract-index-search-mode-program.md`](../../fin/plans/extract-index-search-mode-program.md) wave 3a
**ACR:** all-yes (from spec)

bounded-context-guardian: yes — ranking stays retrieve capability; no fourth MCP tool.
input-contract-tests: yes — Boundaries name all five classes including invalid `filters.search_mode`.
error-handling-enforcer: yes — missing mode → graph; invalid typed; global/sql named codes; graph fail-open vs global not-ready.
complexity-anti-drift: yes — per-档 arms reuse assembler; no second dashboard ranker.
minimal-change-verifier: yes — consume-档 only; sql is typed 未接 not SQL.

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

## 待写入

empty

## Tasks (ordered by dependency)

1. **`filters.search_mode` on retrieve** — tag: `[implementation]`
   - **Inherits:** missing → graph; invalid typed; no new MCP tool; `strictObject` input stays.
   - **Surface:** MCP retrieve tool + assembler
   - **Acceptance:** Missing key behaves as today’s graph-priority fill; invalid value does not return healthy empty `chunks` without a reason field/code the host can map; `npm test` without live ES/GDS.
   - Status: [x] done — #238 (8a71f67) wire parse + SEARCH_MODE_ARMS dispatch; #270 (f992ef7) retokenized to word closed set. src/core/retrieval/search-mode.ts parseSearchMode: missing → graph default, invalid → typed invalid_search_mode; no fourth MCP tool (retrieve rides filters)

2. **档 lexical child hit returns parent text** — tag: `[implementation]`
   - **Inherits:** ADR 0060; cite body is parent; child span optional metadata.
   - **Surface:** retrieve assembler / ES child index
   - **Acceptance:** Fixture with parent+child: a lexical query hitting the child puts parent body in `chunks[]` text.
   - `[blocks: T1]`
   - Status: [x] done — #243 (e591c43) mode-a-arm.ts: child hits collapse to parent-window body keyed by source_doc_id, children kept as span metadata; parentWindowsByChunkIds seam on pgvector + memory backends; mode-a-arm.test.ts

3. **档 global report-first + drop** — tag: `[implementation]`
   - **Inherits:** ADR 0070; default drop after a report hit; `c_drop_windows=0` skips; not-ready → `community_summary_index_failure` not silent miss.
   - **Surface:** community ledger + ES/vectors on report text
   - **Acceptance:** Global-ready fixture: hits are summary rows (ES∥vectors eligible); global not-ready is typed; drop can be disabled by filter.
   - `[blocks: T1]`
   - **Note:** live global-ready needs graph-index plan T5.
   - Status: [x] done at unit level — #244 (7fbad56) mode-c-arm.ts: readiness gate fails closed (communitySummaryNotReady carries COMMUNITY_SUMMARY_INDEX_FAILURE), ES ∥ vectors report arms with rrf fuse, default drop with c_drop_windows=0 opt-out; communityLevel cap + stale-level post-filter added by #264; the production ES report-TEXT legs landed in T5a/T5b below

4. **档 sql unwired + five classes** — tag: `[implementation]`
   - **Inherits:** `real_db_not_wired`; document tables stay graph.
   - **Surface:** retrieve assembler
   - **Acceptance:** `search_mode=sql` → typed 未接, not SQL over chunks; overflow `limit`; concurrent retrieve; graph ledger read throw still fail-open (parent community spec) while global not-ready stays typed.
   - `[blocks: T1]`
   - `[parallel]` with T2
   - Status: [x] done — #245 (5b92881) modeDNotWiredArm throws typed real_db_not_wired touching no deps; five boundary classes (empty/negative/overflow/concurrent/exception) in tests/defensive/search-mode-defensive.test.ts

5. **T5a — ES community-summary write/ingest side (production)** — tag: `[implementation]`
   - **Inherits:** the global arm's report-TEXT bm25 leg (T3/#244) runs against unit doubles because no production path writes community-summary text into ES; the interface (`searchCommunitySummariesLexical`, src/core/retrieval/types.ts:671), shape probe (src/core/storage/backend.ts:199) and call site (src/core/retrieval/mode-c-arm.ts:271) already exist. The stale attribution comment at types.ts:664-668 (claims the write side "belongs to graph-index plan T5 wave" — only the PG ledger landed, f3ac774) is corrected in this ticket.
   - **Surface:** src/cli/community-summary.ts (write leg beside swapCommunitySummaries), src/core/storage/elasticsearch-precision.ts (summary-text index ensure + write), index-name config
   - **Acceptance:** after a successful community-summary generation run, summary text is queryable in ES via the production path; index creation happens ONLY on the write path; the all-or-nothing READY swap semantics from wave-2 (f3ac774) are unchanged; the types.ts attribution comment matches reality; `npx vitest run` green.
   - Status: [x] done — b91ab36: src/cli/community-summary.ts post-swap projection leg reads the PUBLISHED generation back from the ledger and writes it through `indexCommunitySummaries` (an empty published generation CLEARS the index), so the lexical report arm can only ever answer with what Postgres answers for; by an explicit EXIT the ES leg is best-effort (a throw is logged and the run still succeeds — Postgres already committed READY and is authoritative, a stale derived index is repaired by the next run's idempotent write). src/core/storage/elasticsearch-precision.ts summary-text index ensure/write with creation reachable only from the write path, index name from config (src/config.ts + .env.example + docs/mcp-config.md), types.ts attribution comment corrected; unit proof in tests/cli/community-summary.unit.test.ts + tests/storage/elasticsearch-precision.unit.test.ts + tests/config.test.ts

6. **T5b — global report-TEXT ES read seam (production) + live global proof** — tag: `[implementation]`, live 必选
   - **Inherits:** T5a's populated index; the arm's typed readiness gate (mode-c-arm.ts requireCommunityIndexReady → communitySummaryNotReady carrying COMMUNITY_SUMMARY_INDEX_FAILURE) stays untouched.
   - **Surface:** src/core/storage/elasticsearch-precision.ts (`searchCommunitySummariesLexical` implementation mirroring `searchLexical` patterns), tests/integration/retrieve-search-mode-pg.test.ts
   - **Fail-closed contract (explicit):** the search path NEVER auto-creates the index; a missing/unpopulated ES summary index is a typed failure that routes to `community_summary_index_failure` — it must not surface as `ran:true, rows:[]` healthy-empty (specs/search-mode-retrieve.md forbids a silent miss for global not-ready).
   - **Input-contract tests:** the five boundary classes (empty query / negative or limit≤0 / overflow / concurrent / ES-down exception) named against the PRODUCTION seam, not just unit doubles.
   - **Live acceptance:** a global (C-ready) case in retrieve-search-mode-pg.test.ts with `communitySummaryEnabled: true` against real PG + ES + READY community index; the fixture MUST be built through T5a's production write path (no test-only raw ES document writes, which would mask the production gap); wave-2 dependency (graph-index T5, f3ac774) already landed.
   - `[blocks: T5a]`
   - `[parallel]` with nothing — single lane
   - Status: [x] done — 26684c9: `searchCommunitySummariesLexical` on the production ES backend reads only (no ensure/create on the search path; a missing index throws the typed not-ready failure the global arm maps to `community_summary_index_failure`), the mode-c arm consumes it for the report-TEXT bm25 leg, five boundary classes asserted against that production seam, and the live global case builds its fixture through T5a's write path (`communitySummaryEnabled: true`, real PG + ES). Cross-repo live proof: fin `-m mcp tests/retrieve/test_live_search_modes_pg_es.py` = 11 passed against this build, including the global end-to-end refusal path.

## Superseded branch

The old stacked branch `feat/search-mode-t4` (PRs #239–#241, closed 2026-09-19 unmerged after the #238 squash-stack recovery) is a patch-equivalent subset of main (`git cherry` marks all four commits already applied); it retains the retired letter vocabulary and has no salvage value — reference only, worktree `iknow-memory-wt-search-mode-retrieve` may be dropped.
