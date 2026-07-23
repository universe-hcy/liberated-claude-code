# 02 · 入口与命令分发

> 关键文件：`src/entrypoints/cli.tsx`（363 行，真正入口 + 快速路径）、`src/main.tsx`（~5640 行，Commander 注册 + 默认 action）、`src/entrypoints/init.ts`（memoized 一次性 init）、`src/commands.ts`（850 行，**slash 命令**注册表）、`src/types/command.ts`（`Command` 类型契约）。
>
> **两套"命令"别混**：Commander **子命令**（`claude mcp`、`claude auth login`，在 `main.tsx`）vs REPL 内 **slash 命令**（`/clear`、`/help`，在 `commands.ts`）。

## 启动流程：进程 → REPL

1. **shebang / 进程启动** `cli.tsx:1`（`#!/usr/bin/env bun`）。第一条 import 是性能垫片 `../utils/performanceShim.js` `cli.tsx:5`，**必须在 React/OTel 之前**。顶层副作用设 env `cli.tsx:40-69`。
2. **`await main()`** `cli.tsx:363` → `main()` `cli.tsx:76`，取 `process.argv.slice(2)`。
3. **快速路径检查**按顺序跑（见下节）。都不命中则 fall through。
4. **早期输入捕获 + 加载 main** `cli.tsx:353-358`：`startCapturingEarlyInput()`，动态 `import('../main.jsx')`，`await cliMain()`。所有 import 都是动态的，保持快速路径廉价。
5. **`main()` in main.tsx** `main.tsx:743`：装 exit/SIGINT handler，早判 `-p/--print` 得 `isInteractiveSession` `:958-961`。
6. **构建 Commander program** `main.tsx:1082`。
7. **`preAction` hook** `main.tsx:1087-1148`：**`await init()`** `:1096`、`initSinks()` `:1111`、`runMigrations()` `:1129`、加载远程设置/策略。对任何执行的命令都跑，但 `--help` 不跑。
8. **`init()`** `init.ts:66`（memoized）：`enableConfigs()`、graceful shutdown、1P 事件、mTLS/proxy、Sentry/Langfuse、`initUser()`、API 预连接。
9. **Print 模式短路** `main.tsx:4595-4610`：`-p/--print` 时在**注册 ~52 个子命令之前** `parseAsync` 并返回（省 ~65ms），默认 action 路由到非交互 print 处理（分支 `main.tsx:3131`）。
10. **根默认 `.action()`** `main.tsx:1434`（交互路径）：setup 后构建 `initialMessages`，调 **`launchRepl(...)`**，主挂载点 `main.tsx:4449`。
11. **子命令注册 + parse**：非 print 路径注册所有子命令后 `program.parseAsync(process.argv)` `main.tsx:4607`。

## `cli.tsx` 快速路径（进 main.tsx 之前）

大多用 `feature(...)` gate 以便外部构建 DCE：

| 触发 | 行 | 行为 |
|------|----|------|
| `--version`/`-v` | 80 | 打印 `MACRO.VERSION`，零 import |
| `--dump-system-prompt`（feat `DUMP_SYSTEM_PROMPT`）| 93 | 渲染系统提示并退出 |
| `--claude-in-chrome-mcp` / `--chrome-native-host` | 106/111 | Chrome MCP / native host |
| `--computer-use-mcp`（feat `CHICAGO_MCP`）| 116 | Computer Use MCP server |
| `--acp`（feat `ACP`）| 124 | ACP agent（stdio） |
| `weixin` | 131 | `handleWeixinCli()` |
| `--daemon-worker[=kind]`（feat `DAEMON`）| 164 | daemon worker（精简，无 configs/analytics） |
| `remote-control`/`rc`/`bridge`（feat `BRIDGE_MODE`）| 182 | 鉴权 + gate 后 `bridgeMain()` |
| `daemon`（feat `DAEMON`\|`BG_SESSIONS`）| 231 | `daemonMain()` |
| `autonomy` | 249 | 打印后 `exit(0)` |
| `--bg`（feat `BG_SESSIONS`）| 266 | `handleBgStart()` |
| `ps`/`logs`/`attach`/`kill` | 278 | 已废弃 → 映射到 `daemon <sub>` |
| `job` / `new`/`list`/`reply`（feat `TEMPLATES`）| 297/308 | template job |
| `--tmux` + `--worktree` | 318 | `execIntoTmuxWorktree()` |
| `--update`/`--upgrade` | 342 | 改写 argv 为 `update` 子命令 |
| `--bare` | 348 | 早设 `CLAUDE_CODE_SIMPLE=1`，然后 fall through |

