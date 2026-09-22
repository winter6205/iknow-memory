# Plan: search-mode word tokens — T1 record and the identifier-retire follow-up

**Goal:** The retrieve wire carries only `lexical | graph | global | sql` with zero letter coexistence; this file records the landed evidence and owns the source-level naming debt the values-only ruling deferred.
**Approach:** T1 shipped expand-and-retire in one ticket on branch `feat/search-mode-word-tokens`. What the ruling did NOT reach is the arm identifiers and letter-named comments — those move here, in one named contract ticket, "not as a drive-by".
**Spec link:** `specs/search-mode-lexical-sql-tokens.md` (operator ruling 2026-09-22, ACR PASS, values-only scope)
**Sibling plan:** [`../../fin/plans/search-mode-lexical-sql-tokens.md`](../../fin/plans/search-mode-lexical-sql-tokens.md) (fin retokenizes its entry seams after this landed set)

**ACR:** all-yes (inherited from the spec header; this file opens no new contract — it only owns the deferred rename).

## T1 evidence (this increment — closed)

- Hermetic (fakes, no live ES/GDS/PG): the targeted search-mode suites `tests/retrieval/search-mode.test.ts` + `tests/defensive/search-mode-defensive.test.ts` + `tests/retrieve.test.ts` + `tests/retrieval/neo4j-arm-fuse.test.ts` → **103 passed**; the wider hermetic acceptance gate ran **299 passed**. `npm run typecheck` and `npm run build` exit 0.
- **LIVE (必选):** `tests/integration/retrieve-search-mode-pg.test.ts` → **4/4 passed** against real Postgres + real Elasticsearch (production `buildRetrieveDeps` wiring): `lexical` cites the ADR-0060 parent 抽图窗 body while ES only ever saw the child slices; `sql` throws the typed `real_db_not_wired` refusal naming `sql`; a missing key is byte-equal to explicit `graph`; every retired letter `A`/`B`/`C`/`D` comes back as a typed `invalid_search_mode` refusal carrying `SEARCH_MODE_WIRE_COPY`.

## 待写入

- `docs/CONTEXT.md` **retrieve** sentence: proposed in the spec's 待写入 section (letters accepted by nothing, no migration window). Not applied here — the operator's working copy carries uncommitted edits.

## Tasks (ordered by dependency)

1. **Identifier retire: letter-named sources** — tag: `[implementation]`
   - **Inherits:** spec assumption 6 — the 2026-09-22 ruling is values-only, so the wire closed set `lexical | graph | global | sql` is unchanged by this ticket; only source-level names move. graph-global T4 owner rule: the ticket that carries a retired letter's renames is this one.
   - **Surface:** `src/core/retrieval/mode-a-arm.ts` + `modeAParentWindowArm`, `src/core/retrieval/mode-c-arm.ts` + `modeCReportFirstArm`, the `modeDNotWiredArm` spelling, `C_DROP_WINDOWS_FILTER_KEY` / `cDropWindowsEnabled` / `stripCDropWindowsFilter` and their `wire-filters.ts` bindings; callers (`search-mode.ts` table, arms' tests).
   - **Also owns:** the residual comment sweep the spec does NOT claim — `src/core/retrieval/types.ts` 档 A / 档 C prose and the `mode-a-arm.ts` / `mode-c-arm.ts` file headers (keep at most the one historical mention per file so old `search_mode=C` log lines stay readable).
   - **Not owned here:** the wire **value** `c_drop_windows` (host-visible filters key) — retiring or renaming it is its own contract step with fin (spec Open Question 2).
   - **Acceptance:** `npm run typecheck` exit 0; the four targeted suites above green with the renamed identifiers; `tests/integration/retrieve-search-mode-pg.test.ts` still 4/4 on live PG+ES; the wire closed set and refusal byte contracts unchanged (`SEARCH_MODE_WIRE_COPY`, `invalid_search_mode`, `real_db_not_wired`).
   - Status: [ ] pending

## End of round

After T-last lands: one code-review phase vs `specs/search-mode-lexical-sql-tokens.md`, then verification-before-completion. No new spec surface opens in this ticket.
