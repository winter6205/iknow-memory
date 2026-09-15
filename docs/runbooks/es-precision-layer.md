# Elasticsearch precision layer — deployment & operation

**Status:** ships with `plans/es-precision-layer.md` (T2 / T8).
**Applies to:** production `retrieve` configured with an ES node and
`src/core/storage/elasticsearch-precision.ts` as the lexical carrier.

Postgres is the authoritative source. Elasticsearch hosts **two derived
lexical indexes** — chunk and entity — produced by double-writing from
`ingest` / `push` / extract paths. This runbook is the operator side:
spin up the cluster, install the analyzer, verify, recover.

## Version alignment

| Side   | Component                      | Required version                                  |
| ------ | ------------------------------ | ------------------------------------------------- |
| Server | Elasticsearch                  | **8.x** (compose pin **8.19.20**).                |
| Server | `analysis-ik` plugin           | **exact 8.x patch match** (compose: **8.19.20**). |
| Client | `@elastic/elasticsearch` (npm) | **8.x** (currently 8.x).                          |

> **Why the triple must match.** IK plugins are compiled against a
> specific Elasticsearch build. An IK built for 8.15.0 will not load
> against an 8.16.0 cluster (or vice versa), and the client SDK enforces
> its own server-version contract. Mismatch shows up at two boundaries:
> plugin install (`Plugin [analysis-ik] is not compatible with
Elasticsearch`) or query time (client refuses the handshake).
>
> iknow-memory pins **ES 8.x** for both sides; do not run mixed majors.

## Single-node deployment (Docker)

The local / dev shape is one node, no replicas, IK installed once. The
single-node path is sufficient for production triage and any environment
where a managed ES service is not in use.

**Happy path for this repo:** root `docker compose up -d --wait` builds
`docker/elasticsearch` (Elasticsearch **8.19.20** + `analysis-ik` **8.19.20**)
together with Postgres and Neo4j. The MCP app stays on the host. See
`docs/runbooks/local-infra.md`.

The one-off `docker run` below is for triage **outside** that compose file
(you must still install IK at the exact patch, next section):

```bash
# Elasticsearch 8.x, single-node, security off for local dev.
# Pin must match the analysis-ik zip (currently 8.19.20 in compose).
docker run --rm --name iknow-es \
  -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  -e "ES_JAVA_OPTS=-Xms512m -Xmx512m" \
  -e "cluster.routing.allocation.disk.threshold_enabled=false" \
  docker.elastic.co/elasticsearch/elasticsearch:8.19.20
```

Memory / JVM guidance — keep it simple:

- Heap `-Xms == -Xmx`, picked once at start. 512 MB is enough for the
  precision layer (chunk + entity indexes, one shard each, no replicas).
  Raise only when you see `circuit_breakers` in `/_cluster/stats`.
- Disable disk allocation watermarks in Docker / single-node so the
  container does not enter read-only mode when its overlay fills up.
  Production single-node hosts should set a watermarked data path
  instead.
- No replicas (`number_of_replicas: 0`) on a single node — the cluster
  will otherwise stay yellow forever. Index settings under
  `src/core/storage/elasticsearch-precision.ts` already pin this.

Health check:

```bash
curl -fsS http://localhost:9200
# {"name":"iknow-es","cluster_name":"docker-cluster",...}
```

> **WSL / `localhost` host field.** Prefer `127.0.0.1` over `localhost` in
> `GRAPHRAG_MEMORY_ES_URL`. Under WSL `/etc/hosts` maps `localhost` to
> both `127.0.0.1` and `::1`, and the resolver order decides which one
> wins — the two standard resolvers disagree on this very machine
> (`getent hosts localhost` → `::1`, Node `dns.lookup("localhost")` →
> `127.0.0.1`). Compose's plain `9200:9200` publishes on **both**
> `0.0.0.0` and `[::]`, so today both paths answer; a publish bound to
> IPv4 only (`127.0.0.1:9200:9200`) turns the IPv6 path into
> `ECONNREFUSED` / `ECONNRESET`. Pinning `127.0.0.1` removes that
> variable. Same rule in `docs/mcp-config.md`.

## Installing `analysis-ik`

IK is **not** bundled with the official Elasticsearch image. Install the
plugin into the running container — the version **must match the
cluster's exact 8.x patch version**:

