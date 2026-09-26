# Spec: MCP tool surface and round boundaries

> **Status:** ACR PASS 2026-09-05 (lift patch). Persist flushed. Plan: `plans/mcp-tool-surface.md`.
> **Assumption gate:** boundaries 2026-09-05; catalog 2026-09-05 (operator accepted the 5-tool list).
> **Depends on:** `specs/graph-rerank-boot-and-evidence.md` (first slice). This spec is the **second slice**.
> **G4 read-source amendment:** `specs/bounded-source-read.md` replaces this file's historical one-call full-body `read_source` response with bounded, resumable slices. The stored full-body **资料** authority and the named missing/invalidated exits remain.
> **Corpus-index-job amendment:** `specs/corpus-index-job-orchestration.md` decision 4 (ADR-0012) adds the two durable job tools `submit_index_job` / `poll_index_job` (§Catalog, §Index-job tool contract). Assumption 9’s “Not a job queue” exclusion still governs `extract`, `ingest`, and `push`; it is superseded **only** for those two tools.

## Objective

Give Hosts a `tools/list` they can finish a memory loop with: write text, close validity, **extract** triples, **retrieve** chunks. Archive the scaffold. One door per job. Names are verbs a stranger can read.

**Who uses it:** any MCP **host** calling iknow-memory; implementers changing the registry after the first slice.

**Success looks like:** `tools/list` is exactly `ingest`, `push`, `invalidate`, `extract`, `retrieve`; `echo` and `invalidation` are gone; `ingest` no longer invalidates; `extract` runs the existing extract pipeline over MCP; retrieve envelope unchanged.

## Glossary

Exact copy from `docs/CONTEXT.md` (not redefined here):

- **iknow-memory**, **MCP tool**, **host**, **chunk**, **triple**, **authoritative source**, **Neo4j sidecar**, **ingest**, **retrieve**, **extract_triples**, **content invalidation**, **mark-and-continue**, **evidence span**

Terms this contract tightens are on the 待写入 list. Until flush, **extract** as an MCP tool name means the same pipeline as **extract_triples**, exposed over `tools/call`.

## Confirmed assumptions (gate · 2026-09-05)

1. Chunks never enter Neo4j. Neo4j stays a read-only projection (ADR-0001).
2. Session memory, generation, prompt assembly, Text2Cypher are out.
3. Host does not get a parallel evidence chain. `retrieve` stays `{ chunks[] }` plus optional `degraded` / `degraded_reasons`. No `citations[]`, no `evidence_span` on Host chunks.
4. Catalog is frozen as the table in §Catalog. Names need not dodge other products.
5. `ingest` and `push` stay two write tools: loose vs strict+idempotent. Do not merge with a mode flag.
6. `invalidation` MCP name becomes **`invalidate`**. Breaking for callers of the old name.
7. `echo` leaves `tools/list`.
8. `ingest` drops `action: "invalidate"`. Invalidation is only `invalidate`.
9. **`extract` is a new MCP tool.** It runs the existing extract pipeline (LLM triples → merge → persist → outbox), synchronously, `mark-and-continue`. Not a job queue. Not auto-run inside `ingest` or `push`. **Superseded in scope (corpus-index-job T2):** that exclusion is about `extract`, `ingest`, and `push` and still binds all three; per `specs/corpus-index-job-orchestration.md` decision 4 (ADR-0012) it no longer excludes the two §Index-job tool contract tools, which add a durable asynchronous job primitive beside the unchanged synchronous `extract`.
10. CLI extract remains for `--dry-run`, `--list-failed`, `--list-unmapped`, `--backfill-embeddings`. MCP `extract` is the write trigger only.
11. MCP `extract` requires a selector: `chunk_ids` **xor** `source_ref`. It does not scan the whole store the way the unscoped CLI does.
12. Descriptions on `tools/list` are for any Host. No “stage 0” / “fin port” jargon.
13. First-slice grounding gate (`evidence span` substring) applies to whatever persist path MCP `extract` uses, once that slice has landed. Do not fork a second extract writer.
14. `src/tools` must not import `src/cli`. Today `processChunk` / `persistOutputs` / `runPipeline` live as CLI-private functions in `src/cli/extract.ts`. This slice **lifts** that persist/batch orchestration into the existing **extract_triples** capability (`src/core/extraction`). The CLI keeps flags and process exit codes; the MCP tool is another caller. Same pipeline, two entry points.

## Catalog

