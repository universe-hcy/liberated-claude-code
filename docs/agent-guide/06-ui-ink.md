# 06 · UI 层（Ink 终端界面）与 REPL

> 关键文件：`packages/@ant/ink/`（fork 的 Ink 框架，**import 名 `@anthropic/ink`**）、`src/screens/REPL.tsx`（交互主屏）、`src/replLauncher.tsx`（`launchRepl`）、`src/components/`（152 个组件）、`src/interactiveHelpers.tsx`（渲染/对话辅助）。
>
> ⚠️ **无 `src/ink.ts`**。CLAUDE.md 里说的"Ink render wrapper"实际是 `main.tsx` + `src/interactiveHelpers.tsx` 里的渲染入口，加小的颜色辅助 `src/utils/ink.ts`。Ink 框架在 `packages/@ant/ink/`（**不是** `src/ink/`）。

## UI 启动（render → REPL）

1. **建 root** `main.tsx:2758-2759`：`const { createRoot } = await import('@anthropic/ink'); root = await createRoot(ctx.renderOptions)`。渲染选项来自 `getBaseRenderOptions()`（`src/utils/renderOptions.js`）。`createRoot`/`render` 从 `packages/@ant/ink/src/index.ts:11-18` 导出 → `core/root.js`；reconciler/renderer 在 `packages/@ant/ink/src/core/`（`ink.tsx`、`reconciler.ts`、`renderer.ts`、`root.ts`）。
2. **launch** `main.tsx` 在 7 处调 `launchRepl(root, appProps, replProps, renderAndRun)`（fresh/resume/connect 等入口）。
3. **`launchRepl`** `replLauncher.tsx:14-31` 懒 import `App`/`SentryErrorBoundary`/`REPL`，调注入的 `renderAndRun`，树为：
   ```
   <SentryErrorBoundary name="RootREPLBoundary">
     <App {...appProps}>
       <REPL {...replProps} />
     </App>
   </SentryErrorBoundary>
   ```
4. **`renderAndRun`** `interactiveHelpers.tsx:124-125` 就一行 `root.render(element)`。（同文件辅助：`showDialog` `:57`、`exitWithError` `:70`、`exitWithMessage` `:80`。）

## 组件树（高层）

```
createRoot()  [core/root.ts]
 └─ SentryErrorBoundary                    replLauncher.tsx:25
    └─ App                                 components/App.tsx:21
       ├─ FpsMetricsProvider
       ├─ StatsProvider
       ├─ AppStateProvider                 state/AppState
       └─ ThemeProvider  [@anthropic/ink]  App.tsx:26  (theme = getGlobalConfig().theme)
          └─ REPL                          screens/REPL.tsx:831
             ├─ KeybindingSetup            REPL.tsx:5660/5852 (包住交互体)
             ├─ Messages/VirtualMessageList REPL.tsx:5628,5909
             │    └─ MessageRow            components/MessageRow.tsx
             ├─ PromptInput                REPL.tsx:6486
             ├─ CommandKeybindingHandlers  REPL.tsx:5676,5868
             ├─ PermissionRequest/Sandbox… (从队列渲染)
             └─ MessageSelector/dialogs    REPL.tsx:6542…
```

- **`KeybindingSetup` 不在 `App.tsx`**——REPL 自己把交互体包进去（`REPL.tsx:5660,5852`）。独立对话经 `dialogLaunchers.tsx:166` / `interactiveHelpers.tsx:114` 拿到它。
- 消息：顶层列表 `components/Messages.tsx`（~48KB）+ 虚拟化 `components/VirtualMessageList.tsx`；每行 `components/MessageRow.tsx`；内容渲染 `components/Message.tsx`。

## 用户输入流：PromptInput → query 循环

