# Plan: embedding generation rotate

**Goal:** Changing embed model or dimensions rebuilds chunk, entity-description, and community-summary vectors as one generation; cosine reads and query embed use only the active generation.
**Approach:** Ledger pointer + incoming slots first; dual-write persist while rotate is open; bind retrieve to active; then cutover / rollback / drop. Same-model NULL backfill stays a different path. No mixed-generation cosine.
**Spec link:** `specs/embedding-generation.md`
**ACR:** all-yes (from spec)

bounded-context-guardian: yes — ledger vector slots + operator rotate stay in storage/CLI; no host prompt assembly, no new MCP tool.
input-contract-tests: yes — desired≠active empty rotate, invalid/overflow dimensions vs ANN max, concurrent second rotate, embed exception mid-fill (incoming incomplete, active intact).
error-handling-enforcer: yes — typed `ConfigError` and existing embed/storage error codes on mismatch, incomplete cutover, downtime-read, embed fail; no silent DROP; no mixed-generation cosine; // EXIT on refuse-cutover and boot-mismatch.
complexity-anti-drift: yes — orchestrator (open rotate / fill three classes / cutover / drop) plus per-table slot helpers; no god-file that inlines SQL for three tables in one function.
minimal-change-verifier: yes — one task (embedding generation rotate); not eval suite, community-level cap, search_mode tokens, 资料归档, or M4.

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## 待写入

empty — CONTEXT **embedding generation** / **embedding backfill** already match.

## Tasks (ordered by dependency)

1. **Generation pointer + incoming slots; boot refuse** — tag: `[implementation]`
   - **Inherits:** spec: generation is (model, dimensions); same width different model is a new generation; incoming slot per three tables; desired ≠ active with no open rotate → typed `ConfigError`, no DROP of the live vector column.
   - **Surface:** storage schema / operator-setting embed keys / boot align path
   - **Acceptance:** fixture model change keeps old column; concurrent second rotate while one is open is typed refuse; boot mismatch does not DROP COLUMN.
   - Status: [ ] pending

2. **Dual-write persist on open rotate** — tag: `[implementation]`
   - **Inherits:** spec: ingest/push/extract/community-summary persist write **active** and **incoming** while rotate is open; ledger text sources unchanged (chunk wrap, entity assembler, community `summary`); **embedding backfill** remains NULL-only on **active**.
   - **Surface:** existing persist/embed writers for the three classes
   - **Acceptance:** new chunk during open rotate writes both slots; backfill with desired == active and non-NULL active vectors updates 0 rows and does not fill incoming.
   - `[blocks: T1]`
   - Status: [ ] pending

3. **[parallel] Retrieve bound to active** — tag: `[implementation]`
   - **Inherits:** spec: query embed and all cosine reads use **active** until cutover; no mix of slots in one `ORDER BY <=>`; incomplete incoming does not change reads.
   - **Surface:** retrieve vector / entity-seed / community-summary cosine
   - **Acceptance:** after fill but before cutover, retrieve ranks on the old slot with the old query model; same dimensions different model is not one shared cosine index over both slots.
   - `[blocks: T1]`
   - `[parallel]` with T2
   - Status: [ ] pending

4. **Cutover, downtime, rollback, drop** — tag: `[implementation]`
   - **Inherits:** spec: cutover refused until all three classes complete on incoming; one pointer flip; downtime flag typed-refuses vector retrieve until cutover; rollback flips back; drop removes inactive slot; second drop no-op.
   - **Surface:** operator CLI family for rotate / cutover / drop
   - **Acceptance:** incomplete incoming → typed refuse, retrieve still active; after complete cutover, next retrieve uses new model+dimensions on all three classes; downtime flag refuses vector retrieve until cutover; rollback then drop behave as spec; `npx vitest run` on touched suites exits 0.
   - `[blocks: T2, T3]`
   - Status: [ ] pending

## End of round

After T1–T4 land: one code-review phase vs `specs/embedding-generation.md`, then verification-before-completion.