| Name               | Action                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retrieve`         | Keep. Envelope unchanged. Description: ranked chunk search with temporal filter.                                                                                                                                                                                                                                                                                                                             |
| `read_source`      | Add (operator-console T4). Selector `source_ref` xor `id`; returns the full 资料 body `{ id, source_ref, title?, content }`. Miss is a named `read_source_not_found` error result, never a `""` success. An **invalidated** 资料 (T5: window closed) is a distinct named `read_source_invalidated` error result carrying `valid_until`. Pure read: no embedder, no batch limit.                              |
| `ingest`           | Keep write path. Remove `action: "invalidate"` and related fields. One write envelope (T3): `source_ref` + `content` body + `chunks[]` `{ content, index }`; one-slice list allowed (body equals that slice). Legacy single-content / batch shapes accepted during the migration window.                                                                                                                     |
| `push`             | Keep. Same one envelope (T3), stricter: required non-empty metadata, `valid_from` / `valid_until`, idempotent `(source_ref, content_identity)`. Description must not say “fin port”.                                                                                                                                                                                                                         |
| `invalidate`       | Rename from `invalidation`. Same close-window semantics, no physical delete. Operator-console T5: closes the **资料** window (`source_documents.valid_until`) in the same transaction as the derived chunk windows — `read_source` then answers `read_source_invalidated` while every row stays SELECT-able. A same-content re-push keeps the closed 资料 window; a different content version reopens it.    |
| `extract`          | Add. Selector `chunk_ids` xor `source_ref`; reuse existing pipeline; return counts and per-chunk failures.                                                                                                                                                                                                                                                                                                   |
| `submit_index_job` | Add (corpus-index-job T2). Input the `source_ref` + `content_identity` pair (decision 1 of `specs/corpus-index-job-orchestration.md`). Persists the job row **first** and answers at once with a durable `job_id` (`in_progress`, `started_at` null); runs no stage inline, never blocks. Same pair → same `job_id` (join, not a second job). Misses and conflicts are named errors, never an empty success. |
| `poll_index_job`   | Add (corpus-index-job T2). Input `job_id`; returns the **persisted** job state plus a **separate** `community_index_state` sub-object: per-source job readiness and corpus-wide graph/C readiness are never merged into one field. Unknown `job_id` is a named `index_job_unknown_job` miss, mirroring `read_source_not_found`.                                                                              |
| `echo`             | Archive: absent from registry / `tools/list`.                                                                                                                                                                                                                                                                                                                                                                |
| `invalidation`     | Archive the **name**: absent from `tools/list`.                                                                                                                                                                                                                                                                                                                                                              |

### Write envelope contract (operator-console T3)

Both `ingest` and `push` accept one envelope:

```json
{
  "source_ref": "…",
  "content": "<资料 body>",
  "chunks": [{ "content": "…", "index": 0 }]
}
```

- `source_ref` is required — an ingest/push without it is a typed validation error.
- `chunks` are the pre-cut slices (no re-chunking, ADR-0004). Indexes must be dense `0..N-1`; every slice is a contiguous substring of the body in order; a one-slice list must equal the body verbatim.
- Per-chunk content over 1MB → typed `CONTENT_TOO_LARGE` refuse (overflow).
- **资料 SoR row** (`source_documents`) is upserted keyed by `source_ref` — a re-push of the same locator is the concurrent class: same 资料 id, body updated, derived chunks rebuilt (chunks back-point via `source_doc_id` + `ordinal`), 资料 row never physically deleted.
- **`content_identity` (corpus-index-job T2):** the write path also stores the 资料-level content identity on that row (`source_documents.content_identity`, unique together with `source_ref`), computed server-side over the whole pushed body with the existing versioned content-identity hash — no caller-supplied identity field, and the per-slice hash behind the derived chunk ids keeps its own rule. **Both** write tools declare it, `ingest` with the identical derivation `push` uses, so one `source_ref` resolves to exactly one current identity whichever writer touched the row last (a write that omitted it would blank the stored value and turn every later submit for that source into `index_job_identity_mismatch`). Storing it makes the pair addressable by `submit_index_job`; it changes nothing else about the write. `ingest` and `push` stay **write-only** for text status: neither submits, joins, nor advances an index job, and a queued job never rewrites `source_documents.status` or `community_index_state` (the corpus-C demotion stays the extract pipeline’s same-transaction write, per `specs/corpus-index-job-orchestration.md` decision 3).
- Response: `chunk_ids` plus `source_doc_id` (or `source_doc_ids` for legacy batch) and the matching `content_identity` (or `content_identities`, one per 资料 in the same order) — the stored identity is published so a Host can form the `submit_index_job` pair from the response instead of reimplementing the hash, which is the discoverability half of the seam; optional `degraded` / `degraded_reasons` when the derived precision index failed.
- Backward compat: the legacy shapes (`content` as a single string / array of items for `ingest`; `items[]` for `push`) still parse during the migration window and are normalized to one-slice envelopes. Unknown top-level keys are rejected (strict).

## Extract tool contract

**Input (exactly one selector):**

- `chunk_ids`: non-empty list of chunk UUIDs, length ≤ existing ingest batch limit (`readIngestBatchLimit` / `GraphragEnv.ingestBatchLimit`).
- **or** `source_ref`: non-empty string; chunks for that source that do not yet have `extraction_records.status = 'succeeded'` (same pending rule as the CLI scan). Process at most the ingest batch limit; if more pending, return how many were run and that more remain (no silent truncation without that count).

Both set, neither set, empty `chunk_ids`, or over-limit `chunk_ids` → input error (not a successful empty extract).

**Output (JSON text like other tools):** processed count, succeeded count, failed count (mark-and-continue), and failed chunk ids with existing `error_code` shape. Zero pending for a valid `source_ref` is success with zeros, not an error.

**Auth:** same as CLI real extract: missing LLM or embedding credentials that the persist path needs → typed config/tool error, not `FakeLLMClient` / fake vectors.

**Not in this tool:** `--dry-run`, `--list-failed`, `--list-unmapped`, `--backfill-embeddings`, `--only-failed`, `--since` as Host API. Those stay CLI.

## Read source tool contract (operator-console T4)

**Input (exactly one selector):** `source_ref` (non-empty string) **xor** `id` (UUID). Both set or neither set → input error. Unknown keys are rejected (strict).

**Output (JSON text like other tools):** the full 资料 row as stored by the write envelope (T3, `source_documents`): `{ id, source_ref, title?, content }`. `title` is omitted when the row has none. `content` is byte-identical to the pushed body — a read tool: no embedding, no ranking, no batch limit.

**Miss:** a missing key is a **named** not-found — `isError: true` with JSON body `{"error": "read_source_not_found", ...}` carrying back the requested key. It is never a `""` success content block, so a Host can distinguish "no such 资料" from an empty body.

**Invalidated (operator-console T5):** a 资料 whose validity window was closed by `invalidate` answers a distinct **named-invalid** — `isError: true` with JSON body `{"error": "read_source_invalidated", "valid_until": <close instant>, ...}` carrying back the requested key. The row still exists (SELECT-able); the body is just not handed back as if still authoritative.

## Index-job tool contract (corpus-index-job T2)

Two tools over one durable per-source job; the job contract itself (states, C mapping, runner stages) is `specs/corpus-index-job-orchestration.md` decisions 1–4, recorded as a one-way door in ADR-0012. Neither tool runs a graph stage inside its handler.

**`submit_index_job` input:** `source_ref` (non-empty string) **and** `content_identity` (non-empty string) — the pair, not a selector choice. Missing, empty, or over the 1 024-code-point locator ceiling → `index_job_invalid_locator` (an oversized value is never echoed back). The ceiling is `read_source`'s locator budget imported, not restated: submit and read accept exactly one locator domain, so a locator no read tool can carry is never queued as a job. Unknown keys are rejected (strict).

**`submit_index_job` output:** the job row is persisted **before** the call answers, so the returned `job_id` is a Postgres fact that survives an MCP process restart; the id is derived from the pair, not generated per call. The response carries `job_id`, `source_ref`, `content_identity`, the row's `status` and `started_at` as persisted, and `reused` — set from the storage write itself, not from a pre-read, so a racing duplicate submit reports the join honestly. A freshly inserted job reads `status: "in_progress"` with `started_at: null` (queued); a join echoes the persisted row's current state instead, so a worker-started job answers its real `status`/`started_at` rather than a manufactured queue marker. The `job_id` comes from the same content-hash UUID-shape derivation as the chunk ids — the two ledgers share the id _shape_ under one scheme with different hashed inputs, a documented aliasing, not a second id scheme. Nothing is extracted inline and the call never blocks on a stage. Re-submitting the same pair joins the existing job — same `job_id`, same state — it is not an error and not a second row.

**`poll_index_job` input:** `job_id` (non-empty string); an absent, empty, or over-ceiling `job_id` is `index_job_invalid_locator`.

**`poll_index_job` output:** the **persisted** job state — `job_id`, `source_ref`, `content_identity`, `status` (`in_progress` / `ready` / `failed` / `stale`; `started_at` null = queued, non-null = running), `finished_at` when terminal, `failure_code` when `failed` — plus a **separate** `community_index_state` sub-object holding only the corpus-wide pair `{ status, failure_code }`. Per-source job readiness and corpus C readiness are two fields and are never collapsed into one, so a `ready` job never asserts C `ready`. Poll is a pure read: it never re-queues or mutates job or C state.

**Typed errors (`read_source` style):** `isError: true` with a JSON text body `{"error": <literal>, "message": <prose>}` — never an empty success and never a `""` content block.

| Literal                       | Trigger                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index_job_invalid_locator`   | `source_ref` / `content_identity` / `job_id` absent, empty, or over the 1 024-code-point locator ceiling (oversized values are not echoed)                                                                                                                                                                                       |
| `index_job_unknown_source`    | `source_ref` that has no 资料 row                                                                                                                                                                                                                                                                                                |
| `index_job_identity_mismatch` | submitted `content_identity` is not that 资料 row's current one (decision 1's stored column)                                                                                                                                                                                                                                     |
| `index_job_unknown_job`       | poll of a `job_id` with no job row — the poll-side twin of `read_source_not_found`                                                                                                                                                                                                                                               |
| `index_job_in_progress`       | a second submit for the same `source_ref` with a **different** `content_identity` while a job for that source is still non-terminal — answered by the pre-check read and, for submits that race past it, by the ledger's one-active-per-source unique index (which persists nothing); the body names that job in `active_job_id` |

