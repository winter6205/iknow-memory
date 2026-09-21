# Spec: extract verify and maintenance lane

## Objective

After the extract LLM proposes triples from a chunk, a **judge** answers yes/no whether each proposed triple is grounded in that chunk text. Fail or judge-down: do not write `triples` / projection outbox / Neo4j. Record the proposal and reason on `extraction_records` (failed) so the operator can open the source **资料**, the chunk, and (when a stub entity exists) the entity page. Operator actions: promote (write to graph), discard, or re-extract. Do not auto-escalate to a larger generative model. Do not create a new 资料 row for a failed extract.

**Who:** extract MCP/CLI; iknow-memory dashboard.

**Success looks like:** dirty triples never become graph facts; the same failure list is visible in CLI and on the dashboard; reading uses existing 资料/chunk/entity pages.

## Boundaries

- **Does:** judge adapter (yes/no grounded; credentials in operator setting); persist only after pass; fail-closed on judge timeout/error (mark failed, continue batch); error_code + error_msg + proposed payload enough to review; dashboard list of failed records with reason, link to 资料 and chunk; entity page can show unverified/rejected extract tied to that entity; Neo4j projector skips unverified; promote / discard / re-extract from dashboard calling the same runners as CLI; mark-and-continue unchanged for other chunk errors.
- **Confirms with human:** none.
- **Out of this spec:** [entity type and filter](entity-type-and-filter.md); [contextual wrap](contextual-wrap-embed.md); [merge gray zone](merge-gray-zone-judge.md); [retrieve judge rerank](retrieve-judge-rerank.md).

## Success Criteria

- Chunk whose proposed triple fails the grounded check: zero new `triples` rows, `extraction_records.status='failed'`, reason stored; batch continues.
- Judge throw/timeout: same as fail (not succeed).
- `listFailed()` and dashboard failed list show the same chunk ids.
- Opening 资料 detail still returns stored `content`; failed extract does not insert a second 资料.
- Promote writes the held proposal into triples/outbox; discard leaves graph unchanged; re-extract uses existing `--only-failed` / equivalent runner.
- Projection drain does not create Neo4j nodes/edges for unpromoted failures.
- `npx vitest run` on extract/records/dashboard suites this change touches exits 0.

## Open Questions

(none)

## Inherits / Changes

**Inherits:** `extraction_records`, `listFailed`, mark-and-continue, extract MCP/CLI, 资料/chunk/entity dashboard pages, projection outbox, operator setting file.

**Changes:** judge step before persist; dashboard failure queue; promote/discard; fail-closed judge.

**待写入:** CONTEXT extract: maintenance lane; unverified not authoritative; yes/no grounded judge before persist.

## Architecture Change Reviewer

bounded-context-guardian: yes — dashboard remains HTTP facade over core runners; Neo4j stays projection.
input-contract-tests: yes — empty proposal, judge fail, judge down, promote, discard.
error-handling-enforcer: yes — no fail-open into graph; typed failed record.
complexity-anti-drift: yes — verify helper after extract, before persist.
minimal-change-verifier: yes — verify + visibility, not a new 资料 type.
