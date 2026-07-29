# verificationMode 三档持久化设置（设计草案，未实现）

> 状态：**未实现 / 优先级 P2**。本文件是设计记录，等改动 1（契约措辞风险导向化）跑一段时间、确认默认 `risk-aware` 行为不够用时再落地。

## 背景

`verification` 子代理是单笔最大的 token 黑洞（约 60k Opus/次）——它 `model: 'inherit'` 跑主会话模型（Opus），并独立重跑整套 build / test / lint，工具输出在其上下文里累积。

触发它的契约注入在 `src/constants/prompts.ts` 的 `getSessionSpecificGuidanceSection()`（约 374–380 行），受三重门控：

```
hasAgentTool
  && feature('VERIFICATION_AGENT')
  && getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false)  // 3P 默认 false，ant-only A/B
  && !isPoorModeActive()                                                // /poor 整段关闭
```

**改动 1（已落地）** 把契约里的触发判据从"3+ 文件"这种粗计数改成风险导向（机械/replay 类改动 precheck 绿则跳过；净新增逻辑/后端/安全才验），并要求"真要验时给窄简报、别重跑全套"。

**本设置（改动 3）** 在此之上再提供一个比 `/poor` 更细的**显式总档位**，让维护者按 project / 场景固定校验策略。

## 档位语义

| 档位 | 行为 |
|---|---|
| `off` | 完全不注入校验契约（等价于 `/poor` 的 verification 部分，但独立可控、不牵连 extract_memories 等其他 `/poor` 行为） |
| `risk-aware`（默认） | 注入改动 1 的风险导向契约——由模型按判据自行决定跳过 / 窄简报验证 |
| `always` | 注入改动 1 之前的一刀切契约（任何非平凡改动都强制 spawn 校验），用于高风险 repo |

## 实现要点

1. **持久化**：仿 `src/commands/poor/poorMode.ts` 的模式——模块级缓存 `let mode: VerificationMode | null = null`，首次调用时 `getInitialSettings().verificationMode`，写入走 `updateSettingsForSource('userSettings', { verificationMode })`。持久化到 settings.json，跨会话生效。
2. **接入点**：`prompts.ts` 约 374 行那个三元分支，改为按 `getVerificationMode()` 选注入哪一版契约字符串（`off` → null、`risk-aware` → 改动 1 文本、`always` → 旧一刀切文本）。
3. **缓存安全**：该设置整场会话只读一次，选中的契约字符串会话内固定；且这段 guidance 位于 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 之后，不会裂变 `cacheScope:'global'` 的前缀 hash（参见 `prompts.ts` 函数头注释）。**不得**做成"按本轮动态变"的文本，否则击穿缓存。
4. **可选入口**：斜杠命令（如 `/verify-mode <off|risk-aware|always>`）或并入现有 Config UI；MVP 阶段仅读 settings.json 即可。

## 为什么排 P2（暂缓）

- 改动 1 落地后，默认行为已经是 `risk-aware`；`always` = 现状、`off` ≈ `/poor` 已覆盖的那半。本设置的**增量**只是"显式三档 + 命名 + 持久化"。
- 成本比改动 1 大一个量级（新增设置项 + 读取函数 + 门控分支 + 可能的命令入口 + 测试），并新增一个长期维护的配置面。
- 结论：先让默认 `risk-aware` 跑一阵；若确实出现"某些 repo 想强制 `always`"或"想独立于 `/poor` 关校验"的需求，再落地。

## 依赖 / 注意

- 契约仅在 `tengu_hive_evidence` A/B 门控解析为 `true` 时才注入；该 gate 若关闭，本设置也无从生效。
- 与 `/poor` 的关系：`/poor` 是"省 token 总闸"（同时跳过 extract_memories、prompt_suggestion、verification 等）；本设置只管 verification 一项，粒度更细、可正交组合。
