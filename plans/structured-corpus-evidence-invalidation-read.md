# P3 §1.3 + §1.4 — the `invalidations` drain read

Date: 2026-10-08
Status: gate passed; implementation in this branch
Authority: `specs/structured-corpus-evidence.md:218-227` and `:252-269` (SSOT),
`docs/adr/0097-ep8-invalidation-event-contract.md` §2.1/§2.2/§2.3/§2.6/§2.7/§4.3/§4.4,
`plans/structured-corpus-p3-prerequisites.md` §1.3, §1.4, §1b.5, §1b.5a.

## Scope

Two register rows and one vocabulary decision, nothing else.

| Row | Obligation | State after this change |
| --- | --- | --- |
| §1.3 | lift the `invalidations` half of the fence at `src/core/storage/evidence-read.ts:96`; register `unsupported_evidence_contract` (§1b.5) | closed |
| §1.4 | the drain read, in **one** authorized read-only UOW | closed |
| §1.5 | `ack` re-verification in its own write transaction | **still absent** — fence untouched |
| §1.6 | retention of unacknowledged events | **still absent** — follow-up |

## Architecture gate

| Reviewer | Verdict | Reason |
| --- | --- | --- |
| bounded-context-guardian | **yes** | Two new files in the existing `evidence` capability slice, no new bounded context and no cross-context import: the codec imports `canonicalJson` from `evidence-source.ts`, and the reader imports only from `evidence-read.ts`, `invalidation-outbox.ts`, `structured-scope-*.ts`. |
| input-contract-tests | **yes** | The public surface grows three inputs — the `schema_version` integer, `checkpoint`, and `limit` — and each gets a refusal case: a non-integer version is `malformed_evidence_contract`, an integer that is not 1 is `unsupported_evidence_contract`, a `limit` outside 1..20 is `malformed_evidence_contract`, and a `checkpoint` this build cannot authenticate answers `gap: true` rather than a position. |
| error-handling-enforcer | **yes** | No new error class: refusals reuse `EvidenceRefusalError`/`EvidenceRefusal`, and the storage faults the row mapper can raise (`scopedSafeNumber`, an out-of-enum `reason`) keep travelling out of `runTransaction` as typed refusals. Nothing returns `null`/empty on failure, and no catch block swallows a fault. |
| complexity-anti-drift | **yes** | The decision function is a pure `planInvalidationDrain` under 30 lines with no branch deeper than 2, the render is a pure map, and the storage method is the `PgMaintenanceStatusStorage` shape — one `runTransaction({ readOnly: true })` calling three readers. `npm run lint:s5` is reported clean per touched function. |
| minimal-change-verifier | **yes** | One declared member in `EVIDENCE_FAILURE`, one member in `EVIDENCE_ACTION`, three in `EVIDENCE_REFUSAL_REASON`, one new resolver beside the one it delegates to, no new dependency, and no edit to `src/index.ts`, `evidence-dispatch.ts`, or any file outside the four below. The drive-by that was refused: `MemoryStructuredScopeUnitOfWork` gets no drain twin, and the cursor key is a constructor argument rather than a new environment variable. |

No verdict is `no` or `unclear`, so the gate passes and the implementation proceeds.

## Design decisions this change rests on

**One transaction, three statements.** The cursor row, the retained-window floor and the
page are read on one client inside one `REPEATABLE READ READ ONLY` transaction, after
`assertCurrentAuthorization` re-checks the identity **inside** that transaction
(`structured-status-reads.ts:274-279` is the shape precedent). Three round trips is the
price of reusing `readInvalidationCursor` verbatim; a single round trip would mean a
hand-written second copy of its row conversion. The requirement is one unit of work, and
that is what the transaction gives.

**The checkpoint is an authenticated opaque token, minted with an injected key.**
ADR 0097 §2.3 requires the backend to mint it and fin to store it verbatim; the
`structured-query-cursor.ts` codec is the in-repo precedent for exactly this (base64url
canonical JSON, HMAC-SHA256, constant-time compare, exact key set, no partial decode).
The payload is `{ c, s, v }`: `v` the dialect, `s` the last `seq` covered, and `c` the
**SHA-256 digest** of the consumer id — a digest rather than the id because ADR 0097 §2.1
says `consumer_id` is stored and never sent. The key is injected and never defaulted,
which is why this change does not touch `src/index.ts`: composition is MP17's row.

**`gap` is decided, never inferred.** `true` when the checkpoint is not decodable, was
minted for another consumer, names a `seq` beyond `last_allocated_seq` (never issued), or
precedes the earliest retained row (no longer retained) — ADR 0097 §2.7. On `gap` the
batch restarts at the earliest retained row, and no `seq` is ever renumbered, compacted or
dropped.

**An unknown version refuses.** `schema_version` splits the way fin's
`_check_schema_version` splits: a non-integer is `malformed_evidence_contract`, a finite
integer this build does not implement is `unsupported_evidence_contract`. Reading it as
version 1 is not on the table.

## Files

| File | Contract established |
| --- | --- |
| `src/core/types.ts` | `EVIDENCE_FAILURE.UNSUPPORTED_CONTRACT` → `unsupported_evidence_contract`, one declared member (register §1b.5) |
| `src/core/storage/evidence-invalidation-checkpoint.ts` | the authenticated checkpoint codec: mint, decode, consumer digest |
| `src/core/storage/evidence-invalidation-read.ts` | `PgEvidenceInvalidationStorage.drainInvalidations` — one authorized read-only UOW, plus the pure `planInvalidationDrain` / `renderInvalidationBatch` |
| `src/core/storage/evidence-read.ts` | `invalidations` in the action set, its request parse, its success arm, the version refusal, and the corrected `EVIDENCE_FAILURE` comment |

## Tests

- `tests/storage/evidence-invalidation-checkpoint.test.ts` — codec: round trip, tamper,
  wrong key, foreign consumer, non-canonical key set.
- `tests/storage/evidence-invalidation-drain.test.ts` — pure derivation: gap verdicts,
  start position, limit bound, version gating, plus the parser's closed key set.
- `tests/acceptance/structured-invalidation-drain-pg.test.ts` — real PostgreSQL,
  marker `IK_STRUCTURED_INVALIDATION_DRAIN_PG`, whole `upSchemaBootstrap`.