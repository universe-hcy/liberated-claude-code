# 05 · 工具系统

> 关键文件：`src/Tool.ts`（Tool 接口 + `buildTool`）、`src/tools.ts`（注册装配）、`src/constants/tools.ts`（`CORE_TOOLS` 白名单）、`packages/builtin-tools/src/tools/`（~60 个工具实现）、`src/services/searchExtraTools/`（延迟工具 TF-IDF 索引）。

## Tool 接口形状

`Tool<Input, Output, P>` 定义在 **`src/Tool.ts:372-705`**——是一个大的结构化对象类型（**不是** class）。工具是普通对象，通常由 `buildTool(...)` 生成。**没有 generator 形式，执行是单个 async `call`。**

必备/关键成员（选摘）：
- **身份/元数据**：`name` `:466`、`aliases?` `:381`、`searchHint?`（3-10 词，喂 TF-IDF 延迟搜索）`:388`、`maxResultSizeChars`（超过则结果落盘，`Infinity` 退出）`:476`、`shouldDefer?`/`alwaysLoad?`/`isMcp?`/`isLsp?` `:446-482`。
- **Schema**：`inputSchema`（Zod）`:404`、`inputJSONSchema?`（MCP 用）`:407`、`outputSchema?` `:410`。
- **执行**：`call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>` `:389-395`。`ToolResult<T>`（`:331-346`）带 `data` / `newMessages?` / `contextModifier?` / `mcpMeta?`。`description(input, options)` `:396`（动态描述）、`prompt(options)` `:528`（给模型看的 schema 级描述）。
- **行为谓词**（多有 `buildTool` 默认）：`isEnabled()` / `isConcurrencySafe(input)` / `isReadOnly(input)` `:412-414`、`isDestructive?` / `interruptBehavior?`（`'cancel'|'block'`）/ `isSearchOrReadCommand?` / `isOpenWorld?` `:416-445`。
- **权限**：`validateInput?(input, context)` `:499`（告诉模型为何非法，无 UI）、`checkPermissions(input, context)` `:510`（工具专属权限）、`preparePermissionMatcher?` / `getPath?` `:516-526`。
- **渲染（Ink/React）**：`userFacingName(input)` `:534`、`renderToolUseMessage`（必需）`:615`、`mapToolResultToToolResultBlockParam`（必需，**模型面**序列化）`:567`、可选 `renderToolResultMessage?` / `renderToolUseProgressMessage?` / `renderToolUseErrorMessage?` / `getToolUseSummary?` / `getActivityDescription?` / `extractSearchText?` `:549-704`、`toAutoClassifierInput`（auto-mode 安全分类器）`:566`。

**`buildTool` 与 `ToolDef`** `:717-802`：工具写成 `ToolDef`（部分方法可省），过 `buildTool(def)` 补 `TOOL_DEFAULTS`（`:767-779`）。**fail-closed 默认**：`isEnabled→true`、`isConcurrencySafe→false`、`isReadOnly→false`、`isDestructive→false`、`checkPermissions→{behavior:'allow',updatedInput}`、`userFacingName→name`。惯用法：
```ts
export const XTool = buildTool({ ... } satisfies ToolDef<InputSchema, Output>)
```

集合类型 `type Tools = readonly Tool[]` `:711`；查找 `toolMatchesName` `:358`、`findToolByName` `:368`。运行时上下文 `ToolUseContext` `:149-310`（穿进每个 `call`）。

## 一个真实工具的解剖：FileReadTool

目录 `packages/builtin-tools/src/tools/FileReadTool/`。每个工具一个文件夹，惯例：
- **`FileReadTool.ts`** — `buildTool({...})` 导出（工具对象本体）。
- **`prompt.ts`** — 名字常量 + 描述模板：`FILE_READ_TOOL_NAME = 'Read'`。**名字常量放这种轻文件**，让 `src/constants/tools.ts`、`src/tools.ts` 能 import 名字而不拉整个实现（避免循环依赖）。
- **`UI.tsx`** — React/Ink 渲染函数，import 进工具对象。
- 其它：`constants.ts` / `__tests__/` / 专属逻辑文件。BashTool 最全（`bashPermissions.ts`、`bashSecurity.ts`、`readOnlyValidation.ts`、`shouldUseSandbox.ts`…）；AgentTool 有 `runAgent.ts`、`loadAgentsDir.ts`、`builtInAgents.ts`、`built-in/`。