**Not in these tools:** running any stage in the handler, auto-submitting from `ingest` or `push`, a job that coalesces several sources, or a server-push / notification wire (the server advertises only `tools`). The runner that drains the queue stays the job's own path, not a third tool.

## Boundaries

- **Does:**
  1. Freeze and implement the catalog above (registry, schemas, descriptions).
  2. Lift extract batch/persist orchestration from CLI-private functions into `src/core/extraction`; add MCP `extract` and keep CLI as a wrapper over the same module.
  3. Remove ingest-side invalidate action; rename invalidation tool.
- **Confirms with human:** auto-extract on ingest/push; exposing list-failed over MCP; keeping a deprecated `invalidation` alias.
- **Out of this spec:** first-slice boot/logs/evidence implementation (`specs/graph-rerank-boot-and-evidence.md`); session memory; Host citations; generation/prompt; Text2Cypher; SQL graph-arm revival; merging ingest+push; job queue **for `extract` / `ingest` / `push`** (the two corpus-index-job T2 job tools are the named supersede — §Index-job tool contract); `get_chunk` / graph inspect tools.

## Success Criteria

Binary; each maps to a command or measurable check.

1. **Registry:** after start, `tools/list` names are exactly `{retrieve, read_source, ingest, push, invalidate, extract, submit_index_job, poll_index_job}` (order unconstrained). `echo` and `invalidation` absent. **Amendment note:** the 2026-09-05 gate froze this line at the 5-tool set; `read_source` joined at operator-console T4 and `submit_index_job` / `poll_index_job` at corpus-index-job T2, so “exactly” now means the live §Catalog rows. Unit or host-smoke on the registry.
2. **Ingest write-only:** `ingest` with `action: "invalidate"` (or invalidate-only fields without content) is a validation error. Existing ingest of content still returns `chunk_ids`.
3. **Invalidate:** `invalidate` with `source_ref` + `triggered_by` closes windows as today’s invalidation tool; no physical delete; idempotent on identical requests. Existing invalidation tests retargeted to the new name.
4. **Push unchanged contract:** missing required metadata still rejects the whole batch; identical re-push returns the same ids. Existing push tests stay green aside from description text.
5. **Retrieve envelope:** success JSON still `chunks` plus optional `degraded` / `degraded_reasons`; no evidence/citation keys. Existing retrieve tests.
6. **Extract xor selector:** neither / both / empty ids → error. Over-limit `chunk_ids` → error.
7. **Extract by ids:** fake/injected pipeline on two ids, one ungrounded or extract-fail, one success → batch does not abort; counts reflect both; `mark-and-continue`.
8. **Extract by source_ref:** no pending chunks → `{ processed: 0, succeeded: 0, failed: 0 }` (or equivalent zeros), not an error.
9. **Extract no canned persist:** persist path without LLM/embed credentials needed for real extract → typed error, no fake triples/vectors written.
10. **CLI still works:** `npm run extract -- --list-failed` (or the repo’s extract CLI entry) still lists failures; MCP extract does not replace that.
11. **No Neo4j SoR / no chunk text in graph:** projection `subject_kind` remains `entity`/`triple` only.
12. **`npm test` and `npm run build` exit 0.**
13. **No reverse dep:** `src/tools` does not import `src/cli`. CLI extract still calls the lifted core module (existing CLI tests remain the operator entry).

