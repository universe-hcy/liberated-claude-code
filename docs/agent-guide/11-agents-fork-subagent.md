# 11 · Fork Agent 与 Subagent 系统

> 关键文件：`src/utils/forkedAgent.ts`（`runForkedAgent` 进程内旁路 + `createSubagentContext` 共享原语）、`packages/builtin-tools/src/tools/AgentTool/`（`AgentTool.tsx` 路由/spawn、`runAgent.ts` 子 agent 循环、`forkSubagent.ts` 隐式 fork、`agentToolUtils.ts` 异步驱动、`builtInAgents.ts`/`loadAgentsDir.ts` agent 定义）、`src/constants/tools.ts`（agent 工具限制集合）、`src/utils/agentToolFilter.ts`（fork 工具预过滤）、`src/coordinator/`（coordinator 模式）、`src/utils/agentSwarmsEnabled.ts`（teammate/swarm）、`src/commands/fork/fork.tsx`（`/fork` 命令）。

## ⚠️ 先分清：代码库里有**两套**叫 "fork" 的东西

| 机制 | 入口 | 本质 | 是否走 AgentTool |
|------|------|------|------------------|
| **`runForkedAgent`** | `src/utils/forkedAgent.ts:508` | **进程内、复用父 cache 的旁路 `query()` 循环**。复用父的 `systemPrompt`/`tools`/`model`/`messages` 前缀保证 prompt-cache 命中，返回 `{messages, totalUsage}` | ❌ 直接调 `query()` |
| **AgentTool 隐式 fork** | `FORK_SUBAGENT` flag + `forkSubagent.ts` | **真正 spawn 的 subagent**，继承父整段对话作为 prompt 前缀，走 `runAgent` 异步跑，`<task-notification>` 回报 | ✅ AgentTool → runAgent |

**共享底层原语**：`createSubagentContext`（`forkedAgent.ts:342`）——克隆 `ToolUseContext` 并隔离一切可变状态：clone `readFileState`、child abort controller、mutation callback 全部 no-op、`queryTracking.depth +1`、fresh trigger sets。`runForkedAgent` 内部调它（`:534`），`runAgent` 也直接调它（`runAgent.ts:709`）。

**贯穿全篇的设计核心**：**所有 fork 都为命中 prompt cache**。父子必须产出字节级一致的 API 请求前缀，这解释了本系统里几乎所有"看起来奇怪"的做法（占位符 tool_result、`useExactTools`、`renderedSystemPrompt` 字节透传、`contentReplacementState` 默认 clone 而非 fresh）。

---

## 一、`runForkedAgent`：进程内旁路 fork（后台/临时特性）

`runForkedAgent(ForkedAgentParams)` 跑一个隔离的 `query()` 循环，累计 usage，完成后打 `tengu_fork_agent_query` 事件。全部调用者都是**后台/临时**特性，不占用主 loop 的 turn：

| 功能 | 位置 | forkLabel / querySource | 用途 |
|------|------|-------------------------|------|
| 自动压缩 | `services/compact/compact.ts:1222` | `compact` | 复用父 cache 生成压缩摘要（`maxTurns:1`、`skipCacheWrite`） |
| 会话记忆（自动） | `services/SessionMemory/sessionMemory.ts:325` | `session_memory` | 后台从 transcript 抽持久记忆 |
| 会话记忆（手动） | `services/SessionMemory/sessionMemory.ts:427` | `session_memory` | 同上，手动触发；`:310`/`:405` 另有 setup 阶段的 `createSubagentContext` |
| Agent 摘要 | `services/AgentSummary/agentSummary.ts:138` | `agent_summary` | 每 ~30s fork 一个运行中 subagent 的对话生成进度摘要（DI 注入，`:38`/`:65`） |
| 推测执行 | `services/PromptSuggestion/speculation.ts:460` | `speculation` | 预算下一个 prompt 的响应；`skipTranscript` 临时 |
| Prompt 建议 | `services/PromptSuggestion/promptSuggestion.ts:321` | `prompt_suggestion` | 生成建议的下一步 prompt |
| 抽取记忆 | `services/extractMemories/extractMemories.ts:412` | `extract_memories` | "父 agent 的完美 fork" |
| Auto dream | `services/autoDream/autoDream.ts:225` | `auto_dream` | 空闲时后台"做梦"过一遍对话 |
| Side question | `utils/sideQuestion.ts:80` | `side_question` | 通用"带父 cache 问一句"辅助 |
| Away recap | `commands/recap/generateRecap.ts:66` | `away_summary` | 生成"你离开时发生了什么"回顾 |