## 注册：`src/tools.ts`

- **`getAllBaseTools(): Tools`** `:218-284` 是唯一真源：当前环境所有可能工具的数组字面量。**顺序敏感**（`:216` 注释：须与服务端 Statsig 配置同步以保 system-prompt 缓存稳定）。
- **import / gate 方式**：
  - 无条件 `import` 常驻工具（AgentTool、BashTool、FileReadTool…）`:3-13,61-100`。
  - 条件 `require(...)` 绑模块级常量，`feature('X')`（`bun:bundle`，可 DCE）或 `process.env` gate：`REPLTool` on `USER_TYPE==='ant'`、`SleepTool` on `feature('PROACTIVE')||feature('KAIROS')`、`MonitorTool` on `feature('MONITOR_TOOL')` 等。
  - 懒 `require` getter 破循环依赖：`getTeamCreateTool`、`getSendMessageTool`、`getPowerShellTool`。
  - 数组内联条件：`...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool])`、`...(isTodoV2Enabled() ? [...] : [])`、`TestingPermissionTool` only `NODE_ENV==='test'`。
- **`getTools(permissionContext)`** `:304-360`：运行时过滤——`CLAUDE_CODE_SIMPLE`（只 Bash/Read/Edit）、剥离特殊工具、`filterToolsByDenyRules`、隐藏 `REPL_ONLY_TOOLS`、丢 `isEnabled()===false`。
- **`assembleToolPool(permissionContext, mcpTools)`** `:378-400`：唯一合并 built-in + MCP 的地方——built-in 排前缀、MCP 排后、`uniqBy(...,'name')`（built-in 赢名字冲突，保缓存稳定）。

## CORE_TOOLS vs 延迟工具

- **`CORE_TOOLS`** `src/constants/tools.ts:137-179`：`ReadonlySet<string>`，初始 prompt 就带全 schema 的工具名（Bash/Shell、Read、Edit、Write、Glob、Grep、NotebookEdit、Agent、AskUserQuestion、Task* 家族、TodoWrite、plan-mode 工具、WebFetch、WebSearch、LSP、Skill、Workflow、Sleep + 发现工具 SearchExtraTools/ExecuteExtraTool/SyntheticOutput）。
- **延迟规则** `isDeferredTool(tool)`（`SearchExtraToolsTool/prompt.ts:69-78`）：**非 `alwaysLoad` 且不在 `CORE_TOOLS`** 即延迟。→ 所有非核心内置 + 全部 MCP 工具都延迟。`alwaysLoad`（`Tool.ts:459`）强制进初始 prompt。
- **线级含义**：延迟工具带 `defer_loading: true`（`BetaTool` 扩展，`src/utils/api.ts:68-127`）。gating/计数在 `src/utils/searchExtraTools.ts`。

**延迟加载流（SearchExtraTools → ExecuteExtraTool）**：
1. **发现**：`SearchExtraToolsTool` 跑本地 **TF-IDF 搜索**。索引 `src/services/searchExtraTools/toolIndex.ts` `buildToolIndex` `:80-149`：name 权重 3.0、`searchHint` 2.5、`description` 1.0；`searchTools` `:151-209` 余弦相似 + `select:<name>` 精确名快路径 + CJK bigram；阈值 `SEARCH_EXTRA_TOOLS_DISPLAY_MIN_SCORE`（0.10）。索引按工具名列表缓存。
2. **预取**：`prefetch.ts` turn 间提前搜（`startSearchExtraToolsPrefetch`），用 `discoveredToolsThisSession` 去重，发 `tool_discovery` attachment。turn-zero 预取有意禁用。
3. **执行**：`ExecuteTool`（名 `ExecuteExtraTool`）是常驻代理，实际调延迟工具。输入 `{tool_name, params}`。`call`：`findToolByName` 解析 → **拦截未发现的延迟工具**（要求先 SearchExtraTools）→ `isEnabled` → `inputSchema.safeParse` 校验 params → 目标 `validateInput`/`checkPermissions` → 委托 `targetTool.call(...)`，包成 `{result, tool_name}`。自身 `checkPermissions` 返回 `passthrough`。

