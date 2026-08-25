# Plan: P0 Wiring Closure — Map #1 production gaps (G1–G8)

**Goal:** The already-merged P0 components fire on the real
`ingest → extract → retrieve` path: every live entity carries an embedding
and a description, the LLM prompt carries the vocabulary, `relation_norm`
is cascade-vetted, alias rows exist, the graph arm returns hits without
`degraded`, and retrieve p95 is back inside the spec-3 #17 budget.
**Approach:** One write-side slice closes the extract persist path
(embedding + description + aliases together — they share the insert
moment and the #6 Q1 embedding-text SSOT); the remaining gaps are
independent outcomes sliced per gap (cascade vetting, prompt wiring,
merge hardening, two CLI flags, retrieval latency levers), each closed by
its own binary Success Criterion. Two closure probes end the round: the
end-to-end graph-arm-fires integration test and the spec-3 #17 latency
re-measurement with its inherited re-plan exit. Out of scope stays out:
no Neo4j, no DDL change, no new dependency, no frozen-surface change.
**Spec link:** `specs/p0-wiring-closure.md` (binding contract; SC = its
Success Criteria numbering; A# = its ASSUMPTIONS numbering)
**ACR:** all-yes (2026-08-25; 5-line verdict block pasted below)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review →
verification-before-completion → one commit on the ticket branch
**Tracker:** FALLBACK — local `plans/p0-wiring-closure.md` only. The
GitHub Issues API returns 403 for this integration token (`issues=read`
denied), which is the no-usable-`gh`-auth condition in
`writing-plans/references/tracker.md`; no issues were created and no
native blocking edges exist on the tracker. The `[blocks:]` annotations
in this file are the source of truth.

## architecture-change-reviewer verdict

Pasted from `specs/p0-wiring-closure.md` §Architecture Change Reviewer
(gate run 2026-08-25 against the declared structure):

bounded-context-guardian: yes — no new context and no technical-layer slicing: all five source files stay inside their existing capability slices (`cli` / `core/extraction` / `core/entities` / `core/retrieval`), G3 closes inside the adapter with no cycle (`prompt.ts` imports only `vocabulary.js`), G5 is confirmed internal to `core/retrieval` (`src/tools/retrieve.ts` calls only `assembleRetrievalResult`), and the #7 Q2 isolation guard is an explicit constraint with its test kept green.
defensive-contract-validator: yes — Testing Strategy + Success Criteria allocate all 5 boundary classes: empty (SC5 second-run 0-backfill, `--list-failed` empty case, existing 0-seed short-circuit), negative/invalid (SC8 invalid `relationNorm` → cascade → UNMAPPED, SC10 `"all"`), overflow/volume (SC5 N-row backfill, #17 populated-DB ≥100/≥500/≥1000 procedure), concurrent (SC12b arm-concurrency probe, SC9 duplicate `(entity_id, alias)` re-insert), exception (SC11 throwing FakeLLMClient, SC10 typed error class, inherited fail-open `degraded`).
error-handling-enforcer: yes — every new failure path is named and typed: G7 becomes a typed `*Error` asserted by class, cascade miss is the legal UNMAPPED sentinel (#4 D5), alias conflict is an explicit `ON CONFLICT DO NOTHING`, graph-arm failure keeps the frozen fail-open `degraded`/`failureReason` contract, CLI errors reuse the inherited 0/1/2 exit map, and the G5 budget miss has a declared exit (re-plan, not a silent waiver).
complexity-anti-drift: yes — declared structure keeps one abstraction level per module: logic lands in the owning core modules (cascade in `normalize.ts`, vocabulary prompt in `prompt.ts`, embedding text SSOT `computeEntityEmbeddingText`) while `extract.ts` receives only thin wiring into its existing small helpers (`insertEntity` / `persistOutputs` / `loadEntities` / flag handlers); the file's 562-line soft smell is noted for post-impl review but no god-function/god-file intent is declared.
minimal-change-verifier: yes — one logical objective (wire the latent P0 graph layer into the live `ingest → extract → retrieve` path) whose scope exactly matches the review's G1–G8 gap list with an explicit out-of-scope fence and zero new dependencies; per-gap 1-commit sequencing is deferred to `writing-plans` (split first, then commit per split, per the ACR conflict rule).

OVERALL: PASS — hand to writing-plans.

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: one vertical-slice outcome, one
tag, one commit, headroom for the implementer. No `[decision]` bullets:
the spec's Open Questions section is empty and every fork is settled by a
tagged assumption (A1–A15) — bullets inherit, they do not re-decide.

File-contention note (not a dependency): T1, T2, T5, T6 all touch
`src/cli/extract.ts`. Their outcomes are independent, but within one
session implement them sequentially (suggested order T1 → T2 → T5 → T6)
to avoid same-file conflicts. `[parallel]` below describes the outcome
graph, per the skill.

1. **Extract persist path writes embedding, description, and aliases (G1 + G4 + G6)** — tag: `[implementation]`
   - **Inherits:** A2/#6 Q1 — embedding input is `canonical_name + " | " + description` via `computeEntityEmbeddingText` (SSOT), same embedder and dimension as chunks; A7 — description lives at `entities.metadata` key `description` (JSONB; spec-1 DDL frozen, NO new column — insufficiency = stop and Ask-first); A8 — first-write-wins, entity embedding computed exactly once at insert; A11 — alias policy: `alias_type='name'` row for the canonical name at creation, `alias_type='variant'` on an L0/L3 merge whose incoming surface form differs from the survivor's canonical name, all inserts `ON CONFLICT (entity_id, alias) DO NOTHING`; A13 (read half) — the entity loader also returns the stored embedding and description so merge candidates carry them.
   - **Surface:** `src/cli/extract.ts` entity persistence (existing `insertEntity` / `persistOutputs` / `loadEntities` helpers) + the existing CLI and real-PG integration suites.
   - **Acceptance:** SC3 — after a FakeLLMClient + FakeEmbedder CLI run on real Postgres, `SELECT count(*) FROM entities WHERE retired = false AND embedding IS NULL` is 0 and `seedEntitiesByEmbedding` returns ≥1 row; SC6 — created entities carry `metadata->>'description'` equal to the extraction output's description, and an L2 rejection test passes with both descriptions loaded from the database (not injected in-memory); SC9 — creation writes the `name` alias row, a differing-surface L3 merge writes a `variant` row, and re-inserting an identical `(entity_id, alias)` pair neither throws nor duplicates.
   - Status: [x] done — `4efbfb1` (merged `4af15bf`)

2. **`relation_norm` is cascade-vetted before upsert (G2)** — tag: `[implementation]`
   - **Inherits:** A10 — the LLM's claimed `relationNorm` is accepted iff it is a case-insensitive member of `ALLOWED`; otherwise the persisted value is `normalizeRelation(relation_raw, {embedder, threshold: DEFAULT_THRESHOLD})`; `relation_raw` is always stored as received (#3 D3 audit fidelity); #4 D5 — `UNMAPPED` is a legal sentinel, never a silent coerce.
   - **Surface:** `src/cli/extract.ts` triple-persist path consuming `src/core/extraction/normalize.ts`; existing extraction/CLI suites.
   - **Acceptance:** SC8 — claimed `"WORKS_WITH"` (not in ALLOWED) with a synonym-table hit on `relationRaw` persists the vocabulary term; no cascade hit persists `UNMAPPED`; a valid claimed term is kept; `rg -l "normalizeRelation" src/ --glob '!**/*.test.ts'` lists at least one file besides `normalize.ts`.
   - Status: [x] done — `7fd6bfe` (merged `3703805`)
   - [parallel] outcome-independent of T1 (see file-contention note)

3. **`AnthropicLLMClient` sends the vocabulary-carrying prompt (G3)** — tag: `[implementation]`
   - **Inherits:** A6/spec-2 Ask-first — `LLMClient.extract(chunkText)` signature stays frozen; G3 is solved inside the adapter; the vocabulary module (`ALLOWED` / `ALIASES` / `PROMPT_HINT`) is the prompt's term source via `buildExtractionPrompt`.
   - **Surface:** `src/core/extraction/llm-client.ts` + its unit suite (injected fake SDK capturing request params).
   - **Acceptance:** SC7 — a captured `messages.create` request contains every term of `ALLOWED` (via `PROMPT_HINT`), and `rg -l "buildExtractionPrompt" src/ --glob '!**/*.test.ts'` lists at least one file besides `prompt.ts`.
   - Status: [x] done — `8ca051e` (merged `cc3ae1f`)
   - [parallel]

4. **`mergeEntitiesWithGating("all")` throws typed error; L3 reuses stored candidate embeddings (G7)** — tag: `[implementation]`
   - **Inherits:** A14 — `candidateSet === "all"` throws a typed `*Error`-suffix class stating the blocking-subset loader is not wired in P0; the `"all" | Entity[]` signature stays (#6 Q6 reserved shape); A13 — L3 reuses the stored candidate vector when present (one embed for the incoming entity per comparison batch); L2's transient description-only embeddings are unchanged (redefining L2 is out of scope); spec-2 `MergeConfig` defaults frozen.
   - **Surface:** `src/core/entities/merge.ts` + the entities merge unit suite.
   - **Acceptance:** SC10 — the `"all"` call rejects with the typed error class, asserted by class name (not message); a counting FakeEmbedder shows L3 does not re-embed a candidate that carries a stored embedding.
   - Status: [x] done — `655a0dc` (merged `76cd2e7`)
   - [parallel]

5. **`--list-failed` CLI surface (G8)** — tag: `[implementation]`
   - **Inherits:** A15 — prints failed `extraction_records` rows (chunk_id, batch_id, error_code, error_msg, created_at) via the existing `listFailed()`, newest first; optional `--batch-id <uuid>` filter; no LLM call; keyless operation allowed (same class as `--list-unmapped`); exit 0; spec-2 exit-code map 0/1/2 unregressed.
   - **Surface:** `src/cli/extract.ts` flag set consuming `src/core/extraction/records.ts`; CLI subprocess suite.
   - **Acceptance:** SC11 — exits 0 and prints chunk_id / batch_id / error_code for the empty, populated, `--batch-id`-filtered, and keyless cases; a throwing FakeLLMClient proves no LLM call is made; existing flags unregressed.
   - Status: [x] done — `7f9cf4f` (merged `b1667b1`)
   - [parallel]

6. **`--backfill-embeddings` idempotent repair mode (G1 backfill)** — tag: `[implementation]`
   - **Inherits:** A9 — embed and UPDATE every live entity row `WHERE embedding IS NULL` using the stored description (empty string when absent); never runs automatically inside a normal extraction run; #6 Q1 — the same `computeEntityEmbeddingText` SSOT as T1's insert path; CONTEXT.md term **embedding backfill** (already flushed).
   - **Surface:** `src/cli/extract.ts` flag set; real-PG integration suite.
   - **Acceptance:** SC5 — with N pre-existing NULL-embedding live entities the flag exits 0 and leaves 0 NULLs; an immediate second run reports 0 backfilled (idempotency observable in the run output).
   - Status: [x] done — `8b3300d` (merged `7020c14`)
   - [blocks: T1] — consumes T1's metadata-description convention and embedding-text SSOT usage

7. **Retrieve embeds the query once and runs both arms concurrently (G5 levers)** — tag: `[implementation]`
   - **Inherits:** A12 — lever (a): `assembleRetrievalResult` passes its query embedding into the graph arm instead of the arm re-embedding; lever (b): concurrent arm execution; the binding contract is the spec-3 #17 budget, not the lever list; spec-3 frozen envelope (vector-only path returns exactly `{ chunks: [...] }`; `degraded`/`debug` additive-optional) and fail-open graph arm unchanged; internal non-frozen signatures (`runGraphArm` accepting the embedding) may change.
   - **Surface:** `src/core/retrieval/index.ts` + `src/core/retrieval/graph-arm.ts` (internal to `core/retrieval`; `src/tools/retrieve.ts` wiring only) + retrieval unit suites.
   - **Acceptance:** SC12a — exactly one embedder call per `retrieve` invocation when the graph arm is active (counting FakeEmbedder); SC12b — the two arms execute concurrently (start-order probe or timing seam); envelope contract tests stay green.
   - Status: [x] done — `8831736` (merged `b941eb3`)
   - [parallel]

8. **End-to-end closure probe: graph arm fires on a fresh-Postgres run (SC4)** — tag: `[implementation]`
   - **Inherits:** spec "Success looks like" — fresh Postgres → ingest one chunk → CLI extract → `retrieve` with `graphConfig` returns graph-arm hits without `degraded`; #7 Q2 isolation guard; ADR-0001 no-Neo4j.
   - **Surface:** `tests/integration/retrieval-pg.test.ts` extension (FakeLLMClient + FakeEmbedder, real Postgres; loud skip when unreachable per project convention).
   - **Acceptance:** SC4 — the run returns ≥1 chunk contributed by the graph arm and no `degraded` key; SC13 — `tests/cli/isolation.test.ts` green and `rg -n "core/(extraction|entities)" src/index.ts src/tools/` empty; SC14 — `rg -il "neo4j" dist/` empty after `npm run build`.
   - Status: [x] done — `f137f46` (merged `1c4a8a7`)
   - [blocks: T1, T2, T7]

9. **Latency re-measurement per spec-3 #17 with the re-plan exit (SC12c)** — tag: `[implementation]`
   - **Inherits:** spec-3 #17 procedure unchanged — populated DB (≥100 entities / ≥500 triples / ≥1000 chunks), p95 vs the vector-only baseline on the same machine, result recorded in the PR body; A12 — budget still unmet after the levers = re-plan trigger (inherited from spec 3), not an inline patch and not a criterion waiver; relaxing the budget is Ask-first.
   - **Surface:** measurement run (extend `docs/runbooks/integration-smoke.md` procedure as needed) + PR body record; no frozen-surface change.
   - **Acceptance:** SC12c — either retrieve p95 ≤ 1.3× the vector-only baseline is recorded in the PR body, or a re-plan escalation to the operator is recorded as the named exit; no silent pass.
   - Status: [x] done — `bdc752a` (merged `aa1f7b4`); round-close re-measure
     per §7 gives a p95 ratio of 0.98× (median of 3 runs, BUDGET_MET); the
     number still has to be pasted into the PR body.
   - [blocks: T7, T8]

10. **(optional, docs-only) Status lines for `plans/p0-integration.md`** — tag: `[implementation]`
    - **Inherits:** spec Boundaries → Out: "the `plans/p0-integration.md` missing-Status delivery nit (docs-only; belongs to the `writing-plans` slot, not this contract)". Deferred out of this plan-authoring commit to keep it single-purpose; this bullet closes the nit.
    - **Surface:** `plans/p0-integration.md` only — no code, no other plan content changes.
    - **Acceptance:** every T1–T8 ticket in `plans/p0-integration.md` carries a `Status:` line reflecting its landed state; `git diff` for the commit touches only that file.
    - Status: [ ] dropped — `plans/p0-integration.md` still carries no
      `Status:` lines; droppable by its own terms, outside SC1–SC14.
    - [parallel] — droppable without affecting G1–G8 closure

## Dependency graph

```
T1 ─┬─▶ T6
    ├─▶ T8 ─▶ T9
T2 ─┴────▲    ▲
T7 ──────┴────┘        (T7 also blocks T9 directly)
T3 · T4 · T5 · T10 ── [parallel], unblocked, terminal
```

**Parallelizable outcomes:** T2, T3, T4, T5, T7, T10 have no blockers.
T6 waits on T1. T8 waits on T1 + T2 + T7. T9 waits on T7 + T8.
Same-file sequencing for `src/cli/extract.ts` (T1/T2/T5/T6) is a working
constraint, not a dependency — see the file-contention note above.

**Success-criteria coverage:** SC3/SC6/SC9 → T1; SC8 → T2; SC7 → T3;
SC10 → T4; SC11 → T5; SC5 → T6; SC12a/b → T7; SC4/SC13/SC14 → T8;
SC12c → T9. SC1/SC2 (typecheck, build, full suite green) are enforced by
the per-ticket loop on every bullet and re-checked at round close.

## Next session kickoff

- **Branch:** base off `winter/p0-wiring-closure-a71f` (this plan's
  branch; contains spec + ACR + CONTEXT flush + this plan), or off `main`
  once the plan PR merges. One ticket branch per bullet, environment
  naming convention (`winter/<descriptive-name>-<suffix>`).
- **First ticket:** T1 (the critical-severity gap; unblocks T6 and T8).
  T3/T4/T5 are good picks for any parallel capacity — no blockers, no
  shared files with T1.
- **Commands:** `npm run typecheck`, `npm run build`, `npm test` (no real
  LLM in CI); real-PG integration suites need a reachable Postgres 16 +
  pgvector with the spec-1 schema (`DATABASE_URL`) and skip loudly when
  unreachable. Post-extraction SQL probes and `rg` wiring probes are
  listed in `specs/p0-wiring-closure.md` §Commands.
- **Done looks like:** all Status boxes above checked; SC1–SC14 of
  `specs/p0-wiring-closure.md` green; the #17 p95 number (or the re-plan
  escalation) recorded in the PR body; `docs/runbooks/integration-smoke.md`
  re-run with a real LLM + real embedder per the spec's manual row.
- **Round close:** end-of-round code review phase (dual-axis `code-review`
  per this environment), then the post-impl 待写入 flush below.

## 待写入 (persist)

Empty for this plan — no domain term is introduced or changed relative to
`docs/CONTEXT.md` (post-flush of 2026-08-25; **embedding backfill** and
the 11 spec-2/3 carried-over terms are already written). One pending item
is owned by the implementation round, not this plan session: the
CONTEXT.md stage-marker refresh for **entity** / **triple** / **alias** /
**canonical entity** / **extract_triples** fires via `domain-modeling`
only after this plan's bullets land (spec 待写入 item 1,
SKIPPED-UNTIL-IMPL; deferred note already sits under CONTEXT.md →
Flagged ambiguities).

---

_Authored by writing-plans, 2026-08-25, on `winter/p0-wiring-closure-a71f`.
Sequence: spec → ACR → persist → plan (this file). Tracker: local
fallback (Issues API 403 for this token). Next: implementation session
per §Next session kickoff._