```bash
ES_VERSION="8.19.20"

docker exec -it iknow-es bash -c "
  bin/elasticsearch-plugin install --batch \
    https://release.infinilabs.com/analysis-ik/stable/elasticsearch-analysis-ik-${ES_VERSION}.zip
"
# --batch accepts the plugin security exception (ik is on the standard list).
docker restart iknow-es
```

> **Why a release-zip install (not the docker image's bundled plugin
> helper).** INFINI Labs (`release.infinilabs.com/analysis-ik/stable/`)
> is the current IK release channel (the older `medcl` GitHub release
> zips stopped at earlier 8.x patches). The
> `bin/elasticsearch-plugin install <URL>` path keeps the plugin on
> the same lifecycle as the cluster image. Compose bakes this into
> `docker/elasticsearch/Dockerfile` so `up --wait` does not need a
> second install step.

Verify the plugin loaded:

```bash
docker exec iknow-es bin/elasticsearch-plugin list | grep -i analysis-ik
# analysis-ik    <version>
```

## Verifying tokenizer with `_analyze`

The whole point of IK is "a continuous Chinese string tokenizes into ≥ 2
tokens". Run the spec's SC-2 assertion live against the cluster (no auth
in local dev; the runbook does not embed credentials):

```bash
curl -fsS -X POST "http://localhost:9200/_analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "analyzer": "ik_max_word",
    "text": "中华人民共和国国歌"
  }'
```

Expected shape (≥ 2 tokens for any continuous CJK string; exact token
list varies by IK build):

```json
{
  "tokens": [
    {"token":"中华","start_offset":0,"end_offset":4,...},
    {"token":"华人","start_offset":0,"end_offset":4,...},
    {"token":"人民","start_offset":2,"end_offset":6,...},
    {"token":"中华人民共和国","start_offset":0,"end_offset":7,...},
    ...
  ]
}
```

If you get back exactly one token, the cluster is using the
standard analyzer (plugin not loaded) — re-run the install step and
restart the cluster before continuing.

A second sanity probe with `ik_smart` (the analyzer used at query time):

```bash
curl -fsS -X POST "http://localhost:9200/_analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "analyzer": "ik_smart",
    "text": "中华人民共和国国歌"
  }'
```

## Derived indexes — chunk and entity

The precision layer owns **two** derived indexes. They are _created
lazily_ by `ElasticsearchPrecisionLayer.ensureIndex` (`ensureIndex` ->
`createIndexIfMissing`) the first time a write points at them — there
is **no separate bootstrap CLI** to remember. The mapping definitions
live in `src/core/storage/elasticsearch-precision.ts`:

| Index          | Default name            | Mapping fn         | Pinned via env var                |
| -------------- | ----------------------- | ------------------ | --------------------------------- |
| chunk lexical  | `iknow-memory-chunks`   | `chunkMappings()`  | `GRAPHRAG_MEMORY_ES_CHUNK_INDEX`  |
| entity + alias | `iknow-memory-entities` | `entityMappings()` | `GRAPHRAG_MEMORY_ES_ENTITY_INDEX` |

Both indexes use:

- `ik_max_word` at index time and `ik_smart` at query time
  (`ik_index` / `ik_query` custom analyzers).
- Native ES `BM25` similarity (`iknow_bm25`) with `k1` / `b` from
  `RetrieveConfig` (`GRAPHRAG_MEMORY_RETRIEVAL_K1`,
  `GRAPHRAG_MEMORY_RETRIEVAL_B`).
- 1 shard, 0 replicas. Acceptable for single-node and dev; raise
  replicas before going multi-node.

Inspect the live mapping after the first write:

```bash
curl -fsS "http://localhost:9200/iknow-memory-chunks/_mapping?pretty"
curl -fsS "http://localhost:9200/iknow-memory-entities/_mapping?pretty"
```

Verify doc counts:

```bash
curl -fsS "http://localhost:9200/iknow-memory-chunks/_count"
curl -fsS "http://localhost:9200/iknow-memory-entities/_count"
```

## Failure mode A — Postgres succeeded, ES lagged

This is the standard double-write failure path: ingest / push writes the
authoritative Postgres row first, then attempts the ES write. If the ES
write throws, the call still returns success and the chunk / entity is
recorded as degraded (`keyword_bm25:attempted-and-failed` in the envelope
when it is surfaced). Postgres stays the source of truth.

Recovery path:

