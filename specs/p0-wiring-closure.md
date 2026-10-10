# Spec: P0 Wiring Closure — production gaps from the FINAL review

> **Status:** ACR-passed (architecture-change-reviewer 5-verdict gate, all yes — see §Architecture Change Reviewer).
> **Source:** FINAL code review of the P0 integration round.
> The review's gap list is the scoped ask; this spec turns it into a buildable contract.
> **Predecessor specs:** `specs/p0-schema.md` (spec 1, DDL frozen), `specs/p0-extraction.md`
> (spec 2, pipeline + merge), `specs/p0-integration.md` (spec 3, graph arm + RRF).
> **Predecessor ADRs:** `docs/adr/0001-postgres-authoritative-neo4j-projection.md` (ADR-0001).
> **Predecessor decisions:** P0a, P0b, P0c, P0d — all closed;
> forced choices below are marked ACCEPTED-FROM-MAP, not re-litigated.

## Objective

Close the production-wiring gaps between the P0 code that exists (unit-green,
merged) and the P0 behavior the three predecessor specs promised. Every
component named below is already implemented and tested in isolation; none of
them fires on the real `ingest → extract → retrieve` path. This spec wires
them in, so the next session can implement and the graph layer becomes real
rather than latent.

**Who uses it**: operators running the extraction CLI; MCP hosts calling
`retrieve` and expecting graph-aware results; the future eval harness,
which needs a live data path to measure.

**The gaps, with code evidence** (each row is a review finding; file references
are the current `main`):

| # | Severity | Gap | Evidence |
| --- | --- | --- | --- |
| G1 | CRITICAL | `entities.embedding` never written — `insertEntity` in `src/cli/extract.ts` inserts `(id, canonical_name, type, metadata, retired)` only. The graph-arm seed SQL (`SEED_ENTITIES_SQL` in `src/core/storage/pgvector-backend.ts`) filters `WHERE embedding IS NOT NULL`, so after a real extraction the graph arm yields 0 seeds, always degrades, and never fires. | `src/cli/extract.ts` `insertEntity`; `src/core/storage/pgvector-backend.ts` |
| G2 | HIGH | `normalizeRelation` (`src/core/extraction/normalize.ts`) has zero production callers — `persistOutputs` trusts the LLM's `relationNorm` claim verbatim, so the D5 cascade (exact → synonym → embedding → UNMAPPED) never runs and unvetted strings become graph traversal keys. | `src/cli/extract.ts` `persistOutputs` |
| G3 | HIGH | `buildExtractionPrompt` (`src/core/extraction/prompt.ts`) has zero production callers — `AnthropicLLMClient` sends its own minimal `SYSTEM_PROMPT` that omits the vocabulary (`PROMPT_HINT`), so the LLM never sees the ALLOWED relation terms it is told to use. | `src/core/extraction/llm-client.ts` `SYSTEM_PROMPT` / `callOnce` |
| G4 | HIGH | No description persisted — `loadEntities` hardcodes `description: ""`, so the L2 merge gate (description-cosine floor, `minDescriptionLength = 8`) can never trigger against stored entities: L2 is dead code on the production path. | `src/cli/extract.ts` `loadEntities`; `src/core/entities/merge.ts` `l2DescGate` |
| G5 | MEDIUM | spec-3 Success Criterion #17 (retrieve p95 regression ≤ 30% vs vector-only) unmet — measured ~5×. Known contributors: `assembleRetrievalResult` embeds the query, then `runGraphArm` embeds the same query a second time; the vector arm and graph arm run sequentially. | `src/core/retrieval/index.ts`; `src/core/retrieval/graph-arm.ts` `embedQuery` |
| G6 | MEDIUM | `entity_aliases` never written — the table, its UNIQUE/CASCADE constraints, and the `entity_aliases_alias_idx` cross-entity lookup index (spec 1) have no producer; the "alias-aware graph layer" promised by spec 2's Objective does not exist. | no `INSERT INTO entity_aliases` anywhere in `src/` |
| G7 | LOW | `mergeEntitiesWithGating(_, "all", _)` is a silent no-op — the `"all"` branch maps to an empty candidate list, so every caller using the reserved Q6 shape gets `created-new` unconditionally, with no error. | `src/core/entities/merge.ts` line `candidateSet === "all" ? []` |
| G8 | LOW | `listFailed()` (`src/core/extraction/records.ts`) has no CLI surface — spec 2's "Failed chunks are visible via `listFailed()`" is reachable only from test code. | `src/cli/extract.ts` flag set |

