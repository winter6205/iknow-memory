# Spec: entity type and retrieve filter

## Objective

Make graph entity types a closed, mutually exclusive set `person | organization | place | event`, persist that set in Postgres CHECK and normalize-on-write, and let retrieve optionally restrict graph/entity seeding with `filters.entity_type`. Operators and hosts still use one `retrieve` tool. Unknown proposed types are not written as entities.

**Who:** extract persist, retrieve callers, dashboard entity display.

**Success looks like:** empty or wiped store; new extracts only store the four types; optional type filter changes graph/entity seeds without splitting MCP tools.

## Boundaries

- **Does:** migrate `entities.type` CHECK and `ENTITY_TYPES`; rewrite `normalizeEntityType` (organization/company/org/team → `organization`; geo/location/place → `place`; no `concept`/`system` catch-all; unknown → do not insert entity); extract prompt lists the four types; optional retrieve control key `entity_type` stripped like other routing keys; invalid value is typed invalid input; omitted key = all types; graph-arm and entity-embedding seeds honor the filter; MCP tool list unchanged.
- **Confirms with human:** none remaining from the assumption gate for this slice.
- **Out of this spec:** [contextual wrap](contextual-wrap-embed.md); [extract verify](extract-verify.md); [merge gray zone](merge-gray-zone-judge.md); [retrieve judge rerank](retrieve-judge-rerank.md).

## Success Criteria

- After migrate/wipe, inserting `entities.type='concept'` or `'system'` is rejected by CHECK (`npx vitest run` schema suite).
- `normalizeEntityType("Organization")` → `organization`; `"geo"` / `"location"` → `place`; unknown does not persist an entity row (typed skip / no catch-all).
- Extract prompt / vocabulary strings contain `person|organization|place|event` and do not teach `concept`/`system` as stored types.
- `retrieve` with `filters.entity_type=person` does not pass that key through as chunk exact-match; graph/entity seeds are person-only; omitting the key recalls all types.
- `filters.entity_type=widget` is typed invalid input, not silent ignore.
- MCP `tools/list` still has a single `retrieve` (no `retrieve_person`).
- `npx vitest run` on suites this change touches exits 0.

## Open Questions

(none)

## Inherits / Changes

**Inherits:** Postgres authoritative entities; extract persist boundary; retrieve `filters` map + `wire-filters` strip pattern; MCP `retrieve`; dashboard entity `type` string display.

**Changes:** CHECK + mapper + prompt; retrieve routing key `entity_type`.

**待写入:** CONTEXT `entity` production CHECK = target four types; drop `concept`/`system` as stored values.

## Architecture Change Reviewer

bounded-context-guardian: yes — ledger entity type and retrieve filter stay in extraction/storage/retrieval; no host UI as a second corpus.
input-contract-tests: yes — empty omit, invalid type string, four legal values, unknown proposed extract type.
error-handling-enforcer: yes — invalid filter is typed; unknown extract type does not fail-open into a bucket.
complexity-anti-drift: yes — normalize stays one mapper; strip stays with other routing keys.
minimal-change-verifier: yes — taxonomy + one filter key only.
