# Session Handoff — Plan D0 iknow-side implementation (2026-09-02)

## 当前 live 状态

- **任务**: 在 iknow-memory 仓实施 Plan D0 跨仓联调 iknow 侧 7 个子弹 (I-T1–I-T7)，让 fin 能连上本进程
- **为什么重要**: Plan D0 是跨仓缺口 1–6 的联调切片，本仓侧收齐后 fin 侧 push_port / invalidation_port 才能实际命中
- **operator 显式指令**: 「Plan D0 iknow：/home/winner/projects/iknow-memory-wt-plan-d0 → 同名 plans/2026-09-02-plan-d0-cross-repo-wire.md，skill check，进入工作树进行实施，全程自主决策最优选，做完更新对应pr，合理使用subagents（并发不超过2）」

## 已固化工件（引用，不复制 inline）

| 类型         | 路径 / URL                                                                         |
| ------------ | ---------------------------------------------------------------------------------- |
| 计划         | `plans/2026-09-02-plan-d0-cross-repo-wire.md`（I-T1–I-T7 已标 [x] completed）      |
| 配对计划     | fin 仓 `plans/2026-09-02-plan-d0-cross-repo-wire.md`（仅文档，未实施）             |
| Spec / ADR   | `specs/corpus-retrieval.md` §B2–§B4、ADR 0032 / 0037 / 0039（§B4 是 8 能力键权威） |
| 对侧缺口表   | fin 仓 `docs/cross-repo/alignment-proposal.md`                                     |
| PR (本侧)    | https://github.com/winter6205/iknow-memory/pull/173                                |
| PR (对侧)    | https://github.com/winter6205/fin/pull/229                                         |
| 上游合并基线 | iknow `94d70ba`（Plan D0 文档基线）                                                |

## 本 session 变更（iknow 侧工作树 `/home/winner/projects/iknow-memory-wt-plan-d0`）

| 变更（文件路径）                                           | 一行效果                                                           | Commit SHA |
| ---------------------------------------------------------- | ------------------------------------------------------------------ | ---------- |
| `src/tools/retrieve.ts`                                    | 输入 schema 由 `z.object` 改为 `z.strictObject`                    | `e617a30`  |
| `tests/retrieve.test.ts`                                   | 新增 strict 输入护栏 + `chunks[]`/`source_ref` 信封护栏            | `e617a30`  |
| `bin/iknow-memory.js`（新）                                | shebang 包装，调用 `dist/index.js` 的 `main()`                     | `fc4b963`  |
| `src/cli/stdio-entry.ts`（新）                             | argv parser：`[]` 与 `["serve"]` → stdio，其它具名失败             | `fc4b963`  |
| `tests/cli/stdio-entry.test.ts`（新）                      | argv 解析 + bin 入口存在性 + package.json bin 字段对照             | `fc4b963`  |
| `package.json`                                             | `bin` 加 `"iknow-memory": "bin/iknow-memory.js"`                   | `fc4b963`  |
| `src/index.ts`                                             | import `parseStdioEntry` + `main(argv?)` 前置校验；BAD_CONFIG 退出 | `fc4b963`  |
| `src/tools/push.ts`（新）                                  | strictObject 输入，幂等键 `(source_ref, contentIdentity)`          | `695fb39`  |
| `tests/tools/push.test.ts`（新）                           | 幂等去重、B4 字段必填、字节回环（含 I-T7 行为护栏）                | `695fb39`  |
| `src/index.ts`（增量）                                     | 注册 `pushTool(deps)`                                              | `695fb39`  |
| `tests/host-smoke.test.ts`（增量）                         | tools/list 期望加 `push`                                           | `695fb39`  |
| `tests/index.test.ts`（增量）                              | tools/list 期望加 `push`                                           | `695fb39`  |
| `src/tools/invalidation.ts`（新）                          | strictObject 输入，复用 backend helpers，幂等去重                  | `e822b5b`  |
| `tests/tools/invalidation.test.ts`（新）                   | 关区间、同 args 重复、timeline append、未知 source_ref typed 失败  | `e822b5b`  |
| `src/index.ts`（增量）                                     | 注册 `invalidationTool(deps)`                                      | `e822b5b`  |
| `tests/host-smoke.test.ts` + `tests/index.test.ts`（增量） | tools/list 期望加 `invalidation`                                   | `e822b5b`  |
| `tests/tools/capability-keys.test.ts`（新）                | 8 键权威 + 无 legacy alias + fin `capability_keys.json` 镜像对齐   | `87759d9`  |
| `tests/tools/push-no-chunker.test.ts`（新）                | 静态护栏：`chunker.ts` 不存在、`push.ts` 不切 `content`            | `3169295`  |
| `plans/2026-09-02-plan-d0-cross-repo-wire.md`（增量）      | I-T1–I-T7 标 [x] completed；End of round 列出 6 commit             | `cf9a00f`  |

