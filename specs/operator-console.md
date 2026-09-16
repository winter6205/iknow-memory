# Spec: operator-console

> **Status:** assumption gate confirmed in-thread 2026-09-10 (items 1–10 plus header-search correction). Pair spec: `fin` worktree `specs/operator-console-host-contract.md`.
> **Map:** [操作员完整控制台：同一权威源上的检视、喂数与图投影](https://github.com/winter6205/iknow-memory/issues/201)

## Objective

Upgrade **iknow-memory** so the **iknow-memory dashboard** is an operator console over one **authoritative source**: **资料** is the prose system of record; **chunk** is a derived index row (ADR-0010). Operators browse and open **资料** the way they do on the original knowledge-base board (header always present; empty ledger keeps the shell; typeahead on names). Board chrome and pages follow the in-repo prototype `docs/wayfinder/prototypes/operator-board/`. Hosts write and read through **MCP tool**s (`ingest` / `push` / `invalidate` / `extract` / `retrieve` / `read_source`). Thin dashboard writes call the same runners as MCP/CLI.

**Who:** local operator; **host**s (including fin) via MCP.

**Success looks like:** dedicated database `iknow_memory` via **operator setting**; one write envelope; `read_source` returns full **资料** body; header typeahead does not call **retrieve**; three board states distinguishable (empty / named error / graph lag).

## Glossary

Exact copy from `docs/CONTEXT.md` (not redefined here):

- **iknow-memory**, **MCP tool**, **host**, **iknow-memory dashboard**, **资料**, **chunk**, **ledger schema**, **operator setting**, **authoritative source**, **derived index**, **content invalidation**, **ingest**, **push**, **retrieve**, **read_source**, **invalidate**, **extract_triples**, **entity**, **triple**, **projection outbox**, **Neo4j sidecar**, **degraded=true**

## Confirmed assumptions (gate)

1. This repo’s spec lives only in this worktree as `specs/operator-console.md`. Fin’s contract is a separate spec in the fin worktree. Commits stay in the owning repo.
2. Acceptance uses existing `npx vitest run` on the suites this change touches. No new test runner.
3. Operator UI: desktop Chromium. No mobile matrix.
4. Bin `iknow-memory` remains MCP stdio with no subcommand. Setting CLI is `iknow-memory-config`.
5. Sole **authoritative source** DSN is database `iknow_memory`. Do not read the old shared `postgres` catalog in parallel.
6. This repo does not convert PDF/office files. Fin already extracts text; this spec only stores what was pushed.
7. Out of this wave: **retrieve** query-result cache; physical delete after **content invalidation**; wiki-style pages; mode-bundle / `limit` chrome; lockstep fin Agent/XBRL.
8. Live MCP is not required in default CI. No new runtime dependency / lockfile change for **operator setting** (read JSON + existing `GRAPHRAG_MEMORY_*` key names).
9. Browser and hosts do not open Postgres or Neo4j. Dashboard HTTP and MCP share core runners.
10. Header typeahead filters **资料** `title` / `source_ref` in-process (or a cheap list read). It does not call **retrieve** and does not embed. Selecting an option opens that **资料** (or fills then opens). **retrieve** remains MCP-only this wave. Opening a **资料** / entity / graph does not embed.

## Boundaries

- **Does:**
  - **ledger schema** adds **资料**; **chunk** rows back-point with ordinal; `ensureTable` on empty `iknow_memory`.
  - **operator setting** at `~/.iknow-memory/setting.json`; env overrides; dashboard + MCP read it.
  - One **ingest** / **push** envelope: `source_ref` + 资料 body + `chunks[]` `{ content, index }`. One-slice list allowed (body equals that slice).
  - **read_source**: `source_ref` xor `id` → `{ id, source_ref, title?, content }`. Miss is named, not `""`.
  - **content invalidation** targets **资料** (and its **chunk**s). Close windows; do not delete rows this wave.
  - Dashboard: **资料** main list (id / `source_ref` / title; empty title displays `source_ref`); open full body; persistent header typeahead; no retrieve-page nav; keep timeline + stats; thin write controls on **资料** chrome (ingest / extract / invalidate / `graph:backfill` / `graph:drain`); graph node → **entity**; neighborhood existing route; empty shell vs named error vs graph lag (outbox pending or projection empty while ledger has **资料**).
  - List/open are on-demand (no full-corpus body fetch on enter). Same-session reopen may reuse last opened body in the SPA only.
- **Confirms with human:** (none remaining from the gate.)
- **Out of this spec:**
  - PDF/office conversion; **retrieve** result cache; physical purge; wiki pages; header **retrieve**; fin Agent/XBRL; merging frozen parallel dashboard SQL (PR 187).

## Success Criteria

- `npx vitest run` on new/updated suites for schema / ingest / `read_source` / invalidate / setting load exits 0.
- After point `GRAPHRAG_MEMORY_DB_URL` at an empty `iknow_memory`, process start + `ensureTable` exits 0 (no `embedding` missing on a narrow leftover `chunks` table).
- One-slice **ingest** creates exactly one **资料** row and one **chunk** row; `read_source` `content` equals pushed body; **retrieve** hit `content` equals that slice (byte-identical).
- Multi-slice **ingest** stores one **资料** and N **chunk**s with indexes `0..N-1`; **retrieve** never returns the concatenated body as one hit.
- **ingest** without `source_ref` is a validation error (exit/status typed).
- `read_source` unknown key is a named not-found (not 200 empty string).
- **invalidate** by `source_ref` makes subsequent **retrieve** omit those slices and `read_source` named-invalid (or equivalent typed miss), while rows still `SELECT`-able.
- Loading `~/.iknow-memory/setting.json` with DSN + keys starts dashboard-api without those keys exported in the shell; exported env wins when set.
- Header typeahead fixture: typing a **资料** `source_ref` substring lists that row and does not call `assembleRetrievalResult` / embedder.
- Opening **资料** detail does not invoke the embedder.
- Stats/graph: empty ledger → empty chrome (shell visible); storage error → error + retry, not empty; projection empty + non-empty **资料** count → graph-lag (not “no 资料”).
- `tools/list` includes `read_source`; `iknow-memory` CLI `--help`/stdio entry still rejects `config` as a subcommand (parseStdioEntry unchanged).

## Open Questions

(none)

## Inherits / Changes

**Inherits**

- ADR-0001, ADR-0003 (retrieval indexes derived; text SoR superseded by ADR-0010), ADR-0004 (no re-chunk), ADR-0005 / **degraded=true**, ADR-0006, ADR-0007, ADR-0010.
- Existing MCP names `ingest`, `push`, `invalidate`, `extract`, `retrieve`; HTTP dashboard on `dashboard/` + `src/dashboard-api/`; `assembleRetrievalResult`; Neo4j projection reads in `src/core/graph/projection-reads.ts`.
- Test command: `npx vitest run`.

**Changes**

- **资料** table and write/read tools as above; dashboard main list is **资料** not flat **chunk**.
- Header search is typeahead, not **retrieve**.
- Thin write HTTP.

**待写入:** flushed — CONTEXT glossary + flagged “not a host” line.

**Planned files (ACR; implementer may add tests beside each)**

- `src/core/storage/` schema + pgvector ensure
- `src/tools/ingest.ts`, `push.ts`, `invalidate.ts`, `read_source.ts` (new), `src/index.ts`
- `src/config.ts` + `bin/iknow-memory-config.js` (new)
- `src/dashboard-api/handlers/*`, `dashboard/src/chrome/*`, `dashboard/src/pages/*`
- matching `tests/**`

## architecture-change-reviewer

```
bounded-context-guardian: yes — dashboard remains HTTP facade not a host; Neo4j stays projection; 资料/chunk stay in authoritative-source storage; no wiki page context
defensive-contract-validator: yes — Success Criteria name empty (no source_ref), negative (unknown read_source / invalidate miss), overflow (chunk 1MB refuse), concurrent (re-push same source_ref), exception (storage vs empty vs graph-lag)
error-handling-enforcer: yes — named not-found / validation / STORAGE_ERROR; invalidate is close-window not silent delete; no empty catch as the miss path
complexity-anti-drift: yes — split: schema, MCP tools, setting bin, dashboard chrome; no second retrieve in the header
minimal-change-verifier: yes — one upgrade, sequenced commits (schema+tools, setting, dashboard); not one mega-commit; fin contract is the other repo
```
