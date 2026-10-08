# MP17 — all-owner purge completion, and the `ack` half of the invalidation contract

Date: 2026-10-08
Status: in progress (gate written before any implementation)
Branch: `feat/p3-mp17-completion`, stacked on MP16 `46149ba`.
Authority: [`ADR 0099`](../docs/adr/0099-scrub-before-ack-two-phase.md) is binding for this
slice and is followed literally. Register obligations §1.5 and §1.6 in
[`structured-corpus-p3-prerequisites.md`](../plans/structured-corpus-p3-prerequisites.md)
are closed here. [`ADR 0097`](../docs/adr/0097-ep8-invalidation-event-contract.md) §2.1,
§2.3, §2.7 and §4.5 own the event and checkpoint halves;
[`ADR 0098`](../docs/adr/0098-mp15-to-fin-outcome-channel.md) constrains what may be
invented and this slice invents no outcome shape.

## 0. Architecture gate

Five verdicts, each one line, each with the evidence the verdict rests on. All five
are `yes`; the implementation below follows them.

| axis | verdict | reason |
| --- | --- | --- |
| `bounded-context-guardian` | **yes** | Four capability modules with disjoint tables and callers — completion recording (`structured-purge-completion`), the `ack` write (`evidence-invalidation-ack`), outbox retention (`invalidation-outbox`, whose module header already says §1.5 needs its reader), and the DDL sibling `schema-structured-completion`; nothing is added to a technical-layer directory and no module borrows another's writer. |
| `input-contract-tests` | **yes** | The `ack` request parse is a public action on the `iknow.evidence_request` surface, so it is covered for absent / blank / non-string / over-long / cross-consumer checkpoints and for unlisted identity keys; the two new pure derivations (`planAckAdvance`, `planInvalidationRetention`) are exported for direct value-level testing. |
| `error-handling-enforcer` | **yes** | Every refusal arm returns a typed `EvidenceRefusal` value out of the transaction (the drain's documented reason: the rollback path would re-type a thrown token into `backend_unavailable`); a zero-row guarded completion is reported as `completed: false`, never as an error and never as a completion; no catch block swallows anything. |
| `complexity-anti-drift` | **yes** | Each new function is a single decision with its inputs as arguments; the reconciler is one statement plus one read, the ack write is one transaction with five ordered steps, and `npm run lint:s5:all` is required to report zero findings for the four new files. |
| `minimal-change-verifier` | **yes** | No new dependency, no new vocabulary beyond what ADR 0099/0097 already fixed, and the only edit to MP16 is the two `scheduled` writes appended to the existing `applyPurge` transaction rather than a second transaction beside it. |

## 1. What lands

| file | establishes |
| --- | --- |
| `src/core/storage/schema-structured-completion.ts` | the two tables: `structured_purge_outcomes` keyed `(scope_binding, purge_revision)` and `structured_purge_ack_states` keyed `(scope_binding, purge_revision, consumer_id)` |
| `src/core/storage/structured-purge-completion.ts` | ADR 0099 §2.1's four states as rows, the owner-set derivation, the reconciler's guarded predicate, the `collected` write for MP15, and the `scheduled` write MP16 calls |
| `src/core/storage/evidence-invalidation-ack.ts` | register §1.5: the `ack` action, its own write transaction, and the monotonic ack state |
| `src/core/storage/invalidation-outbox.ts` (edited) | register §1.6: retention of an unacknowledged event while its grant is unexpired |
| `src/core/storage/evidence-read.ts` (edited) | `ack` in `EVIDENCE_ACTION`, its request key set, its parse, its success arm, and the named mis-route in `readPrivateEvidence` |
| `src/core/storage/structured-purge-pg.ts` (edited) | the `scheduled` writes, inside MP16's existing transaction |

## 2. The four states, as rows

ADR 0099 §2.4b names the two columns the predicate reads, and this is the mapping it
implies, used literally:

| ADR 0099 §2.1 state | column | written by | here |
| --- | --- | --- | --- |
| `scheduled` | `structured_purge_outcomes.collection_state`, `structured_purge_ack_states.ack_state` | the purge transaction, same commit as the tombstone | `schedulePurgeCompletion(client, …)` called from `applyPurge` |
| `scrubbed` | `structured_purge_ack_states.ack_state` | the ack handler, for that owner only | the `ack` transaction |
| `collected` | `structured_purge_outcomes.collection_state` | the local delete transaction, same commit as the payload removal | `recordPayloadCollection(client, …)`, called by MP15 inside its own transaction |
| `completed` | `structured_purge_outcomes.completed_at` | the reconciler only | `PgPurgeCompletionReconciler.reconcile` |

## 3. The configured-owner set, and why it is derived from `consumer_id`

ADR 0099 requires completion for "**every** configured owner of that revision" and the
briefing's decision is to derive that set rather than configure it. The derivation is:

```sql
SELECT DISTINCT consumer_id FROM evidence_grants WHERE scope_binding = $1
```

filtered through `isBoundedConsumerId` (`src/core/storage/evidence-store.ts:282-284`),
the single consumer-id predicate this repo already enforces at grant issuance, at the
outbox allocator and in the drain. `evidence_grants.consumer_id` is the backend's record
of "the trusted fin consumer against each grant" (evidence spec `:254`, register §1b.3),
so the set of owners a scope has is already a fact in the store and needs no second
configuration surface. The predicate lives in `readConfiguredOwners`, in
`structured-purge-completion.ts`, and both the purge transaction (to freeze one owner row
per owner) and the reconciler (to re-derive the same set) call that one function.

A single-consumer shortcut was rejected: ADR 0099 §2.4b's guard is an all-owner join, and
evidence spec `:259` requires cross-consumer refusal to be reachable, which is only
observable with N ≥ 2.

## 4. Why `scrubbed` is decided by a covered position, not by an event join

ADR 0099 §2.1 makes `scrubbed` true only when "the acknowledged checkpoint covers a
contiguous batch whose local scrub committed on the consumer". ADR 0097 §2.1 fixes the
outbox at six scalar columns with **no** `purge_revision`, so an event cannot be joined
back to the revision that emitted it, and adding a seventh column is forbidden.

So the join is made the other way: each owner row records `covered_seq`, the consumer's
`last_allocated_seq` as of the purge commit — the position through which this revision has
published everything it will publish for this owner — and `scrubbed` is true when the
owner's `acked_seq` has reached it. That is monotone, needs no new event column, and is
strictly the ADR's condition: the acknowledged batch covers the whole of what this
revision published for this owner.

## 5. Writer separation (ADR 0099 §2.4a)

`completed_at` is set by exactly one statement, in the reconciler. `tests/storage/structured-purge-completion-contract.unit.test.ts`
proves it by source shape: `completed_at` may appear only in the DDL module and in the
reconciler, and only once as an `UPDATE` target. A second write path is a failing test,
not a code review note.

## 6. Known consequence, stated rather than hidden

The owner set is re-derived live at reconcile time, so a consumer that gains a grant in
the scope **after** a purge becomes an owner of that revision with no owner row, and the
reconciler therefore refuses to complete. That is the safe direction — absent ≠ acked — and
the record settles at `collected`, never at `completed`, exactly as ADR 0099 §2.3 says an
offline owner does. It is recorded here because it is a real liveness cost of the
conservative reading, not a defect to be papered over.

## 7. Out of scope

The payload deletion (MP15), the fin side, and any `collection_outcome` token shape.
`recordPayloadCollection` therefore exposes the write as a **client-level** function for
MP15 to call inside its own delete transaction; no deletion, and no claim that the
atomicity of §2.1's `collected` half has been demonstrated by production code, because
that caller does not exist yet.