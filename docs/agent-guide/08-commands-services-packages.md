# 08 · 目录地图：commands / services / packages

> 定位"某功能在哪个目录"用这篇。两大依赖：`@anthropic/ink`（UI，642 处 import）、`@claude-code-best/builtin-tools`（工具，552 处 import）。

## `src/commands/` — 命令组（slash 命令）

命令用轻量描述符注册：每组 `index.ts` 导出 `Command` 对象（`{type, name, description, load: () => import(...)}`，懒 `load()`）。中央注册/类型在 `src/commands.ts`。约 90 个条目（多为单文件 `.ts`/`.tsx`，如 `advisor.ts`、`commit.ts`、`review.ts`、`statusline.tsx`、`ultraplan.tsx`）。显著子目录组：

| 子目录 | 职责 | 入口 |
|--------|------|------|
| `poor/` | 穷鬼模式——关 extract_memories/prompt_suggestion 省 token | `poorMode.ts` |
| `schedule/` | Cron/定时 agent（routines）、triggers API | `launchSchedule.tsx`、`triggersApi.ts` |
| `agents/` | 子 agent 管理 UI | `agents.tsx` |
| `agents-platform/` | 云 agents platform 视图 + API | `agentsApi.ts`、`AgentsPlatformView.tsx` |
| `plugin/` | 插件 + marketplace 浏览/安装/管理（大 Ink 面） | `plugin.tsx`、`ManagePlugins.tsx` |
| `mcp/` | MCP server add/list/manage CLI+UI、IDP 鉴权 | `mcp.tsx`、`addCommand.ts`、`xaaIdpCommand.ts` |
| `vault/` / `local-vault/` | 密钥 vault 视图 + API | `vaultsApi.ts`、`VaultView.tsx` |
| `skills/`、`skill-search/`、`skill-store/`、`skill-learning/` | Skill 发现/搜索/商店/学习 UI | `skills.tsx` |
| `buddy/`、`tasks/`、`workflows/`、`voice/`、`pipes/` | Buddy、任务列表、工作流启动、语音、管道 | `buddy.ts`、`tasks.tsx`、`voice.ts` |
| `bridge/`、`daemon/` | remote-control bridge / 后台 daemon 的 CLI 面 | — |
| `config/`、`permissions/`、`hooks/`、`keybindings/`、`memory/`、`memory-stores/`、`local-memory/` | 设置/权限/hook/键位/记忆管理 | 各有 `index.ts` |
| `_shared/` | 命令实现共享辅助 | — |
| `createMovedToPluginCommand.ts` | 生成"已迁移到插件"命令的桩 | 文件 |

其它单文件命令：auth（`login/`、`logout/`、`oauth-refresh/`、`subscribe-pr.ts`）、dev（`doctor/`、`debug-tool-call/`、`heapdump/`、`perf-issue/`）、git/PR（`commit.ts`、`commit-push-pr.ts`、`review.ts`、`pr_comments/`、`autofix-pr/`）。

## `src/services/` — 服务子目录

