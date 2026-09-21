# Spec: search-mode graph / global retrieve arms

> **Status:** assumption gate confirmed in-session (wire tokens + mix join + rerank window locked). Parent consumption spec is not edited in place.
> **Inherits (do not rewrite):** [`search-mode-retrieve.md`](search-mode-retrieve.md)
> **Sibling spec (fin):** [`../../fin/specs/search-mode-graph-global.md`](../../fin/specs/search-mode-graph-global.md) (Out-link; that file need not exist yet)
> **Judge window:** [`retrieve-judge-rerank.md`](retrieve-judge-rerank.md)
> **Ledger community rows:** [`retrieve-community.md`](retrieve-community.md)
> **Plan:** later slot (`writing-plans` after this ACR block)

## Objective

Keep a **single** MCP **retrieve** tool. Honor `filters.search_mode` so **A** and **D** stay the parent arms, while the knowledge-Q path is **`graph`** and the corpus-summary path is **`global`**. Missing `search_mode` defaults to **`graph`**. Ranking and mix stay in this repo; the **host** still writes the user-visible answer. Envelope stays `{ chunks[] }` (+ optional `degraded` / `degraded_reasons`).

**Who:** MCP **host** (fin syncs the same tokens in the sibling spec above); operators querying a **资料集合**.

Quoted from this repo `docs/CONTEXT.md` (exact copy, not redefinition):

- **host**: any MCP client that discovers and calls iknow-memory tools (Claude Code, iknow harness, custom agents). The host owns context engineering (JIT retrieval triggers, cache layout, prompt assembly). iknow-memory never reaches into the host.
- **retrieve**: the read pipeline: embed query once → entity seeds + Neo4j **PPR** (when configured) mapping to chunks via `source_chunk_id` → non-empty graph hits lead Host `chunks[]`, else (and remainder slots) vector ∥ BM25 → **RRF fusion** → optional entity-embedding seeds / community-summary hits → optional **rerank** … → top-K … wire stays `{ chunks[] }` (+ optional `degraded` / `degraded_reasons`).
- **hybrid retrieval**: production Host ranking is graph-priority (`specs/retrieve-graph-priority.md`): non-empty **Neo4j graph arm** hits occupy the front of `chunks[]`; remaining `limit` slots (and the whole list when the graph arm contributes nothing) are vector+BM25 **RRF fusion (k=60)**. … optional later steps are entity-embedding seeds and community-summary hits **before** **rerank**, then **neighbor evidence**.
- **Neo4j graph arm**: the sole production true-graph recall path (ADR-0008): query embedding → entity seeds (vector + **precision layer** entity index) → Neo4j GDS **PPR** (`gds.graph.project` → `gds.pageRank.stream`) → map entities back to chunks via Postgres `source_chunk_id` (chunks never enter Neo4j).
- **community**: Entity-graph clusters from hierarchical **Leiden** at index time (ADR-0011). Each cluster has a ledger summary (index LLM, no write-path judge) whose **community level** is cluster size / grain; retrieve may return those rows as Host `chunks[]` (`search_mode=global` report-first then optional 抽图窗 fill after a report hit; `search_mode=graph` may join summaries for seed entities) after a level cap on those summaries, then the same **rerank** judge; map-reduce stays on the **host**.
- **community level**: cluster size / summary grain of a **community** (larger community = coarser theme), not summary word count and not **entity** type. Retrieve cap defaults to `2` on the reference scale (`level <= 2`); optional `filters.community_level` overrides; missing uses `2`; invalid is a typed refuse. Wire and column names are `community_level` / `level`.
- **rerank**: a post-ranking permutation of retrieve `chunks[]` before Host `limit`. Intended production path is a judge filter-then-order adapter on `ChunkReranker` (`specs/retrieve-judge-rerank.md`); the permute window includes community-summary items already in that list. … Throw at retrieve time fails open + `degraded`.
- **degraded=true**: … invalid caller input is not a capability failure and must not set it.

Fin CONTEXT **检索档** / **抽图窗** / **具名失败** apply as joint product names; this spec does not redefine them.

## Confirmed assumptions (gate)

