# Spec: Neo4j Projection + True Graph Arm

> **Status:** draft → ACR gate in this file (§Architecture Change Reviewer).
> **Source tickets:** ADR-0001 / D1·D6 / Q3b.
> **Predecessor:** `specs/bm25-retrieve.md` (production = vector+BM25; SQL graph arm archived).
> **Assumption gate:** treated as **confirmed by HITL grilling** (2026-08-26) — forks below are not re-opened.

## Objective

Ship the next retrieve stop after BM25: **Postgres → Neo4j read-only projection** (outbox + backfill) and a **true graph recall arm** (entity seed → Neo4j GDS **PPR** → chunks via Postgres `source_chunk_id`) fused into production **RRF** as a third arm.

**Who uses it:** MCP hosts calling `retrieve`; operators running extract + projection CLIs.

**Success looks like:**

- With Neo4j configured and projection populated, default retrieve fuses **vector + BM25 + Neo4j graph**.
- Without Neo4j URI / when the arm fails: vector+BM25 still return, and both cases set `degraded=true` — **Superseded (C-6, `specs/retrieval-stack.md` §B3 rule 1)**: a missing URI leaves a default-on capability unattempted, which now degrades; the graph arm is named in `degraded_reasons`.
- Postgres remains the only SoR for entities/triples; Neo4j never accepts product writes outside the projection path.
- `npm test` green on paths that do not require a live Neo4j; ≥1 loud-skip integration path proves projection and/or PPR when Neo4j is reachable.

## Glossary

Exact copy / stage notes from `docs/CONTEXT.md` (SSOT) — not redefined here. Spec **Changes** / plan **待写入** will refresh stage lines after ship:

- **Neo4j sidecar** — read-only projection engine; never SoR (ADR-0001 / D1).
- **PPR (Personalized PageRank)** — query-anchored multi-hop traversal via Neo4j GDS.
- **hybrid retrieval** / **RRF fusion (k=60)** / **BM25** / **vector search** / **degraded=true** / **RetrieveConfig** — as in CONTEXT (weights and graph defaults change under this contract).
- **graph arm** — today means the **archived SQL one-hop** path. This spec adds a distinct production arm backed by Neo4j (see Inherits/Changes and 待写入 term **Neo4j graph arm**).
- **chunk**, **entity**, **triple**, **valid_window** / **valid_at**, **retrieve**, **extract_triples** — as in CONTEXT.
- **projection outbox** — new term (待写入): transactional intent log for ledger→Neo4j sync.

## Confirmed assumptions (gate)

1. Artifacts this PR: `specs/neo4j-graph-arm.md` (+ CONTEXT persist for decided morphology).
2. Stack: TS strict ESM · Node ≥20 · Vitest · existing `pg.Pool` / `StorageBackend`. **Neo4j JavaScript driver** is an allowed new runtime dependency for projection + PPR clients (not LangGraph, not a second SoR).
3. Authority: Postgres ledger SoR; Neo4j read-only projection; node `{id,canonical_name,type}` (no embedding); edges carry `relation_norm` + confidence + valid bounds; **chunks do not enter Neo4j** (ADR-0001 / D6).
4. Sync mechanism: **transactional outbox** (+ async/CLI projector) + **full backfill**; phased delivery allowed (**reconcile/backfill CLI first**, then outbox drain) without changing the locked mechanism.
5. Write touchpoint for outbox emit: offline **extract CLI** per-chunk transaction (not MCP `ingest`).
6. Consistency: **eventually consistent**; **no read-your-writes** in this spec (Q3c remains deferred).
7. Retrieve path: embed once → entity **seeds** (reuse archived SQL arm’s linking _idea_; implementation may share helpers without re-enabling SQL JOIN fusion) → Neo4j GDS **PPR** → map ranked entities to chunks via Postgres `source_chunk_id` → RRF third arm. **No LangGraph.**
8. Defaults: `w_vec=0.7`, `w_bm25=0.15`, `w_graph=0.15`; Neo4j graph arm **enabled by default** when Neo4j is configured; Ask-first to change defaults post-ship.
9. Failure / absence:
   - Neo4j **URI/config absent** → do **not** attempt the arm. ~~Envelope stays non-degraded for that reason alone.~~ **Superseded (C-6, `specs/retrieval-stack.md` §B3 rule 1):** the arm is on by default, so a missing URI means it could not be attempted → set `degraded=true` and name graph multi-hop in `degraded_reasons`. Other arms still return.
   - Neo4j **configured** but call/projection errors → **fail-open**; set `degraded=true`; vector+BM25 still returned.
