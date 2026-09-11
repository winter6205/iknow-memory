# 0006. Graph and rerank missing deps refuse process start

Date: 2026-09-05
Status: accepted; superseded-by ADR-0007 Elasticsearch exception only

Default-on **graph** and **rerank** (`RetrieveConfig.graphEnabled` / `rerankEnabled`, unset = on) cannot be attempted without credentials or an address. Unlike ADR-0005 rule 1, the process must not start: `loadEnv()` throws `ConfigError`. Explicit off is the only way to boot without those deps. Vector and BM25 keep ADR-0005 rule 1 (start + `degraded` / skip as already specified). Elasticsearch no longer follows that skip: missing `GRAPHRAG_MEMORY_ES_URL` is ADR-0007 fail-start. Retrieve-time failure of a configured graph or reranker still follows ADR-0005 rule 2 (fail-open + `degraded`). Eval CLIs that call `loadEnv()` share this contract; they must not hardcode the switches off. The graph capability is satisfied only by Neo4j (ADR-0008).

**Why not keep rule 1 for graph/rerank:** a server that answers without a sidecar while advertising default-on graph/rerank looks healthy and is not. Fail-start makes the operator gap visible before the first `retrieve`.

**Does not decide:** node-embedding or wait-for-drain fail-start.
