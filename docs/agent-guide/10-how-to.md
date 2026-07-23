# 10 · How-To 配方集（"我要开发一个 X"）

> 每个配方给出：碰哪些文件、按什么顺序、参考哪个既有实现、别忘了什么。深入细节点对应专题文档。**所有配方最后一步都是 `bun run precheck` 零错误。**

## 通用起手式

1. **先找最像的既有实现**当模板（配方里都点名了）。
2. 决定是否需要 **feature flag** gate（新功能默认应可开关，见 [07](./07-state-build-flags.md)）。
3. 改完跑 `bun run precheck`（typecheck + biome + test）。
4. 有运行时行为的改动，用 `bun run dev` 或 `echo "..." | bun run src/entrypoints/cli.tsx -p` 实测。

---

## 加一个内置工具 → [05](./05-tool-system.md)

1. `packages/builtin-tools/src/tools/MyTool/` 建目录。
2. `prompt.ts`（名字常量 `MY_TOOL_NAME` + 描述，**轻文件**）、`MyTool.ts`（`buildTool({...} satisfies ToolDef<Input,Output>)`）、可选 `UI.tsx` / `__tests__/`。
3. `src/tools.ts`：import + 加进 `getAllBaseTools()` 数组（按需 `feature`/`env` gate）。
4. core vs deferred：要进初始 prompt 就把名字加进 `src/constants/tools.ts` 的 `CORE_TOOLS`；否则写好 `searchHint` 自动延迟。
5. 模板：`FileReadTool`（只读并发安全）、`BashTool`（重权限）、`ExecuteTool`（代理型）。

## 加一个模型 provider → [04](./04-api-and-providers.md)

- **Anthropic-wire 兼容**（像 bedrock）：改 3 处——`providers.ts` 的 `APIProvider` 联合 + `getAPIProvider` 选择分支 + `client.ts` 的 `getAnthropicClient` 客户端工厂分支（返回 `as unknown as Anthropic`）。`claude.ts` 不动。
- **非 Anthropic-wire**（像 openai/grok）：上面 2 处 + 建 `src/services/api/<x>/{client,index}.ts`（**复制 `grok/index.ts`**）+ 在 `packages/@ant/model-provider/src/providers/<x>/` 加转换器/`resolveXModel`/`adaptXStreamToAnthropic` 并导出 + `claude.ts` `queryModel` 加分派分支。

## 加一个 CLI 子命令（`claude foo`）→ [02](./02-entry-and-commands.md)

- 在 `src/main.tsx` 子命令注册区（print 早返回 `:4595` 之后）加 `program.command('foo')...action(async () => { const { h } = await import('...'); await h() })`。
- 需绕过完整 bootstrap（性能/CI）则改在 `cli.tsx` main() 加快速路径分支（仿 `daemon`），`feature()` gate。
- ⚠️ 不碰 `src/commands.ts`。

## 加一个 slash 命令（`/foo`）→ [02](./02-entry-and-commands.md)

1. `src/commands/foo/index.ts`（`satisfies Command`，`load: () => import('./foo.js')`，选 `type: 'local'|'local-jsx'|'prompt'`）。
2. `src/commands/foo/foo.ts(x)` 导出 `call`。
3. `src/commands.ts`：import + 加进 `COMMANDS()` 数组。
4. 模板：`clear/`（local）、`help/`（local-jsx）。⚠️ `index.ts` 只放元数据 + 懒 load。

## 加一个 feature flag → [07](./07-state-build-flags.md)

1. `scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES` 加大写名（或只经 `FEATURE_<NAME>=1`）。
2. 代码里 `feature('X')`，**只在 `if`/三元条件**；gate 值/模块用命名 helper `feature('X') ? real : false`（正向三元）。
3. dev 试：`FEATURE_X=1 bun run dev`。需 runtime kill-switch 另加 `isXEnabled()`。

## 加一个 UI 组件 / 屏 / 键位 → [06](./06-ui-ink.md)