**Success looks like**: a fresh-Postgres `ingest → extract → retrieve` run in
which every entity row carries an embedding and a description, the LLM prompt
carries the vocabulary, `relation_norm` is cascade-vetted, alias rows exist,
the graph arm returns hits without `degraded`, and retrieve p95 is back inside
the spec-3 #17 budget — each proven by the binary criteria below.

## Boundaries

- **Does:** wire G1–G8 into the production path: persist `entities.embedding`
  (input shape per Q1) and description at entity insert; add an idempotent
  embedding backfill path for pre-existing NULL-embedding rows; route the
  production LLM call through the vocabulary-carrying prompt; re-normalize
  `relation_norm` via the D5 cascade before `upsertTriple`; write
  `entity_aliases` rows on entity creation and on merge; make `"all"` a typed
  error instead of a silent no-op; add `--list-failed` to the CLI; eliminate
  the duplicate query embed and sequential arm execution in retrieve, and
  re-measure spec-3 #17.
- **Confirms with human (Ask-first):** any column/index/constraint change on
  the spec-1 tables (this spec plans NONE — description lives in the existing
  `metadata` JSONB; if implementation finds that insufficient, stop and ask);
  any new runtime dependency; any change to the frozen
  `LLMClient.extract(chunkText)` signature or the `retrieve` MCP input shape;
  any change to `MergeConfig` threshold defaults or `RetrieveConfig` defaults;
  relaxing the spec-3 #17 latency budget (per spec 3: failure = re-plan, not
  inline patch); adding HNSW on `entities.embedding`.
- **Out of this spec:** the evaluation harness and the
  T-007 host-harness workstream (whole workstream deferred per review); Neo4j
  connection, projection sync, outbox, read-your-writes (ADR-0001 — P1; not
  reopened); P1 fog (BM25 arm, rerank, PPR, mode bundles); vocabulary growth
  automation (D7); the LLM-judge merge cascade (Q3 reserved); the
  `specs/p0-integration.md` missing-Status delivery nit (docs-only; belongs to
  the `writing-plans` slot, not this contract); `entity_aliases` as an L0
  merge-candidate READ source (write-side only in this round; alias-aware L0
  lookup is a candidate follow-up, see 待写入).

## Architectural Constraints

- **ADR-0001** (`docs/adr/0001-postgres-authoritative-neo4j-projection.md`):
  Postgres is the sole system of record; Neo4j is a read-only projection; P0
  code does not connect to Neo4j at all. Every write in this spec is Postgres.
- **Q2 isolation (inherited spec-2 Never-do):** `src/index.ts` and
  `src/tools/*` must not import from `src/core/extraction/*` or
  `src/core/entities/merge`. `tests/cli/isolation.test.ts` stays green.
- **spec-1 DDL is frozen.** No new columns. G4 uses the existing
  `entities.metadata` JSONB ("open-ended attributes" per spec-1 rationale).
- **spec-2 `LLMClient` interface is frozen** (`extract(chunkText)` — one
  method). G3 is closed inside the adapter, not by widening the interface.
- **spec-3 envelope contract is frozen**: vector-only path returns exactly
  `{ chunks: [...] }`; `degraded`/`debug` stay additive-optional. G5's changes
  are internal to `src/core/retrieval/*` and `src/tools/retrieve.ts` wiring.
- **Q1**: entity embedding input is `canonical_name + " | " + description`
  (`computeEntityEmbeddingText` is the SSOT); one vector, two consumers
  (merge input + graph-arm entity linking); never written to Neo4j.
- **Q4**: merge remains the last step of the extraction pipeline, same
  execution context. No new background worker.
- **D5/D7**: `UNMAPPED` is a legal sentinel; vocabulary is git-managed with
  human review only.

## Glossary

