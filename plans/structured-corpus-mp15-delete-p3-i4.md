# MP15 — Resumable deletion phases (P3-I4)

Plan `structured-corpus-maintenance-gc-p3.md` L64–66 · spec `specs/structured-corpus-maintenance.md`
§Physical collection :309–:314, :335–336 · M15 (:360), M16 (:361) · ADR 0099 §2.1.

Predecessor of MP13 (eligibility) → MP14 (mark) → **MP15 (delete)**, and the deletion half of
MP16 (tombstone, already merged on this branch) → MP17 (completion, other branch).

## Step 0 — Architecture-change-reviewer gate

| Axis | Verdict | One-line reason |
|---|---|---|
| `bounded-context-guardian` | **yes** | One capability slice (`collection-delete-*` + one DDL), keyed on the existing source-version identity; no new bounded context, no technical-layer directory, and it opens no import edge into MP16/MP17's stores. |
| `input-contract-tests` | **yes** | `deleteCollectionPayload` has a closed refusal vocabulary drawn from `MAINTENANCE_WORK_FAILURE_CODES` (not widened), and every input class — blank/foreign identity, non-`retired_unreferenced` class, wrong scope, missing mark, stale mark, past deadline, already collected, unresolvable binding, live row grant — has a named refusal with a unit test. |
| `error-handling-enforcer` | **yes** | Every failure is a typed `{refused, code, detail}` value (the MP13/MP14 shape) or a `MaintenanceStoreError`; no magic codes, no empty-catch, no message matching, and the transaction rolls back through the runner's own `fail` mapper. |
| `complexity-anti-drift` | **yes** | The pure module is pure derivations only; each PG phase is its own small method over one statement, so no function approaches 60 lines / cyclomatic 10 / 4 params, and the DDL stays a single `CREATE TABLE` + one index pair. |
| `minimal-change-verifier` | **yes** | No new dependency, no vocabulary widening (`collect_payload` and the nine failure codes are reused as they stand), and the only files touched outside the new ones are the two registration seams plus `schema-lock.ts` + `schema-evidence.ts` (the two indexes, with the query each one serves named below). |

No `no`, no `unclear` → proceed.

## The phase vocabulary

Closed, in `COLLECTION_DELETE_PHASES`, in this order:

| # | Phase | Rows it removes | Why it sits here |
|---|---|---|---|
| 1 | `dependent_supports` | `evidence_grant_supports`, `evidence_grant_extractions` | Both FK into the payload `ON DELETE RESTRICT`; nothing below them can go first. |
| 2 | `extraction_payloads` | `support_extractions` | Its own children are gone; the `evidence_grant_extractions → support_extractions` RESTRICT is satisfied by phase 1. |
| 3 | `assertion_supports` | `assertion_supports` | `assertion_supports.source_version_id → source_versions` is RESTRICT, and `structured_publication_membership/_display.support_id` is NO ACTION. |
| 4 | `frozen_units` | `source_version_locators` | The frozen unit/object rows. CASCADE from the version, listed explicitly so the phase is resumable and its count observable. |
| 5 | `superseded_caches` | `structured_publication_extraction_bindings` | Its `(source_ref, source_version) → source_versions` FK is NO ACTION, so it must precede the identity stamp. |
| — | `collected` (terminal) | the collection mark row; then `payload_collected_at` | Not a delete: the identity row survives as spec :314's minimal non-content record, and the stamp is what stops a rescan (`already_collected`). |

This is spec :310's list in :310's own order, one phase per removable row set, plus the terminal stamp.
`snapshot_payloads` from :310 has **no backend row**: fin owns answer snapshots (spec :13, :314–:315) and
the backend's half of that boundary is MP16's durable invalidation event plus MP17's owner
acknowledgement — both already owned. Stated here so the omission is a decision, not a silence.

## Shared-object key (:312) — answered, not assumed

`content_digest` and `origin_object_ref` are the only two NOT NULL "the original content" columns.
Neither is used as a lookup or a join key anywhere in `src/`:

- `content_digest` is read at exactly two places: the immutability compare on re-insert of the same
  `(source_ref, source_version)` (`evidence-source.ts`), and a change-detection compare against
  `structured_screening_decisions.content_digest` — a different table (`screening-decision-pg.ts:230`).
- `origin_object_ref` is written and immutability-compared, and never read again. It is a *retained
  pointer* to an object the backend does not own: there is no object store, no blob client and no
  payload `unlink` anywhere in `src/` (the only `node:fs` uses are eval fixtures, config and settings).

