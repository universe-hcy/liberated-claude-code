# 07 · 状态管理 · 构建管线 · Feature Flags

## 状态：两套全局机制（分工明确）

### A. `AppState` — 中央响应式 React store
定义 `src/state/AppStateStore.ts`（类型 + 默认），React 接线 `src/state/AppState.tsx`。

- 类型 `AppState`：`AppStateStore.ts:91-459`，是 `DeepImmutable<{...}>` 并上一个可变尾巴（含函数/Map 的字段排除在 DeepImmutable 外，如 `tasks` `:167`、`agentNameRegistry: Map` `:170`）。
- 默认工厂 `getDefaultAppState()`：`:463-577`。

**放这里**（响应式 UI/会话数据）：messages/speculation、`toolPermissionContext` `:114`、pending worker/sandbox 请求、`denialTracking`、`mcp: {clients,tools,commands,resources}` `:180-191`、`plugins` `:192`、`tasks`/`agentNameRegistry`/`todos`/`agentDefinitions`、UI 模型 `mainLoopModel`/`mainLoopModelForSession` `:95-96`、bridge/voice/tmux 等大量 feature UI 状态。部分字段特意 optional 以便 feature 关时 DCE。

### B. `src/bootstrap/state.ts` — 模块级会话全局单例
一个可变 `STATE` 对象，模块加载时建一次：
- `type State`：`:45+`；`const STATE: State = getInitialState()`：**`:423`**。
- 只经导出的 getter/setter 访问，**永不直接碰对象**。
- 文件明确警告：`// DO NOT ADD MORE STATE HERE`（`:31`、`:422`）。

**放这里**（进程/会话身份 + 记账，非响应式）：`sessionId`（`getSessionId` `:425`、`switchSession` `:462`）、`originalCwd`/`projectRoot`/`cwd`（`getCwdState`/`setCwdState` `:521-526`）、模型覆盖 `mainLoopModelOverride`（`get/setMainLoopModelOverride` `:820-831`）、成本/时间记账（`getTotalCostUSD` `:560`）、会话标志（`sessionBypassPermissionsMode`、`sessionTrustAccepted`…）。

### 判断规则
- **要触发 React 重渲染**（UI、消息、每 turn 工具/权限）→ `AppState`。
- **进程级身份/配置/记账，被非 React 代码命令式读取**（sessionId、cwd、模型覆盖、成本）→ `bootstrap/state.ts` getter。bootstrap 文件是"冻结"倾向的，优先用 AppState。

### store 工作方式
手写外部 store `src/state/store.ts`（34 行）：
- `createStore<T>(initialState, onChange?)` `:10`：持 `let state` + `Set<Listener>`。
- `setState(updater)` `:20-27`：`next=updater(prev)`，`Object.is` 相等则跳过，否则替换 + 通知。
- `subscribe` `:29-32` 返回 unsubscribe。

React 绑定 `src/state/AppState.tsx`：
- `AppStateProvider` `useState(() => createStore(...))` `:69` 建一次，provider 不重渲染，禁嵌套 `:61-64`。
- **读** `useAppState(selector)` `:129-146`：`useSyncExternalStore`，仅选中切片变化才重渲染。规则：每个独立字段调一次 hook；**selector 不得返回整个 state 或新分配对象**（dev 有 throw `:136-140`）。
- **写** `useSetAppState()` `:153-155` 返回稳定 `setState`；只用它的组件不重渲染。`useAppStateStore()` `:160` 给非 React 代码。
- 派生逻辑在 `src/state/selectors.ts`（**纯函数**，无副作用，如 `getActiveAgentForInput` `:59`）。

## 构建管线

### 主：`build.ts`（Bun.build）
- 清 `dist/` `:9-10`。
- feature = `DEFAULT_BUILD_FEATURES` ∪ 所有 `FEATURE_*` env（去前缀）`:13-16`。
- `Bun.build({ entrypoints:['src/entrypoints/cli.tsx'], target:'bun', splitting:true, sourcemap:'linked', define:{...getMacroDefines(),'process.env.NODE_ENV':'production'}, features })` `:19-33`。设 production 是为剥离 React `_debugStack`（~12MB）。
- **`import.meta.require` patch** `:43-60`：把 Bun-only 的 `import.meta.require` 改成 Node 兼容 `createRequire`，同一产物可跑 Node。
- **Bun 解构 patch** `:62-80`：守 `var {..} = globalThis.Bun`（第三方依赖），防 Node 崩。
- **vendor 复制** `:86-93`：`vendor/audio-capture`、`src/utils/vendor/ripgrep` → `dist/vendor/`。
- **双入口** `:95-108`：`cli-bun.js`（`#!/usr/bin/env bun`）+ `cli-node.js`（`#!/usr/bin/env node`），`chmod 755`。

**为何必须代码分割（内存）**：`vite.config.ts:96-99` 记录——Bun/JSC 全量解析单文件 bundle，17MB 产物 ~1GB RSS；分割成 chunk 按需加载降到 ~300MB。`build.ts` 靠 `splitting:true`。

