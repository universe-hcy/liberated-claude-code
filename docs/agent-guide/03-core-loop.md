# 03 · 核心会话循环（The Loop）

> 一个 turn 从用户输入到 API 调用、流式响应、工具执行、再循环，是本项目的心脏。
>
> 关键文件：`src/query.ts`（2057 行，流式 turn 循环）、`src/QueryEngine.ts`（1365 行，每会话编排器）、`src/context.ts`（上下文构建）、`src/utils/queryContext.ts`（system prompt 装配）、`src/constants/prompts.ts`（system prompt 内容）。

## 心智模型（先记这个）

```
ask() / REPL
   └─ QueryEngine.submitMessage()   ← 一次调用 = 一个 turn，拥有"持久会话状态"
         └─ query() → queryLoop()   ← 单个 while(true)，靠"重新赋值 State"循环（不是递归）
               ├─ 每轮：切压缩边界 → 预算裁剪 → 组装 system/user context
               ├─ deps.callModel(...) 流式拉取模型响应
               ├─ 收集 tool_use → StreamingToolExecutor 或 runTools 执行
               └─ 无工具调用 → return {reason:'completed'}；有 → 拼结果、turnCount++、循环
```

三份上下文分别注入：`systemPrompt`、`userContext`、`systemContext`，每 turn 由 `fetchSystemPromptParts` 装配一次，每轮迭代注入。

## Turn 生命周期（带 file:line）

1. **用户输入入口** — `QueryEngine.submitMessage()` `QueryEngine.ts:217`，清空 turn 级状态 `:246`。
2. **取 system prompt + context** — `fetchSystemPromptParts()` `QueryEngine.ts:298` → `queryContext.ts:44` 并行跑 `getSystemPrompt()` / `getUserContext()` / `getSystemContext()`（`queryContext.ts:61`）。最终 systemPrompt 在 `QueryEngine.ts:331` 组装。
3. **输入处理 / slash 命令** — `processUserInput()` `QueryEngine.ts:420`，返回 `messages` / `shouldQuery` / 模型覆盖；新消息进 `mutableMessages` `:441`，transcript 持久化 `:461`。
4. **文件历史快照** — `fileHistoryMakeSnapshot()` `QueryEngine.ts:653-668`（按用户消息 uuid），支持把编辑回滚到 turn 前状态。
5. **发 system-init，进入循环** — `buildSystemInitMessage()` `:551`，然后 `for await (const message of query({...}))` `QueryEngine.ts:688`。
6. **`query()` 包装** — `query.ts:276`：建 Langfuse trace，委托 `queryLoop()` `:320`，`finally` 里收尾 autonomy 队列 + trace `:329`。
7. **每轮上下文准备**（`while(true)` 顶部 `query.ts:460`）：
   - 压缩边界切片 `getMessagesAfterCompactBoundary()` `:523`
   - 剥离过期 `toolUseResult` `:542`
   - 工具结果字节预算 `applyToolResultBudget()` `:567`
   - snip / microcompact / context-collapse / autocompact `:589-888`
   - 组装最终 system prompt `appendSystemContext()` `:647`
8. **API 流式调用** — `deps.callModel(...)`（= `queryModelWithStreaming`），`for await` 于 `query.ts:899`；消息用 `prependUserContext(...)` `:900` + `fullSystemPrompt` `:902` 构建。
9. **流式消费** — 每条 yield 消息：可恢复错误暂缓 `:1052-1078`；进 `assistantMessages`，收集 tool_use → `needsFollowUp=true` `:1079-1103`；流式工具启动 `streamingToolExecutor.addTool` `:1100`。
10. **无工具 → 终止** — `if (!needsFollowUp)` `:1349`：413/max-tokens 恢复、stop hooks（`handleStopHooks` `:1557`）、token 预算续跑 `:1598`，然后 `return {reason:'completed'}` `:1647`。
11. **工具执行** — `query.ts:1669`：`streamingToolExecutor.getRemainingResults()` 或 `runTools(...)`；结果归一化进 `toolResults` `:1673-1697`。
12. **工具后附加** — 排队命令、memory/skill/tool prefetch 注入 `:1894-1954`；新 MCP 工具刷新 `:1989`。
13. **循环回去** — 下一个 `State` 在 `query.ts:2043` 构建：`messages = messagesForQuery.concat(assistantMessages, toolResults)`，`turnCount++`，`state = next` `:2055`。**"递归"是靠重新赋值 State 实现的，不是递归调用。**
14. **QueryEngine 消费每条 yield** — 记 transcript、累计 usage、`normalizeMessage` 映射为 SDK 消息 `:700-1020`，终态 `result` 在 `:1194`。