- `PromptInput`（`components/PromptInput/PromptInput.tsx`，~98KB，最大文件）渲染于 `REPL.tsx:6486`。关键 prop：`input`/`onInputChange`、`mode`/`onModeChange`，核心 **`onSubmit`** `:6524` + `onAgentSubmit`。
- `onSubmit`（`useCallback`，`REPL.tsx:3970`，经 ref `onSubmitRef`）→ `handlePromptSubmit({...})` `REPL.tsx:4364`。
- `handlePromptSubmit`（`src/utils/handlePromptSubmit.ts`）收 `onQuery` 参数 → `executeUserInput` → `processUserInput`（`src/utils/processUserInput/processUserInput.ts`）。
- 实际 query 循环回到 REPL：`onQuery`（`REPL.tsx:3617`）→ `onQueryImpl`（`:3334`）→ `onQueryEvent`（`:3152`）发事件。loading/turn 生命周期由 `queryGuard` / `resetLoadingState` 管。

## 工具权限提示

- REPL 维护队列：`toolUseConfirmQueue`（`REPL.tsx:1388`，`ToolUseConfirm` 对象）+ `sandboxPermissionRequestQueue`（`:1393`）。选择器决定活动对话 `'tool-permission'`/`'sandbox-permission'`（`:2446-2502`）。
- 分派组件 `src/components/permissions/PermissionRequest.tsx`。`permissionComponentForTool(tool)`（`:75-110`）是对 **Tool 身份**（非名字）的 `switch`，映射每个内置工具到其请求 UI：`FileEditTool→FileEditPermissionRequest`、`BashTool→BashPermissionRequest`、`WebFetchTool→WebFetchPermissionRequest`、`ExitPlanModeV2Tool→ExitPlanModePermissionRequest`、`SkillTool→SkillPermissionRequest`、`GlobTool/GrepTool/FileReadTool→FilesystemPermissionRequest` 等；默认 → **`FallbackPermissionRequest`** `:107`。
- 契约 `PermissionRequestProps`（`:112-131`）+ `ToolUseConfirm`（`:133-162`）；关键回调 `onAllow(updatedInput, permissionUpdates, feedback?, contentBlocks?)`、`onReject`、`recheckPermission()`、`setStickyFooter`。
- 每个工具专属对话是 `src/components/permissions/` 下子目录（`BashPermissionRequest/` 等）。共享积木：`PermissionPrompt.tsx`、`PermissionDialog.tsx`、`PermissionExplanation.tsx`、`hooks.ts`、`permissions/rules/`。

## design-system/ 可复用组件

`src/components/design-system/` 是对 `@anthropic/ink` 主题组件的**一行 re-export 薄壳**：`Byline`、`Dialog`、`KeyboardShortcutHint`、`ListItem`、`ThemedText`（`Text`）。

完整可复用集在 `packages/@ant/ink/src/theme/`，从 `index.ts:234-253` 导出：`Box`（ThemedBox）、`Text`、`Dialog`、`Divider`、`FuzzyPicker`、`ListItem`、`LoadingState`、`Pane`、`ProgressBar`、`Ratchet`、`StatusIcon`、`Tabs`/`Tab`、`Byline`、`KeyboardShortcutHint`、`Spinner`、`SearchBox`。低层原语（未主题化）：`BaseBox`、`BaseText`、`Link`、`Newline`、`Spacer`、`ScrollBox`、`AlternateScreen`。App 级复用 UI 在 `src/components/ui/`。

## 主题与键位

**主题**（`packages/@ant/ink/src/theme/`）：
- `ThemeProvider.tsx` 提供 context；`useTheme()`（`:140`，返回 `[ThemeName, setter]`）、`useThemeSetting()`（`:149`）。
- 调色板 `theme/theme-types.ts`：`Theme` 类型 `:4`、`THEME_NAMES`（含 `'dark'`/`'light'`）`:92-93`、`lightTheme` `:115`/`darkTheme` `:440` + `*AnsiTheme`/`*DaltonizedTheme`；`getTheme(themeName)` `:598`。
- `theme/color.ts` `color(key, themeName, type)` `:9` 解析 `keyof Theme` 或裸色到 ANSI。App 桥 `src/utils/ink.ts` `toInkColor()`。
- 接线：`App.tsx:26-29` 挂 `ThemeProvider`（`initialState=getGlobalConfig().theme`），`saveGlobalConfig` 持久化。选择器 `src/components/ThemePicker.tsx`。

