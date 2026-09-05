# Local tickets — retrieve and graph quality stack

> **CLOSED.** Do not execute from this table. T1–T11 are on main
> (`plans/retrieve-graph-quality.md`, PRs #118 / #120 / #123 / #171).
> Remaining work is `plans/retrieval-stack.md` T17–T24.
> Dedicated HTTP rerank (old T2) is an optional sidecar; production rerank is MiniMax LLM.

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

| Id  | Tag                | Outcome                                             | Status                | Blocks   |
| --- | ------------------ | --------------------------------------------------- | --------------------- | -------- |
| T1  | `[implementation]` | Temporary LLM rerank                                | **done** (#118)       | —        |
| T2  | `[implementation]` | Dedicated rerank HTTP on the same hook              | **done** (#171)       | T1       |
| T3  | `[implementation]` | Projection GC on drain                              | **done** (#171)       | parallel |
| T4  | `[implementation]` | Self-loop extract reject                            | **done** (#171)       | parallel |
| T5  | `[implementation]` | Persist `merged_into`                               | **done** (#171)       | parallel |
| T6  | `[implementation]` | Mode bundles                                        | **done** (#120)       | T1       |
| T7  | `[implementation]` | Neighbor chunk evidence                             | **done** (#120)       | T6       |
| T8  | `[implementation]` | Node embedding seeds from Postgres                  | **done** (#120)       | T1       |
| T9  | `[implementation]` | Community summaries (`plans/retrieve-community.md`) | **done** (2026-08-29) | T6       |
| T10 | `[implementation]` | Causal vocab + supersession CLI                     | **done** (#120)       | T5       |
| T11 | `[implementation]` | Optional retrieve wait-for-drain                    | **done** (#120)       | T3       |

**Frontier:** closed. Next: `plans/retrieval-stack.md` T17.

Inherits / Surface / Acceptance: only in `plans/retrieve-graph-quality.md` — do not duplicate here.
