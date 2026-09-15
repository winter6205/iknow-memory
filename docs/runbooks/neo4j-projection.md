# Neo4j projection — backfill, drain, verify

**Status:** shipped on the #70 implementation branch (T2–T5).
**Applies to:** the `graph:backfill` / `graph:drain` operator CLIs and the
Neo4j graph arm on `retrieve`.

Postgres is the system of record. Neo4j holds a derived, read-only
projection of `entities` and `triples` (ADR-0001), kept in sync by a
transactional **projection outbox** plus a full backfill. This runbook is
the operator side of that: how to fill an empty graph, how to keep it
current, and how to tell whether it worked.

## The write surface is exactly two commands

Only `npm run graph:backfill` and `npm run graph:drain` write to Neo4j.
Nothing else does — not the MCP server, not `ingest`, not `retrieve`,
not the `extract` CLI. Extract writes an _intent_ row to
`projection_outbox` inside the same Postgres transaction as the ledger
rows it describes; the drain is what turns intents into graph writes.

That is a spec contract (SC1), not a convention. The retrieve-side arm
opens read-only sessions, and `projection_outbox.subject_kind` is CHECKed
to `('entity','triple')`, so "chunks never enter the graph" is enforced by
the database rather than remembered by each new writer. If you find
yourself adding a third writer, route it through `specs/` first.

An intent names a **subject**, never a snapshot. The drain re-reads the
current row from Postgres before it MERGEs, so intents need no ordering
rule between them and a re-drain can never push a stale value.

## Prerequisites

- `npm run build` done.
- `GRAPHRAG_MEMORY_DB_URL` pointing at the ledger.
- `GRAPHRAG_MEMORY_NEO4J_URI` (plus `_USER` / `_PASSWORD` together, if the
  sidecar has auth on). Neo4j CE with the GDS plugin — the retrieve arm
  calls `gds.graph.project` and `gds.pageRank.stream`.

Local sidecar options (do not bind both to `:7687`):

- **Docker (common case):** `docker compose up -d --wait` — Neo4j `5.26.0`
  + GDS `2.13.2` baked in `docker/neo4j`, auth `neo4j` / `iknow-memory-dev`.
  Set URI, USER, and PASSWORD. See `docs/runbooks/local-infra.md`.
- **No Docker:** `bash scripts/neo4j.sh install && bash scripts/neo4j.sh start`
  — same version pin, auth disabled on `127.0.0.1`, URI only.

Both CLIs bootstrap `projection_outbox` themselves, so there is no
separate migration step.

## Filling an empty graph

Backfill MERGEs every live entity and triple straight into Neo4j. It is
keyed on the ledger id, so a re-run updates in place and an interrupted
run just resumes — check the counts stay flat rather than doubling:

```
$ npm run graph:backfill -- --dry-run
INFO graph-backfill-plan {"entities":3,"triples":2}

$ npm run graph:backfill
INFO graph-backfill-complete {"nodes":3,"edges":2,"batchSize":500}

$ npm run graph:backfill          # idempotent
INFO graph-backfill-complete {"nodes":3,"edges":2,"batchSize":500}
```

`--dry-run` reports what would be projected without opening a Neo4j
connection at all.

The alternative is `--reconcile`, which touches Postgres only: it enqueues
one pending intent per live subject and lets the drain do the work. Use it
when you would rather converge through the same path production uses. A
partial unique index keeps the queue from growing on repeat runs:

```
$ npm run graph:backfill -- --reconcile
INFO graph-reconcile-complete {"entities":3,"triples":2,"queued":5}

$ npm run graph:backfill -- --reconcile
INFO graph-reconcile-complete {"entities":3,"triples":2,"queued":0}
```

## Draining the outbox

This is the steady-state command — run it on a timer, or after a batch of
`extract`. Each batch is its own transaction, so an interrupted drain
keeps the batches it finished and leaves the rest `pending`:

