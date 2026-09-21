# Plan: merge gray-zone judge

**Goal:** After L0–L3 leave a pair in the gray zone, a three-level judge may merge, refuse merge, or hold for the operator; judge-down stays reject plus structured log.
**Approach:** Keep existing L0–L3 cosine/rule gates. Add a gray-only judge after the L3 reject path. Persist merge / dual-live / hold through extract persist. Human holds emit records onto the extract-verify maintenance lane; this plan does not own dashboard UI.
**Spec link:** `specs/merge-gray-zone-judge.md`
**Required (human hold):** `specs/extract-verify.md` (lane contract; not that plan file)
**ACR:** all-yes (block below)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

**待写入:** none — `docs/CONTEXT.md` already records gray-zone three-level judge and judge-down reject.

**Affects (planned, ACR scope):** `src/core/entities/merge.ts`, `src/core/entities/types.ts`, `src/core/extraction/persist.ts`, `tests/entities/merge.test.ts` (plus extract/persist tests this change touches). No dashboard or retrieve files.

## ACR

bounded-context-guardian: yes — merge stays in entities; extract persist writes `merged_into` and hold records; dashboard/lane UI stays extract-verify.
input-contract-tests: yes — L0 skip-judge; three judge levels; judge throw/down (empty/overflow/concurrent N/A on this gate).
error-handling-enforcer: yes — judge-down does not merge; gray-zone structured log still emitted.
complexity-anti-drift: yes — one gray-zone helper after L3; L0–L3 gates unchanged.
minimal-change-verifier: yes — gray zone only; no dashboard re-own.

## Tasks (ordered by dependency)

1. **Gray-only judge: merge vs do not merge** — tag: `[implementation]`
   - **Inherits:** spec: L0–L3 thresholds unchanged; judge only when L3 would take the gray-zone reject path; no judge on every candidate pair; L0 exact same name+type still merges with zero judge calls; fake judge `merge` writes `merged_into`; fake `do not merge` leaves two live entities
   - **Surface:** `src/core/entities` merge; extract persist (`merged_into`)
   - **Acceptance:** unit test with fake judge: L0 path call count is 0 and merge still happens; gray pair + `merge` writes `merged_into`; gray pair + `do not merge` leaves two live entities; `npx vitest run` on merge/extract suites this change touches exits 0
   - Status: [ ] pending

2. **Judge-down keeps reject + log** — tag: `[implementation]`
   - **Inherits:** spec: fake judge throw → no merge, gray-zone log still emitted; judge-down = today’s gray-zone reject + structured log
   - **Surface:** `src/core/entities` merge (gray-zone log sink)
   - **Acceptance:** fake judge throw: neither entity is merged away; a structured gray-zone log entry is still emitted
   - [blocks: T1]
   - Status: [ ] pending

3. **Human hold emits extract-verify lane record** — tag: `[implementation]`
   - **Inherits:** spec: `human` writes no merge and a failed/hold record listable with extract failures; operator-held pairs use the same maintenance lane as extract verify; this spec only emits records — shared lane UI is owned by extract-verify
   - **Surface:** extract persist; `extraction_records` / `listFailed()` (existing extract visibility). Do not add dashboard routes or pages here.
   - **Acceptance:** fake judge `human`: no `merged_into`; a hold/failed record is listable with extract failures; no dashboard files in this diff
   - [blocks: T1]
   - [blocks: extract-verify T1]
   - Status: [ ] pending

## Code review phase (end of round)

After all bullets of this task land: `code-review`; `GATE: BLOCKED` → next slot `review-report-repair`.
