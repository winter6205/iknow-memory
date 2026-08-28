# Local tickets — retrieve and graph quality stack

GitHub issues **are not the SSOT** for a PR remote (cannot rely on `gh issue view`). Execute from files:

| Artifact                         | Path                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| Spec                             | `specs/retrieve-graph-quality.md`                              |
| Plan (tracer bullets + blocking) | `plans/retrieve-graph-quality.md`                              |
| Slice 0 extra plan               | `plans/retrieve-rerank-llm.md`                                 |
| Glossary                         | `docs/CONTEXT.md`                                              |
| Map index                        | `docs/handoff/wayfinder-tickets/map-retrieve-graph-quality.md` |

Claim a bullet by marking **Status** in `plans/retrieve-graph-quality.md` on the feature branch. Do not wait on tracker assignee.

## Bullets

| Id  | Tag                | Outcome                                               | Blocks   |
| --- | ------------------ | ----------------------------------------------------- | -------- |
| T1  | `[implementation]` | Temporary LLM rerank (`retrieve-rerank-llm` T2–T3)    | —        |
| T2  | `[implementation]` | Dedicated rerank HTTP on the same hook                | T1       |
| T3  | `[implementation]` | Projection GC on drain                                | parallel |
| T4  | `[implementation]` | Self-loop extract reject                              | parallel |
| T5  | `[implementation]` | Persist `merged_into`                                 | parallel |
| T6  | `[implementation]` | Mode bundles `conservative` / `balanced` / `tokenmax` | T1       |
| T7  | `[implementation]` | Neighbor chunk evidence                               | T6       |
| T8  | `[implementation]` | Node embedding seeds from Postgres                    | T1       |
| T9  | `[implementation]` | Community summaries for topic retrieve                | T6       |
| T10 | `[implementation]` | Causal vocab + supersession CLI                       | T5       |
| T11 | `[implementation]` | Optional retrieve wait-for-drain                      | T3       |

Frontier: **T1**, plus **T3 / T4 / T5** in parallel.

Inherits / Surface / Acceptance: read the matching numbered item in `plans/retrieve-graph-quality.md`. Do not invent a second copy here.