**穷鬼模式（`/poor`）关掉的正是其中三个**：`extract_memories`、`prompt_suggestion`、`verification_agent`——因为它们各自额外发一轮请求，token 开销明显。

**易混淆点（别踩）**：
- **Verification agent 不是 `runForkedAgent`**——它是走 AgentTool 正常路径的内置 agent（`built-in/verificationAgent.ts`，`builtInAgents.ts:66` 注册，`feature('VERIFICATION_AGENT')` gate）。
- **不存在名为 `supervisor` 的 `runForkedAgent` 调用**——"supervisor" 只是 `ForkedAgentParams.forkLabel` 文档里的示例（`forkedAgent.ts:87`）。
- **Skill / slash-command 执行**用了 `forkedAgent.ts` 的 helper（`prepareForkedCommandContext:186`、`createGetAppStateWithAllowedTools:142`、`extractResultText:232`），但实际 spawn 走 **`runAgent`**，不是 `runForkedAgent`。

### `runForkedAgent` 数据流

```
调用方(compact/memory/...)
  └─ 构造 cacheSafeParams = { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages }
  └─ runForkedAgent(params)
       ├─ createSubagentContext(toolUseContext, overrides)   # 隔离可变状态
       ├─ initialMessages = [...forkContextMessages, ...promptMessages]   # 不做 filterIncompleteToolCalls，交给下游 ensureToolResultPairing 修复
       ├─ query({ messages, systemPrompt, ..., maxOutputTokensOverride, maxTurns, skipCacheWrite })
       │    └─ 逐 message：从 message_delta 事件累计 totalUsage；可选喂 setResponseLength（进度条）
       ├─ recordSidechainTranscript(...)   # 除非 skipTranscript
       └─ finally: readFileState.clear() + 释放 initialMessages
     → { messages, totalUsage }；打点 tengu_fork_agent_query（含 cacheHitRate）
```

---

## 二、AgentTool spawn 路径：普通 subagent vs 隐式 fork

`packages/builtin-tools/src/tools/AgentTool/` 的分工：
- **`AgentTool.tsx`** — 工具本体。`call()`（`:322`）解析 agent、构造 messages、决定 sync/async、调 `runAgent`。
- **`runAgent.ts`** — `async function* runAgent()`（`:257`），单个 subagent 的 query 循环。解析工具（`:509`）、建 system prompt、`createSubagentContext`（`:709`）、yield messages。
- **`agentToolUtils.ts`** — `filterToolsForAgent`（`:70`）、`resolveAgentTools`（`:122`）、`runAsyncAgentLifecycle`（`:520`，异步驱动器）、`finalizeAgentTool`、`classifyHandoffIfNeeded`、`emitTaskProgress`。
- **`resumeAgent.ts`** — `resumeAgentBackground()`，重新水合已存 transcript 继续跑（teammate re-entry 用）。
- **`forkSubagent.ts`** — 隐式 fork 特性：`isForkSubagentEnabled()`（`:32`）、`FORK_AGENT` 合成定义（`:60`）、`buildForkedMessages()`（`:107`）、`isInForkChild()` 守卫（`:78`）、`buildChildMessage`/`buildWorktreeNotice`。

### 路由决策（`AgentTool.tsx:414`）

```ts
effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : 'general-purpose')
isForkPath = effectiveType === undefined
```

- 给了 `subagent_type` → 显式赢，走**普通 spawn**。
- 省略 `subagent_type` 且 `FORK_SUBAGENT` 开 → **隐式 fork**。
- 省略且 gate 关 → 默认 `general-purpose`（普通 spawn）。

### 普通 subagent（`AgentTool.tsx:432-457, 651-681`）
- 从 `activeAgents` 按 `effectiveType` 查定义，套 `filterDeniedAgents`/`allowedAgentTypes`；查不到 → 报错列出可用 agent。
- 用 agent **自己的** system prompt（`:658` `selectedAgent.getSystemPrompt`，env 增强 `:672`）。
- prompt 是普通 user message（`:680`）。
- worker 工具用自己的 `permissionMode` 独立 `assembleToolPool`（`:722-726`），再经 `runAgent` 的 `resolveAgentTools` 过滤。