Terms below are exact copies from `docs/CONTEXT.md` (SSOT; only
`domain-modeling` may redefine): **chunk**, **entity**, **triple**, **alias**
("a surface-form string that resolves to a canonical entity (name variant,
abbreviation, spelling). Stored in `entity_aliases` with `entity_id` foreign
key"), **canonical entity**, **valid_window**, **valid_at**, **vector search**,
**ingest**, **retrieve**, **extract_triples**, **Neo4j sidecar** (not
connected in P0). Flagged ambiguity in force: _Postgres authoritative, Neo4j
read-only projection_.

Terms already introduced by specs 2–3 and used here without redefinition:
**relation_norm**, **vocabulary**, **extraction_records**, **merged_into**,
**L0/L1/L2/L3 gate**, **mark-and-continue**, **gray zone**, **graph arm**,
**RRF fusion (k=60)**, **`degraded=true`**, **`RetrieveConfig`**.

## ASSUMPTIONS I'M MAKING

Tag legend: ACCEPTED-FROM-MAP = forced by a closed wayfinder decision, not a
choice. RECOMMENDED = true fork; the stated default is treated as accepted
unless demoted to an Open Question by the operator.

1. **ACCEPTED-FROM-MAP (D1 / ADR-0001):** all writes are Postgres; Neo4j
   stays untouched in P0.
2. **ACCEPTED-FROM-MAP (Q1):** `entities.embedding` input shape is
   `canonical_name + " | " + description` via `computeEntityEmbeddingText`;
   the same embedder as chunks; the same dimension.
3. **ACCEPTED-FROM-MAP (Q2):** server isolation holds — the MCP server
   never imports extraction/entities-merge code; all G1–G8 writes happen in
   the CLI or in `src/core/retrieval/*` read paths.
4. **ACCEPTED-FROM-MAP (D5 + D7):** relation normalization is the
   exact → synonym → embedding → UNMAPPED cascade over the git-managed
   vocabulary; no growth automation.
5. **ACCEPTED-FROM-MAP (Q4):** entity merge stays inside the CLI extraction
   run; no new process or worker.
6. **ACCEPTED-FROM-MAP (spec-2 Ask-first):** `LLMClient.extract(chunkText)`
   signature stays frozen; G3 is solved inside `AnthropicLLMClient`.
7. **RECOMMENDED (G4 fork — column vs metadata):** description is persisted at
   `entities.metadata` under key `description` (JSONB), NOT a new column. The
   spec-1 DDL stays frozen and no Ask-first migration is triggered. If a
   future spec needs indexed/typed description access, a column is that spec's
   Ask-first.
8. **RECOMMENDED (description merge policy):** first-write-wins — the
   survivor's description and embedding are not recomputed when a later
   mention merges in. Entity embedding is computed exactly once, at insert.
9. **RECOMMENDED (G1 backfill):** the CLI gains an idempotent
   `--backfill-embeddings` mode: embed and UPDATE every live entity row
   `WHERE embedding IS NULL`, using the stored description (empty string when
   absent). No automatic backfill inside normal extraction runs.
10. **RECOMMENDED (G2 trust policy):** the LLM's claimed `relationNorm` is
    accepted iff it is a case-insensitive member of `ALLOWED`; otherwise the
    persisted value is `normalizeRelation(relation_raw, {embedder, threshold: DEFAULT_THRESHOLD})`.
    `relation_raw` is always stored as received (audit fidelity, D3).
11. **RECOMMENDED (G6 alias policy):** on entity creation, insert the entity's
    own `canonical_name` with `alias_type='name'`; on a merge decision (L0 or
    L3) where the incoming surface form differs from the survivor's
    `canonical_name`, insert it with `alias_type='variant'`. All alias inserts
    are `ON CONFLICT (entity_id, alias) DO NOTHING`. Alias rows are write-side
    provenance in this round; L0 does not read them yet.
12. **RECOMMENDED (G5 levers):** close the latency gap with (a) one query
    embed per retrieve — `assembleRetrievalResult` passes its embedding into
    the graph arm instead of the arm re-embedding, and (b) concurrent arm
    execution (`Promise.all` over vector search + graph arm). The binding
    contract is the spec-3 #17 budget, not the lever list; if the budget is
    still unmet after the levers, that is a re-plan trigger (inherited from
    spec 3), not an inline patch.
