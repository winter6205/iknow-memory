# Plan: Structured Query grant issuance fence

**Status:** Implemented and verified on 2026-10-07.
**Goal:** Refuse a Query result when its trusted authorization or purge revision changes between the authorized read snapshot and Evidence grant issuance, and leave no grant artifacts from that refused result.
**Authority:** Fin `specs/structured-corpus-query.md` and `specs/structured-corpus-evidence.md`; IK `plans/structured-corpus-query-execution-integration.md`.
**Scope:** Keep the existing read-only `REPEATABLE READ` Query unit of work. Carry its actual `(scope_binding, authorization_revision, purge_revision)` fence into the existing Evidence batch-write transaction, lock that scope revision row, and compare the exact fence before any grant, receipt, or dependency write. Existing callers that omit the optional Evidence fence remain compatible. Query always supplies the fence. The memory lane follows the same contract.
**Known limit:** This fence closes the stale-snapshot issuance window. The Query read transaction and grant write transaction remain separate, so this work does not claim literal P1-I6 same-transaction completion.

affects: plans/structured-query-grant-issuance-fence.md
affects: src/core/types.ts
affects: src/core/storage/structured-query-reads.ts
affects: src/core/storage/evidence-store.ts
affects: src/core/storage/evidence-pg.ts
affects: src/core/storage/pgvector-backend.ts
affects: src/core/storage/memory-backend.ts
affects: src/index.ts
affects: tests/storage/evidence-store-contract.ts
affects: tests/storage/structured-query-memory.test.ts
affects: tests/index-query-seam.test.ts
affects: tests/acceptance/structured-query-pg.test.ts

**Affected files:**

- `src/core/types.ts`
- `src/core/storage/structured-query-reads.ts`
- `src/core/storage/evidence-store.ts`
- `src/core/storage/evidence-pg.ts`
- `src/core/storage/pgvector-backend.ts`
- `src/core/storage/memory-backend.ts`
- `src/index.ts`
- `tests/storage/evidence-store-contract.ts`
- `tests/storage/structured-query-memory.test.ts`
- `tests/index-query-seam.test.ts`
- `tests/acceptance/structured-query-pg.test.ts`

**Architecture review (all five verdicts required before implementation):**

```text
bounded-context-guardian: yes — the fence stays within Query's storage read boundary and Evidence's grant writer; Fin-facing and model-visible surfaces do not change.
input-contract-tests: yes — exercise current issuance, legacy calls without a fence, invalid/mismatched fences, stale authorization, stale purge, empty pages, and batch atomicity on the applicable PG and memory boundaries.
error-handling-enforcer: yes — map ACCESS_DENIED to authorization_denied, UNAVAILABLE/MALFORMED_CONTRACT to structured_search_unavailable, preserve the primary error, and roll back the complete PG batch.
complexity-anti-drift: yes — use one shared fence validator, one PG row-lock check before the existing batch loop, and one synchronous memory preflight; do not add another transaction abstraction.
minimal-change-verifier: yes — one authorization/purge race repair; no schema, dependency, lockfile, CI, settings, or broad P1-I6 transaction rewrite.
```

**Implementation sequence:**

1. Preserve the live PostgreSQL RED repros for authorization and purge advancement after the read snapshot.
2. Add an optional expected scope-revision fence to whole-page grant issuance and validate its shape and scope binding.
3. Capture the actual fence from the PostgreSQL read client and from the memory read lane; do not synthesize either revision.
4. Lock the PostgreSQL scope revision row and compare the fence before any member of the grant batch writes. Validate the memory fence before staging any grant/receipt/dependency state.
5. Map typed Evidence refusals to the existing closed Query codes and correct comments that currently imply the separate grant transaction already satisfies P1-I6.

**Validation:**

- Live PostgreSQL RED baseline: the two race cases failed before the fix with one persisted grant and its dependencies for authorization movement, and one grant plus receipt for purge movement.
- Full live PostgreSQL acceptance: `source /home/winner/projects/fin-wt-p3-closeout/scripts/structured-live-env.sh >/dev/null 2>&1 && STRUCTURED_QUERY_PG=1 ./node_modules/.bin/vitest run tests/acceptance/structured-query-pg.test.ts` — exit 0, 35 passed.
- Memory and Query seam parity: `./node_modules/.bin/vitest run tests/storage/structured-query-memory.test.ts tests/index-query-seam.test.ts` — exit 0, 45 passed.
- Evidence store contract on both backends: `source /home/winner/projects/fin-wt-p3-closeout/scripts/structured-live-env.sh >/dev/null 2>&1 && ./node_modules/.bin/vitest run tests/storage/evidence-store-memory.test.ts tests/storage/evidence-store-pg.test.ts` — exit 0, 59 passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- Deterministic memory input-read race — exit 1 before moving fence capture ahead of reads, then exit 0 after the fix.
