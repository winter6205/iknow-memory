# Plan: extract verify

**Goal:** After extract proposes triples, a yes/no grounded judge must pass before anything becomes graph fact; failures stay on `extraction_records` for the same CLI and dashboard maintenance lane.
**Approach:** First close persist so a judge no / down never writes `triples` or **projection outbox**. Then expose that failed state on `listFailed()` and CLI promote / discard / re-extract. Then the **iknow-memory dashboard** shows the same list and calls those same runners. Out of this plan: entity-type filter, contextual wrap, merge gray zone, retrieve judge rerank; no auto-escalate to a larger generative model; no new **资料** row for a failed extract.
**Spec link:** `specs/extract-verify.md`
**ACR:** all-yes (copied from spec)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)
**待写入:** CONTEXT extract: maintenance lane; unverified not authoritative; yes/no grounded judge before persist. (`extraction_records` already names the lane; **extract_triples** still omits the judge-before-persist contract.)

## ACR

```
bounded-context-guardian: yes — dashboard remains HTTP facade over core runners; Neo4j stays projection.
input-contract-tests: yes — empty proposal, judge fail, judge down, promote, discard.
error-handling-enforcer: yes — no fail-open into graph; typed failed record.
complexity-anti-drift: yes — verify helper after extract, before persist.
minimal-change-verifier: yes — verify + visibility, not a new 资料 type.
```

## Harvest（已决 vs 开放）

**已决 / inherits：**

- Judge answers yes/no whether each proposed **triple** is grounded in that **chunk** text; persist only after pass.
- Fail or judge-down: do not write `triples` / **projection outbox** / Neo4j; record proposal + reason on `extraction_records` (`status='failed'`).
- Judge throw/timeout is the same as fail (fail-closed); batch continues (**mark-and-continue** for other chunk errors unchanged).
- Credentials live in **operator setting**.
- `listFailed()` and the dashboard failed list show the same chunk ids.
- Opening **资料** detail still returns stored `content`; failed extract does not insert a second **资料**.
- Promote writes the held proposal into triples/outbox; discard leaves the graph unchanged; re-extract uses existing `--only-failed` / equivalent runner.
- Projection drain does not create Neo4j nodes/edges for unpromoted failures.
- Do not auto-escalate to a larger generative model.
- Acceptance command: `npx vitest run` on extract/records/dashboard suites this change touches.

**开放（implementer headroom）：**

- Adapter and helper filenames; how yes/no is serialized on the wire.
- How proposed payload is stored on `extraction_records` (column vs sidecar) as long as error_code + error_msg + payload are enough to review.
- Exact dashboard route/widget names; entity-page placement of unverified/rejected extract.

## Tasks (ordered by dependency)

1. **Judge persist: grounded yes before ledger write** — tag: `[implementation]`
   - **Inherits:** spec: judge yes/no grounded in that chunk; persist only after pass; fail or judge-down writes no `triples` / **projection outbox** / Neo4j; throw/timeout same as fail; fail-closed, mark failed, continue batch; empty proposal is a reject class; no auto larger model; no new **资料** row; **mark-and-continue** for other chunk errors unchanged; credentials in **operator setting**; verify helper after extract, before persist (ACR complexity line).
   - **Surface:** existing **extract_triples** pipeline (MCP `extract` / extract CLI write path)
   - **Acceptance:** a chunk whose proposed triple fails grounded (or judge throws/times out, or proposal is empty): zero new `triples` rows, no outbox intent, `extraction_records.status='failed'` with reason, batch continues; a passing judge still persists as today; **资料** count for that source is unchanged. `npx vitest run` on extract suites this change touches exits 0.
   - Status: [ ] pending

2. **Records/CLI: same failed list; promote, discard, re-extract** — tag: `[implementation]`
   - **Inherits:** spec: maintenance lane on `extraction_records`; `listFailed()` shows failed chunk ids; error_code + error_msg + proposed payload enough to review; promote writes the held proposal into triples/outbox; discard leaves graph unchanged; re-extract uses existing `--only-failed` / equivalent runner; drain does not create Neo4j nodes/edges for unpromoted failures.
   - **Surface:** existing extract CLI + `extraction_records` / `listFailed`
   - **Acceptance:** `listFailed()` after T1 fail includes that chunk id; promote then yields `triples` + outbox for the held proposal; discard leaves triples/outbox/Neo4j unchanged; re-extract goes through the same `--only-failed` runner (still judged before persist). `npx vitest run` on extract/records suites this change touches exits 0.
   - Status: [ ] pending
   - [blocks: T1]

3. **Dashboard: same list; promote via core runners** — tag: `[implementation]`
   - **Inherits:** spec: dashboard failed list shows the same chunk ids as `listFailed()`; operator can open the source **资料**, the chunk, and (when a stub entity exists) the entity page; entity page can show unverified/rejected extract tied to that entity; promote / discard / re-extract from dashboard call the same runners as CLI; reading uses existing 资料/chunk/entity pages.
   - **Surface:** existing **iknow-memory dashboard** (HTTP facade over core runners)
   - **Acceptance:** dashboard failed list chunk ids match `listFailed()`; opening **资料** still returns stored `content`; promote/discard/re-extract outcomes match T2 (same runners, not a second write path). `npx vitest run` on dashboard suites this change touches exits 0.
   - Status: [ ] pending
   - [blocks: T2]

## End of round

After T1–T3 land: `arthurpower:code-review` then `arthurpower:verification-before-completion`.
