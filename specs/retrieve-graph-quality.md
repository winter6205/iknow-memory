# Spec: Retrieve and graph quality stack

> **Status:** ACR all-yes; slice 0 (temporary LLM rerank) **on main** (#118). Remaining slices T2–T11 tracked only in `plans/retrieve-graph-quality.md` (no GitHub issues).
> **Source:** operator 2026-08-28 — coarse single contract (not one-question tickets); new wayfinder map for this destination; parent map remains local `docs/handoff/wayfinder-tickets/map-1.md`.
> **Predecessors:** `specs/retrieve-graph-priority.md` (Host order, on main), `specs/retrieve-rerank-llm.md` (temporary LLM rerank, on main), `specs/neo4j-graph-arm.md` (PPR arm + outbox, on main).
> **Tracker (files):** `plans/retrieve-graph-quality.md` is SSOT for implementation slices. Do not use GitHub issues.
> **Assumption gate:** operator chose one overview spec. Locks below are the gate; object in review or they stand.

## Objective

Finish the **in-protocol** retrieve and graph-quality path so a standard MCP Host can call `ingest` / `retrieve` and get measurable, iterable ranking: two-stage rerank, named retrieve presets, neighboring-chunk evidence, ledger-faithful merge and projection, topic-level community summaries, causal / supersession facts, and optional projection wait.

**Who:** MCP Hosts; operators running extract CLI, graph drain/backfill, and `npm run eval:retrieve`.

**Success looks like:** Host envelope stays `{ chunks[] }` (+ optional `degraded`); new capabilities are default-off or fail-open; Postgres remains SoR; Neo4j remains a read-only projection; no new Host-facing tools.

## Glossary

Exact copy from `docs/CONTEXT.md` (not redefined): **iknow-memory**, **MCP tool**, **host**, **chunk**, **entity**, **triple**, **alias**, **canonical entity**, **vector search**, **BM25**, **hybrid retrieval**, **Neo4j graph arm**, **projection outbox**, **RRF fusion (k=60)**, **degraded=true**, **RetrieveConfig**, **rerank**, **PPR**, **mode bundle**, **neighbor evidence**, **valid_window**, **valid_at**, **superseded_by**, **causal edge**, **Neo4j sidecar**, **community**, **ingest**, **retrieve**, **extract_triples**, **merged_into**, **P@5 / R@5**.

## ASSUMPTIONS I'M MAKING

(operator 2026-08-28: coarse spec, new map allowed — treated as confirmed)

1. This is **one** contract for the remaining in-scope stack. Implementation is still sequenced (writing-plans tracer bullets), not one commit.
2. MCP surface stays **ingest + retrieve** (T-005 D8). Presets, evidence width, and wait flags are retrieve input and/or env, not new tools.
3. Context assembly, JIT, query rewrite, map-reduce final answers, session traces, multi-tenant, Text2Cypher, framework adapters, and SQL graph-arm revival stay **out**.
4. **#15 extraction F1** stays postponed (own ticket / spec). This spec uses existing **P@5** harness for retrieve order.
5. Temporary Anthropic rerank is **already** `specs/retrieve-rerank-llm.md`. This spec **inherits** it as slice 0 and does not replace that file.
6. Neighbor evidence uses **Postgres** chunks on the same `source_ref` (order by ingest sequence / created_at). Chunks **never** enter Neo4j (#3 D6).
7. Entity embeddings used in retrieve stay on the **Postgres** entity row (already used for merge). Neo4j nodes stay without embedding properties (#3 D6).
8. Community detection is **Louvain** via Neo4j GDS (CONTEXT **community**). Summaries are ledger rows (Postgres), optionally projected as nodes; retrieve may return summary text as chunks with a typed metadata flag. Host still generates the user-visible answer.
9. Causal relations are vocabulary + extract, not a new MCP tool. Fact supersession writes `superseded_by` / `valid_until` on the ledger; operator consolidate is dry-run-first.
10. Projection stays eventually consistent by default. Optional retrieve wait-for-drain is **default off**; timeout fail-open (pre-wait ranking, `degraded=true`).
11. Dedicated rerank is HTTP, default off, fail-open; not the Host chat model. Until it ships, slice 0 temporary LLM adapter remains the only on-path rerank.
12. `merged_into` persist is implementation of P0c, not a new merge algorithm.

→ Correct in review or these are the spec.

## Boundaries

- **Does:**
  1. **Slice 0 — temporary LLM rerank:** implement `specs/retrieve-rerank-llm.md` (T2–T3) if not already on main.
  2. **Slice 1 — dedicated rerank HTTP:** replace the temporary adapter behind the same retrieve hook; default off; missing URL skip (not `degraded`); throw fail-open + `degraded`.
  3. **Slice 2 — projection GC:** ledger delete/retire of entity or triple → drain removes the projection by id (delete edge / `DETACH DELETE` node as needed). Empty graph still backfill. No graph tombstone as the primary scheme.
  4. **Slice 3 — extract reject class:** self-loop triples are row-level reject values; they do not force `--only-failed` re-extract; do not create orphan entities for discarded loops.
  5. **Slice 4 — `merged_into` persist:** extract writes the pointer; `resolveCanonicalId` is the production read path; triples FK unchanged.
  6. **Slice 5 — mode bundles:** named presets `conservative` | `balanced` | `tokenmax` on retrieve (env default + optional input). Each sets candidateK / topK / rerank window / vector-BM25 weights / neighbor width. Invalid name → `ConfigError` at process start or typed tool error on call.
  7. **Slice 6 — neighboring chunk evidence:** after ranking (and optional rerank), expand ±N chunks on the same `source_ref` (N from preset, default 1). Deduped by id; still cut to `limit` unless preset says evidence-fill may grow to a documented cap. N=0 is identity.
  8. **Slice 7 — node embedding in retrieve:** optional seed/score using Postgres `entities.embedding`; fail-open to today’s graph-priority path + `degraded` if the embedding path throws. No Neo4j vector index in this spec.
  9. **Slice 8 — community summaries:** index-time Louvain + LLM summary per community stored on the ledger; retrieve may lead with summary chunks for topic-like queries when the preset enables it. Detection/summary failure fail-open (no summaries, not a hard retrieve fail).
  10. **Slice 9 — causal edges and supersession:** allow causal `relation_norm` values in vocabulary; extract may emit them. Consolidate CLI: detect contradiction / superseded facts, default dry-run; apply writes `superseded_by` and closes `valid_window`. Retrieve honors `valid_at` (already) so superseded facts drop out of time-valid graph mapping.
  11. **Slice 10 — optional projection wait:** retrieve flag/env to wait for outbox drain up to a timeout; timeout or drain error → fail-open + `degraded`. Default off.

- **Confirms with human:** none remaining for this contract (coarse lock). Slice order in writing-plans may be retimed without a spec rewrite if dependencies hold (0 before 1; 2 before 10; 4 before 9 apply-path).

- **Out of this spec:**
  - extraction F1 / #15 / gold-set bootstrap
  - multi-granularity chunker
  - putting chunks or entity embeddings on Neo4j nodes
  - new MCP tools, Cypher-for-the-model, Host map-reduce
  - session memory, preferences-as-conversation, multi-tenant
  - SQL graph arm, graph tombstones as SoR, transaction-internal Neo4j writes
  - changing T-007 Host set (echo remains)

## Success Criteria

Each slice is independently binary. A slice not yet implemented does not fail slices that already shipped.

0. Slice 0: all Success Criteria in `specs/retrieve-rerank-llm.md` pass (`npm test` exit 0 without live Anthropic).
1. Dedicated rerank off → identical order to post-slice-0 assembler. Unit test.
2. Dedicated rerank on, no URL → skip, no `degraded`. Unit test.
3. Dedicated rerank on, fake HTTP permutation → Host `chunks[]` follows it then `limit`. Unit test.
4. Ledger entity/triple delete then `graph:drain` → Neo4j has no node/edge for that id. Integration test with testcontainers or recorded Bolt fixture already used by graph-arm tests.
5. Self-loop triple → recorded as extract reject, zero graph edge, `--only-failed` does not list it as “must re-extract”. Unit / CLI test.
6. Merge survivor/loser → loser row has `merged_into` = survivor; second extract is idempotent on that pointer. CLI or unit test on real Postgres test helper.
7. `RetrieveConfig` / retrieve input rejects unknown preset names. Unit test.
8. Neighbor N=1 on a three-chunk source → hitting the middle chunk can include neighbors without Neo4j writes. Unit test.
9. Node-embedding path throw → graph-priority (or fallback RRF) list + `degraded`. Unit test with fake embedder/store.
10. Community path off or empty communities → retrieve order unchanged vs slice 7. Unit test.
11. Fact with `valid_until` before `valid_at` does not appear in graph-mapped chunks. Existing temporal tests stay green; add one supersession fixture.
12. Wait-for-drain off → no drain wait in retrieve. Unit test.
13. Envelope remains `{ chunks[] }` (+ optional `degraded`). Existing MCP retrieve tests stay green.
14. `npm test` and `npm run build` exit 0 without live Neo4j, live Anthropic, or live rerank HTTP.

## Open Questions

(none)

## Inherits / Changes

**Inherits:** TS strict ESM, Node ≥20, Vitest, `npm test` / `npm run build`; ADR-0001 Postgres SoR / Neo4j projection; graph-priority ranking; BM25+vector RRF fallback; PPR arm skip/fail-open; extract Anthropic trio; P@5 harness `npm run eval:retrieve`; CONTEXT fail-open **rerank**.

**Changes:** retrieve may apply dedicated HTTP rerank, neighbor expansion, entity-embedding seeds, community-summary hits, and optional drain wait; extract persists `merged_into` and typed self-loop rejects; drain deletes projections; consolidate CLI can apply supersession; **mode bundle** is no longer TBD — three named presets.

## Testing Strategy (5 boundary classes)

| Class      | Coverage                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| empty      | Zero chunks / zero communities / empty outbox → identity retrieve, no throw                                  |
| negative   | Unknown preset; N<0 neighbor width; wait timeout 0 with wait on → typed error or documented skip             |
| overflow   | Neighbor expansion + rerank W + `limit` still respect documented caps                                        |
| concurrent | Two retrieve calls do not share mutable ranking buffers                                                      |
| exception  | Rerank HTTP / drain wait / community / node-embedding throw → fail-open + `degraded` where the slice says so |

## Architecture Change Reviewer

Planned files (≥3, sequenced by slice): `src/config.ts`, `src/core/retrieval/`, `src/core/extraction/`, `src/core/graph/` (drain GC), retrieve tool wiring, consolidate CLI, tests under `tests/retrieval/`, `tests/extraction/`, `tests/graph/`.

### Verdict (pre-plan gate · 2026-08-28)

bounded-context-guardian: yes — retrieval / extraction / projection stay capability slices; no Host context-assembly module; no technical-layer top-level dirs.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception for the stack; each slice adds tests before code (writing-plans).
error-handling-enforcer: yes — skip vs fail-open vs `ConfigError` named per slice; embed hard-fail unchanged; EXIT on skip/fail-open.
complexity-anti-drift: yes — each slice is a helper on the existing assembler or extract/drain CLI, not a god-file rewrite.
minimal-change-verifier: yes **for this spec as one contract**; implementation **must** be one logical task per tracer bullet (writing-plans). Do not land slices 0–10 in one commit.

OVERALL: PASS — hand to `writing-plans` for ordered bullets. Do not implement from this file in one diff.

## 待写入 (persist)

Flushed 2026-08-28 into `docs/CONTEXT.md` (mode bundle, neighbor evidence, retrieve/community/merged_into/rerank/causal/superseded_by, optional drain wait).
