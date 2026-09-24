# G4 planning baseline — iknow-memory (2026-09-24)

This records existing retrieval-gold behavior at iknow-memory base `0539ad5` before bounded `read_source` implementation. It is not G4 source-read acceptance: the long-body PostgreSQL plus MCP gold case does not exist yet.

## Fixture validation

`tests/eval/gold.test.ts` exited 0 with 21/21 tests passing. It verifies the frozen gold/corpus fixture shapes; it does not execute `read_source` or score retrieval queries.

## Twelve-query retrieval gold

The first unqualified CLI attempt exited 1 because graph and rerank were enabled while the evaluator did not construct those optional adapters. The supported vector+BM25 baseline was then run with these exact arguments, writing outside the repository:

```text
GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED=false \
GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED=false \
node dist/cli/eval-retrieve.js \
  --gold eval/gold/retrieve-v1.json \
  --corpus eval/corpus/retrieve-v1.json \
  --out /tmp/iknow-g4-planning-baseline.json
```

Exit 0. Output schema `iknow-retrieve-p5/v1`; gold `retrieve-gold-v1`; corpus `retrieve-corpus-v1`; arm set `vector+bm25`; 12 queries; mean P@5 `0.26666666666666666`; mean R@5 `1`.

| Gold query | Actual top-1 chunk | Actual P@5 | Actual R@5 |
| --- | --- | ---: | ---: |
| `q01-autovacuum` | `c-pg-autovacuum` | 0.2 | 1 |
| `q02-index-type` | `c-pg-index-choice` | 0.2 | 1 |
| `q03-hnsw` | `c-pgvector-hnsw` | 0.2 | 1 |
| `q04-bm25-knobs` | `c-bm25-okapi` | 0.2 | 1 |
| `q05-rrf` | `c-rrf-fusion` | 0.2 | 1 |
| `q06-ppr` | `c-neo4j-ppr` | 0.2 | 1 |
| `q07-bolt-pool` | `c-neo4j-bolt-pool` | 0.2 | 1 |
| `q08-mcp` | `c-mcp-tools-list` | 0.4 | 1 |
| `q09-vectors` | `c-embedding-dimensions` | 0.4 | 1 |
| `q10-chunking` | `c-chunk-window` | 0.2 | 1 |
| `q11-outbox` | `c-transactional-outbox` | 0.4 | 1 |
| `q12-extraction` | `c-triple-extraction` | 0.4 | 1 |

The evaluator used its MemoryBackend and a configured embedding endpoint. This result measures existing retrieval scoring, not PostgreSQL persistence or MCP `read_source` transport.

## G4 validation state

Not run: the G4 bounded-read implementation and committed long-body gold fixture do not exist yet. Real PostgreSQL plus MCP acceptance remains required by `specs/bounded-source-read.md`; the local Docker daemon was unavailable during this planning run.
