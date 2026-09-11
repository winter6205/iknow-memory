# 0007. Elasticsearch missing address refuses process start

Date: 2026-09-11
Status: accepted

`GRAPHRAG_MEMORY_ES_URL` is the Elasticsearch connection address in global `GraphragEnv` / Host MCP `env` — not a product feature switch and not a setting on Postgres or Neo4j. A default-on **precision layer** with no address must not start: `loadEnv()` throws `ConfigError`. Explicit off is the test/escape hatch only, same shape as `graphEnabled=false`. A configured ES that fails at retrieve time still fail-opens with `degraded=true`; vector and the **Neo4j graph arm** keep answering.

This supersedes the Elasticsearch exception in ADR-0006 and the “Elasticsearch still follows ADR-0005 rule 1” clause in ADR-0005 rule 1. Named-entity graph seeds stay on the ES entity index (`canonical_name` / `aliases`); a second ledger lexical seed path is out.

**Does not decide:** changing ES query/boost internals; node-embedding fail-start.
