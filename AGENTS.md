# Project Instructions for Claude Code

## 读取规范

每次开始任务时按需读取：只读取与当前任务相关的文件。

---

## 代码规范

@.claude/rules/code-quality.md

## 测试规范

@.claude/rules/test.md

## 安全边界

@.claude/rules/security-boundaries.md

## Completion

汇报使用中文

完成后简要报告：

- 改了什么；
- 实际运行的验证及结果；
- 未验证内容及原因；
- 存在时报告风险、阻塞项以及 commit、push、release 等 Git/发布操作。

---

## 规范变更流程

修改本文件前必须：

1. 说明修改原因。
2. 说明影响范围。
3. 检查是否与 README / docs 冲突。
4. 单独提交规范变更，不与业务代码混合。

---

## 网络工具

- `mcp__exa__*`。

## Git 操作

- 自动commit。
- 无用户明确 `push` 授权则不执行 `git push`。

## 按需查阅（SSOT 指针）

Sibling checkout `../deer-flow` is read-only. Do not copy its tree into `src/fin`.
