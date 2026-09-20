# Plan: entity type and retrieve filter

**Goal:** Graph entity types are the closed set `person | organization | place | event` on write, and retrieve may optionally restrict graph/entity seeds with `filters.entity_type` while operators keep one `retrieve` tool.
**Approach:** Land CHECK plus normalize-on-write so unknown proposed types never become rows; then teach extract only those four types; then add the optional retrieve routing key (strip, typed invalid, omit = all types) on the existing retrieve surface, including dashboard type display. Sibling specs and 资料归档 stay out.
**Spec link:** `specs/entity-type-and-filter.md`
**ACR:** all-yes (from spec)

bounded-context-guardian: yes — ledger entity type and retrieve filter stay in extraction/storage/retrieval; no host UI as a second corpus.
input-contract-tests: yes — empty omit, invalid type string, four legal values, unknown proposed extract type.
error-handling-enforcer: yes — invalid filter is typed; unknown extract type does not fail-open into a bucket.
complexity-anti-drift: yes — normalize stays one mapper; strip stays with other routing keys.
minimal-change-verifier: yes — taxonomy + one filter key only.

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## 待写入

CONTEXT `entity`: production CHECK = target four types; drop `concept`/`system` as stored values.

## Tasks (ordered by dependency)

1. **Closed types persist** — tag: `[implementation]`
   - **Inherits:** spec: mutually exclusive `person | organization | place | event`; Postgres CHECK plus normalize-on-write; `normalizeEntityType("Organization")` → `organization`; `"geo"` / `"location"` → `place`; organization/company/org/team → `organization`; geo/location/place → `place`; no `concept`/`system` catch-all; unknown proposed types are not inserted as entities (typed skip); after migrate/wipe, `entities.type='concept'` or `'system'` is rejected by CHECK.
   - **Surface:** extract persist + ledger `entities`
   - **Acceptance:** empty or wiped store: a legal mapped write stores one of the four types; unknown proposed type leaves no entity row; CHECK rejects `concept` and `system`; `npx vitest run` schema suite exits 0 for this invariant.
   - Status: [ ] pending

2. **Extract vocabulary matches the closed set** — tag: `[implementation]`
   - **Inherits:** spec: extract prompt / vocabulary strings contain `person|organization|place|event` and do not teach `concept`/`system` as stored types; new extracts only store the four types.
   - **Surface:** extract persist (prompt / vocabulary used by extract)
   - **Acceptance:** extract of new content only persists the four types; prompt/vocabulary text lists those four and does not list `concept` or `system` as stored types.
   - [blocks: 1]
   - Status: [ ] pending

3. **Optional `filters.entity_type` on retrieve** — tag: `[implementation]`
   - **Inherits:** spec: optional retrieve control key `entity_type` stripped like other routing keys; omitted key = all types; `filters.entity_type=person` does not pass that key through as chunk exact-match; graph-arm and entity-embedding seeds are person-only when that value is set; `filters.entity_type=widget` is typed invalid input, not silent ignore; MCP `tools/list` still has a single `retrieve` (no second retrieve tool); four legal values are accepted.
   - **Surface:** retrieve (`filters` map + existing wire-filters strip) + MCP `retrieve`
   - **Acceptance:** omit recalls all types; a legal type restricts graph/entity seeds to that type and is stripped from chunk exact-match; invalid value is typed invalid; `tools/list` still exposes one `retrieve`; `npx vitest run` on suites this change touches exits 0.
   - [blocks: 1]
   - Status: [ ] pending
   - [parallel] with 4 after 1

4. **Dashboard entity type display** — tag: `[implementation]`
   - **Inherits:** spec: dashboard entity `type` string display; operators still use the same retrieve tool (no host UI as a second corpus).
   - **Surface:** dashboard entity display
   - **Acceptance:** entity views show the stored type string for the four closed values; display does not require a second retrieve tool or a second corpus.
   - [blocks: 1]
   - Status: [ ] pending
   - [parallel] with 3 after 1

## End of round

After all four bullets land: one code-review phase vs `specs/entity-type-and-filter.md`, then verification-before-completion.
