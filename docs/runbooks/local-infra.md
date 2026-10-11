# Local infrastructure (Docker Compose)

**Purpose:** one command to bring up the heavy dependencies on a new machine.
**Does not** run the TypeScript MCP server. iknow-memory stays on the host
(`npm install && npm start` / stdio MCP). There is no Dockerfile for the Node
app and `docker-compose.yml` must stay infra-only.

Postgres remains the authoritative ledger (ADR-0001). Neo4j is the GDS
projection the PPR graph arm reads. Elasticsearch is the precision layer
(ADR-0007). Compose makes those addresses easy to point at; it does **not**
change fail-start. A host process with graph / rerank / precision-layer still
on (the defaults) refuses to boot without the matching URI / secret / ES
address (ADR-0006 / ADR-0007).

CI: `.github/workflows/test.yml` job `test-es` builds only the
`elasticsearch` compose service (`--no-deps`) from this repository
compose file and runs `tests/integration/bm25-pg.test.ts` so the
precision layer cannot loud-skip on PR/main (`CI=true` turns an
unreachable probe into a failed job, not `describe.skip`). That job
reaches Elasticsearch at `http://127.0.0.1:9201`. Nightly `test-full`
starts the same ES service on host port `9201` alongside the Postgres
workflow service on `5432` (the workflow service, not this compose
Postgres).

## Start

From the repo root:

```bash
docker compose up -d --wait
```

`--wait` blocks until the healthchecks pass (Postgres ready, Neo4j Bolt
accepts `RETURN 1`, Elasticsearch cluster at least yellow).

Without `--wait`, `docker compose up -d` still starts the same three services;
poll `docker compose ps` until each is `healthy`.

Linux hosts that have never run Elasticsearch may need:

```bash
sudo sysctl -w vm.max_map_count=262144
```

Persist that under `/etc/sysctl.d/` if the kernel resets it on reboot.

Stop / wipe:

```bash
docker compose down          # keep named volumes
docker compose down -v       # destroy local data
```

## Published ports and dev credentials

These values are committed on purpose for local use. Change them before any
shared or production host. No API keys live in the compose file or images.

| Service                         | Image / build                                    | Port(s)                      | Dev credential                                  |
| ------------------------------- | ------------------------------------------------ | ---------------------------- | ----------------------------------------------- |
| Postgres + pgvector             | `pgvector/pgvector:pg16` (same family as CI)     | `5433`                       | user/db `iknow_memory`, password `iknow_memory` |
| Neo4j + GDS                     | `docker/neo4j` → `5.26.0` + baked GDS `2.13.2`   | `7688` (Bolt), `7475` (HTTP) | user `neo4j`, password `iknow-memory-dev`       |
| Elasticsearch 8.x + analysis-ik | `docker/elasticsearch` → `8.19.20` + matching IK | `9201`                       | security off (no user / API key)                |

`CREATE EXTENSION vector` is created by the host app on first schema bootstrap;
you do not need a separate migration.

## Dev stack and the production template

`docker-compose.yml` is the dev stack. Compose project name
`iknow-memory-dev`. Container names `iknow-memory-dev-postgres`,
`iknow-memory-dev-neo4j`, and `iknow-memory-dev-es`. Host ports `5433`
(Postgres), `7475` (Neo4j HTTP), `7688` (Neo4j Bolt), and `9201`
(Elasticsearch). Its volumes are not external and are not named
`iknow-memory-pg`, `iknow-memory-es`, or `iknow-memory-neo4j`.

`docker-compose.production.yml` is the production template. Compose project
name `iknow-memory`. Container names stay `iknow-memory-postgres`,
`iknow-memory-neo4j`, and `iknow-memory-es`. Host ports stay `5432`,
`7474`, `7687`, and `9200`. Volumes are `external: true` with names
`iknow-memory-pg`, `iknow-memory-es`, and `iknow-memory-neo4j`.

An operator copies `docker-compose.production.yml` to
`~/.iknow-memory/compose/`. This change does not apply that file: it does
not copy it into the home directory and it does not start, stop, or
recreate containers.

The dev stack publishes different host ports from the production containers,
so both can be running. `scripts/neo4j.sh` remains the no-Docker path and
listens on `7687`; the dev compose Bolt port is `7688`.

