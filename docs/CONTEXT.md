# iknow-memory — 领域词汇表

> 本文件是 iknow-memory（外置知识记忆 MCP 服务）的**领域词汇 SSOT**. 仅 `domain-modeling` 技能可写; 其他技能只读消费.

---

## Language

### Product identity

**iknow-memory**: the standalone, host-agnostic knowledge memory MCP server. Stores, indexes, and retrieves semantic facts with temporal validity; exposes MCP tools (`ingest`, `push`, `invalidate`, `extract`, `retrieve`) over stdio. Does not assemble context, trigger retrieval, or manage conversation state — those are the host's job.
_Avoid_: "knowledge base" (implies curated documents, not extracted facts); "memory backend" (too generic)

**MCP tool**: a function exposed via Model Context Protocol (`tools/list` + `tools/call`). iknow-memory defines its own tool protocol — not constrained by any legacy tool contract.
_Avoid_: "tool" alone (ambiguous with host tools); "API endpoint" (MCP is not REST)

**host**: any MCP client that discovers and calls iknow-memory tools (Claude Code, iknow harness, custom agents). The host owns context engineering (JIT retrieval triggers, cache layout, prompt assembly). iknow-memory never reaches into the host.
_Avoid_: "client" (too generic); "consumer" (implies passive reading, hosts actively orchestrate)

### Memory units

**chunk**: pushed text is final text. fin is the sole chunking authority; iknow-memory stores and recalls the pushed text as-is without re-chunking, truncation, reassembly, or normalization/rewrite. Identified by UUID, carries `embedding`, `source_ref`, `metadata`, `valid_from`, `valid_until`, `created_at`. The atomic unit of vector storage and retrieval in stage 1; returned chunk text is byte-identical to the pushed text.
_Avoid_: "document" (a chunk is a slice, not a whole document); "passage" (implies semantic completeness); "segment" (ambiguous with context segments)

**entity**: a canonical real-world referent extracted from chunks (person, concept, system, event). Identified by UUID, carries `canonical_name`, `type`, `embedding`, `metadata`. Multiple surface forms (aliases) resolve to one entity. _Stage: P0 (implemented)._
_Avoid_: "node" (graph-generic, use only when discussing Neo4j topology); "concept" (one entity type, not the general term); "mention" (a mention is an occurrence, not the canonical entity)

**triple**: a directed typed edge `(head_entity, relation, tail_entity)` extracted from a chunk. Carries `confidence`, `source_chunk_id`, **evidence span** (`evidence_span`), `valid_window`, `created_at`. The atomic unit of graph knowledge. _Stage: P0 (implemented)._
_Avoid_: "fact" (too ambiguous in retrieval context; use "graph fact" / "temporal fact" if needed); "edge" (graph-generic, use only in Neo4j context); "link" (rule-based linkers do not produce typed edges)

**alias**: a surface-form string that resolves to a canonical entity (name variant, abbreviation, spelling). Stored in `entity_aliases` with `entity_id` foreign key. _Stage: P0 (implemented)._
_Avoid_: "synonym" (implies bidirectional equivalence); "variant" (one alias type, not the general term)

