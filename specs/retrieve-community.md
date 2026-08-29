# Spec: Retrieve community summaries

> **Status:** draft — ACR in this file after spec-axis + ACR review (2026-08-30); not implemented.
> **Source:** operator 2026-08-30 — coarse contract for CONTEXT **community** (English GraphRAG term). Parent stack remains `specs/retrieve-graph-quality.md` slice 8 / plan T9.
> **Predecessors:** ADR-0001; `specs/neo4j-graph-arm.md` (projection + GDS); `specs/retrieve-graph-priority.md` (Host `chunks[]` order); `specs/retrieve-graph-quality.md` (mode bundle, fail-open, envelope).
> **Tracker:** local markdown only. Do not use GitHub issues.

## Objective

At **index time**, detect densely connected groups of **entity** nodes on the Neo4j projection with **Louvain** (Neo4j GDS). Persist one **summary** per group on the Postgres ledger. On **retrieve**, when the **mode bundle** topic-retrieve switch is on, those summaries **may appear** in Host `chunks[]` (typed metadata). Graph-priority order for non-empty Neo4j graph-arm hits is unchanged.

**Who:** MCP Hosts calling `retrieve`; operators who run extract, graph drain/backfill, and the index-time Louvain + summary job.

**Success looks like:** Host envelope stays `{ chunks[] }` (+ optional `degraded`); summaries are ledger facts, not live Cypher for the model; the **host** still writes the user-visible answer (no map-reduce on this server); path default-off or fail-open; Postgres remains SoR; Neo4j remains a read-only projection.

## Glossary

Exact copy from `docs/CONTEXT.md` (not redefined): **community**, **Neo4j sidecar**, **PPR**, **entity**, **triple**, **chunk**, **retrieve**, **ingest**, **host**, **MCP tool**, **mode bundle**, **degraded=true**, **hybrid retrieval**, **projection outbox**.

This spec uses the English term **community** only. Do not introduce a Chinese alias in code, config, metadata flags, or Host-facing strings.

## ASSUMPTIONS I'M MAKING

(operator 2026-08-30: write the coarse spec now — treated as confirmed)

1. This is **one** contract for Louvain + ledger summary + optional retrieve hits. Implementation is still one tracer bullet (quality plan T9), not this spec as a multi-commit mega-diff.
2. Detection is **Louvain** via Neo4j GDS. Hyperparameters (resolution, iterations, random seed) stay implementer headroom; they are not frozen here.
3. Summaries are **Postgres ledger rows**. Neo4j may optionally carry a projection of the group id; summary **text** is not the graph SoR. Chunks **never** enter Neo4j.
4. Retrieve may return summary text as items in `chunks[]` with a **typed metadata flag** (name is implementer headroom; must be stable once shipped). This does **not** displace the graph-priority prefix: non-empty Neo4j graph-arm hits still occupy the front of `chunks[]` (`docs/CONTEXT.md` **hybrid retrieval**). Community hits are an optional later step on the same list, cut to `limit`. Parent slice 8 “may lead” is **not** “rank-1 must be a summary.”
5. The only retrieve **gate** is a mode-bundle topic-retrieve **switch** (on/off). Which of `conservative` | `balanced` | `tokenmax` turn that switch on is **writing-plans headroom** (parent T6 lists levers; it does not yet name a topic lever). This slice does not invent a fourth preset, a query-class detector (“topic-like” vs “entity-anchored”), or a new MCP tool. Unknown preset names stay parent T6’s `ConfigError` / typed tool error.
6. If that switch does not exist on `main` yet (T6 not shipped), this slice **does not ship retrieve hits**. Index-time detect + ledger write belong in T9 **after** T6, same bullet, not a second Host tool.
7. **Index-time job** (Louvain + summary LLM): typed failure, non-zero process exit, no empty `catch`. EXIT: operator reruns the job; retrieve does not start Louvain. Missing Neo4j URI → job skip (no Louvain), not a retrieve `degraded` (cannot attempt) — same skip class as PPR skip.
8. **Retrieve** only **reads** the ledger. Ledger read throw → **fail-open**: keep pre-community ranking, **no** Host throw. This coarse slice does **not** lock `degraded=true` for that path (parent slice 8 body only requires fail-open / no hard fail; CONTEXT **degraded=true** does not yet list community). A later persist may add `degraded` without changing skip/fail-open.
9. Summary generation (index-time) may use the **extract Anthropic** credential trio, not the Host chat model. Retrieve hits stay default-off even when summaries exist, until the T6 switch is on.
10. MCP surface stays `ingest` + `retrieve` (+ leftover `echo` per T-007). No Text2Cypher, no community-id Host argument (filters remain the existing retrieve `filters` map).
11. PPR stays the query-time walk. **Community** detection is index-time only. Retrieve never runs Louvain or summary LLM.
12. Map-reduce of a final answer stays on the **host**.

→ Correct in review or these are the spec.

## Boundaries

- **Does:**
  1. Index-time Louvain on the projected entity graph (GDS); typed job errors (assumption 7).
  2. Persist one summary per **community** on Postgres; optional projection of group membership, not a second SoR.
  3. Retrieve path: when the mode-bundle topic-retrieve switch is on, include ledger summaries in `chunks[]` with a typed metadata flag, without reordering the graph-priority prefix; existing ranking / optional rerank / neighbor evidence still apply as the parent spec sequences them.
  4. Retrieve skip (switch off / empty ledger / missing URI does not degrade retrieve) vs fail-open on ledger **read** throw (assumption 8).
  5. Unit/integration tests without requiring live GDS in `npm test` when the path is off.

