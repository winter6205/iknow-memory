# Local tickets — retrieve community summaries

**GitHub issues are not the tracker.** Execute from files only:

| Artifact    | Path                                      |
| ----------- | ----------------------------------------- |
| Spec        | `specs/retrieve-community.md`             |
| Plan (SSOT) | `plans/retrieve-community.md`             |
| Parent slot | `plans/retrieve-graph-quality.md` T9      |
| Glossary    | `docs/CONTEXT.md` (**community**)         |
| Parent spec | `specs/retrieve-graph-quality.md` slice 8 |

Claim a bullet by marking **Status** in `plans/retrieve-community.md` on the feature branch.

## Bullets

| Id  | Tag                | Outcome                            | Status  | Blocks         |
| --- | ------------------ | ---------------------------------- | ------- | -------------- |
| T1  | `[implementation]` | Persist community summary ledger   | **done** (2026-08-29) | quality T6     |
| T2  | `[implementation]` | Index-time Louvain + summary job   | **done** (2026-08-29) | T1             |
| T3  | `[implementation]` | Retrieve includes ledger summaries | **done** (2026-08-29) | T1, quality T6 |

**Frontier:** quality T6, then this file’s T1.

Inherits / Surface / Acceptance: only in `plans/retrieve-community.md` — do not duplicate here.