1. The authoritative Postgres row is intact; nothing in `chunks` /
   `entities` / `entity_aliases` was rolled back.
2. **Direct push recovery** — re-run the original `ingest` / `push` /
   extract with the same `(source_ref, contentIdentity)` idempotency key.
   The double-write semantic replays, this time against a now-healthy
   cluster, and the index catches up. Repushing the same key does not
   create a second Postgres row; the idempotency contract is preserved.
3. **Replay tail** — if there is a backlog (multiple failed writes
   during an outage), the runbook below covers the bulk-replay path.

## Failure mode B — full rebuild

When the indexes are too far out of sync to repair chunk-by-chunk (mass
outage, mapping accidentally recreated with wrong analyzer settings,
operator "let's start over"), the recovery is:

1. Stop ingestion (set `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false`
   and restart the server, or just pause the extract CLI).
2. Use the `es:reindex` CLI (see the section below).
3. Postgres rows are never modified by the rebuild; only the two
   derived indexes are dropped and re-populated.

### Reindex tool (`es:reindex`)

`npm run es:reindex` is the supported full-rebuild recovery path
(`src/cli/es-reindex.ts`). It scans the live Postgres ledger in
keyset-paginated pages, wipes both derived indexes **once up front**, then
re-projects every page through the plain index upsert — so all pages
accumulate (a per-page delete-then-rebuild would erase previously written
pages). Indexing is idempotent: documents key on the ledger row id, so a
re-run converges on the same shape.

```bash
# Dry run: scan Postgres, report plan counts, touch nothing on ES,
# open no ES connection.
npm run es:reindex -- --dry-run

# Full rebuild of both derived indexes from Postgres.
npm run es:reindex

# Smaller pages (rows scanned per page; also the per-call bulk slice).
npm run es:reindex -- --batch-size 200
```

Behavior:

- **`--dry-run`** counts the chunk and live-entity rows the rebuild would
  project and exits without opening the ES client or deleting an index.
- **`--batch-size N`** sets the keyset page size (default 500; must be a
  positive integer).
- **Exit codes:** `0` success (full reindex or dry run) · `1` config /
  fatal — missing `GRAPHRAG_MEMORY_DB_URL`, Postgres unreachable, missing
  `GRAPHRAG_MEMORY_ES_URL` when a rebuild was asked for, or any
  non-usage throwable during the run · `2` usage error (unknown or
  malformed flag).
- An unconfigured ES block is a **config error (exit 1)**, not a silent
  skip: the tool was invoked specifically to push to ES, so "no target
  configured" is an operator mistake. Since ADR-0007 that refusal now
  surfaces earlier — `loadEnv()` itself fails the boot when the
  default-on precision layer has no address — so even `--dry-run` needs
  `GRAPHRAG_MEMORY_ES_URL` set or `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false`
  set for the run.
- **Postgres is read-only.** The CLI never issues a write against the
  ledger; only `iknow-memory-chunks` and `iknow-memory-entities` are
  dropped and re-populated.

## Environment variables

All of the following are read by `src/config.ts`. Credentials are
referenced by **variable name only** in this runbook — set the values in
your host's MCP JSON `env` block or `.env.local`, never in source
(`docs/CONTEXT.md` / `security-boundaries.md` rule).

