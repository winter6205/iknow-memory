# Structured corpus integration repairs

Authority: the operator's request to integrate the Query, Evidence, and
Maintenance deliveries, verify real interactions, and synchronize local and
remote state. The complete Q/E/M acceptance remains separate from these
foundation repairs.

## Offline evaluator dependency repair

The unchanged `tests/eval/isolation.test.ts` fails on baseline `e8165a7` and
the integrated candidate because retrieval's dependency type imports the
concrete SQL executor, whose module imports `pg`. Retrieval needs only its
`query` capability. Define a structural port in the existing business-query
type module and consume that port at the retrieval boundary. Keep the
implementation and composition root responsible for constructing the executor.

Files expected to change:

- `src/core/business-query/sql-query-types.ts`
- `src/core/retrieval/index.ts`

```text
bounded-context-guardian: yes — the business-query capability owns its port; retrieval consumes the contract rather than the concrete PostgreSQL executor.
input-contract-tests: yes — runtime request semantics remain unchanged; existing SQL request, arm, and retrieve tests cover the inherited contract, and the existing evaluator isolation test is the failing regression.
error-handling-enforcer: yes — this type-only dependency repair preserves the executor's typed failure surface and introduces no fallback or catch.
complexity-anti-drift: yes — one structural query method replaces an implementation dependency; no runtime branch or duplicate executor is introduced.
minimal-change-verifier: yes — two existing source files repair one proven integration regression; no new dependency, lockfile, settings, or CI changes.
```

Validation: run the existing evaluator isolation regression without weakening
its import-closure assertions, the SQL/retrieval regressions, whole-package
typecheck, build, and full tests in a hermetic provider environment. Baseline
Neo4j configuration tests also fail under inherited embedding credentials but
pass when those provider variables are blank; this is recorded separately and
does not justify changing production credentials or configuration.