1. Parent [`search-mode-retrieve.md`](search-mode-retrieve.md) still owns 档 **A** (parent 抽图窗 cite) and 档 **D** (typed 真库未接). This file does not reopen those arms.
2. Closed `filters.search_mode` set is `A | graph | global | D`. One retrieve tool. Invalid value is a typed refuse (`invalid_search_mode` class). Missing key → **`graph`**. Tokens `B` and `C` are not lasting wire values.
3. **`graph` path:** entity seed → **PPR** → **chunk** slices lead; vector ∥ BM25 fill remainder (parent graph-priority). Community mix is **not** a corpus-wide summary **vector search** arm.
4. **Mix** = join ledger `community_summaries` whose `entity_ids` contain this request’s seed and/or **PPR** hit **entity** ids, **and** `level <=` the **community level** cap (cap column/filter: [`community-level.md`](community-level.md)). Mix occupies `limit`. Mix does not reorder the **Neo4j graph arm** slice ranking. A judge does **not** decide whether to mix.
5. Mix skip (slices still return, fail-open, not a Host throw): no seed/hit **entity**; community index not ready; ledger mix **read** throw. Empty join is identity for mix (not `degraded` solely from “no matching summaries”).
6. **`global` path:** community-report **precision layer** (ES) ∥ report **vector search**, same **community level** cap. Index not ready → typed `community_summary_index_failure` (not a healthy `{ chunks: [] }`, not silent fall-through to **`graph`**). After **at least one** report hit, remaining `limit` may drop to 抽图窗. Existing `filters.c_drop_windows=0` skips that fill. Zero report hits → do **not** answer as window-only 综述.
7. **rerank** ([`retrieve-judge-rerank.md`](retrieve-judge-rerank.md)): the permute window **must** include community-summary items **already on** the pre-rerank list. Do **not** prepend or splice community hits **after** `maybeRerank`. After permute, non-empty graph-arm **chunk** hits still occupy the front for **`graph`**.
8. Envelope `{ chunks[] }` (+ optional `degraded`). No new generate MCP tool. No library map-reduce / answer-reduction on this server; the **host** writes the user-visible answer.
9. `npm test` without live ES/GDS when those arms are faked. Default tests do not require fin.
10. Credentials stay in `~/.iknow-memory/setting.json` / existing env; no secrets in git.

## Boundaries

- **Does:**
  - Parse/strip `filters.search_mode`; route **A** / **`graph`** / **`global`** / **D** on the existing dispatcher; reuse parent A/D arms and the report-first assembler for **`global`**.
  - **`graph`:** keep **Neo4j graph arm** prefix + remainder **RRF fusion (k=60)**; replace corpus-wide community-summary vector recall with the entity-id join mix; place mix on the list **before** `maybeRerank`; mix skip paths above.
  - **`global`:** report ES ∥ report vectors; typed not-ready; report-lead then optional 抽图窗 fill; no window-only 综述.
  - Tests covering empty (no entities / empty summary ledger / ready-but-zero reports); negative (invalid `search_mode`; **`global`** not-ready; `c_drop_windows=0`; mix skip); overflow (`limit` holds; mix does not drop the graph prefix); concurrent retrieve (no shared mutable mix buffer); exception (mix read throw fail-open vs **`global`** state-read not-ready typed).

- **Confirms with human:** none remaining for tokens, mix join, or rerank window order.

- **Out of this spec:**
  - [`community-level.md`](community-level.md) (column + `filters.community_level` parse/default/invalid)
  - [`embedding-generation.md`](embedding-generation.md)
  - [`retrieve-eval-suite.md`](retrieve-eval-suite.md)
  - extract / **Leiden** write jobs (index-time summary persist)
  - 资料归档
  - Host Soft-Track classify (档 choice stays on the **host**)
  - citation verifier
  - M4
  - four Host retrieve nodes; re-chunking; a generate/map-reduce tool in this library

## Success Criteria

