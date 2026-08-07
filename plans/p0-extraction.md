# Plan: P0 Extraction — LLM Triple Extraction + Canonical Entity Merge

**Goal:** Ship the offline LLM triple-extraction pipeline, canonical entity merge,
relation normalization cascade, and the stand-alone extraction CLI that populate the
four Postgres tables from spec 1 (`entities` / `triples` / `entity_aliases` /
`extraction_records`).
**Architecture:** New bounded contexts `src/core/extraction/` (pipeline) and
`src/core/entities/` (merge), plus `src/cli/extract.ts` (trigger). `src/index.ts`,
`src/tools/`, `src/core/storage/` are unchanged. Neo4j not touched (ADR-0001). New
runtime dep = `@anthropic-ai/sdk` only (#4 D2).
**Tech Stack:** TypeScript strict ESM + `pg` + `zod` + `@anthropic-ai/sdk` +
existing `Embedder` interface. Tests via `vitest` with `FakeLLMClient` +
`FakeEmbedder`; no real LLM calls in CI.
**Spec link:** `specs/p0-extraction.md`
**ACR verdict:** 5/5 yes (2026-08-07; verdict block embedded below).
**Blocked by:** spec 1 (`specs/p0-schema.md` / PR winter6205/iknow-memory#11) — the
DDL this plan populates. Implementation tickets may be written before #11 merges, but
their Postgres integration tests require #11's tables.

## architecture-change-reviewer verdict

1. bounded-context-guardian: yes (slices by business capability; `src/index.ts` forbidden from importing extraction/entities)
2. defensive-contract-validator: yes (all 5 boundary classes named for the public surface)
3. error-handling-enforcer: yes (sealed tagged unions; `*Error` suffix; CLI exit codes 0/1/2)
4. complexity-anti-drift: yes (binding envelope pinned in spec Code Style)
5. minimal-change-verifier: yes (scope tracks #13; sole new dep = `@anthropic-ai/sdk`)

→ spec advances; planning proceeds.

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: vertical slice, one tag, one commit, binary
acceptance. The spec locked the data contract, gate semantics, and complexity
envelope; bullets below test behaviors, not internal decomposition. The per-ticket
loop line is mandatory and verbatim (ADR-0012).

### T1. `[decision]` Resolve the spec's Open Questions

- **Affects:** `specs/p0-extraction.md` (Open Questions section updated; answers
  folded into the spec body where they unblock concrete behavior); no production code.
- **Acceptance:** the spec's Open Questions section is empty (or annotated
  "deferred to `<reason>`") for each of: (a) L3 mid threshold — single floor or band;
  (b) L2 description floor value; (c) description minimum length for L2; (d)
  `maxChainDepth`; (e) L0 fast-path description-coherence check; (f) vocabulary
  freeze timing; (g) `@anthropic-ai/sdk` version pin. The commit message body records
  all answers.
- **Why [decision]:** T2–T10 consume these answers; without them the code would
  either pick a wrong default or block waiting for input.
- **Commit:** 1 commit = this 1 task.

### T2. `[implementation]` Types + `LLMClient` interface + `FakeLLMClient`

- **Affects:** `src/core/extraction/types.ts` (new — `ExtractionOutput`,
  `ExtractionResponse`, `RetryClass`, `GateLevel`, `MergeDecision`, error classes);
  `src/core/extraction/llm-client.ts` (new — `LLMClient` interface +
  `FakeLLMClient`); `tests/extraction/llm-client.test.ts` (new — FakeLLMClient
  contract: all `RetryClass` branches 5xx/4xx/format/ok; retry classification counts
  5xx×3 / 4xx×1 / format×1 per #4 D4).
- **Acceptance:** `npx vitest run tests/extraction/llm-client.test.ts` exits 0; every
  `RetryClass` branch of `ExtractionResponse` is exercised by at least one test.
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** T4, T5
- **Commit:** 1 commit = this 1 task.
- **Status:** [x] complete

### T3. `[implementation]` Relation normalization cascade + vocabulary

- **Affects:** `src/core/extraction/vocabulary.ts` (new — git-managed `ALLOWED` /
  `ALIASES` / `PROMPT_HINT`, ≤ 36 initial entries, freeze-timing header comment);
  `src/core/extraction/normalize.ts` (new — exact → synonym → embedding-similarity →
  `UNMAPPED` sentinel); `src/core/extraction/prompt.ts` (new — schema-guided prompt
  builder from vocabulary); `tests/extraction/normalize.test.ts` + `prompt.test.ts`
  (new — cascade each leg; `UNMAPPED` fallback; threshold sweep .6/.7/.8).
- **Acceptance:** `npx vitest run tests/extraction/normalize.test.ts
tests/extraction/prompt.test.ts` exits 0; a triple whose raw relation matches no
  `ALLOWED` or `ALIASES` entry and scores below the embedding floor resolves to
  `relation_norm='UNMAPPED'`.
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** T4
- **Commit:** 1 commit = this 1 task.
- **Status:** [x] complete

### T4. `[implementation]` Extraction pipeline + dedup + records

- **Affects:** `src/core/extraction/extract.ts` (new — `extractChunk()`: validate →
  `LLMClient.extract` → classify retry → mark-and-continue); `src/core/extraction/
dedup.ts` (new — write-layer dedup: `(head_id, relation_norm, tail_id)` +
  `valid_window` overlap → merge into existing row: max confidence, accumulated
  `source_chunk_ids`); `src/core/extraction/records.ts` (new — `extraction_records`
  status transitions `pending → succeeded|failed`, `listFailed()`, `batch_id`
  aggregation); `tests/extraction/extract.test.ts` + `dedup.test.ts` +
  `records.test.ts` (new).
- **Acceptance:** `npx vitest run tests/extraction/extract.test.ts
tests/extraction/dedup.test.ts tests/extraction/records.test.ts` exits 0; inserting
  the same `(head, relation_norm, tail)` with overlapping `valid_window` does not
  create a second row and accumulates `source_chunk_ids` (Success Criterion #7).
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** T6, T7, T8, T10
- **Commit:** 1 commit = this 1 task.
- **Status:** [x] complete

### T5. `[implementation]` Canonical entity merge gates + embedding + resolve

- **Affects:** `src/core/entities/merge.ts` (new — `mergeEntitiesWithGating()`:
  L0 exact / L1 type-reject / L2 desc-cosine floor / L3 name+desc mid threshold;
  gray-zone reject + structured log); `src/core/entities/embedding.ts` (new —
  `computeEntityEmbedding(canonical_name + " | " + description)`);
  `src/core/entities/resolve.ts` (new — `resolveCanonicalId(id, maxChainDepth)`
  chain walk + cycle detection); `tests/entities/merge.test.ts` + `embedding.test.ts`
  - `resolve.test.ts` (new — one test per gate L0/L1/L2/L3 + soft merge + rollback).
- **Acceptance:** `npx vitest run tests/entities/` exits 0; all four gates (L0 merge,
  L1 type-reject, L2 desc-reject, L3 mid merge + gray-zone reject) each have at least
  one passing test; a merged entity resolves via `resolveCanonicalId(loserId)`.
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** T6, T7, T8
- **Commit:** 1 commit = this 1 task.
- **Status:** [x] complete

### T6. `[implementation]` CLI wiring + isolation guard

- **Affects:** `src/cli/extract.ts` (new — scan chunks with no `succeeded` record →
  batch → extract → merge → write; flags `--batch-size` / `--dry-run` / `--since` /
  `--only-failed` / `--list-unmapped`; exit codes 0/1/2); `package.json` (add
  `extract` script + `bin.extract` entry); `tests/cli/isolation.test.ts` (new —
  asserts `src/index.ts` + `src/tools/*` import nothing from
  `src/core/extraction/*` or `src/core/entities/merge`).
- **Acceptance:** `npx vitest run tests/cli/isolation.test.ts` exits 0; `node
dist/cli/extract.js --dry-run --batch-size 1` against a fresh DB exits 0 and writes
  no rows (Success Criterion #4).
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** T8, T9
- **Commit:** 1 commit = this 1 task.
- **Status:** [x] complete

### T7. `[implementation]` Real Postgres integration tests

- **Affects:** `tests/integration/extraction-pg.test.ts` (new — against a real
  Postgres 16 with spec 1 schema: extraction_records status round-trip; soft merge +
  chain walk; dedup overlap semantics; all four tables touched); reuses spec 1's
  Postgres test harness.
- **Acceptance:** `npx vitest run tests/integration/extraction-pg.test.ts` exits 0
  against a reachable Postgres; if Postgres is unreachable, the suite loudly skips with
  the project's documented Validation block (no silent skip).
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** none (terminal)
- **Commit:** 1 commit = this 1 task.
- **Status:** [x] complete

### T8. `[implementation]` Defensive contract (5 boundary classes)

- **Affects:** `tests/extraction/defensive.test.ts` + `tests/entities/defensive.test.ts`
  - `tests/cli/defensive.test.ts` (new — empty / negative / overflow / concurrent /
    exception for `extractChunk`, `mergeEntitiesWithGating`, `runCli`); may add typed
    error classes to `types.ts` if a boundary reveals a missing one.
- **Acceptance:** `npx vitest run tests/extraction/defensive.test.ts
tests/entities/defensive.test.ts tests/cli/defensive.test.ts` exits 0; each of the 5
  boundary classes has at least one test per public function (Success Criterion #15).
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** none (terminal)
- **Commit:** 1 commit = this 1 task.
- **Status:** [x] complete

### T9. `[implementation]` CLI subprocess e2e

- **Affects:** `tests/cli/extract.test.ts` (new — subprocess `spawn` of compiled
  `dist/cli/extract.js`: empty DB / full-batch happy path / failure-recovery /
  `--dry-run` / `--list-unmapped` / exit codes 0/1/2); uses `FakeLLMClient`.
- **Acceptance:** `npx vitest run tests/cli/extract.test.ts` exits 0; the happy-path
  test populates ≥1 `entities` row, ≥1 `triples` row linked via `source_chunk_id`, and
  one `extraction_records` row with `status='succeeded'` (Success Criteria #5, #6).
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** none (terminal)
- **Commit:** 1 commit = this 1 task.
- **Status:** [x] complete

### T10. `[implementation]` Real LLM smoke + docs

- **Affects:** `docs/runbooks/extraction-smoke.md` (new — manual real-LLM smoke run
  steps, env var names only, no secrets); `.gitignore` (add any smoke scratch files);
  no production code change beyond what T4–T6 already landed.
- **Acceptance:** the runbook documents a runnable `node dist/cli/extract.js
--batch-size 1 --since <ts>` command against a live Anthropic-compatible endpoint;
  operator executes it once and records the output in the PR description (Success
  Criterion: real-LLM smoke run once, exit 0). Not in CI.
- **Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **Blocks:** none (terminal)
- **Commit:** 1 commit = this 1 task.
- **Status:** [x] complete

## Dependency graph

```
T1 [decision]
 ├──▶ T2 (types + LLMClient) ─┐
 └──▶ T3 (normalize + vocab) ─┤
                               ├──▶ T4 (extract + dedup + records) ─┐
                 T2 ──────────▶ T5 (merge + embedding + resolve) ───┤
                                                                    ├──▶ T6 (CLI + isolation) ──▶ T8, T9
                               T4 + T5 ────────────────────────────▶ T7 (Postgres integration)
                               T4 ─────────────────────────────────▶ T10 (real LLM smoke + docs)
```

**Parallelizable:** T2 ∥ T3 (both after T1). T4 ∥ T5 (both after T2; T4 also needs T3).
T6 ∥ T7 (both after T4+T5). T8 ∥ T9 ∥ T10 (after their respective predecessors).

## Cross-references

- **Spec:** `specs/p0-extraction.md` (binding contract; ACR verdict 5/5 yes embedded).
- **Spec 1:** `specs/p0-schema.md` — the four-table DDL this plan populates (PR #11).
- **Wayfinder:** winter6205/iknow-memory#13 T-P0-extraction (parent ticket).
- **Decisions consumed:** wayfinder #3 (six), #4 (seven), #6 (six) — all closed.
- **ADR-0001:** storage authority (Postgres authoritative, Neo4j read-only projection).
- **Evaluator (#15):** this plan lands the data the eval gate measures; the harness
  itself is a separate ticket.

## Open Questions gate

T1 must close before any `[implementation]` bullet that consumes its answers (T2–T10).
If an Open Question is re-opened during execution, stop and route back to
`spec-driven-development` — do not patch the spec inline from a tracer bullet.

## Complexity envelope reminder

Every file in this plan stays within the spec's binding envelope: function ≤ 40 lines
target / cyclomatic ≤ 10 hard, nesting ≤ 2, params ≤ 4, file ≤ 500 lines target /
≤ 1000 hard. `extract.ts`, `normalize.ts`, `dedup.ts`, `merge.ts` decompose into named
helpers rather than one long function.