## Open Questions

(none) — alias for old `invalidation` name explicitly deferred (Boundaries / Confirms).

## Inherits / Changes

**Inherits:**

- ADR-0001; ADR-0005 rules 2–4; ADR-0006 graph/rerank boot (server still `loadEnv()` before tools).
- `specs/graph-rerank-boot-and-evidence.md` retrieve envelope and evidence persist gate.
- Extract pipeline today in `src/cli/extract.ts` (scan pending, per-chunk transaction, mark-and-continue, outbox emit) — **moved** into `src/core/extraction` so MCP and CLI share it; CLI-only flags stay in `src/cli/extract.ts`.
- `push` / `ingest` / invalidation storage behaviour already tested.
- Stack: TypeScript strict ESM, Node ≥20, Vitest, `npm test` / `npm run build`.
- MCP registry: `src/tools/registry.ts` + `src/index.ts` `buildRegistry`.

**Changes:**

- CONTEXT **iknow-memory** tool list; **extract_triples** is also an MCP tool named `extract`; **content invalidation** is MCP `invalidate`, not an ingest action; **ingest** has no invalidate action.
- Breaking: MCP name `invalidation` → `invalidate`; `echo` removed; ingest invalidate action removed.

## Tech Stack

Unchanged. No new runtime dependency. Extract tool reuses the existing LLM/embed clients the server already knows how to build.