- **组件**：`src/components/MyThing.tsx`，用 `@anthropic/ink` 主题原语（`Box`/`Text`/`Dialog`），颜色用主题 key / `toInkColor()`；输入用 `useKeybinding`（**不要**裸 `useInput`）；渲染进 REPL 树 `KeybindingSetup` 内。
- **屏**：`src/screens/MyScreen.tsx`，`main.tsx` 里 `createRoot` + `<App><MyScreen/></App>`（仿 `launchRepl`）。
- **键位**：`src/keybindings/defaultBindings.ts` 对应 context 块加 `键→action`，组件里 `useKeybinding('app:x', fn, {context})`；避开 `reservedShortcuts.ts`。

## 加一个全局状态 → [07](./07-state-build-flags.md)

- **响应式 UI/会话** → `AppStateStore.ts` 加字段 + `getDefaultAppState()` 默认；`useAppState(s=>s.x)` 读、`useSetAppState()` 写。
- **进程/会话身份或记账** → `bootstrap/state.ts`（**谨慎**）加 `type State` 字段 + getter/setter，永不暴露 `STATE`。

## 改会话/turn 行为 → [03](./03-core-loop.md)

| 想做 | 下手点 |
|------|--------|
| 改模型调用/压缩（测试友好） | `QueryDeps`（`query/deps.ts`）覆盖 `callModel`/`autocompact` |
| 拦截每个工具调用 | `canUseTool`（QueryEngine 已包装 `:253`）；改执行 hook `runTools`/`StreamingToolExecutor.executeTool` |
| 加 system/user 上下文 | `getSystemPrompt()` 动态段 / `getUserContext()` / `getSystemContext()` |
| turn 中途注入 | attachment 流（`getAttachmentMessages`，`query.ts:1894`） |
| turn 边界 hook | `executePostSamplingHooks` / `handleStopHooks` |

## 加/改一个 MCP 传输或工具暴露 → [08](./08-commands-services-packages.md)

- 协议层改 `packages/mcp-client/`（transport/discovery）。
- Host 集成改 `src/services/mcp/`（`client.ts` 接传输、`config.ts` 配置、`channelPermissions.ts` 权限）。
- MCP 工具默认延迟，经 `searchExtraTools/toolIndex.ts` 索引。

## 加/改一个兼容层适配器 → [04](./04-api-and-providers.md)

- 写 `async function*` 产出 `BetaRawMessageStreamEvent`（`message_start` → 每块 `content_block_*` → `message_delta`+usage → `message_stop`），放 `packages/@ant/model-provider/src/providers/<x>/`。
- provider 说 OpenAI 线格式就复用 `adaptOpenAIStreamToAnthropic`；usage 走 `normalizeOpenAIUsage`。
- 加单测到 `model-provider/src/**/__tests__/`。

---

## 常见"我该改哪"速查

| 现象/需求 | 起点文件 |
|-----------|----------|
| system prompt 内容不对 | `src/constants/prompts.ts:423`（`getSystemPrompt`） |
| CLAUDE.md/memory 没被注入 | `src/context.ts:155`（`getUserContext`）+ `src/utils/claudemd.ts` |
| git 状态注入 | `src/context.ts:36`（`getGitStatus`） |
| 工具权限弹窗 UI 不对 | `src/components/permissions/PermissionRequest.tsx:75`（`permissionComponentForTool`） |
| 某工具不出现在工具列表 | `src/tools.ts`（`getAllBaseTools`/`getTools` 的 gate） |
| provider 选错了 | `src/utils/model/providers.ts:15`（`getAPIProvider` 优先级） |
| 构建后内存暴涨/产物问题 | `build.ts` / `vite.config.ts`（代码分割） + `scripts/post-build.ts` |
| feature flag 不生效 | `scripts/defines.ts`（`DEFAULT_BUILD_FEATURES`）+ 检查是否 `if`/三元用法 |
| 命令启动慢 | 检查 `index.ts`/action 是否懒 import；print 模式跳过子命令注册 |
| 测试互相污染 | 见 [09](./09-testing.md) 跨文件 mock 污染——多半是 mock 了上层业务模块 |
| 版本号 | `package.json` `version`（`scripts/defines.ts` 读取，别硬编码） |
