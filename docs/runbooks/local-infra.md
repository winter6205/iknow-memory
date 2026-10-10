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
`elasticsearch` compose service (`--no-deps`) and runs
`tests/integration/bm25-pg.test.ts` so the precision layer cannot
loud-skip on PR/main (`CI=true` turns an unreachable probe into a
failed job, not `describe.skip`). Nightly `test-full` starts the same ES
service alongside the Postgres workflow service (not the compose
Postgres, to avoid binding `:5432` twice).

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
| Postgres + pgvector             | `pgvector/pgvector:pg16` (same family as CI)     | `5432`                       | user/db `iknow_memory`, password `iknow_memory` |
| Neo4j + GDS                     | `docker/neo4j` → `5.26.0` + baked GDS `2.13.2`   | `7687` (Bolt), `7474` (HTTP) | user `neo4j`, password `iknow-memory-dev`       |
| Elasticsearch 8.x + analysis-ik | `docker/elasticsearch` → `8.19.20` + matching IK | `9200`                       | security off (no user / API key)                |

`CREATE EXTENSION vector` is created by the host app on first schema bootstrap;
you do not need a separate migration.

## Port ownership: Compose vs a host that already runs Postgres

Decision (2026-09-14): on a dev box,
**this Compose stack owns `5432` / `7687` / `9200`.** Stop any non-compose
listener on those ports before `docker compose up`. One written set of
addresses and credentials beats a mixed stack, and it keeps local dev on the
same `pgvector/pgvector:pg16` family as CI.

On this WSL box the system PostgreSQL 16 owns `5432` and the same instance
also hosts other local projects' databases. The operator stops it before
the first `docker compose up -d --wait`:

```bash
sudo systemctl stop postgresql
# If Compose should own 5432 across reboots too: `sudo systemctl disable postgresql`
# — at the cost of those other databases not coming back at boot.
```

`7687` and `9200` have no non-compose listener here, so Neo4j and
Elasticsearch follow the Compose paths above by default. `scripts/neo4j.sh`
remains the no-Docker path and must not run at the same time.

The Compose volumes start empty. Re-populate the ledger with `ingest` /
`push`; migrating rows off the stopped system instance (`pg_dump`) is a
manual step and out of scope for this runbook.

## Host MCP / `.env.local` pointing at compose

Copy `.env.example` → `.env.local` and fill embedding / rerank API keys. The
connection block already matches compose. Host MCP and `loadEnv()` read this
file directly. Vitest does **not** inject non-`VITE_` keys into `process.env`;
Postgres suites resolve `GRAPHRAG_MEMORY_DB_URL` through
`tests/integration/pg-test-harness.ts` (process env wins; an explicit empty
pin does not fall through to the file).

```bash
GRAPHRAG_MEMORY_STORAGE=pgvector
GRAPHRAG_MEMORY_DB_URL=postgresql://iknow_memory:iknow_memory@localhost:5432/iknow_memory
GRAPHRAG_MEMORY_NEO4J_URI=bolt://localhost:7687
GRAPHRAG_MEMORY_NEO4J_USER=neo4j
GRAPHRAG_MEMORY_NEO4J_PASSWORD=iknow-memory-dev
GRAPHRAG_MEMORY_ES_URL=http://localhost:9200
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

Do not run both against port `7687` at once. Both ship GDS so
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
curl -fsS http://localhost:9200
docker compose exec elasticsearch bin/elasticsearch-plugin list | grep -i analysis-ik
curl -fsS -X POST "http://localhost:9200/_analyze" \
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
