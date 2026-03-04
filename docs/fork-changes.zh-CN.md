# Fork 改动说明（相对上游 `ChiChou/grapefruit`）

本文档用于说明本仓库在长期迭代后，相对上游项目的核心改动方向。

## 1. 场景化自动化测试能力

- 新增场景管理与执行链路：
  - 后端：`src/routes/scenarios.ts`、`src/lib/scenario-runner.ts`、`src/lib/scenario-templates.ts`
  - 存储：`src/lib/store/scenarios.ts`
  - 前端：`gui/src/components/panels/ScenarioManager.tsx`
- 支持模板导入、步骤编排、断言执行与运行记录，方便回归和复现。

## 2. MCP 控制与自动化编排

- 新增 MCP 路由与配置能力：`src/routes/mcp.ts`、`src/lib/mcp-config.ts`
- 新增 MCP 自动化结果与证据存储：`src/lib/store/mcp-automation.ts`
- 前端新增 MCP 控制与可视化组件：`gui/src/components/shared/McpControl.tsx`

## 3. Hook 脚本资产与管理能力增强

- 新增脚本管理能力：
  - 存储：`src/lib/store/scripts.ts`
  - 前端：`gui/src/components/panels/HookScriptsManager.tsx`
- 新增内置脚本目录：`builtin-frida-script/`、`public-frida-script/`
- 新增内置脚本清单：`src/lib/builtin-hooks.ts`

## 4. 时间线与会话可观测性增强

- 新增时间线会话上下文与展示组件：
  - `gui/src/context/TimelineSessionContext.tsx`
  - `gui/src/components/shared/TimelineSessionView.tsx`
- 会话管理、日志流和多处面板联动能力增强，便于排障与取证。

## 5. 功能覆盖与质量保障扩展

- 核心能力扩展涉及 `src/session.ts`、`src/routes/data.ts`、`src/routes/devices.ts`、`src/routes/transfer.ts` 等链路。
- 测试覆盖增强：`src/tests/app.test.ts`、`src/tests/ws.test.ts`、`src/tests/helpers/environment.ts`

## 6. 文档与技能包扩展

- 新增中文部署使用文档：`docs/install-deploy-usage.zh-CN.md`
- 新增技能包与索引：
  - `skills/index.json`
  - `skills/*/SKILL.md`
  - `scripts/skills-validate.ts`

## 7. 仓库维护性调整

- 为避免误提交本地运行数据，已将 `.grapefruit-state/` 加入 `.gitignore`。