13. **RECOMMENDED (merge candidate embeddings):** `loadEntities` also selects
    `embedding` and `metadata->>'description'`, so L3 reuses the stored
    candidate vector (one embed for the incoming entity per comparison batch)
    instead of re-embedding both sides. L2's description-only cosine keeps
    computing transient embeddings — its input shape differs from the stored
    Q1 vector, and redefining L2 is out of scope.
14. **RECOMMENDED (G7):** `candidateSet === "all"` throws a typed error
    (`*Error` suffix class) stating the blocking-subset loader is not wired in
    P0. The `"all" | Entity[]` signature itself stays (Q6 reserved shape);
    the silent-empty behavior is the bug being removed.
15. **RECOMMENDED (G8 flag shape):** `--list-failed` prints failed
    `extraction_records` rows (chunk_id, batch_id, error_code, error_msg,
    created_at) via the existing `listFailed()`, newest first; optional
    `--batch-id <uuid>` filter; no LLM call; keyless operation allowed
    (same class as `--list-unmapped`); exit 0.

→ Correct me now or these become the spec.

## Tech Stack

**No new dependencies.** Existing stack only: TypeScript strict ESM, Node ≥20,
`pg`, `zod`, `@anthropic-ai/sdk@0.115.0` (pinned by spec 2), existing
`Embedder` interface (`NineRouterEmbedder` prod / `FakeEmbedder` tests),
vitest. Postgres 16 + pgvector with the frozen spec-1 schema.

## Commands

```bash
npm run build                                   # dist/cli/extract.js + dist/index.js
npm run typecheck
npm test                                        # full suite, no real LLM

# New / changed CLI surface
node dist/cli/extract.js --list-failed                      # G8
node dist/cli/extract.js --list-failed --batch-id <uuid>    # G8, filtered
node dist/cli/extract.js --backfill-embeddings              # G1 backfill, idempotent

# Post-extraction probes (against the dev Postgres)
psql "$DATABASE_URL" -c "SELECT count(*) FROM entities WHERE retired = false AND embedding IS NULL"   # expect 0 (G1)
psql "$DATABASE_URL" -c "SELECT count(*) FROM entity_aliases"                                          # expect > 0 (G6)
psql "$DATABASE_URL" -c "SELECT count(*) FROM entities WHERE coalesce(metadata->>'description','') <> ''" # expect > 0 (G4)

# Wiring probes (no production caller → gap not closed)
rg -l "buildExtractionPrompt" src/ --glob '!**/*.test.ts'    # expect ≥2 files (def + caller)
rg -l "normalizeRelation" src/ --glob '!**/*.test.ts'        # expect ≥2 files (def + caller)

# Latency re-measurement: spec-3 #17 procedure unchanged (populated DB:
# ≥100 entities / ≥500 triples / ≥1000 chunks; p95 vs vector-only baseline
# on the same machine; result recorded in the PR body).
```

## Project Structure

Modified files only — no new bounded contexts, no moved files:

```text
src/
  cli/extract.ts                    # G1 G2 G4 G6 G8 G9: persist embedding +
                                    #   metadata.description + aliases; cascade
                                    #   relation_norm; --list-failed;
                                    #   --backfill-embeddings
  core/extraction/llm-client.ts     # G3: AnthropicLLMClient composes its request
                                    #   from buildExtractionPrompt (vocabulary in)
  core/entities/merge.ts            # G7: "all" → typed error; L3 reuses stored
                                    #   candidate embedding when present
  core/retrieval/graph-arm.ts       # G5: accept the query embedding as input
  core/retrieval/index.ts           # G5: single embed; Promise.all over arms
tests/                              # extend existing suites in place:
  cli/extract.test.ts               #   flags, persistence, backfill
  extraction/llm-client.test.ts     #   prompt content assertion
  entities/merge.test.ts            #   "all" error; stored-embedding reuse
  retrieval/graph-arm.unit.test.ts  #   embedding pass-through; embed-call count
  integration/retrieval-pg.test.ts  #   end-to-end graph-arm-fires probe
specs/
  p0-wiring-closure.md              # THIS FILE
```

`src/index.ts`, `src/tools/*`, `src/core/storage/schema-p0.ts` (DDL), and the
spec-2 pipeline modules not named above are unchanged.

## Testing Strategy

