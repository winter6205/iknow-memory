# Plan: search-mode retrieve (iknow assembler)

**Goal:** MCP `retrieve` honors **检索档** via `filters.search_mode` without a fourth tool or a second dashboard ranker.
**Approach:** Reuse `assembleRetrievalResult`; add A/C/D arms; B remains graph-priority fill. C needs wave-2 summaries for live proof; Fake/unit can land earlier.
**Spec link:** `specs/search-mode-retrieve.md`
**Sibling:** [`../../fin/specs/search-mode-retrieve.md`](../../fin/specs/search-mode-retrieve.md)
**Program:** [`../../fin/plans/extract-index-search-mode-program.md`](../../fin/plans/extract-index-search-mode-program.md) wave 3a
**ACR:** all-yes (from spec)

bounded-context-guardian: yes — ranking stays retrieve capability; no fourth MCP tool.
input-contract-tests: yes — Boundaries name all five classes including invalid `filters.search_mode`.
error-handling-enforcer: yes — missing mode → B; invalid typed; C/D named codes; B fail-open vs C not-ready.
complexity-anti-drift: yes — per-档 arms reuse assembler; no second dashboard ranker.
minimal-change-verifier: yes — consume-档 only; D is typed 未接 not SQL.

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

## 待写入

empty

## Tasks (ordered by dependency)

1. **`filters.search_mode` on retrieve** — tag: `[implementation]`
   - **Inherits:** missing → B; invalid typed; no new MCP tool; `strictObject` input stays.
   - **Surface:** MCP retrieve tool + assembler
   - **Acceptance:** Missing key behaves as today’s graph-priority B; invalid value does not return healthy empty `chunks` without a reason field/code the host can map; `npm test` without live ES/GDS.
   - Status: [ ] pending

2. **档 A child hit returns parent text** — tag: `[implementation]`
   - **Inherits:** ADR 0060; cite body is parent; child span optional metadata.
   - **Surface:** retrieve assembler / ES child index
   - **Acceptance:** Fixture with parent+child: A query hitting the child puts parent body in `chunks[]` text.
   - `[blocks: T1]`
   - Status: [ ] pending

3. **档 C report-first + drop** — tag: `[implementation]`
   - **Inherits:** ADR 0070; default drop after a report hit; `c_drop_windows=0` skips; not-ready → `community_summary_index_failure` not silent miss.
   - **Surface:** community ledger + ES/vectors on report text
   - **Acceptance:** C-ready fixture: hits are summary rows (ES∥vectors eligible); C-not-ready is typed; drop can be disabled by filter.
   - `[blocks: T1]`
   - **Note:** live C-ready needs graph-index plan T5.
   - Status: [ ] pending

4. **档 D unwired + five classes** — tag: `[implementation]`
   - **Inherits:** `real_db_not_wired`; document tables stay B.
   - **Surface:** retrieve assembler
   - **Acceptance:** `search_mode=D` → typed 未接, not SQL over chunks; overflow `limit`; concurrent retrieve; B ledger read throw still fail-open (parent community spec) while C not-ready stays typed.
   - `[blocks: T1]`
   - `[parallel]` with T2
   - Status: [ ] pending
