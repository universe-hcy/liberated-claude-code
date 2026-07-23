# 09 · 测试规范

> 权威来源：`CLAUDE.md` 的 Testing 段 + `docs/testing-spec.md`。本文是开发时的操作速查。

## 职责与框架

- **框架**：`bun:test`（内置断言 + `mock`）。不是 Jest/Vitest。
- **类型门槛**：TypeScript strict，`tsc --noEmit` 必须零错误。
- **总入口**：`bun run precheck` = `typecheck` + `biome check:fix` + `bun test`，**任务完成后必须零错误通过**。

## 测试放置约定

| 类型 | 位置 | 命名 |
|------|------|------|
| 单元测试 | 就近 `src/**/__tests__/` | `<module>.test.ts` |
| 集成测试 | `tests/integration/` | 6 个文件（cli-arguments, context-build, message-pipeline, tool-chain, autonomy-lifecycle-user-flow, dependency-overrides） |
| 共享 mock/fixture | `tests/mocks/` | api-responses, file-system, fixtures/ |
| 包测试 | 各 `packages/*/` 内 | 独立测试（如 `color-diff-napi` 11 tests） |

命名：`describe("functionName")` + `test("behavior description")`，用英文。

## Mock 使用规范（重点）

**核心原则：只 mock 有副作用的依赖链，不 mock 纯函数/纯数据模块。**

必须 mock 的模块（有模块级副作用，如 `realpathSync`/`randomUUID`）：
`log.ts`、`debug.ts`、`bun:bundle`、`settings/settings.js`、`config.ts`、`auth.ts`、第三方网络库。

`log.ts` / `debug.ts` 用**共享 mock**，不要在测试文件里内联：

```ts
import { logMock } from "../../../tests/mocks/log";
mock.module("src/utils/log.ts", logMock);

import { debugMock } from "../../../../tests/mocks/debug";
mock.module("src/utils/debug.ts", debugMock);
```

**不要 mock**：纯函数模块（`errors.ts`、`stringUtils.js`）、mock 值与真实实现相同的模块、mock 路径与实际 import 不匹配的模块。

路径规则：统一 `.ts` 扩展名 + `src/*` 别名路径，禁止双重 mock 同一模块。

## ⚠️ 跨文件 mock 污染（最容易踩的坑）

**Bun 的 `mock.module` 是进程全局的（last-write-wins），不是 per-file 隔离的。** 一个测试文件的 `mock.module` 会污染同进程中所有其它测试文件的 `require`/`import`。

实测事实（Bun 1.x）：
- 测试文件执行顺序**不是**严格字母序，别假设 A 在 B 之前跑。
- `beforeAll` 里调用的 `mock.module` **不会**被 hoist，但仍污染后续加载的文件。
- `require()` 和 `import()` 共享同一模块注册表，`mock.module` 对两者都生效。
- 模块一旦被某文件替换，后续所有 `require`/`import`（即使不同 specifier 路径解析到同一模块）都返回 mock 值。

**核心规则：不要 mock 被测模块的上层业务模块。**

❌ 错误（污染同目录 `api.test.ts`）：
```ts
mock.module('src/commands/schedule/triggersApi.js', () => ({ listTriggers: ... }))
```

✅ 正确（mock 底层 HTTP 层）：参考 `launchSkillStore.test.ts`、`launchVault.test.ts`：
```ts
import { setupAxiosMock } from '../../../../tests/mocks/axios.js'
const axiosHandle = setupAxiosMock()
axiosHandle.stubs.get = axiosGetMock
beforeAll(() => { axiosHandle.useStubs = true })
afterAll(() => { axiosHandle.useStubs = false })
```

**判断标准**：同目录若同时有 `launch*.test.ts`（集成）和 `api.test.ts`（回归），则 `launch*.test.ts` 必须 mock axios 而非源 API 模块——否则 `api.test.ts` 无法测真实 HTTP 逻辑。

**排查污染步骤**：
1. 单独跑可疑文件确认通过：`bun test path/to/suspect.test.ts`
2. 与同目录一起跑定位污染源：`bun test path/to/__tests__/`
3. 各加 `console.error('[file] milestone')` 追踪真实执行顺序
4. 检查 `mock.module` specifier 是否与同目录其它测试的 import 解析到同一模块

## 类型规范（测试相关）

- 生产代码禁 `as any`；**测试文件的 mock 数据可用 `as any`**。
- 类型不匹配优先 `as unknown as SpecificType` 双重断言。
- 未知结构对象用 `Record<string, unknown>` 而非 `any`。

## 常用命令

```bash
bun test                                 # 全部
bun test src/utils/__tests__/hash.test.ts  # 单文件
bun test src/commands/schedule/__tests__/  # 单目录（排查污染用）
bun test --coverage                      # 覆盖率
bun run precheck                         # 完整门禁（必过）
```
