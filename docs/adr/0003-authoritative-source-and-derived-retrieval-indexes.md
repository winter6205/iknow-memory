# 0003. Separate the authoritative source from derived retrieval indexes; keep the vector store upgradeable

Date: 2026-08-31
Status: accepted; superseded-by ADR-0010 §text SoR only

Postgres is the **authoritative source**, and every retrieval index — the vector index and the lexical index — is a **derived index** that can be deleted and rebuilt from it, with a rebuild that never touches authoritative data. Because that split is explicit, moving the vector index to a dedicated vector store later (when scale reaches the tens of millions) is a self-contained action that leaves the already-built **precision layer** untouched. ADR-0001 is unchanged; this extends its "derived, rebuildable" rule from the Neo4j projection to retrieval indexes.
