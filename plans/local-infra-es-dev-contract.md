# Plan: 本机 Docker 三端 + ES 精度层开发契约收口（#226）

**Goal:** checkout 后有一条不靠口头的路径：Compose 起齐 Postgres / Neo4j / ES，host MCP 用**三个不同端点**接到产品默认（精度层开、ADR-0007 fail-start 仍在），并且真 ES 检索在 CI 与本机都不是 loud-skip 绿。
**Approach:** 先锁「本机是否独占 Compose 端口」；再把三服务与 MCP `env` 对齐；然后用活集群钉死词法套件（含 phrase 契约）；最后让 CI 无法 skip 当过，并清掉空串 pin / 错配的 host JSON。不推翻 ADR-0007，不把 MCP 装进容器，不改 fin spawn cwd。
**Spec link:** GitHub [#226](https://github.com/winter6205/iknow-memory/issues/226)；`docs/adr/0007-elasticsearch-fail-start.md`；`specs/es-precision-layer.md`；`docs/runbooks/local-infra.md`；`docs/mcp-config.md`
**ACR:** all-yes（见下）
**待写入:** （空 — 不新增 CONTEXT 词条，不 reopen ADR）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion（landing grain: operator 全局 commit 规则）

## 下一会话从哪续

分支 `feat/es-live-ci-226`（叠在 PR [#223](https://github.com/winter6205/iknow-memory/pull/223) compose 上）。已发生、**不算本计划完成**：

- WSL 用户已在 `docker` 组；仅 `elasticsearch` compose 服务在跑（`iknow-memory-es` / 8.19.20 + analysis-ik）。
- 活套件 `tests/integration/bm25-pg.test.ts`：中文检索 / 空查询 / k1 重建 **过**；phrase「on/off 排序必须不同」**不过**（真 BM25 上两条短文顺序不变）。
- `.env.local` 与 Cursor 用户 MCP（`~/.cursor/mcp.json`）已是 pgvector + `ES_URL=http://127.0.0.1:9200`，但 **DB 仍是本机 `postgres@localhost/postgres`，不是 compose 的 `iknow_memory`**；`7687` 当时无人听。
- 未收口：workflow `test-es`、`CI=true` 探测失败即失败、tracked `.mcp.json` 去掉空 `ES_*`、phrase 断言改契约。

## ACR

- bounded-context-guardian: yes — Compose / CI / host MCP JSON 停在 infra 与 host 配置；精度层仍是已有 storage 适配；Node MCP 继续宿主机进程
- input-contract-tests: yes — 公共启动契约仍是 `loadEnv` fail-start；词法契约仍由已有 live 套件证明；不新增 MCP tool
- error-handling-enforcer: yes — CI 上 ES 不可达必须失败而非 skip；已配置 ES 的 retrieve 期失败仍 ADR-0007 fail-open；不引入空 catch
- complexity-anti-drift: yes — 接线与文档，不新增编排层
- minimal-change-verifier: yes — 单一结果：产品形状的本机三端 + 被证明的 ES + 对齐的 host env；不做 dashboard / extract 新功能

## Tasks (ordered by dependency)

1. **锁定本机端口主权（Compose 独占 vs 混搭）** — tag: `[decision]`
   - **Inherits:** #226 选项 1「ES 是必起开发依赖」；ADR-0007 精度层缺地址 fail-start；三端点不是同一 URL（Postgres `DB_URL`、Neo4j `NEO4J_URI`、ES `ES_URL`）。
   - **Surface:** `docs/adr/` 仅当要 reopen 开发契约；否则只把结论写进本计划勾选 + `docs/runbooks/local-infra.md` 的「本机已有 5432/7687」段。
   - **Acceptance:** 书面选定其一：(A) 停掉占用 5432/7687 的非 compose 进程，三服务都走仓库 Compose 与 `.env.example` 开发凭据；(B) 明确混搭（本机 PG + 本机/脚本 Neo4j + compose ES）并列出 MCP 必须填写的三套 URL。未选定不得改 MCP 凭据。
   - **Decision 2026-09-14: A.** 本机 5432 被系统 PostgreSQL 16 占用（同实例还有其它本地项目库）；operator 选 Compose 独占三端口，停系统 PG 的操作由 operator 本人执行（operator 原话「重启让我来」）。已写入 `docs/runbooks/local-infra.md` §Port ownership。
   - Status: [x] done

2. **三服务 healthy，MCP 三 URL 与选定栈一致** — tag: `[implementation]`
   - **Inherits:** T1 的选定；compose 不弱化 fail-start；MCP `env` 是 host SSOT、禁止空字符串 pin；WSL 连 ES 用 `127.0.0.1` 而非可能 RST 的 `localhost`；`BM25=false` 只是逃生门不是产品默认。
   - **Surface:** 仓库根 Compose；host MCP JSON（Cursor 用户 `mcp.json` / 项目 `.cursor/mcp.json`）；`.env.local` fallback。
   - **Acceptance:** `docker compose` 按 T1 范围 `--wait` 至 healthy；`loadEnv()` 在 host 注入的 env 下 `bm25Enabled=true` 且 `elasticsearch` 有地址；Postgres 与 Neo4j 地址与 T1 一致且进程可连；MCP 重启后 `tools/list` 可见 `ingest`/`retrieve`。不把 Node MCP 做成 compose service。
   - **Evidence 2026-09-14:** operator 停系统 PG 后 `docker compose up -d --wait` 三端全 healthy（Neo4j 镜像含 GDS 2.13.2 build 成功）。`loadEnv()`（clean process.env，走 `.env.local`）= `storage=pgvector` / `bm25Enabled=true` / `esNode=http://127.0.0.1:9200` / `neo4j=bolt://127.0.0.1:7687` + auth。PG `iknow_memory@iknow_memory v16.15` 可连、schema bootstrap 出 7 表 + vector；Neo4j host 侧 `RETURN 1` 与 `gds.version()=2.13.2` 通；MCP stdio `tools/list` 见 `ingest`/`retrieve`（+`invalidate`/`push`/`extract`）；端到端 ingest→retrieve 中文查询命中该 chunk（PG 1 行 + ES `_count` 1），探针数据已清理。`.env.local` 补 `NEO4J_USER`/`NEO4J_PASSWORD`（原本只有 URI，compose 开认证会连不上）。
   - Status: [x] done
   - [blocks: T1]

3. **真 ES 词法套件按产品契约全绿** — tag: `[implementation]`
   - **Inherits:** `specs/es-precision-layer.md` 中文切词与 BM25；phrase 是精度层能力（默认 on 的 `match_phrase`），不是「on/off 两次 id 顺序必须不同」。
   - **Surface:** 已有 live 套件与 `ElasticsearchPrecisionLayer.searchLexical`。
   - **Acceptance:** 对着可达的 8.x+analysis-ik 跑现有 live 文件：**中文查询命中中文 chunk**、空查询 `[]`、改 k1 重建后排序变化、**phrase-on 时含连续短语的目标 chunk 为第一**；phrase-off 仍能命中目标。不再用「两次 JSON 顺序不等」当唯一断言。本地无 ES 时仍 loud-skip 且 exit 0。
   - **Evidence 2026-09-14（三态，主 agent 实测）:** ① 可达 `GRAPHRAG_MEMORY_ES_URL=http://127.0.0.1:9200` → `4 passed` exit 0（中文命中 / 空查询 / k1 重建 / phrase-on 目标第一全绿）；② 不可达 `http://127.0.0.1:9` 且不设 `CI` → `4 skipped` + loud Validation block，exit 0；③ 不可达 + `CI=true` → `Test Files 1 failed`，exit 1（顶层 throw 未被 vitest 吞掉）。
   - **phrase 区分力修复（code-review High，已修）:** 原 fixture 目标文本句末句点使 IK 索引期 token 为 `chunks.`、查询期为 `chunks`，`match_phrase` 位置链断裂永不命中——实测 phrase on/off 分数完全相同（1.2401 = 1.2401），断言无区分力。改为无句点 target + 词频干扰 distractor 后：`phrase=on` target 第一且 `score 2.358 > 0.998`，`phrase=off` distractor 第一（排序翻转）；**变异测试**（把实现 `if (precision.phrase ?? true)` 临时写死为 `if (false)`）→ 用例失败 `expected <distractor> to be <target>`，恢复后通过——证明开关失效时断言真的会红（修复前同样变异下仍通过）。unit 层补 `phrase: false` 时 query body 不含 `match_phrase` 的反向断言（原先只测 `phrase: true` 方向）。
   - Status: [x] done
   - [blocks: T2]

4. **CI 无法把 ES 套件 skip 成绿** — tag: `[implementation]`
   - **Inherits:** T3 的 live 命令；#226「没有任何测试证明开发者机器上 ES 可启动」必须被 CI 补上；`test-full` 已有 Postgres service，Compose Postgres 不得再占 `:5432`。
   - **Surface:** `.github/workflows/test.yml`；同一 live 套件。
   - **Acceptance:** PR/main 有 job 只起 compose `elasticsearch`（`--no-deps`）并跑 T3 那条 live 文件；夜间 `test-full` 同样起 ES 并设置 `GRAPHRAG_MEMORY_ES_URL`；`CI=true` 且探针失败时该文件 **非 0 退出**。`test-fast` 仍排除 `tests/integration/**`。
   - **Evidence 2026-09-14:** YAML 解析（node `yaml` + python3 PyYAML 双路径）确认 `test-es` 只起 `--no-deps elasticsearch` 且跑 live 文件、无 `services:` 块；`test-full` 有 `GRAPHRAG_MEMORY_ES_URL` 且用 workflow `services.postgres`（非 compose PG，避免 `:5432` 二次绑定）；`vitest list` 证实 `test-fast` 排除集命中 0 个 `tests/integration/**`；`grep continue-on-error|\|\| true` 无命中；`vitest run does-not-exist.test.ts` 非 0 退出（路径漂移不静默）。**修复一处本次插入 job 引入的 guard 逃逸路径**：`scripts/ci-check-test-excludes.ts` 原用 `slice("test-fast:", "test-full:")` 切段，会把中间的 `test-es` 段并入 test-fast 判定集（对照实验：test-es 里加一条 `--exclude` → 旧脚本 exit 0 假通过；新脚本 exit 1 点名该文件）；改为按 `jobs:` 下真实 job 边界切片，正常树仍 exit 0。
   - Status: [x] done
   - [blocks: T3]

5. **[parallel] Host 模板不再错配** — tag: `[implementation]`
   - **Inherits:** `docs/mcp-config.md`：host `env` SSOT；禁止 `"GRAPHRAG_MEMORY_ES_URL": ""`；tracked JSON 保持 launch-only（无 secret、无空串 pin）。
   - **Surface:** tracked `.mcp.json`；`docs/mcp-config.md` / `docs/runbooks/local-infra.md` / `docs/runbooks/es-precision-layer.md`。
   - **Acceptance:** git 跟踪的 MCP JSON 不含空 ES/索引键、不含把产品路径钉成 `memory` 的 env；文档写明三 URL、Compose 凭据 vs 本机已有实例、WSL 用 `127.0.0.1:9200`；Cursor 用户 MCP 与 T1/T2 一致（本机文件，不提交密钥）。
   - **Evidence 2026-09-14（仓内部分）:** tracked `.mcp.json` 收敛为 launch-only（去掉 `STORAGE: "memory"` 与四个空串 pin）；`README.md` 的两行空串 ES 索引键一并清除，全仓 tracked 文件 grep 后仅剩文档反例；`docs/mcp-config.md` 补三条 URL 填法 / WSL `127.0.0.1` 专节 / 空串 pin 三态语义 / Compose 凭据 vs 本机实例对照表；`docs/runbooks/es-precision-layer.md` 补 WSL 提示。
   - **Host 本地部分（operator 手工核对，未随 PR 提交）:** `~/.cursor/mcp.json` 与 `.cursor/mcp.json` 已改为 compose 端点（`iknow_memory` 库 + `NEO4J_USER/PASSWORD`），由主 agent 原地改、未读值、未提交。其余 operator 若自建 host 注册，按 `docs/mcp-config.md` 对照表自查。
   - Status: [x] done（仓内可提交面）；host 本地一致性由 operator 自查
   - [parallel] 相对 T3；仍 [blocks: T1]

## 明确不做

- 推翻 ADR-0007 / 默认关 BM25 / 缺地址 degraded 启动（#226 选项 2/3）。
- 把 TypeScript MCP 打进 Docker。
- fin-serve cwd（fin#263）。
- 为过 phrase 断言去改生产 query 形状，除非 T3 证明 phrase-on 连「目标第一」都做不到。

## 实施结束后

整轮 `code-review`（Standards + Spec）。`GATE: BLOCKED` → `review-report-repair`。关 #226 仅当 T2–T4 的 Acceptance 有实测记录（compose ps / live 套件 / CI job），而不是「workflow 已写」。

## T1 决策的已知代价（全量套件实测，2026-09-14；2026-09-15 已收口）

停掉系统 PG、让 Compose 独占 5432 之后，本机 `npm test` 曾出现 54 failed / 1490 passed：

- **52 条 = 环境前提变化。** 四个套件曾把 `postgresql://postgres@localhost/postgres` 硬编码
  （`tests/schema-bootstrap.test.ts`、`tests/cli/extract.test.ts`、
  `tests/cli/extract-e2e-graph.test.ts`、`tests/integration/extraction-pg.test.ts`），
  依赖系统 PG 的 `postgres` 库与角色；Compose PG 只有 `iknow_memory` 库。
  **已交付：** 四个套件经 `resolvePgConnectionString` 读 `GRAPHRAG_MEMORY_DB_URL`，
  并在 process env 未设时读 `.env.local`（与 `loadEnv` 相同：键存在即使空串也不回落到文件）。
  `schema-bootstrap` 改在独立 schema 里 DROP/重建，不再碰 `public.chunks`。
  CI 上 PG 探针失败与 ES 套件同形：`CI=true` 硬失败，本地仍 loud-skip。
- **2 条 = pre-existing 测试缺陷。** `tests/cli/es-reindex.unit.test.ts` 的
  `vi.doMock` 被 ESM 模块缓存绕过。**已交付：** 用例改用 `vi.resetModules()`。