| Variable                                             | Purpose                                           | Default                                   |
| ---------------------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| `GRAPHRAG_MEMORY_ES_URL` (alias `_NODE`)             | Single ES node URL (`http(s)://…`).               | unset (fail-start, see below)             |
| `GRAPHRAG_MEMORY_ES_USERNAME`                        | Basic-auth user (with `_PASSWORD`).               | unset                                     |
| `GRAPHRAG_MEMORY_ES_PASSWORD`                        | Basic-auth password (with `_USERNAME`).           | unset                                     |
| `GRAPHRAG_MEMORY_ES_API_KEY`                         | API key (mutually exclusive with user/password).  | unset                                     |
| `GRAPHRAG_MEMORY_ES_CHUNK_INDEX`                     | Chunk derived index name.                         | `iknow-memory-chunks`                     |
| `GRAPHRAG_MEMORY_ES_ENTITY_INDEX`                    | Entity + alias derived index name.                | `iknow-memory-entities`                   |
| `GRAPHRAG_MEMORY_ES_REQUEST_TIMEOUT_MS`              | Per-request client timeout (ms).                  | `5000`                                    |
| `GRAPHRAG_MEMORY_RETRIEVAL_K1`                       | Okapi BM25 k1 (similarity setting).               | `1.2`                                     |
| `GRAPHRAG_MEMORY_RETRIEVAL_B`                        | Okapi BM25 b (similarity setting).                | `0.75`                                    |
| `GRAPHRAG_MEMORY_RETRIEVAL_CJK_SEGMENTATION_ENABLED` | Use `ik_max_word` / `ik_smart`; off → standard.   | `true`                                    |
| `GRAPHRAG_MEMORY_RETRIEVAL_PHRASE_ENABLED`           | Add `match_phrase` shoulder to scoring.           | `true`                                    |
| `GRAPHRAG_MEMORY_RETRIEVAL_FIELD_BOOST_ENABLED`      | Apply multi-field `boost` weights.                | `true`                                    |
| `GRAPHRAG_MEMORY_RETRIEVAL_FIELD_BOOSTS`             | JSON object of field → weight (≥ 0).              | `{content:1,source_ref:1,"metadata.*":1}` |
| `GRAPHRAG_MEMORY_RETRIEVAL_RRF_ENABLED`              | RRF fusion of vector+BM25 (fallback + remainder). | `true`                                    |
| `GRAPHRAG_MEMORY_RETRIEVAL_VECTOR_ENABLED`           | Vector arm on/off.                                | `true`                                    |

The precision layer is default-on with no address here, so
`GRAPHRAG_MEMORY_ES_URL` unset makes `loadEnv()` throw `ConfigError` and
refuse process start (ADR-0007 fail-start) — the same shape as the
graph / rerank refusals. Set the address, or take the explicit-off escape
hatch `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false` to boot
vector-only. Partial configuration (a username without a password, or
credentials without a URL) is still rejected at startup as a typed
`ConfigError` naming the missing variable.

## Exit codes / fail-start behavior

When ES is configured but unreachable at query time:

- Retrieve succeeds. The lexical arm sets `degraded: true` and records
  `keyword_bm25` (and related names) in `degraded_reasons`. Vector
  results still come back.

When ES is configured but unreachable at ingest write time:

- Postgres write has already succeeded. The ES write is recorded as a
  failure; recovery is mode A above. Caller sees the chunk id; the
  envelope reports the precision layer as degraded for that push.

When ES is **not** configured (`GRAPHRAG_MEMORY_ES_URL` unset):

- A default-on precision layer with no address refuses process start
  (`ConfigError`, ADR-0007 fail-start). This is not a retrieve-time
  state — the process never boots, so no `degraded` envelope is produced.
- Only an explicit `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED=false` boots
  without ES; the lexical arm is then not attempted at all and no
  `degraded` flag is set (per `degraded=true` rule 4: a capability the
  caller / operator switched off is not a degradation).

## Troubleshooting

- **`Connection refused` on first retrieve.** The cluster is not up yet
  or the URL is wrong. Confirm with the health `curl` above before
  retrying.
- **One-token CJK output in `_analyze`.** Plugin not loaded. Re-run the
  install step against the _exact_ cluster version, then `docker
restart iknow-es` (or the prod equivalent).
- **`Plugin [analysis-ik] is not compatible with Elasticsearch`.** IK
  and cluster patch versions differ. Re-fetch the matching release ZIP.
- **`version_conflict_engine_exception` on bulk reindex.** An older
  reindex run is still in flight; let it finish before retrying, or drop
  and recreate the index with the rebuild tool.
- **Doc count disagrees with Postgres count.** Chunk / entity rows were
  written to Postgres while ES was down. Use the rebuild path or replay
  the specific `(source_ref, contentIdentity)` keys.

## See also

- `specs/es-precision-layer.md` — the active contract (SC-1..10
  acceptance mapping; IK alignment; spec for `phrase` / `field_boost` /
  BM25 knobs).
- `plans/es-precision-layer.md` — execution plan (T2 ES stack, T7
  Postgres 词法臂摘除, T8 docs / reindex tool).
- `docs/adr/0003-authoritative-source-and-derived-retrieval-indexes.md`
  — derived-index semantics (Postgres authoritative; ES indexes
  deletable and re-buildable).
- `docs/adr/0005-degraded-signal-and-partial-failure-semantics.md` —
  why configured-but-unreachable ES degrades rather than throws.