1. `npm run typecheck` and `npm test` exit 0 on suites this change touches.
2. Missing `filters.search_mode` routes as **`graph`**. `search_mode=B` or `search_mode=C` is typed invalid, not aliased.
3. **A** still cites parent 抽图窗 on a child lexical fixture (parent SC3). **D** still typed 真库未接 (parent SC5).
4. **`graph`:** non-empty **Neo4j graph arm** fixture chunks still prefix `chunks[]` after mix and after judge permute; vector∥BM25 only fill remainder. Mix rows are summaries whose `entity_ids` overlap this request’s seed/hit entities; a corpus-wide summary-vector hit that does not join those ids is **not** mixed in.
5. **`graph` mix skip:** no entities / community index not ready / mix read throw → slice `chunks[]` still returned; no Host throw from mix. Fake store; no live GDS required.
6. Mix occupies `limit`; graph-arm slice **order** among prefix hits is unchanged by which summaries joined.
7. Judge permute is invoked on a list that already contains those mixed community-summary items. A fake that records window ids includes them. Post-`maybeRerank` code does not splice additional community hits onto the list.
8. **`global`:** ES and summary vectors both eligible; hits are summary rows when ready. Not-ready → typed `community_summary_index_failure`. Zero report hits → empty/degraded-per-parent-report-arms, **not** a 抽图窗-only list. One-or-more report hits + drop on → remaining slots may be 抽图窗. `c_drop_windows=0` → reports only.
9. Envelope remains `{ chunks[] }` (+ optional `degraded`). Dashboard retrieve still shares `assembleRetrievalResult` / the same dispatcher (no second ranker).
10. No generate MCP tool; no in-process map-reduce of a final answer.

## Open Questions

(none)

## Inherits / Changes

**Inherits:** [`search-mode-retrieve.md`](search-mode-retrieve.md) (A/D arms, envelope, one tool, C drop switch semantics now on **`global`**, named not-ready vs B fail-open split now **`global`** vs **`graph`** mix); [`retrieve-graph-priority.md`](retrieve-graph-priority.md); [`es-precision-layer.md`](es-precision-layer.md); [`bm25-retrieve.md`](bm25-retrieve.md); [`corpus-ready-retrieve.md`](corpus-ready-retrieve.md); [`retrieve-community.md`](retrieve-community.md) (ledger summary rows, retrieve **read** throw fail-open on the **`graph`** mix path); [`retrieve-judge-rerank.md`](retrieve-judge-rerank.md); `assembleRetrievalResult` / `SEARCH_MODE_ARMS` dispatcher; `communitySummaryArmHit` wire shape; `filters.c_drop_windows`.

**Changes:** lasting wire values **`graph`** / **`global`** (not `B` / `C`); default missing key → **`graph`**; **`graph`** community consumption is entity-id join mix occupying `limit`, not corpus-wide summary vectors and not a post-`maybeRerank` `prependCommunityPriority` splice; **`global`** is the parent report-first arm under the new token, still fail-closed on index not-ready.

## 待写入 (persist after ACR)

- CONTEXT **retrieve** / **hybrid retrieval** / **community**: lasting `filters.search_mode` values are `A | graph | global | D`; mix = entity-id join on **`graph`**, not a third equal vector arm over all summaries; community hits enter the list **before** **rerank**.
- CONTEXT **rerank**: already forbids splicing community hits after permute — keep that sentence; drop any remaining “prepend after ranker” wording if a persist still describes `prependCommunityPriority` after `maybeRerank`.

## architecture-change-reviewer

Affected surfaces (implementation later): `src/core/retrieval/search-mode.ts` (closed set, default, arm table), `src/core/retrieval/optional-arms.ts` (join mix vs corpus summary vector), `src/core/retrieval/index.ts` (`assembleFusedResult` / community placement vs `maybeRerank`), `src/core/retrieval/mode-c-arm.ts` (**`global`** report-first + 抽图窗 drop), `src/tools/retrieve.ts` (error copy), retrieval tests.

bounded-context-guardian: yes — ranking/mix stay retrieve capability; one MCP `retrieve`; **host** still generates the answer; no generate tool.
input-contract-tests: yes — Boundaries name empty / negative / overflow / concurrent / exception including invalid `search_mode` and **`global`** not-ready.
error-handling-enforcer: yes — invalid typed; **`global`** not-ready typed; **`graph`** mix skip fail-open; mix read throw does not fail the slice list.
complexity-anti-drift: yes — retokenize dispatcher rows; one join helper; reuse report-first assembler; no second dashboard ranker.
minimal-change-verifier: yes — consume-token + mix-before-rerank + **`global`** report-first; A/D unchanged; eval suite / level column / Leiden writes Out.

OVERALL: PASS — hand to `writing-plans`. Do not implement from this file until that plan.