| 子目录 | 职责 |
|--------|------|
| `api/` | 核心模型 API 层——HTTP client、Anthropic/Bedrock/Gemini/Grok clients、请求/错误/usage（详见 [04](./04-api-and-providers.md)） |
| `acp/` | Agent Client Protocol server 模式（Zed 集成）——`entry.ts`(`runAcpAgent`)、`agent.ts`、`bridge.ts`、`permissions.ts` |
| `mcp/` | MCP 集成 host 侧——`client.ts`(传输)、`MCPConnectionManager.tsx`、`config.ts`、`auth.ts`、elicitation、`claudeai.ts`(代理)、`xaa.ts`(IDP) |
| `searchExtraTools/` | 延迟工具发现——TF-IDF `toolIndex.ts` + `prefetch.ts`（详见 [05](./05-tool-system.md)） |
| `tools/` | 工具执行运行时——`StreamingToolExecutor.ts`、`toolOrchestration.ts`、`toolHooks.ts`（详见 [03](./03-core-loop.md)） |
| `compact/` | 上下文压缩——`autoCompact.ts`、`microCompact.ts`、`snipCompact.ts` |
| `analytics/` | 遥测 + feature flag——`growthbook.ts`、`datadog.ts`、1P 事件 |
| `oauth/` / `auth/` | OAuth 流 + workspace-key/host-guard 鉴权 |
| `lsp/` | LSP 客户端/管理器（诊断） |
| `goal/` | Goal 状态/存储/prompt（Goal 工具后端） |
| `SessionMemory/`、`extractMemories/`、`teamMemorySync/`、`localVault/` | 记忆提取、会话记忆、团队同步、本地密钥库 |
| `providerRegistry/`、`providerUsage/`、`policyLimits/` | 模型 provider 注册、usage 追踪、速率/策略限制 |
| `skillLearning/`、`skillSearch/` | Skill 学习 + 本地搜索（TF-IDF `localSearch.ts`，被 searchExtraTools 复用） |
| `settingsSync/`、`remoteManagedSettings/` | 设置同步、远程托管设置 |
| `plugins/` | 插件安装/操作——`PluginInstallationManager.ts`、`pluginCliCommands.ts` |
| `langfuse/`、`PromptSuggestion/`、`AgentSummary/`、`toolUseSummary/`、`tips/`、`MagicDocs/`、`autoDream/`、`contextCollapse/`、`sessionTranscript/` | 可观测、提示建议、摘要、tips、文档、环境功能 |

## `packages/` — workspace 包（19 个）

workspaces glob：`packages/*`、`packages/@ant/*`、`packages/@anthropic-ai/*`（最后一个磁盘上为空）。

| 目录 | import 名 | 职责 | 用量 |
|------|-----------|------|------|
| `@ant/ink/` | **`@anthropic/ink`** | fork 的 Ink TUI 库 | 642（最重） |
| `builtin-tools/` | `@claude-code-best/builtin-tools` | 全部内置工具定义 | 552 |
| `@ant/model-provider/` | `@ant/model-provider` | 模型 provider 抽象（转换器/流适配器，详见 [04](./04-api-and-providers.md)） | 26 |
| `agent-tools/` | `@claude-code-best/agent-tools` | 纯工具接口类型 + registry（`findToolByName`），零依赖 | — |
| `mcp-client/` | `@claude-code-best/mcp-client` | 严格 MCP 协议客户端：`connection.ts`、`transport/`、`discovery.ts`、`manager.ts`(`createMcpManager`) | 2 |
| `workflow-engine/` | `@claude-code-best/workflow-engine` | 确定性 JS 多 agent 编排引擎（port-adapter，零运行时依赖） | 13 |
| `weixin/` | `@claude-code-best/weixin` | 微信集成 | — |
| `@ant/computer-use-mcp/` | `@ant/computer-use-mcp` | Computer-use MCP server | 11 |
| `@ant/claude-for-chrome-mcp/` | `@ant/claude-for-chrome-mcp` | Chrome 控制 MCP server | 3 |
| `@ant/computer-use-input/` | `@ant/computer-use-input` | 底层输入注入（键鼠） | 1 |
| `@ant/computer-use-swift/` | `@ant/computer-use-swift` | Swift/macOS computer-use 后端 | 1 |
| `acp-link/` | `acp-link` | ACP 代理服务器（WS → ACP agent） | 独立 |
| `remote-control-server/` | `@anthropic/remote-control-server` | remote-control bridge 后端服务 + Web UI | bridge |
| `cloud-artifacts/` | `cloud-artifacts` | Cloudflare Worker + R2，HTML artifact 托管 | 独立部署 |
| `audio-capture-napi/` | `audio-capture-napi` | 原生音频捕获（语音输入） | native |
| `image-processor-napi/` | `image-processor-napi` | 原生图像处理 | native |
| `color-diff-napi/` | `color-diff-napi` | 原生颜色差异 | native |
| `modifiers-napi/` | `modifiers-napi` | 原生键盘修饰键检测 | native |
| `url-handler-napi/` | `url-handler-napi` | 原生 OS URL-scheme 处理 | native |

> `@anthropic-ai/sdk`、`@anthropic-ai/bedrock-sdk`、`@anthropic-ai/mcpb`、`@anthropic-ai/sandbox-runtime`、`@anthropic-ai/claude-agent-sdk` 是**外部 npm 依赖**，不是 workspace 包。

