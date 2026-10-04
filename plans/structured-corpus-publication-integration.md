# Structured publication integration slice

Authority: integrate the operator's three structured-corpus plans into a working
knowledge-base path. Normative contracts live in fin's
`specs/structured-corpus-{query,evidence,maintenance}.md` and corresponding plans.
This slice supplies MP5, MP6, and MP7, plus the publication-owned inputs
for a partial MP10 summary. Full MP10 remains open until MP8/MP9 provide
structural screening and guarded decisions. It does not claim final Q/E/M
acceptance or production migration.

## Observed gap

At integration `a2c0106`, identity, immutable evidence, and durable jobs are
separate foundations. There is no desired/published source pair, exact accepted
support membership, authorized source mapping, current data revision, attributed
display payload, or scope-wide maintenance summary. Sequential calls to their
public stores cannot constitute atomic publication: each PostgreSQL wrapper
owns its transaction and each memory implementation owns independent maps.

## Contract to implement

Add an optional publication capability with PostgreSQL and memory parity. Scope
membership is supplied by the trusted server owner, never the query/model. The
scope includes active sources with no published extraction and sources with no
matching rows. Persist source generation, desired and published version plus
extraction pair, withdrawal/access tombstones, and exact accepted occurrence
membership. Preserve the authoritative original/support/extraction identities.

Keep attributed entity display values keyed by accepted support and extraction
revision. A repeated occurrence can retain its support identity while a new
extraction has different attributed display values. Do not place mutable display
values on the immutable occurrence record. Relation identities remain exact
normalized tuples from the identity registry; no embedding merge or newest-wins
resolution is introduced.

Staging never changes serving membership. Every stage mutation and publication
checks the live attempt token, lease, absolute deadline, source generation,
desired pair, input/dependency revisions, and config/ruleset revision. A stale
attempt cannot modify a newer attempt's status. Successful publication commits
the pointer, exact membership, attributed compilation, data revision, progress
revision/status, and durable projection outbox in one transaction. A failed
replacement retains the prior published pair. Re-extraction retires omitted
occurrences only from that source. Withdrawal advances generation and removes
that source's current membership immediately; remaining authorized origins
preserve the result.

Use checked-out transaction-client helpers for existing identity/evidence/work
operations; do not nest their independent transaction-owning entry points.
Memory uses one serialized unit of work with staged state and rollback before
publication. External indexes remain derived and are not authority for current
membership.

Persist separate scope `read_revision` and `maintenance_revision`. Progress-only
changes advance maintenance revision. Publication, membership/display changes,
withdrawal, resolution, or authorization advance data revision. Read rows and
the required summary from the same authorized snapshot. Every active scoped
source occupies exactly one desired-index and one conflict-check bucket; missing
required state refuses `maintenance_status_unavailable`. Pending desired input
cannot inherit ready status from an older accepted pair. Report only structural
screen coverage, never semantic truth readiness.

## Ownership and ordering

One implementer owns the coupled TypeScript package changes: publication
contract/service, PG and memory adapters, schema/bootstrap/readiness registration,
and transaction-client refactoring strictly required by atomicity. Another
test-engineer owns disjoint publication tests. Existing source wrappers retain
their inherited external behavior. No dependency, lockfile, settings, or CI
change is needed.

Private evidence actions, current list/count/cursor, fin transport and replay,
recorded structural decisions, collection, purge, and invalidation remain the
next dependent slices. This capability must provide their real publication and
status inputs rather than mocked ready values.

## Driver contract before implementation

The existing strict PostgreSQL pattern is verified in
`tests/acceptance/maintenance-m-acceptance-pg.test.ts`; its nine passing cases
cover only durable jobs. Choose a new strict driver at
`tests/acceptance/structured-publication-pg.test.ts`, invoked as:

```sh
STRUCTURED_PUBLICATION_ACCEPTANCE=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-publication-pg.test.ts
```

