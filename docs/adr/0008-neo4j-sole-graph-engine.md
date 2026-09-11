# 0008. Neo4j is the only engine that satisfies the graph capability

Date: 2026-09-11
Status: accepted

iknow-memory is a graph-database-first service. The production graph capability is the **Neo4j graph arm** only. A Postgres-ledger PPR (or any revival of the archived SQL **graph arm**) must not satisfy ADR-0006 fail-start and must not be selectable as a second production graph engine. ADR-0001 still holds: Postgres is the authoritative source; Neo4j is the read-only projection that exists for native traversal (PPR / Louvain / later).

When a configured Neo4j fails at retrieve time, the arm fail-opens and **vector search** (plus the **precision layer** when that call succeeds) still answers with `degraded=true`. That already-shipped path is the “graph is down, retrieval continues” contract. It is not a reason to implement a ledger graph engine so a process can claim graph-ready without Neo4j.

**Rejected:** treating “either engine satisfies graph” as a product boundary (PR #217 shape).