### 备用：Vite（`vite.config.ts` + `scripts/post-build.ts`）
- SSR/Node 构建（`ssr.target:'node'`，`noExternal:true`）；Rollup `format:'es'`，`entryFileNames:'cli.js'`，`chunkFileNames:'chunks/[name]-[hash].js'`（同样代码分割）。
- 三个 Rollup 插件：`rawAssetPlugin`（`.md/.txt/.html/.css` 当裸字符串）、`featureFlagsPlugin()`（见下）、`importMetaRequirePlugin()`。
- `post-build.ts` 做 `build.ts` 内联做的 Node 兼容/vendor/双入口活（但 `import.meta.require` patch 由 Vite 插件处理，不在 post-build）。

## MACRO defines 与 feature 注入（dev vs build）

单一真源 `scripts/defines.ts`：
- `getMacroDefines()` `:18-28`：`MACRO.*` 的 JSON 化替换（`MACRO.VERSION` 从 package.json 读避免漂移、`MACRO.BUILD_TIME`、若干置空的 URL/channel）。**编译期常量替换。**
- `DEFAULT_BUILD_FEATURES` `:39-101`：启用 flag 的规范列表（带中文注释；禁用的注释掉，如 `HISTORY_SNIP`/`CONTEXT_COLLAPSE`/`UDS_INBOX`/`TEAMMEM`）。被 `build.ts`、`scripts/dev.ts`、`scripts/vite-plugin-feature-flags.ts` 消费。

**dev vs build 注入**：
- **Dev**（`scripts/dev.ts`）：`bun run` + MACRO 作 `-d k:v` flag `:25-28`，feature 作 `--feature <NAME>` `:39-40`（因 `bunfig.toml [define]` 不传播到动态 import 的模块）。还并入 `FEATURE_*` env。
- **Build**（`build.ts`）：MACRO 进 `Bun.build` `define`，feature 进 `features` 数组。
- **Vite**：MACRO 经 `vite.config.ts` `define`；feature 由 transform 插件处理。

## `feature()` flag 规则

- 声明 `src/types/internal-modules.d.ts:10-12`：`declare module 'bun:bundle' { export function feature(name: string): boolean }`。
- 用法：`import { feature } from 'bun:bundle'` 后 `feature('FLAG_NAME')`（**247** 个文件用到）。
- **编译器约束**：`feature()` 只能**直接**出现在 `if` 语句或三元条件里（Bun bundler tree-shaking 限制）。代码内文档见 `src/commands/autofix-pr/index.ts:4-9`、`src/query.ts:1049-1051`。要 gate 整个模块/值，用命名 helper 返回 `feature('X') ? A : B`。
- **必须正向三元，不只是风格**：`src/voice/voiceModeEnabled.ts:17-22`、`src/bridge/bridgeEnabled.ts:35` 指出负向（`if (!feature(...)) return`）无法从外部构建剥离内联字符串字面量；须写 `feature('X') ? real : false`。
- **如何求值**：
  - Bun 下（dev `--feature` / build `features`）：Bun 原生 macro 解析 `feature('X')` 为布尔并 DCE 掉 false 分支。
  - Vite/Rollup 下：`scripts/vite-plugin-feature-flags.ts` 手动做——正则 `FEATURE_CALL_RE` 在 **transform 时（import 解析前）**把每个调用替换成字面 `true`/`false`（这样死分支里对不存在文件的 `require` 永不解析）；并把 `bun:bundle` 注册为返回 `feature()=>false` 的虚拟模块。
- **启用 flag**：加进 `DEFAULT_BUILD_FEATURES`，或设 `FEATURE_<NAME>=1`。例：`FEATURE_PROACTIVE=1 bun run dev`。
- **两层 gating**：有些 flag build 时编入（在列表里），但另有 runtime toggle 默认关——如 `EXPERIMENTAL_SKILL_SEARCH` build 由 `feature()` gate、runtime 由 `featureCheck.isSkillSearchEnabled()` gate。

## 实操

### 加 feature flag
1. 把大写名（`[\w]+`）加进 `DEFAULT_BUILD_FEATURES`（`scripts/defines.ts:39-101`），或只经 `FEATURE_<NAME>=1` 启用。
2. 代码里 `import { feature } from 'bun:bundle'`，**只在 `if`/三元里** gate。gate 值/模块用命名 helper：`function isXEnabled() { return feature('X') ? true : false }`。用正向三元。
3. 无需改插件——Bun 与 Vite 正则插件都从 `DEFAULT_BUILD_FEATURES` ∪ `FEATURE_*` 自动识别。dev 时 `FEATURE_X=1 bun run dev`。
4. 需 runtime kill-switch 则另加 `isXEnabled()`（GrowthBook/settings），仿 voice/skill-search。

### 加全局状态
- **响应式 UI/会话 → AppState**：① 在 `AppStateStore.ts:91-459` 加字段（纯数据放 DeepImmutable 块；含函数/Map 放 `:165` 之后；feature-gated 设 optional 助 DCE）。② `getDefaultAppState()`（`:463-577`）加默认。③ 读 `useAppState(s => s.yourField)`，写 `useSetAppState()(prev => ({...prev, yourField:...}))`，需要派生加进 `selectors.ts`（保持纯）。
- **进程/会话身份或记账 → bootstrap 单例**（**谨慎**，文件头明确劝退）：① 在 `type State`（`:45+`）加字段 + `getInitialState()` 加种子。② 导出 getter/setter（仿 `getCwdState`/`setCwdState`），**永不暴露 `STATE`**。

> 注：部分代码注释引用 `docs/feature-gating.md`，但该文件**不存在**——权威规则目前只在这些代码注释与 `scripts/vite-plugin-feature-flags.ts` 里。
