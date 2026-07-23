# 01 · 全局架构

> 先读这篇建立心智模型，再按需跳专题文档。

## 一句话

`claude-code-best` 是 Anthropic 官方 Claude Code CLI 的**逆向/反编译版**：一个跑在 **Bun** 上、用 **React/Ink 渲染到终端**的交互式编码 agent。它把用户输入送进一个**流式 turn 循环**，循环里调模型 API、执行工具、再循环，直到模型不再要求工具。大量次要能力用 **feature flag** 开关或桩化。

## 分层（从上到下）

```
┌─────────────────────────────────────────────────────────────┐
│ 入口层   cli.tsx（快速路径）→ main.tsx（Commander 命令）        │  → 02
│          init.ts（一次性初始化）                                │
├─────────────────────────────────────────────────────────────┤
│ UI 层    replLauncher → App（providers）→ REPL（Ink 主屏）      │  → 06
│          PromptInput / Messages / permissions / design-system  │
│          框架：packages/@ant/ink（import 名 @anthropic/ink）    │
├─────────────────────────────────────────────────────────────┤
│ 编排层   QueryEngine（每会话，持久状态）                        │  → 03
│          → query.ts / queryLoop（while(true) turn 状态机）      │
│          services/tools（StreamingToolExecutor / 编排）         │
│          services/compact（auto/micro/snip 压缩）              │
├─────────────────────────────────────────────────────────────┤
│ 工具层   Tool.ts（接口）+ tools.ts（注册）                     │  → 05
│          packages/builtin-tools（~60 工具）                    │
│          searchExtraTools（TF-IDF 延迟工具）+ MCP 工具         │
├─────────────────────────────────────────────────────────────┤
│ API 层   services/api/claude.ts（分派）→ 7 provider           │  → 04
│          firstParty/bedrock/vertex/foundry（Anthropic-wire）   │
│          openai/gemini/grok（兼容层，流适配器）                │
│          packages/@ant/model-provider（转换器/适配器库）       │
├─────────────────────────────────────────────────────────────┤
│ 状态/构建 state/AppState（响应式）+ bootstrap/state（单例）    │  → 07
│          build.ts / vite.config.ts / defines.ts / feature()   │
└─────────────────────────────────────────────────────────────┘
```

## 端到端数据流（一个 turn）

```
用户在 PromptInput 敲字并提交
  → handlePromptSubmit → processUserInput（slash 命令 / 展开）
  → REPL.onQuery → QueryEngine.submitMessage()      [编排层，拥有会话状态]
      → fetchSystemPromptParts（组装 systemPrompt / userContext / systemContext）
      → query() / queryLoop()  while(true):          [turn 状态机]
          → 切压缩边界 / 预算裁剪 / 注入上下文
          → deps.callModel → services/api/claude.ts  [API 层]
              → getAPIProvider() 分派 → provider SDK / 兼容层适配器
              → 流式 BetaRawMessageStreamEvent
          → 收集 tool_use → StreamingToolExecutor.executeTool
              → tool.checkPermissions → canUseTool（可能弹权限 UI）
              → tool.call(...) → ToolResult
          → 无工具调用 → return completed；有 → 拼结果、turnCount++、循环
      → 逐条 yield 消息映射为 SDK 消息，UI 渲染 MessageRow
```

关键洞察：**循环是状态机**（重新赋值 `State`），不是递归；**provider 对循环透明**（都收敛到同一 `AsyncGenerator` 契约）；**三份上下文**（systemPrompt/userContext/systemContext）每 turn 装配一次。

## 顶层目录地图

| 路径 | 是什么 |
|------|--------|
| `src/entrypoints/` | 真入口 `cli.tsx`、`init.ts`、ACP/agent SDK 类型 |
| `src/main.tsx` | Commander CLI 定义（~5640 行，所有子命令） |
| `src/query.ts` / `src/QueryEngine.ts` | 核心 turn 循环 + 每会话编排 |
| `src/context.ts` / `src/constants/prompts.ts` | 上下文 + system prompt 组装 |
| `src/services/` | API、MCP、ACP、tools、compact、analytics、auth、lsp… |
| `src/tools.ts` / `src/Tool.ts` / `src/constants/tools.ts` | 工具注册 + 接口 + CORE_TOOLS |
| `src/components/` | 152 个 Ink 组件（App、Messages、PromptInput、permissions…） |
| `src/screens/REPL.tsx` | 交互主屏 |
| `src/commands/` | ~90 个 slash 命令组 |
| `src/state/` / `src/bootstrap/` | AppState store + 会话全局单例 |
| `src/bridge/` `src/daemon/` `src/coordinator/` `src/proactive/` | feature-gated 高级模式 |
| `src/utils/` | 横切工具（log、debug、config、settings、auth、model/providers…） |
| `packages/` | 19 个 workspace 包（ink、builtin-tools、model-provider、mcp-client…） |
| `scripts/` | `dev.ts`、`defines.ts`、`post-build.ts`、health-check… |
| `build.ts` / `vite.config.ts` | 两套构建管线 |
| `docs/` | Mintlify 用户文档 + 审计/设计记录 + 本 agent-guide |
| `tests/` | 集成测试 + 共享 mock/fixture |

## 运行时与关键约束

- **Bun 运行时**（非 Node）。所有 import/build/执行用 Bun API。构建产物经后处理兼容 Node（`node dist/cli.js` 可跑）。
- **ESM** + **TSX**（`react-jsx`）。**TypeScript strict**，`bun run precheck` 必须零错误。
- **Monorepo**：Bun workspaces。`workspace:*` 解析包间依赖。
- **Lint/Format**：Biome（42 条规则因反编译代码关闭，仅 recommended 基线）。pre-commit 用 husky + lint-staged。
- **React Compiler**：build 时跑，源码是干净 `.tsx`；打包产物里的 `_c()` memo 是自动生成的，别手写/编辑（见 [06](./06-ui-ink.md)）。
- **Feature flag**：`import { feature } from 'bun:bundle'`，只能在 `if`/三元条件里用（见 [07](./07-state-build-flags.md)）。

## 各专题文档的"何时看"

- 改会话/turn 行为、压缩、上下文注入、工具执行时机 → [03](./03-core-loop.md)
- 加/改模型 provider、兼容层、模型映射、鉴权 env → [04](./04-api-and-providers.md)
- 加/改工具、权限、结果渲染、延迟工具 → [05](./05-tool-system.md)
- 加/改 UI 组件、屏、权限对话、主题、键位 → [06](./06-ui-ink.md)
- 加 feature flag、全局状态、理解构建/内存 → [07](./07-state-build-flags.md)
- 加 CLI 子命令 / slash 命令 → [02](./02-entry-and-commands.md)
- 理解/改 fork agent、subagent spawn、coordinator/teammate、后台旁路特性 → [11](./11-agents-fork-subagent.md)
- 长流程任务的 agent 编排设计方案（主干 + 阶段 worker + fork/subagent 自适应选择） → [12](./12-pattern-trunk-orchestrator.md)
- 找"某功能在哪个目录/包" → [08](./08-commands-services-packages.md)
- 写测试 / 排查 mock 污染 → [09](./09-testing.md)
- "我要开发一个 X" 配方 → [10](./10-how-to.md)