Framework: vitest (existing). No real LLM in CI; real-Postgres integration
suites skip loudly when unreachable (project convention).

| Level | What it covers |
| --- | --- |
| Unit | prompt content (ALLOWED terms present in captured Anthropic params via injected fake SDK); relation trust policy (valid claim kept / invalid claim cascaded / no hit → UNMAPPED); `"all"` typed error; L3 stored-embedding reuse (embed-call count with a counting FakeEmbedder); graph arm consumes a passed embedding without re-embedding. |
| Integration (real PG) | after a FakeLLMClient CLI run: every live entity has non-NULL `embedding` and non-empty `metadata->>'description'`; alias rows exist with correct `alias_type`; `seedEntitiesByEmbedding` returns ≥1 seed; full `ingest → extract → retrieve` returns a graph-arm hit without `degraded`; `--backfill-embeddings` fills NULLs and is a no-op on second run; L2 rejection fires against stored (not empty) descriptions. |
| CLI subprocess | `--list-failed` (empty / populated / `--batch-id` filter / keyless) exit codes; existing flags unregressed. |
| Isolation | `tests/cli/isolation.test.ts` unchanged and green (Q2). |
| Manual (runbook) | re-run `docs/runbooks/integration-smoke.md` with a real LLM + real embedder; record the spec-3 #17 p95 measurement in the PR body. |

## Success Criteria

Binary — each maps to a command or measurable check:

1. `npm run typecheck` exits 0; `npm run build` exits 0.
2. `npm test` exits 0 — no regression in spec-1/2/3 suites, isolation test
   included.
3. **G1 closed:** after a CLI extraction run (FakeLLMClient + FakeEmbedder,
   real Postgres), `SELECT count(*) FROM entities WHERE retired = false AND
   embedding IS NULL` returns 0, and `seedEntitiesByEmbedding` returns ≥1 row
   (integration test).
4. **Graph arm fires end-to-end:** fresh Postgres → ingest one chunk → CLI
   extract → `retrieve` with `graphConfig` returns ≥1 chunk contributed by the
   graph arm and no `degraded` key (integration test extending
   `tests/integration/retrieval-pg.test.ts`).
5. **G1 backfill:** with N pre-existing NULL-embedding live entities,
   `--backfill-embeddings` exits 0 and leaves 0 NULLs; an immediate second run
   updates 0 rows (idempotency, asserted via UPDATE count or unchanged
   `xmin`-free probe: repeated run output reports 0 backfilled).
6. **G4 closed:** entities created from outputs carry
   `metadata->>'description'` equal to the extraction output's description
   (integration assert), and an L2 rejection test passes where both
   descriptions are loaded from the database — not injected as in-memory
   strings — proving the production read path feeds the gate.
   不变量：同一 output 的 head/tail 在彼此的合并候选集中互斥；`triples` 不得
   出现 `head_id = tail_id`。一条三元组断言的是两个实体，而两端共享同一条
   `description` 会让 L3 的 name+desc 余弦把 tail 合并进 head。候选集互斥在
   合并前消除这条自环路径；`upsertTriple` 前的 `head_id != tail_id` 断言是
   兜底，违反时按 gray-zone 结构化日志拒绝该三元组（不整批失败）。
7. **G3 closed:** a captured `messages.create` request (injected fake SDK)
   contains every term of `ALLOWED` (via `PROMPT_HINT`), and
   `rg -l "buildExtractionPrompt" src/ --glob '!**/*.test.ts'` lists at least
   one file besides `prompt.ts`.
8. **G2 closed:** with FakeLLMClient emitting `relationNorm: "WORKS_WITH"`
   (not in ALLOWED) and `relationRaw` having a synonym-table hit, the persisted
   `triples.relation_norm` equals the vocabulary term; with no cascade hit the
   persisted value is `UNMAPPED`; with a valid claimed term the claim is kept.
   `rg -l "normalizeRelation" src/ --glob '!**/*.test.ts'` lists at least one
   file besides `normalize.ts`.
9. **G6 closed:** entity creation writes an `alias_type='name'` row for the
   canonical name; an L3 merge with a differing surface form writes an
   `alias_type='variant'` row; re-inserting an identical `(entity_id, alias)`
   pair does not throw and does not duplicate (UNIQUE + DO NOTHING probe).