Strict mode must fail if PostgreSQL or required schema capabilities are absent.
Use a unique schema and delete only that schema. No default skip is an acceptance
pass. Expected inputs/outcomes come from the independently reviewed original
corpus; backend UUID mapping is recorded separately after ingestion.

Required failing-first scenarios: v1 serving during v2 pending/failure; atomic
successful switch; re-extraction omission with shared stable occurrence IDs;
two origins followed by one and final withdrawal; expired/superseded/A-to-B-to-A
attempt fences including intermediate writes; hidden and zero-hit sources in
summary; progress-only versus data revisions; simultaneous competing publication
and source withdrawal; rollback on injected write/outbox failure. Add memory
parity tests against the same capability contract. Run whole-package typecheck,
build, relevant identity/evidence/work regressions, and hermetic full unit tests
after focused acceptance.

## Authoritative composition and affected existing files

The backend composition root supplies one authoritative structured unit of work.
PostgreSQL composes existing identity, Evidence, and durable-work operations on
one checked-out client with one transaction owner; helper extraction preserves
existing independently transaction-owning entry points. Scope/source locks and
same-transaction reads enforce the generation, lease, desired-pair, and input
checks. No sequential wrapper calls stand in for this transaction.

Memory composes the actual existing identity registry, Evidence state, and work
ledger into the same serialized unit of work. Stage immutable changes in an
isolated state view; commit all referenced state together or restore every map
on failure before releasing the serialization lock. Adapter-private shadow
registries and independent store writes that survive a failed publication are
forbidden. Tests query the existing identity/Evidence/work capabilities after a
fault to prove the shared authority and rollback, not just publication pointers.

Existing affected files are `src/core/structured/identity-store.ts`,
`src/core/storage/evidence-pg.ts`, `maintenance-work-pg.ts`,
`maintenance-work-memory.ts`, `memory-backend.ts`, `pgvector-backend.ts`,
`backend.ts`, `schema-bootstrap.ts`, and `schema-lock.ts`. All storage filenames
above are under `src/core/storage/`. Capability access is optional through
`backend.ts`, with PG/memory composition registered by their backends; inherited
backends without the optional capability remain valid and refuse it explicitly.
Additive capability tables/indexes are registered with the existing readiness
probe in `schema-lock.ts` and bootstrap in `schema-bootstrap.ts`.

Partial status is honest: extraction/publication readiness can be reported;
conflict checks are pending only for recorded outstanding work or the SPEC's
first-ingest-without-scheduled-work case. Missing required records refuse
`maintenance_status_unavailable`. This slice does not claim conflict-ready or
completed MP10 and does not fabricate screening or decisions. MP8/9 will supply
those independent authoritative states before full Query/status acceptance.

## Planned boundaries and failures

Implementation files: `core/maintenance/publication-types.ts`,
`publication-service.ts`, `publication-state.ts`; PG and memory adapters in
`core/storage/publication-pg.ts` and `publication-memory.ts`; additive DDL in
`core/storage/schema-publication.ts`, bootstrap/readiness registration; same-client
helper extraction only in existing identity/evidence/work adapters. Resolve and
record exact existing file paths before implementation. Tests own
`tests/storage/publication-contract.ts`, `publication-memory.test.ts`, and the
strict PostgreSQL driver already selected above. No required StorageBackend
method, dependency, settings, lockfile, or CI edit is introduced.

Each stage/publish/withdraw/status entry has failing-first tests for empty
required scope/source/version/config, malformed IDs and types, negative
revision/generation/span, unsafe-integer overflow and invalid timestamp,
duplicate/inconsistent membership, empty authorized scope, authorization denial,
concurrent/duplicate calls, and storage exceptions. A successful extraction's
empty support set is valid; absent required payload or scope binding is refused.
Caller-supplied scope/generation never creates authority. Shared contract cases
run in memory and PostgreSQL; document truly inapplicable classes explicitly.