**canonical entity**: the merged, deduplicated entity that multiple aliases and mentions resolve to. P0 merging uses rule + embedding hybrid with hierarchical gating (zero LLM in P0; an LLM judge interface is reserved but not implemented — issue #6 Q3). The merge is the P0 "canonical entity resolution" deliverable. _Stage: P0 (implemented)._
_Avoid_: "master entity" (implies hierarchy); "root entity" (implies tree structure)

### Retrieval

**vector search**: cosine similarity over chunk embeddings, served by an index built in place on the existing Postgres vector extension — no longer brute-force scan, and no longer a future item. The configured dimension must sit within the index's dimension limit, and when the index cannot be built the process exits non-zero with a typed error instead of skipping silently. One capability called at two points — finding entities, and the fallback when the graph returns nothing — not two roles. Host ranking uses it when the **Neo4j graph arm** contributes nothing, and to fill remaining `limit` slots after graph hits; embed failure still fails the call.
_Avoid_: "semantic search" (too broad, includes BM25); "embedding search" (the search is over embeddings, not for them); "always-on third RRF vote" (graph-priority superseded three-arm voting); "brute-force scan" (retired shape — the index is a contract, not an optimization)

**BM25**: Okapi BM25 lexical ranking over tokenized chunk text, with k1 and b configurable. Production shape is now the Elasticsearch **precision layer**, which also supplies CJK segmentation, phrase queries, and field boosting; the earlier shape — Postgres ranking a generated `content_tsv` under the `simple` config, with MemoryBackend keeping a same-contract inverted index — is superseded. A retrieval arm that complements **vector search** by matching exact terms (query↔chunk lexical relevance — not chunker head/tail overlap); the two are partners, with no primary/standby switchover. Default on, configurable off, fail-open to vector-only. _Stage: implemented (#62); production shape re-decided by `specs/retrieval-stack.md` (C-1)._
_Avoid_: "keyword search" (BM25 is ranked, not boolean); "lexical search" (acceptable alias but BM25 is more precise); "Postgres tsvector ranking" (superseded production shape)

**precision layer**: the lexical capability layer that carries CJK segmentation, Okapi BM25 (k1 / b configurable), phrase queries, and field boosting as one unit, delivered by Elasticsearch. Present at both the entity-finding stage and the fallback stage; it complements **vector search** rather than standing by for it, so there is no primary/standby switchover between the two. _Stage: `specs/retrieval-stack.md` (定档 B)._
_Avoid_: "BM25 layer" (BM25 is one capability inside it); "keyword arm" (the layer is not a single recall arm); "backup arm" (not a standby for vector search)

**authoritative source**: Postgres, holding the sole authoritative copy of chunk text and its metadata. Retrieval indexes are built from it and never the reverse, so no index rebuild can change authoritative data. _Stage: ADR-0001; extended to retrieval indexes by ADR-0003._
_Avoid_: "primary database" (implies a replication topology); "system of record table" (the term covers the whole store, not one table); "master" (replication vocabulary)

**derived index**: a retrieval index — the vector index and the lexical index — built from the **authoritative source**. Deletable and re-builtable from that source; a rebuild leaves authoritative data untouched and must not regress retrieval quality. _Stage: ADR-0003._
_Avoid_: "cache" (a rebuild does not depend on missed reads); "replica" (no replication protocol involved); "projection" (reserved for the Neo4j read-only projection)

**hybrid retrieval**: production Host ranking is graph-priority (`specs/retrieve-graph-priority.md`): non-empty **Neo4j graph arm** hits occupy the front of `chunks[]`; remaining `limit` slots (and the whole list when the graph arm contributes nothing) are vector+BM25 **RRF fusion (k=60)**. Weights 0.7 / 0.15 apply to that vector+BM25 RRF only — `w_graph` does not vote against vector; default-on graph/rerank missing deps refuse boot (ADR-0006); other default-on gaps and attempted failures follow **degraded=true**; empty hits and explicit caller switches do not; optional later steps are **rerank**, **neighbor evidence**, entity-embedding seeds, and community-summary hits. _Stage: graph-priority on main (PR #94); default-on capability gaps and failures follow the four-rule **degraded=true** authority (#165)._
_Avoid_: "fusion search" (ambiguous); "three-arm RRF" (retired production ranking); "multi-signal search" (too vague)

**graph arm**: the archived Postgres SQL one-hop recall path (seed entities → one-hop triples with `valid_window @> valid_at` → chunks via `source_chunk_id`). Code and ledger retained; default server wiring never supplies `graphConfig`. Not a product transition bridge — see `docs/runbooks/sql-graph-arm-archived.md`. #70 does not reverse the archive: it adds the separate **Neo4j graph arm** and leaves `graphConfig` absent from `buildRetrieveDeps`, so the two arms are distinct code paths reached by distinct keys — `graphConfig` (test-injected only) vs `graphRanker` (production). Re-enabling this one is still a spec decision. _Stage: **archived off production** (#58 / #62); still archived after #70._
_Avoid_: "graph search" (too broad); "Neo4j graph arm" (different term — true PPR path); "deleted" / "removed" (archived, not deleted)

**Neo4j graph arm**: the production true-graph recall path: query embedding → entity seeds → Neo4j GDS **PPR** (`gds.graph.project` → `gds.pageRank.stream`) → map entities back to chunks via Postgres `source_chunk_id` (chunks never enter Neo4j). Non-empty hits lead Host ranking; empty hits are not `degraded` and ranking falls back to vector+BM25 RRF. Default on; a missing URI refuses process start when `graphEnabled` is on (ADR-0006). Configured failure at retrieve time fail-open with `degraded=true`. Explicit `graphEnabled=false` starts without Neo4j and does not set `degraded` for that switch. No LangGraph. Operating it: `docs/runbooks/neo4j-projection.md`. _Stage: PPR arm + graph-priority Host order on main._
_Avoid_: "graph arm" alone (that name is the archived SQL path); "third RRF arm" (retired ranking); "LangGraph" (wrong layer)

**projection outbox**: the transactional intent log written in the same Postgres transaction as ledger entity/triple changes (extract CLI), later drained by a projector into Neo4j. Enables eventually-consistent read-only projection without dual-writing Neo4j inside the SoR transaction. Paired with a full backfill/reconcile for empty graphs. Concretely the `projection_outbox` table (`subject_kind` CHECKed to `entity`/`triple`, so "chunks never enter the graph" is a database invariant), drained by `npm run graph:drain`. An intent names a subject, never a snapshot: the drain re-reads Postgres, so intents need no ordering rule and a re-drain cannot push a stale value. _Stage: locked (#69); on main via #77 — outbox emit on the extract path, backfill/reconcile CLI, projector drain._
_Avoid_: "CDC" (acceptable mechanism class, but the locked choice is outbox); "dual-write" (forbidden product pattern — Neo4j is not a second SoR); "event bus" (too generic)

**RRF fusion (k=60)**: Reciprocal Rank Fusion with constant k=60; rank-based — no cross-arm score calibration. Production uses it for **vector + BM25** (fallback when the Neo4j graph arm contributes nothing, and remainder fill after graph hits). It does not fuse graph hits against vector as equal votes. Ties break by arm order (vector, then bm25) then id. _Stage: implemented (#62); graph-as-third-vote retired (#89 / `specs/retrieve-graph-priority.md`)._
_Avoid_: "score fusion" (RRF is rank-based); "three-arm RRF" (retired Host ranking); "merging results" (ambiguous with entity merge)

**degraded=true**: the additive-optional envelope flag on the `retrieve` JSON payload, set by four rules and nothing else: (1) a capability that is on by default could not be attempted because credentials or an address are missing → set — **except graph and rerank**, which refuse process start instead (ADR-0006); (2) an attempted capability failed → set; (3) a capability was attempted and found no hits → **not** set; (4) a capability the caller explicitly switched off → **not** set. Rule 1 supersedes the earlier "missing Neo4j URI does not degrade" for capabilities that still start; graph/rerank missing deps never reach retrieve. Rules 3 and 4 preserve the earlier "found nothing" and "switched off" behavior. Each set names the capability in `degraded_reasons`; invalid caller input is not a capability failure and must not set it. This entry is the sole authority for the set rules wherever another entry states them differently. _Stage: P0, extended to BM25 in #62; four-rule form is `specs/retrieval-stack.md` §B3; graph/rerank boot is ADR-0006 / `specs/graph-rerank-boot-and-evidence.md`._
_Avoid_: "error flag" (a degraded response is a valid response, not an error); "fallback flag" (`degraded` is not the graph-empty ranking fork)

**RetrieveConfig**: the frozen-on-read retrieval config object including `{w_vec, w_bm25, w_graph, bm25Enabled, graphEnabled, …}` loaded via `GraphragEnv` (`ConfigError` on invalid values). `w_vec` / `w_bm25` fuse vector+BM25 RRF on fallback and remainder fill; `w_graph` does not vote against vector under graph-priority ranking. `graphEnabled` and `rerankEnabled` default on; on plus missing deps is `ConfigError` at `loadEnv()` (ADR-0006). Changing defaults post-Bootstrap is Ask-first. _Stage: env shape from #62/#69; ranking semantics `specs/retrieve-graph-priority.md`; boot contract `specs/graph-rerank-boot-and-evidence.md`._
_Avoid_: "retrieval settings" (vague); "0.7/0.15/0.15 three-arm weights" (retired Host ranking)

**embedding credentials**: the canonical embedding secret is `GRAPHRAG_MEMORY_EMBED_API_KEY`; the preferred vector alias is `GRAPHRAG_MEMORY_VECTOR_API_KEY`; `GRAPHRAG_MEMORY_ANTHROPIC_API_KEY` is a legacy vector alias; the indirect `GRAPHRAG_MEMORY_EMBED_API_KEY_ENV` form remains supported. They are embedding credentials, never the LLM secret; missing credentials leave the default-on vector capability unattempted, so `retrieve` reports `degraded` with a vector reason instead of using pseudo-vectors. _Stage: provider-agnostic embedding aliases and missing-credential degraded behavior on main (#165)._
_Avoid_: treating `GRAPHRAG_MEMORY_ANTHROPIC_API_KEY` as the LLM token (`ANTHROPIC_AUTH_TOKEN` is the LLM secret); "Anthropic API key" unqualified (ambiguous between vector alias and LLM token)

**rerank**: a post-ranking permutation of retrieve `chunks[]` before Host `limit`; on main, slice 0 uses the Anthropic **main model** with default MiniMax-M3 on China `https://api.minimaxi.com/anthropic` and LLM secret `ANTHROPIC_AUTH_TOKEN`, is **default on**; missing production rerank deps refuse process start (ADR-0006); an LLM or HTTP failure at retrieve time fails open and sets `degraded`. Slice 1 (`specs/retrieve-graph-quality.md`) is a dedicated HTTP reranker behind the same hook with default on; it is not the Host chat model. _Stage: default-on temporary Anthropic LLM rerank on main (#165); dedicated HTTP reranker remains the later quality-stack slice; spec/plan slice 0: `specs/retrieve-rerank-llm.md`._
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

**Neo4j sidecar**: graph engine deployed alongside the MCP server for native multi-hop traversal (PPR first; Louvain / node-level embedding later); a read-only projection of Postgres-authoritative entities/triples, never a system of record (ADR-0001 / issue #3 D1). Sync mechanism locked as transactional **projection outbox** + full backfill (#69; #7 Q3b). SQL JOIN and Apache AGE do not meet the native-traversal constraint, hence the sidecar. When **RetrieveConfig** `graphEnabled` is on (the default), missing Neo4j URI or credentials refuse process start (`ConfigError`, ADR-0006); explicit off allows start without a sidecar. Ingest does not require Neo4j. _Stage: morphology locked (#69); on main via #77 (Neo4j CE + GDS over Bolt)._
_Avoid_: "graph database" (too generic); "Neo4j CE" (edition detail, not architectural term); "graph backend" (acceptable alias)

**community**: a cluster of densely-connected entities detected by Louvain (Neo4j GDS). Each community gets a ledger-stored summary; retrieve may return those summaries as Host `chunks[]` when the **mode bundle** enables topic retrieve. Map-reduce of a final answer stays on the **host**. _Stage: locked in `specs/retrieve-graph-quality.md`; not yet implemented._
_Avoid_: "cluster" (too generic, used in embedding clustering too); "topic group" (implies manual curation)

### Pipeline

**ingest**: the write pipeline for final pushed text: validate → size check → embed → store as-is. Pushed text is final text; fin is the sole chunking authority, and iknow-memory does not re-chunk, truncate, reassemble, or normalize/rewrite it. Exposed as MCP tool `ingest` (content + `source_ref`, optional metadata / validity → `{chunk_ids}`). Does not invalidate and does not run **extract_triples**.
_Avoid_: "index" (implies search-index building, not knowledge extraction); "import" (implies bulk file loading)

**push**: the strict MCP write tool: every item requires metadata and a validity window; the idempotency key is `(source_ref, content identity)`; a re-push returns the same **chunk** ids without growing rows. Distinct from **ingest** (optional fields). Does not run **extract_triples**.
_Avoid_: "upsert" (the guarantee is idempotent push, not the SQL verb); "fin port" (any Host may call it)

**ingest idempotency**: the guarantee that repeated pushes of the same idempotency key — (`source_ref`, content identity, where content identity hashes chunk text plus the normalization / parsing-rule / parameter versions) — produce no second write and return the same **chunk** ids. A failed push is returned by name and is not counted against the idempotency assertion. _Stage: `specs/retrieval-stack.md` (C-9)._
_Avoid_: "upsert" (idempotency is a result contract, not the SQL mechanism); "dedupe" (implies removing a duplicate after the fact); "at-least-once ingest" (transport property, not the guarantee)

**content invalidation**: the action that closes a **chunk**'s `valid_window` so the content stops matching any query time. Exposed as MCP tool `invalidate`. It never physically deletes the row, is repeatable, and leaves a queryable invalidation record (chunk id, invalidation instant, triggering party). Not an `ingest` action. _Stage: `specs/retrieval-stack.md` (C-9); MCP name `specs/mcp-tool-surface.md`._
_Avoid_: "delete" (the row stays); "expire" (a scheduled TTL, not a change-triggered close); "tombstone" (no marker row replaces the chunk)

**retrieve**: the read pipeline: embed query once → entity seeds + Neo4j **PPR** (when configured) mapping to chunks via `source_chunk_id` → non-empty graph hits lead Host `chunks[]`, else (and remainder slots) vector ∥ BM25 → **RRF fusion** → optional entity-embedding seeds / community-summary hits → optional **rerank** (slice 0 temporary Anthropic on main, default on; dedicated HTTP later) → optional **neighbor evidence** → top-K, with default-on graph/rerank missing deps refusing boot (ADR-0006) and other gaps or retrieve-time failures surfaced through `degraded` and `degraded_reasons`. Optional drain wait is default off; exposed as MCP tool `retrieve(input: {query, valid_at?, filters?, limit?}) → {chunks[]}`; wire stays `{ chunks[] }` (+ optional `degraded` / `degraded_reasons`). Host `chunks[]` does not carry **evidence span**. _Stage: graph-priority + default-on rerank + ADR-0006 boot on `specs/graph-rerank-boot-and-evidence.md`; later steps `specs/retrieve-graph-quality.md`._
_Avoid_: "search" (too broad); "three-arm retrieve" (retired ranking); "recall" (one stage, not the whole pipeline)

**extract_triples**: the P0 extraction pipeline: LLM schema-guided triple extraction from chunk text → confidence scoring → canonical entity resolution → store. Exposed as MCP tool `extract` (`chunk_ids` xor `source_ref`, synchronous, **mark-and-continue**) and as the extract CLI. CLI-only: `--dry-run`, `--list-failed`, `--list-unmapped`, `--backfill-embeddings`. Not folded into **ingest** or **push**. _Stage: CLI on main; MCP `extract` is `specs/mcp-tool-surface.md`._
_Avoid_: "parse" (implies deterministic grammar, extraction is LLM-based); "NER" (NER is one sub-step, not the whole pipeline)

**embedding backfill**: the idempotent NULL-embedding repair mode (CLI flag `--backfill-embeddings`) that embeds and UPDATEs every live entity row `WHERE embedding IS NULL` using the stored description; an immediate second run updates 0 rows. Never runs automatically inside a normal extraction run. _Stage: P0 (implemented per `specs/p0-wiring-closure.md`)._
_Avoid_: "re-embed" (backfill never overwrites an existing embedding); "migration" (repeatable repair, not a one-shot schema change)

### Extraction & merge

**evidence span**: the model-proposed substring of **chunk** text that grounds one **triple**. Persist requires a non-empty span contained in that chunk; the value is stored as `triples.evidence_span` and is not returned on Host `retrieve` `chunks[]`.
_Avoid_: "citation" (Host UI); "source_ref" (chunk provenance); "chunk text" (the whole chunk)

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

**P@5 / R@5**: precision and recall at rank 5 over the Host-visible `chunks[]` after graph-priority ranking (graph hits first when present, else vector+BM25 RRF); gold is query → relevant chunk ids; the published ruler is the default-on graph+rerank path unless env explicitly offs a switch (`specs/graph-rerank-boot-and-evidence.md`); Bootstrap records numbers only (no CI fail-on-drop). Operated by `npm run eval:retrieve` through `assembleRetrievalResult` using the same `loadEnv()` as the server, baseline `eval/baseline/retrieve-p5.json`. Separate from **extraction F1** (#15 postponed). _Stage: harness on main (#80/#82); boot/eval contract `specs/graph-rerank-boot-and-evidence.md`._
_Avoid_: "hit rate" (ambiguous); "three-arm fused P@5" (retired ranking); "extraction F1" (different layer)

**ablation**: the evaluation method of switching off exactly one capability at a time and comparing against the all-on and all-off baselines, reporting both percentage and absolute differences. Turning a capability off is itself visible — it sets `degraded` and names the item — and that is expected output of the run, not a silent behavior change. _Stage: `specs/retrieval-stack.md` (§B1 / §B4)._
_Avoid_: "sensitivity analysis" (too broad); "A/B test" (no traffic split); "feature flag sweep" (the point is measurement, not toggling)

**concurrency benchmark**: a repeatable entry point that runs a fixed concurrency level, duration, and read/write ratio, then reports error count and latency percentiles (p50 / p95 / p99) against fixed thresholds. Warm-up requests are excluded; the numbers are a gate, not a capacity exploration. _Stage: `specs/retrieval-stack.md` (§B1)._
_Avoid_: "load test" (implies capacity discovery); "stress test" (we do not push to the breaking point); "soak test" (duration is fixed and short)

## Relationships

- **content → chunker → chunk[]**: fin's chunker produces the final pushed text; pushed text is final text, and iknow-memory stores and recalls each pushed chunk as-is without any ingest-side re-chunking
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
- **rerank fail-open**: rerank failure returns the pre-rerank Host order unchanged (graph-priority list, or vector+BM25 RRF). A dead reranker must not block retrieval — but the response must still carry `degraded` and name the rerank item in `degraded_reasons`. Do not add retry/fallback logic that changes this contract without explicit decision.
- **graph-priority vs three-arm RRF**: Host ranking is graph-priority (`specs/retrieve-graph-priority.md`). Do not describe production retrieve as vector+BM25+graph RRF at 0.7/0.15/0.15.
- **context engineering is NOT our job**: JIT retrieval triggers, cache breakpoint planning, prompt assembly, budget allocation — these belong to the host. iknow-memory returns ranked chunks; what the host does with them is the host's problem.
- **zero external runtime dependency on any reference implementation**: design decisions (RRF k=60, cosine re-score 0.7/0.3, rerank fail-open, PPR) are first-class product choices documented in CONTEXT.md and PRDs; rationale is independent of any particular reference codebase. Any locally tracked upstream reference directory is read-only and not linked at runtime (zero import/link/symlink/dynamic load). We implement from first principles, not by copying.

## Bootstrap mode

If this file only had template examples and no real project terms, seed via:

1. Read `src/core/types.ts` for storage vocabulary
2. Read `src/tools/ingest.ts` and `retrieve.ts` for tool contracts
3. Read each module's local README / header comment for that capability area's gap vocabulary
4. Invoke `arthurpower:domain-modeling` to ratify new terms before adding them here
