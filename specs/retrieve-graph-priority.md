# Spec: Retrieve graph-priority ranking

> **Status:** draft → ACR gate in this file (§Architecture Change Reviewer).
> **Source:** wayfinder grilling #89 (CLOSED) — production ranking is graph-priority, not three-arm RRF 0.7/0.15/0.15.
> **Predecessor:** `specs/neo4j-graph-arm.md` (seed → PPR → chunks; this spec changes **how** those hits enter Host `chunks[]`).
> **Assumption gate:** confirmed 2026-08-27 — follow the locked retrieve path; update stale CONTEXT terms; projection GC / graph tombstones / self-loop reject taxonomy / #88 rerank deferred.

## Objective

Change Host-visible `retrieve` ranking so the **Neo4j graph arm** leads when it returns non-empty chunk hits, and **vector search + BM25** rank only when the graph arm contributes nothing (or to fill remaining `limit` slots after graph hits).

**Who uses it:** MCP hosts calling `retrieve`; implementers changing `assembleRetrievalResult`; eval via `npm run eval:retrieve`.

**Success looks like:** a query that walks the graph puts graph-mapped chunks first in `{ chunks[] }`; a query that does not walk ranks by vector+BM25 RRF as today without a graph vote; envelope and fail-open/skip rules stay.

## Glossary

Exact copy from `docs/CONTEXT.md` after the persist flush in this SPECIFY turn (not redefined here):

- **vector search**, **BM25**, **hybrid retrieval**, **Neo4j graph arm**, **PPR**, **RRF fusion (k=60)**, **degraded=true**, **RetrieveConfig**, **retrieve**, **chunk**, **entity**, **triple**, **valid_window** / **valid_at**
- **graph arm** — archived SQL one-hop; still not production
- **projection outbox** — unchanged; this spec does not modify sync

## Confirmed assumptions (gate · 2026-08-27)

1. Scope is MCP `retrieve` Host ranking only. No ingest / extract / outbox / drain / backfill. Envelope stays `{ chunks[] }` (+ optional `degraded`).
2. Graph did not walk: no URI or `graphEnabled=false` (do not attempt, not degraded) OR zero seeds / empty PPR / no valid mapped chunks (empty hits, not degraded) OR arm throw (empty hits, `degraded=true`). Ranking then is vector + BM25 RRF (k=60), no empty graph arm as a third vote.
3. Non-empty graph hits: no equal-weight RRF vs vector/BM25. Graph-arm order occupies the front of the list; if fewer than `limit`, fill from vector+BM25 RRF, deduped by chunk id (graph-already-present ids skipped). If graph hits ≥ `limit`, no fill.
4. Query embeds once. Vector / BM25 / graph may still run concurrently for latency; fusion follows 2–3.
5. Levers unchanged: `entityLinkTopK=8`, `candidateCap=50`, Host `limit` default 10, PPR damping 0.85. `triples.confidence` stays off the ranking path. SQL graph arm stays archived.
6. Out of this spec: Neo4j tombstones, unresolved-graph DELETE, id-set reconcile, self-loop typed reject, #88 rerank, #15 extraction F1, read-your-writes.
7. Tests: existing assembler tests assert the new order; `npm run eval:retrieve` keeps the same gold harness (order changes, not harness shape); missing Neo4j URI still skips the graph, run not failed. `npm test` green without live Neo4j.
8. CONTEXT terms that still describe three-arm RRF 0.7/0.15/0.15 as production ranking are flushed in this SPECIFY persist (domain-modeling). ADR-0001 unchanged.

## Boundaries

- **Does:**
  1. Replace production fusion in `assembleRetrievalResult`: graph-priority list + remainder fill; empty-graph fallback to vector+BM25 RRF.
  2. Update tests that lock three-arm weighted RRF as Host order.
  3. Refresh CONTEXT ranking vocabulary (persist with this spec).
- **Confirms with human:** changing `entityLinkTopK` / `candidateCap` / default `limit`; dropping remainder fill (graph-only lists); deleting `w_graph` from env.
- **Out of this spec:** projection GC / graph tombstones; extract reject taxonomy; rerank; SQL arm re-enable; MCP wire shape; dual-write Neo4j.

## Success Criteria

Binary; each maps to a command or measurable check.

