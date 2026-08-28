# iknow-memory — 领域词汇表

> 本文件是 iknow-memory（外置知识记忆 MCP 服务）的**领域词汇 SSOT**. 仅 `domain-modeling` 技能可写; 其他技能只读消费.

---

## Language

### Product identity

**iknow-memory**: the standalone, host-agnostic knowledge memory MCP server. Stores, indexes, and retrieves semantic facts with temporal validity; exposes MCP tools (`ingest`, `retrieve`) over stdio. Does not assemble context, trigger retrieval, or manage conversation state — those are the host's job.
_Avoid_: "knowledge base" (implies curated documents, not extracted facts); "memory backend" (too generic)

**MCP tool**: a function exposed via Model Context Protocol (`tools/list` + `tools/call`). iknow-memory defines its own tool protocol — not constrained by any legacy tool contract.
_Avoid_: "tool" alone (ambiguous with host tools); "API endpoint" (MCP is not REST)

**host**: any MCP client that discovers and calls iknow-memory tools (Claude Code, iknow harness, custom agents). The host owns context engineering (JIT retrieval triggers, cache layout, prompt assembly). iknow-memory never reaches into the host.
_Avoid_: "client" (too generic); "consumer" (implies passive reading, hosts actively orchestrate)

### Memory units

**chunk**: a fixed-window text slice produced by the chunker during ingest. Identified by UUID, carries `embedding`, `source_ref`, `metadata`, `valid_from`, `valid_until`, `created_at`. The atomic unit of vector storage and retrieval in stage 1.
_Avoid_: "document" (a chunk is a slice, not a whole document); "passage" (implies semantic completeness); "segment" (ambiguous with context segments)

**entity**: a canonical real-world referent extracted from chunks (person, concept, system, event). Identified by UUID, carries `canonical_name`, `type`, `embedding`, `metadata`. Multiple surface forms (aliases) resolve to one entity. _Stage: P0 (implemented)._
_Avoid_: "node" (graph-generic, use only when discussing Neo4j topology); "concept" (one entity type, not the general term); "mention" (a mention is an occurrence, not the canonical entity)

**triple**: a directed typed edge `(head_entity, relation, tail_entity)` extracted from a chunk. Carries `confidence`, `source_chunk_id`, `valid_window`, `created_at`. The atomic unit of graph knowledge. _Stage: P0 (implemented)._
_Avoid_: "fact" (too ambiguous in retrieval context; use "graph fact" / "temporal fact" if needed); "edge" (graph-generic, use only in Neo4j context); "link" (rule-based linkers do not produce typed edges)

**alias**: a surface-form string that resolves to a canonical entity (name variant, abbreviation, spelling). Stored in `entity_aliases` with `entity_id` foreign key. _Stage: P0 (implemented)._
_Avoid_: "synonym" (implies bidirectional equivalence); "variant" (one alias type, not the general term)

