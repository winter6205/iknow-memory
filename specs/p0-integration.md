# Spec: P0 Integration — Graph-Arm Retrieve + Extraction CLI End-to-End (spec 3 of 3)

> **Status:** draft, awaiting `architecture-change-reviewer` 5-verdict gate.
> **Source ticket:** winter6205/iknow-memory#14 T-P0-integration.
> **Wayfinder parent:** winter6205/iknow-memory#1.
> **Predecessor specs:** `specs/p0-schema.md` (spec 1), `specs/p0-extraction.md` (spec 2).
> **Predecessor ADRs:** `docs/adr/0001-postgres-authoritative-neo4j-projection.md`.
> **Predecessor decisions:** wayfinder #3 (P0a), #4 (P0b), #6 (P0c), #7 (P0d), #5 (P0e).

## Objective

Wire the P0 entity + triple layer (produced by spec 2) into the stage-1
`retrieve` MCP tool as a parallel **graph arm**, fuse both arms with RRF, and
ship a CLI-driven end-to-end loop `ingest → extract → retrieve` that proves
the data path round-trips through real Postgres — without touching Neo4j,
without changing the `retrieve` MCP tool contract, and without re-opening
spec-1 or spec-2 boundaries.

**Who uses it**: MCP hosts call `retrieve` and get graph-aware chunks; ops
runs the extraction CLI out-of-band; the harness eventually runs the
end-to-end smoke (`winter6205/iknow#49` T-007).

**Success looks like** (binary list in §Success Criteria):

- `retrieve` returns graph-arm chunks when extraction has run, vector-arm
  chunks when it has not, both when it has — and the `{chunks[]}` wire shape
  is byte-identical to stage 1.
- A fresh-Postgres run of `ingest → extract → retrieve` exits 0 at each
  step; the final `retrieve` returns at least one chunk that originated from
  an extracted triple's `source_chunk_id`.
- All guardrails in §Boundaries continue to hold.

## Glossary

Surface terms — exact copy from `docs/CONTEXT.md` (the SSOT). Not redefined
here.

- `iknow-memory` — standalone, host-agnostic knowledge memory MCP server.
- `MCP tool`, `host` — protocol and consumer roles.
- `chunk`, `entity`, `triple`, `alias`, `canonical entity` — memory units.
- `valid_window`, `valid_at` — temporal model (`@>` containment, left-closed
  right-open; `valid_until = null` = forever).
- `vector search` — cosine over chunk embeddings (the stage-1 arm).
- `hybrid retrieval` — multi-arm recall fused by RRF; **P0 实现两步：spec-3
  落地 vector + graph 双臂 + RRF (k=60) + 1:1 权重；P1 再加 BM25 / rerank / PPR。**
