# P0 integration end-to-end smoke runbook

**Purpose:** one-shot manual verification that the P0 layer works end-to-end
against a real Postgres and a real MCP host: `ingest` → `extract` →
`retrieve`. This proves the whole data path (chunk in → entities/triples →
graph-aware retrieval) in a way fake-embedder / subprocess tests cannot. It is
**not** part of CI; the operator runs it once against a live Postgres + live MCP
host and records the actual output in the PR description.

**Success Criterion #15** (specs/p0-integration.md): the operator runs this
sequence once and records the numbers + the returned chunk's `source_ref` in the
PR body.

**Prerequisites in the code path:**

1. spec-1 DDL is deployed (the four-table schema from specs/p0-schema.md).
2. spec-2 extract CLI is available (`node dist/cli/extract.js`).
3. spec-3 MCP server starts (`node dist/index.js`).

This runbook covers spec-3. `docs/runbooks/extraction-smoke.md` covers the
spec-2 real-LLM extraction path in detail.

---

## 1. Prerequisites

**Tools**

- `node` + `npm` (the repo ISM is built with these).
- A running Postgres 14+ with the spec-1 schema.
- `psql` (optional, for the direct-table checks in step 7).
- An MCP host harness that can drive the server over stdio (a stdio MCP client
  of your choice, or Claude Code's `mcp` registration).

**Environment variables** (names only — set the values in your shell or
`.env.local`, which is gitignored; never paste real values into this file or any
commit):

| Env var                                    | Meaning                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `GRAPHRAG_MEMORY_DB_URL`                   | Postgres DSN (`postgresql://...`)                                             |
| `GRAPHRAG_MEMORY_STORAGE`                  | `pgvector` (ledger + vector; lexical ranking lives in the ES precision layer) |
| `GRAPHRAG_MEMORY_EMBED_DIMENSIONS`         | `2048` for Zhipu embedding-3                                                  |
| `GRAPHRAG_MEMORY_EMBED_BASE_URL`           | `https://open.bigmodel.cn/api/paas/v4`                                        |
| `GRAPHRAG_MEMORY_EMBED_MODEL`              | `embedding-3`                                                                 |
| `GRAPHRAG_MEMORY_EMBED_API_KEY`            | Zhipu embedding key (dedicated; not MiniMax)                                  |
| `GRAPHRAG_MEMORY_EMBED_API_KEY_ENV`        | optional: NAME of another env var holding key                                 |
| `GRAPHRAG_MEMORY_LOG_LEVEL`                | optional: `info` (default) or `debug`                                         |
| `DEBUG`                                    | optional: `1` exposes the retrieve debug keys                                 |
| `GRAPHRAG_MEMORY_RETRIEVAL_W_VEC`          | optional: vector weight (default `0.7`)                                       |
| `GRAPHRAG_MEMORY_RETRIEVAL_W_BM25`         | optional: BM25 weight (default `0.15`)                                        |
| `GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH`        | optional: Neo4j PPR weight (default `0.15`)                                   |
| `GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED`   | optional: `false` to switch BM25 off                                          |
| `GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED`  | optional: `false` to switch the Neo4j arm off                                 |
| `GRAPHRAG_MEMORY_NEO4J_URI`                | optional: Bolt URI; omit to skip the graph arm                                |
| `GRAPHRAG_MEMORY_NEO4J_USER` / `_PASSWORD` | required as a pair when URI is set                                            |

Production retrieve is vector + BM25 + Neo4j PPR at `0.7 / 0.15 / 0.15`
(`src/config.ts`). No URI → the Neo4j arm is not attempted and the envelope
must **not** carry `degraded`. A configured but failing sidecar fail-opens
with `degraded: true`. The archived SQL one-hop path is never wired on the
server (`graphConfig` is test-only). Sidecar operator steps:
`docs/runbooks/neo4j-projection.md`.

> **Host smoke vs this runbook.** `tests/host-smoke.test.ts` spawns
> `dist/index.js` over stdio (same class of launch as Claude Code) with
> memory storage and FakeEmbedder. It proves tool discovery + ingest →
> retrieve and the no-URI skip. This runbook is the operator path against
> **live Postgres** (and optional Neo4j). Extract remains a CLI, not an MCP
> tool.

---

## 2. Steps

### Step 1 — Fresh Postgres

Start a fresh Postgres, or create a clean database / drop the spec-1 schema so
the smoke run starts from an empty P0 layer:

```bash
# pick one:
#   createdb smoke_p0
#   psql -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
```

Apply the spec-1 DDL if the target database does not already have the P0 tables
(`chunks`, `entities`, `entity_aliases`, `triples`, `extraction_records`).

**Assert:** connecting succeeds and the P0 tables exist (or are created).

### Step 2 — Start the MCP server

```bash
npm run build && node dist/index.js
```

The server logs INFO at startup. **Assert** the log contains:

- `server constructed`
- `tools: echo,ingest,retrieve`
- `storage: pgvector`

Leave the server running for the host harness to attach to.

### Step 3 — Ingest a known chunk via the host harness

Use your stdio MCP client (or Claude Code `mcp` registration) to call `ingest`
with a sentence you control and a unique `source_ref`:

```json
{
  "content": "The iknow smoke test owl likes fresh rain on Tuesday.",
  "source_ref": "smoke-test-<uuid>",
  "metadata": { "purpose": "p0-integration-smoke" }
}
```

Replace `<uuid>` with a fresh UUID, e.g. from `uuidgen` or `python -c
"import uuid;print(uuid.uuid4())"` — make sure the same value is reused in step 5.

**Assert:** the response contains the persisted chunk id(s).

### Step 4 — Run the extract CLI

Build first (spec-2 mode), then run the CLI scoped to the chunk you just
ingested:

```bash
npm run build

GRAPHRAG_MEMORY_STORAGE=pgvector \
GRAPHRAG_MEMORY_DB_URL="${GRAPHRAG_MEMORY_DB_URL}" \
node dist/cli/extract.js --batch-size 1 --since <ingest_ts>
```

Set `<ingest_ts>` to the chunk's `created_at` (the timestamp returned at ingest,
or the wall-clock time just before step 3). This bounds the scan to exactly one
chunk.