## `query.ts` 如何流式 + 分派工具

- 入口生成器 `query()` `:276` → **`queryLoop()`** `:393`（async generator，yield `StreamEvent | Message | ...`，return 一个 `Terminal`）。
- **循环状态**是单个 `State` 对象（`:261`），每次 `continue` 处重新赋值而非递归。`transition.reason` 记录续跑原因（`next_turn` / `reactive_compact_retry` / `stop_hook_blocking` / `token_budget_continuation` / `max_output_tokens_recovery` / `collapse_drain_retry`）。
- **两条工具分派路径**：
  - **流式（默认，`config.gates.streamingToolExecution` 开）**：`StreamingToolExecutor`（类 `StreamingToolExecutor.ts:42`）。流中 `.addTool()` `query.ts:1100`，交错取 `.getCompletedResults()` `:1109`，末尾 `.getRemainingResults()` `:1670`。处理并发、abort/合成错误、fallback 丢弃。
  - **批量兜底**：`runTools()` `toolOrchestration.ts:20` — 用 `partitionToolCalls()` `:106` 分为「并发安全（只读）」vs「串行」，`runToolsConcurrently` `:169` / `runToolsSerially` `:133`。
- **缺失结果守卫** `yieldMissingToolResultBlocks()` `query.ts:149`：为每个无匹配结果的 tool_use 合成 `is_error` tool_result（错误/abort/fallback 时）。
- **fallback 模型重试** `FallbackTriggeredError` 于 `:1151` 捕获，换模型、弃执行器、重试。

## `QueryEngine` 管理的状态

一会话一实例（`:192`）。`submitMessage()` = 新 turn；`ask()` `:1256` 是一次性便捷包装。字段 `:193-206`：

- **`mutableMessages`** — 持久会话历史，随 `query()` yield 追加。
- **`totalUsage`** — 从 `message_start/delta/stop` 流事件累计 `:817-848`。
- **`readFileState`**（`FileStateCache`）— `ask()` 中克隆 `:1329`，`finally` 还给调用方 `:1363`。
- **`permissionDenials`** — 由 `wrappedCanUseTool` `:253` 记录所有非 `allow` 决策。
- **压缩**：QueryEngine **不自己压缩** — 压缩发生在 `query.ts` 内。它**响应** yield 出的 `compact_boundary` 系统消息：刷 transcript `:714-730`，把边界前消息从 `mutableMessages` 中 splice 掉以省内存 `:958-971`，再重发 SDK `compact_boundary`。
- **文件历史快照** `:653`，写入 `AppState.fileHistory` `:386`。
- **归因** `updateAttributionState` `:395`（`AppState.attribution`，用于 commit 共同作者归因）。
- **终态记账**：构建 SDK `result`（成功 / `error_max_turns` / `error_max_budget_usd` / `error_max_structured_output_retries` / `error_during_execution`）`:895-1214`；强制 `maxBudgetUsd` `:1023` 与结构化输出重试上限 `:1058`。

## 上下文与 system prompt 装配

三份内容流入 `query()`：