- `extract_triples` — spec-2 LLM triple extraction pipeline.
- `extraction F1` — evaluation metric (#15 ticket).
- `Neo4j sidecar` — **not connected in P0**; projection sync, outbox, and
  read-your-writes graduate to P1 per ADR-0001 + #7 Q3b/Q3c.

Terms introduced by this spec (graduation to `docs/CONTEXT.md` deferred to a
domain-modeling pass after spec 3 lands):

- **graph arm** — read-side recall path that converts the query embedding
  into a seed set of entities, follows one-hop triples filtered by
  `triples.valid_window @> valid_at`, and joins back to chunks via
  `source_chunk_id`. Read-only Postgres JOIN; no writes.
- **RRF fusion (k=60)** — Reciprocal Rank Fusion with constant `k=60`
  (matches gbrain upgrade guide §3 + spec-2 precedent). Weighted arms in P0:
  `w_vec = w_graph = 1`. The weights are real-number scaling factors; they
  do NOT span cross-arm scores.
- **`degraded=true`** — envelope flag added to the `retrieve` JSON payload
  when the graph arm yielded fewer than `graphArmFloor` chunks (default
  `floor = 3`). The wire shape `RetrieveResult = { chunks: RetrievedChunk[] }`
  stays intact; the flag lives at the top level of the tool's JSON output
  string.
- **`RetrieveConfig`** — frozen-on-read-only config object
  `{wVec: 1, wGraph: 1, entityLinkTopK: 8, candidateCap: 50, graphArmFloor: 3}`
  read from the same env loader as `GraphragEnv`; no new env names
  introduced.

## Tech Stack

| Layer          | Choice                                                          | Reason                                             |
| -------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| Language       | TypeScript strict ESM                                           | Matches spec 1/2 + `tsconfig.json`.                |
| Runtime        | Node ≥20                                                        | Matches `package.json#engines.node`.               |
| Tests          | Vitest + `FakeEmbedder` for unit; real Postgres for integration | Matches spec-2 strategy; no real LLM in CI.        |
| Storage        | Postgres 16 + pgvector + spec-1 schema (no change)              | ADR-0001; existing `pg.Pool` reused.               |
| Graph engine   | **None** (no Neo4j connection in P0)                            | #7 Q1 + ADR-0001 + #1 Decisions-so-far #7 P0d Q1.  |
| LLM (CLI only) | `@anthropic-ai/sdk@0.115.0` (already pinned)                    | spec-2 §Tech Stack; CLI uses `AnthropicLLMClient`. |
| Embedder (CLI) | existing `NineRouterEmbedder` / `FakeEmbedder`                  | No new runtime dep.                                |

**No new runtime dependencies.** No new client / ORM / query builder.
Everything goes through the existing `StorageBackend` `pg.Pool` plus one new
file `src/core/retrieval/graph-arm.ts` and one new file
`src/core/retrieval/rrf.ts`. CLI reuses spec-2 `src/cli/extract.ts` with
**no signature changes** to `runCli` (only two internal switches: `--since`
already exists; this spec adds `--only-failed` only at the wire level —
already in spec-2 §Boundaries; verify in plan).

## Commands

Full executable commands (no tool names without flags):

```bash
# Build (produces dist/cli/extract.js + dist/index.js, mutually non-importing)
npm run build

# Typecheck
npm run typecheck

# Full test suite — must stay green (spec-1 9 + spec-2 15 + spec-3 N)
npm test

# Real-Postgres integration suite — must skip loudly if Postgres unreachable
npx vitest run tests/integration/retrieval-pg.test.ts

# CLI smoke against configured Postgres (env GRAPHRAG_MEMORY_*)
# Lists chunks with no succeeded extraction_records row (default mode)
node dist/cli/extract.js --dry-run --batch-size 1

# Re-process only previously-failed chunks
node dist/cli/extract.js --only-failed --batch-size 4

# List UNMAPPED relations grouped by raw with count desc (no LLM call)
node dist/cli/extract.js --list-unmapped

# End-to-end ground-truth smoke (runbook): ingest → extract → retrieve
# Recorded in docs/runbooks/integration-smoke.md (new, see §Boundaries)
node dist/index.js                  # MCP server; manually drive via host-smoke
node dist/cli/extract.js --batch-size 1 --since 2026-08-01T00:00:00Z
# Then: call retrieve via host harness (winter6205/iknow#49 path) and
# assert ≥1 returned chunk has source_ref matching the ingested chunk.
```

## Project Structure

New files only inside the boundary guarded by spec-1/spec-2:

```text
src/
  core/
    retrieval/                       # NEW bounded context (read-only)
      types.ts                       # ArmHit, ArmResult, FusedHit, RetrieveConfig
      rrf.ts                         # pure RRF fusion (k=60, wVec/wGraph)
      graph-arm.ts                   # pure scoring helper; emits ArmResult
      query-builder.ts               # pure SQL composition; no live DB
      index.ts                       # assemble the two arms into RetrieveResult
    storage/
      backend.ts                     # + one optional method `graphArmSeed()`
      pgvector-backend.ts            # implements graphArmSeed via JOIN
  tools/
    retrieve.ts                      # MODIFIED: adds graph-arm call + RRF fusion
                                     # external contract UNCHANGED (shape)
                                     # adds top-level envelope field degraded
                                     # (non-breaking — additive JSON key)
tests/
  retrieval/
    rrf.test.ts                      # pure-function tests (no DB)
    graph-arm.unit.test.ts           # FakeEmbedder + FakePool seam
  integration/
    retrieval-pg.test.ts             # real Postgres 16 (extends spec-2 harness)
  tools/
    retrieve-graph.test.ts           # contract test: shape unchanged, degraded added
  cli/
    extract-e2e-graph.test.ts        # extends spec-2 #9 harness (subprocess e2e)
  defensive/
    retrieval-defensive.test.ts      # 5 boundary classes (empty / negative /
                                     # overflow / concurrent / exception)
docs/
  runbooks/
    integration-smoke.md             # NEW (analog of spec-2 #10 runbook)
```

No new files in `src/cli/extract.ts` shape (the CLI gains no new flags; only
behavior under existing flags is tightened — verified in plan). No edits to
`schema-p0.ts` (spec-1 DDL is frozen here).

## Code Style

One snippet per concern. Match `src/core/embedder.ts` and
`src/core/storage/backend.ts` style.

**`graph-arm.ts` (pure scoring; no I/O):**

```typescript
// src/core/retrieval/graph-arm.ts
import type { EmbeddingClient } from "../embedder.js";
import type { ChunkRecord } from "../types.js";

export interface GraphArmInput {
  queryEmbedding: number[];
  validAt: string; // ISO 8601
  candidateCap: number; // 50 in RetrieveConfig
  entityLinkTopK: number; // 8 in RetrieveConfig
}

export interface ArmHit {
  chunk: ChunkRecord;
  score: number; // 0..1, monotonic in rank; not a real probability
  source: "vector" | "graph";
}

export interface ArmResult {
  hits: ArmHit[];
  debug: {
    seedEntityIds: string[]; // for logging; never sent to host
    tripleHitsCount: number;
    chunkHitsCount: number;
    candidateCapUsed: number;
  };
}

export async function runGraphArm(
  input: GraphArmInput,
  deps: { embedder: EmbeddingClient; storage: GraphArmStorage }
): Promise<ArmResult> {
  /* ... */
}

export interface GraphArmStorage {
  /** Returns up to topK seed entities (id, canonical_name) by cosine. */
  seedEntitiesByEmbedding(
    embedding: number[],
    topK: number
  ): Promise<Array<{ id: string; canonical_name: string }>>;
  /** Returns chunks joined from one-hop triples filtered by valid_window. */
  chunksByOneHopFromEntities(
    seedIds: string[],
    validAt: string,
    limit: number
  ): Promise<
    Array<{
      id: string;
      content: string;
      source_ref: string;
      valid_window: [string, string | null];
    }>
  >;
}
```

**`rrf.ts` (pure fusion):**

```typescript
// src/core/retrieval/rrf.ts
export function rrfFuse(
  vecHits: ArmHit[],
  graphHits: ArmHit[],
  cfg: { wVec: number; wGraph: number; k: number; /* k=60 */ limit: number }
): FusedHit[] {
  /* deterministic, stable on tie by source vec-first then graph */
}
```

**`StorageBackend` extension (additive, optional):**

```typescript
// src/core/storage/backend.ts (additive — never a breaking change)
export interface StorageBackend {
  upsert(chunks: ChunkRecord[]): Promise<string[]>;
  search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]>;
  close(): Promise<void>;
  /** OPTIONAL — provided by PgvectorBackend; throws on MemoryBackend. */
  graphArmSeed?: GraphArmStorage;
}
```

**`retrieve.ts` (additive envelope field `degraded`):**

```typescript
// src/tools/retrieve.ts (added — existing shape preserved)
export interface RetrieveOutputEnvelope {
  chunks: RetrievedChunk[];
  degraded?: boolean; // true iff graph arm floor not met
  debug?: {
    // only when DEBUG=1; never PII
    graphArmSeedIds?: string[];
  };
}
```

## Testing Strategy

| Level       | Framework      | What it covers                                                                                                                                                                                                                                                                                          |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Vitest         | `rrf.ts` (pure) — k=60, weight 1:1, tie-break, limit truncation, empty arms. `graph-arm.ts` (pure) — topK, candidateCap, candidate-set signature.                                                                                                                                                       |
| Integration | Vitest + PG 16 | Real Postgres 16 with spec-1 schema; `graph-arm.ts` JOIN path; `valid_window @>` filter on both `triples` and `chunks`; one-hop semantics; soft-merge interaction (a `merged_into` chain does not return the loser). Reuses spec-2 `search_path` isolation in `tests/integration/retrieval-pg.test.ts`. |
| Subprocess  | Vitest spawn   | CLI: `--dry-run`, `--since`, `--only-failed`, `--list-unmapped`; exit codes 0/1/2 unchanged; new envelope key `degraded` exposed only when graph arm is active.                                                                                                                                         |
| End-to-end  | Manual runbook | `docs/runbooks/integration-smoke.md` — fresh PG → ingest chunk → CLI extract → host harness retrieve; assert ≥1 returned chunk whose `source_ref` matches the ingested chunk. Recorded in PR body (not CI).                                                                                             |
| Defensive   | Vitest         | 5 boundary classes (empty K=0 / negative K=-1 / overflow K=10⁹ / concurrent two CLIs / PG exception mid-call).                                                                                                                                                                                          |

## Boundaries

**Always do**:

- Run `npm run typecheck` + `npm test` before commit; both must exit 0.
- Follow existing naming (camelCase TS, snake_case SQL, `*Error` suffix).
- Keep `retrieve` MCP tool input/output shape identical; any additive
  envelope field (`degraded`, `debug`) must be optional and stripped when
  absent so existing hosts keep working.
- Validate `RetrieveConfig` at startup; reject negative / non-finite
  weights, `entityLinkTopK ≤ 0`, `candidateCap < entityLinkTopK`,
  `graphArmFloor ≤ 0`. Fail fast with `ConfigError` (exit 1 in CLI; tool
  error envelope in MCP).
- Reuse the existing `pg.Pool`; do not open a second connection / pool.
- Mark the graph arm as best-effort: any thrown error becomes
  `degraded: true` + log at `warn` level with `level='graph-arm'`. Never
  propagate the error to the host — the vector arm is the safety net.
- Honor `valid_at` in BOTH `triples.valid_window @> $valid_at` AND
  `chunks.valid_window @> $valid_at`. A triple whose chunk expired must not
  be returned as if still valid.
- Honor the floor: if `chunksByOneHopFromEntities` returns `< graphArmFloor`
  hits, set `degraded: true` and proceed with vector-only. Do not retry,
  do not widen topK.
- Reuse spec-2 `extraction_records` for `batch_id` aggregation. CLI does
  not need new columns; cleanup behavior is documented in the runbook.

**Ask first** (any of these = new PR + new spec discussion):

- Any column / index / constraint / FK change on spec-1 tables.
- Any new runtime dependency.
- Any change to the `retrieve` tool's input shape (vs. additive envelope).
- Any change to the `extract_triples` pipeline shape (this spec only
  _consumes_ it).
- Changing `RetrieveConfig` defaults (`wVec`, `wGraph`, `entityLinkTopK`,
  `candidateCap`, `graphArmFloor`) after Bootstrap (per spec-2 #5 Q3).
- Replacing the RRF k=60 / weight 1:1 with a different fusion algorithm.

**Never do**:

- Connect to Neo4j in P0 (ADR-0001, #7 Q1).
- Add a new MCP tool. The host-side tool surface stays `ingest` + `retrieve`
  only (#36 D8).
- Open a new `pg.Pool` from `graph-arm.ts`. Reuse the injected storage
  pool.
- Use cross-arm score calibration (MinMax / z-score / sigmoid). P0 keeps
  RRF rank-based fusion to avoid the calibration problem (#14 ticket
  explicitly lists this as a reason).
- Persist any debug payload to disk; `debug` lives only in the envelope and
  is gated on `DEBUG=1`.
- Implement multi-hop traversal (PPR), rerank, or BM25. Those are P1+.

## Success Criteria

Each criterion is binary (yes/no) and maps to a measurable check.

1. `npm run typecheck` exits 0.
2. `npm test` exits 0; full suite (spec-1 9 + spec-2 15 + spec-3 N) green;
   no regression in `tests/schema-p0.test.ts` or `tests/extraction/*` /
   `tests/entities/*`.
3. `npm run build` produces `dist/cli/extract.js` and `dist/index.js`;
   neither file imports the other.
4. **Contract preservation**: feeding the `retrieve` tool a valid stage-1
   payload (against an empty P0 DB — no entities/triples) returns the
   _exact_ JSON shape `{ chunks: [...] }` from stage 1; no extra top-level
   keys; no `degraded`; no `debug`. (Vector-only fallback.)
5. **Envelope extension**: when extraction has run and `graphArmSeed` is
   provided, the tool returns `{ chunks: [...], degraded?: boolean,
debug?: {...} }` where `degraded` is `true` iff `chunksByOneHopFromEntities`
   returned `< graphArmFloor` (default `floor = 3`) hits. Existing hosts
   that ignore unknown keys continue to work.
6. **`@>` filter on triples**: with a triple whose `valid_window` is `[t,
t+1h)` and a query `valid_at = t+1h`, that triple's source chunk is NOT
   returned by the graph arm (right-open boundary).
7. **`@>` filter on chunks**: even if a triple is valid, if its
   `source_chunk_id` points at a chunk whose `valid_window` excludes
   `valid_at`, the chunk is NOT returned.
8. **One-hop limit**: a graph two-hop traversal (entity A → triple → entity
   B → triple → chunk) returns NOTHING from the B-seeded second hop. The
   SQL must terminate at one hop.
9. **RRF math**: a vector-arm hit at rank 1 and a graph-arm hit at rank 1
   for the same `chunk.id` produce a fused rank strictly better (smaller)
   than either alone; `limit` truncation preserves the top `limit` fused
   scores deterministically.
10. **Tie-break**: when vector and graph arms both contain the same
    `chunk.id` at different ranks, the fused result picks the vector rank
    first in ties (documented in `rrf.ts` header).
11. **Floor degradation**: with `graphArmFloor = 3` and graph arm yielding
    2 chunks, the response includes `degraded: true`, returns the vector
    arm's chunks, and does NOT throw.
12. **Concurrent CLI safety**: two concurrent CLI invocations against the
    same Postgres (different `batch_id`s) do not produce duplicate
    `triples` rows; `extraction_records.batch_id` differs across the two
    runs.
13. **Soft-merge interaction**: a graph-arm hit returning a chunk linked
    from a triple whose head/tail entity has `merged_into != NULL` does
    NOT return the loser's other triples. (Only the survivor's triples
    seed the JOIN; loser IDs are not in the seed set.)
14. **No Neo4j connection**: `npm run build` produces no binary referencing
    `neo4j` / `neo4j-driver` / graph API names. Verified by grep on `dist/`.
15. **End-to-end smoke (manual)**: per `docs/runbooks/integration-smoke.md`,
    fresh Postgres → ingest one chunk with known content → run
    `extract` with `--batch-size 1 --since` → run `retrieve` via host
    harness → assert returned chunk has `source_ref` equal to the
    ingested chunk's `source_ref`. Operator runs once; output recorded in
    PR body (not CI).
16. **Defensive contract (5 boundary classes)** for `runGraphArm`,
    `rrfFuse`, `retrieve` graph-arm path — all 5 classes (empty / negative
    / overflow / concurrent / exception) tested.
17. **Latency budget**: with the graph arm active on a populated DB
    (≥ 100 entities, ≥ 500 triples, ≥ 1000 chunks), `retrieve` p95
    latency does not regress more than 30% vs the vector-only baseline
    measured on the same machine (recorded in PR body). Hard threshold;
    failure = re-plan, do not patch inline.

## Architectural Constraints (from ADR + map)

- ADR-0001: Postgres authoritative, Neo4j read-only projection; P0 does
  not connect to Neo4j at all.
- #7 Q1: graph arm uses read-only Postgres JOINs (entity embedding →
  triples → source_chunk_id → chunks). No new tables, no projection
  sync, no outbox, no read-your-writes in P0.
- #7 Q3b / Q3c: projection sync + read-your-writes + idempotent
  consumption are P1 tasks; explicitly out of scope here.
- #5 Q2: ground-truth evaluation is filter-first; this spec ships the
  data path, the harness ships in #15 (separate spec).
- spec-1 DDL is frozen here; no Ask-first schema edits.
- spec-2 `LLMClient` interface is frozen here; this spec only consumes
  spec-2 outputs.
- spec-2 §Boundaries "Always do / Ask first / Never do" three-way
  categorization is inherited as-is.

## Open Questions

RESOLVED by T1 (plan p0-integration, commit message body). Answers below
are binding for T2–T8.

- **`graphArmSeed` interface placement.** RESOLVED: optional method on
  `StorageBackend` (`graphArmSeed?: GraphArmStorage`), additive, never a
  breaking change. `MemoryBackend` does not implement it; `retrieve.ts`
  guards with `?.()`. No `graph-arm.ts` import from `index.ts` /
  `tools/ingest.ts` / `src/cli/extract.ts` (isolation guard).
- **CLI `extraction_records` cleanup runbook detail.** RESOLVED: deferred
  to the spec-2 runbook territory. Spec-3 ships no archive SQL. The smoke
  runbook (T8) documents the retention policy only: succeeded rows
  archived after 30 days, failed rows retained; exact SQL (DELETE vs
  archive table vs PG partition) is out of scope for this spec.
- **`RetrieveConfig` source of truth.** RESOLVED: extend `GraphragEnv`
  with a nested `retrieval` sub-struct holding the five knobs
  (`w_vec` / `w_graph` / `entityLinkTopK` / `candidateCap` /
  `graphArmFloor`). No new `cli.retrieval.*` env namespace. Startup
  validation rejects invalid values with `ConfigError`; `tests/config.test.ts`
  key-set assertions are extended in the same change (T5).
- **End-to-end smoke harness integration with `winter6205/iknow#49` T-007.**
  RESOLVED: spec-3 ships the runbook + the CLI/retrieve data path; T-007
  owns the full host harness gate. The two converge at the runbook level
  (`docs/runbooks/integration-smoke.md`); spec-3 does not reopen T-007.

---

_Authored by spec-driven-development, 2026-08-07. Next step: Step 4 —
`architecture-change-reviewer` 5-verdict gate; then Step 5 — handoff to
`writing-plans` (sequence is fixed: spec → ACR → writing-plans)._
