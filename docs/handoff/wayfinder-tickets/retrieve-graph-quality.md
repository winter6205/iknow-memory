# Local tickets — retrieve and graph quality stack

**GitHub issues are not the tracker.** Execute from files only:

| Artifact             | Path                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| Spec                 | `specs/retrieve-graph-quality.md` (+ slice 8: `specs/retrieve-community.md`) |
| Plan (SSOT + Status) | `plans/retrieve-graph-quality.md`                                            |
| Slice 8 detail plan  | `plans/retrieve-community.md`                                                |
| Slice 0 (closed)     | `plans/retrieve-rerank-llm.md`                                               |
| Glossary             | `docs/CONTEXT.md`                                                            |
| Map index            | `docs/handoff/wayfinder-tickets/map-retrieve-graph-quality.md`               |

Claim a bullet by marking **Status** in `plans/retrieve-graph-quality.md` on the feature branch.

## Bullets

| Id  | Tag                | Outcome                                             | Status          | Blocks   |
| --- | ------------------ | --------------------------------------------------- | --------------- | -------- |
| T1  | `[implementation]` | Temporary LLM rerank                                | **done** (#118) | —        |
| T2  | `[implementation]` | Dedicated rerank HTTP on the same hook              | pending         | T1       |
| T3  | `[implementation]` | Projection GC on drain                              | pending         | parallel |
| T4  | `[implementation]` | Self-loop extract reject                            | pending         | parallel |
| T5  | `[implementation]` | Persist `merged_into`                               | pending         | parallel |
| T6  | `[implementation]` | Mode bundles                                        | pending         | T1       |
| T7  | `[implementation]` | Neighbor chunk evidence                             | pending         | T6       |
| T8  | `[implementation]` | Node embedding seeds from Postgres                  | pending         | T1       |
| T9  | `[implementation]` | Community summaries (`plans/retrieve-community.md`) | pending         | T6       |
| T10 | `[implementation]` | Causal vocab + supersession CLI                     | pending         | T5       |
| T11 | `[implementation]` | Optional retrieve wait-for-drain                    | pending         | T3       |

**Frontier:** **T2**（首选），或并行 **T3 / T4 / T5**。

Inherits / Surface / Acceptance: only in `plans/retrieve-graph-quality.md` — do not duplicate here.
