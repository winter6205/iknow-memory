# Local tickets — retrieve LLM rerank (temporary main model)

> **CLOSED on main** (PR #118). Do not re-implement. Next rerank work is quality **T2** (dedicated HTTP) in `plans/retrieve-graph-quality.md`.

| Artifact            | Path                                                       |
| ------------------- | ---------------------------------------------------------- |
| Spec                | `specs/retrieve-rerank-llm.md`                             |
| Plan                | `plans/retrieve-rerank-llm.md`（T1–T3 all done）           |
| Glossary            | `docs/CONTEXT.md` → **rerank** / **embedding credentials** |
| Parent quality plan | `plans/retrieve-graph-quality.md`                          |

## Bullets

| Id  | Tag                | Outcome                                                               | Status |
| --- | ------------------ | --------------------------------------------------------------------- | ------ |
| T1  | `[decision]`       | Temporary reranker = extract Anthropic 主模型; default off; fail-open | done   |
| T2  | `[implementation]` | Enable gate on retrieve config; skip if no token                      | done   |
| T3  | `[implementation]` | Permute candidates after ranking; tests with fake LLM                 | done   |
