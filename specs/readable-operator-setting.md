# Readable operator setting

Operator file: `setting.json` under the memory home (`IKNOW_MEMORY_HOME`, otherwise `~/.iknow-memory`).

This spec supersedes two sentences in `specs/config-effective-show.md`: "No YAML config" stays in force, and "Nested JSON is still rejected" does not. A flat string map of `GRAPHRAG_MEMORY_*` keys still loads. The file the operator edits is the nested document below.

## Document

One JSON object. A file is either that nested document or a flat `GRAPHRAG_MEMORY_*` string map. A mix of the two is `ConfigError` naming the file. An unknown section or field is `ConfigError` naming the path. A leaf that is not a string is `ConfigError` naming the path. Invalid JSON is `ConfigError` naming the file. A missing file is an empty map.

`${NAME}` is a whole-string placeholder. Any other use of `${` is `ConfigError` naming the path. `NAME` is looked up from process env, then from the same setting map. An unset name does not throw: the key stays unset, the same way an unset `*_API_KEY_ENV` pointer stays unset today.

Process env still wins over the file for the same registry key. `loadEnv` remains the only loader. Callers keep reading the existing registry names. Effect classes stay on those names (`restart`, `rotate`, `next-extraction`).

`show` and `list` do not print secret values. A `${NAME}` api key prints the name. A raw api key prints `configured` or `unset`. `layer=setting` when the value came from this file.

`iknow-memory-config set` and `unset` keep a nested file nested.

## Sections

Absent section means the file does not set those keys. Defaults and process env still apply.

```json
{
  "llm": {
    "extract": {
      "model": "MiniMax-M3.1-Flash-Preview",
      "baseUrl": "https://api.minimaxi.com/anthropic",
      "protocol": "anthropic",
      "apiKey": "${MINIMAX_API_KEY}"
    },
    "summary": {
      "model": "MiniMax-M3.1-Flash-Preview",
      "baseUrl": "https://api.minimaxi.com/anthropic",
      "protocol": "anthropic",
      "apiKey": "${MINIMAX_API_KEY}"
    },
    "rerank": {
      "model": "MiniMax-M3.1-Flash-Preview",
      "baseUrl": "https://api.minimaxi.com/anthropic",
      "protocol": "anthropic",
      "apiKey": "${MINIMAX_API_KEY}"
    }
  },
  "embed": {
    "model": "embedding-3",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "dimensions": "1536",
    "apiKey": "<existing secret>"
  },
  "jev": {
    "model": "jev-latest",
    "baseUrl": "https://api.typesafe.ai",
    "apiKey": "${JEV_API_KEY}"
  },
  "storage": "pgvector",
  "database": { "url": "<existing connection string>" },
  "elasticsearch": { "url": "http://localhost:9200" },
  "neo4j": {
    "uri": "bolt://localhost:7687",
    "user": "neo4j",
    "password": "<existing secret>"
  },
  "pgvector": { "annMaxDimensions": "2000" }
}
```

| Path | Registry name |
| --- | --- |
| `llm.extract.model` | `GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL` and `GRAPHRAG_MEMORY_ANTHROPIC_MODEL` |
| `llm.extract.baseUrl` | `GRAPHRAG_MEMORY_LLM_EXTRACT_BASE_URL` and `GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL` |
| `llm.extract.protocol` | `GRAPHRAG_MEMORY_LLM_EXTRACT_PROTOCOL` |
| `llm.extract.apiKey` `${NAME}` | `GRAPHRAG_MEMORY_LLM_EXTRACT_API_KEY_ENV` = `NAME` |
| `llm.extract.apiKey` raw string | `loadEnv().llm.extract.apiKey` is that string; `show` does not print it |
| `llm.summary.*` | `GRAPHRAG_MEMORY_LLM_SUMMARY_*` the same way |
| `llm.rerank.*` | `GRAPHRAG_MEMORY_LLM_RERANK_*` the same way; `${NAME}` also sets `GRAPHRAG_MEMORY_RERANK_API_KEY_ENV` |
| `embed.model` | `GRAPHRAG_MEMORY_EMBED_MODEL` |
| `embed.baseUrl` | `GRAPHRAG_MEMORY_EMBED_BASE_URL` |
| `embed.dimensions` | `GRAPHRAG_MEMORY_EMBED_DIMENSIONS` |
| `embed.apiKey` | `GRAPHRAG_MEMORY_EMBED_API_KEY` |
| `jev.model` | `GRAPHRAG_MEMORY_JEV_MODEL` |
| `jev.baseUrl` | `GRAPHRAG_MEMORY_JEV_BASE_URL` |
| `jev.apiKey` `${NAME}` | in-memory `GRAPHRAG_MEMORY_JEV_API_KEY` from that name; do not write the expanded secret back to disk |
| `jev.apiKey` raw string | `GRAPHRAG_MEMORY_JEV_API_KEY` |
| `storage` | `GRAPHRAG_MEMORY_STORAGE` |
| `database.url` | `GRAPHRAG_MEMORY_DB_URL` |
| `elasticsearch.url` | `GRAPHRAG_MEMORY_ES_URL` |
| `neo4j.uri` | `GRAPHRAG_MEMORY_NEO4J_URI` |
| `neo4j.user` | `GRAPHRAG_MEMORY_NEO4J_USER` |
| `neo4j.password` | `GRAPHRAG_MEMORY_NEO4J_PASSWORD` |
| `pgvector.annMaxDimensions` | `GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS` |

Retrieval weights, dashboard host and port, and Elasticsearch index names have no short names in this slice. A flat file can still set them.

## Live file

Rewrite `~/.iknow-memory/setting.json` into this document.

- `llm.extract.model`, `llm.summary.model`, and `llm.rerank.model` become `MiniMax-M3.1-Flash-Preview`.
- Every `llm.*.baseUrl` stays `https://api.minimaxi.com/anthropic`. Every `llm.*.protocol` stays `anthropic`. Every `llm.*.apiKey` stays `${MINIMAX_API_KEY}`.
- `jev.apiKey` is `${JEV_API_KEY}`. `jev.model` and `jev.baseUrl` stay `jev-latest` and `https://api.typesafe.ai`.
- Embed, database, Elasticsearch, Neo4j, storage, and `pgvector.annMaxDimensions` keep their current values, including secrets. Do not print those secrets.
- Do not restart MCP, dashboard, the index worker, or containers. Do not re-extract or rotate.

## Out of scope

YAML. Fin's section names. Changing the provider host to `https://api.minimax.cn/v1`. Editing `~/.bashrc`. Docker. Pushing `origin`. The unrelated dirty embedder batch on the main worktree.