### 隐式 fork（`AgentTool.tsx:418-431, 611-786`）
- `selectedAgent = FORK_AGENT`（`tools:['*']`、`model:'inherit'`、`permissionMode:'bubble'`）。
- **递归 fork 守卫**（`:425`）：已在 fork child 内就拒绝——主判据是 querySource `agent:builtin:fork`（抗压缩），fallback 是 `isInForkChild(messages)` 扫 fork 边界 tag。
- child 继承**父的已渲染 system prompt**（`toolUseContext.renderedSystemPrompt`，`:625`；缺失则 `:627-649` fallback 重算，可能因 GrowthBook 冷热态漂移而破 cache）——字节级一致是硬要求。
- prompt 由 `buildForkedMessages(prompt, assistantMessage)`（`:650`）构造成：
  `[父完整 assistant 消息(所有 tool_use/thinking/text), user(每个 tool_use 配相同占位 tool_result… + 本 child 的 directive)]`
  所有 child 用**同一占位符**（`FORK_PLACEHOLDER_RESULT`）→ 只有末尾 directive 文本不同 → 最大化 cache 命中（`forkSubagent.ts:91-175`）。
- 传 `forkContextMessages: toolUseContext.messages`（`:785`）+ `useExactTools:true`（`:786`）+ `availableTools: filterParentToolsForFork(父工具)`（`:782`）——用父的**精确工具数组**（去掉禁用项）保证 tool-def 序列化一致。
- `runAgent` 中 `useExactTools` **跳过 `resolveAgentTools`**（`:509-511`），并继承父的 `thinkingConfig` + `isNonInteractiveSession`。
- child 被注入强指令 `buildChildMessage`（`forkSubagent.ts:177`）："你是 fork worker、别再 spawn 子 agent、别闲聊、直接用工具干、改文件要 commit、报告以 `Scope:` 开头、≤500 词"。

### 异步 spawn 与结果交付（`<task-notification>`）
- `shouldRunAsync`（`AgentTool.tsx:709`）为真的条件（任一，且未禁用后台任务）：`run_in_background` / agent 定义 `background:true` / coordinator 模式 / `forceAsync = isForkSubagentEnabled()`（fork 强制**所有** spawn 异步）/ KAIROS assistant 模式 / proactive 模式。
- **异步分支**（`:830-912`）：`registerAsyncAgent`（`:831`）建**独立 abort controller**（用户按 ESC 取消主线程时后台 agent 存活，只能靠 `chat:killAgents` 显式杀）→ `void runWithAgentContext(… runAsyncAgentLifecycle({ makeStream: runAgent(...) }))`（`:873`）→ 立即返回 `{ status:'async_launched', agentId, outputFile }`。
- **同步分支**（`:913+`）：`registerAgentForeground`（`:968`）带 auto-background 计时器（`getAutoBackgroundMs`），可中途转后台。
- **`runAsyncAgentLifecycle`**（`agentToolUtils.ts:520`）驱动流：进度打进 app state + `emitTaskProgress`，完成时 `finalizeAgentTool` → `completeAsyncAgent` → 可选 handoff 分类 → **`enqueueAgentNotification`**。
- **`enqueueAgentNotification`**（`tasks/LocalAgentTask/LocalAgentTask.tsx:242`）：`notified` flag 去重，构造 `<task-notification>` XML（`<task-id>`/`<output-file>`/`<status>`/`<summary>`/`<result>`/`<usage>`/可选 `<worktree>`），`enqueuePendingNotification({ mode:'task-notification' })`（`:317`）。
- **消费**（`src/query.ts:1869`）：每个 subagent **只 drain 发给自己 `agentId`** 的 task-notification（`:1871`）；prompt / task-notification 命令在下一个 user turn 前转成 attachment 注入（`:1957-1961`）。

---

## 三、Agent 定义与加载

