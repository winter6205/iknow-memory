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

**vector search**: brute-force cosine similarity over chunk embeddings (stage 1) or HNSW index (future). Returns ranked chunks by cosine score. The always-on arm: every retrieve runs it, and its failure is the caller's failure.
_Avoid_: "semantic search" (too broad, includes BM25); "embedding search" (the search is over embeddings, not for them)

**BM25**: Okapi BM25 lexical ranking (k1=1.2, b=0.75) over tokenized chunk text. A retrieval arm that complements vector search by matching exact terms (query↔chunk lexical relevance — not chunker head/tail overlap). Production shape locked in issue #59: Postgres ranks a generated `content_tsv` (`simple` config, GIN index) while MemoryBackend keeps a same-contract inverted index for tests — scores are not comparable across the two, since RRF fuses on rank. Default on, configurable off via `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED`, fail-open to vector-only. _Stage: implemented (#62); the production partner arm._
_Avoid_: "keyword search" (BM25 is ranked, not boolean); "lexical search" (acceptable alias but BM25 is more precise)

**hybrid retrieval**: multi-arm recall fused by Reciprocal Rank Fusion (RRF, k=60). Production path is vector + BM25 + Neo4j graph at weights 0.7 / 0.15 / 0.15 (Ask-first to change defaults). The weights are unconditional; the arm set is not — with no Neo4j URI configured the graph arm never attempts, so the same defaults fuse vector + BM25 alone and nothing is marked `degraded`. Cosine re-score blend (0.7 normRRF + 0.3 cosine) remains a later polish. _Stage: vector+BM25 implemented (#62); three-arm morphology locked (#69); three-arm path implemented on the #70 branch, pending merge to main._
_Avoid_: "fusion search" (ambiguous); "multi-signal search" (too vague)

**graph arm**: the archived Postgres SQL one-hop recall path (seed entities → one-hop triples with `valid_window @> valid_at` → chunks via `source_chunk_id`). Code and ledger retained; default server wiring never supplies `graphConfig`. Not a product transition bridge — see `docs/runbooks/sql-graph-arm-archived.md`. #70 does not reverse the archive: it adds the separate **Neo4j graph arm** and leaves `graphConfig` absent from `buildRetrieveDeps`, so the two arms are distinct code paths reached by distinct keys — `graphConfig` (test-injected only) vs `graphRanker` (production). Re-enabling this one is still a spec decision. _Stage: **archived off production** (#58 / #62); still archived after #70._
_Avoid_: "graph search" (too broad); "Neo4j graph arm" (different term — true PPR path); "deleted" / "removed" (archived, not deleted)

**Neo4j graph arm**: the production true-graph recall path: query embedding → entity seeds → Neo4j GDS **PPR** (`gds.graph.project` → `gds.pageRank.stream`) → map entities back to chunks via Postgres `source_chunk_id` (chunks never enter Neo4j) → RRF as a third arm. Default on when Neo4j is configured (`GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED`, `GRAPHRAG_MEMORY_NEO4J_URI`); missing URI skips without `degraded`; configured failure fail-open with `degraded=true`. No LangGraph. Operating it: `docs/runbooks/neo4j-projection.md`. _Stage: morphology locked (#69); implemented on the #70 branch, pending merge to main._
_Avoid_: "graph arm" alone (that name is the archived SQL path); "graph traversal" (mechanism is PPR); "LangGraph" (agent workflow framework — wrong layer)

**projection outbox**: the transactional intent log written in the same Postgres transaction as ledger entity/triple changes (extract CLI), later drained by a projector into Neo4j. Enables eventually-consistent read-only projection without dual-writing Neo4j inside the SoR transaction. Paired with a full backfill/reconcile for empty graphs. Concretely the `projection_outbox` table (`subject_kind` CHECKed to `entity`/`triple`, so "chunks never enter the graph" is a database invariant), drained by `npm run graph:drain`. An intent names a subject, never a snapshot: the drain re-reads Postgres, so intents need no ordering rule and a re-drain cannot push a stale value. _Stage: locked (#69); implemented on the #70 branch — outbox emit on the extract path, backfill/reconcile CLI, projector drain — pending merge to main._
_Avoid_: "CDC" (acceptable mechanism class, but the locked choice is outbox); "dual-write" (forbidden product pattern — Neo4j is not a second SoR); "event bus" (too generic)

**RRF fusion (k=60)**: Reciprocal Rank Fusion with constant k=60; rank-based by design — no cross-arm score calibration (MinMax / z-score / sigmoid). N-arm: it takes an arm list rather than a fixed pair, so the arm set can change without touching the algorithm. Ties break by arm order (vector, then bm25, then graph) and then by id, so fused output is deterministic. _Stage: implemented (#62); #70 adds the Neo4j graph arm as the third weighted arm (on branch, pending merge)._
_Avoid_: "score fusion" (RRF is rank-based, not score-based); "ensemble" (ML model terminology); "merging results" (ambiguous with entity merge)

**degraded=true**: the additive-optional envelope flag on the `retrieve` JSON payload, set when an optional arm was ATTEMPTED and could not deliver — BM25 threw, Neo4j graph arm threw, or (legacy) SQL graph arm threw / fell below `graphArmFloor` — while other arms' chunks are still returned. An arm that found nothing has not degraded; an arm the operator switched off has not degraded; **missing Neo4j URI** (cannot attempt) also does not degrade. _Stage: P0, extended to BM25 in #62; Neo4j rules locked #69 and implemented on the #70 branch._
_Avoid_: "error flag" (a degraded response is a valid response, not an error); "fallback flag" (the vector arm always runs; it is not a fallback)

**RetrieveConfig**: the frozen-on-read retrieval config object including `{w_vec, w_bm25, w_graph, bm25Enabled, …}` loaded via `GraphragEnv` and validated at startup (`ConfigError` on invalid values). Defaults are 0.7 / 0.15 / 0.15 with `graphEnabled` default on. `w_graph` steers the **Neo4j graph arm** — never the archived SQL one, which the production wiring cannot reach at any weight. Changing defaults post-Bootstrap is Ask-first. _Stage: extended in #62; Neo4j defaults locked #69 and implemented on the #70 branch, pending merge to main._
_Avoid_: "retrieval settings" (vague); "tuning knobs" (colloquial); "mode bundle" (P1 preset concept, distinct)

**rerank**: a post-fusion reordering step that promotes authoritative/fresh/relevant chunks. Options to evaluate: cross-encoder (e.g. zerank-class models), LLM rerank, or feature-based heuristics. iknow-memory: TBD (feature-based prototype validated, real cross-encoder or LLM rerank pending). Fail-open: rerank failure returns fused order unchanged.
_Avoid_: "re-sort" (implies trivial ordering); "refinement" (too vague)

**PPR (Personalized PageRank)**: single-step multi-hop graph traversal from query-anchored seed nodes. Replaces iterative BFS/DFS (10-30× cheaper per HippoRAG 2). Requires native graph engine (Neo4j GDS). Named term of art in GraphRAG literature — not a project-coined acronym. _Stage: morphology locked (#69); implemented via the Neo4j graph arm on the #70 branch, pending merge to main._
_Avoid_: "graph search" (too broad); "random walk" (PPR is a specific algorithm, not generic random walk); "multi-hop retrieval" (describes the effect, not the mechanism)

**mode bundle**: a named preset of retrieval parameters (candidateK, topK, rerank depth, arm weights). Common presets seen in hybrid RAG systems: conservative / balanced / tokenmax. iknow-memory: TBD. _Stage: P1._
_Avoid_: "profile" (ambiguous with embedding profile); "preset" (acceptable alias for mode bundle)

### Time model

**valid_window**: the temporal validity interval `[valid_from, valid_until)` of a chunk or triple. `valid_until = null` means forever-valid. Filtering uses `@>` containment (Postgres) or equivalent. Left-closed, right-open: a chunk expiring at exactly `valid_at` is NOT returned.
_Avoid_: "time range" (ambiguous with query time range); "TTL" (TTL is cache terminology, not validity); "lifespan" (implies biological metaphor)

**valid_at**: the query-time reference point for temporal filtering. Defaults to `now()` when caller omits it. All `valid_window` checks are evaluated against this instant.
_Avoid_: "current time" (valid_at can be set to past/future for historical queries); "timestamp" (too generic)

**superseded_by**: a forward pointer from an expired fact to its replacement. Enables "what replaced this?" queries without deletion. _Stage: P2 (not yet implemented)._
_Avoid_: "replaced_by" (acceptable alias); "version" (implies linear versioning, supersession can be non-linear)

**causal edge**: a typed triple relation expressing causation (`caused`, `enabled`, `prevented`). Enables "why did X happen?" reasoning. Distinct from descriptive relations (`is_a`, `part_of`, `located_in`). _Stage: P2 (not yet implemented)._
_Avoid_: "causal link" (rule-based linkers do not produce typed edges); "reason edge" (ambiguous)

### Graph storage

**Neo4j sidecar**: graph engine deployed alongside the MCP server for native multi-hop traversal (PPR first; Louvain / node-level embedding later); a read-only projection of Postgres-authoritative entities/triples, never a system of record (ADR-0001 / issue #3 D1). Sync mechanism locked as transactional **projection outbox** + full backfill (#69; #7 Q3b). SQL JOIN and Apache AGE do not meet the native-traversal constraint, hence the sidecar. Optional by construction: the server starts, ingests and retrieves with no sidecar configured. _Stage: morphology locked (#69); implemented on the #70 branch (Neo4j CE + GDS over Bolt), pending merge to main._
_Avoid_: "graph database" (too generic); "Neo4j CE" (edition detail, not architectural term); "graph backend" (acceptable alias)

**community**: a cluster of densely-connected entities detected by Louvain (Neo4j GDS). Each community gets a hierarchical summary for global/topic QA. _Stage: P3 (not yet implemented)._
_Avoid_: "cluster" (too generic, used in embedding clustering too); "topic group" (implies manual curation)

### Pipeline

**ingest**: the write pipeline: validate → size check → chunk → embed → store. Exposed as MCP tool `ingest(input: {content, source_ref, metadata?, valid_from?, valid_until?}) → {chunk_ids}`. Stage 1: chunks-only. P0 adds: → extract triples → resolve entities → store graph.
_Avoid_: "index" (implies search-index building, not knowledge extraction); "import" (implies bulk file loading)

**retrieve**: the read pipeline: embed query once → vector search ∥ BM25 ∥ (when configured) Neo4j graph arm, all with valid_window where applicable → RRF fusion → return ranked chunks. Exposed as MCP tool `retrieve(input: {query, valid_at?, filters?, limit?}) → {chunks[]}`. Wire shape stays `{ chunks[] }` (+ optional `degraded`). Rerank remains later. _Stage: vector+BM25 on main (#62); Neo4j third arm implemented on the #70 branch, pending merge to main._
_Avoid_: "search" (too broad); "query" (the input is a query, the operation is retrieve); "recall" (one stage of retrieval, not the whole pipeline)

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

**merged_into**: the soft-merge pointer on `entities` (nullable FK → `entities.id`, `ON DELETE SET NULL`) from a losing entity to its survivor. Roll-backable — deleting the survivor nulls the pointer; `resolveCanonicalId` walks the chain with cycle detection (maxChainDepth 16). _Stage: P0._
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

**P@5 / R@5**: precision and recall at rank 5 for retrieval evaluation. Standard IR metric; widely adopted as primary metric in retrieval benchmarks (e.g. BrainBench). iknow-memory will establish its own baseline. _Stage: P1._
_Avoid_: "hit rate" (ambiguous); "top-K accuracy" (K must be specified)

## Relationships

- **content → chunker → chunk[]**: ingest splits raw text into fixed-window overlapping chunks
- **chunk → embedder → embedding**: each chunk gets a dense vector (real API or FakeEmbedder for dev/test)
- **chunk + LLM → extract_triples → triple[]**: P0 extraction produces (head, relation, tail) from chunk text
- **triple → entity resolution → canonical entity**: aliases and mentions merge into deduplicated entities
- **query → embedder → vector search ∥ BM25 → RRF fusion → top-K**: production retrieve on main today (#62)
- **query → hybrid retrieval (vector + BM25 + Neo4j graph) → RRF fusion → top-K**: production path once #70 merges; rerank stays a later stage
- **valid_window + valid_at → temporal filter**: chunks/triples outside the query's time window are excluded
- **entity → Neo4j node; triple → Neo4j edge**: read-only projection of Postgres via **projection outbox** + backfill (#69/#70; ADR-0001). Operator path: `npm run graph:backfill` then `npm run graph:drain` — see `docs/runbooks/neo4j-projection.md`
- **Postgres authoritative, Neo4j read-only projection**: Postgres is the sole system of record for entities, triples, aliases, and extraction_records; Neo4j is a derived read-only projection. Sync = projection outbox + full backfill (eventually consistent; no read-your-writes in #70). Do not propose writing to Neo4j outside the projection path, or "just use Postgres for everything" without addressing the native-traversal constraint (PPR / later Louvain / node embedding).
- **community → Louvain → hierarchical summary**: P3 global QA path

## Flagged ambiguities

- **triple vs fact**: in iknow-memory, "triple" is the canonical term for (head, relation, tail). "Fact" is avoided because it is too generic in retrieval literature (bi-temporal claims in some systems, plain extracted assertions in others). If you must say "fact" in iknow-memory context, qualify it: "graph fact" or "temporal fact".
- **valid_window vs valid_at**: `valid_window` is a property of stored data (when is this true?); `valid_at` is a property of the query (when am I asking about?). The filter is `valid_window @> valid_at`.
- **Postgres authoritative, Neo4j read-only projection**: Postgres is the sole system of record for entities, triples, aliases, and extraction_records; Neo4j is a derived read-only projection synced via **projection outbox** + backfill (#69/#70; ADR-0001). Eventually consistent; read-your-writes still deferred. Native traversal (PPR first) is why Neo4j exists — SQL JOIN / AGE do not meet that constraint. Do not write to Neo4j outside the projection path.
- **rerank fail-open**: rerank failure returns the fused order unchanged. This is intentional — a dead reranker should not block retrieval. Do not add retry/fallback logic that changes this contract without explicit decision.
- **context engineering is NOT our job**: JIT retrieval triggers, cache breakpoint planning, prompt assembly, budget allocation — these belong to the host. iknow-memory returns ranked chunks; what the host does with them is the host's problem.
- **zero external runtime dependency on any reference implementation**: design decisions (RRF k=60, cosine re-score 0.7/0.3, rerank fail-open, PPR) are first-class product choices documented in CONTEXT.md and PRDs; rationale is independent of any particular reference codebase. Any locally tracked upstream reference directory is read-only and not linked at runtime (zero import/link/symlink/dynamic load). We implement from first principles, not by copying.

## Bootstrap mode

If this file only had template examples and no real project terms, seed via:

1. Read `src/core/types.ts` for storage vocabulary
2. Read `src/tools/ingest.ts` and `retrieve.ts` for tool contracts
3. Read each module's local README / header comment for that capability area's gap vocabulary
4. Invoke `arthurpower:domain-modeling` to ratify new terms before adding them here