Expected refusals use closed maintenance SPEC codes: `invalid_input`,
`access_denied`, `unsupported_source_binding`, `input_stale`, `lease_lost`,
`ruleset_unavailable`, `resource_exhausted`, `backend_unavailable`, and
`execution_timeout`. Wrong/reclaimed/expired attempt ownership is `lease_lost`;
changed generation, desired pair, dependency or configuration is `input_stale`;
absolute attempt deadline is `execution_timeout`. Stale attempts cannot alter
newer attempt status. Missing required summary records refuse the Query SPEC's
`maintenance_status_unavailable`, without fabricated empty or ready values.

Write/commit/outbox exceptions roll back the whole unit of work and surface typed
`backend_unavailable`; memory faults restore the entire staged state with the
same outcome. Preserve original typed errors and retain safe suppressed rollback
metadata when rollback fails. Add `// EXIT:` comments to refusal exits, failed
replacement preservation, and rollback termination. Tests assert exact refusal
codes, prior serving pointers/membership, unchanged data revision/outbox, and
no mutation of a newer job's status.

## Pre-implementation review

Independent architecture gate, 2026-10-04, after resolving two review rounds:

```text
bounded-context-guardian: yes — one shared PG transaction and memory unit of work, existing identity/evidence/work seams, optional backend access, schema-lock readiness.
input-contract-tests: yes — failing-first empty, malformed, negative, overflow, authorization, concurrency, and exception cases for each entry with PG/memory parity.
error-handling-enforcer: yes — closed typed refusals, atomic rollback, primary-error preservation, EXIT comments and exact-state assertions.
complexity-anti-drift: yes — separate contract/service/state, adapters, schema and only required same-client helpers.
minimal-change-verifier: yes — MP5–MP7 plus honest partial MP10 inputs; full MP10 waits for MP8/9; downstream slices and CI remain excluded.
```

Reviewer: `/root/publication_architecture_gate`. Foundations pinned at
`a932d5ca2e94e0fe24a27ee2965c0c5bab7878dd`. This committed gate precedes
implementation. Tests and shared API contract are authored first; one coupled
IK implementer owns production files while an independent test engineer owns
publication tests. No gate closes full Q/E/M acceptance.

## WIP implementation checkpoint — 2026-10-04

The optional publication capability is implemented in memory and PostgreSQL.
The strict publication driver passed 29 cases against local real PostgreSQL;
memory parity passed 28 cases. Maintenance PostgreSQL regressions passed 13
cases and bootstrap column repair passed 3. Typecheck, build and `lint:s5`
passed. This validates controlled boundary fixtures, not the draft public-corpus
oracle, full M-STATUS, or final Q/E/M behavior acceptance.

An initial full regression run produced 2833 passed, 19 failed and 322 skipped.
Eighteen failures were inherited provider-environment contamination in config
tests: the config file passed all 188 tests when provider variables were removed
only from the test subprocess. One failure exposed a new DDL/readiness index
lockstep mismatch. The unchanged lockstep test reproduced it (1 failed, 7 passed)
and passed all 8 after explicit matching primary-key/index DDL was added.
The fresh isolated full regression then passed 2852 tests with 322 skipped
(exit 0). The subprocess removed provider variables without printing their
values or modifying configuration files.
The skipped real dependencies are unverified by that default run; strict
publication and maintenance commands above provide their separate real-PG
evidence. No production settings or credentials were changed.

After the DDL correction, root independently reran the strict publication
driver together with `tests/storage/evidence-store-pg.test.ts` and
`tests/structured/identity-store-pg.test.ts`, using the isolated development DSN:
61 passed (29 publication, 25 Evidence, 7 identity), zero skips, exit 0.

The accepted screening plan owns the next shared scope UOW, owner/source/job
lock ordering, reader-subset views and complete structural status. This WIP
checkpoint is not a default-branch landing or rollout approval.