Dev compose volumes start empty. Re-populate the ledger with `ingest` /
`push`.

## Host MCP / `.env.local` pointing at compose

Copy `.env.example` → `.env.local` and fill embedding / rerank API keys. The
connection block already matches compose. Host MCP and `loadEnv()` read this
file directly. Vitest does **not** inject non-`VITE_` keys into `process.env`;
Postgres suites resolve `GRAPHRAG_MEMORY_DB_URL` through
`tests/integration/pg-test-harness.ts` (process env wins; an explicit empty
pin does not fall through to the file).

```bash
GRAPHRAG_MEMORY_STORAGE=pgvector
GRAPHRAG_MEMORY_DB_URL=postgresql://iknow_memory:iknow_memory@localhost:5433/iknow_memory
GRAPHRAG_MEMORY_NEO4J_URI=bolt://localhost:7688
GRAPHRAG_MEMORY_NEO4J_USER=neo4j
GRAPHRAG_MEMORY_NEO4J_PASSWORD=iknow-memory-dev
GRAPHRAG_MEMORY_ES_URL=http://localhost:9201
```

Then on the **host** (not in a container):

```bash
npm install
npm run build
npm start          # stdio MCP
```

Host MCP JSON uses the same env names (`docs/mcp-config.md`). Production
secrets stay in the host secret store — do not copy compose passwords into a
shared MCP config.

After the ledger has entities/triples, project the graph:

```bash
npm run graph:backfill
npm run graph:drain
```

## Neo4j: compose vs `scripts/neo4j.sh`

| Path                                                           | When                                                                         | Auth                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `docker compose up` (this runbook)                             | Docker is available; common local/dev case                                   | `neo4j` / `iknow-memory-dev` — set URI **and** USER/PASSWORD together                               |
| `bash scripts/neo4j.sh install && bash scripts/neo4j.sh start` | No Docker, or Cloud Agent snapshot (`cursor-install.sh` / `cursor-start.sh`) | Auth **disabled**, listener on `127.0.0.1` — `eval "$(bash scripts/neo4j.sh env)"` exports URI only |

Dev compose publishes Bolt on `7688`. `scripts/neo4j.sh` listens on `7687`. Do not bind both to the same host port. Both ship GDS so
`gds.pageRank.stream` works. Version pin: Neo4j `5.26.0`, GDS `2.13.2`
(compose bakes the jar; `scripts/neo4j.sh` unpacks the same zip).

## Elasticsearch: compose vs the manual `docker run`

Compose is the happy path: the image in `docker/elasticsearch/Dockerfile`
installs `analysis-ik` at the **same 8.x patch** as the cluster (`8.19.20`).
The precision-layer runbook still documents a one-off `docker run` plus
`elasticsearch-plugin install` for triage outside this repo compose —
`docs/runbooks/es-precision-layer.md`.

Sanity check after `--wait`:

```bash
curl -fsS http://localhost:9201
docker compose exec elasticsearch bin/elasticsearch-plugin list | grep -i analysis-ik
curl -fsS -X POST "http://localhost:9201/_analyze" \
  -H "Content-Type: application/json" \
  -d '{"analyzer":"ik_smart","text":"中华人民共和国国歌"}'
```

A continuous Chinese string must tokenize into **≥ 2** tokens. One token
means IK is not loaded.

## Fail-start reminder

Compose being healthy is not a substitute for host env:

- Graph default-on + missing `GRAPHRAG_MEMORY_NEO4J_URI` → process refuses start (ADR-0006).
- Precision layer default-on + missing `GRAPHRAG_MEMORY_ES_URL` → process refuses start (ADR-0007).
- Rerank default-on + no MiniMax/Anthropic secret and no `GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL` → process refuses start (ADR-0006).

Explicit `GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED=false` /
`GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false` /
`GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED=false` remain test/escape hatches,
not the product story.

## See also

- `.env.example` — compose-aligned connection block + embedding / rerank notes.
- `docs/mcp-config.md` — host MCP JSON.
- `docs/runbooks/neo4j-projection.md` — backfill / drain / GDS verify.
- `docs/runbooks/es-precision-layer.md` — IK version rule, indexes, reindex.