10. Content without entities/triples: graph arm contributes nothing; vector+BM25 remain the path (hybrid, not graph-only).
11. `triples.confidence` may project onto edges; **must not** become the primary graph ranking algorithm.
12. Out of this ship: SQL fake-graph product arm; eval; node-level embedding; Louvain; causal edges; mode bundle; locking GDS hyperparameters as immutable.
13. Tests: `npm test` green without live Neo4j; MemoryBackend does **not** require Neo4j; ≥1 real Neo4j integration (or documented loud-skip) for backfill/PPR when available; no real LLM required for retrieve tests.
14. Prior fence `rg -il neo4j dist/` **empty** is **retired** for this feature: Neo4j client code may appear under projector/retrieve surfaces; isolation rules still forbid iknow runtime imports and still keep MemoryBackend/Neo4j-free unit paths green.

## Boundaries

- **Does:**
  1. Outbox (or equivalent schema) + extract-path emit; idempotent Neo4j MERGE projection; full backfill/reconcile CLI; projector drain path.
  2. Production retrieve third arm: seed → PPR → chunks → RRF with defaults above; `graphEnabled`-class switch; fail-open on configured failure, and `degraded` on a missing URI per the superseded rule above (C-6, `specs/retrieval-stack.md` §B3).
  3. Config + CONTEXT stage refresh for hybrid weights and Neo4j arm morphology.
- **Confirms with human:** changing default weights after ship; hard-deleting archived SQL `graph-arm.ts`; requiring Neo4j in CI as non-skippable; choosing a specific GDS PPR hyperparameter set as the forever default.
- **Out of this spec:** map-level Out of scope SQL fake-graph productization; node embedding; Louvain; causal edges; mode bundle; read-your-writes; MCP dual-write to Neo4j; LangGraph orchestration.

## Success Criteria

Binary; each maps to a command or measurable check.

1. **SoR intact:** Entities/triples remain writable only via Postgres ledger paths; no product API writes Neo4j except projection/backfill/projector. Asserted by code ownership + tests that extract still commits ledger rows without requiring Neo4j up.
2. **Backfill/reconcile exists:** A CLI (or documented command) can project existing ledger entities/triples into Neo4j idempotently (re-run safe). Loud-skip if Neo4j unreachable.
3. **Outbox emit:** After extract commits a chunk that writes/updates projectable ledger rows, an outbox (or equivalent intent) row exists in the same transactional story — or the phased “CLI-only reconcile” milestone is explicitly incomplete until the outbox bullet lands (plan sequences this). Final ship has outbox emit on the extract write path.
4. **Projector drain:** Pending outbox intents can be applied to Neo4j and marked done/failed observably (status column or equivalent); failed rows are visible for retry.
5. **PPR arm returns chunks:** With a seeded Neo4j graph and Postgres `source_chunk_id` links, retrieve with graph enabled includes graph-arm contribution into RRF (observable via debug/arm hits or ranking change vs graph-disabled). Loud-skip without Neo4j.
6. **Default weights:** Fresh env yields `w_vec=0.7`, `w_bm25=0.15`, `w_graph=0.15` (and graph enable default on). Config unit tests.
7. **Unattempted without URI** (**Superseded C-6, `specs/retrieval-stack.md` §B3 rule 1** — was "no `degraded` solely for missing URI"): No Neo4j URI → retrieve does not throw, `degraded: true` with graph multi-hop named in `degraded_reasons`; vector+BM25 still run when enabled.
8. **Fail-open:** Injected Neo4j/PPR failure with URI configured → chunks from other arms + `degraded: true`; call does not throw.
9. **Disable graph → dual-arm:** Graph disabled via config → vector+BM25 only; no `degraded` solely from disable.
10. **RRF still N-arm:** Graph arm participates as a weighted arm; k=60 unchanged; unit tests cover three-arm soft-merge on shared chunk ids.
11. **No LangGraph dependency:** `package.json` does not add LangGraph/langgraph packages for this feature.
12. **MemoryBackend / unit suite:** `npm test` exits 0 without a live Neo4j instance (loud-skip only for Neo4j-tagged integration files).
13. **Full suite on impl branch:** `npm test` + `npm run build` exit 0 after all plan bullets.

## Open Questions

(none) for product forks — closed by HITL grilling. Implementer headroom (exact outbox DDL, driver package version, GDS procedure names/params, whether projector is long-running worker vs CLI drain, shared seed helper vs new module) stays open under Boundaries → Confirms / headroom.

## Inherits / Changes

**Inherits:**

- ADR-0001 Postgres authoritative / Neo4j read-only projection; Neo4j CE+GDS; D6 projection shape; Q3b outbox preselect (confirmed by HITL grilling).
- Production retrieve today: vector ∥ BM25 + RRF (`specs/bm25-retrieve.md`); SQL graph arm archived off default wiring.
- Stack & commands: TypeScript strict ESM, Node ≥20, Vitest, `npm test` / `npm run build`.
- Fail-open envelope pattern; `RetrieveConfig` / `rrfFuse` N-arm; extract CLI as sole production ledger writer for entities/triples.
- Hard contracts: env secrets not hardcoded; no iknow runtime import.

