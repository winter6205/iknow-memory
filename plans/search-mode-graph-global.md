# Plan: search-mode graph / global retrieve arms

**Goal:** One MCP `retrieve` lasting set is `A | graph | global | D`; `graph` mix is entity-id join before rerank; `global` is report-first then optional 抽图窗.
**Approach:** Expand tokens beside `B`/`C` so fin can migrate; replace corpus-wide summary-vector mix with join + judge window; retarget the report-first arm as `global`; contract `B`/`C` only after the fin sibling port sends the new tokens. Level column/filter is the community-level plan.
**Spec link:** `specs/search-mode-graph-global.md`
**Sibling plan:** [`../../fin/plans/search-mode-graph-global.md`](../../fin/plans/search-mode-graph-global.md)
**Parent plan (do not rewrite):** `plans/search-mode-retrieve.md`
**ACR:** all-yes (from spec)

bounded-context-guardian: yes — ranking/mix stay retrieve capability; one MCP `retrieve`; **host** still generates the answer; no generate tool.
input-contract-tests: yes — Boundaries name empty / negative / overflow / concurrent / exception including invalid `search_mode` and **`global`** not-ready.
error-handling-enforcer: yes — invalid typed; **`global`** not-ready typed; **`graph`** mix skip fail-open; mix read throw does not fail the slice list.
complexity-anti-drift: yes — retokenize dispatcher rows; one join helper; reuse report-first assembler; no second dashboard ranker.
minimal-change-verifier: yes — consume-token + mix-before-rerank + **`global`** report-first; A/D unchanged; eval suite / level column / Leiden writes Out.

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## 待写入

empty this file — CONTEXT **retrieve** / **hybrid retrieval** / **community** / **rerank** already name `graph`/`global` and mix-before-rerank; `_Stage:` refresh after T-last is implementation persist, not this plan.

## Tasks (ordered by dependency)

External blocker: `plans/community-level.md` T2 (cap exists). Do not ship join mix without `level <= N`.

1. **Expand wire: `graph` / `global` beside `B` / `C`** — tag: `[implementation]`
   - **Inherits:** spec closed set includes `graph` and `global`; missing key → **`graph`**; A/D unchanged; one retrieve tool; envelope `{ chunks[] }`.
   - **Surface:** retrieve `search_mode` dispatcher
   - **Acceptance:** `search_mode=graph` runs today’s knowledge-QA assembler; `search_mode=global` runs today’s report-first assembler; omit still routes as knowledge-QA; `B`/`C` still accepted this bullet (aliases) so the live host is not cut mid-migrate; `npm test` without live ES/GDS.
   - `[blocks: community-level T2]`
   - Status: [x] done — `fb0e8c0`. Wire widened in `src/core/retrieval/search-mode.ts`: `SEARCH_MODES = ["A", "graph", "global", "D"]`, `DEFAULT_SEARCH_MODE = "graph"`, `SEARCH_MODE_ALIASES = { B: "graph", C: "global" }` normalized inside `parseSearchMode` (so `SEARCH_MODE_ARMS` keeps exactly one row per lasting token: `graph` → `assembleRetrievalResult`, `global` → `modeCReportFirstArm`); unknown values still typed `invalid_search_mode`, and the `retrieve` tool description advertises `A | graph | global | D` with the aliases. Evidence this round (hermetic fakes, no live ES/GDS): `npm run typecheck` exit 0; targeted `npx vitest run` over `tests/retrieval/search-mode.test.ts`, `tests/retrieve.test.ts`, `tests/defensive/search-mode-defensive.test.ts`, `tests/retrieval/mode-a-arm.test.ts`, `tests/retrieval/mode-c-arm.test.ts`, `tests/retrieval/community-summary.test.ts`, `tests/defensive/retrieval-defensive.test.ts`, `tests/index.test.ts` → 171/171 (the three search-mode files alone went 69 → 84). Full `npm test` and `npm run lint:s5` NOT run here: this worktree is scoped to targeted files and eslint/typescript-eslint do not resolve inside it.

2. **`graph` entity-id join mix before rerank** — tag: `[implementation]`
   - **Inherits:** spec: mix = `community_summaries` whose `entity_ids` contain this request’s seed/PPR hit entities and `level <=` cap; not corpus-wide summary vectors; occupies `limit`; does not reorder graph-arm prefix; no judge decides whether to mix; skip fail-open (no entities / index not ready / mix read throw); permute window includes those mix items; no splice after `maybeRerank`.
   - **Surface:** retrieve optional community arm + assembler order vs rerank
   - **Acceptance:** fake store: mix rows overlap seed/hit ids; a summary-vector-only hit that does not join is absent; graph prefix order unchanged; recorded rerank window ids include mix items; post-rerank path does not append community hits; mix skip still returns slices.
   - `[blocks: T1]`
   - Status: [ ] pending

3. **`global` report-first + drop (token, not a second arm)** — tag: `[implementation]`
   - **Inherits:** spec: ES ∥ report vectors + cap; not-ready → `community_summary_index_failure`; ≥1 report hit may drop remaining `limit` to 抽图窗; `c_drop_windows=0` skips; zero report hits → not window-only 综述.
   - **Surface:** existing report-first retrieve arm
   - **Acceptance:** ready fixture hits are summary rows; not-ready typed; one-or-more reports + drop on → remaining slots may be 抽图窗; zero reports is not a window-only list.
   - `[blocks: T1]`
   - `[parallel]` with T2
   - Status: [ ] pending

4. **Contract: `B` / `C` typed invalid** — tag: `[implementation]`
   - **Inherits:** spec SC2: `search_mode=B` or `C` is typed invalid, not aliased; invalid is not **degraded=true**.
   - **Surface:** retrieve `search_mode` closed set
   - **Acceptance:** `B`/`C` typed refuse; missing still **`graph`**; A/D unchanged; `npm test` and `npm run typecheck` on touched suites exit 0.
   - `[blocks: T2, T3, fin search-mode-graph-global T3]`
   - **Also owns (folded in from the T1 review, Low):** the file/symbol rename of everything still named after the retired letters — `src/core/retrieval/mode-c-arm.ts`, `modeCReportFirstArm`, `c_drop_windows` — because those names only make sense while the alias exists; do it in this bullet, not as a drive-by.
   - Status: [ ] pending

## End of round

After T1–T4 land: one code-review phase vs `specs/search-mode-graph-global.md`, then verification-before-completion. Do not open a generate MCP tool.
