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

| Env var                                       | Meaning                                        |
| --------------------------------------------- | ---------------------------------------------- |
| `GRAPHRAG_MEMORY_DB_URL`                      | Postgres DSN (`postgresql://...`)              |
| `GRAPHRAG_MEMORY_STORAGE`                     | `pgvector` (the graph arm reads the P0 tables) |
| `GRAPHRAG_MEMORY_EMBED_DIMENSIONS`            | embedder dims (e.g. `1536`, or whatever yours) |
| `GRAPHRAG_MEMORY_EMBED_BASE_URL`              | embed endpoint base URL                        |
| `GRAPHRAG_MEMORY_EMBED_MODEL`                 | embed model id                                 |
| `GRAPHRAG_MEMORY_EMBED_API_KEY`               | embed key, **or** …                            |
| `GRAPHRAG_MEMORY_EMBED_API_KEY_ENV`           | name of the env var holding the embed key      |
| `GRAPHRAG_MEMORY_LOG_LEVEL`                   | optional: `info` (default) or `debug`          |
| `DEBUG`                                       | optional: `1` exposes the retrieve debug keys  |
| `GRAPHRAG_MEMORY_RETRIEVAL_W_VEC`             | optional: vector weight (default `1`)          |
| `GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH`           | optional: graph weight (default `1`)           |
| `GRAPHRAG_MEMORY_RETRIEVAL_ENTITY_LINK_TOP_K` | optional: entity link top-K (default `5`)      |
| `GRAPHRAG_MEMORY_RETRIEVAL_CANDIDATE_CAP`     | optional: candidate cap (default `20`)         |
| `GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ARM_FLOOR`   | optional: graph-arm floor (default `3`)        |

The five `GRAPHRAG_MEMORY_RETRIEVAL_*` knobs are the graph arm's config. The
retrieval defaults are `1 / 1 / 5 / 20 / 3`
(`w_vec` / `w_graph` / `entityLinkTopK` / `candidateCap` / `graphArmFloor`) per
`src/config.ts`.

> **Graph arm activation note.** The orchestrator only runs the graph arm when
> BOTH the storage backend carries `graphArmSeed` AND a retrieval
> `graphConfig` is supplied at wiring time. The retrieval knobs above are read
> from the environment by the CLI / server; the fragment that threads
> `graphConfig` into `src/index.ts` lands in the T7 wiring commit. Until that
> commit is merged, the envelope is vector-only (no `degraded` / `debug` graph
> keys) even when the env vars are set. Do not claim graph-arm activation that
> is not yet wired.

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
  in case you hand-write a latency probe).

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
this path lives in winter6205/iknow#49 (T-007); spec-3 owns the data path +
runbook and does not reopen T-007.

---

**Security:** API keys and DSNs live only in the environment or `.env.local`
(gitignored). They must never appear in this file, in commit messages, or in
pasted PR output. Redact any key or DSN before copying output into the PR.