## 添加新内置工具（步骤）

1. **建目录** `packages/builtin-tools/src/tools/MyTool/`。
2. **建文件**：
   - `prompt.ts`（或 `constants.ts`/`toolName.ts`）导出名字常量 `export const MY_TOOL_NAME = 'MyTool'` + 描述（**轻文件，无重 import**）。
   - `MyTool.ts`：定义 Zod `inputSchema`（常 `lazySchema(() => z.object({...}))`）+ `export const MyTool = buildTool({ name: MY_TOOL_NAME, searchHint, maxResultSizeChars, inputSchema, async description(), async prompt(), async call(...) {...}, checkPermissions, renderToolUseMessage, mapToolResultToToolResultBlockParam, ... } satisfies ToolDef<InputSchema, Output>)`。能靠默认就别重写谓词。
   - 可选 `UI.tsx` / `__tests__/`。
3. **注册 `src/tools.ts`**：`import { MyTool } from '@claude-code-best/builtin-tools/tools/MyTool/MyTool.js'`（或按需 `feature`/`env` gate 的 `require` 常量），加入 `getAllBaseTools()` 返回数组。
4. **决定 core vs deferred**：要免 SearchExtraTools 直接进初始 prompt → 把名字常量加进 `CORE_TOOLS`（`src/constants/tools.ts`）。否则自动延迟，只需写好 `searchHint`。
5. **（可选）agent 可用性**：要对 subagent/coordinator/async agent 限制，加名字到 `src/constants/tools.ts` 的对应集合（`ALL_AGENT_DISALLOWED_TOOLS` / `ASYNC_AGENT_ALLOWED_TOOLS` / `COORDINATOR_MODE_ALLOWED_TOOLS`）。

## 权限与结果渲染

**权限**（多阶段流水线，逐工具 hook 在工具对象，通用逻辑 `src/utils/permissions/permissions.ts`）：
1. `validateInput?` — 输入是否合法（`ValidationResult`），只告知模型，无 UI。
2. `checkPermissions` — 通过 validate 后调，返回 `PermissionResult`（`behavior: 'allow'|'deny'|'ask'|'passthrough'` + `updatedInput`/`message`）。默认 `{behavior:'allow',updatedInput}`。FileReadTool 覆盖为 `checkReadPermissionForTool(...)`；ExecuteTool 返回 `passthrough` 委托内层工具。
3. 上下文 `ToolPermissionContext`（`Tool.ts:114-129`，含 `mode` + `alwaysAllow/Deny/AskRules`）。
4. **黑名单在模型看到工具前应用**——`filterToolsByDenyRules`（`tools.ts:295-302`），如 `mcp__server` deny 剥离整个 server 的工具。
5. 辅助：`preparePermissionMatcher?`（hook `if` 条件匹配器）、`getPath?`/`backfillObservableInput?`（归一化输入，FileReadTool 展开 `~`/相对路径防绕过 hook 白名单）。

**结果渲染**分两面：
- **模型面**：`mapToolResultToToolResultBlockParam(content, toolUseID)`（必需）转 `Output` → API `tool_result` 块（模型读这个）。超 `maxResultSizeChars` 则落盘 + 预览 + 路径。
- **UI 面（Ink）**：`renderToolUseMessage`（必需，input 是 `Partial` 因为流式进）、`renderToolResultMessage?`（省略则不渲染，如 TodoWrite 改用面板）、`renderToolUseErrorMessage?`（fallback `<FallbackToolUseErrorMessage/>`）、`getActivityDescription?`（spinner 文字）、`extractSearchText?`（须返回恰好 transcript 可见文本，保搜索索引一致）。惯例：渲染函数写在 `UI.tsx`，`buildTool` 里引入。