**Assert:** exit code `0`; the log reports the number of batched chunks as `1`
and one `extraction_records` row with `status = 'succeeded'`.

> If the LLM/embed key is missing, the CLI exits `1` before any LLM call —
> see Troubleshooting. The extraction itself (entity/triple inference) is run by
> spec-2's CLI; this step reuses it to populate the P0 graph tables the
> retrieve step reads.

### Step 5 — Retrieve via the host harness (the end-to-end assertion)

Call `retrieve` with the **same unique sentence** you ingested in step 3:

```json
{
  "query": "the iknow smoke test owl likes fresh rain on Tuesday",
  "limit": 3
}
```

**Assert (the core spec-3 Success Criterion #15):**

```
envelope.chunks[0].source_ref === "smoke-test-<uuid>"
```

The top-ranked returned chunk must carry the exact `source_ref` that step 3
ingested. This proves ingest → extract → retrieve round-trips the data through
the real Postgres + real MCP host.

### Step 6 — (Optional) Re-run retrieve with `DEBUG=1`

Restart the server with `DEBUG=1` set, then call `retrieve` again. **Assert** the
envelope contains the debug keys:

- `debug.vectorHits`
- `debug.graphHits`
- `debug.graphBelowFloor`

> These keys are only present when `DEBUG=1` is set AND the graph arm is wired
> (see the graph-arm activation note in §1). If the T7 wiring commit is not yet
> merged, or the storage backend does not carry `graphArmSeed`, the envelope has
> no `debug` key — that is expected, not a failure.

### Step 7 — (Optional) Direct table check

Confirm the P0 layer has data beyond the vector store:

```sql
SELECT count(*) FROM entities;
SELECT count(*) FROM triples;
SELECT status, count(*) FROM extraction_records GROUP BY status;
```

**Assert:** `entities` and `triples` each have at least one row, and
`extraction_records` has the batch marked `succeeded`.

---

## 3. Cleanup

- Drop the smoke schema / database created in step 1 (or truncate the smoke
  rows).
- Stop the MCP server (Ctrl-C).
- Remove any scratch files the operator may have written under `/tmp` while
  debugging (the `.gitignore` whitelists one such glob, `/tmp/retrieval-pg-latency.json`,
  in case you hand-write a latency probe), including
  `/tmp/retrieval-p95-probe.mjs` from §7 if you ran the latency
  re-measurement.

---

## 4. Troubleshooting

### Postgres unreachable

- **Exit `1` at startup with no LLM call** → config / DB error. Confirm
  `GRAPHRAG_MEMORY_STORAGE=pgvector` and `GRAPHRAG_MEMORY_DB_URL` point at a
  reachable Postgres with the schema loaded. Check `GRAPHRAG_MEMORY_LOG_LEVEL`
  is `debug` to see the connection error.

### Entity embedding is NULL → empty entity seed

- If `entities.embedding` is NULL for the freshly extracted entities, the graph
  arm's seed query finds nothing and the graph arm contributes zero hits
  (`graphHits: 0`). Confirm the embedder env vars from §1 are set and reachable
  so extraction/merge writes non-NULL embeddings.

### LLM key missing

- **Extraction fails / exits `1`** → `GRAPHRAG_MEMORY_LLM_*` or the embed key
  is missing/wrong. See `docs/runbooks/extraction-smoke.md#troubleshooting`
  (401 / wrong base URL / no chunks). Keys live only in the environment or
  `.env.local` — never in this file or a commit.

### Graph arm appears inactive

- No `degraded` / `debug` keys in the envelope even with `DEBUG=1` → the T7
  `graphConfig` wiring into `src/index.ts` is not merged yet, or the storage
  backend lacks `graphArmSeed`. Not a failure; the vector arm alone satisfies
  the §5 assertion. Re-check after T7 merges.

---

## 5. Result template (paste into the PR body)

Copy this block, fill in the actual numbers and the `source_ref` you used, and
attach it to the PR description:

```text
## P0 integration smoke (spec-3 Success Criterion #15)

- Env: storage=pgvector, embed dimensions=<dims>, model=<model>
- Steps 1-4: fresh PG + server up + ingest OK + extract exit 0
  - batched chunks: <n>
  - extraction_records succeeded: <n>
- Step 5 (end-to-end assertion):
  - query: "<the unique sentence>"
  - source_ref ingested: smoke-test-<uuid>
  - envelope.chunks[0].source_ref: smoke-test-<uuid>  # MUST match
- Step 6 (optional): debug.vectorHits=<n> debug.graphHits=<n> debug.graphBelowFloor=<bool>
- Step 7 (optional): entities=<n> triples=<n>
- Cleanup done: <yes/no>
```

---

## 6. Spec-3 retention-policy note

This spec (spec-3) ships **no** `extraction_records` archive SQL. The archival
policy is documented here only:

- **Succeeded** `extraction_records` rows are archived after **30 days**.
- **Failed** rows are retained (kept for diagnosis).

The exact mechanism (DELETE vs archive table vs PG partition) is **out of scope
for spec-3** and is owned by the spec-2 runbook (see
`docs/runbooks/extraction-smoke.md`). The full host-harness acceptance gate for
this path lives under T-007; spec-3 owns the data path +
runbook and does not reopen T-007.

---

## 7. Latency re-measurement (spec-3 Success Criterion #17 / SC12c)

**Purpose:** measure `retrieve` p95 with the graph arm active against the
vector-only baseline on the same machine, on a populated DB
(**≥ 100 entities, ≥ 500 triples, ≥ 1000 chunks**). The threshold is hard:
graph-armed p95 ≤ **1.3×** the vector-only p95. Failure is a **re-plan
trigger** — do not patch retrieval inline and do not relax the budget
(`specs/p0-wiring-closure.md` SC12c, ASSUMPTION 12).

### 7.1 Prerequisites specific to this measurement

- The T7 `graphConfig` wiring is merged (see the activation note in §1);
  otherwise the "graph-armed" arm is the vector-only arm and the number is
  meaningless.
- `CREATE EXTENSION IF NOT EXISTS vector;` has been run against the target
  database.
- The `chunks` table carries a `valid_window` column. The graph arm's one-hop
  SQL filters on `c.valid_window @> $validAt`, but the inline
  `CREATE TABLE IF NOT EXISTS chunks` in `PgvectorBackend.ensureTable()` emits
  only the stage-1 two-column time model (`valid_from` / `valid_until`). The
  operator's deployed `chunks` DDL must add:

  ```sql
  valid_window tstzrange GENERATED ALWAYS AS (
    tstzrange(valid_from, valid_until, '[)')
  ) STORED
  ```

  Without it every one-hop query errors, the fail-open graph arm reports
  `graphBelowFloor: true`, and the measurement silently degrades to
  vector-vs-vector.

### 7.2 What makes the number valid

Both arms must be the **same handler in the same process against the same
dataset**, differing only in whether `graphConfig` is passed:

- graph-armed → `createRetrieveHandler({ embedder, storage, graphConfig })`
- vector-only baseline → `createRetrieveHandler({ embedder, storage })`

Four protocol rules, each of which changes the answer if dropped:

1. **Warm the pool first.** The graph arm is the first code path to issue
   _concurrent_ queries, so its first call pays to open the extra `pg` pool
   connections. Discard at least 30 warmup calls per arm.
2. **Interleave the arms** (alternating which one goes first) so neither
   systematically absorbs cache-warm or cache-cold slots.
3. **Use N ≥ 200 samples per arm.** With N = 10 the "p95" is literally the
   maximum sample — see §7.5.
4. **Assert the arm is actually armed** before timing: the `DEBUG=1` envelope
   must show `graphBelowFloor: false` and `graphHits ≥ 1`.

`FakeEmbedder` is the right embedder here: it makes the run keyless and
deterministic, and it is the conservative choice — a real network embedder adds
the same constant to both arms and only pushes the ratio closer to 1.

### 7.3 The probe

Build first, then write this throwaway probe to `/tmp/retrieval-p95-probe.mjs`
(scratch only — it is not part of the repo; delete it after the run). Set
`REPO` to your checkout:

```js
// /tmp/retrieval-p95-probe.mjs — throwaway spec-3 #17 / SC12c latency probe.
// Set REPO to your checkout and run `npm run build` first.
const REPO = "/workspace";
const DB_URL =
  process.env.GRAPHRAG_MEMORY_DB_URL ??
  "postgresql://postgres@localhost:5432/postgres";
const DIM = 1536,
  ENTITIES = 100,
  TRIPLES = 500,
  CHUNKS = 1000,
  ITER = 300,
  WARMUP = 30;

import { randomUUID } from "node:crypto";
const { default: pg } = await import(`${REPO}/node_modules/pg/lib/index.js`);
const { PgvectorBackend } = await import(
  `${REPO}/dist/core/storage/pgvector-backend.js`
);
const { FakeEmbedder } = await import(`${REPO}/dist/core/embedder.js`);
const { computeEntityEmbeddingText } = await import(
  `${REPO}/dist/core/entities/embedding.js`
);
const { createRetrieveHandler } = await import(
  `${REPO}/dist/tools/retrieve.js`
);
const { loadEnv } = await import(`${REPO}/dist/config.js`);

const SCHEMA = `p95_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
const URL_ = `${DB_URL}${DB_URL.includes("?") ? "&" : "?"}options=-c%20search_path%3D${SCHEMA},public`;
const NOW = new Date(),
  NOW_ISO = NOW.toISOString();
const FROM = new Date(NOW - 864e5).toISOString(),
  UNTIL = new Date(+NOW + 365 * 864e5).toISOString();
const embedder = new FakeEmbedder(DIM);
const vec = async (t) => `[${(await embedder.embed([t]))[0].join(",")}]`;
const p = (a, q) =>
  [...a].sort((x, y) => x - y)[
    Math.min(a.length - 1, Math.ceil(q * a.length) - 1)
  ];
const ms = (n) => Number(n.toFixed(3));

process.env.GRAPHRAG_MEMORY_STORAGE = "pgvector";
process.env.GRAPHRAG_MEMORY_DB_URL = URL_;
process.env.GRAPHRAG_MEMORY_EMBED_DIMENSIONS = String(DIM);
const graphConfig = loadEnv().retrieval;

const c = new pg.Client({ connectionString: URL_ });
await c.connect();
await c.query(`CREATE SCHEMA "${SCHEMA}"`);
await c.query(`SET search_path TO "${SCHEMA}", public`);
// Same chunks DDL the operator deploys: the one-hop SQL filters c.valid_window.
await c.query(`CREATE TABLE chunks (
  id uuid PRIMARY KEY, content text NOT NULL, embedding vector(${DIM}) NOT NULL,
  valid_from timestamptz NOT NULL, valid_until timestamptz NULL, source_ref text NOT NULL,
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL,
  valid_window tstzrange GENERATED ALWAYS AS (tstzrange(valid_from, valid_until, '[)')) STORED)`);

const backend = new PgvectorBackend(URL_, DIM);
await backend.search((await embedder.embed(["warm"]))[0], {
  limit: 1,
  validAt: NOW_ISO,
});

const eIds = [],
  cIds = [];
let buf = [];
for (let i = 0; i < ENTITIES; i++) {
  const id = randomUUID();
  eIds.push(id);
  buf.push(
    `('${id}','entity-${i}','${["person", "organization", "place", "event"][i % 4]}','${await vec(computeEntityEmbeddingText(`entity-${i}`, "latency"))}'::vector)`
  );
}
await c.query(
  `INSERT INTO entities (id, canonical_name, type, embedding) VALUES ${buf.join(",")}`
);
buf = [];
for (let i = 0; i < CHUNKS; i++) {
  const id = randomUUID();
  cIds.push(id);
  buf.push(
    `('${id}','bulk-${i}','${await vec(`bulk-chunk-${i}`)}'::vector,'${FROM}','${UNTIL}','src/${i}','{}',now())`
  );
  if (buf.length >= 200) {
    await c.query(
      `INSERT INTO chunks (id,content,embedding,valid_from,valid_until,source_ref,metadata,created_at) VALUES ${buf.join(",")}`
    );
    buf = [];
  }
}
if (buf.length)
  await c.query(
    `INSERT INTO chunks (id,content,embedding,valid_from,valid_until,source_ref,metadata,created_at) VALUES ${buf.join(",")}`
  );
buf = [];
for (let i = 0; i < TRIPLES; i++)
  buf.push(
    `('${randomUUID()}','${eIds[i % eIds.length]}','${eIds[(i * 7 + 1) % eIds.length]}','rel','rel',1.0,'${cIds[i % cIds.length]}',tstzrange('${FROM}','${UNTIL}','[)'))`
  );
await c.query(
  `INSERT INTO triples (id,head_id,tail_id,relation_raw,relation_norm,confidence,source_chunk_id,valid_window) VALUES ${buf.join(",")}`
);
await c.query("ANALYZE entities");
await c.query("ANALYZE chunks");
await c.query("ANALYZE triples");

const input = {
  query: computeEntityEmbeddingText("entity-0", "latency"),
  valid_at: NOW_ISO,
  limit: 10,
};
const armed = createRetrieveHandler({
  embedder,
  storage: backend,
  graphConfig,
});
const plain = createRetrieveHandler({ embedder, storage: backend });
// Arm-activation proof — a degraded graph arm would make the comparison meaningless.
const dbg = JSON.parse(
  (
    await createRetrieveHandler({
      embedder,
      storage: backend,
      graphConfig,
      debug: true,
    })(input)
  ).content[0].text
);
if (dbg.debug.graphBelowFloor || dbg.debug.graphHits < 1)
  throw new Error(`graph arm not active: ${JSON.stringify(dbg.debug)}`);

for (let i = 0; i < WARMUP; i++) {
  await armed(input);
  await plain(input);
}
const g = [],
  v = [];
for (let i = 0; i < ITER; i++) {
  // Alternate order so neither arm systematically absorbs the warm slot.
  const first = i % 2 === 0 ? armed : plain,
    second = i % 2 === 0 ? plain : armed;
  const a = i % 2 === 0 ? g : v,
    b = i % 2 === 0 ? v : g;
  let t = performance.now();
  await first(input);
  a.push(performance.now() - t);
  t = performance.now();
  await second(input);
  b.push(performance.now() - t);
}
console.log(
  JSON.stringify(
    {
      dataset: { entities: ENTITIES, triples: TRIPLES, chunks: CHUNKS },
      dims: DIM,
      iterations: ITER,
      graphConfig,
      armProof: dbg.debug,
      graphArmed: { p50Ms: ms(p(g, 0.5)), p95Ms: ms(p(g, 0.95)) },
      vectorOnly: { p50Ms: ms(p(v, 0.5)), p95Ms: ms(p(v, 0.95)) },
      p95Ratio: Number((p(g, 0.95) / p(v, 0.95)).toFixed(4)),
      verdict: p(g, 0.95) / p(v, 0.95) <= 1.3 ? "BUDGET_MET" : "REPLAN_TRIGGER",
    },
    null,
    2
  )
);

await backend.close();
await c.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
await c.end();
```

### 7.4 Exact commands

```bash
psql "$GRAPHRAG_MEMORY_DB_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"

npm run build

# Three repeats; the run-to-run spread is the measurement's own noise floor.
for i in 1 2 3; do node /tmp/retrieval-p95-probe.mjs; done
```

Record the **median** of the three `p95Ratio` values. The probe creates and
drops its own scratch schema, so it leaves no rows behind.

### 7.5 Trap: the in-suite probe is not a p95 estimator

`tests/integration/retrieval-pg.test.ts` case 6 also prints a graph-vs-vector
p95 (`/tmp/retrieval-pg-latency.json`). It is a **soft-record smoke probe, not
the #17 measurement**, and it reads high by design:

- N = 10, so its "p95" is the single largest sample;
- no warmup, and the graph loop runs first, so that largest sample is the
  cold-pool call that opens the extra `pg` connections;
- the arms are not interleaved.

Measured on the same box, that first graph call costs ~8 ms while calls 4–10
settle at ~2.9 ms, i.e. the vector arm's own cost. Do not report case 6's
ratio as the SC12c number.

### 7.6 Result template (paste into the PR body)

```text
## Retrieve latency budget (spec-3 #17 / SC12c)

- Machine: <cpu> x <vCPU>, <ram>, <kernel>, node <ver>, PostgreSQL <ver> + pgvector <ver>
- Commit measured: <sha> (<subject>)
- Dataset: <n> entities / <n> triples / <n> chunks, embed dims <n>
- Protocol: <n> interleaved iterations per arm, <n>-call warmup, same process
- Graph arm active: graphBelowFloor=false graphHits=<n> vectorHits=<n>
- graph-armed p95: <n> ms   (p50 <n> ms)
- vector-only p95: <n> ms   (p50 <n> ms)
- p95 ratio: <n.nn>x   budget 1.30x
- Verdict: BUDGET_MET | REPLAN_TRIGGER
```

### 7.7 Re-plan exit

If the ratio exceeds 1.3×, stop and escalate with the measured numbers. The
named exit is re-plan (`specs/p0-wiring-closure.md` ASSUMPTION 12 / SC12c) —
not an inline retrieval patch, not a criterion waiver. Relaxing the budget is
Ask-first.

The budget's headroom is not scale-invariant. The graph arm hides behind the
vector arm only while the seed scan over `entities.embedding` is cheaper than
the vector scan over `chunks.embedding` — neither column carries an ANN index
in P0, so both are sequential scans and the ratio tracks the entity:chunk row
ratio. Re-measure whenever the corpus shape changes materially, not only when
the code changes.

---

**Security:** API keys and DSNs live only in the environment or `.env.local`
(gitignored). They must never appear in this file, in commit messages, or in
pasted PR output. Redact any key or DSN before copying output into the PR.
