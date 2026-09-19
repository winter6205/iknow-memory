# Spec: graph index (standard LLM extract vs Fast NLP)

> **Status:** assumption gate confirmed 2026-09-17 (two-repo sync with fin spec 2 of 4).
> **Sibling spec (fin):** [`../../fin/specs/graph-index-standard-fast.md`](../../fin/specs/graph-index-standard-fast.md)
> **Related (this repo):** `specs/retrieve-community.md` (Louvain + optional topic hits — **algorithm superseded** for detection; ledger summary + retrieve-read still parent for C hits until `search-mode-retrieve.md`).
> **Plan:** later slot (`writing-plans` after `architecture-change-reviewer`).

## Objective

Implement the **index-time graph job** in **iknow-memory**: two **extract methods** on the index job (**standard** LLM entities/relations vs **Fast** NLP co-occurrence), canonical merge, optional prune (Fast only), hierarchical **Leiden** **community** clustering, index-time community summaries on the Postgres ledger, and three index embedding classes. Fin supplies freeze-text / **抽图窗** (and in-window children). This server does not assemble Host answers and does not rank in fin.

**Who:** operators who run extract / drain / community-summary jobs; MCP **host** fin.

Quoted from this repo `docs/CONTEXT.md` (exact copy at write time — persist may amend **community** after ACR):

- **community**: Entity-graph clusters from **hierarchical Leiden** at index time (ADR-0011), each with a ledger-stored summary. Retrieve may return those summaries as Host `chunks[]` when topic / **检索档** C is enabled; map-reduce of a final answer stays on the **host**.
- **extract_triples**: the P0 extraction pipeline: LLM schema-guided triple extraction from chunk text → confidence scoring → canonical entity resolution → store. Exposed as MCP tool `extract` (`chunk_ids` xor `source_ref`, synchronous, **mark-and-continue**) and as the extract CLI.
- **chunk**: a derived index row for one fin-cut slice of a **资料**: slice text, embedding, ordinal, back-pointer.
- **authoritative source**: Postgres, holding the sole authoritative copy of **资料** body text and ledger rows.
- **Neo4j sidecar**: the only production graph engine (ADR-0008); native multi-hop traversal (PPR first; Louvain / node-level embedding later); a read-only projection of Postgres-authoritative entities/triples, never a system of record (ADR-0001).
- **projection outbox**: the transactional intent log written in the same Postgres transaction as ledger entity/triple changes.

Joint terms **抽图窗**, **Fast 抽图**, **实体描述**, **claim**, **具名失败** are defined in fin `docs/CONTEXT.md`; this spec does not redefine them.

## Confirmed assumptions (gate)

1. Two-repo sync 2026-09-17: fin `specs/graph-index-standard-fast.md` is the joint contract; **this file is the iknow implementation spec**.
2. Postgres remains SoR for entities, triples, aliases, community **summary text**, and embeddings of those classes. Neo4j is a read-only projection (ADR-0001 / ADR-0008). Chunks never enter Neo4j.
3. Extract method is an **index-job switch** (default **standard**), one method per **资料** / corpus **version**. Dual graphs on one version are rejected. Host may propose Fast; this server must **not** silent-apply Fast without the recorded switch.
4. Fast noun-phrase regex is mixed Chinese/English. Product Fast default is **not** English-only regex. Empty Fast graph on Chinese **资料** is a typed job fail.
5. Fast co-occurrence uses **in-window children** as pushed by fin, not a second token slide in this repo (ADR-0004: no re-chunk).
6. Fast **prunes** then Leiden; standard does **not** prune by default.
7. Canonical merge (existing L0–L3 gates + **merged_into**) runs **before** entity-description summarization. Fast has no entity descriptions. Query/dream do not write them.
8. **claim** extract ON for standard, OFF for Fast. Not XBRL, not SQL 档 D.
9. Community detection is **hierarchical Leiden** (GDS `leiden` or equivalent documented in the plan), **not** product Louvain. `max_cluster_size` default 10 tunable; `use_lcc` default on; **fixed default seed** (integer is Open Question until persist). Isolated specks are not community-report rows when lcc is on.
10. Community summaries at index; any community empty/error/timeout → **typed job fail**; C not-ready. B / graph-priority retrieve may use the entity graph. Query does not backfill summaries. Graph change rebuilds Leiden + reports; do not serve the previous report set for that version.
11. Three embeddings at index: parent window / pushed slice text as applicable, entity descriptions (standard), community summary text. Query is not the first embed of those classes.
12. `npm test` / `npm run typecheck` stay green **without** live Neo4j GDS and without fin. Live GDS jobs are opt-in / later plan.
13. Retrieve **档** hit assembly is `specs/search-mode-retrieve.md` in this repo (sibling to fin spec 3). Host cascade is fin spec 4.

## Boundaries