1. **Graph hits lead:** With a fake/live graph arm returning hits `[A, B]` and vector ranking `B` then unrelated `C`, Host `chunks[]` at `limit≥2` starts with `A` then `B` (graph order), not RRF-vs-vector order. Unit test on `assembleRetrievalResult`.
2. **Remainder fill:** Graph returns 1 hit, `limit=3`, vector+BM25 would return `[X, Y, graphHit]`: envelope has graph hit first, then two others, graph id once. Unit test.
3. **Empty graph → dual RRF:** Graph arm empty (no seeds / empty PPR / no chunks) and not thrown: Host order equals vector+BM25 `rrfFuse` without a graph arm. No `degraded` solely for emptiness. Unit test.
4. **Skip URI:** No `graphRanker` / no URI → same as today: no `degraded` for that reason; vector+BM25 still rank. Existing skip tests remain green (update if they assume a graph vote).
5. **Fail-open:** Injected graph throw → `degraded: true`, vector+BM25 chunks still returned, call does not throw. Existing fail-open tests remain; order is fallback RRF.
6. **Disable graph:** `graphEnabled=false` → vector+BM25 only; no `degraded` from disable.
7. **Envelope:** Success JSON has exactly `chunks` plus optional `degraded`; no new Host keys. Existing envelope tests.
8. **Eval harness:** `npm run eval:retrieve` still writes `eval/baseline/retrieve-p5.json` via `assembleRetrievalResult`; gold shape unchanged. CLI records the arm set that ran (graph present or not) without requiring a three-arm RRF vote.
9. **No live Neo4j required for unit:** `npm test` exits 0 without Neo4j. `npm run build` exits 0 after impl.
10. **No new ranking algorithm:** No cross-encoder, no `confidence`-weighted PPR, no SQL JOIN arm in production wiring.

## Open Questions

(none) — remainder fill locked in assumption 3; deferred work listed in Boundaries.

## Inherits / Changes

**Inherits:**

- ADR-0001 Postgres SoR / Neo4j read-only projection.
- `specs/neo4j-graph-arm.md` seed → PPR → `source_chunk_id` mapping; skip vs fail-open vs empty-not-degraded.
- `rrfFuse` k=60 for **vector+BM25 only** on fallback and remainder fill.
- Stack: TypeScript strict ESM, Node ≥20, Vitest, `npm test` / `npm run build`.
- MCP `retrieve` input/output types in `src/core/types.ts`.

**Changes:**

- Production Host ranking is **graph-priority**, not vector+BM25+graph RRF at 0.7/0.15/0.15.
- `w_graph` does not vote against vector when graph hits exist; `w_vec` / `w_bm25` still fuse the fallback/fill list.
- CONTEXT: **hybrid retrieval**, **Neo4j graph arm**, **retrieve**, **RRF fusion**, **RetrieveConfig**, **vector search**, **degraded=true**, **P@5 / R@5**, Relationships retrieve bullets — flushed this turn.

## Tech Stack

Unchanged (existing retrieve + Neo4j sidecar). No new runtime dependency.

## Commands

```bash
npm test
npm run build
npm run eval:retrieve
```

## Testing Strategy (5 boundary classes)

| Class      | Coverage in this spec                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| empty      | Zero seeds / empty PPR / empty mapped chunks → fallback RRF; remainder fill when graph returns 0 extra unique ids |
| negative   | `limit` ≤ 0 still yields empty `chunks[]` (existing rrf/assembler behavior, keep)                                 |
| overflow   | Graph `candidateCap` hits truncated to Host `limit` before fill; fill must not exceed `limit`                     |
| concurrent | Vector ∥ BM25 ∥ graph still started together when enabled; fusion is sequential on results                        |
| exception  | Graph throw → fail-open + `degraded`; embed throw still rejects                                                   |

## Architecture Change Reviewer

Planned blast radius (implementation; ≥3 files):

- `src/core/retrieval/index.ts` — `assembleRetrievalResult` fusion
- `src/core/retrieval/` helper if extracted (graph-priority assemble, not a new technical-layer dir)
- `tests/retrieval/*` and `tests/tools/retrieve-graph.test.ts` — order assertions
- `tests/cli/eval-retrieve.unit.test.ts` — arm-set vs three-arm vote wording
- `docs/CONTEXT.md` — persist this SPECIFY turn (not an impl file)

### Verdict (pre-plan gate · 2026-08-27)

bounded-context-guardian: yes — stays in retrieval capability; no new controllers/services tree; projection/extract untouched.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception; SC1–SC5 bind observables.
error-handling-enforcer: yes — skip / empty / throw paths already typed in neo4j-graph-arm; this spec keeps EXIT: fail-open vs skip vs fallback-rank; no new empty catch.
complexity-anti-drift: yes — declared split: compose `assembleRetrievalResult` from graph result + `rrfFuse(vector, bm25)` remainder/fallback, not one inlined three-arm vote; no god-file intent.
minimal-change-verifier: yes — one logical task (Host ranking graph-priority); CONTEXT flush is glossary persist for the same decision; no GC/rerank mixed in.

OVERALL: PASS — hand to `writing-plans`.

## 待写入 (persist)

- CONTEXT ranking terms listed in Inherits/Changes → flushed 2026-08-27 with this spec (domain-modeling).
- No new ADR (ranking is reversible; ADR-0001 SoR unchanged).

## Hand-off

- Spec path: `specs/retrieve-graph-priority.md`
- Next: `writing-plans` → `plans/retrieve-graph-priority.md` (not this turn)
- Tracker: implement as a new `wayfinder:task` under map #1; do not reopen #89 grilling
