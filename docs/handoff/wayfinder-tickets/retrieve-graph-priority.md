# Local tickets — retrieve graph-priority ranking

> **CLOSED on main** (PR #94). Do not re-implement. Ranking order is the baseline under `plans/retrieve-graph-quality.md`.

| Artifact | Path                                                    |
| -------- | ------------------------------------------------------- |
| Spec     | `specs/retrieve-graph-priority.md`                      |
| Plan     | `plans/retrieve-graph-priority.md`（T1–T3 all done）    |
| Glossary | `docs/CONTEXT.md` → **hybrid retrieval** / **retrieve** |

## Bullets

| Id  | Tag                | Outcome                                         | Status |
| --- | ------------------ | ----------------------------------------------- | ------ |
| T1  | `[decision]`       | CONTEXT graph-priority terms                    | done   |
| T2  | `[implementation]` | graph hits front, fill, empty → vector+BM25 RRF | done   |
| T3  | `[implementation]` | eval armSet, not three-arm vote                 | done   |
