# 0001. Storage authority: Postgres authoritative, Neo4j read-only projection

Date: 2026-08-01
Status: accepted

## Context

The P0 foundation adds an entity + triple layer on top of stage 1's chunks-only ingest/retrieve. The shape-level question is which store owns the source of truth for entities / triples / entity_aliases (and the new extraction_records table): (A) Neo4j authoritative + Postgres holding only chunks/embeddings, or (B) Postgres authoritative + Neo4j as a read-only projection. Stage 1 has already hardened the Postgres/pgvector path; the daily query main battleground (temporal filtering, vector search, source filtering) all lives there. Only native multi-hop traversal (PPR, Louvain, node-level embedding) requires Neo4j.

## Decision

Postgres is the sole system of record for entities / triples / entity_aliases (and P0 extraction_records). Neo4j is a read-only projection — node shape `{id, canonical_name, type}` (no embedding); edge shape `{relation_norm, confidence, valid_from, valid_until}`; chunks do not enter the graph. In P0 the server does not connect to Neo4j at all; the projection sync mechanism (pre-selected outbox) and read-your-writes strategy graduate to P1.

## Consequences

- **Positive**: Single source of truth for writes, transactional, no double-write consistency problem in P0; pgvector's existing infrastructure (HNSW optional, tstzrange, GiST) is reused; build pipeline ships without Neo4j.
- **Trade-off**: P0 has no native multi-hop retrieval; the P1 cutover requires a full backfill from Postgres into Neo4j plus outbox + read-your-writes solutions (see Q3b/Q3c, P1 fog area).
- **Rejected alternative (A)**: Neo4j authoritative would impose a dual-write cost in P0 (entities/triples mirrored into Postgres and Neo4j on every write) even though the read path is pure Postgres for now — premature cost without payoff.

Evidence pointers: D1 (2026-08-01 HITL grilling); Q1, Q3b (2026-08-02).