**Changes:**

- Production hybrid becomes **vector + BM25 + Neo4j graph** with defaults **0.7 / 0.15 / 0.15**.
- `RetrieveConfig`: `w_graph` steers production again; add explicit Neo4j graph enable flag (name left to implementer); URI/config gated skip vs fail-open rules above.
- New projection surfaces: outbox schema, extract emit, backfill/reconcile CLI, projector drain, Neo4j driver client.
- Neo4j client code allowed in dist for those surfaces; prior “no neo4j string in dist” fence retired (SC12 replaces it).
- CONTEXT: refresh hybrid / RetrieveConfig / retrieve / Neo4j sidecar / PPR stages; add **Neo4j graph arm** + **projection outbox** terms (persist).

## Tech Stack

| Layer         | Choice                                   | Reason                 |
| ------------- | ---------------------------------------- | ---------------------- |
| Language      | TypeScript strict ESM                    | Existing               |
| Runtime       | Node ≥20                                 | `package.json#engines` |
| Tests         | Vitest; FakeEmbedder; loud-skip Neo4j/PG | Existing               |
| Ledger        | Postgres + pgvector                      | SoR                    |
| Graph         | Neo4j CE + GDS (PPR)                     |                        |
| Sync          | Outbox + backfill/reconcile              | ADR-0001               |
| Fusion        | Existing RRF k=60                        |                        |
| Orchestration | In-repo retrieve assembler               | No LangGraph           |

## Commands

```bash
npm test
npm run build
# Neo4j / projection / PPR integration — loud skip if Neo4j unreachable (plan bullets)
```

## Testing Strategy (5 boundary classes)

| Class      | Coverage in this spec                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| empty      | Empty seed set / empty PPR → other arms still return; empty outbox drain is no-op                                                       |
| negative   | Invalid weights / enable env → `ConfigError`; invalid Neo4j URI shape → ConfigError or skip-with-reason (implementer picks one, tested) |
| overflow   | Large PPR candidate lists truncated before/at RRF `limit`                                                                               |
| concurrent | Vector ∥ BM25 ∥ graph arms start together when all enabled                                                                              |
| exception  | Neo4j/PPR throw → fail-open + `degraded`; embed failure still hard-fails                                                                |

## Architecture Change Reviewer

Planned blast radius (implementation; ≥3 files):

- `src/config.ts` + retrieve types — weights, graph enable, Neo4j env
- `src/core/storage/schema-p0.ts` (or sibling) — outbox DDL
- `src/cli/extract.ts` (+ dedup write path) — outbox emit
- New projection CLI / projector module under existing capability dirs (`cli`, `core/storage` or `core/graph` **capability** slice — not a `controllers/` layer)
- `src/core/retrieval/*` — Neo4j PPR arm + `assembleRetrievalResult` third arm
- `package.json` — `neo4j-driver` (or equivalent)
- tests + `docs/CONTEXT.md` stage/term refresh

### Verdict (pre-plan gate · 2026-08-26)

bounded-context-guardian: yes — stays in capability slices (config, storage/ledger, retrieval, cli); Neo4j is a sidecar adapter behind projection/retrieve, not a new technical-layer package tree; SQL archive remains archived.
defensive-contract-validator: yes — Testing Strategy covers empty / negative / overflow / concurrent / exception; SC6–SC10 bind config and fail-open/skip observables.
error-handling-enforcer: yes — missing URI = skip without degraded (EXIT: continue other arms); configured failure = fail-open + `degraded` (EXIT: return hybrid envelope); embed still hard-fail; config invalid → `ConfigError`; no empty-catch prescription.
complexity-anti-drift: yes — declared split: config defaults, projection (outbox+backfill+drain), PPR arm+orchestrator, suite/docs; avoids one god-module “do all Neo4j” file by sequencing plan bullets.
minimal-change-verifier: yes — one logical product outcome (Neo4j true graph into production retrieve); allows one new justified runtime dep (Neo4j driver); per-bullet 1-commit sequencing owned by `writing-plans`.

OVERALL: PASS — hand to `writing-plans`.

## 待写入 (persist)

- ~~CONTEXT hybrid / RetrieveConfig / retrieve / Neo4j sidecar / PPR; add Neo4j graph arm + projection outbox.~~ Flushed 2026-08-26 with this docs PR.
- **Flushed 2026-08-31 (C-6, `specs/retrieval-stack.md` §B3):** CONTEXT **degraded=true** now carries the four set rules, and **Neo4j graph arm** no longer says "missing URI skips without `degraded`".
- No new ADR required (outbox already ADR-0001); weights Ask-first reversible.

## Hand-off

- Spec path: `specs/neo4j-graph-arm.md`