- **Confirms with human:** none remaining for this coarse lock. Exact Louvain numbers, summary prompt, metadata key spelling, and which presets set the topic switch stay implementer headroom inside writing-plans.

- **Out of this spec:**
  - Host prompt assembly, JIT, query rewrite, map-reduce answers
  - new MCP tools, Cypher-for-the-model, community id as a new retrieve field
  - putting **chunk** text or entity embeddings on Neo4j nodes
  - PPR algorithm changes, SQL graph-arm revival
  - extraction F1 / #15
  - mode-bundle names and lever integers (parent T6), including which presets enable topic retrieve
  - neighbor evidence, dedicated HTTP rerank, projection GC, `merged_into`, causal / supersession, wait-for-drain
  - treating **community** as a human-curated topic taxonomy
  - retrieve-attached Louvain refresh; locking `degraded` for community without a CONTEXT persist

## Success Criteria

Each criterion is binary. A later implementer headroom choice does not fail these.

1. Topic switch **off** → Host `chunks[]` order identical to post-T8 (or post-graph-priority if node-embedding seeds are off). Unit test; retrieve does not call Louvain or summary LLM.
2. Topic switch **on**, zero communities / empty summary ledger → same order as (1); no throw; no `degraded` solely from empty ledger. Unit test.
3. Topic switch **on**, fixture summaries present → at least one `chunks[]` item is a ledger summary (typed metadata flag); non-empty graph-arm fixture hits still occupy the front when the graph arm contributes; `limit` still holds. Unit test with a fake store (no live GDS).
4. Ledger **read** throw on retrieve → pre-community ranking, no throw to Host. Unit test with fake port. (No `degraded` required in this slice.)
5. Neo4j URI absent → index-time job skips Louvain (typed skip / non-zero or documented skip exit as writing-plans chooses, but not a silent empty catch); retrieve not `degraded` solely from missing URI. Unit or CLI test.
6. Envelope remains `{ chunks[] }` (+ optional `degraded`). No new Host keys. Existing envelope tests stay green.
7. `npm test` exits 0 with community path off and without live Neo4j GDS. `npm run build` exits 0 after impl.

## Open Questions

(none)

## Inherits / Changes

**Inherits:** CONTEXT **community** / **mode bundle** / **hybrid retrieval** (graph-priority prefix) / **host**; ADR-0001 Postgres SoR, Neo4j read-only projection, chunks never in graph; GDS already required for PPR (`gds.graph.project`); retrieve assembler `assembleRetrievalResult` (or current equivalent); extract Anthropic trio; parent slice 8 fail-open (no hard retrieve fail); T6 as the future topic-retrieve **switch** (not a locked per-preset map).

**Changes:** retrieve **may include** ledger **community** summaries in `chunks[]` when the topic switch is on; an index-time Louvain + summary job exists beside drain/extract. Does not add MCP tools. Does not make Neo4j authoritative for summary text. Does not prepend summaries ahead of a non-empty graph-arm prefix.

## Testing Strategy (5 boundary classes)

| Class      | Coverage                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| empty      | Zero entities / zero communities / empty summary ledger → identity retrieve, no throw                     |
| negative   | Topic switch off; missing URI job skip; unknown preset still parent T6’s typed error, not this slice      |
| overflow   | Summary hits + existing `limit` / candidateCap; output still ≤ Host `limit`; graph-arm prefix not dropped |
| concurrent | Two retrieve calls do not share a mutable community-hit buffer                                            |
| exception  | Index-time job: typed error + non-zero (or documented skip) exit. Retrieve: ledger read throw → fail-open |

## Architecture Change Reviewer

Planned files (≥3, T9 only): index-time Louvain/summary job (graph CLI or extract-adjacent) with typed failure, Postgres ledger for summaries, retrieve assembler helper that **reads** the ledger only, tests under `tests/graph/` and/or `tests/retrieval/`. Config/env only if T6 already exposed the topic switch.

### Verdict (pre-plan gate · 2026-08-30, post review)

bounded-context-guardian: yes — graph projection + retrieval hits; no Host assembly module; no technical-layer top-level dirs.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception.
error-handling-enforcer: yes — job: typed failure + EXIT (rerun); URI skip at job, not retrieve `degraded`; retrieve: off / empty identity; ledger read throw fail-open, no retrieve Louvain.
complexity-anti-drift: yes — Louvain/summary job and a retrieve read-helper, not inlined into a god assembler.
minimal-change-verifier: yes — one logical task (community summaries); not mixed with T6/T7/T8/T10/T11 in one commit.

OVERALL: PASS — hand to `writing-plans` for T9 only. Do not implement from this file until that plan bullet.

## 待写入 (persist)

(none for this coarse slice. Optional later: CONTEXT **degraded=true** if community retrieve read-fail should set the flag; **mode bundle** topic-retrieve switch once T6 names it.)

## Hand-off

- Spec: `specs/retrieve-community.md`
- Parent slice: `specs/retrieve-graph-quality.md` slice 8
- Plan: `plans/retrieve-community.md` (T9 internals; parent slot `plans/retrieve-graph-quality.md` T9)
