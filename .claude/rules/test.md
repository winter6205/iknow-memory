# Testing Requirements

When adding or changing business logic, prioritize tests for the changed behavior. Cover each applicable class:

1. Normal behavior.
2. Failure behavior.
3. Boundary conditions.
4. Insufficient permissions.
5. Empty, malformed, or invalid input.
6. Concurrent requests or duplicate submissions, when applicable.

## Golden-set acceptance for every change

For every change, identify the applicable committed, versioned golden set, run it, compare actual per-case results with independently defined expected results, and record the command, dataset version, observed results, and exit status. If the change alters a product contract that the current gold set does not cover, add or update the gold cases before implementation; a documentation-only change with no contract change still runs the repository's baseline gold set.

When changed behavior crosses a real service, storage, model, or MCP boundary, the golden run must exercise that real boundary and assert observable results. Fake or fixture-server runs remain useful for deterministic tests but do not satisfy this golden acceptance. Missing gold coverage or an unavailable required dependency is blocked evidence, not a pass or a green skip.

Do not delete tests to make a build pass. Do not weaken assertions. Do not change a failing test to a skip unless the user explicitly authorizes it and the commit message explains why.

## Real Dependencies and Representative Data

Use fakes for pure logic and controlled seams. A fake is not evidence for external behavior whose correctness depends on a real service's semantics. For those changes, add or update integration coverage against the real dependency and assert an observable contract result, such as persisted state, a returned document, or its expected rank. A mock call or request shape alone does not prove persistence or retrieval behavior.

- **PostgreSQL and pgvector:** Changes to PostgreSQL persistence, schema/transaction behavior, pgvector indexing, or vector-search semantics require integration coverage against real PostgreSQL 16 with pgvector, as pinned in `docker-compose.yml` and `specs/p0-integration.md`. Assert the relevant stored state or retrieved result; an in-memory backend does not prove PostgreSQL behavior.
- **Elasticsearch and analysis-ik:** Changes to lexical indexing, Chinese analysis, BM25, phrase matching, field boosts, or ES retrieval require a real Elasticsearch instance with the `analysis-ik` plugin at the matching version, as specified in `specs/es-precision-layer.md` and `docs/runbooks/es-precision-layer.md`. Use representative Chinese document/query fixtures and assert observable analysis or retrieval behavior, such as the expected target document appearing in the result set or ranking. Follow `tests/integration/bm25-pg.test.ts` for the existing Chinese fixture and retrieval assertions.
- **Neo4j and GDS:** Changes to graph projection or PPR behavior require real Neo4j/GDS integration coverage when required by the changed feature's acceptance criteria; use `specs/neo4j-graph-arm.md`, `tests/integration/graph-neo4j.test.ts`, and `tests/integration/neo4j-ppr-arm.test.ts`. Neo4j/GDS is not a blanket dependency for unrelated tests or every local suite run.
- **Complete data path:** When a change affects the complete `ingest → extract → retrieve` path, run the applicable real-service smoke in `docs/runbooks/integration-smoke.md` and record its actual output. That smoke asserts that retrieval returns the ingested `source_ref`. Use `docs/runbooks/extraction-smoke.md` when the changed behavior specifically requires evidence for the live LLM extraction integration; a live LLM is not a default requirement for unrelated tests.

Fixtures should represent the documents and queries the changed behavior is meant to handle, and expected results should come from the relevant spec or an independent fixture/gold set. Keep fakes for unrelated providers or seams where they help isolate the behavior under test; do not use them to stand in for the external semantics the test claims to verify.

If an integration dependency is unavailable locally, loud-skip that integration test and report it as **Not run** with the expected command and blocking issue. Do not report a skipped integration as a pass. A CI lane configured to exercise a required dependency must fail when that dependency is unavailable rather than turn the integration into a green skip. Follow the existing gates in `tests/integration/pg-test-harness.ts`, `tests/integration/es-test-harness.ts`, and `tests/integration/graph-neo4j.test.ts`.

When validation cannot run, report:

```text
Validation:
- Not run: <reason>
- Expected command: <command>
- Blocking issue: <issue>
```
