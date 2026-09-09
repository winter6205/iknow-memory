# Spec: iknow-memory dashboard

> **Status:** assumption gate = wayfinder map [#188](https://github.com/winter6205/iknow-memory/issues/188) Decisions so far (2026-09-09). ACR block below.
> **Map:** [冻结 PR 187，重写 memory 监控看板](https://github.com/winter6205/iknow-memory/issues/188)
> **Plan:** `plans/iknow-memory-dashboard.md`
> **Frozen PR (do not merge):** [#187](https://github.com/winter6205/iknow-memory/pull/187) · branch `worktree-memory-dashboard-plan` is read-only对照. T1 shapes are **not** SSOT.

## Objective

Ship the **iknow-memory dashboard**: an operator HTTP read facade and React SPA in this repo, over the **same core** as **MCP tool**s. Operators can inspect memory (stats, retrieve, graph projection, Postgres entity/chunk/timeline) with the source knowledge-base board’s chrome (fonts + skeleton) and **冷墨** / **晨纸** colors. Not a **host**, not an MCP client, not the iknow harness UI.

**Who uses it:** a local operator on `127.0.0.1`.

**Success looks like:** `npm` scripts start thin HTTP + SPA on port **18868**; pages show real data or empty states; graph reads Neo4j when configured; no parallel SQL/boot; no write buttons this round.

## Glossary

Exact copy from `docs/CONTEXT.md` (not redefined here):

- **iknow-memory**, **MCP tool**, **host**, **iknow-memory dashboard**, **chunk**, **entity**, **authoritative source**, **Neo4j sidecar**, **retrieve**, **degraded=true**, **valid_window**

## Confirmed assumptions (gate · wayfinder #188)

1. Do not merge PR 187. Branch `worktree-memory-dashboard-plan` is对照 only. T1 11-endpoint JSON pins are not inherited.
2. One core, two facades: stdio **MCP tool**s and thin HTTP. HTTP does not `tools/call`.
3. No parallel SQL and no parallel process boot (no second embedder/ES/Neo4j stack copied beside MCP). Missing core read surfaces are added on **core**, not in a dashboard-only query file.
4. Graph canvas reads the Neo4j **read-only projection**. Entity / **chunk** / timeline read Postgres (**authoritative source**). Retrieve uses `assembleRetrievalResult`.
5. Visual: source-board skeleton + Playfair Display / Space Grotesk / Fira Code. Default **冷墨**; switchable **晨纸**. Not source teal/cream. Product name **iknow-memory**, not iknow.
6. SPA lives in this repo `dashboard/`. Stack is PR 187’s React 18 + Vite + Tailwind + Radix + zustand + react-router. Tokens are CSS variables (theme switch). Graph: vis-network (not cytoscape by default).
7. Bind `127.0.0.1`. No auth this round. SPA listen **18868** (not 5173). API is a separate port (env-overridable; 187对照 default 4174 is allowed as a starting number).
8. `storage=memory` is a legal empty ledger: empty states, not errors. Missing Neo4j (or other true capability gap) errors only on the surfaces that need it. ADR-0005 **degraded=true** still applies on retrieve.
9. This round is **read-only**. consolidate / graph:backfill / graph:drain / retire are **not** on the board (not “never”; not ready). No page CRUD / tags / import / Brain Score.
10. Wiki “Chunks” on the source board are not this product’s **chunk**.

## HTTP read surfaces (names, not 187 JSON)

Implementer chooses concrete JSON so long as tests pin behaviour below. Suggested paths (changeable if acceptance still holds):

| Surface                  | Suggested path                             | Data origin                                                                     |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------- |
| Health                   | `GET /api/health`                          | process + storage mode                                                          |
| Stats                    | `GET /api/stats`                           | core counts (memory map or PG)                                                  |
| Retrieve                 | `GET /api/query`                           | `assembleRetrievalResult`                                                       |
| Graph                    | `GET /api/graph`                           | Neo4j read session via existing graph wiring                                    |
| Entity neighborhood      | `GET /api/entities/:id/backlinks`          | Neo4j read **or** core projection helper — not dashboard Cypher strings as SSOT |
| Chunk/entity list+detail | `GET /api/chunks`, `/api/entities`, `/:id` | Postgres / memory backend via core                                              |
| Timeline                 | `GET /api/timeline`                        | **chunk** `valid_window` + invalidation records via core                        |

No `POST /api/maintenance` this round.

## Boundaries

- **Does:**
  1. Core public reads if storage today cannot list/count/timeline without raw SQL.
  2. Thin HTTP over those reads + retrieve + graph; bind `127.0.0.1`.
  3. React SPA: chrome, 冷墨/晨纸, pages for the surfaces above; empty vs capability-error.
  4. Root scripts + README so a clone can start API + SPA (browser on 18868).
- **Confirms with human:** none remaining from the map. Palette hex may move a few points if roles stay (底/字/强调/glow).
- **Out of this spec:** merging 187; MCP catalog changes; Host prompt/assembly; writing Neo4j outside projection (ADR-0001); auth / LAN bind; maintenance buttons; wiki port; iknow harness UI; health-trend metrics table.

## Success Criteria

Binary; each maps to a command or measurable check.

1. **Bind:** dashboard HTTP listen address is `127.0.0.1`. A request to a non-loopback bind is out of this spec (not implemented). Check: server config test or listen assertion.
2. **SPA port:** Vite/dev (or equivalent) serves the SPA on **18868**, not 5173. Check: config in repo + `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18868/` is 200 when `npm run dashboard` (or documented script) is up.
3. **No tools/call:** dashboard HTTP handlers do not import an MCP client or spawn stdio MCP to serve reads. Check: grep/architectural test or module boundary test.
4. **Retrieve SSOT:** query surface calls `assembleRetrievalResult` (or the same function retrieve MCP uses). Empty hits are 200 + empty list, not a crash. `degraded` / `degraded_reasons` follow ADR-0005 when set. Check: `npx vitest` on dashboard/query tests.
5. **Store split:** graph surface fails structured when Neo4j is required and missing; chunk/entity/timeline still succeed against memory or PG empty/full. Check: tests for both cases.
6. **Empty vs error:** memory backend + no Neo4j → stats/browse/timeline empty or zeros; graph is structured error; UI shows empty state vs error+retry, not a generic “non-PG error” for empty ledger. Check: API tests + one documented browser pass or Playwright if added.
7. **Read-only:** no maintenance POST (or equivalent write) registered. Check: router test 404/405.
8. **Theme:** default 冷墨; control switches 晨纸 (CSS variables). Fonts are Playfair Display, Space Grotesk, Fira Code. Check: CSS tokens present; visual check against `docs/wayfinder/prototypes/iknow-memory-palette-193.html` sections 冷墨 / 晨纸.
9. **Existing suite:** `npm run typecheck` and `npm test` exit 0 (existing skips unchanged).
10. **No 187 merge:** this work is a new branch from `main`, not a rebase of `worktree-memory-dashboard-plan` as the implementation trunk.

## Open Questions

(none)

## Inherits / Changes

**Inherits**

- ADR-0001 Postgres SoR / Neo4j read-only projection; chunks never enter Neo4j.
- ADR-0005 `degraded` four rules; ADR-0006 graph/rerank fail-start.
- Retrieve assembly: `assembleRetrievalResult` / `loadEnv()` / existing storage + graph ranker construction used by the MCP server (extend, do not copy).
- Test runner: `npm test` (vitest), `npm run typecheck`.
- CONTEXT term **iknow-memory dashboard** (already persisted).

**Changes**

- New operator surface: thin HTTP + `dashboard/` SPA (not a new MCP tool).
- New core **read** methods only if current `StorageBackend` cannot satisfy list/count/timeline without dashboard-local SQL.
- 待写入: (none — glossary flushed on #198)

## ACR (spec gate · 2026-09-09)

bounded-context-guardian: yes — HTTP + `dashboard/` are the **iknow-memory dashboard** facade; they call core/storage/retrieval/graph already used by MCP; no `controllers/`/`services/` tree; no `src/tools` → `src/cli` for reads; wiki/host UI out.
defensive-contract-validator: yes — Testing Strategy: empty ledger, missing Neo4j, illegal query, retrieve exception → typed HTTP error, no write/maintenance concurrent POST this round (absent). Plan bullets must name those classes on public handlers.
error-handling-enforcer: yes — capability-missing vs empty-ledger are different typed outcomes; no empty catch; retrieve failures are not silent `[]` when all arms failed (follow existing retrieve contract).
complexity-anti-drift: yes — thin handlers + core reads; no second boot graph; SPA pages compose chrome/tokens, not a god App store.
minimal-change-verifier: yes — one product slice (read dashboard); 187 leftover is not the trunk; maintenance/auth/LAN out so the commit train stays one capability.

OVERALL: PASS — hand to `writing-plans`.

## Testing Strategy

Public HTTP and any new core read methods: normal / empty / illegal input / dependency missing / retrieve failure. Do not weaken existing retrieve tests. Browser: at least documented pass of 冷墨 default + 晨纸 switch + one empty-state page.

## Palette roles (not a second spec)

| Role          | 冷墨 (default)                 | 晨纸            |
| ------------- | ------------------------------ | --------------- |
| 底            | `#0e1218`                      | `#f3f1ea`       |
| 字            | `#e8e4d9`                      | `#1c1e22`       |
| Playfair 标题 | `#eee6d8`                      | same ink family |
| 强调          | `#3d7ea6`                      | `#3d7ea6`       |
| glow          | steel `rgba(138,164,184,0.35)` | subtler         |

Hex may drift; roles must not.
