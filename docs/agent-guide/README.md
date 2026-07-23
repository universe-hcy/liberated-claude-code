# Agent Guide — 代码库开发手册

> 这是一套 **面向 AI 开发 agent** 的代码库地图。目标：让 agent（和人类）在最短时间内理解 `claude-code-best` 的架构、数据流与扩展点，从而准确回答设计/技术问题，并快速定位、开发新功能。
>
> 与 `docs/` 下其它文档的区别：`docs/features/`、`docs/extensibility/` 等是**面向用户/概念**的 Mintlify 文档；本目录是**面向开发的代码库地图**——"东西在哪、数据怎么流、改哪个文件"。

## 如何使用这套文档

1. **不了解项目** → 先读本页 + [`01-architecture.md`](./01-architecture.md)。
2. **要回答"XX 是怎么实现的"** → 用下面的「按主题索引」跳到对应文档，每篇都有 `file:line` 级引用。
3. **要开发新功能** → 直接看 [`10-how-to.md`](./10-how-to.md)（"如何添加 X" 配方集），它会把你导向具体子系统文档。
4. **每篇文档结构统一**：`职责 → 关键文件 → 数据流 → 扩展点（如何修改）→ 陷阱`。

## 文档索引

| 文档 | 内容 | 关键问题 |
|------|------|----------|
| [`01-architecture.md`](./01-architecture.md) | 全局架构、分层、目录地图 | 项目整体长什么样？ |
| [`02-entry-and-commands.md`](./02-entry-and-commands.md) | 启动流程、CLI 快速路径、Commander 子命令、slash 命令 | 程序怎么启动？命令怎么注册？ |
| [`03-core-loop.md`](./03-core-loop.md) | `query.ts` / `QueryEngine.ts` 会话循环、流式、工具调用、压缩 | 一个 turn 怎么跑完？ |
| [`04-api-and-providers.md`](./04-api-and-providers.md) | API 客户端、7 个 provider、OpenAI/Gemini/Grok 兼容层 | 请求怎么发出去？怎么加 provider？ |
| [`05-tool-system.md`](./05-tool-system.md) | Tool 接口、内置工具、注册、延迟加载 | 工具怎么定义/注册？怎么加工具？ |
| [`06-ui-ink.md`](./06-ui-ink.md) | Ink 终端 UI、REPL、组件树、权限 UI、主题、键位 | 界面怎么渲染？怎么加组件/键位？ |
| [`07-state-build-flags.md`](./07-state-build-flags.md) | AppState、bootstrap 单例、build 管线、MACRO defines、feature flags | 状态放哪？怎么构建？怎么加 flag？ |
| [`08-commands-services-packages.md`](./08-commands-services-packages.md) | `src/commands/`、`src/services/`、workspace 包总览、MCP、bridge/daemon/acp | 目录里都有啥？包怎么用？ |
| [`09-testing.md`](./09-testing.md) | 测试框架、mock 规范、跨文件污染、precheck | 怎么写测试？为什么会互相污染？ |
| [`10-how-to.md`](./10-how-to.md) | "如何添加 X" 配方集（工具/provider/命令/flag/组件…） | 我要开发一个 X，从哪下手？ |
| [`11-agents-fork-subagent.md`](./11-agents-fork-subagent.md) | 两套 fork 机制、AgentTool spawn、隐式 fork、agent 定义/工具限制、coordinator/teammate、`/fork` | fork agent 和 subagent 怎么跑？怎么加？ |
| [`12-pattern-trunk-orchestrator.md`](./12-pattern-trunk-orchestrator.md) | 设计方案：主干编排 + 阶段 worker + fork/subagent 自适应选择（成本模型 · 2×2 · 谁决定 · author-time 路由 · 三档落地） | 长流程任务怎么用 agent 编排出好效果？fork 还是 subagent？ |

## 30 秒速览

- **本质**：Anthropic 官方 Claude Code CLI 的**逆向/反编译版本**，恢复核心功能、裁剪次要能力。大量模块通过 **feature flag** 开关或桩化。
- **运行时**：**Bun**（非 Node.js）。ESM + TSX（`react-jsx`）。TypeScript **strict** 模式，`bun run precheck` 必须零错误。
- **规模**：`src/` 约 **2369** 个 ts/tsx 文件，**152** 个组件，**120** 个命令目录，**17+** 个 workspace 包。
- **UI**：终端 **Ink**（React 渲染到终端），fork 版在 `packages/@ant/ink/`（**不是** `src/ink/`）。
- **核心链路**：`cli.tsx`（入口/快速路径）→ `main.tsx`（Commander 命令）→ REPL → `QueryEngine` → `query.ts`（turn 循环）→ `services/api/claude.ts` → provider SDK。
- **版本**：`package.json` `version` 字段（当前 `2.8.3`），MACRO defines 从 package.json 读取，不硬编码。

## 开发工作流（必背）

```bash
bun install                 # 安装依赖
bun run dev                 # 开发模式（scripts/dev.ts，默认启用全部 feature）
echo "hi" | bun run src/entrypoints/cli.tsx -p   # pipe/headless 模式
bun test                    # 全部测试
bun test path/to/x.test.ts  # 单文件
bun run precheck            # ★ 任务完成后必须跑：typecheck + biome check:fix + test，零错误
bun run build               # Bun.build 代码分割产物 → dist/
bun run build:vite          # Vite 备用构建管线
```

**铁律**：
- 任何修改后 **`bun run precheck` 必须零错误通过**（typecheck + lint + test）。
- 生产代码禁止 `as any`；测试的 mock 数据可用。
- 提交遵循 **Conventional Commits**（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`），中文描述可以。
- feature flag：`import { feature } from 'bun:bundle'`，`feature('FLAG')` **只能**直接放在 `if`/三元的条件位置（Bun 编译器限制）。
- 设计 Web UI 前先看根目录 `.impeccable.md`（Claude 品牌设计上下文）。

## 与既有文档的关系

- 概念/功能文档：`docs/features/`（各功能）、`docs/extensibility/`（hooks/mcp/skills/custom-agents）、`docs/safety/`、`docs/tools/`、`docs/context/`、`docs/conversation/`。
- 深度审计/设计记录：`docs/internals/`、`docs/*-audit.md`、`docs/agent/`。
- 顶层：`CLAUDE.md`（agent 指令，**最高优先级**）、`README.md`、`DEV-LOG.md`、`progress.md`。

> 本目录聚焦"开发定位"，若与 `CLAUDE.md` 冲突，以 `CLAUDE.md` 为准。
