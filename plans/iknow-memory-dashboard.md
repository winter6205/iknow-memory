# Plan: iknow-memory dashboard

**Goal:** Operator can run a read-only **iknow-memory dashboard** on `127.0.0.1:18868` over the same core as MCP, with 冷墨/晨纸 chrome.
**Approach:** First make core readable without dashboard SQL. Then one thin HTTP process that reuses MCP boot/deps. Then SPA shell (theme + port), then vertical pages (stats → retrieve → PG browse/timeline → graph). Docs/scripts last. Do not rebase `worktree-memory-dashboard-plan`.
**Spec link:** `specs/iknow-memory-dashboard.md`
**Tracker:** **local markdown fallback** — operator asked for a worktree spec+plan as SSOT this round (`docs/iknow-memory-dashboard`). `ready-for-agent` issues when implementation starts, not in this docs commit train.
**Map:** [冻结 PR 187，重写 memory 监控看板](https://github.com/winter6205/iknow-memory/issues/188)
**ACR:** all-yes (copied from spec · 2026-09-09)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

bounded-context-guardian: yes — HTTP + `dashboard/` are the **iknow-memory dashboard** facade; they call core/storage/retrieval/graph already used by MCP; no `controllers/`/`services/` tree; no `src/tools` → `src/cli` for reads; wiki/host UI out.
defensive-contract-validator: yes — Testing Strategy: empty ledger, missing Neo4j, illegal query, retrieve exception → typed HTTP error, no write/maintenance concurrent POST this round (absent). Plan bullets must name those classes on public handlers.
error-handling-enforcer: yes — capability-missing vs empty-ledger are different typed outcomes; no empty catch; retrieve failures are not silent `[]` when all arms failed (follow existing retrieve contract).
complexity-anti-drift: yes — thin handlers + core reads; no second boot graph; SPA pages compose chrome/tokens, not a god App store.
minimal-change-verifier: yes — one product slice (read dashboard); 187 leftover is not the trunk; maintenance/auth/LAN out so the commit train stays one capability.

OVERALL: PASS — implement from this list.

## Tasks (ordered by dependency)

1. **Core read facade: counts, chunk/entity list+detail, timeline** — tag: `[implementation]`
   - **Inherits:** spec assumptions 3–4, 8; ADR-0001; empty memory backend is zeros/empty lists, not errors; no dashboard-local SQL as SSOT.
   - **Surface:** existing `src/core/storage` (`StorageBackend` / backends). Add methods on the interface only if list/count/timeline cannot be expressed today.
   - **Acceptance:** memory backend and (if tests already use it) pg test path return counts and pages; empty store is empty; illegal id is a typed miss/error. `npm test` covers empty / illegal id. No `src/dashboard-api` yet required.
   - Status: [x] done

2. **Thin HTTP: listen 127.0.0.1 + health + stats + query** — tag: `[implementation]`
   - **Inherits:** spec SC1, SC3, SC4, assumption 2–3, 7; `assembleRetrievalResult` for query; bind loopback; no MCP client; API port env-overridable and **not** 18868.
   - **Surface:** new HTTP facade next to MCP (same process-boot helpers as `src/index.ts`, not a copied embedder/ES/PPR block).
   - **Acceptance:** health reports storage mode; stats use T1 reads; query empty `q` is 4xx; empty hits 200 empty list; retrieve failure is typed, not `200 []` when the existing retrieve contract says fail. Tests: empty / illegal / retrieve exception.
   - Status: [x] done
   - [blocks: T1]

3. **HTTP: PG/memory browse + timeline** — tag: `[implementation]`
   - **Inherits:** spec store split; empty ledger ≠ error; pagination behaviour is implementer-chosen but stable in tests.
   - **Surface:** same HTTP facade; data via T1 core reads only.
   - **Acceptance:** list+detail+timeline work on memory empty and non-empty; unknown id typed; no Neo4j required for these routes.
   - Status: [x] done
   - [blocks: T2]

4. **HTTP: graph + backlinks (Neo4j read)** — tag: `[implementation]`
   - **Inherits:** ADR-0001 read-only; spec SC5; missing Neo4j → structured error, not empty graph; no dashboard-owned Cypher as the long-term SSOT (prefer existing graph session/helpers).
   - **Surface:** existing Neo4j graph wiring used by retrieve/PPR boot.
   - **Acceptance:** configured+reachable returns nodes/edges (or empty graph 200 if the projection is empty); unconfigured/unreachable is structured error. Tests: missing dep / empty projection / happy if fixture exists.
   - Status: [x] done
   - [blocks: T2]

5. **SPA shell: 18868, 冷墨 default, 晨纸 switch, fonts, nav** — tag: `[implementation]`
   - **Inherits:** spec assumption 5–7, SC2, SC8; React 18 + Vite + Tailwind + Radix + zustand + react-router; CSS variables for theme; vis-network later; no 5173.
   - **Surface:** repo `dashboard/` (new Vite app).
   - **Acceptance:** documented script serves `http://127.0.0.1:18868/` with 200; default theme is 冷墨; switch applies 晨纸 tokens; wordmark is iknow-memory; fonts are the three named families. `dashboard` build exits 0.
   - Status: [x] done
   - [parallel] with T3/T4 after T2 if API proxy target is known; otherwise [blocks: T2]

6. **SPA pages: stats, query, browse, timeline, graph — empty vs error** — tag: `[implementation]`
   - **Inherits:** spec SC6; no maintenance UI; wiki routes out.
   - **Surface:** `dashboard/` pages + T2–T4 APIs.
   - **Acceptance:** each surface shows empty state on memory/empty; graph shows error+retry when Neo4j missing; query shows hits or empty and surfaces `degraded` when the API does. Documented browser pass or Playwright if the implementer adds it.
   - Status: [x] done
   - [blocks: T3, T4, T5]

7. **Root scripts + README: one command for API + SPA** — tag: `[implementation]`
   - **Inherits:** spec Does #4; clean shutdown (no orphan 18868); zero-config memory mode allowed.
   - **Surface:** root `package.json`, `README.md`.
   - **Acceptance:** README lists the two ports (SPA 18868, API separate); clone-level commands start both; stop releases 18868. `npm run typecheck` and `npm test` exit 0.
   - Status: [x] done
   - [blocks: T6]

## 待写入 (persist)

- (none — **iknow-memory dashboard** already in `docs/CONTEXT.md`)

## End of round

After T1–T7 land: `arthurpower:code-review` then `arthurpower:verification-before-completion`. Do not mix commits from `worktree-memory-dashboard-plan`.
