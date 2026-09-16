# Plan: operator-console

**Goal:** Operator console over one **authoritative source**: **资料** as prose SoR, **chunk** as derived index; hosts write/read via MCP; dashboard lists/opens **资料** with header typeahead (no **retrieve**).
**Approach:** Schema first so empty `iknow_memory` can boot. Then one write envelope and `read_source` / **invalidate**. Setting bin in parallel with schema. Dashboard last: match `docs/wayfinder/prototypes/operator-board/` (list/open/three states, typeahead, thin writes + graph→entity). Out of this plan: **retrieve** query cache, physical purge (map follow-up #213), PDF conversion, wiki pages.
**Spec link:** `specs/operator-console.md`
**Pair plan:** `fin` `plans/operator-console-host-contract.md` (Fake MCP; live transport optional)
**Board prototype:** `docs/wayfinder/prototypes/operator-board/`
**Tracker:** **local markdown fallback** — operator: 本程序不开 GitHub issue tracker；票以本文件 Tasks 编号为准。
**Map:** [操作员完整控制台：同一权威源上的检视、喂数与图投影](https://github.com/winter6205/iknow-memory/issues/201)
**ACR:** all-yes (copied from spec · 2026-09-10)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch
**End-of-round:** 全部子弹落地后对整轮 diff 做一次 code-review（Standards + Spec）
**待写入:** flushed — CONTEXT flagged “not a host” line (header typeahead, not retrieve).

## ACR

```
bounded-context-guardian: yes — dashboard remains HTTP facade not a host; Neo4j stays projection; 资料/chunk stay in authoritative-source storage; no wiki page context
defensive-contract-validator: yes — Success Criteria name empty (no source_ref), negative (unknown read_source / invalidate miss), overflow (chunk 1MB refuse), concurrent (re-push same source_ref), exception (storage vs empty vs graph-lag)
error-handling-enforcer: yes — named not-found / validation / STORAGE_ERROR; invalidate is close-window not silent delete; no empty catch as the miss path
complexity-anti-drift: yes — split: schema, MCP tools, setting bin, dashboard chrome; no second retrieve in the header
minimal-change-verifier: yes — one upgrade, sequenced commits (schema+tools, setting, dashboard); not one mega-commit; fin contract is the other repo
```

## Harvest（已决 vs 开放）

**已决 / inherits：**

- ADR-0001, ADR-0004 (no re-chunk), ADR-0005 / **degraded=true**, ADR-0006, ADR-0007, ADR-0010 (**资料** SoR; **chunk** derived).
- Dedicated DB `iknow_memory`; no ALTER shared `postgres`; old islands not migrated.
- One envelope: `source_ref` + 资料 body + `chunks[]` `{ content, index }`.
- **invalidate** closes windows; does not delete rows this wave.
- `read_source`: `source_ref` xor `id`; miss is named, not `""`.
- Header typeahead filters `title` / `source_ref`; does not **retrieve** or embed.
- Bin `iknow-memory` stays MCP stdio; setting CLI is `iknow-memory-config`.
- Acceptance command: `npx vitest run` on suites this change touches.

**开放（implementer headroom）：**

- Table/column names and `ensureTable` layout as long as 资料 + ordinal chunk back-pointers exist.
- How typeahead loads the name list (in-process filter vs cheap list read).
- Exact HTTP path names for thin writes and 资料 list/detail.
- How “graph-lag” is detected (outbox pending and/or empty projection + non-zero 资料 count).

## Tasks (ordered by dependency)

1. **Empty `iknow_memory` gets ledger schema** — tag: `[implementation]`
   - **Inherits:** spec Boundaries / SC: **ledger schema** adds **资料**; **chunk** rows back-point with ordinal; `ensureTable` on empty `iknow_memory`; do not ALTER shared `postgres`; no `embedding` missing on a leftover narrow `chunks` table.
   - **Surface:** existing `src/core/storage`
   - **Acceptance:** pointing `GRAPHRAG_MEMORY_DB_URL` at an empty `iknow_memory`, process start + `ensureTable` exits 0; a **资料** row can exist with N **chunk** rows indexed `0..N-1` that back-point to it. `npx vitest run` on the storage suite this bullet touches exits 0.
   - Status: [x] done — commit 6c3ba3a (source_documents table + chunks.source_doc_id/ordinal back-pointers)

2. **[parallel] Operator setting + `iknow-memory-config`** — tag: `[implementation]`
   - **Inherits:** spec: `~/.iknow-memory/setting.json`; keys stay `GRAPHRAG_MEMORY_*`; env overrides; missing file does not block start; `iknow-memory` stdio rejects `config` as a subcommand (`parseStdioEntry` unchanged).
   - **Surface:** existing `src/config` and bin entrypoints
   - **Acceptance:** loading setting.json with DSN + keys starts dashboard-api without those keys exported in the shell; exported env wins when set; `iknow-memory` CLI/stdio still rejects `config`. `npx vitest run` on the config/stdio suites this bullet touches exits 0.
   - Status: [x] done — commit 351a855 (setting-store + resolver wired into readEnv SSOT; iknow-memory-config bin)
   - [parallel]

3. **One ingest/push envelope** — tag: `[implementation]`
   - **Inherits:** spec: `source_ref` + 资料 body + `chunks[]` `{ content, index }`; one-slice list allowed (body equals that slice); **ingest** without `source_ref` is a typed validation error; re-push same `source_ref` is the concurrent class; chunk overflow refuse per ACR (1MB).
   - **Surface:** existing MCP write tools (`ingest` / `push`)
   - **Acceptance:** one-slice **ingest** creates exactly one **资料** and one **chunk**; **retrieve** hit `content` equals that slice (byte-identical). Multi-slice stores one **资料** and N **chunk**s `0..N-1`; **retrieve** never returns the concatenated body as one hit. Missing `source_ref` is a typed error. `npx vitest run` on the ingest/push suites this bullet touches exits 0.
   - Status: [x] done — commit faec7be (one envelope { source_ref, content, chunks[] }; rebuild-on-repush with orphan sweep; 1MB refuse; legacy shape adapter)
   - [blocks: T1]

4. **`read_source` returns full 资料 body** — tag: `[implementation]`
   - **Inherits:** spec: `source_ref` xor `id` → `{ id, source_ref, title?, content }`; miss is named, not `""`; `tools/list` includes `read_source`.
   - **Surface:** existing MCP tool surface (`src/tools` / `src/index.ts`)
   - **Acceptance:** `tools/list` includes `read_source`; known key returns body equal to the pushed 资料; unknown key is a named not-found (not 200 empty string). `npx vitest run` on the suites this bullet touches exits 0.
   - Status: [x] done — commit 278a667 (read_source tool: source_ref xor id -> {id, source_ref, title?, content}; named miss; six-tool catalog)
   - [blocks: T1, T3]

5. **Invalidate closes the 资料 window, keeps rows** — tag: `[implementation]`
   - **Inherits:** spec: **content invalidation** targets **资料** and its **chunk**s; close windows; do not delete rows this wave.
   - **Surface:** existing `invalidate` tool
   - **Acceptance:** **invalidate** by `source_ref` makes subsequent **retrieve** omit those slices and `read_source` a named-invalid (or equivalent typed miss); rows remain `SELECT`-able. `npx vitest run` on the invalidate suite this bullet touches exits 0.
   - Status: [x] done — commit d02249d (source_documents.valid_until closed in same tx as chunk windows; read_source_invalidated named miss; rows stay SELECT-able)
   - [blocks: T3, T4]

6. **Dashboard lists and opens 资料; three board states** — tag: `[implementation]`
   - **Inherits:** spec: main list is **资料** (id / `source_ref` / title; empty title displays `source_ref`); open full body; keep timeline + stats; list/open on-demand (no full-corpus body fetch on enter); empty ledger keeps the shell; storage error is named + retry, not empty; projection empty + non-empty **资料** count is graph-lag, not “no 资料”; opening **资料** does not invoke the embedder. Chrome and page shape follow `docs/wayfinder/prototypes/operator-board/` (`App.vue` header/nav, `PageList.vue`, `PageDetail.vue`).
   - **Surface:** existing `dashboard/` + `src/dashboard-api/`
   - **Acceptance:** empty ledger → shell visible; storage error → error + retry; graph-lag distinguishable from empty; opening detail does not invoke the embedder; list/detail layout is recognizably the operator-board prototype, not a stats-only monitor. Suites this bullet touches exit 0 under `npx vitest run`.
   - Status: [x] done — commit 09000e1 (/api/sources + detail; SourcesPage/SourceDetailPage per operator-board prototype; graph-lag vs empty vs error pinned; embedder-not-invoked spy)
   - [blocks: T2, T3, T4]

7. **Header typeahead does not retrieve** — tag: `[implementation]`
   - **Inherits:** spec assumption 10: filters **资料** `title` / `source_ref`; does not call **retrieve** and does not embed; selecting an option opens that **资料** (or fills then opens); no retrieve-page nav. Typeahead widget shape follows `docs/wayfinder/prototypes/operator-board/src/components/SearchSuggest.vue`. Prototype header still has search-mode + submit; spec wins — do not wire those to **retrieve**.
   - **Surface:** existing dashboard chrome
   - **Acceptance:** typing a **资料** `source_ref` substring lists that row and does not call `assembleRetrievalResult` / embedder. `npx vitest run` on the chrome suite this bullet touches exits 0.
   - Status: [x] done — commit b33a69e (HeaderSearch in-process filter over /api/sources summaries; selection opens /sources/:id; no /api/query traffic pinned)
   - [blocks: T6]

8. **Thin writes on 资料 chrome; graph node opens entity** — tag: `[implementation]`
   - **Inherits:** spec: thin write controls on **资料** chrome (ingest / extract / invalidate / `graph:backfill` / `graph:drain`) call the same runners as MCP/CLI; graph node → **entity**; neighborhood keeps the existing route. Import/graph page shape follows `docs/wayfinder/prototypes/operator-board/` `ImportView.vue` / `GraphView.vue`.
   - **Surface:** existing dashboard HTTP + graph pages
   - **Acceptance:** each named thin write hits the same runner as the matching MCP/CLI path; a graph node click opens an **entity**, not a **资料**. Suites this bullet touches exit 0 under `npx vitest run`.
   - Status: [x] done — commit 6fed1a5 (/api/writes/* delegating to MCP/CLI runner modules, spy-pinned; VisGraph onSelectNode -> /browse/entities/:id)
   - [blocks: T5, T6]
