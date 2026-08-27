# Local tickets — retrieve graph-priority ranking

GitHub issues **not** the SSOT for this remote. Read:

| Artifact   | Path                                                     |
| ---------- | -------------------------------------------------------- |
| Spec       | `specs/retrieve-graph-priority.md`                       |
| Plan       | `plans/retrieve-graph-priority.md`                       |
| Glossary   | `docs/CONTEXT.md` → **hybrid retrieval** / **retrieve**  |
| Do not mix | `plans/retrieve-rerank-llm.md` (rerank after this order) |

## Bullets

| Id  | Tag                | Outcome                                                                    |
| --- | ------------------ | -------------------------------------------------------------------------- |
| T1  | `[decision]`       | **done** — CONTEXT graph-priority terms                                    |
| T2  | `[implementation]` | `assembleRetrievalResult`: graph hits front, fill, empty → vector+BM25 RRF |
| T3  | `[implementation]` | eval CLI/tests: arm set, not three-arm vote                                |

Order: T1 → T2 → T3.

## Impl surfaces (not frozen filenames)

- `src/core/retrieval/index.ts` (`assembleRetrievalResult`)
- `src/core/retrieval/rrf.ts` (vector+BM25 only on fallback/fill)
- `tests/retrieval/*`, `tests/tools/retrieve-graph.test.ts`, `tests/defensive/retrieval-defensive.test.ts`
- `tests/cli/eval-retrieve.unit.test.ts`
