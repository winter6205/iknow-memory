# G4 bounded source-read gold run — iknow-memory (2026-09-24)

This records the measured output of `tests/integration/read-source-gold-mcp-pg.test.ts`, on the `feat/g4-bounded-source-read` branch (base `0539ad5`, plan head `0d6ac33`, implementation `057c7de` plus the review-repair commit that widened the byte ceiling to the terminal cursor form). `dist/index.js` was rebuilt with `npm run build` immediately before the run, so the child MCP process exercised the repaired handler. It is the source-read acceptance evidence required by `specs/bounded-source-read.md`; the retrieval-gold baseline in `2026-09-24-g4-planning-baseline.md` does not cover it.

## Real dependencies used

- PostgreSQL `PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2) on x86_64-pc-linux-gnu`, image `pgvector/pgvector:pg16`, extension `vector 0.8.6`.
- Server under test: the real MCP process `node dist/index.js` over the stdio transport, `GRAPHRAG_MEMORY_STORAGE=pgvector`, `GRAPHRAG_MEMORY_EMBED_DIMENSIONS=32`, `GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS=2000`, with the graph, BM25 and rerank arms switched off and `HOME` set to a fresh temp directory so the operator `setting.json` cannot reach the child.
- Storage isolation: a per-run schema (`read_gold_<uuid>`) addressed through the libpq `options=-c search_path=` parameter, dropped in `afterAll`.
- Gold fixture: committed `eval/source-body/g4-long-source-v1.json`, `version` `g4-long-source-v1`, 9,143 Unicode code points (9,215 UTF-16 units), sha256 `35e7dca471d2b2b429365e507c8aa22f6bd97772ff1b6226e948fca6330f727b`, containing a 72-code-point supplementary-plane run across index 8,000 and embedded `"` / `\` / newline-heavy sections. Its `source_ref` uses fin's canonical frozen-unit locator — sorted keys, compact separators, and a **string** `version` — the only form fin's `deserialize_source_ref` accepts.

## Command and exit status

```text
env -u GRAPHRAG_MEMORY_EMBED_API_KEY \
GRAPHRAG_MEMORY_DB_URL="postgresql://postgres@localhost:5432/postgres" \
npx vitest run tests/integration/read-source-gold-mcp-pg.test.ts
```

Exit 0 — `Test Files 1 passed (1)`, `Tests 9 passed (9)`, duration 4.75s. The suite self-skips loudly with the harness `Validation: Not run` block when PostgreSQL is unreachable, and throws instead of skipping when `CI=true`. The `env -u` only guards the ambient-key caveat noted below; a clean CI shell does not need it.

## Persisted identity

Read back with plain SQL against `source_documents`, independent of the tool:

| Field             | Actual                                                             |
| ----------------- | ------------------------------------------------------------------ |
| gold `source_ref` | `{"document_id":"g4-bounded-read-handbook","unit":1,"version":"3"}` |
| gold `id`         | `a75798c2-12c8-41cc-b01b-c14196189734`                             |
| stored length     | 9,143 code points, sha256 equal to the fixture                     |
| unit 2 `id`       | `8249286d-3d73-4899-8d98-bb92484a8ce3`                             |
| version 4 `id`    | `3be21f46-27a2-4f97-a2e3-da4b877d9dc6`                             |

The `id`s are per-run UUIDs from this execution; the assertion is that the three rows carry distinct stored keys and distinct bodies, so the gold read can never return unit 2 or version 4.

The unit-2 and version-4 rows carry different stored keys and different bodies; the suite asserts the gold read never returns either of them.

## Observed slice and position sequence

Ceilings in force: 8,000 Unicode code points of text and 32,768 UTF-8 bytes for the complete serialized `tools/call` result object.

Gold body, `source_ref` selector, walked from `position: 0` to the terminal cursor:

| Call | `position` in | code points out | serialized result bytes | `next_position` |
| ---- | ------------: | --------------: | ----------------------: | --------------: |
| 1    |             0 |           8,000 |                  22,248 |           8,000 |
| 2    |         8,000 |           1,143 |                   2,595 |          `null` |

Measured maxima for the gold walk: **8,000 code points** per slice (equal to the ceiling, so the text bound is what binds) and **22,248 bytes** per serialized result (against a 32,768-byte ceiling). Concatenating the two slices reproduced the stored body with `toBe` equality and the fixture sha256.

Mid-body resume, `position: 7,500`: one slice, 4,051 serialized bytes, content equal to the independently sliced code-point range.

## Byte ceiling binding

A canonical locator is short, so 8,000 code points never exhaust the byte ceiling. The suite therefore also stores a locator probe whose `document_id` is 900 supplementary-plane code points (941 code points serialized) and whose body is 8,500 code points of `"`, `\`, emoji and newline:

| Call | code points out | serialized result bytes | `next_position` |
| ---- | --------------: | ----------------------: | --------------: |
| 1    |           7,706 |              **32,750** |           7,706 |
| 2    |             794 |                   6,829 |          `null` |

The first slice stops 294 code points below the text ceiling because the byte ceiling binds, and lands at 32,750 bytes — the largest slice that fits, 18 bytes of headroom because one more code point (each escaping to at least three bytes through the JSON-in-JSON envelope) would cross 32,768. The two slices still reconstruct that body exactly.

## Typed exits observed on the real store

| Case                                   | Actual result                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| absent locator                         | `read_source_not_found`, `isError: true`                                                              |
| row with `valid_until` set             | `read_source_invalidated` carrying the row's `id`, `source_ref`, `valid_until`; no content, no cursor |
| `position` -1, 2.5, 9,144              | `read_source_invalid_position`                                                                        |
| `source_ref` of 1,025 code points      | `read_source_invalid_locator`, request value not echoed                                               |
| four concurrent reads at two positions | two distinct results, each byte-identical across its pair                                             |

## Suite evidence

- `tests/eval/source-body-gold.test.ts` — 7 passed. Fixture self-integrity: recomputed code-point count, recomputed sha256, surrogate-pair straddle at index 8,000, escaping present, locator parts distinct.
- `tests/tools/read-source.test.ts` — 37 passed. Empty, invalid, overflow, concurrent and exception classes on the pure seam, including the terminal-`null`-cursor byte ceiling and the bounded error echo.
- `tests/integration/read-source-pg.test.ts` and `tests/integration/content-invalidation-pg.test.ts` — passed against the same real server.
- `tests/index.test.ts`, `tests/content-invalidation.test.ts`, `tests/host-smoke.test.ts` — 34 passed, covering the changed tool description and input schema on the registered surface.
- `npm run typecheck` — exit 0.

## Not run

- `npm test` (full suite): **run, exit 0** — `Test Files` and `Tests` all green. One caveat recorded for the operator: the suite is sensitive to an ambient `GRAPHRAG_MEMORY_EMBED_API_KEY` in the invoking shell, which makes `tests/config.test.ts` assert the wrong boot-guard message; the run above unsets it (`env -u GRAPHRAG_MEMORY_EMBED_API_KEY npm test`).
- Live LLM extraction and the ingest→retrieve smoke: unrelated to the read boundary; no ingest or ranking path changed.
- Elasticsearch and Neo4j containers: unavailable in this environment and not exercised by this change.
- fin's live client round-trip over this wire (success criterion 5): **open**. The real consumer is fin's `src/fin/retrieve/mcp_adapter.py` (`_fetch_unit_body`, which reads `inner["content"]` as a single complete body and does not yet follow `next_position`); the `next_position` cursor is not consumed anywhere in fin today. That adapter must move to the bounded, resumable walk before fin T4 closes, so this iknow-memory wire ships ahead of its consumer.