Fall-through `cli.tsx:352-358` → 加载 main.tsx。

## 添加 Commander 子命令

1. 写 handler（惯例：单独模块，在 action 里动态 import，保持注册廉价）。
2. 在 `src/main.tsx` **子命令注册区**（print 早返回 `:4595` 之后、最终 `parseAsync` 之前），加：
   ```ts
   program
     .command('mycmd <required> [optional]')
     .description('...')
     .option('--flag', '...')
     .action(async (required, optional, options) => {
       const { myHandler } = await import('../cli/handlers/mycmd.js')
       await myHandler(...)
     })
   ```
   命令组：`const g = program.command('mycmd'); g.command('sub')...`。
3. 需要渲染界面则学 `doctor`/`login`：`createRoot(getBaseRenderOptions(false))` 再传 `root`（`main.tsx:5244-5248`）。
4. 若要**绕过完整 CLI bootstrap**（性能/CI），改在 `cli.tsx` main() 加快速路径分支（仿 `daemon`/`job`），按需 `feature('...')` gate。
5. ⚠️ **不要**为 Commander 子命令碰 `src/commands.ts`（那是 slash 命令）。

## 添加 slash 命令（REPL 内 `/name`）

位置：`src/commands/<name>/index.ts`（元数据 + 懒加载 `load()`），中央注册在 `src/commands.ts`。契约 `Command`（`src/types/command.ts:219`）。

三种 kind（`type` 判别）：
- `type: 'local'` — 返回 `{type:'text'|'compact'|'skip'}`，模块导出 `call`。例 `src/commands/clear/clear.ts`。
- `type: 'local-jsx'` — 渲染 Ink UI，`call` 返回 `ReactNode`。例 `src/commands/help/`。
- `type: 'prompt'` — 展开成模型 prompt（`getPromptForCommand()`）。

元数据形状（`clear/index.ts`）：
```ts
const clear = {
  type: 'local', name: 'clear', description: '...',
  aliases: ['reset', 'new'],
  supportsNonInteractive: false,
  load: () => import('./clear.js'),   // 懒加载，保持启动廉价
} satisfies Command
export default clear
```
可选 `CommandBase` 字段（`command.ts:177-217`）：`isEnabled?()`、`isHidden`、`availability`（`'claude-ai'|'console'`）、`bridgeSafe`、`userInvocable`、`argumentHint`、`immediate` 等。

**步骤**：
1. 建 `src/commands/mycmd/index.ts`（`satisfies Command`，`load: () => import('./mycmd.js')`）。
2. 建 `src/commands/mycmd/mycmd.ts(x)` 导出 `call`。
3. 在 `src/commands.ts`：顶部 `import mycmd from './commands/mycmd/index.js'`，加入 `COMMANDS()` memoized 数组（`commands.ts:297`）。
4. 运行时经 `loadAllCommands`（`:536`）→ `getCommands(cwd)`（`:563`）合并 skills/plugin/workflow 命令后过滤。

## 陷阱

- `performanceShim` import 必须第一（`cli.tsx:5`）。
- ablation-baseline env 写在 `cli.tsx` 而非 `init.ts`——工具在 import 时把 env 抓进模块级常量，`init()` 太晚（`cli.tsx:51-54`）。
- `--daemon-worker` 快速路径必须先于 `daemon` 子命令检查。
- `--bare` 在 `cli.tsx:348` 与 action `main.tsx:1440` **两处**都设 `CLAUDE_CODE_SIMPLE=1`——早设是为了让 gate 在 Commander 选项构建时就生效。
- **Print 模式跳过子命令注册**——新子命令在 `-p` 下不可达，这是有意的（cc:// URL 除外）。
- `init()` memoized，仅经 preAction hook 跑；`--help` 与 cli.tsx 快速路径不跑它（需要 config 时它们直接 `enableConfigs()`）。
- slash 命令 `index.ts` 必须**仅元数据 + 懒 `load()`**，重 import 会拖慢启动。
- `USER_TYPE === 'ant' && !IS_DEMO` 才追加内部专用 slash 命令（`INTERNAL_ONLY_COMMANDS`，`commands.ts:~428`）；部分 Commander 子命令描述里标 `[ANT-ONLY]`。
