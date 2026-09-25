# Spec: durable corpus index-job orchestration

> **Status:** decision spec, written 2026-09-25. Fixes the cross-repository contract for the durable corpus graph-index job. **T2 landing (2026-09-25):** decisions 1, 2, and 4 are implemented — the `content_identity` column, the `index_jobs` ledger, and the `submit_index_job` / `poll_index_job` wire (ADR-0012; §待写入 records each landing, §Error and status vocabulary carries the settled literals); decision 3's runner stages are the next ticket. Measured T2 validation is in §T2 validation record.
> **Plan:** [`plans/corpus-index-job-orchestration.md`](../plans/corpus-index-job-orchestration.md) (this spec is T1's deliverable).
> **Sibling spec (fin):** [`../../fin/specs/corpus-serve-ingest.md`](../../fin/specs/corpus-serve-ingest.md) — the permanent-upload amendment that consumes this contract.
> **Depends on:** `specs/graph-index-standard-fast.md` (the index-job algorithms: extract methods, projection, Leiden, community summaries), `specs/bounded-source-read.md` (the exact-`source_ref` read boundary), `specs/mcp-tool-surface.md` (the MCP tool catalog this spec extends).

## Goal

A permanent corpus upload that has been pushed as text can trigger a **durable, observable graph-index job** in iknow-memory. The job has a persisted identity and a persisted state readable by a Host (fin), it composes the existing extract / projection / community-summary stages rather than duplicating them, and it reports **corpus-wide graph and C readiness separately** from per-source text-search readiness. A successful `push` never implies graph or C readiness.

This spec records four settled decisions (idempotency key, job-state vocabulary, job-binding granularity, MCP async job wire) and the fin-facing seam they produce. It is a contract, not a suggestion; where a decision was made from alternatives the rejected alternatives are named so a later reader cannot silently reopen them.

**Who uses it:** the iknow-memory implementer of the index-job runner and its MCP tools; the fin implementer wiring the upload job's graph-readiness polling; any Host reading job state.

## Inherits

- `specs/graph-index-standard-fast.md` — owns the algorithms. Extract methods (standard / Fast), canonical merge, prune, hierarchical Leiden, the ledger community summaries + embeddings, and the `community_index_state` singleton are **inherited, not redefined here**. An index job is a new trigger/ledger around those capabilities, never a second copy of them.
- `specs/bounded-source-read.md` — owns the exact-`source_ref` bounded read boundary. This spec does not touch `read_source`.
- `specs/mcp-tool-surface.md` — owns the frozen `{ingest, push, invalidate, extract, retrieve}` catalog, the write-envelope contract, and the statement that `extract` is synchronous and "not a job queue". **Decision 4 below amends that statement**; `extract` itself stays synchronous and is not redefined.
- ADR-0001 / ADR-0004 / ADR-0008 as inherited by `graph-index-standard-fast.md` (Postgres SoR, no re-chunk, Neo4j is a read-only projection).
- fin ADR 0069 (entity descriptions come from the index/extract job, not from push or query) and fin ADR 0043 (raw bytes in the object store, metadata/pointer in fin), inherited through the fin sibling spec.

### Code facts this contract is pinned to (verified, must not be contradicted)

These are the current storage and tool shapes. The contract is written to sit on top of them; any implementation that would break one of them must reopen this spec first.

- `source_documents` columns: `id uuid PK`, `source_ref text UNIQUE`, `title`, `content`, `created_at`, `valid_until`, `status`, `failure_code`, `extract_method`. **There is no `content_identity` column** (`src/core/storage/schema-bootstrap.ts:515-571`). Decision 1 adds one.
  - **Landed (T2):** that fact is now superseded — `source_documents` carries `content_identity text NULL` with a unique index on `(source_ref, content_identity)`, and the new `index_jobs` table is the job ledger (`job_id text PK` derived from the pair, `status` CHECKed to decision 2's four values, `started_at NULL` = queued, `finished_at`, `failure_code`). The cited line numbers pre-date the landing.
- `chunks` columns: `id uuid PK`, `source_ref`, `content`, `embedding`, `valid_from`, `valid_until`, `source_doc_id`, `ordinal`; unique index `chunks(source_doc_id, ordinal)` (`schema-bootstrap.ts:596-598`).
- The existing derived identity: `chunks.id = sha256(JSON([source_ref, content_identity]))` (`src/tools/ingest.ts:184-191`), where `content_identity = sha256(JSON([slice_text, normalizationRuleVersion, parseRuleVersion, parameterTableVersion]))` (`src/tools/ingest.ts:176-183`). This is the invariant decision 1 promotes to a first-class column.
- `source_ref` is an **opaque string** on the iknow side: `push` validates only `z.string().min(1)` (`src/tools/push.ts:78`). iknow never parses its interior.
- Status vocabularies today: `source_documents.status` = `in_progress / ready / failed` (no `stale`; DB CHECK `source_documents_status_check`); `community_index_state` is a corpus-level singleton (`CHECK id = 1`) with `in_progress / ready / stale / failed`.
- `source_documents.status = ready` means **only** "the last push succeeded and at least one chunk row exists". It does **not** mean graph or C is ready.
- MCP has no asynchronous primitive: a tool handler returns a single `ToolResult` (`src/tools/registry.ts:37`); the server advertises only `{ tools: {} }` (`src/index.ts:490`); the `extract` tool is a synchronous JSON call. Decision 4 is shaped by this.
- Of the stages an index job must compose, only extract + merge + persist is callable in-process (`src/core/extraction/pipeline.ts:279`, `processBatch`). The projection drain → Neo4j (`src/cli/graph-drain.ts`) and the community detect+summarize+swap (`src/cli/community-summary.ts:416-519`) are **CLI-only entry points today**. This is a declared integration constraint for T2/T3, not a decision this spec makes.

## Contract

### Decision 1 — idempotency key: a real `content_identity` column

**Chosen: option C.** iknow-memory adds a **first-class `content_identity` column (text) on `source_documents`**, with a **unique constraint on `(source_ref, content_identity)`**.

- **What is elevated.** Today the pair `(source_ref, content_identity)` is only an implicit invariant folded into the derived `chunks.id`. Decision 1 promotes it to a declared, constraint-enforced identity on the 资料 row. `chunks.id` **continues to be derived** exactly as today (`sha256(JSON([source_ref, content_identity]))`); its semantics are now _guaranteed_ by the storage constraint instead of merely assumed by the derivation. No second id scheme is introduced.
- **Wire unchanged.** No new request field, no new envelope shape. **Landed (T2):** iknow derives the stored value itself, from the 资料 body the write already carries, with the existing versioned `computeContentIdentity` (normalization / parsing-rule / parameter versions) applied to the whole body, and writes it in the same 资料 upsert — so no identity field crosses the push wire in either direction. fin's `body_content_id` stays fin-side bookkeeping and is never this column's authority; a submit whose pair disagrees with the stored column is `index_job_identity_mismatch`.
- **Re-push of an unchanged `(source_ref, content_identity)`** is a no-op write: the existing row's `content_identity` is unchanged and the derived chunk ids are unchanged. This is the idempotent arm.
- **A different `content_identity` with the same `source_ref`** is a **new content version for that source**: iknow **OVERWRITE**s the source row's `content_identity` and content, and the rebuild **deletes and replaces** the derived chunks — the prior version's slices are physically dropped by the delete-and-replace write, which is a different mechanism from content _invalidation_ (invalidation closes a validity window and never deletes rows). It never produces two live 资料 rows for one `source_ref` (`source_ref` stays UNIQUE).
- **Backfill / migration strategy.** The column is added **nullable** with `ALTER TABLE source_documents ADD COLUMN IF NOT EXISTS content_identity text NULL`, following the existing forward-compat ALTER pattern in `schema-bootstrap.ts`. **Existing rows keep `content_identity = NULL`** and are **backfilled by the next push** (the push write always declares the current `content_identity`). A row with `NULL` `content_identity` is readable and retrieve-able under today's rules; it simply has no job identity until it is re-pushed. The unique constraint may be created against the nullable column: because `source_ref` is already UNIQUE there is at most one row per `source_ref`, so no `NULL` collision is possible and no partial-index workaround is needed. Backfill is **lazy on re-push**, not a batch data migration — the push path already writes every source it touches, and forcing an eager backfill would require re-sending bodies iknow may not be able to reconstruct for legacy rows.
- **Semantics made explicit by the constraint:** one `source_ref` resolves to exactly one current `content_identity`; the `(source_ref, content_identity)` pair is the job's idempotency key and the fin-side re-push key. The fin sibling spec's "fin's idempotency pair = `(source_ref, content_identity)`" is the other half of this same pair.

**Rejected alternatives (do not reopen):** (A) keep folding the identity into `chunks.id` only, with no column — rejected because a job cannot be idempotently keyed without a declared, queryable source-level identity; (B) a separate side table keyed by the pair — rejected as a second source of truth for one concept when the 资料 row already is the SoR.

### Decision 2 — job-state vocabulary: reuse the four-value C vocabulary

**Chosen: option A.** The new index-job ledger uses the **same four values as `community_index_state`**: `in_progress / ready / failed / stale`.

| Job state     | Meaning                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `in_progress` | The job is durable and not terminal. Covers **both** "submitted, not yet picked up" and "actively running".                                  |
| `ready`       | The job ran every required stage to completion and published a terminal success.                                                             |
| `failed`      | A required stage failed; the job carries a typed `failure_code`. Retry is allowed and re-enters from the failed stage.                       |
| `stale`       | A previously `ready` job's result was invalidated by a later graph change (a new content version for its source, or a corpus-level rebuild). |

- **`queued` vs `running` are not separate states.** They are the same `in_progress`, distinguished by `started_at`: **`NULL` = queued (not yet picked up); non-`NULL` = running**. A consumer that needs the finer distinction reads `started_at`, not a fifth state word. This keeps one status vocabulary across the two readiness ledgers instead of two near-synonyms.
- **`source_documents.status` is not changed.** It stays exactly `in_progress / ready / failed` (no `stale`), and its meaning is unchanged: "the last push succeeded and ≥1 chunk exists". The new job ledger is a **separate table**; a queued or running job must never write `source_documents.status`, and a successful push must never write a job `ready` by itself.
- **Ownership:** per-source text readiness = `source_documents.status`; per-source graph-index job outcome = the new job ledger; corpus-wide C readiness = `community_index_state`. Three distinct facts, three distinct writers.

**Rejected alternatives (do not reopen):** (B) a five-state vocabulary adding `queued`/`running` — rejected because it forks a near-identical vocabulary beside `community_index_state`; (C) reusing `source_documents.status` as the job state — rejected because that column is the text-push status and its CHECK is pinned to three values, and because a job is bound to `(source_ref, content_identity)` while `source_documents.status` is bound to `source_ref` alone.

### Decision 3 — job binding granularity: one job per source

**Chosen: a job binds a single `{document_id, version}` source.** A job is bound to exactly **one `source_ref`** (equivalently, one `(source_ref, content_identity)` pair at submit time) and **does not coalesce work across uploads**. Two uploads produce two jobs, even if they belong to the same `document_id`.

- **Why:** the per-source outcome must be observable per source (fin reports per-source readiness), and the delicate reconciliation of "which uploads did this job cover" would otherwise have to be encoded in the job ledger for no product benefit. Coalescing is deferred; if a future corpus-level batch job is wanted it is a separate ticket, not a change to this binding.
- **Idempotency at submit:** submitting the **same** `(source_ref, content_identity)` again resolves to the **same job** (same `job_id`, same state) — no second job row. This is the job side of decision 1's idempotent arm. A **different `content_identity`** for the same `source_ref` is a new job version; the prior job, if `ready`, becomes `stale`, consistent with the OVERWRITE semantics in decision 1.

**Mapping to the corpus-level C singleton (required by T1):**

The job is per-source; `community_index_state` is a whole-corpus singleton (`CHECK id = 1`, `graph-index-standard-fast.md` Decisions). The mapping is:

1. A job that commits graph rows (its extract/merge/persist arm) **demotes corpus-level C to `stale`** inside the same graph-writing transaction, exactly as the existing extract pipeline already does. A per-source graph change makes the previous summary generation outdated.
2. A job whose final stage performs the corpus-wide **detect + summarize + atomic swap** contributes the whole-graph C back to `ready` **only when that swap commits**. C is never `ready` from a per-source extract alone.
3. Because C is a whole-graph fact, **any** per-source job that completes the summary stage settles C for the whole corpus (the swap is atomic and replaces the whole generation). C is therefore not attributable to one job; job `ready` and C `ready` are correlated but not identical. A job may be `ready` (its own stages finished) while C is `stale`/`in_progress` because a later graph change landed; conversely a job cannot be `ready` while its own required summary stage never ran.
4. **Concurrency:** two jobs must not interleave a partial summary generation. The existing atomic swap is the guarantee; the runner must serialize jobs (or serialize the summary stage) so a partial generation is never served as current C. This is a T2/T3 acceptance constraint, not a new algorithm.
5. Per-source **text** readiness (`source_documents.status = ready`) remains independent of C at all times: text stays retrievable while graph work is queued, running, stale, or failed.

### Decision 4 — MCP async job wire: submit + poll

MCP exposes no server-push or notification primitive, and the server advertises only the `tools` capability (`src/index.ts:490`). The async job wire is therefore a two-call, poll-based contract built from ordinary `tools/call`:

- **Submit tool** — MCP name `submit_index_job` (landed T2). Input selects a source by `source_ref` plus the `content_identity` the caller wants indexed (the pair from decisions 1/3). The handler **persists the job row first**, then returns **immediately** with a **durable `job_id`**: a fresh insert answers the initial state (`in_progress`, `started_at` null), while a join echoes the persisted row's current state rather than a manufactured queue marker. It does **not** run extraction inline and does **not** block until the job is terminal. Reusing the same `(source_ref, content_identity)` returns the same `job_id`, same state. The returned identity is durable across MCP process restart (it is a Postgres row, not in-memory).
- **Poll / status tool** — MCP name `poll_index_job` (landed T2). Input is `job_id`. Output is the **persisted** job state: `job_id`, `source_ref`, `content_identity`, `status`, `started_at` (null = queued), terminal timestamps when present, `failure_code` when `failed`, and a **separate corpus-level graph/C readiness sub-object** read from `community_index_state` — landed as its own sub-object carrying only `{ status, failure_code }` — the two readiness meanings are never merged into one field. Poll is a pure read: it never re-queues a job or mutates C.
- **Reconciliation with `specs/mcp-tool-surface.md`.** That spec states `extract` is "synchronous" and "Not a job queue. Not auto-run inside `ingest` or `push`." Decision 4 **amends the scope of that statement**: it remains true that the **`extract` tool** is synchronous and that neither `ingest` nor `push` auto-runs extract. What this spec **adds** is a **new, separate job primitive** whose orchestration is durable and asynchronous. `extract` is unchanged and is not redefined; the job is a different surface that composes extract plus the projection and summary stages. The `mcp-tool-surface.md` "job queue" exclusion is superseded **only for the new job tools**, not for `extract` and not for `push`/`ingest`. **Landed (T2):** that file carries the supersede note on assumption 9, the two §Catalog rows, §Index-job tool contract, and the amended SC1 `tools/list` set.
- **Reconciliation with the algorithms spec.** The job composes, in order, the existing stages: chunk selection + extract + merge + persist (in-process today via `processBatch`) → projection drain → Neo4j → community detect + summarize + atomic swap. It does not copy any stage's algorithm and it does not re-chunk (ADR-0004). The two CLI-only stages are a declared integration constraint: the runner must be able to invoke them programmatically (lifting them into a callable module, or shelling to the CLI entry) — **which of the two is an implementation choice for T2/T3, not a decision of this spec** — and the job must record a typed failure if either stage cannot run.
- **Empty / invalid / conflict input** (a missing or empty `source_ref` or `content_identity` at submit — the pair is required, not a selector choice — a missing or empty `job_id` at poll, an unknown `source_ref`, a `content_identity` that does not match the source row, a poll of an unknown `job_id`) is a **typed** error, never an empty success. An unknown poll is a named `index_job_unknown_job` miss, mirroring `read_source_not_found`.

**Rejected alternative (do not reopen):** an in-process-only trigger with no persisted identity (e.g. reusing the synchronous `extract` tool as the whole job) — rejected because the job must survive MCP process restart and must be pollable by a Host that did not initiate it in the same connection.

### Cross-repository seam with fin

fin owns the upload, the raw object, deterministic chunking, and `push`. iknow owns the `content_identity` column (decision 1), the index job, and corpus-wide graph/C readiness. The seam is:

1. **fin → iknow, at push time:** fin sends `source_ref` **and** that source's `content_identity` (`body_content_id`) on **every** push, including idempotent re-pushes. `source_ref` remains the exact three-key `{document_id, version, unit}` canonical JSON and **never** contains `content_identity`. iknow stores the received `content_identity` in the decision-1 column. (The wire field and its separator are fin's, defined in the fin sibling spec; iknow treats the value as opaque.) **Landed (T2):** iknow instead stores the identity **it derives** from the pushed body (decision 1), so no field of this name is required on the write wire; what stays binding on both sides is that the pair, not `source_ref` alone, names a content version, and that `source_ref` never carries the identity.
2. **fin → iknow, at index time:** after a successful push, fin submits (or joins) the index job for the `(source_ref, content_identity)` pair through the decision-4 submit tool and receives the durable `job_id`.
3. **fin ← iknow, on poll:** fin reads job state **and** the separate corpus-level graph/C readiness through the decision-4 poll tool. fin may report graph/C readiness **only** by passing through iknow's confirmed corpus-level result.
4. **Readiness boundary (binding on fin):** a successful `push` — or a partial or `stale` index job — **must never** be rendered as graph/C ready. fin's per-source **text** readiness (`source_documents.status = ready` on the iknow side) is a different fact from corpus-wide graph/C readiness and the two are never collapsed into one boolean. fin must not infer graph/C readiness from push success; only iknow's corpus-level `community_index_state` confirms it.
5. **Restart:** the job identity is a Postgres row, so a fin restart resumes status tracking by re-polling the same `job_id`; fin does not re-push a different source version to recover job state.
6. **Out of this spec / out of fin's contract:** fin does not define iknow's column, constraint, job states, or C semantics. Where the fin sibling spec references graph/C readiness it **depends on** this contract and does not restate it.

## Error and status vocabulary

**Job states (decision 2):** `in_progress` (queued when `started_at IS NULL`, running otherwise) · `ready` · `failed` · `stale`.

**Submit-time / poll-time typed errors:** the literals landed with T2 (they close Open Question 1 below); each is returned `isError: true` with a JSON text body `{"error": <literal>, "message": <prose>}` in the `read_source` named-miss style, never an empty success. Submit takes the **pair** — `source_ref` and `content_identity` are both required, there is no selector choice.

| Code                          | Trigger                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `index_job_invalid_locator`   | `source_ref` / `content_identity` / `job_id` absent, empty, or over the 1 024-code-point locator ceiling (oversized values are not echoed) |
| `index_job_unknown_source`    | `source_ref` that has no 资料 row                                                                                                          |
| `index_job_identity_mismatch` | `content_identity` submitted that does not match the source row's current `content_identity`                                               |
| `index_job_unknown_job`       | poll of a `job_id` that has no job row                                                                                                     |
| storage / tool error          | the job row cannot be persisted, or a storage exception on submit/poll                                                                     |

**Job-stage typed outcomes (the job is accepted, then `failed` with `failure_code`), mapping to the inherited algorithms spec's typed failures:**

| Outcome                    | Source of the failure                                                           |
| -------------------------- | ------------------------------------------------------------------------------- |
| empty / empty-Fast extract | `graph-index-standard-fast.md` assumption 4 (Fast on Chinese 资料 → typed fail) |
| two methods on one version | `EXTRACT_METHOD_CONFLICT`                                                       |
| projection-drain failure   | Neo4j projection stage                                                          |
| community-summary failure  | summary job fail → C not-ready (`community_summary_index_failure` token)        |
| embedding failure          | index embedding stage                                                           |
| stage-not-runnable         | a CLI-only stage the runner cannot invoke                                       |

**Conflict / overflow:**

| Code                    | Trigger                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| duplicate submit        | same `(source_ref, content_identity)` → resolves to the same job (not an error)                                                                                                                                                                                                                                              |
| `index_job_in_progress` | a second submit for the same `source_ref` with a different `content_identity` while a job for that source is non-terminal — answered by the pre-check read and, for submits racing past it, enforced by the ledger's one-active-per-source unique index (which persists nothing); the body names that job in `active_job_id` |
| selector overflow       | a submitted chunk batch above the existing ingest batch limit                                                                                                                                                                                                                                                                |

**Not-ready default:** C is not-ready (not `ready`) whenever the summary generation has not been atomically swapped — in-flight, `stale`, or `failed`.

## Acceptance criteria

Each line is binary and maps to `plans/corpus-index-job-orchestration.md` T1/T2/T3.

1. `source_documents` has a `content_identity text NULL` column with a unique constraint on `(source_ref, content_identity)`; existing rows read `NULL` and are filled by the next push; `chunks.id` remains `sha256(JSON([source_ref, content_identity]))`. A re-push of an unchanged pair writes nothing; a changed pair overwrites the source row and the rebuild drops the prior version's chunks (delete-and-replace, not invalidation).
2. The index-job ledger uses exactly `in_progress / ready / failed / stale`; `started_at IS NULL` distinguishes queued from running; `source_documents.status` keeps exactly `in_progress / ready / failed` and is never written by a job.
3. A job is bound to one `(source_ref, content_identity)` and never coalesces two uploads; the same pair resolves to the same `job_id`; a different `content_identity` for a source with a non-terminal job returns a typed conflict; a completed prior job for that source becomes `stale`.
4. The submit tool persists the job and returns a durable `job_id` immediately without running extraction inline; the poll tool returns the persisted state plus a **separate** corpus-level graph/C readiness sub-object. A real Postgres-backed job remains pollable after the MCP process restarts.
5. The job composes the existing extract / projection / community-summary capabilities and re-chunks nothing; a stage failure is a typed `failed` with a `failure_code` and leaves C not-ready; a `ready` job's required stages all completed.
6. No path renders a successful push, or a partial / `stale` job, as graph/C ready. Per-source text readiness and corpus-wide graph/C readiness are separate fields that never collapse into one boolean.
7. Empty / invalid selectors, unknown `source_ref`, mismatched `content_identity`, and unknown `job_id` return typed errors, never empty success. The five boundary classes (empty, invalid/negative, overflow, concurrent, exception) are covered at submit, poll, and worker boundaries.
8. `npm test` and `npm run typecheck` exit 0 without live GDS and without fin.

## T2 validation record

Measured 2026-09-25 (UTC+8 local) on branch `feat/corpus-index-job` at base `7c6e621` + T2 worktree changes; **every row re-measured 2026-09-26 (UTC+8 local, 01:55–02:05) after the second-pass repair (review M1–M5, L1–L4)** — the table carries the repair-pass numbers. PostgreSQL 16 + pgvector from `docker-compose.yml` (`iknow-memory-postgres`), real embedding API, real stdio MCP child processes; Neo4j/ES not required by this surface (stages are T3).

| Command                                                                                                                                                                                                                                                                                                         | Scope                                                            | Result                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                                                                                                                                                                                                                                                                                             | whole project                                                    | exit 0                                                                                                                                                                                                                   |
| `npm run lint:s5`                                                                                                                                                                                                                                                                                               | touched functions                                                | exit 0 — 50 touched function(s) within baseline                                                                                                                                                                          |
| `npx vitest run tests/tools/index-job.test.ts tests/index.test.ts tests/tools/push.test.ts tests/tools/ingest-envelope.test.ts tests/dashboard/sources.test.ts tests/storage/index-jobs-memory.test.ts tests/storage/schema-bootstrap.unit.test.ts tests/tools/read-source.test.ts tests/cli/isolation.test.ts` | unit + fakes + real MemoryBackend ledger                         | exit 0 — 241 passed (9 files)                                                                                                                                                                                            |
| `npx vitest run tests/host-smoke.test.ts`                                                                                                                                                                                                                                                                       | real stdio MCP server process, 8-tool catalog                    | exit 0 — 11 passed                                                                                                                                                                                                       |
| `GRAPHRAG_MEMORY_DB_URL=… npx vitest run tests/schema-bootstrap.test.ts tests/integration/index-jobs-pg.test.ts tests/integration/push-duplicate-source-ref-pg.test.ts tests/integration/read-source-pg.test.ts`                                                                                                | real PG 16/pgvector DDL + ledger + write-path regressions        | exit 0 — 75 passed, 0 skipped (4 files)                                                                                                                                                                                  |
| `npm run build && GRAPHRAG_MEMORY_DB_URL=… npx vitest run tests/integration/index-job-gold-mcp-pg.test.ts`                                                                                                                                                                                                      | golden: real MCP stdio client + real PG, per-run isolated schema | exit 0 — 7 passed (repair pass: two consecutive clean runs, no rate-limit rerun needed; the first-pass note stands — live-embedding rate-limit after batched PG suites is retry-tolerant, no assertion was ever changed) |

Gold GOLD-RECORD (repair-pass measured run `measured_at 2026-09-25T17:59:25Z`, schema `index_gold_913c…f5d4`; the derived ids repeat the first-pass run unchanged, proving determinism across the repair): s1 push→stored identity `e9c7d6dc…38e72`, submit of the returned pair → job `264baccd…233f` `in_progress`/`started_at:null`, poll matches, push response publishes the identity (no recomputation); s2 kill process A, fresh process B polls same `job_id` `f84f73e5…a6a2` → same persisted row, `created_at` 2026-09-26 01:59:20 UTC+8 (**durable across MCP restart**); s3 re-submit same pair → `reused:true`, exactly one row; s4 `index_job_unknown_source` / `index_job_identity_mismatch` / `index_job_unknown_job` over the wire; s5 queued job leaves `source_documents.status=ready` and `community_index_state=stale` untouched, poll shows them as separate fields; s6 second version while job1 active → `index_job_in_progress` with `active_job_id=264baccd…233f`.

## Open Questions

1. ~~Public MCP/CLI error-code **strings** for the job submit/poll surface.~~ **Settled and landed 2026-09-25 (T2):** `index_job_invalid_locator`, `index_job_unknown_source`, `index_job_identity_mismatch`, `index_job_unknown_job`, `index_job_in_progress` — one shared `index_job_` prefix so a Host names the failure class without reading iknow internals, returned `isError: true` with `{"error", "message"}` in the `read_source` style. Aligning the fin 具名失败 spelling stays the sibling spec's own naming task; iknow's literals are the five above. See §Error and status vocabulary, `specs/mcp-tool-surface.md` §Index-job tool contract, and ADR-0012.
2. Whether the CLI-only projection-drain and community-summary stages are **lifted into a callable module** or **invoked through their CLI entries** by the job runner (an implementation choice for T2/T3; either satisfies criterion 5).
3. Job retention / pruning policy for `ready` and `stale` job rows (not required for correctness; deferred).

## Inherits / Changes

**Inherits:** `specs/graph-index-standard-fast.md` algorithms and `community_index_state` singleton; `specs/bounded-source-read.md`; `specs/mcp-tool-surface.md` catalog and write envelope; ADR-0001 / ADR-0004 / ADR-0008; fin ADR 0069 and ADR 0043 through the sibling spec.

**Changes this spec adds:**

1. **`content_identity` first-class column** plus unique constraint `(source_ref, content_identity)`, with lazy re-push backfill; the derived `chunks.id` is unchanged and its invariant is now constraint-enforced.
2. **Durable per-source index-job ledger** with the four-value vocabulary `in_progress / ready / failed / stale`, queued-vs-running via `started_at`; `source_documents.status` unchanged.
3. **Single-source job binding** with an explicit per-source-job ↔ corpus-level-C mapping (graph change demotes C to `stale`; only the atomic summary swap returns C to `ready`; concurrent jobs must serialize the summary stage).
4. **MCP async job wire** — submit returns a durable `job_id`, a separate poll tool reads persisted state; this adds a job primitive while `extract` stays synchronous, amending the "not a job queue" exclusion in `specs/mcp-tool-surface.md` only for the new job tools.
5. **fin seam pinned** — `(source_ref, content_identity)` sent at push, job submitted/joined after push, graph/C readiness a pass-through of iknow's corpus-level state, never inferred from push success.

## Cross-repo contract dependencies

- **fin `specs/corpus-serve-ingest.md`** — the consuming side: it sends `body_content_id = content_identity(...)` beside `source_ref`, polls job state, and reports graph/C readiness only as a pass-through. fin's decision 2 and this spec's decision 1 are the two halves of one pair.
- **`specs/graph-index-standard-fast.md`** — the algorithms the job composes; `community_index_state` is the corpus-level C singleton this spec maps to.
- **`specs/mcp-tool-surface.md`** — the catalog this spec extends with the job submit/poll tools.

## 待写入 (persist after ACR)

- ~~CONTEXT glossary: add **index job** (a durable per-source graph-index job, states `in_progress / ready / failed / stale`, queued vs running via `started_at`), **content_identity** (the first-class `source_documents` column and the `(source_ref, content_identity)` idempotency pair), and the iknow-side split of per-source **text** readiness from corpus-wide **graph/C** readiness.~~ **landed 2026-09-25 (T2)** in `docs/CONTEXT.md` §Pipeline: **content_identity**, **index job**, **readiness split (text vs graph/C)** — plus the **iknow-memory** entry's tool list, which now names `submit_index_job` and `poll_index_job`.
- ~~ADR (new): _Durable corpus index-job orchestration: per-source job binding, the `content_identity` column, and the async MCP job wire._ Records the four decisions and the fin seam.~~ **landed 2026-09-25** as [`docs/adr/0012-durable-corpus-index-job-orchestration.md`](../docs/adr/0012-durable-corpus-index-job-orchestration.md) (accepted; the four decisions, each with its rejected alternatives, plus the fin seam).
- ~~`specs/mcp-tool-surface.md`: add the supersede note that the "not a job queue" exclusion applies to `extract`/`push`/`ingest` but not to the new job tools.~~ **landed 2026-09-25** in that file: the assumption-9 supersede note and the matching header amendment line, the two §Catalog rows, §Index-job tool contract (with the five literals), the §Write envelope contract `content_identity` bullet, the §Boundaries out-of-scope carve-out, and the SC1 frozen `tools/list` set.

## architecture-change-reviewer

bounded-context-guardian: yes — the job ledger and runner stay in iknow-memory's graph-index boundary; the `content_identity` column stays on the 资料 SoR; fin owns upload and text readiness; Postgres remains authoritative and Neo4j a projection; no fin-side graph logic and no new splitter.
input-contract-tests: yes — submit, poll, and worker boundaries each name empty, invalid, overflow, concurrent, and exception cases with typed errors or job states (criteria 1–7; error/state vocabulary tables).
error-handling-enforcer: yes — every stage failure is a typed `failed` with a `failure_code`; unknown lookups are named `unknown_job`; no empty success; no push implies graph/C ready; C not-ready is the default.
complexity-anti-drift: yes — orchestration composes the existing extract, projection-drain, and community-summary capabilities instead of copying them; one status vocabulary is reused instead of forked; the job is a new trigger/ledger, not a second pipeline.
minimal-change-verifier: yes — one logical slice; the only schema addition is one nullable column plus one constraint, the only new vocabulary is one ledger, and the wire adds two tools; PDF parsing, chunking, push semantics, ranking, and graph algorithms stay with their owners.

**OVERALL: PASS — hand to `writing-plans`. Spec path: `specs/corpus-index-job-orchestration.md`.**
