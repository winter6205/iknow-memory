# Plan: graph index (standard vs Fast)

**Goal:** iknow index job implements two extract methods, Leiden communities, index-time summaries, and C-ready coupling — no ranking rewrite, no Host map-reduce.
**Approach:** Version metadata first, then replace Louvain detection with Leiden, then standard describe/claims, then Fast path, then rebuild/C-ready. Push slices stay fin’s; this repo does not re-chunk (ADR-0004).
**Spec link:** `specs/graph-index-standard-fast.md`
**Sibling:** [`../../fin/specs/graph-index-standard-fast.md`](../../fin/specs/graph-index-standard-fast.md)
**Program:** [`../../fin/plans/extract-index-search-mode-program.md`](../../fin/plans/extract-index-search-mode-program.md) wave 2
**ACR:** all-yes (from spec)

bounded-context-guardian: yes — Postgres SoR, Neo4j projection; retrieve 档 and Host cascade out.
input-contract-tests: yes — Boundaries name all 5 classes with Fake/no live GDS.
error-handling-enforcer: yes — typed EXITs named; public spelling is Open Question, not untyped fail.
complexity-anti-drift: yes — staged pipeline maps to existing modules, not one god-function.
minimal-change-verifier: yes — one index-time graph job.

**Per-ticket loop (all bullets):** tdd → typecheck+tests → typecheck → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

## 待写入

empty — ADR-0011 / CONTEXT **community** already flushed. Leiden **default seed integer** is implementer choice (must be fixed, not unseeded); record the value in tests.

## Tasks (ordered by dependency)

1. **One extract method per version** — tag: `[implementation]`
   - **Inherits:** ADR 0079 / 0068; default **standard**; no silent Fast.
   - **Surface:** extract CLI / version metadata on **资料** or ledger
   - **Acceptance:** Second method on the same version is typed fail; default job is standard; `npm test` without live GDS.
   - Status: [ ] pending

2. **Leiden replaces Louvain for community detection** — tag: `[implementation]`
   - **Inherits:** ADR-0011; spec lcc on, max size 10 tunable, fixed seed; summaries still Postgres.
   - **Surface:** graph community detector (today Louvain stream)
   - **Acceptance:** Detector yields hierarchical communities (levels or parent ids as implementer stores); default lcc; same graph+seed → same partition; Neo4j still projection-only; `npm test` fakes GDS.
   - `[blocks: T1]`
   - Status: [ ] pending

3. **Standard describe + claims after merge** — tag: `[implementation]`
   - **Inherits:** ADR 0069 / 0071; L0–L3 merge first; Fast skips both.
   - **Surface:** extract path after canonical merge
   - **Acceptance:** Survivor has one description before Leiden; claims present on standard fixture; Fast fixture has neither; one description miss does not fail the whole C job.
   - `[blocks: T1]`
   - `[parallel]` with T2
   - Status: [ ] pending

4. **Fast mixed zh/en regex, child co-occur, prune** — tag: `[implementation]`
   - **Inherits:** ADR 0076 / 0077 / 0073; empty Fast on Chinese **资料** typed fail; no second cut.
   - **Surface:** NLP extract + prune then Leiden
   - **Acceptance:** Product Fast default is not English-only regex; co-occurrence keyed by pushed children; prune before Leiden; standard path does not prune; empty Chinese Fast is job fail.
   - `[blocks: T1]`
   - **Note:** child packing quality depends on fin wave 1.
   - Status: [ ] pending

5. **Community summaries all-or-nothing + rebuild** — tag: `[implementation]`
   - **Inherits:** ADR 0064 / 0078; C not-ready; B graph-arm still usable.
   - **Surface:** community-summary CLI + version C-ready
   - **Acceptance:** Any community empty/error → typed fail, previous reports not served as current C; graph change rebuilds Leiden+summaries; `community_summary_index_failure` (or documented equivalent) surfaces to host; five classes including concurrent rebuild vs graph retrieve.
   - `[blocks: T2]`
   - Status: [ ] pending

6. **Three index embeddings** — tag: `[implementation]`
   - **Inherits:** ADR 0058; Fast has no entity-description class.
   - **Surface:** existing embedder at index
   - **Acceptance:** Window/slice, (standard) entity description, and community summary are embedded at index; query is not the first embed of those classes in tests with a Fake embedder.
   - `[blocks: T3, T5]`
   - Status: [ ] pending
