# Spec: P0 Extraction — LLM Triple Extraction + Canonical Entity Merge

> **Spec 2 of 3** for the P0 entity/triple layer. **Blocked by spec 1** (`specs/p0-schema.md` — four-table DDL: entities / triples / entity_aliases / extraction_records).

## Objective

Implement the **offline LLM triple-extraction pipeline** and the **canonical entity merge algorithm** that consume chunks (already produced by spec 1's stage-1 ingest) and populate `entities` / `triples` / `entity_aliases` / `extraction_records` for downstream spec-3 graph-arm retrieval.

**Who uses it**: the extraction pipeline is invoked by a stand-alone CLI (operator, cron, or host-side automation), never by the MCP server. The MCP server stays `ingest`+`retrieve`-only — context engineering (JIT, cache layout, assembly) belongs to the host, not the server.

**Why now**: stage 1 ships only chunk-level vector retrieval; no LLM-driven structured extraction, no canonical entity merge, and no alias-aware graph layer exists yet. Established hybrid RAG benchmarks (e.g. BrainBench) credit canonical entity merge with material P@5 gains. P0 is the ROI-tightest path to a real graph layer.

**What success looks like**:

- Operator can execute `npm run extract` (or `node dist/cli/extract.js`) against a populated `chunks` table and watch it produce (a) `triples` rows linked to chunks, (b) `entities` rows with embedding-based merge already applied, (c) `extraction_records` rows exposing per-chunk status.
- Failed chunks are visible via `listFailed()` without retrying the whole batch.
- No regression in stage-1 ingest/retrieve (`npm test` green; `host-smoke` 5/6 → 6/6 once spec-3 lands).

## Architectural Constraints

Authoritative prior decisions:

| Decision ID                                 | Source            | Effect on this spec                                                                                                                                                                                  |
| ------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0a D1** (storage authority)           | closed 2026-08-01 | Postgres authoritative for entities / triples / entity_aliases / extraction_records. Neo4j is a read-only projection (P1). This spec writes only Postgres.                                           |
| **D2** (UUID)                            | closed 2026-08-01 | All id columns = UUID v4 (resolved in spec 1 Open Question 1).                                                                                                                                       |
| **D3** (raw + norm)                      | closed 2026-08-01 | `triples.relation` is split into `relation_raw` (free text, audit) and `relation_norm` (traversal key, vocabulary-enforced in app).                                                                  |
| **D4** (source_chunk_id)                 | closed 2026-08-01 | Every triple carries `source_chunk_id` (nullable FK → chunks.id, `ON DELETE SET NULL`).                                                                                                              |
| **D5** (valid_window)                    | closed 2026-08-01 | `triples.valid_window` is `tstzrange` + GiST + `@>` containment.                                                                                                                                     |
| **D6** (Neo4j projection shape)          | closed 2026-08-01 | Out of scope for this spec — Neo4j nodes/edges not touched.                                                                                                                                          |
| **D1** (offline CLI)                     | closed 2026-08-02 | Server is unaware of extraction. CLI is an independent process.                                                                                                                                      |
| **D2** (LLMClient interface)             | closed 2026-08-02 | `LLMClient` interface + per-vendor adapter; default adapter uses `@anthropic-ai/sdk` against MiniMax M3. `FakeLLMClient` test double.                                                                |
| **D3** (per-chunk granularity)           | closed 2026-08-02 | One LLM call per chunk. Cross-chunk relations deferred to merge.                                                                                                                                     |
| **D4** (retry classification)            | closed 2026-08-02 | SDK auto-retries 429/529; we classify: 5xx/network → 3 attempts, 4xx → no retry, format → 1 retry. Mark-and-continue: failed chunk gets `extraction_records.status='failed'` and the batch proceeds. |
| **D5** (relation normalization cascade)  | closed 2026-08-02 | Exact match → synonym table → embedding similarity. `UNMAPPED` is a legal sentinel.                                                                                                                  |
| **D6** (write-layer dedup)               | closed 2026-08-02 | `(head_id, relation_norm, tail_id) + valid_window overlap` is the dedup key. No DB-layer dedup constraint.                                                                                           |
| **D7** (vocabulary governance)           | closed 2026-08-02 | Vocabulary = git-managed TS module + human review + CLI helper (e.g. `listUnmapped`). No growth automation in P0.                                                                                    |
| **Q1** (entity embedding)                | closed 2026-08-02 | `entities.embedding` column, input = `canonical_name + " \| " + description`. Merge-only use, not written to Neo4j.                                                                                  |
| **Q2** (soft merge + hierarchical gates) | closed 2026-08-02 | `entities.merged_into` column (FK → entities.id, `ON DELETE SET NULL`, roll-backable). Gates L0/L1/L2/L3.                                                                                            |
| **Q3** (hybrid algorithm)                | closed 2026-08-02 | Rule + embedding hybrid; gray zone (L3 mid band) → reject; LLM cascade deferred to future ticket.                                                                                                    |
| **Q4** (merge trigger)                   | closed 2026-08-02 | Merge = last step of the extraction pipeline, same execution context.                                                                                                                                |
| **Q5** (gray-zone logging)               | closed 2026-08-02 | Structured log on every gray-zone rejection.                                                                                                                                                         |
| **Q6** (no blocking in P0)               | closed 2026-08-02 | Merge compares against all existing entities; blocking subset interface is reserved (signature accepts `"all" \| Entity[]`).                                                                         |

ADR references (in `docs/adr/`):

- **ADR-0001** — Storage authority (Postgres authoritative, Neo4j read-only projection).

Cross-references:

- spec 1 — `specs/p0-schema.md` (binding contract for the four tables this spec populates; see Open Questions A1, A7 below).
- spec 3 — `specs/p0-integration.md`. This spec exposes a programmatic merge pipeline; spec 3 consumes entities/triples rows produced here.

## Glossary

Terms from `docs/CONTEXT.md` (exact definitions, not redefined here):

- **chunk** — atomic unit of vector storage and retrieval; carries embedding, source_ref, metadata, valid_window.
- **entity** — canonical real-world referent extracted from chunks; carries canonical_name, type, embedding, metadata; resolved via alias merging.
- **triple** — directed typed edge `(head_entity, relation, tail_entity)`; carries confidence, source_chunk_id, valid_window.
- **alias** — surface-form string that resolves to a canonical entity (name variant, abbreviation, spelling).
- **canonical entity** — merged, deduplicated entity that multiple aliases and mentions resolve to.
- **extract_triples** — P0 pipeline: LLM schema-guided triple extraction from chunk text → confidence scoring → canonical entity resolution → store. _(Note: in this spec the CLI is not an MCP tool; the glossary says "TBD" — this spec closes that TBD: CLI is the extraction trigger.)_
- **extraction F1** — fact-level precision and recall for triple extraction, evaluated against human-annotated ground truth.

Terms introduced in this spec (graduation to `docs/CONTEXT.md` deferred to a domain-modeling pass after spec 2 lands):

- **relation_norm** — the normalized relation form used as the graph traversal key. Vocabulary in `src/core/extraction/vocabulary.ts`. `UNMAPPED` is a legal sentinel.
- **vocabulary** — git-managed module holding `ALLOWED` relation set, `ALIASES` synonym map, and `PROMPT_HINT` for LLM prompt construction.
- **extraction_records** — per-chunk status table: `pending → succeeded | failed`, with `error_code` / `error_msg` / `triples_count` / `unmapped_count` and `batch_id` for aggregation.
- **merged_into** — soft-merge pointer on `entities` (nullable FK → entities.id). Survives when the merged entity is later deleted.
- **L0/L1/L2/L3 gate** — hierarchical merge gates: L0 rule-exact, L1 type-reject, L2 description-cosine floor, L3 name+description-cosine mid threshold.
- **mark-and-continue** — batch policy: a failed chunk does not abort the batch; `extraction_records.status='failed'` is the visible record.
- **gray zone** — the L3 cosine band where merge-vs-reject is ambiguous. Default behavior: reject + structured log (per Q5).

## Tech Stack

| Layer             | Choice                                                                                                                                                         | Reason                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Language          | TypeScript strict ESM                                                                                                                                          | Matches spec 1 + project `tsconfig.json` strict.                                                     |
| Runtime           | Node ≥20                                                                                                                                                       | Matches `package.json#engines.node`.                                                                 |
| LLM client        | `@anthropic-ai/sdk` (single new runtime dep)                                                                                                                   | D2 — sole default adapter, pointed at MiniMax M3 via env. SDK owns 429/529 retry + rate limiting. |
| Embedding         | existing `Embedder` interface (`src/core/embedder.ts`) — `NineRouterEmbedder` in prod, `FakeEmbedder` in tests. Dimension matches spec 1 `entities.embedding`. | Reuse, no new dep.                                                                                   |
| Storage           | existing `pg` client + spec 1 schema                                                                                                                           | Reuse.                                                                                               |
| Schema validation | `zod`                                                                                                                                                          | Already a dependency. Used for `ExtractionResponse` shape.                                           |
| Test              | `vitest` + `tsx` (devDep already present)                                                                                                                      | Matches spec 1 test stack.                                                                           |
| Build / typecheck | `tsc`                                                                                                                                                          | Matches existing scripts.                                                                            |
| CLI entry         | `node dist/cli/extract.js` (compiled)                                                                                                                          | No `tsx` runtime dep added; existing `tsx` is devDep for dev mode only.                              |

No new persistent infra. No new background worker. CLI runs to completion.

## Commands

Full executable commands (no tool names without flags):

```bash
# Build (produces dist/cli/extract.js + dist/index.js)
npm run build

# Typecheck
npm run typecheck

# Run extraction CLI against the configured Postgres (env GRAPHRAG_MEMORY_*).
# Default: scans chunks with no 'succeeded' extraction_records row.
npm run extract -- [--batch-size 64] [--dry-run] [--since <iso8601>] [--only-failed]

# Example: dry-run on chunks touched after 2026-08-01
node dist/cli/extract.js --dry-run --since 2026-08-01T00:00:00Z

# Tests
npm test                                    # full suite (stages 0+1 + extraction + merge)
npx vitest run tests/extraction/            # extraction module only
npx vitest run tests/entities/merge.test.ts # merge gates
npx vitest run tests/cli/extract.test.ts    # CLI subprocess e2e

# Inspect unmapped relations after a run
node dist/cli/extract.js --list-unmapped    # prints triples where relation_norm = 'UNMAPPED', grouped by raw, count desc

# Real LLM smoke (NOT in CI; documented manual run)
ANTHROPIC_AUTH_TOKEN=<set in the environment> \
GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
GRAPHRAG_MEMORY_ANTHROPIC_MODEL=MiniMax-M3 \
node dist/cli/extract.js --batch-size 1 --since <timestamp of one chunk>
```

CLI flags:

| Flag              | Effect                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--batch-size N`  | Process at most N chunks per CLI run (default 64).                                                                           |
| `--dry-run`       | Read chunks, simulate extraction, write no rows.                                                                             |
| `--since ISO8601` | Only consider chunks with `created_at >= since`.                                                                             |
| `--only-failed`   | Re-process only chunks whose latest `extraction_records.status = 'failed'`.                                                  |
| `--list-unmapped` | Print triples with `relation_norm='UNMAPPED'`, grouped by `relation_raw`, count desc, and exit. Does not perform extraction. |

## Project Structure

Where new code lives (relative to repo root). Every file listed below stays within the complexity envelope (function ≤ 40 lines target / cyclomatic ≤ 10 hard, file ≤ 500 lines target / ≤ 1000 hard, params ≤ 4); `extract.ts`, `normalize.ts`, `dedup.ts`, `merge.ts` decompose into named helpers rather than one long function.

```text
src/
  core/
    extraction/
      llm-client.ts          # LLMClient interface + AnthropicLLMClient + FakeLLMClient
      extract.ts             # extractChunk(): chunk → ExtractionResponse (validated, retries)
      normalize.ts           # relation_norm cascade: exact → synonym → embedding → UNMAPPED
      vocabulary.ts          # git-managed: ALLOWED / ALIASES / PROMPT_HINT
      dedup.ts               # write-layer dedup (A9 + D6): overlap → merge into existing row
      records.ts             # extraction_records status transitions + listFailed
      prompt.ts              # schema-guided prompt builder from vocabulary
      types.ts               # ExtractionResponse, ExtractionOutput, RetryClass, GateLevel, etc.
    entities/
      merge.ts               # mergeEntities(): L0/L1/L2/L3 + soft merge
      embedding.ts           # computeEntityEmbedding(canonical_name, description) → VECTOR(dim)
      resolve.ts             # resolveCanonicalId(id, maxChainDepth) → canonical UUID (chain walk)
      types.ts               # GateLevel, MergeDecision, GrayZoneLog
  cli/
    extract.ts               # CLI entry: scan chunks → batch → extract → merge → write
  index.ts                   # MCP server entry — UNCHANGED. Must not import extraction/entities.

bin/
  extract.js                 # shebang wrapper for `node dist/cli/extract.js` (npm bin)

tests/
  extraction/
    llm-client.test.ts       # FakeLLMClient, AnthropicLLMClient retry classification (5xx×3, 4xx×1, format×1), backoff curve
    extract.test.ts          # per-chunk happy path + 5-boundary defensive contract (empty/negative/overflow/concurrent/exception)
    normalize.test.ts        # cascade: exact / synonym / embedding / UNMAPPED; threshold sweep
    dedup.test.ts            # overlap semantics; max-confidence; source_chunk_ids accumulation
    records.test.ts          # status transitions; listFailed; batch_id aggregation
    prompt.test.ts           # prompt shape carries vocabulary + schema instructions
  entities/
    merge.test.ts            # L0 exact / L1 type reject / L2 desc reject / L3 mid threshold; soft merge + rollback
    embedding.test.ts        # input shape (canonical_name + " | " + description); reuse from Embedder
    resolve.test.ts          # chain walk, maxChainDepth=16, cycle detection
  cli/
    extract.test.ts          # subprocess e2e: empty DB / batch / dry-run / list-unmapped / exit codes
    isolation.test.ts        # defensive: src/index.ts does not import src/core/extraction/* (regex-based AST scan)
  fixtures/
    fake-embedder.ts         # deterministic embedding (re-uses spec 1 FakeEmbedder pattern if present)
    fake-llm-client.ts       # canned ExtractionResponse
```

`docs/CONTEXT.md` and `docs/adr/` are unchanged in this PR (per Assumption A17).

`src/index.ts`, `src/tools/`, `src/core/storage/`, `src/core/chunker.ts`, `src/core/cosine.ts`, `src/core/embedder.ts`, `src/core/errors.ts`, `src/core/types.ts` — unchanged.

## Code Style

One snippet per concern. Match existing style in `src/core/embedder.ts` and `src/core/storage/backend.ts`.

**LLMClient interface (one method, sealed result type):**

```typescript
// src/core/extraction/llm-client.ts
export type RetryClass = "ok" | "5xx" | "4xx" | "format";
export interface ExtractionOutput {
  head: string;
  headType: string; // open string; L1 type gate enforces consistency
  relationRaw: string;
  relationNorm: string; // may equal 'UNMAPPED'
  tail: string;
  tailType: string;
  description: string; // MANDATORY per Q1(b); LLM client validates non-empty
  evidenceSpan: string; // verbatim substring of chunk content
  confidence: number; // [0,1]
}
export type ExtractionResponse =
  | { kind: "ok"; outputs: ExtractionOutput[] }
  | { kind: RetryClass; message: string };

export interface LLMClient {
  extract(chunkText: string): Promise<ExtractionResponse>;
}
```

**Hierarchical merge gate (single function, deterministic output):**

```typescript
// src/core/entities/merge.ts
export type GateLevel = "L0" | "L1" | "L2" | "L3";
export type MergeDecision =
  | { kind: "merge"; into: string; via: GateLevel; observedCosine: number }
  | {
      kind: "reject";
      reason: string;
      level: GateLevel;
      observedCosine?: number;
    };

export async function mergeEntitiesWithGating(
  incoming: { canonicalName: string; type: string; description: string },
  candidateSet:
    | "all"
    | Array<{
        id: string;
        canonicalName: string;
        type: string;
        description: string;
        embedding?: number[];
      }>,
  ctx: { embedder: Embedder; config: MergeConfig }
): Promise<{ canonicalId: string; decision: MergeDecision | "created-new" }> {
  // L0 normalize-exact + type same → merge
  // L1 type mismatch → reject
  // L2 desc cosine < floor → reject
  // L3 name+desc cosine ≥ mid → merge; else reject (gray zone)
}
```

Naming conventions (matching `src/core/embedder.ts`):

- camelCase for functions and variables, PascalCase for types.
- snake_case for SQL column names; DB row objects use the original `snake_case` keys; TypeScript callers may rename to camelCase locally but never in the SQL layer.
- No abbreviations except standard ones (`ctx`, `cfg`, `dim`, `id`).
- `*Error` suffix for typed error classes; no generic `Error` thrown from this spec.

Comments explain **why** (per project rule), not what. Example: `// Q4: merge is last step of extraction, same execution context`.

**Complexity envelope** (binding, mirrors spec 1): no function in this spec's files exceeds **40 lines** (target) / cyclomatic **10** hard cap; no nesting beyond **2** levels; no function takes more than **4** parameters (use a single options object — `mergeEntitiesWithGating(incoming, candidateSet, ctx)` already does); no file exceeds **500 lines** (target) / **1000** hard cap. When a function approaches a cap, decompose it into a named helper — the L0/L1/L2/L3 gates are four sequential branches, not nested ifs.

## Testing Strategy

Framework: **vitest** (existing). Locations above. Levels:

| Level              | Concern                                                                                                                                                                                                                                                                                                                          | Coverage target                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Unit               | `extract`, `normalize`, `dedup`, `records`, `merge`, `embedding`, `resolve`, `prompt`                                                                                                                                                                                                                                            | ≥90% line, ≥85% branch                                                                             |
| Contract           | `LLMClient` interface — `FakeLLMClient` matches real `AnthropicLLMClient` response shape exactly                                                                                                                                                                                                                                 | All `RetryClass` branches covered (5xx, 4xx, format, ok)                                           |
| Integration        | Real Postgres 16 + spec 1 schema; `extraction_records` status round-trip; soft-merge + chain walk; dedup overlap semantics                                                                                                                                                                                                       | All four tables touched                                                                            |
| CLI                | subprocess `spawn` of compiled `dist/cli/extract.js`; exit codes (0 success, 1 error, 2 partial); `--dry-run` and `--list-unmapped` paths                                                                                                                                                                                        | At least one full-batch happy + one failure-recovery test                                          |
| Defensive contract | 5 boundary classes per defensive contract validation: empty chunk / negative (chunk_id missing, content over max) / overflow (chunk larger than LLM context window → 4xx class) / concurrent (two CLI runs against same chunks, second sees first's records) / exception (LLM SDK throws → classification + status) | All 5 classes covered for the public surface (`extractChunk`, `mergeEntitiesWithGating`, `runCli`) |
| Isolation          | `src/index.ts` must not import from `src/core/extraction/*` or `src/core/entities/merge` (per Assumption A11). Test parses the module's source AST or grep for `import .* from .*core/(extraction\|entities)`.                                                                                                                   | Single test, fail-fast                                                                             |

CI: `npm test` (no real LLM calls). Real LLM smoke is documented as a manual run; recorded in PR description.

## Boundaries

**Always do**:

- Run `npm run typecheck` + `npm test` before commit; both must exit 0.
- Follow existing naming (camelCase TS, snake_case SQL, `*Error` suffix).
- Validate `chunk.content` size and presence before calling `LLMClient.extract`.
- Use `UNMAPPED` sentinel literal only in code paths that explicitly handle it; never silently coerce.
- Write extraction_records in the **same transaction** as the triples/entities it describes (per D6 + Q2).
- Emit a structured gray-zone log entry for every merge rejection at L1/L2/L3 (per Q5).
- Treat `relation_norm='UNMAPPED'` as a queryable bucket; `--list-unmapped` is a first-class command.

**Ask first** (any of these = new PR + new spec discussion):

- Adding/removing/renaming any column on `entities`, `triples`, `entity_aliases`, `extraction_records`, `chunks`.
- Adding a new runtime dependency beyond `@anthropic-ai/sdk`.
- Changing the `LLMClient` interface signature or adding new vendor adapters.
- Modifying `src/index.ts`, `src/tools/*`, `src/core/storage/*`, or `src/core/chunker.ts`.
- Adding a unique constraint, exclusion constraint, or DB-level dedup (per D6 = "no DB-layer dedup").
- Replacing or upgrading `zod`, `pg`, `@modelcontextprotocol/server`, or `@modelcontextprotocol/client`.

**Never do**:

- Import any symbol from `src/core/extraction/*` or `src/core/entities/merge` from `src/index.ts` or any `src/tools/*` file (per Q2 + D8).
- Make the extraction CLI an MCP tool or expose it via `tools/list`.
- Write to Neo4j in this spec. Neo4j is a P1 concern.
- Delete failing tests to make builds pass; lower assertion strength without operator approval (project rule).
- Hard-code API keys, base URLs, or model names in source. All come from env (`config.ts` SSOT).
- Treat `relation_raw` as a traversal key. Graph traversal keys on `relation_norm`.
- Skip the gray-zone structured log on a rejected merge.

## Success Criteria

Each criterion is binary (yes/no) and maps to a measurable check.

1. `npm run typecheck` exits 0.
2. `npm test` exits 0; full suite (stage 0+1 + extraction + merge + CLI) green; no regression in spec 1's `tests/schema-p0.test.ts`.
3. `npm run build` produces `dist/cli/extract.js` and `dist/index.js`; neither file imports the other.
4. **CLI smoke (in-memory / fake-LLM mode)**: `node dist/cli/extract.js --dry-run --batch-size 1` against a fresh Postgres with one chunk populated exits 0 and writes no rows.
5. **End-to-end happy path**: with `FakeLLMClient` returning a fixed `ExtractionResponse`, running the CLI populates (a) ≥1 row in `entities`, (b) ≥1 row in `triples` linked via `source_chunk_id`, (c) one row in `extraction_records` with `status='succeeded'`, `triples_count ≥ 1`.
6. **Failure isolation**: with `FakeLLMClient` returning `{kind: '5xx', message: ...}` for the third chunk only, the CLI exits 0, writes 4 succeeded + 1 failed `extraction_records`, and `listFailed()` returns exactly the failed chunk.
7. **Dedup overlap**: inserting the same `(head, relation_norm, tail)` triple with overlapping `valid_window` does not create a second row; the existing row's `confidence` becomes `max(existing, new)` and a `source_chunk_ids` array accumulates both source chunks (per Assumption A9).
8. **Merge gate L0**: two entities with `normalizeAlias(name_a) === normalizeAlias(name_b)` and same `type` merge on insert.
9. **Merge gate L1**: same name, different `type` → reject; structured log emitted with `level='L1'`.
10. **Merge gate L2**: same name + type, but description cosine < floor → reject; log with `level='L2'`, `observedCosine` recorded.
11. **Merge gate L3**: same name + type + desc above L2 floor, name+desc cosine ≥ mid → merge; below mid → reject (gray zone); log with `level='L3'`.
12. **Soft merge + rollback**: merged entity remains resolvable via `resolveCanonicalId(loserId)`; deleting the survivor nulls `merged_into` (FK ON DELETE SET NULL), enabling manual rollback.
13. **`--list-unmapped`**: produces output grouped by `relation_raw` with count desc; exits 0; does not invoke the LLM.
14. **Isolation test passes**: `src/index.ts` contains no imports from `src/core/extraction/*` or `src/core/entities/merge`.
15. **Defensive contract (5 boundary classes)** for `extractChunk`, `mergeEntitiesWithGating`, `runCli` — all 5 classes (empty / negative / overflow / concurrent / exception) tested.

## Open Questions

These items are tracked for implementation reference. Items 1–7 were resolved by `T1 [decision]` on 2026-08-07 (answers recorded in the committing message and locked into `MergeConfig` defaults / `vocabulary.ts` header / package.json). Items 8–9 are still open (see below).

### RESOLVED 2026-08-07 (T1)

1. **[RESOLVED] L3 "middle threshold" — single floor or band?** → **Single floor at `0.5`** (P0c prototype verdict; band mode is the documented alternative via `MergeConfig.l3NameDescHighThreshold` / `l3NameDescLowThreshold` — switchable if Bootstrap data mandates). Default pinned in `MergeConfig`.
2. **[RESOLVED] L2 description floor value.** → **`0.30`** (P0c prototype verdict). Default pinned in `MergeConfig.l2DescLowThreshold`.
3. **[RESOLVED] Description minimum length for L2.** → **`8`** characters. Descriptions shorter than 8 chars skip L2 and proceed straight to L3. Default pinned in `MergeConfig.minDescriptionLength`.
4. **[RESOLVED] `maxChainDepth` for `resolveCanonicalId`.** → **`16`** (configurable; cycle detection via visited set). Default pinned in `MergeConfig.maxChainDepth`.
5. **[RESOLVED] L0 fast-path — add description-coherence check?** → **No** description check at L0 (keeps L0 cost=0; documented limitation). L0 fast = name exact + type same, per Q3 hybrid algorithm.
6. **[RESOLVED] Vocabulary entry freeze timing.** → **Initial vocabulary lands with this implementation (≤36 entries).** Frozen-on date and frozen-by recorded in `src/core/extraction/vocabulary.ts` header. Growth automation deferred; `--list-unmapped` is the human-review signal.
7. **[RESOLVED] `@anthropic-ai/sdk` version.** → **`0.115.0`** (latest stable as of 2026-08-07; verified via `npm view @anthropic-ai/sdk version`). Pinned in `package.json#dependencies`. Per Boundaries, any version bump = Ask-first.

### Still open (out of T1 scope)

8. **CLI `--list-unmapped` scope.** Counts over `triples.relation_norm='UNMAPPED'` (per spec 1 schema, single table). If human-review needs `relation_raw` surface instead of relation-row count, add `--by-raw` flag in a follow-up.
9. **Spec 1 Open Question alignment.** This spec assumes the three spec-1 Open Questions are resolved as documented in `specs/p0-schema.md` (`uuid v4`, app-level dedup, `CREATE IF NOT EXISTS`).

## Out of scope

- **Retrieval integration** (spec 3). The graph-arm code lives there; this spec only produces the data it consumes.
- **Evaluation harness implementation**. The eval gate's three-axis + Bootstrap shape is closed; this spec lands the data the eval will measure, not the harness itself.
- **Neo4j projection sync** (P1). P0 doesn't read Neo4j.
- **Cross-chunk relation bridging**. Per-chunk granularity (D3) means cross-chunk relations are resolved at the entity merge step, not at extraction. (E.g. "Alice works at Acme" in chunk 1 + "Acme is in NYC" in chunk 2 do not produce a 3-edge triple in P0.)
- **Multimodal extraction** (images, tables). Out of scope; LLM input is text only.
- **Streaming / incremental LLM calls**. Per-chunk granularity uses request/response, not streams.
- **Auto-promotion of `UNMAPPED` raw forms into the vocabulary**. Per D7: human review + CLI helper only.

---

## Architecture-Change-Reviewer verdict

5/5 yes — PASS. Cleared 2026-08-07 (initial review 4 yes / 1 unclear on complexity-anti-drift; envelope added per fix; re-review 5 yes).

- **bounded-context-guardian — yes**. Spec slices by business capability (`extraction/` vs `entities/merge.ts` vs `cli/extract.ts`); `src/index.ts` + `src/tools/` forbidden from importing extraction/entities; spec 1 schema contract consumed not rewritten.
- **defensive-contract-validator — yes**. Testing Strategy enumerates all 5 boundary classes (empty / negative / overflow / concurrent / exception) for the public surface; coverage targets ≥90% line / ≥85% branch; Success Criterion #15 makes 5-class coverage binary.
- **error-handling-enforcer — yes**. Sealed tagged unions (`ExtractionResponse`, `MergeDecision`); `*Error` suffix mandated; CLI exit codes 0/1/2 documented; input validation before LLM call; `UNMAPPED` is an explicit sentinel, never a silent coerce.
- **complexity-anti-drift — yes**. Binding envelope pinned (function ≤ 40 lines target / cyclomatic ≤ 10 hard, nesting ≤ 2, params ≤ 4, file ≤ 500 lines target / ≤ 1000 hard); L0/L1/L2/L3 decomposition hint; Project Structure reinforces for the four hot files.
- **minimal-change-verifier — yes**. Explicit out-of-scope list; sole new runtime dep = `@anthropic-ai/sdk` per D2; spec 1's per-file envelope precedent mirrored.

Hand to `writing-plans`.

## Assumption gate record (locked 2026-08-07)

All 17 assumptions (A1–A17) presented in the spec-driven-development session were confirmed by operator with no corrections or removals. Recorded verbatim above in Architectural Constraints / Tech Stack / Project Structure / Boundaries / Open Questions.
