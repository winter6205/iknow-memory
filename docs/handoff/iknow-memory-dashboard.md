# Handoff — iknow-memory dashboard

| Artifact                             | Path / URL                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Wayfinder map                        | [冻结 PR 187，重写 memory 监控看板](https://github.com/winter6205/iknow-memory/issues/188)       |
| Spec                                 | `specs/iknow-memory-dashboard.md`                                                                |
| Plan                                 | `plans/iknow-memory-dashboard.md`                                                                |
| Glossary                             | `docs/CONTEXT.md` · **iknow-memory dashboard**                                                   |
| Palette prototype                    | `docs/wayfinder/prototypes/iknow-memory-palette-193.html`                                        |
| Frozen implementation (do not merge) | PR [187](https://github.com/winter6205/iknow-memory/pull/187) · `worktree-memory-dashboard-plan` |
| This branch                          | `docs/iknow-memory-dashboard`                                                                    |

Implement from **main + this branch**, not from 187.

## SC6 browser-pass record (2026-09-09 leftover remediation)

Command: `npm run dashboard` in this worktree (zero storage env → memory). Then:

```
curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18868/   # 200
curl -sS http://127.0.0.1:18868/api/stats                         # 200 empty zeros
curl -sS http://127.0.0.1:18868/api/chunks                        # 200 empty page
curl -sS http://127.0.0.1:18868/api/graph                         # 503 NEO4J_UNAVAILABLE
curl -sS http://127.0.0.1:18868/api/entities/<uuid>/backlinks     # 503 NEO4J_UNAVAILABLE
```

Operator checklist (冷墨 default / 晨纸 switch / one empty page) is in README § iknow-memory dashboard. No Playwright added. Shut down with Ctrl-C on the orchestrator.