So MP15 (a) **keys every statement on `source_version_id`, never on a content hash** — which is
precisely what "not deletion by one logical source's hash alone" forbids — and (b) still performs the
exact live-reference count on both columns, because nothing in the schema prevents two logical sources
from naming the same original object and an exact count is the only mechanism this store has for :312.
The counts are reported in the outcome; they never gate, because MP15 removes no shared object.

Indexes added, each justified by the statement it serves:

| Index | Statement it serves |
|---|---|
| `source_versions_content_digest_idx (content_digest)` | `SELECT count(*) FROM source_versions WHERE content_digest = $1` |
| `source_versions_origin_object_ref_idx (origin_object_ref)` | `SELECT count(*) FROM source_versions WHERE origin_object_ref = $1` |
| `evidence_grant_extractions_support_id_idx (support_id)` | `DELETE FROM evidence_grant_extractions WHERE support_id IN (payload supports)` — the PK leads with `evidence_ref`, so it cannot serve this |

No other new index: `assertion_supports_source_version_idx`, `support_extractions`' PK
`(support_id, extraction_ref)` and `source_version_locators`' PK `(source_version_id, …)` already
lead with the column phase 2–4 filter on.

## Structural protections relied on vs added

**Relying on (no work):** `assertion_supports → source_versions` RESTRICT;
`evidence_grant_supports → assertion_supports` RESTRICT; `evidence_grant_extractions → support_extractions`
RESTRICT; `structured_publication_membership/_display → assertion_supports` NO ACTION;
`structured_publication_extraction_bindings → source_versions` NO ACTION; the `evidence_grants_arm_check`
arm CHECK that makes "a count grant names no dependency" structural, so MP15 excludes count grants by
`grant_kind = 'row'` and never has to guess; `structured_purge_tombstones` already committed by MP16 (:309).

**Added:** the two `source_versions` indexes and `evidence_grant_extractions_support_id_idx`; the
`structured_collection_deletions` progress table; and the DDL's CHECK lists rendered from the exported
vocabularies so the schema cannot disagree with the TypeScript unions.

## The UoW `active = false` refusal

`withAuthorizedScope` always locks `context.authorizedSourceRefs` and then calls
`assertAuthorizedSourcesActive` (`structured-scope-uow.ts:359-370` PG, `:853-858` memory), which throws
`input_stale` on an inactive row. MP15 deletes retired **and withdrawn** payloads, so that is the
normal case, not an edge.

MP15 therefore does **not** compose through `withAuthorizedScope`. It uses `PgScopeTransactionRunner`
directly and takes the shared lock order itself — `reserveSources` → `lockOwnerScope` →
`lockAffectedSources` → `lockScopeRevisions` — exactly as `PgStructuredPurgeStore.applyPurge` does.
This is not a new bypass: it is MP16's route, chosen for the same reason (a purge must run against the
row whose `active` flag it is about to change), and it is not a hole because the authority it drops is
only the read-admission assertion — the reservation, the scope lock and the source locks all still
run, and eligibility is re-read **inside** those locks by the same `FACTS_SQL` statement MP14's
post-grace recheck uses.

## Vector-side payload — explicitly out of scope

`chunks` carries `source_ref text NOT NULL` and **no** `source_version` column and no FK to
`source_versions` (`pgvector-backend.ts:927`). A source ref has several versions, so `DELETE … WHERE
source_ref = $1` would take the LIVE version's chunks with the retired one — the vector-tier instance
of exactly the hash-only deletion :312 forbids. Version-scoped deletion is not expressible against the
table today, so MP15 defers it. Named follow-up: **`chunks` needs a `source_version_id` back-pointer
(or a per-version `valid_window`) before a version-scoped collector can own the vector payload**;
until then the tier is bounded by the existing `valid_until` invalidations and MP12's serving guards.
Recorded here, not silently omitted.

## Files

New:
- `src/core/maintenance/collection-delete.ts` — phase vocabulary + every pure derivation.
- `src/core/storage/collection-delete-pg.ts` — `PgCollectionDeleteStore`.
- `src/core/storage/collection-delete-memory.ts` — `InMemoryCollectionDeleteStore`.
- `src/core/storage/schema-collection-delete.ts` — the progress table.
- `src/core/storage/structured-purge-completion.ts` — the MP17 slice MP15 needs, copied from `2ffbb96`.
- `src/core/storage/schema-structured-completion.ts` — copied verbatim from `2ffbb96` (additive DDL).
- tests: `tests/core/maintenance/collection-delete.unit.test.ts`,
  `tests/storage/collection-delete-memory.test.ts`,
  `tests/acceptance/maintenance-mp15-delete-pg.test.ts` (marker `IK_STRUCTURED_COLLECTION_DELETE_PG`).

Touched seams only: `schema-bootstrap.ts`, `schema-lock.ts`, `schema-evidence.ts` (two indexes).