## Commands

```bash
npm test
npm run build
```

## Testing Strategy (5 boundary classes)

| Class      | Coverage in this spec                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| empty      | `extract` with `source_ref` and zero pending chunks → zeros, success; empty `chunk_ids` → validation error                   |
| negative   | both selectors; neither selector; `ingest` + `action: "invalidate"`; `echo` / `invalidation` names missing                   |
| overflow   | `chunk_ids` longer than ingest batch limit → validation error; `source_ref` with more pending than the cap reports remaining |
| concurrent | two overlapping `extract` calls on distinct chunks do not scramble per-chunk transactions (existing extract isolation)       |
| exception  | missing LLM/embed creds on persist extract → typed error; extract fail on one chunk does not abort the sibling               |

## Architecture Change Reviewer

Planned blast radius (implementation; ≥3 files):

- `src/core/extraction` — lifted batch/persist (today CLI-private `processChunk` / `persistOutputs` / scan)
- `src/cli/extract.ts` — flag/IO/exit-code wrapper; no second persist
- `src/index.ts` — registry membership
- `src/tools/ingest.ts` — drop invalidate action
- `src/tools/invalidation.ts` (or successor) — MCP name `invalidate`
- `src/tools/` extract registration — calls `src/core/extraction`, **never** `src/cli`
- `src/tools/echo.ts` — unregistered (delete or leave unreferenced)
- tests under `tests/tools/` and registry/host-smoke
- `docs/CONTEXT.md` — persist this SPECIFY turn

### Verdict (pre-plan gate · 2026-09-05)

bounded-context-guardian: yes — extract persist lifts into existing `src/core/extraction`; MCP tool and CLI both call that module; `src/tools` does not import `src/cli`; no new controllers/services tree; no Host package; no chunk text into Neo4j.
defensive-contract-validator: yes — Testing Strategy names empty / negative / overflow / concurrent / exception; SC1–SC11 bind observables.
error-handling-enforcer: yes — selector errors are validation; persist extract without creds is typed; per-chunk extract failure is mark-and-continue, not empty catch or fake LLM; invalidate/ingest failures stay GraphragError-shaped as today.
complexity-anti-drift: yes — declared split: lift one persist/batch into core, two thin wrappers (CLI + MCP), ingest schema shrink, rename invalidate, unregister echo — not a copied second writer or a god `index.ts`.
minimal-change-verifier: yes — one logical slice (MCP catalog + the lift it requires); first-slice boot/evidence, session memory, and Host citations are out; plan commits per tracer bullet.

OVERALL: PASS — hand to `writing-plans`.

## 待写入 (persist)

- ~~CONTEXT **iknow-memory**, **ingest**, **push**, **content invalidation**, **extract_triples**~~ flushed 2026-09-05.

## Hand-off

- Spec path: `specs/mcp-tool-surface.md`
- Plan path: `plans/mcp-tool-surface.md`
- Do not mix first-slice boot/evidence commits into this plan.