- **内置 agent 文件**：`packages/builtin-tools/src/tools/AgentTool/built-in/` → `generalPurposeAgent.ts`、`exploreAgent.ts`、`planAgent.ts`、`claudeCodeGuideAgent.ts`、`statuslineSetup.ts`、`verificationAgent.ts`。
- **`builtInAgents.ts:getBuiltInAgents()`（`:20`）** 按条件组装：
  - 恒有 `GENERAL_PURPOSE_AGENT` + `STATUSLINE_SETUP_AGENT`（`:44`）。
  - `areExplorePlanAgentsEnabled()`（`:13`，`feature('BUILTIN_EXPLORE_PLAN_AGENTS')`）→ 加 `EXPLORE_AGENT` + `PLAN_AGENT`（`:49`）。
  - 非 SDK 入口 → 加 claude-code-guide。
  - `feature('VERIFICATION_AGENT')` + GrowthBook（`:63`）→ 加 `VERIFICATION_AGENT`（`:66`）。
  - **coordinator 模式**（`:33-39`）→ **只**返回 `getCoordinatorAgents()`。
  - `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`（`:24`）可整体清空。
- **`loadAgentsDir.ts`**：union 类型 `AgentDefinition = BuiltIn | Custom | Plugin`，守卫 `isBuiltInAgent`（`:168`）等。`getAgentDefinitionsWithOverrides`（memoize，`:296`）：`loadMarkdownFilesForSubdir('agents', cwd)`（`:308`）读 `.claude/agents/*.md` → `parseAgentFromMarkdown`（`:542`）→ 合并 built-in + plugin + custom → `getActiveAgentsFromList`（`:193`/`:365`）去重成 `activeAgents`。`CLAUDE_CODE_SIMPLE` 跳过 custom agent。
- **自定义类型解析**：spawn 时 `AgentTool.tsx:434-457` 在 `toolUseContext.options.agentDefinitions.activeAgents` 里查 `subagent_type`，尊重 `allowedAgentTypes` 与 deny 规则。

---

## 四、Agent 工具限制（`src/constants/tools.ts` + 两层过滤）

**集合定义**（`src/constants/tools.ts`）：
- `ALL_AGENT_DISALLOWED_TOOLS`（`:44`）——任何 subagent 都拿不到：TaskOutput、plan-mode 工具、AskUserQuestion、TaskStop、AgentTool（除非 `USER_TYPE=ant`）、Workflow、LocalMemoryRecall、VaultHttpFetch。
- `CUSTOM_AGENT_DISALLOWED_TOOLS`（`:64`）——非内置 agent 的超集（当前 == ALL）。
- `ASYNC_AGENT_ALLOWED_TOOLS`（`:71`）——异步 agent 的**白名单**（Read/Grep/Glob/Web*/shell/edit/write/Skill/Execute/worktree…）。
- `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS`（`:94`）——in-process teammate 额外拿到 Task*/SendMessage/Cron*。
- `COORDINATOR_MODE_ALLOWED_TOOLS`（`:124`）——coordinator 只有 Agent/TaskStop/SendMessage/SyntheticOutput。
- `CORE_TOOLS`（`:137`）——初始 prompt 就带全 schema 的常驻工具（见 `05-tool-system.md`）。

**两层过滤**：
1. **普通 spawn**：`agentToolUtils.ts:filterToolsForAgent`（`:70`）分层——主线程 bypass、内置 `whenToUse` bypass、扣 `ALL_AGENT_DISALLOWED_TOOLS`、非内置再扣 `CUSTOM_AGENT_DISALLOWED_TOOLS`、异步则 `isAsync && !ASYNC_AGENT_ALLOWED_TOOLS`（teammate 经 `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` 逃逸）；再由 `resolveAgentTools`（`:122`）与 agent 声明的 `tools`（`['*']` = 过滤后全部）取交集。
2. **fork 路径**：`useExactTools:true` **绕过** `resolveAgentTools`（也就绕过了第 1 层），所以额外用 `src/utils/agentToolFilter.ts:filterParentToolsForFork`（`:21`）在把父工具数组交给 fork 前先扣掉 `ALL_AGENT_DISALLOWED_TOOLS`。调用点：`AgentTool.tsx:782`、`resumeAgent.ts`。

---

## 五、Coordinator 模式 与 Agent Swarm / Teammate

三者本质是**叠在同一套** `AgentTool → runAgent → runAsyncAgentLifecycle → <task-notification>` 机器上的不同 **spawn 策略**，区别只在 agent 集合、工具池、是否强制异步、re-entry 模型：