10. **G7 closed:** `mergeEntitiesWithGating(incoming, "all", ctx)` rejects with
    the typed error class (unit test asserts the class name, not the message).
11. **G8 closed:** `--list-failed` exits 0, prints each failed record's
    chunk_id / batch_id / error_code, supports `--batch-id` filtering, makes no
    LLM call (asserted via a throwing FakeLLMClient), and runs keyless.
12. **G5 closed:** (a) exactly one embedder call per `retrieve` invocation
    when the graph arm is active (counting FakeEmbedder unit assert); (b) the
    two arms execute concurrently (start-order probe or timing seam);
    (c) re-measured per the spec-3 #17 procedure, retrieve p95 ≤ 1.3× the
    vector-only baseline, recorded in the PR body. Budget still unmet after
    the levers = re-plan (inherited spec-3 rule), not a criterion waiver.
13. **Isolation intact:** `tests/cli/isolation.test.ts` passes; `rg -n
    "core/(extraction|entities)" src/index.ts src/tools/` returns nothing.
14. **No Neo4j:** `rg -il "neo4j" dist/` returns nothing after `npm run build`.

## Open Questions

(none — the assumption gate covers every fork; items 7–15 are RECOMMENDED
defaults treated as accepted unless the operator demotes one before PLAN.)

## Inherits / Changes

**Inherits** (this workspace already provides; the contract depends on it):

- Stack: TypeScript strict ESM, Node ≥20, `pg`, `zod`,
  `@anthropic-ai/sdk@0.115.0`, vitest; commands `npm run build` /
  `npm run typecheck` / `npm test`.
- spec-1 frozen DDL: `entities` (with nullable `embedding vector(N)` and
  `metadata jsonb` — both already in place for G1/G4), `entity_aliases`
  (UNIQUE `(entity_id, alias)`, CHECK `alias_type IN
  ('name','variant','abbreviation')`), `triples`, `extraction_records`.
- spec-2 frozen surfaces: `LLMClient.extract(chunkText)`;
  `mergeEntitiesWithGating(incoming, candidateSet, ctx)` signature (Q6
  reserved `"all"`); `MergeConfig` defaults (L2 floor 0.30, L3 0.5, min
  description length 8, maxChainDepth 16); vocabulary module
  (`ALLOWED` / `ALIASES` / `PROMPT_HINT`); CLI exit-code map 0/1/2;
  mark-and-continue; keyless policy (real extraction requires the API key).
- spec-3 frozen surfaces: `retrieve` envelope contract (vector-only = exactly
  `{ chunks: [...] }`; `degraded`/`debug` additive-optional); `RetrieveConfig`
  defaults; RRF k=60 weight 1:1; the #17 latency procedure and 30% budget;
  fail-open graph arm.
- ADR-0001 and the Q2 isolation guard.

**Changes** (what this contract adds):

- `entities.metadata.description` becomes a produced field (JSONB key; no DDL
  change).
- `entities.embedding` gains its producer (insert-time) and a backfill path.
- `entity_aliases` gains its producer (creation + merge writes).
- `triples.relation_norm` becomes cascade-vetted instead of LLM-trusted.
- The production LLM request carries the vocabulary via
  `buildExtractionPrompt`.
- CLI flags: `--list-failed [--batch-id <uuid>]`, `--backfill-embeddings`.
- Internal (non-frozen) signatures: `runGraphArm` accepts the query embedding;
  `assembleRetrievalResult` embeds once and runs arms concurrently;
  `mergeEntitiesWithGating("all", …)` throws a typed error.

## 待写入 (persist list — for `domain-modeling`, not written by this spec)

> Flushed 2026-08-25 by `domain-modeling` on `winter/p0-wiring-closure-a71f`.
> Item statuses below; only item 1 remains pending (post-implementation).

1. **SKIPPED-UNTIL-IMPL** — Stage-marker refresh in `docs/CONTEXT.md`:
   **entity**, **triple**, **alias**, **canonical entity**,
   **extract_triples** entries still read "_Stage: P0 (not yet
   implemented)_"; refresh only after this spec's implementation lands.
   A deferred note now sits under CONTEXT.md → Flagged ambiguities.
