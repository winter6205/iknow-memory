# Plan: Neo4j Projection + True Graph Arm

**Goal:** Production `retrieve` gains a Neo4j PPR third arm on RRF, fed by
an eventually-consistent Postgres→Neo4j outbox projection (with full
backfill), without reopening the archived SQL fake-graph product path.
**Approach:** Lock config/defaults first so weights and enable/skip rules
are testable. Then land projection in two slices (backfill+outbox emit,
then drain). Wire seed→PPR→chunk into the existing assembler last, and
close with suite + CONTEXT. Coarse bullets on purpose — GDS hyperparams
and exact DDL stay implementer headroom. Out of scope stays map-level:
SQL fake-graph productization (#57), #15, node embedding, Louvain,
causal edges, mode bundle, LangGraph, read-your-writes.
**Spec link:** `specs/neo4j-graph-arm.md` (binding; SC = Success Criteria; A# = assumptions)
**ACR:** all-yes (2026-08-26; block pasted below)
**Per-ticket loop (all bullets):** tdd → typecheck+tests →
verification-before-completion → one commit on the ticket branch
(end-of-round code-review once before merge)
**Tracker:** GitHub main path — parent [#70](https://github.com/winter6205/iknow-memory/issues/70).
Child `ready-for-agent` issues listed under Tasks.

## architecture-change-reviewer verdict

Pasted from `specs/neo4j-graph-arm.md` §Architecture Change Reviewer
(gate run 2026-08-26):

bounded-context-guardian: yes — stays in capability slices (config, storage/ledger, retrieval, cli); Neo4j is a sidecar adapter behind projection/retrieve, not a new technical-layer package tree; SQL archive remains archived.
defensive-contract-validator: yes — Testing Strategy covers empty / negative / overflow / concurrent / exception; SC6–SC10 bind config and fail-open/skip observables.
error-handling-enforcer: yes — missing URI = skip without degraded (EXIT: continue other arms); configured failure = fail-open + `degraded` (EXIT: return hybrid envelope); embed still hard-fail; config invalid → `ConfigError`; no empty-catch prescription.
complexity-anti-drift: yes — declared split: config defaults, projection (outbox+backfill+drain), PPR arm+orchestrator, suite/docs; avoids one god-module “do all Neo4j” file by sequencing plan bullets.
minimal-change-verifier: yes — one logical product outcome (#69/#70 Neo4j true graph into production retrieve); allows one new justified runtime dep (Neo4j driver); per-bullet 1-commit sequencing owned by `writing-plans`.

OVERALL: PASS — proceed with tracer bullets.

## 待写入

- ~~CONTEXT: **hybrid retrieval**, **RetrieveConfig**, **retrieve**, **Neo4j sidecar**, **PPR**; add **Neo4j graph arm** + **projection outbox**.~~ Flushed in this docs PR (2026-08-26). Stage lines re-touched in T5 from `implementing (#70)` to implemented-on-branch, and the archived SQL **graph arm** vs **Neo4j graph arm** split restated now that `w_graph` steers a live arm again.
- No ADR open/reopen (outbox already ADR-0001).

## Tasks (ordered by dependency)

1. **RetrieveConfig + defaults for Neo4j graph arm** — tag: `[implementation]`
   - **Inherits:** Spec SC6, SC9–SC10; A8–A9; #69 weights 0.7/0.15/0.15; graph enable default on; missing URI → skip without degraded; RRF k=60 unchanged; `w_graph` steers production again.
   - **Surface:** `src/config.ts`; `src/core/retrieval` types / weight wiring; config unit tests.
   - **Acceptance:** SC6 fresh-env asserts; SC9 disable → no degraded solely from disable; invalid env → `ConfigError`; N-arm weight map accepts graph again in unit tests (SC10 partial).
   - Status: [x] done
   - Tracker: https://github.com/winter6205/iknow-memory/issues/71

2. **Projection backfill/reconcile CLI + outbox schema/emit** — tag: `[implementation]`
   - **Inherits:** SC1–SC3; A3–A5; ADR-0001 shape; phased “CLI backfill first” allowed but final emit on extract path required for ship; chunks never projected.
   - **Surface:** storage schema / ensureTable; extract CLI write transaction; new or extended CLI for reconcile/backfill; Neo4j driver dependency justified in PR.
   - **Acceptance:** SC1 ledger writes work without Neo4j up; SC2 idempotent backfill (loud-skip if Neo4j down); SC3 outbox (or equivalent) emitted in extract commit path.
   - Status: [x] done
   - [blocks: T1] — only if sharing config env for Neo4j URI validation; otherwise may start after T1 for cleaner review
   - Tracker: https://github.com/winter6205/iknow-memory/issues/72

3. **Outbox projector drain → Neo4j** — tag: `[implementation]`
   - **Inherits:** SC4; A4 eventually consistent; idempotent MERGE; failed intents visible; confidence may project but not rank.
   - **Surface:** projector CLI/worker under cli or storage/graph capability; tests with loud-skip or testcontainer if already used.
   - **Acceptance:** SC4 pending→done/failed observable; re-drain safe; no product write API to Neo4j outside this path (SC1 still holds).
   - Status: [x] done
   - [blocks: T2]
   - Tracker: https://github.com/winter6205/iknow-memory/issues/73

4. **Seed → Neo4j PPR → chunks + orchestrator fuse + fail-open** — tag: `[implementation]`
   - **Inherits:** SC5, SC7–SC10; A7, A9–A11; no LangGraph (SC11); concurrent with vector∥BM25 when enabled; SQL JOIN fusion stays off default path.
   - **Surface:** `src/core/retrieval` (new Neo4j arm module beside archived SQL arm); `assembleRetrievalResult`; retrieval unit tests + Neo4j loud-skip integration.
   - **Acceptance:** SC5 graph contribution observable when Neo4j seeded; SC7–SC8 skip/fail-open; SC10 three-arm soft-merge unit test; SC11 no langgraph dep.
   - Status: [x] done
   - [blocks: T1, T3]
   - Tracker: https://github.com/winter6205/iknow-memory/issues/74

5. **Suite closure + CONTEXT term/stage refresh** — tag: `[implementation]`
   - **Inherits:** SC12–SC13; persist list above; map frontier pointer to #70 children as needed.
   - **Surface:** full `npm test` / `npm run build`; `docs/CONTEXT.md` (if not already flushed); short runbook note for Neo4j projection ops optional.
   - **Acceptance:** SC12–SC13; CONTEXT distinguishes archived SQL **graph arm** vs **Neo4j graph arm** and documents **projection outbox**.
   - Status: [x] done
   - [blocks: T4]
   - Tracker: https://github.com/winter6205/iknow-memory/issues/75

## Code review phase (end of round)

After T1–T5 land on the implementation branch: one `arthurpower:code-review` pass on the full diff, then merge. Not per bullet.
