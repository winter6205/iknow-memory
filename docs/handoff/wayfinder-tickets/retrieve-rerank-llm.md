# Local tickets — retrieve LLM rerank (temporary main model)

GitHub issues **not** the SSOT for this remote (cannot `gh issue view`). Read:

| Artifact                          | Path                               |
| --------------------------------- | ---------------------------------- |
| Spec                              | `specs/retrieve-rerank-llm.md`     |
| Plan (tracer bullets)             | `plans/retrieve-rerank-llm.md`     |
| Glossary                          | `docs/CONTEXT.md` → **rerank**     |
| Ranking (separate, not this impl) | `specs/retrieve-graph-priority.md` |

## Bullets

| Id  | Tag                | Outcome                                                               |
| --- | ------------------ | --------------------------------------------------------------------- |
| T1  | `[decision]`       | Temporary reranker = extract Anthropic 主模型; default off; fail-open |
| T2  | `[implementation]` | Enable gate on retrieve config; skip if no creds                      |
| T3  | `[implementation]` | Permute candidates after ranking; tests with fake LLM                 |

T3 blocks on T2; T2 on T1 (T1 flushed in CONTEXT this turn).

## Impl surfaces (not frozen filenames)

- `src/config.ts` / `RetrieveConfig`
- `src/core/retrieval/index.ts` (`assembleRetrievalResult`)
- extract LLM adapter under `src/core/extraction/` (reuse Anthropic trio)
- `src/tools/retrieve.ts` (wiring only if deps change)
- `tests/retrieval/*`, `tests/config.test.ts`, `tests/tools/*`
