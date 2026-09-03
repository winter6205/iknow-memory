# Spec: BM25 Retrieve + SQL Graph-Arm Cleanup

> **Archived 2026-09-03.** This spec has been moved to
> [`docs/archive/bm25-retrieve.md`](../docs/archive/bm25-retrieve.md) — it is
> kept here only as a path-stable pointer for older links.
>
> The production lexical carrier has moved from the Postgres `simple` FTS
> shape described here to the Elasticsearch **precision layer**. The
> active contract for that work is now
> [`specs/es-precision-layer.md`](es-precision-layer.md), with execution
> tracked in [`plans/es-precision-layer.md`](../plans/es-precision-layer.md).
> The SQL one-hop graph arm referenced in this spec was separately retired
> by [`docs/runbooks/sql-graph-arm-archived.md`](../docs/runbooks/sql-graph-arm-archived.md).
>
> For the rationale and history (C-1 supersession, ADR-0003 derived-index
> rule, BM25 fail-open semantics, MemoryBackend parity), read the archived
> copy; do not treat this file as the live source of truth.