## bridge / daemon / acp（feature-flag gated）

- **`src/bridge/`** — remote-control"桥"，让手机/桌面驱动 REPL。入口 `bridgeMain.ts`；REPL 接线 `replBridge.ts`；消息 I/O `inboundMessages.ts`/`bridgeMessaging.ts`；会话生命周期 `createSession.ts`/`sessionRunner.ts`。gate：`isBridgeEnabled()`（`bridge/bridgeEnabled.ts`，组合 build-time `feature('BRIDGE_MODE')` + GrowthBook + claude.ai 订阅 + self-hosted 覆盖）。鉴权 `jwtUtils.ts`/`trustedDevice.ts`/`workSecret.ts`。后端 `@anthropic/remote-control-server`。
- **`src/daemon/`** — 后台 supervisor。`main.ts` spawn/监督 CLI worker（崩溃退避，`EXIT_CODE_PERMANENT=78`），`workerRegistry.ts` 追踪，`state.ts` 持久化 PID/状态。
- **`src/services/acp/`** — 编辑器 ACP 模式（Zed）。`runAcpAgent()`（`acp/entry.ts`）在 stdin/stdout 的 ndjson 流上建 `AgentSideConnection`。gate：`cli.tsx:124`（`feature('ACP') && argv[2]==='--acp'`）。权限经 `acp/permissions.ts` 回调 ACP 客户端。

## MCP 集成（高层）

两层：
- **协议层** `packages/mcp-client`（`@claude-code-best/mcp-client`）：纯 connection/transport/discovery/execution，各传输类型（stdio、SSE、HTTP、WebSocket、in-SDK、claude.ai 代理）Zod schema；`manager.ts` `createMcpManager(deps)` 可注入编排器。
- **Host 集成** `src/services/mcp/`：`client.ts` 把官方 `@modelcontextprotocol/sdk` `Client` 接到具体传输（`StdioClientTransport`、`SSEClientTransport`、`StreamableHTTPClientTransport` + 自定义 `InProcessTransport.ts`、`SdkControlTransport.ts`、`vscodeSdkMcp.ts`）。`MCPConnectionManager.tsx`（Ink）管连接生命周期（hooks `useMcpReconnect`、`useMcpToggleEnabled`）。配置/env 展开 `config.ts`/`envExpansion.ts`；鉴权 `auth.ts`/`xaa.ts`；权限 `channelPermissions.ts`/`channelAllowlist.ts`；`elicitationHandler.ts`；`claudeai.ts`(代理)；`officialRegistry.ts`。
- **工具暴露**：发现的 MCP 工具进工具 registry；`ListMcpResourcesTool`/`ReadMcpResourceTool`/`McpAuthTool`/`MCPTool`（`packages/builtin-tools`）暴露给模型。MCP 工具默认延迟，经 `searchExtraTools/toolIndex.ts` 索引。

## 横切 `src/utils/`

- `log.ts` — 会话/API 请求日志（`feature`、序列化消息、写 `CACHE_PATHS`、剥显示标签、设 `setLastAPIRequest*` bootstrap 状态）。
- `debug.ts` — `logForDebugging`（广用）；配 `debugFilter.ts`、`diagLogs.ts`、`errorLogSink.ts`。
- `config.ts` — `enableConfigs()`（ACP 入口等调）；`configConstants.ts`、`markdownConfigLoader.ts`、`caCertsConfig.ts`。
- `settings/` — 设置目录（settings.json 分层读/合并）；`gitSettings.ts`、`shellConfig.ts`。
- `auth.ts` — 中央鉴权（订阅/API-key 检测）；`bridgeEnabled.ts` 用 namespace import 它来破 `bridgeEnabled→auth→config→bridgeEnabled` require 环。
- feature flag 两条路：build-time `feature('X')`（`bun:bundle`，DCE）+ runtime GrowthBook（`growthbook.ts` 的 `checkGate_CACHED_OR_BLOCKING`、`getDynamicConfig_CACHED_MAY_BE_STALE`）。