```
$ npm run graph:drain -- --dry-run
INFO graph-drain-plan {"pending":5,"done":0,"failed":0}

$ npm run graph:drain
INFO graph-drain-complete {"intents":5,"nodes":3,"edges":2,"unresolved":0,"batches":1}
```

`unresolved` counts intents whose subject no longer exists in the ledger.
They are logged and marked done; the stale node stays in Neo4j, because
projection GC is not implemented. Deleting entities is rare enough that
the honest answer today is to re-create the graph from a backfill.

Intents that failed mid-batch keep their `last_error` and stay visible.
`npm run graph:drain -- --retry-failed` moves them back to `pending` for
the next run and reports how many it re-armed (`{"rearmed":0}` when there
were none — that is a clean queue, not a no-op bug).

## Verifying

Queue state, from Postgres:

```sql
SELECT status, count(*) FROM projection_outbox GROUP BY status;
SELECT subject_kind, subject_id, attempts, last_error
  FROM projection_outbox WHERE status = 'failed';
```

Graph state, from Cypher — note the labels are `Entity` and `RELATION`:

```cypher
MATCH (e:Entity) RETURN count(e);
MATCH ()-[r:RELATION]->() RETURN count(r);
MATCH (h:Entity)-[r:RELATION]->(t:Entity)
  RETURN h.canonical_name, r.relation_norm, t.canonical_name LIMIT 20;
```

Retrieve state: run a query with `DEBUG=1` and compare it against the same
query with `GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED=false`. A live arm
changes the fused order; a configured-but-broken arm sets `degraded: true`
and names itself under the debug key.

## Exit codes and loud skip

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| `0`  | Success — including `--dry-run`, `--reconcile`, `--retry-failed` |
| `1`  | Config / fatal — no `DB_URL`, Postgres down, `ConfigError`       |
| `2`  | Usage error — unknown, malformed, or mutually exclusive flags    |
| `3`  | Loud skip — Neo4j is configured but unreachable                  |

Exit `3` is deliberately not fatal. Nothing is left half-projected that a
re-run cannot fix, so a script can treat it as "try later" — but it is
loud, never silent:

```
$ npm run graph:drain
graph-drain: Neo4j unreachable at bolt://localhost:7699
Validation:
- Not run: Neo4j projection (outbox drain)
- Expected command: npm run graph:drain
- Blocking issue: Neo4j at bolt://localhost:7699 is unreachable: ...
```

The connection is opened before any intent is claimed, so a sidecar that
is down at start leaves the queue exactly as it was.

The same loud-skip discipline gates the test suite. `npm test` passes with
no Neo4j running — `tests/integration/graph-neo4j.test.ts` and
`tests/integration/neo4j-ppr-arm.test.ts` skip with a Validation block
naming the env they need, rather than passing quietly. Set
`GRAPHRAG_MEMORY_NEO4J_URI` to run them for real.

## Troubleshooting

- **Exit `1` naming the URI** — `--dry-run`, `--reconcile` and
  `--retry-failed` never need Neo4j, but a projecting backfill or drain
  does, and it says so rather than silently doing nothing:
  `GRAPHRAG_MEMORY_NEO4J_URI is required to drain the projection outbox;
pass --dry-run or --retry-failed for a Postgres-only run`.
- **Scheme rejected** — must be one of `bolt`, `bolt+s`, `bolt+ssc`,
  `neo4j`, `neo4j+s`, `neo4j+ssc`. User and password must be set together
  or not at all.
- **Backfill reports edges but Cypher finds none** — check the label. The
  relationship type is `RELATION`.
- **Drain says `pending` but nothing lands** — the sidecar is likely
  reachable yet rejecting writes. Look at `last_error` on the failed rows.
- **Graph arm contributes nothing to retrieve** — an empty projection
  is not an error and does not set `degraded`. Backfill first, then
  re-check the counts above.
- **`retrieve` returns `degraded: true`** — the arm was attempted and
  failed. Missing GDS procedures are the usual cause; confirm with
  `RETURN gds.version()`.
