# 0011. Community detection is hierarchical Leiden, not Louvain

Date: 2026-09-17
Status: accepted

Index-time **community** clustering on the entity-relation projection is **hierarchical Leiden** (GDS or equivalent), with default lcc-on, max community size 10 (tunable), and a fixed seed. Product Louvain (`gds.louvain.stream` as the C-layer algorithm, `specs/retrieve-community.md`) is superseded for detection. Summary **text** stays Postgres ledger (ADR-0001). PPR is unchanged. Aligns with the fin joint map (`specs/graph-index-standard-fast.md` in both repos).

Considered Options: keep Louvain as the only GDS community call; query-time clustering.