- **`getSystemPrompt()`** `prompts.ts:423` 返回有序 `string[]`：
  - 可缓存头部（intro/system/doing-tasks/actions/using-tools/output-efficiency）`:527-537`。
  - `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记 `:539` 分割「可缓存 vs 动态」（驱动 `splitSysPromptPrefix()` `api.ts:317` 的缓存作用域）。
  - 动态段 `:469-522`：mode persona、session guidance、**memory（`loadMemoryPrompt()`）**、env、language、output style、MCP 指令、scratchpad、token-budget、brief。
  - `CLAUDE_CODE_SIMPLE` 短路 `:429`。
- **`getUserContext()`** `context.ts:155`（memoized）：注入 **CLAUDE.md / memory 文件**（`getMemoryFiles()` + `getClaudeMds()` `:172`，来自 `utils/claudemd.ts`），key = `claudeMd`，加 `currentDate` `:186`。受 `CLAUDE_CODE_DISABLE_CLAUDE_MDS` 与 `--bare` 影响 `:165`。
- **`getSystemContext()`** `context.ts:116`（memoized）：注入 **git 状态**（`getGitStatus()` `:36` — 分支、main、git user、`git status --short`、最近 5 commit，1000 字符截断 `:85`）。
- **注入到请求**（循环内）：
  - `systemContext` → `appendSystemContext()` `api.ts:431`（`key: value` 拼接），调用于 `query.ts:647`。
  - `userContext` → `prependUserContext()` `api.ts:443`，调用于 `query.ts:900`。其中 `claudeMd` 单独拆成高权重 `<project-instructions>` 用户消息（`api.ts:461`），其余进 `<system-reminder>` 块（`api.ts:474`）——**就是本对话顶部看到的那个块**。
  - `NODE_ENV==='test'` 时 `prependUserContext` 是 no-op（`api.ts:447`）。

## 扩展点：想改 turn 行为 / 加上下文 / 拦截工具

| 目标 | 在哪下手 |
|------|----------|
| 改模型调用 / 压缩逻辑（测试友好的注入点） | `QueryDeps`（`query/deps.ts:21`），覆盖 `callModel`/`microcompact`/`autocompact`/`uuid`；默认 `productionDeps()` `deps.ts:33` |
| 拦截/门控每个工具调用 | `canUseTool`（`CanUseToolFn`，`hooks/useCanUseTool.js`），QueryEngine 已包装 `:253`；改执行本身则 hook `runTools` `toolOrchestration.ts:20` 或 `StreamingToolExecutor.executeTool` `:292` |
| 加静态/system 段 | `getSystemPrompt()` 动态列表 `prompts.ts:469` |
| 加每会话 user/system 上下文 | `getUserContext()` / `getSystemContext()`（`context.ts`） |
| turn 中途动态注入 | attachment 流 `getAttachmentMessages()`，消费于 `query.ts:1894`（memory/skill/tool prefetch 走这条） |
| turn 边界 hook | post-sampling `executePostSamplingHooks()` `:1288`；stop hooks `handleStopHooks()` `:1557`（`query/stopHooks.ts`） |
| 观察/转换每条流消息 | `QueryEngine.submitMessage` 的 `for await` `:688`，switch 在 `:772` |
| 压缩 / token 预算 | `autoCompactIfNeeded()` `autoCompact.ts:270`，阈值 `getAutoCompactThreshold` `:101`；token 预算在 `feature('TOKEN_BUDGET')` 后的 `query/tokenBudget.ts` |

## 关键类型

- **消息层级** — `src/types/message.ts:3-45` 从 `@ant/model-provider` 再导出：`Message` / `AssistantMessage` / `UserMessage` / `AttachmentMessage` / `ProgressMessage` / `SystemMessage`（含 `SystemCompactBoundaryMessage` 等子类型）/ `TombstoneMessage` / `ToolUseSummaryMessage` / `StreamEvent` / `NormalizedMessage`。**具体定义在 `@ant/model-provider` 包里，不在本 repo**。UI-only 类型（`RenderableMessage`）在 `message.ts:61-109` 本地定义。
- `QueryParams` `query.ts:238`；`State`（循环状态）`query.ts:261`。
- `Terminal` / `Continue` — `src/query/transitions.ts`。
- `QueryDeps` — `query/deps.ts:21`；`QueryEngineConfig` — `QueryEngine.ts:138`。
- `ToolUseContext` / `Tools` / `Tool` — `src/Tool.ts`。
- SDK 输出类型（`SDKMessage` 等）— `src/entrypoints/agentSdkTypes.js`。

## 陷阱

- 循环是**状态机**不是递归——找"下一轮从哪来"要看 `State` 重新赋值处（`query.ts:2043-2055`），别找递归调用。
- 压缩不在 QueryEngine 里做，它只是**响应** `compact_boundary` 消息去裁剪 `mutableMessages`。
- `prependUserContext` 在测试环境是 no-op，别指望测试里看到 `<system-reminder>` 注入。