**键位**（两半）：
- 框架引擎 `packages/@ant/ink/src/keybindings/`：`KeybindingSetup.tsx`（provider + chord 状态 + `ChordInterceptor` 先抢输入，`CHORD_TIMEOUT_MS=1000`）、`useKeybinding.ts`（`useKeybinding`/`useKeybindings`）、`resolver.ts`、`parser.ts`、`match.ts`。
  - 解析模型（`useKeybinding.ts:34-97`）：handler 按 `action` 字符串 + `context` 注册；每键 context 列表 `[...activeContexts, context, 'Global']`（越具体越优先）；handler 返回 `false` = 未消费 → 继续传播（fall-through）。
- App 配置 `src/keybindings/`：`defaultBindings.ts` `DEFAULT_BINDINGS` `:32`——按 context 分块（`Global` `:34`、`Chat` `:64`…）映射 键→action（`'ctrl+c':'app:interrupt'`、`'ctrl+t':'app:toggleTodos'`、`'ctrl+r':'history:search'`、`shift+tab`→`chat:cycleMode`）。用户覆盖 `~/.claude/keybindings.json`（`loadUserBindings.ts` 热重载）；`reservedShortcuts.ts` 标不可改键（ctrl+c/d）；`validate.ts`/`schema.ts` 校验。App provider 包装 `src/keybindings/KeybindingProviderSetup.tsx`。

## 添加 UI 组件 / 屏 / 键位

**加组件**：
1. 建 `src/components/MyThing.tsx`，**用 `@anthropic/ink` 主题原语**（`Box`/`Text`/`Dialog`/`ListItem`）而非裸 ANSI，才尊重主题。
2. 颜色用主题 key（`<Text color="error">`）或 `toInkColor()`；别硬编码 ANSI。
3. 渲染进 REPL 树合适处（`REPL.tsx:5852-6678`，在 `KeybindingSetup` 内才能用键位）。输入处理用 `useKeybinding`/`useKeybindings`（示例 `src/components/ThinkingToggle.tsx:35,48`），**不要**用裸 `useInput`（有 eslint 规则 `custom-rules/prefer-use-keybindings`）。

**加屏**：
1. 建 `src/screens/MyScreen.tsx` 导出组件 + `Props`（仿 `REPL.tsx:831`）。
2. 像 REPL 一样 boot：`main.tsx` 里 `createRoot(getBaseRenderOptions(...))` 渲染 `<App {...appProps}><MyScreen .../></App>`，经 `renderAndRun`。需键位就包 `KeybindingSetup`。模态对话可复用 `interactiveHelpers.tsx` / `dialogLaunchers.tsx` 的 `showDialog`。

**加键位**：
1. 在 `src/keybindings/defaultBindings.ts` 对应 context 块加映射（如 `Global` 块加 `'ctrl+g':'app:myAction'`）。
2. 组件里注册：`useKeybinding('app:myAction', () => {...}, { context: 'Global' })`（`useKeybinding.ts:34`）。组件必须挂在 `KeybindingSetup` 内。
3. 别用保留键（`reservedShortcuts.ts` / `NON_REBINDABLE`），`/doctor` 会警告。用户可在 `~/.claude/keybindings.json` 覆盖。

## React Compiler（`_c()`）约定——别被吓到

- **本 repo 源码是正常写的**——`src/` 与 `packages/@ant/ink/src/` 里 `_c(` / `react/compiler-runtime` **零**出现（grep 确认）。**不要手写 memo 缓存。**
- React Compiler 在 **build 时**跑。证据：ambient 类型垫片 `src/types/react-compiler-runtime.d.ts` + `react-compiler-runtime` 运行时依赖（`vite.config.ts:133` 去重）。
- 后果：在**打包后**的 `cli.js`（及栈跟踪）里会看到编译器生成的 `import { c as _c } from "react/compiler-runtime"` 和 `const $ = _c(N)` 槽位检查——那是自动的逐组件 memo（等价 `useMemo`/`useCallback`），**不要编辑或模仿**，改干净的 `.tsx` 源即可。