2. **FLUSHED** — new term **embedding backfill** written to CONTEXT.md
   (Pipeline section), marked "specified in `specs/p0-wiring-closure.md`;
   not yet implemented".
3. **FLUSHED** — carried-over debt from specs 2–3: all 11 terms were missing
   from CONTEXT.md and are now written — **relation_norm**, **vocabulary**,
   **extraction_records**, **merged_into**, **L0/L1/L2/L3 gate**,
   **mark-and-continue**, **gray zone** (new "Extraction & merge" section);
   **graph arm**, **RRF fusion (k=60)**, **`degraded=true`**,
   **`RetrieveConfig`** (Retrieval section). No duplicates found.
4. **SKIPPED** — alias-aware L0 merge lookup is not a CONTEXT term; the
   CONTEXT format has no future-work section and the ADR three-condition
   gate is not met. It remains recorded here (Boundaries → Out) as the
   candidate follow-up.

## Architecture Change Reviewer

Pre-implementation gate run 2026-08-25 against this contract (declared
structure, not measured code). Verdict block:

bounded-context-guardian: yes — no new context and no technical-layer slicing: all five source files stay inside their existing capability slices (`cli` / `core/extraction` / `core/entities` / `core/retrieval`), G3 closes inside the adapter with no cycle (`prompt.ts` imports only `vocabulary.js`), G5 is confirmed internal to `core/retrieval` (`src/tools/retrieve.ts` calls only `assembleRetrievalResult`), and the Q2 isolation guard is an explicit constraint with its test kept green.
defensive-contract-validator: yes — Testing Strategy + Success Criteria allocate all 5 boundary classes: empty (SC5 second-run 0-backfill, `--list-failed` empty case, existing 0-seed short-circuit), negative/invalid (SC8 invalid `relationNorm` → cascade → UNMAPPED, SC10 `"all"`), overflow/volume (SC5 N-row backfill, #17 populated-DB ≥100/≥500/≥1000 procedure), concurrent (SC12b arm-concurrency probe, SC9 duplicate `(entity_id, alias)` re-insert), exception (SC11 throwing FakeLLMClient, SC10 typed error class, inherited fail-open `degraded`).
error-handling-enforcer: yes — every new failure path is named and typed: G7 becomes a typed `*Error` asserted by class, cascade miss is the legal UNMAPPED sentinel (D5), alias conflict is an explicit `ON CONFLICT DO NOTHING`, graph-arm failure keeps the frozen fail-open `degraded`/`failureReason` contract, CLI errors reuse the inherited 0/1/2 exit map, and the G5 budget miss has a declared exit (re-plan, not a silent waiver).
complexity-anti-drift: yes — declared structure keeps one abstraction level per module: logic lands in the owning core modules (cascade in `normalize.ts`, vocabulary prompt in `prompt.ts`, embedding text SSOT `computeEntityEmbeddingText`) while `extract.ts` receives only thin wiring into its existing small helpers (`insertEntity` / `persistOutputs` / `loadEntities` / flag handlers); the file's 562-line soft smell is noted for post-impl review but no god-function/god-file intent is declared.
minimal-change-verifier: yes — one logical objective (wire the latent P0 graph layer into the live `ingest → extract → retrieve` path) whose scope exactly matches the review's G1–G8 gap list with an explicit out-of-scope fence and zero new dependencies; per-gap 1-commit sequencing is deferred to `writing-plans` (split first, then commit per split, per the ACR conflict rule).

OVERALL: PASS — hand to writing-plans.

affects: src/cli/extract.ts
affects: src/core/extraction/llm-client.ts
affects: src/core/entities/merge.ts
affects: src/core/retrieval/graph-arm.ts
affects: src/core/retrieval/index.ts
affects: tests/cli/extract.test.ts
affects: tests/extraction/llm-client.test.ts
affects: tests/entities/merge.test.ts
affects: tests/retrieval/graph-arm.unit.test.ts
affects: tests/integration/retrieval-pg.test.ts
affects: specs/p0-wiring-closure.md

---

_Authored by spec-driven-development, 2026-08-25. ACR passed 2026-08-25.
Next: persist (待写入 flush via `domain-modeling`); then handoff to
`writing-plans` (sequence fixed: spec → ACR → persist → plan)._