- **Does:**
  - Index job pipeline: ingest/push already stored **chunk**/window text → extract standard **or** Fast → merge → (standard: description summarize + claims) → (Fast: prune) → project/drain as today → Leiden on the graph projection → ledger community summaries + embeddings → C-ready flag/version metadata for that corpus version.
  - Persist **extract method** on the version/metadata so a second method cannot attach silently.
  - Typed EXITs: empty Fast on Chinese **资料**; community-summary job fail; rebuild-in-progress C not-ready (codes: Open Questions).
  - Tests (5 classes, Fake/no live GDS by default): empty extract / empty Fast; negative (two methods one version, English-only Fast default); overflow (`max_cluster_size`); concurrent (rebuild vs graph-arm retrieve); exception (summary fail → C not ready, graph-arm still usable).

- **Confirms with human:** public error code strings; Leiden default seed integer; embedding model id / dimension (reuse existing embedder unless persist says otherwise).

- **Out of this spec:**
  - fin **citation verifier**, Soft-Track, search-mode cascade, choice-window HTTP
  - re-chunking pushed text (ADR-0004)
  - Host map-reduce answers
  - new MCP tools for Cypher / community id (retrieve `filters` / later search-mode field)
  - putting summary **text** SoR on Neo4j
  - D SQL; dream; default `npm test` live GDS

## Success Criteria

1. `npm run typecheck` and `npm test` exit 0 without live GDS and without the fin tree.
2. A corpus version stores **exactly one** extract method; applying the other method without a version rebuild is a typed fail.
3. Index-job default method is **standard**. Fast does not run unless the recorded switch is Fast.
4. Fast extractor is **not** English-only regex as product default. Fast on a Chinese fixture that yields zero entities/edges is a **typed job fail**, not a successful empty graph.
5. Fast co-occurrence keys off **child** slice ids/text as pushed; this repo does not emit a second 50–100 token cut.
6. Fast prune runs before Leiden; standard fixture path does not call that prune by default.
7. Standard writes one entity description per survivor **after** merge and **before** Leiden; Fast writes none. No query-time description writer.
8. Standard claim extract is enabled by default in that job; Fast writes no claims.
9. Leiden is hierarchical; default max community size 10 (overridable); lcc on by default; clustering uses a **fixed** seed (not unseeded).
10. Community summary text is Postgres ledger. Summary job fail → process non-zero / typed fail; C not-ready; graph-priority retrieve of entities/triples still possible.
11. After a graph-changing extract/invalidate, Leiden + summaries rebuild before C-ready; previous summaries are not served as current C for that version.
12. Index embeds window/slice text, (standard) entity descriptions, and community summaries; retrieve is not the first embed of those classes.
13. Envelope of MCP `retrieve` stays `{ chunks[] }` (+ optional `degraded`). This spec does not add Host keys.

## Open Questions

1. Public MCP/CLI **error code** strings for empty Fast graph vs community-summary fail vs C not-ready during rebuild (align with fin 具名失败).
2. Integer **Leiden default seed**.
3. Embedding **model id / dimension** if not the existing NineRouter/env embedder.

**Note (2026-09-19):** assumption 9's **tunable** prune thresholds are satisfied programmatically — `FastPruneOptions` (`src/core/extraction/fast.ts`) takes `weakPercentile` (default 40th percentile) and `minDegree` (default 1) as index-job config. An operator CLI/env surface stays deferred until a real tuning need appears (YAGNI).

## Inherits / Changes

**Inherits:** ADR-0001 / ADR-0008 / ADR-0004; P0 extract + L0–L3 merge; projection outbox + drain; `specs/p0-extraction.md`; `specs/neo4j-graph-arm.md`; community **summary on ledger** from `specs/retrieve-community.md`.

**Changes:** product community detection is **hierarchical Leiden**, not Louvain (`retrieve-community.md` algorithm clause superseded). Fast vs standard extract methods; prune; claims on standard; graph-change rebuild; C-ready coupling; three index embedding classes as a job requirement. Retrieve topic-hit **order** stays parent graph-priority spec until `search-mode-retrieve.md`.

## 待写入 (persist after ACR)

empty — flushed 2026-09-17: CONTEXT **community** / pipeline Leiden; ADR-0011.

## architecture-change-reviewer

Affected surfaces: `src/core/extraction/*`, `src/core/graph/neo4j-community.ts`, community-summary CLI, ledger embeddings.

bounded-context-guardian: yes — Postgres SoR, Neo4j projection; retrieve 档 and Host cascade out.
input-contract-tests: yes — Boundaries name all 5 classes with Fake/no live GDS.
error-handling-enforcer: yes — typed EXITs named; public spelling is Open Question, not untyped fail.
complexity-anti-drift: yes — staged pipeline maps to existing modules, not one god-function.
minimal-change-verifier: yes — one index-time graph job.

OVERALL: PASS — 2026-09-17 ACR. Next: writing-plans.