fin 侧工作树 `/home/winner/projects/fin-wt-plan-d0`：

| 变更（文件路径）                                              | 一行效果                                        | Commit SHA |
| ------------------------------------------------------------- | ----------------------------------------------- | ---------- |
| `plans/2026-09-02-plan-d0-cross-repo-wire.md`（仅文档，新增） | 缺口 1–6 的 fin 侧执行切片（与 iknow 同名配对） | `ee62252`  |

## 已验证状态

```
$ npx vitest run tests/retrieve.test.ts tests/tools/push.test.ts tests/cli/stdio-entry.test.ts tests/tools/invalidation.test.ts tests/tools/capability-keys.test.ts tests/tools/push-no-chunker.test.ts tests/index.test.ts tests/host-smoke.test.ts
=> exit 0 — all green

$ npm test    # full sweep incl. host-smoke stdio round-trip
=> 1286 passed, 10 skipped (live PG/Neo4j), 0 failed

$ npm run typecheck
=> exit 0 — clean

$ git push origin docs/plan-d0-cross-repo-wire
=> cf9a00f pushed (7 commits ahead of 94d70ba)

$ gh pr edit 173 --body "..."    # updated PR body with 6-commit table
=> https://github.com/winter6205/iknow-memory/pull/173

$ gh pr comment 173 --body "..." # posted 7-commit落点表
=> https://github.com/winter6205/iknow-memory/pull/173#issuecomment-5499634132
```

## Open blockers + next steps

**[NEXT] fin 侧 PR #229 实施 T1–T7（按 fin 仓同名 plan 的 7 个 fin 侧子弹），完成后做跨仓 code-review + verification-before-completion。**

- fin 侧 T1：retrieve 请求不再静默剥键（fin 适配器把 `top_k`/`filter`/`document_id` 映射到 `limit`/`filters` 后再发）
- fin 侧 T2：retrieve 响应按 `chunks` 映射 locator
- fin 侧 T3：`DEFAULT_MCP_COMMAND` 与 iknow I-T3 公布的 argv 逐字一致（已对齐到 `("iknow-memory",)`，fin 侧无需改动）
- fin 侧 T4：客户端接 push，调本仓 `push` 工具
- fin 侧 T5：客户端接 invalidation，调本仓 `invalidation` 工具
- fin 侧 T6：消费 B4 信封字段与 8 能力键
- fin 侧 T7：opt-in 不二次切分对账（现有样本）
- 跨仓联调：opt-in 跑 fin → iknow 真实进程对账（不在默认 pytest 范围）

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:code-review` — 双仓 plan 对齐后做跨仓 code-review（Standards + Spec 双轴）
- `arthurpower:verification-before-completion` — 跨仓联调完成、commit 全部入库后做最终 verification
- `arthurpower:test-driven-development` — fin 侧实施时仍按 TDD 节奏（failing test → minimal impl → refactor）
- `arthurpower:using-agent-skills` — 若下一阶段跨多文件跨模块，先用此 skill 路由

## 脱敏

- 无 API key / token / password / credential 值出现
- GitHub 用 `gh` CLI 的现有认证，不在文件里写任何 secret
- fin / iknow 仓的内部 env-var 名（如 `GRAPHRAG_MEMORY_DB_URL`、`NINE_ROUTER_KEY`）已在 commit message / docstring 引用过，未在 handoff 中重复值
