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

**entity**: a canonical real-world referent extracted from chunks (person, concept, system, event). Identified by UUID, carries `canonical_name`, `type`, `embedding`, `metadata`. Multiple surface forms (aliases) resolve to one entity. _Stage: P0 (not yet implemented)._
_Avoid_: "node" (graph-generic, use only when discussing Neo4j topology); "concept" (one entity type, not the general term); "mention" (a mention is an occurrence, not the canonical entity)

**triple**: a directed typed edge `(head_entity, relation, tail_entity)` extracted from a chunk. Carries `confidence`, `source_chunk_id`, `valid_window`, `created_at`. The atomic unit of graph knowledge. _Stage: P0 (not yet implemented)._
_Avoid_: "fact" (too ambiguous in retrieval context; use "graph fact" / "temporal fact" if needed); "edge" (graph-generic, use only in Neo4j context); "link" (rule-based linkers do not produce typed edges)

**alias**: a surface-form string that resolves to a canonical entity (name variant, abbreviation, spelling). Stored in `entity_aliases` with `entity_id` foreign key. _Stage: P0 (not yet implemented)._
_Avoid_: "synonym" (implies bidirectional equivalence); "variant" (one alias type, not the general term)

**canonical entity**: the merged, deduplicated entity that multiple aliases and mentions resolve to. P0 merging uses rule + embedding hybrid with hierarchical gating (zero LLM in P0; an LLM judge interface is reserved but not implemented — issue #6 Q3). The merge is the P0 "canonical entity resolution" deliverable. _Stage: P0 (not yet implemented)._
_Avoid_: "master entity" (implies hierarchy); "root entity" (implies tree structure)

### Retrieval

**vector search**: brute-force cosine similarity over chunk embeddings (stage 1) or HNSW index (future). Returns ranked chunks by cosine score. The only retrieval arm in stage 1.
_Avoid_: "semantic search" (too broad, includes BM25); "embedding search" (the search is over embeddings, not for them)

**BM25**: Okapi BM25 lexical ranking (k1=1.2, b=0.75) over tokenized chunk text. A retrieval arm that complements vector search by matching exact terms. _Stage: not yet in product retrieve (algorithm validated in prototype)._
_Avoid_: "keyword search" (BM25 is ranked, not boolean); "lexical search" (acceptable alias but BM25 is more precise)

**hybrid retrieval**: multi-arm recall (vector + BM25 + graph traversal) fused by Reciprocal Rank Fusion (RRF, k=60) with weighted arms (vector 0.8, BM25 0.2), followed by cosine re-score blend (0.7 normRRF + 0.3 cosine). _Stage: P1._
_Avoid_: "fusion search" (ambiguous); "multi-signal search" (too vague)

**rerank**: a post-fusion reordering step that promotes authoritative/fresh/relevant chunks. Options to evaluate: cross-encoder (e.g. zerank-class models), LLM rerank, or feature-based heuristics. iknow-memory: TBD (feature-based prototype validated, real cross-encoder or LLM rerank pending). Fail-open: rerank failure returns fused order unchanged.
_Avoid_: "re-sort" (implies trivial ordering); "refinement" (too vague)

**PPR (Personalized PageRank)**: single-step multi-hop graph traversal from query-anchored seed nodes. Replaces iterative BFS/DFS (10-30× cheaper per HippoRAG 2). Requires native graph engine (Neo4j GDS). _Stage: P1._
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

**Neo4j sidecar**: graph engine deployed alongside the MCP server for P1+ native multi-hop traversal (PPR, Louvain, node-level embedding); a read-only projection of Postgres-authoritative entities/triples, never a system of record (issue #3 D1). In P0 the server does not connect to it at all — projection synchronization graduated to P1, with outbox as the leading candidate (issue #7 Q3b). SQL JOIN and Apache AGE do not meet the native-traversal constraint, hence the sidecar.
_Avoid_: "graph database" (too generic); "Neo4j CE" (edition detail, not architectural term); "graph backend" (acceptable alias)

**community**: a cluster of densely-connected entities detected by Louvain (Neo4j GDS). Each community gets a hierarchical summary for global/topic QA. _Stage: P3 (not yet implemented)._
_Avoid_: "cluster" (too generic, used in embedding clustering too); "topic group" (implies manual curation)

### Pipeline

**ingest**: the write pipeline: validate → size check → chunk → embed → store. Exposed as MCP tool `ingest(input: {content, source_ref, metadata?, valid_from?, valid_until?}) → {chunk_ids}`. Stage 1: chunks-only. P0 adds: → extract triples → resolve entities → store graph.
_Avoid_: "index" (implies search-index building, not knowledge extraction); "import" (implies bulk file loading)

**retrieve**: the read pipeline: embed query → vector search with valid_window filter → return ranked chunks. Exposed as MCP tool `retrieve(input: {query, valid_at?, filters?, limit?}) → {chunks[]}`. Stage 1: vector-only. P1 adds: BM25 arm + graph traversal arm + hybrid fusion + rerank.
_Avoid_: "search" (too broad); "query" (the input is a query, the operation is retrieve); "recall" (one stage of retrieval, not the whole pipeline)

**extract_triples**: the P0 extraction pipeline: LLM schema-guided triple extraction from chunk text → confidence scoring → canonical entity resolution → store. Not yet an MCP tool (may be internal to ingest, or a separate async tool — TBD in P0 spec). _Stage: P0._
_Avoid_: "parse" (implies deterministic grammar, extraction is LLM-based); "NER" (NER is one sub-step, not the whole pipeline)

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
- **query → embedder → vector search → ranked chunks**: stage 1 retrieve path
- **query → hybrid retrieval (vector + BM25 + graph) → RRF fusion → rerank → top-K**: P1 retrieve path
- **valid_window + valid_at → temporal filter**: chunks/triples outside the query's time window are excluded
- **entity → Neo4j node; triple → Neo4j edge**: read-only projection of Postgres (P1 onward; P0 has no Neo4j connection — issue #3 D1, #7 Q3b)
- **community → Louvain → hierarchical summary**: P3 global QA path

## Flagged ambiguities

- **triple vs fact**: in iknow-memory, "triple" is the canonical term for (head, relation, tail). "Fact" is avoided because it is too generic in retrieval literature (bi-temporal claims in some systems, plain extracted assertions in others). If you must say "fact" in iknow-memory context, qualify it: "graph fact" or "temporal fact".
- **valid_window vs valid_at**: `valid_window` is a property of stored data (when is this true?); `valid_at` is a property of the query (when am I asking about?). The filter is `valid_window @> valid_at`.
- **Postgres authoritative, Neo4j read-only projection**: Postgres is the sole system of record for entities, triples, aliases, and (P0) extraction_records; Neo4j is a derived read-only projection. In P0 the server does not connect to Neo4j at all (issue #3 D1; #7 Q1 graph arm reads Postgres JOINs; #7 Q3b projection sync and #7 Q3c read-your-writes graduate to P1). The rationale for keeping Neo4j as a future projection is native graph node traversal (PPR, Louvain, node-level embedding); SQL JOIN and Apache AGE do not meet that constraint. Do not propose writing to Neo4j outside the projection path, or "just use Postgres for everything" without addressing that constraint.
- **rerank fail-open**: rerank failure returns the fused order unchanged. This is intentional — a dead reranker should not block retrieval. Do not add retry/fallback logic that changes this contract without explicit decision.
- **context engineering is NOT our job**: JIT retrieval triggers, cache breakpoint planning, prompt assembly, budget allocation — these belong to the host. iknow-memory returns ranked chunks; what the host does with them is the host's problem.

## Bootstrap mode

If this file only had template examples and no real project terms, seed via:

1. Read `src/core/types.ts` for storage vocabulary
2. Read `src/tools/ingest.ts` and `retrieve.ts` for tool contracts
4. Invoke `arthurpower:domain-modeling` to ratify new terms before adding them here