- **Coordinator 模式**（`src/coordinator/`）：`isCoordinatorMode()`（`coordinatorMode.ts:36`）= `feature('COORDINATOR_MODE') && CLAUDE_CODE_COORDINATOR_MODE`。开启后主 agent 变**纯编排者**（只有 `COORDINATOR_MODE_ALLOWED_TOOLS`），`getBuiltInAgents()` 只返回 worker agent（`workerAgent.ts`，工具 = `ASYNC_AGENT_ALLOWED_TOOLS` 去掉编排工具），所有 spawn 强制异步。**与 fork-subagent 互斥**（`forkSubagent.ts:34` 在 coordinator 下返回 false）。
- **Agent Swarm / Teammate**（`src/utils/agentSwarmsEnabled.ts:11`，默认开，`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_DISABLED` 关）：**持久化命名 agent**（`agentNameRegistry`，`AgentTool.tsx:846`），靠 `SendMessage({to:name})` 通信，`resumeAgentBackground` 支持 re-entry。in-process 实现见 `src/utils/swarm/inProcessRunner.ts`、`backends/InProcessBackend.ts`。与 fire-and-forget 的 fork 不同——teammate 是长活、可寻址、双向对话的。

---

## 六、`/fork` slash 命令

`src/commands/fork/fork.tsx`（`FORK_SUBAGENT` 关时 `fork` 别名挂在 `/branch` 上）：
- `feature('FORK_SUBAGENT')` gate（`:14`）。
- 递归守卫 `isInForkChild(context.messages)`（`:20`）。
- 找最后一条 assistant 消息 → 驱动**同一条** AgentTool fork 路径：`AgentTool.call({ prompt: directive, run_in_background: true, ... }, context, canUseTool, lastAssistantMessage)`（`:47`/`:59`），永远异步、fire-and-forget（`.catch` 记 log），用户立刻拿到系统确认。

---

## 扩展点（如何添加 X）

- **加一个后台旁路特性**（不占主 turn，复用父 cache）：调 `runForkedAgent`，起新 `forkLabel`，把新 querySource 加进 `src/constants/querySource.ts`；用 `createCacheSafeParams(context)` 从 hook 上下文快速构参。若要工具，注意 `canUseTool` 里 deny/allow 的 `decisionReason`。
- **加一个内置 agent**：在 `built-in/` 写定义（`getSystemPrompt`/`tools`/`whenToUse`/`model`/`permissionMode`），在 `builtInAgents.ts:getBuiltInAgents()` 注册（按需 feature/env gate）。
- **加一个自定义 agent**：放 `.claude/agents/*.md`，frontmatter 由 `parseAgentFromMarkdown`（`loadAgentsDir.ts:542`）解析。
- **改 subagent 工具访问**：编辑 `src/constants/tools.ts` 对应集合；**fork 路径额外**受 `filterParentToolsForFork` 约束（改这里才对 fork 生效）。
- **加一种 spawn 策略**：扩展 `AgentTool.tsx:414`（路由）/ `:709`（`shouldRunAsync`）的判定。

## 陷阱

- **两套 "fork" 别混**：`runForkedAgent`（进程内旁路，不 spawn）vs AgentTool 隐式 fork（真 spawn）。改到"fork"相关代码先确认在哪一套。
- **cache 一致性是命门**：任何改动若让父子 API 前缀产生字节差异（改 systemPrompt 渲染、改工具顺序/序列化、给 fork 设 `maxOutputTokens` 从而 clamp `budget_tokens`），都会静默破 cache、成本飙升。`ForkedAgentParams.maxOutputTokens` 的 docstring 专门警告了这点。
- **`useExactTools` 绕过普通工具过滤**：fork 的工具安全**只**由 `filterParentToolsForFork` 兜底——别以为 `resolveAgentTools` 会拦。
- **异步 agent 用独立 abort controller**：不挂父 controller，ESC 取消主线程**不会**杀后台 agent，必须 `chat:killAgents`。
- **task-notification 是自动事件不是用户输入**：完成通知以系统消息注入，`query.ts` 按 `agentId` 精确投递，别当成用户确认。
- **`feature()` 只能放 `if`/三元条件位**（Bun 编译器限制）——本系统大量用它 gate（`FORK_SUBAGENT`/`COORDINATOR_MODE`/`VERIFICATION_AGENT`…），别赋值给变量或塞进 `&&` 链。
