# Spec: MCP tool surface and round boundaries

> **Status:** ACR PASS 2026-09-05 (lift patch). Persist flushed. Plan: `plans/mcp-tool-surface.md`.
> **Assumption gate:** boundaries 2026-09-05; catalog 2026-09-05 (operator accepted the 5-tool list).
> **Depends on:** `specs/graph-rerank-boot-and-evidence.md` (first slice). This spec is the **second slice**.

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
9. **`extract` is a new MCP tool.** It runs the existing extract pipeline (LLM triples → merge → persist → outbox), synchronously, `mark-and-continue`. Not a job queue. Not auto-run inside `ingest` or `push`.
10. CLI extract remains for `--dry-run`, `--list-failed`, `--list-unmapped`, `--backfill-embeddings`. MCP `extract` is the write trigger only.
11. MCP `extract` requires a selector: `chunk_ids` **xor** `source_ref`. It does not scan the whole store the way the unscoped CLI does.
12. Descriptions on `tools/list` are for any Host. No “stage 0” / “fin port” jargon.
13. First-slice grounding gate (`evidence span` substring) applies to whatever persist path MCP `extract` uses, once that slice has landed. Do not fork a second extract writer.
14. `src/tools` must not import `src/cli`. Today `processChunk` / `persistOutputs` / `runPipeline` live as CLI-private functions in `src/cli/extract.ts`. This slice **lifts** that persist/batch orchestration into the existing **extract_triples** capability (`src/core/extraction`). The CLI keeps flags and process exit codes; the MCP tool is another caller. Same pipeline, two entry points.

## Catalog

| Name           | Action                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retrieve`     | Keep. Envelope unchanged. Description: ranked chunk search with temporal filter.                                                                     |
| `ingest`       | Keep write path. Remove `action: "invalidate"` and related fields. Description: loose ingest (content + `source_ref`, optional metadata / validity). |
| `push`         | Keep. Strict batch, idempotent `(source_ref, content_identity)`, required metadata and validity window. Description must not say “fin port”.         |
| `invalidate`   | Rename from `invalidation`. Same close-window semantics, no physical delete.                                                                         |
| `extract`      | Add. Selector `chunk_ids` xor `source_ref`; reuse existing pipeline; return counts and per-chunk failures.                                           |
| `echo`         | Archive: absent from registry / `tools/list`.                                                                                                        |
| `invalidation` | Archive the **name**: absent from `tools/list`.                                                                                                      |

## Extract tool contract

**Input (exactly one selector):**

- `chunk_ids`: non-empty list of chunk UUIDs, length ≤ existing ingest batch limit (`readIngestBatchLimit` / `GraphragEnv.ingestBatchLimit`).
- **or** `source_ref`: non-empty string; chunks for that source that do not yet have `extraction_records.status = 'succeeded'` (same pending rule as the CLI scan). Process at most the ingest batch limit; if more pending, return how many were run and that more remain (no silent truncation without that count).

Both set, neither set, empty `chunk_ids`, or over-limit `chunk_ids` → input error (not a successful empty extract).

**Output (JSON text like other tools):** processed count, succeeded count, failed count (mark-and-continue), and failed chunk ids with existing `error_code` shape. Zero pending for a valid `source_ref` is success with zeros, not an error.

**Auth:** same as CLI real extract: missing LLM or embedding credentials that the persist path needs → typed config/tool error, not `FakeLLMClient` / fake vectors.

**Not in this tool:** `--dry-run`, `--list-failed`, `--list-unmapped`, `--backfill-embeddings`, `--only-failed`, `--since` as Host API. Those stay CLI.

## Boundaries

- **Does:**
  1. Freeze and implement the catalog above (registry, schemas, descriptions).
  2. Lift extract batch/persist orchestration from CLI-private functions into `src/core/extraction`; add MCP `extract` and keep CLI as a wrapper over the same module.
  3. Remove ingest-side invalidate action; rename invalidation tool.
- **Confirms with human:** auto-extract on ingest/push; exposing list-failed over MCP; keeping a deprecated `invalidation` alias.
- **Out of this spec:** first-slice boot/logs/evidence implementation (`specs/graph-rerank-boot-and-evidence.md`); session memory; Host citations; generation/prompt; Text2Cypher; SQL graph-arm revival; merging ingest+push; job queue; `get_chunk` / graph inspect tools.

## Success Criteria

Binary; each maps to a command or measurable check.

1. **Registry:** after start, `tools/list` names are exactly `{ingest, push, invalidate, extract, retrieve}` (order unconstrained). `echo` and `invalidation` absent. Unit or host-smoke on the registry.
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