**canonical entity**: the merged, deduplicated entity that multiple aliases and mentions resolve to. P0 merging uses rule + embedding hybrid with hierarchical gating (zero LLM in P0; an LLM judge interface is reserved but not implemented — issue #6 Q3). The merge is the P0 "canonical entity resolution" deliverable. _Stage: P0 (implemented)._
_Avoid_: "master entity" (implies hierarchy); "root entity" (implies tree structure)

### Retrieval

**vector search**: brute-force cosine similarity over chunk embeddings (stage 1) or HNSW index (future). Host ranking uses it when the Neo4j graph arm contributes nothing, and to fill remaining `limit` slots after graph hits; embed failure still fails the call.
_Avoid_: "semantic search" (too broad, includes BM25); "embedding search" (the search is over embeddings, not for them); "always-on third RRF vote" (graph-priority superseded three-arm voting)

**BM25**: Okapi BM25 lexical ranking (k1=1.2, b=0.75) over tokenized chunk text. A retrieval arm that complements vector search by matching exact terms (query↔chunk lexical relevance — not chunker head/tail overlap). Production shape locked in issue #59: Postgres ranks a generated `content_tsv` (`simple` config, GIN index) while MemoryBackend keeps a same-contract inverted index for tests — scores are not comparable across the two, since RRF fuses on rank. Default on, configurable off via `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED`, fail-open to vector-only. _Stage: implemented (#62); the production partner arm._
_Avoid_: "keyword search" (BM25 is ranked, not boolean); "lexical search" (acceptable alias but BM25 is more precise)

**hybrid retrieval**: production Host ranking is graph-priority (`specs/retrieve-graph-priority.md`): non-empty **Neo4j graph arm** hits occupy the front of `chunks[]`; remaining `limit` slots (and the whole list when the graph arm contributes nothing) are vector+BM25 **RRF fusion (k=60)**. Weights 0.7 / 0.15 apply to that vector+BM25 RRF only — `w_graph` does not vote against vector. No URI → graph not attempted, not `degraded`. Optional later steps (same spec stack): **rerank**, **neighbor evidence**, entity-embedding seeds, community-summary hits. _Stage: graph-priority on main (PR #94)._
_Avoid_: "fusion search" (ambiguous); "three-arm RRF" (retired production ranking); "multi-signal search" (too vague)

**graph arm**: the archived Postgres SQL one-hop recall path (seed entities → one-hop triples with `valid_window @> valid_at` → chunks via `source_chunk_id`). Code and ledger retained; default server wiring never supplies `graphConfig`. Not a product transition bridge — see `docs/runbooks/sql-graph-arm-archived.md`. #70 does not reverse the archive: it adds the separate **Neo4j graph arm** and leaves `graphConfig` absent from `buildRetrieveDeps`, so the two arms are distinct code paths reached by distinct keys — `graphConfig` (test-injected only) vs `graphRanker` (production). Re-enabling this one is still a spec decision. _Stage: **archived off production** (#58 / #62); still archived after #70._
_Avoid_: "graph search" (too broad); "Neo4j graph arm" (different term — true PPR path); "deleted" / "removed" (archived, not deleted)

**Neo4j graph arm**: the production true-graph recall path: query embedding → entity seeds → Neo4j GDS **PPR** (`gds.graph.project` → `gds.pageRank.stream`) → map entities back to chunks via Postgres `source_chunk_id` (chunks never enter Neo4j). Non-empty hits lead Host ranking; empty hits are not `degraded` and ranking falls back to vector+BM25 RRF. Default on when Neo4j is configured; missing URI skips without `degraded`; configured failure fail-open with `degraded=true`. No LangGraph. Operating it: `docs/runbooks/neo4j-projection.md`. _Stage: PPR arm + graph-priority Host order on main._
_Avoid_: "graph arm" alone (that name is the archived SQL path); "third RRF arm" (retired ranking); "LangGraph" (wrong layer)

**projection outbox**: the transactional intent log written in the same Postgres transaction as ledger entity/triple changes (extract CLI), later drained by a projector into Neo4j. Enables eventually-consistent read-only projection without dual-writing Neo4j inside the SoR transaction. Paired with a full backfill/reconcile for empty graphs. Concretely the `projection_outbox` table (`subject_kind` CHECKed to `entity`/`triple`, so "chunks never enter the graph" is a database invariant), drained by `npm run graph:drain`. An intent names a subject, never a snapshot: the drain re-reads Postgres, so intents need no ordering rule and a re-drain cannot push a stale value. _Stage: locked (#69); on main via #77 — outbox emit on the extract path, backfill/reconcile CLI, projector drain._
_Avoid_: "CDC" (acceptable mechanism class, but the locked choice is outbox); "dual-write" (forbidden product pattern — Neo4j is not a second SoR); "event bus" (too generic)

**RRF fusion (k=60)**: Reciprocal Rank Fusion with constant k=60; rank-based — no cross-arm score calibration. Production uses it for **vector + BM25** (fallback when the Neo4j graph arm contributes nothing, and remainder fill after graph hits). It does not fuse graph hits against vector as equal votes. Ties break by arm order (vector, then bm25) then id. _Stage: implemented (#62); graph-as-third-vote retired (#89 / `specs/retrieve-graph-priority.md`)._
_Avoid_: "score fusion" (RRF is rank-based); "three-arm RRF" (retired Host ranking); "merging results" (ambiguous with entity merge)

**degraded=true**: the additive-optional envelope flag on the `retrieve` JSON payload, set when an optional arm was ATTEMPTED and could not deliver — BM25 threw, Neo4j graph arm threw, or (legacy) SQL graph arm threw / fell below `graphArmFloor` — while remaining chunks are still returned. An arm that found nothing has not degraded; an arm the operator switched off has not degraded; **missing Neo4j URI** (cannot attempt) also does not degrade. Empty graph hits then use vector+BM25 ranking; that is not `degraded`. _Stage: P0, extended to BM25 in #62; Neo4j skip/fail-open locked #69; ranking fallback is graph-priority (`specs/retrieve-graph-priority.md`)._
_Avoid_: "error flag" (a degraded response is a valid response, not an error); "fallback flag" (`degraded` is not the graph-empty ranking fork)

**RetrieveConfig**: the frozen-on-read retrieval config object including `{w_vec, w_bm25, w_graph, bm25Enabled, graphEnabled, …}` loaded via `GraphragEnv` (`ConfigError` on invalid values). `w_vec` / `w_bm25` fuse vector+BM25 RRF on fallback and remainder fill; `w_graph` does not vote against vector under graph-priority ranking. `graphEnabled` default on when Neo4j is configured. Changing defaults post-Bootstrap is Ask-first. _Stage: env shape from #62/#69; ranking semantics `specs/retrieve-graph-priority.md`._
_Avoid_: "retrieval settings" (vague); "0.7/0.15/0.15 three-arm weights" (retired Host ranking)

**embedding credentials**: the canonical embedding secret is `GRAPHRAG_MEMORY_EMBED_API_KEY`; the preferred vector alias is `GRAPHRAG_MEMORY_VECTOR_API_KEY`; `GRAPHRAG_MEMORY_ANTHROPIC_API_KEY` is a legacy vector alias. These are embedding credentials, never the LLM secret. The indirect `GRAPHRAG_MEMORY_EMBED_API_KEY_ENV` form remains supported.
_Avoid_: treating `GRAPHRAG_MEMORY_ANTHROPIC_API_KEY` as the LLM token (`ANTHROPIC_AUTH_TOKEN` is the LLM secret); "Anthropic API key" unqualified (ambiguous between vector alias and LLM token)

**rerank**: a post-ranking permutation of retrieve `chunks[]` before Host `limit`. Slice 0 (on main): extract Anthropic **main model**, default MiniMax-M3 on China `https://api.minimaxi.com/anthropic` with LLM secret `ANTHROPIC_AUTH_TOKEN`; default off; missing token skip (not `degraded`); LLM failure fail-open. Slice 1 (`specs/retrieve-graph-quality.md`): dedicated HTTP reranker behind the same hook; default off; missing URL skip; throw fail-open + `degraded`. Not the Host chat model. Spec/plan slice 0: `specs/retrieve-rerank-llm.md`.
_Avoid_: "re-sort" (implies trivial ordering); "Host rerank" (forbidden); "cross-encoder" (HTTP client may be one, not a new MCP tool)

**PPR (Personalized PageRank)**: single-step multi-hop graph traversal from query-anchored seed nodes. Replaces iterative BFS/DFS (10-30× cheaper per HippoRAG 2). Requires native graph engine (Neo4j GDS). Named term of art in GraphRAG literature — not a project-coined acronym. _Stage: morphology locked (#69); on main via Neo4j graph arm (#77)._
_Avoid_: "graph search" (too broad); "random walk" (PPR is a specific algorithm, not generic random walk); "multi-hop retrieval" (describes the effect, not the mechanism)

**mode bundle**: a named retrieve preset (`conservative` | `balanced` | `tokenmax`) setting candidateK, topK, rerank window, vector+BM25 weights, and neighbor width. Applied inside the existing `retrieve` tool (env default + optional input). Unknown names are config/tool errors. Not a new MCP tool. _Stage: locked in `specs/retrieve-graph-quality.md`; not yet implemented._
_Avoid_: "profile" (ambiguous with embedding profile); "preset" (acceptable alias for mode bundle)

**neighbor evidence**: after Host ranking (and optional **rerank**), include ±N other **chunk**s with the same `source_ref` from Postgres. Default N comes from the **mode bundle** (balanced default 1; N=0 is identity). Chunks never enter Neo4j. _Stage: locked in `specs/retrieve-graph-quality.md`; not yet implemented._
_Avoid_: "lexical graph" (we do not store chunk-chunk edges in Neo4j); "context window" (Host assembly)

### Time model

**valid_window**: the temporal validity interval `[valid_from, valid_until)` of a chunk or triple. `valid_until = null` means forever-valid. Filtering uses `@>` containment (Postgres) or equivalent. Left-closed, right-open: a chunk expiring at exactly `valid_at` is NOT returned.
_Avoid_: "time range" (ambiguous with query time range); "TTL" (TTL is cache terminology, not validity); "lifespan" (implies biological metaphor)

**valid_at**: the query-time reference point for temporal filtering. Defaults to `now()` when caller omits it. All `valid_window` checks are evaluated against this instant.
_Avoid_: "current time" (valid_at can be set to past/future for historical queries); "timestamp" (too generic)

**superseded_by**: a forward pointer from an expired fact to its replacement. Enables "what replaced this?" queries without deletion. Consolidate CLI dry-run then apply (`specs/retrieve-graph-quality.md` slice 9). _Stage: locked; not yet implemented._
_Avoid_: "replaced_by" (acceptable alias); "version" (implies linear versioning, supersession can be non-linear)

**causal edge**: a typed triple relation expressing causation (`caused`, `enabled`, `prevented`). Enables "why did X happen?" reasoning. Distinct from descriptive relations (`is_a`, `part_of`, `located_in`). Vocabulary + extract (`specs/retrieve-graph-quality.md` slice 9). _Stage: locked; not yet implemented._
_Avoid_: "causal link" (rule-based linkers do not produce typed edges); "reason edge" (ambiguous)

### Graph storage

**Neo4j sidecar**: graph engine deployed alongside the MCP server for native multi-hop traversal (PPR first; Louvain / node-level embedding later); a read-only projection of Postgres-authoritative entities/triples, never a system of record (ADR-0001 / issue #3 D1). Sync mechanism locked as transactional **projection outbox** + full backfill (#69; #7 Q3b). SQL JOIN and Apache AGE do not meet the native-traversal constraint, hence the sidecar. Optional by construction: the server starts, ingests and retrieves with no sidecar configured. _Stage: morphology locked (#69); on main via #77 (Neo4j CE + GDS over Bolt)._
_Avoid_: "graph database" (too generic); "Neo4j CE" (edition detail, not architectural term); "graph backend" (acceptable alias)

**community**: a cluster of densely-connected entities detected by Louvain (Neo4j GDS). Each community gets a ledger-stored summary; retrieve may return those summaries as Host `chunks[]` when the **mode bundle** enables topic retrieve. Map-reduce of a final answer stays on the **host**. _Stage: locked in `specs/retrieve-graph-quality.md`; not yet implemented._
_Avoid_: "cluster" (too generic, used in embedding clustering too); "topic group" (implies manual curation)

### Pipeline

**ingest**: the write pipeline: validate → size check → chunk → embed → store. Exposed as MCP tool `ingest(input: {content, source_ref, metadata?, valid_from?, valid_until?}) → {chunk_ids}`. Stage 1: chunks-only. P0 adds: → extract triples → resolve entities → store graph.
_Avoid_: "index" (implies search-index building, not knowledge extraction); "import" (implies bulk file loading)

**retrieve**: the read pipeline: embed query once → entity seeds + Neo4j **PPR** (when configured) mapping to chunks via `source_chunk_id` → non-empty graph hits lead Host `chunks[]`, else (and remainder slots) vector ∥ BM25 → **RRF fusion** → optional entity-embedding seeds / community-summary hits → optional **rerank** (slice 0 temporary Anthropic on main, default off; dedicated HTTP later) → optional **neighbor evidence** → top-K. Optional drain wait is default off. Exposed as MCP tool `retrieve(input: {query, valid_at?, filters?, limit?}) → {chunks[]}`. Wire stays `{ chunks[] }` (+ optional `degraded`). _Stage: graph-priority + temporary LLM rerank on main; later steps `specs/retrieve-graph-quality.md`._
_Avoid_: "search" (too broad); "three-arm retrieve" (retired ranking); "recall" (one stage, not the whole pipeline)

**extract_triples**: the P0 extraction pipeline: LLM schema-guided triple extraction from chunk text → confidence scoring → canonical entity resolution → store. Not an MCP tool — it runs as the `extract` CLI batch pipeline, separate from `ingest`. _Stage: P0 (implemented)._
_Avoid_: "parse" (implies deterministic grammar, extraction is LLM-based); "NER" (NER is one sub-step, not the whole pipeline)

**embedding backfill**: the idempotent NULL-embedding repair mode (CLI flag `--backfill-embeddings`) that embeds and UPDATEs every live entity row `WHERE embedding IS NULL` using the stored description; an immediate second run updates 0 rows. Never runs automatically inside a normal extraction run. _Stage: P0 (implemented per `specs/p0-wiring-closure.md`)._
_Avoid_: "re-embed" (backfill never overwrites an existing embedding); "migration" (repeatable repair, not a one-shot schema change)

### Extraction & merge

**relation_norm**: the normalized relation string used as the graph traversal key, produced by the #4 D5 cascade (exact → synonym → embedding → `UNMAPPED`) over the git-managed vocabulary; `UNMAPPED` is a legal sentinel, never a silent coerce. `relation_raw` is always stored alongside for audit fidelity. _Stage: P0 (implemented; cascade wired into the production upsert path per `specs/p0-wiring-closure.md`)._
_Avoid_: "relation" alone (ambiguous with `relation_raw`); "predicate" (RDF terminology, not used here); "edge type" (Neo4j projection detail)

**vocabulary**: the git-managed TS module (`src/core/extraction/vocabulary.ts`) holding the `ALLOWED` relation set, the `ALIASES` synonym map, and `PROMPT_HINT` for LLM prompt construction. Growth is human-review only — no automation in P0 (#4 D7). _Stage: P0._
_Avoid_: "ontology" (implies formal class hierarchy); "taxonomy" (implies tree structure); "schema" (ambiguous with the DB schema)

**extraction_records**: the per-chunk extraction status table (`pending → succeeded | failed`) carrying `error_code`, `error_msg`, `triples_count`, `unmapped_count`, and `batch_id` for aggregation. The visibility surface for mark-and-continue, queried via `listFailed()`. _Stage: P0._
_Avoid_: "log table" (records are queryable state, not append-only logs); "audit table" (audit is a side benefit, not the purpose)

**merged_into**: the soft-merge pointer on `entities` (nullable FK → `entities.id`, `ON DELETE SET NULL`) from a losing entity to its survivor. Roll-backable — deleting the survivor nulls the pointer; `resolveCanonicalId` walks the chain with cycle detection (maxChainDepth 16). Extract **must write** the pointer in production (`specs/retrieve-graph-quality.md` slice 4). _Stage: schema+resolver on main; persist on extract not yet implemented._
_Avoid_: "parent" (implies hierarchy); "redirect" (web terminology); "tombstone" (the loser row is not deleted)

**L0/L1/L2/L3 gate**: the hierarchical merge gates: L0 rule-exact (normalized name + same type → merge), L1 type mismatch → reject, L2 description-cosine floor (0.30; skipped when description < 8 chars) → reject, L3 name+description cosine ≥ 0.5 → merge, else gray-zone reject. _Stage: P0._
_Avoid_: "merge levels" (vague); "thresholds" (L0/L1 are rules, not thresholds)

**mark-and-continue**: the batch policy where a failed chunk does not abort the extraction batch; the failure is recorded as `extraction_records.status='failed'` and stays visible via `listFailed()`. _Stage: P0._
_Avoid_: "skip" (implies silent loss; the failure is recorded); "best-effort" (too vague)

**gray zone**: the L3 cosine band where merge-vs-reject is ambiguous; default behavior is reject plus a structured log on every gray-zone rejection (#6 Q5). The LLM-judge escalation is reserved, not implemented (#6 Q3). _Stage: P0._
_Avoid_: "uncertain match" (vague); "borderline" (colloquial)

### Evaluation

**extraction F1**: fact-level precision and recall for triple extraction, evaluated against human-annotated ground truth. Separate metrics for entity recognition and relation classification. The quality gate for P0. _Stage: P0._
_Avoid_: "accuracy" (F1 is more informative for imbalanced extraction); "quality score" (too vague)

**P@5 / R@5**: precision and recall at rank 5 over the Host-visible `chunks[]` after graph-priority ranking (graph hits first when present, else vector+BM25 RRF); gold is query → relevant chunk ids, Bootstrap records numbers only (no CI gate), and a missing Neo4j URI is skip not a failed run. Operated by `npm run eval:retrieve` through `assembleRetrievalResult`, baseline `eval/baseline/retrieve-p5.json`. Separate from **extraction F1** (#15 postponed). _Stage: harness on main (#80/#82); ranking semantics follow `specs/retrieve-graph-priority.md` once implemented._
_Avoid_: "hit rate" (ambiguous); "three-arm fused P@5" (retired ranking); "extraction F1" (different layer)

## Relationships

- **content → chunker → chunk[]**: ingest splits raw text into fixed-window overlapping chunks
- **chunk → embedder → embedding**: each chunk gets a dense vector (real API or FakeEmbedder for dev/test)
- **chunk + LLM → extract_triples → triple[]**: P0 extraction produces (head, relation, tail) from chunk text
- **triple → entity resolution → canonical entity**: aliases and mentions merge into deduplicated entities
- **query → embedder → Neo4j graph arm (PPR → chunks) leading Host list, else vector search ∥ BM25 → RRF fusion → top-K**: locked ranking (`specs/retrieve-graph-priority.md`); on main
- **query → hybrid retrieval**: graph-priority ranking, then optional entity-embedding seeds / community hits / **rerank** / **neighbor evidence** (`specs/retrieve-rerank-llm.md`, `specs/retrieve-graph-quality.md`)
- **valid_window + valid_at → temporal filter**: chunks/triples outside the query's time window are excluded
- **entity → Neo4j node; triple → Neo4j edge**: read-only projection of Postgres via **projection outbox** + backfill (#69/#70; ADR-0001). Operator path: `npm run graph:backfill` then `npm run graph:drain` — see `docs/runbooks/neo4j-projection.md`
- **Postgres authoritative, Neo4j read-only projection**: Postgres is the sole system of record for entities, triples, aliases, and extraction_records; Neo4j is a derived read-only projection. Sync = projection outbox + full backfill (eventually consistent by default; optional retrieve wait in `specs/retrieve-graph-quality.md`). Do not propose writing to Neo4j outside the projection path, or "just use Postgres for everything" without addressing the native-traversal constraint (PPR / Louvain / later).
- **community → Louvain → ledger summary → optional retrieve hits**: topic retrieve; Host still generates the answer

## Flagged ambiguities

- **triple vs fact**: in iknow-memory, "triple" is the canonical term for (head, relation, tail). "Fact" is avoided because it is too generic in retrieval literature (bi-temporal claims in some systems, plain extracted assertions in others). If you must say "fact" in iknow-memory context, qualify it: "graph fact" or "temporal fact".
- **valid_window vs valid_at**: `valid_window` is a property of stored data (when is this true?); `valid_at` is a property of the query (when am I asking about?). The filter is `valid_window @> valid_at`.
- **Postgres authoritative, Neo4j read-only projection**: Postgres is the sole system of record for entities, triples, aliases, and extraction_records; Neo4j is a derived read-only projection synced via **projection outbox** + backfill (#69/#70; ADR-0001). Eventually consistent by default; optional retrieve wait is `specs/retrieve-graph-quality.md` slice 10. Native traversal (PPR first) is why Neo4j exists — SQL JOIN / AGE do not meet that constraint. Do not write to Neo4j outside the projection path.
- **rerank fail-open**: rerank failure returns the pre-rerank Host order unchanged (graph-priority list, or vector+BM25 RRF). A dead reranker must not block retrieval. Do not add retry/fallback logic that changes this contract without explicit decision.
- **graph-priority vs three-arm RRF**: Host ranking is graph-priority (`specs/retrieve-graph-priority.md`). Do not describe production retrieve as vector+BM25+graph RRF at 0.7/0.15/0.15.
- **context engineering is NOT our job**: JIT retrieval triggers, cache breakpoint planning, prompt assembly, budget allocation — these belong to the host. iknow-memory returns ranked chunks; what the host does with them is the host's problem.
- **zero external runtime dependency on any reference implementation**: design decisions (RRF k=60, cosine re-score 0.7/0.3, rerank fail-open, PPR) are first-class product choices documented in CONTEXT.md and PRDs; rationale is independent of any particular reference codebase. Any locally tracked upstream reference directory is read-only and not linked at runtime (zero import/link/symlink/dynamic load). We implement from first principles, not by copying.

## Bootstrap mode

If this file only had template examples and no real project terms, seed via:

1. Read `src/core/types.ts` for storage vocabulary
2. Read `src/tools/ingest.ts` and `retrieve.ts` for tool contracts
3. Read each module's local README / header comment for that capability area's gap vocabulary
4. Invoke `arthurpower:domain-modeling` to ratify new terms before adding them here
