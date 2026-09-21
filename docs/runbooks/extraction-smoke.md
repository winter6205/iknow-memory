# Real-LLM extraction smoke runbook

**Purpose:** one-shot manual verification of the extraction CLI against a live
Anthropic-compatible endpoint (MiniMax M3). This proves the real LLM path
end-to-end — CLI → LLM client → extraction → merge → Postgres writes — in a way
the fake-LLM unit and subprocess tests cannot. It is **not** part of CI; the
CI suite (`npm test`) runs entirely on `FakeLLMClient` with no real LLM calls.

The Success Criterion for T10 is to run this once and record the actual output
in the PR description.

---

## 1. Prerequisites

1. **Build done.** `dist/cli/extract.js` exists:

   ```bash
   npm run build
   ```

2. **A reachable Postgres** with the spec-1 schema initialized. Configure:
   - `GRAPHRAG_MEMORY_STORAGE=pgvector`
   - `GRAPHRAG_MEMORY_DB_URL` set (see `src/config.ts`)

3. **At least one `chunks` row present** for the CLI to extract from. The
   `--since` filter bounds the scan to that row's `created_at`.

4. **Embedding config set** — extraction and merge write entity/triple rows and
   need the embedder. See `src/config.ts` for the full set:
   - `GRAPHRAG_MEMORY_EMBED_DIMENSIONS`
   - the embedding key + base URL + model vars (`GRAPHRAG_MEMORY_EMBED_API_KEY`
     or `GRAPHRAG_MEMORY_EMBED_API_KEY_ENV`, `GRAPHRAG_MEMORY_EMBED_BASE_URL`,
     `GRAPHRAG_MEMORY_EMBED_MODEL`)

T10 is skipped when `GRAPHRAG_MEMORY_DB_URL` is unset. Do not treat a skipped
run as a successful extraction smoke.

## 2. Set the LLM env vars

Provide these **names** via the environment or `.env.local` (which is
gitignored). Never put real values in this file or in any commit.

| Env var                              | Meaning                                          | Example                       |
| ------------------------------------ | ------------------------------------------------ | ----------------------------- |
| `ANTHROPIC_AUTH_TOKEN`               | LLM secret (extract + retrieve rerank)           | _(set in env / `.env.local`)_ |
| `GRAPHRAG_MEMORY_EMBED_API_KEY`      | Canonical vector/embedding secret               | _(set in env / `.env.local`)_ |
| `GRAPHRAG_MEMORY_VECTOR_API_KEY`     | Preferred vector/embedding alias                | _(set in env / `.env.local`)_ |
| `GRAPHRAG_MEMORY_ANTHROPIC_API_KEY`  | Legacy vector/embedding alias                   | _(set in env / `.env.local`)_ |
| `GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL` | LLM Anthropic-compatible SDK base (optional)     | `https://api.minimaxi.com/anthropic` (default) |
| `GRAPHRAG_MEMORY_ANTHROPIC_MODEL`    | LLM model id (optional)                          | `MiniMax-M3` (default)        |

## 3. Dry-run first

Confirm config loads and the scan finds the target chunk without writing any
rows (exit 0, nothing persisted):

```bash
node dist/cli/extract.js --dry-run --batch-size 1 --since <ISO8601 timestamp of one chunk>
```

## 4. Real run

```bash
node dist/cli/extract.js --batch-size 1 --since <ISO8601 timestamp of one chunk>
```

`--since` should be set to the `created_at` of the chunk you want to process, so
the run is scoped to exactly one chunk.

## 5. Expected outcome

- Process exits with code **0**.
- Exactly one `extraction_records` row with `status = 'succeeded'`.
- At least one `triples` row (and its `entities` / `entity_aliases`) written.

Verify with SQL:

```sql
-- one succeeded record for the batch
SELECT status, count(*) FROM extraction_records GROUP BY status;

-- at least one triple written
SELECT count(*) FROM triples;

-- entities written by this run
SELECT count(*) FROM entities;
```

## 6. Entity-type normalization

`entities.type` is pinned by a DDL CHECK constraint to exactly
`('person','organization','place','event')` (specs/entity-type-and-filter.md).
The LLM emits an open-string type, so the persist layer normalizes every
`headType` / `tailType` into that closed set at the boundary
(`src/core/extraction/entity-type.ts :: normalizeEntityType`) before the
INSERT — otherwise a non-listed raw type (e.g. `"Organization"`,
`"Location"`) would violate the CHECK and roll back the whole chunk (exit 2).

Mapping (case-insensitive; input is trimmed + lowercased first):

| Raw LLM type                                       | Persisted / action               |
| -------------------------------------------------- | -------------------------------- |
| person, human, individual, user, agent             | person                           |
| organization, company, org, team                   | organization                     |
| place, location, geo                               | place                            |
| event, incident, occurrence, action                | event                            |
| anything else / empty / unknown                    | not persisted (typed skip)       |

There is deliberately no catch-all bucket: an unknown proposed type makes
`normalizeEntityType` return `null`, and the persist layer typed-skips the
whole output — no entity row is written — emitting a structured
`entity-type-unknown-skip` warn log so the drop is auditable
(`src/core/extraction/persist.ts`).

Known limitation (fast leg): `--method fast` co-occurrence nodes carry the
unclassified type `concept`, so under the closed set a fast run currently
persists **zero** entities — every output is typed-skipped above — until the
fast method gets its own typed-node scheme (follow-up).

## 7. Troubleshooting

### Exit codes

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| `0`  | Success — full run completed                                          |
| `1`  | Config or fatal error (bad env, unreachable DB, unreachable endpoint) |
| `2`  | Partial failure — some chunks succeeded, some failed                  |

### Common failures

- **401 unauthorized** → `ANTHROPIC_AUTH_TOKEN` is missing or
  wrong. Re-check the key in `.env.local` / env.
- **4xx-failed records only on one path** → the extract CLI expects a bare
  `ANTHROPIC_AUTH_TOKEN`, while the MCP host path may resolve the key via the
  `GRAPHRAG_MEMORY_RERANK_API_KEY_ENV` pointer; this asymmetric config produces
  4xx failed records on the CLI side.
- **Wrong base URL** → request fails to reach the endpoint. Confirm
  `GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL` matches the provider (default:
  `https://api.minimaxi.com/anthropic`).
- **No chunks to process** → `--since` filters out every chunk, or every chunk
  already has a `succeeded` record. Widen `--since` or pick a fresh chunk.
- **Exit `1` on startup with no LLM call** → config error; check the storage /
  DB / embedding env vars from §1–§2.

## 8. Record the result

After the run, paste the actual command output (stdout/stderr + exit code) into
the PR description. That recorded output is the T10 Success Criterion.

---

**Security:** API keys live in the environment or `.env.local` only (gitignored).
They must never appear in this file, in commit messages, or in pasted PR output.
Redact any key before copying output into the PR.
