# iknow-memory

An MCP memory service for agent hosts. It stores source content and retrieves it
with hybrid search and validity-time filtering.

## Capabilities

- Combines vector search and Elasticsearch BM25 with Neo4j PPR graph ranking.
- Extracts relation triples and resolves canonical entities.
- Retrieves content for a requested `valid_at` time and supports source invalidation.
- Reads bounded source slices and supports persistent index jobs.
- Uses MiniMax over Anthropic-compatible HTTP for default reranking. `GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL` configures a dedicated rerank sidecar.
- Leaves context assembly to the host.

## Requirements

- Node.js 20 or later.
- For the default retrieval setup: PostgreSQL with pgvector, Neo4j with Graph
  Data Science (GDS), and Elasticsearch 8.x with `analysis-ik` at the same patch
  version.
- An embedding API credential and MiniMax credentials for the default LLM reranker.
- Docker Compose to run the repository's local backend stack.

Graph retrieval, reranking, and Elasticsearch lexical retrieval are enabled by
default. The Compose stack starts the backend services; run the MCP server on
the host. See [local infrastructure](docs/runbooks/local-infra.md) and
[MCP configuration](docs/mcp-config.md) for service and credential setup.

## Quick start

```bash
git clone https://github.com/winter6205/iknow-memory.git
cd iknow-memory
docker compose up -d --wait
cp .env.example .env.local
```

Edit `.env.local` to add your embedding and MiniMax API credentials. The copied
connection settings match the local Compose services. See [MCP configuration](docs/mcp-config.md)
for supported environment variables and credential options.

Install dependencies and build the server:

```bash
npm install
npm run build
```

To run the stdio server directly from the repository root:

```bash
npm start
```

To let an MCP host start it, add this entry to the host's MCP configuration and
replace the path with the absolute path to your clone:

```json
{
  "mcpServers": {
    "iknow-memory": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/iknow-memory"
    }
  }
}
```

The server loads `.env.local` relative to `cwd`. Keep credentials in `.env.local` or the host's environment rather than in a shared MCP configuration.

## MCP tools

| Tool | Input | Purpose |
| --- | --- | --- |
| `ingest` | `{content, source_ref, metadata?, valid_from?, valid_until?}` | Store and index source content. |
| `push` | Same input as `ingest` | Store content through the host push entry point. |
| `invalidate` | `{source_ref, triggered_by, invalidated_at?}` | Close a source's validity window. |
| `extract` | Exactly one of `{chunk_ids}` or `{source_ref}` | Extract relation triples and resolve entities. |
| `retrieve` | `{query, valid_at?, filters?, limit?}` | Retrieve matching content, optionally at a specified valid time. |
| `read_source` | Exactly one of `source_ref` or `id`, plus optional `position` | Read a bounded source slice and continue with `next_position`. |
| `submit_index_job` | `{source_ref, content_identity}` | Persist an indexing job and return its job ID. |
| `poll_index_job` | `{job_id}` | Read job status and community-index readiness as separate states. |

Index jobs run in a separate worker; submitting a job does not process it inline. After building the server, start the worker from the repository root with:

```bash
npm run index:worker
```

## Dashboard

Start the dashboard and API together:

```bash
npm run dashboard
```

The UI is served at `http://127.0.0.1:18868/`; the API binds to
`127.0.0.1:4174` by default. Set `GRAPHRAG_MEMORY_DASHBOARD_PORT` to change
the API port; it must differ from `18868`. The command installs dashboard
dependencies if Vite is missing.

Without storage settings, the dashboard uses an empty in-memory store. To view
PostgreSQL data, set `GRAPHRAG_MEMORY_STORAGE=pgvector` and
`GRAPHRAG_MEMORY_DB_URL` in `.env.local` alongside the required backend
settings above; graph views also require Neo4j. See the
[dashboard specification](specs/iknow-memory-dashboard.md).

## Development

```bash
npm run dev
npm test
npm run typecheck
```

Setup and operations: [MCP configuration](docs/mcp-config.md), [local infrastructure](docs/runbooks/local-infra.md), and [Elasticsearch precision layer](docs/runbooks/es-precision-layer.md).

## Acknowledgments

Design references are listed in [ATTRIBUTION.md](ATTRIBUTION.md).

## License

Licensed under the [MIT License](LICENSE).
