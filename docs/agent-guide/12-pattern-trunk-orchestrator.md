# 12 · 设计方案：主干编排 + 阶段 worker + primitive 自适应选择

> 关键前提：`src/coordinator/`（coordinator 模式，本模式的现成骨架）、`packages/builtin-tools/src/tools/AgentTool/`（spawn 接口 + `runAgent`）、`TaskOutputTool`（`block:true` 同步等结果）、`SendMessageTool`（续用 worker 上下文）、`.claude/agents/*.md`（自定义 worker 定义，`loadAgentsDir.ts:542`）、`forkedAgent.ts`（cache-safe fork）。机制背景见 [11-agents-fork-subagent.md](./11-agents-fork-subagent.md)。
>
> **本文性质**：这是一份**设计方案**。§1–§2 的现成能力可直接用；§3–§5 的选择规则/enforcement 是**提出的设计，尚未在代码库实现**，落地时需自行搭建（可挂在 AgentTool 的 spawn 路径上）。

## 阅读地图

- 只想快速跑起来 → 直接看 [§6 三档落地路径](#6-三档落地路径按投入递增)。
- 想理解"fork 还是 subagent 怎么选" → [§2 成本模型](#2-两个-primitive-的成本与-2×2-决策) → [§4 选择规则](#4-选择规则与-enforcement)。
- 想知道"谁来决定、怎么 enforce" → [§3 谁决定](#3-谁来决定模型-vs-harness) + [§4](#4-选择规则与-enforcement)。

---

## 1. 目标与总体形态

长流程任务里，让**主干 agent 只做编排**：它持有一条干净的 backbone（`plan` + 各阶段**已验收**摘要 + 集成状态），把每个阶段的脏活（探索、实现、沿路调试的死胡同）压进**隔离的 worker**；worker 跑完只回传一段结构化结果。主干工作路径始终高海拔、不被噪音污染 —— 这是对抗长任务 context rot 的核心手段。

```
主干（orchestrator + integrator + 验收闸门）
  持有: plan + 各阶段【已验收】摘要 + 集成状态。别的都不留。
  循环 每个阶段:
    ├─ 起草该阶段 handoff（此刻决定用哪种 primitive，见 §3–§4）
    ├─ spawn worker（fork 或 subagent）
    ├─ 等结果（TaskOutput block:true / <task-notification>）
    ├─ 验收闸门（§7）: 达标→并入 backbone; 不达标→打回重派
    └─ 越界待办喂回 plan 调度
```

**这不是银弹**：它用 token / 延迟 / 协调复杂度 / handoff 信息损耗风险，换"上下文不膨胀 + 可并行 + 可隔离"。短任务、能塞进单上下文的任务、阶段切不干净的任务、需密集全局回溯的任务 —— 单体 agent 全面更优。适用边界见 [§8](#8-代价与不适用场景)。

---

## 2. 两个 primitive 的成本与 2×2 决策

每个阶段有两种 spawn primitive（机制详见 [11](./11-agents-fork-subagent.md)）：

| primitive | 上下文来源 | 一句话 |
|---|---|---|
| **fork** | 继承父整段对话（字节级，命中父 prompt cache） | worker 什么都知道，但拖着全历史 |
| **subagent** | 全新隔离上下文 + 主干写的策展 handoff | worker 只知该知道的，干净但要写 handoff |

### 2.1 成本公式（阈值从这里反推，不靠拍脑袋）

读价 ≈ 输入 10%，5m 冷写 ≈ 125%，输出 ≈ 5× 输入。近似每次 spawn：

```
fork      ≈ d_out(极短指令) + P × (热?0.1 : 1.25) × T          + worker 自己的新 token
subagent  ≈ H_out(生成 handoff 的输出,≈5×) + [S_sys(同类缓存) + H(输入) + reReads] + worker 自己的新 token
```

- `P` = 父上下文 token 数；`T` = worker 的 turn 数；`H` = handoff 大小；`S_sys` = 系统提示（同类 worker 第二个起走 cache）。
- 关键项对比：**fork 的重读税 `P×0.1×T`(热) vs subagent 的 handoff 成本 `H_out`**。
- 代入现实（P≈100k，H≈几 k）：`T=1` 打平；`T=3` fork 已亏；`T=20`（长实现）fork 巨亏。
- **例外**：当阶段**真需要几乎全部父上下文**时 `H → P`，subagent 压不小上下文、handoff 逼近"全文摘要"，此时 fork（缓存）反超。

### 2.2 于是规则塌缩成一张 2×2

|  | **需要少量上下文**（H 小） | **需要几乎全部上下文**（H≈P） |
|---|---|---|
| **少 turn（1–3）** | subagent（小 handoff） | **fork ✓**（且需 cache 热） |
| **多 turn（>3）** | subagent（策展 handoff） | subagent，或 **fork 读→subagent 写**（§5.3） |

**只有一格是 fork**：`少 turn ∧ 高上下文依赖 ∧ cache 热 ∧ 装得下窗口`。其余全 subagent。全部复杂度就是"如何可靠地判定这一格"，见 §4。

### 2.3 handoff 生成成本 = 横轴的成因（重要）

`H_out` 是 subagent 侧一笔真金白银（输出 token），但**它不是"总结整段上下文"**：

- **读是沉没的**：写 handoff 的是主干，它本就常驻持有全上下文、每 turn 都在处理它；新增的只有生成那几 k 输出。
- **handoff 是索引不是复述**：给 worker `相关文件 file:line + 决策引用 + 成功判据`，让它在自己上下文里**自己 Read**，而不是把文件内容重叙一遍。
- **摊销**：`decisions.md`/`plan.md` scratchpad 是攒下来的 handoff 素材，写一次引用多次；验收闸门消化上一阶段的 digest 恰好是下一阶段 handoff 的原料。

而 `H_out` 的大小**随上下文依赖度上升** —— 这正是 2×2 横轴的机制。于是得到一条极好用的操作信号：

> **当 handoff 草稿开始膨胀成"整段上下文摘要"时 —— 停。这就是 fork 的触发信号。** 详见 §4.3。

---

## 3. 谁来决定：模型 vs harness

**结论：绝大部分归 harness；只从模型抽取一个不可约的语义位，且刻意不把"fork vs subagent"做成模型可见的裸参数。** 因为三个决定变量的可观测性天差地别：

| 变量 | 谁知道 | 为什么 |
|---|---|---|
| 上下文依赖度 `H` | 模型（粗）→ **author 时变可测**（见下） | 语义/意图，harness 事前读不出 |
| cache 热度 / TTL | **harness**（精确） | 距父上次请求多久、ephemeral 标记（usage 里有 `cache_creation.ephemeral_1h_*`） |
| 窗口压力 `P/W` | **harness**（精确） | token 数 harness 一清二楚 |
| turn 数 `T` | **harness 观测 + 钳制**（§4.2） | 只有跑起来才知道；用 `maxTurns` 钳住而非预测 |
| 递归/模式互斥/隔离/并行时机 | **harness** | 机械不变量（`isInForkChild`、coordinator 互斥等） |

**核心设计原则**：别让模型推理 cache 经济学（TTL、token 账、读写价 —— 二阶运维推理它不可靠）。让**模型说 WHAT**（任务性质 + 起草 handoff，它擅长），**harness 决定 HOW**（量草稿 + 机械态 → 路由 primitive），并能**运行时推翻**模型粗估。

**决策推迟到 author-time（关键洞察）**：`H` 事前是隐藏语义变量，但**在模型起草 handoff 的那一刻，它就等于草稿的 token 数** —— 变成可测量。所以最优决策点不是 spawn 时（靠先验猜），而是 authoring 时（H 已摆在眼前）。这让"要不要 fork"成为模型**本就要做的事**（写 scoped 简报）的副产品，模型全程没在算 cache。

**现成旁证**（codebase 已在用这套哲学）：
- `getAutoBackgroundMs`（120s）：模型不决定"后台跑"，任务先同步起步，**harness 观测到"跑太久"再自动转后台**（`AgentTool.tsx`）—— 观测+纠正 > 预测。
- `FORK_SUBAGENT` 隐式路由：模型**省略** `subagent_type`，harness 判走 fork（`AgentTool.tsx:414`）；模型从不显式点名 fork。
- `forceAsync`：fork 实验一开，所有 spawn 被 harness 强制异步，不看模型意愿。

---

## 4. 选择规则与 enforcement

> 以下是**提出的设计**（未实现）。可作为一个"primitive router"挂在 AgentTool spawn 路径上：接收模型起草的 handoff 草稿 + 任务性质，输出 primitive + 参数。

### 4.1 门序列（带默认值，全部可调）

harness 按顺序过门，任一不满足即 subagent：

```
硬门（机械，不可谈）:
  G1 已在 fork child 内            → subagent   [复用 isInForkChild]
  G2 coordinator 模式             → worker subagent（fork 互斥，forkSubagent.ts:34）
  G3 任务性质 == 长实现/写         → subagent（fork 在此必亏）
  G4 需要并行写文件               → subagent + worktree（isolation）

热度门:
  G5 age > 0.8 × TTL             → subagent
     TTL: 5m cache=300s→阈值240s; 买了 1h ephemeral=3600s→阈值2880s

窗口门:
  G6 P > 0.40 × W               → subagent
     （fork worker 从 P 起步，得留 ≥60% 干活空间）

依赖门（author-time 测量，§4.3）:
  G7 handoff 草稿膨胀（H_draft > 0.30·P 或超绝对阈值）→ fork
     否则                                          → subagent（默认）

全过 fork 条件 → fork；若同一决策点有 N 个并行请求 → 成批热扇出（§5.1）
```

### 4.2 别"预测" turn 数，直接"钳住"它

`T` 是主导变量，但 spawn 前谁都不知它会跑几 turn。解法不是预测，是 enforce：

> **给 fork worker 设 `maxTurns ≤ 3`（硬上限）。**（内置 `FORK_AGENT` 默认 `maxTurns:200`，`forkSubagent.ts:66`；本方案的"有界读 fork"要显式压低。）

"少 turn"从假设变约束。若任务真需要更多 turn → 它撞上限、没干完 → 这本身就是"分错格了"的信号（它其实属长实现/subagent 格）。用一次便宜失败换一次分类纠正，胜过让模型事前猜。同款哲学 = `getAutoBackgroundMs` 的 120s 自动转后台。

### 4.3 author-time 草稿测量路由（主机制）

把 G7 具体化为一个**可测量、无需信任模型判断**的 seam：

```
模型:  起草 handoff（它必须做的事）
harness: 量草稿 token 数 H_draft
         + 已知机械态（G5 热度 / G6 窗口 / maxTurns 钳制）
         路由:  H_draft 小             → 提交 subagent（用这份草稿当 handoff）
                H_draft 膨胀(>0.30·P)   → 弃草稿，改走 fork（继承即可，省掉这份昂贵总结）
```

接口物 = **handoff 草稿的大小**。连"语义轴"都被转成机械测量，harness 拿回控制权，且不必信任模型的自我判断 —— 它量草稿就行。

### 4.4 三层纠错（重心在最快的 author-time 层）

| 层 | 时机 | 代价 | 机制 |
|---|---|---|---|
| **author-time** | spawn 前 | ≈ 免费、无损 | 草稿膨胀 → 当场改 fork（§4.3）。**主机制** |
| **post-spawn** | 这一 turn | **有损**：worker 已干的活作废 + 父 cache 可能已凉→冷 fork | subagent 立刻空转/喊缺上下文 → 杀+重开或补 handoff。罕见纠错，少用 |
| **telemetry** | 跨 spawn | 后台 | 用 `tengu_fork_agent_query` 的 `cacheHitRate`/实测 T 校准阈值（§4.6） |

### 4.5 保守偏置 + 回退分界（安全的前提）

- **默认 subagent，fork 要证据确凿才给**。因为失败成本不对称：**误判成 fork** = 冷/巨/多 turn，一次烧几十万 token；**误判成 subagent** = 顶多 handoff 薄一点、重探一轮，便宜得多。边界模糊一律倒向 subagent。
- **保守之所以安全，是因为主回退在 spawn 前（author-time，无损）** —— 你不会因保守而漏掉 fork 收益，是靠"草稿膨胀就在派之前改 fork"拿到它。
- ⚠️ **别拿 post-spawn 回退当保守的依据**：一旦拖到 subagent 烧了几个 turn 再回退，父 cache 往往已冷，fork 的意义都没了，还赔了 worker 的活。所以膨胀检查必须在"提交 spawn"之前完成。

### 4.6 阈值怎么校准（用现成 telemetry）

`tengu_fork_agent_query` 已带 `cacheHitRate`/tokens/duration（`forkedAgent.ts` logForkAgentQueryEvent）。

1. 先用上面保守默认（偏 subagent）。
2. 每次 spawn 记：primitive、`P`、`age`、实测 `T`、总 token、`cacheHitRate`。
3. 校准目标：被判 fork 的 spawn，实测 `cacheHitRate > 0.7` 且 `T ≤ 3`。
   - fork 们 `cacheHitRate` 普遍低 → **G5 热度阈值收紧**（0.8→0.6×TTL）。
   - fork 们频繁超 `T=3` → **任务性质分类器错了**，更多类别划入长实现。
   - subagent 们频繁重读大量父内文件 → **G7 判太严**，放宽。

### 4.7 warmth 时钟在走

author-time 升级要**趁热**：主干若在 spawn 前磨蹭很久（长 deliberation、先干一堆别的），父 cache 在老化，升级到的 fork 就没那么热。实践中 authoring 是一个 trunk turn（秒级），没问题；但别把"决定 fork"拖过一整段冗长的主干活动。

---

## 5. 三种编排形态（primitive 选择的具体落法）

### 5.1 热扇出（fork 的主场）
决策点上需**基于当前完整上下文**同时探 N 个变体/子问题 → **立刻并发 spawn N 个 fork**（cache 正热，各命中一次读），每个短指令、干几 turn 就回。比 N 个 subagent 便宜（省去各自重建/重读），且零 handoff 损耗。典型：多方案探索、多角度验证、并行假设。**内置 `runForkedAgent` 的全部用法都是这个形态**（compact/speculation/verify —— 立刻、基于热上下文、干 1 趟）。

### 5.2 冷串行阶段（subagent 的主场）
plan 切出的顺序阶段：隔时间派、各干很久、各只要一个切片 → fork 是陷阱（冷 cache 全价重写 + 拖巨大上下文 + 多 turn 重读）。策展 handoff 的 subagent 胜。旁证：`FORK_SUBAGENT`（用 fork 跑实现）被**禁用**，注解"普通 Agent tool 已等效覆盖" —— 长实现正是 fork 的反甜点区。

### 5.3 fork 读 → subagent 写（组合拳，解 handoff 损耗）
当 `H → P`（高依赖、难蒸馏，即 G7 触发但又要 worker 上下文小）：
- **fork 一个"分析员"**：热 cache 读全上下文，产出"实现阶段 K 的策展简报"（1–2 turn，便宜，因看得到全部所以**无损**）。
- **把简报喂给 fresh subagent 去长实现**：小上下文、注意力集中。

适用条件精确 = **`H_out` 高的时候**。注意：主干自己也持有热的全上下文，多数时候**主干直接写简报即可，不必真 fork 一个分析员**；只有想**并行**为多阶段生成简报、或想**卸载**这份 synthesis 免撑大主干 turn 时，才值得用 fork 分析员。

---

## 6. 三档落地路径（按投入递增）

### 档 0 · 零改造，直接用 coordinator 模式（先试）
`src/coordinator/` 已把本模式做成内置能力。启用：① build/dev 开 `COORDINATOR_MODE` feature；② 运行时 `CLAUDE_CODE_COORDINATOR_MODE=1`（`coordinatorMode.ts:36`）。得到：
- 主 agent 变纯 coordinator（只剩 `COORDINATOR_MODE_ALLOWED_TOOLS`：Agent/TaskStop/SendMessage/SyntheticOutput，`constants/tools.ts:124`），天然被迫编排。
- 只有 `worker` 一种 subagent（`workerAgent.ts`，全新上下文 + `ASYNC_AGENT_ALLOWED_TOOLS`）。
- 所有 spawn 强制异步，结果走 `<task-notification>`（`query.ts:1869` 按 `agentId` 精确投递）。
- coordinator 系统提示自带 Task Workflow 阶段表 + synthesis-by-coordinator 纪律；`SendMessage({to,message})` 续用已完成 worker 的上下文。

> 局限：与 `FORK_SUBAGENT` 互斥（用不了 fork 形态）；偏"多 worker 并行研究"，你的"串行阶段 + 强验收 + §4 自适应选择"需靠下面两档补齐。

### 档 1 · 轻量搭建：自定义 phase-worker + 验收协议 + scratchpad（推荐落地形态）
普通 REPL 主 agent + 一个自定义 worker 定义。

**a) `.claude/agents/phase-worker.md`**（字段解析 `loadAgentsDir.ts:542`，支持 `name`/`description`/`model`/`tools`/`permissionMode`/`isolation`/`background`/`effort`/`memory`）：

```markdown
---
name: phase-worker
description: 执行 plan 中单个阶段的隔离 worker——研究+实现+自验证，只回传结构化结果。
model: inherit
permissionMode: acceptEdits
# isolation: worktree   # 需要并行或防污染主干工作树时再开
---

你是主干编排 agent 派出的**阶段 worker**。在**隔离上下文**里独立完成 prompt 描述的**单个阶段**，然后只回传一段结构化结果。

纪律：
- 严格待在本阶段 scope 内。发现越界问题**不要顺手改**——记进"越界待办"回传，主干统一调度。
- 用工具直接干：读码、搜索、改文件、跑测试。别闲聊、别在工具调用间输出解说。
- **改完必须自验证**（跑测试 / 复现修复 / 满足给定成功判据），失败就在自己上下文里反复修，直到达标或确认卡死。
- 改了文件就 commit，报告带 commit hash。
- 报告 ≤400 词，纯文本标签，以 `Scope:` 开头：

  Scope: <一句话回述本阶段范围>
  Result: <达成了什么 / 关键发现>
  Verification: <怎么验证的、结果>
  Files changed: <路径 + commit hash；没改则 none>
  Out-of-scope TODO: <越界问题；没有则 none>
  Blocked: <卡死原因；没有则 none>
```

**b) 策展 handoff 模板**（subagent 的成本项，必须写好；也是 §4.3 measure 的对象）：

```
[阶段目标] <本阶段要达成什么>
[Scope 边界] 只做 X；不要碰 Y（Y 由别的阶段负责）
[相关文件] <file:line 锚点清单——省得 worker 重新全库搜>
[已定决策/约束] <从 decisions.md 摘相关几条>
[成功判据] <客观、可验证：哪个测试绿 / 什么命令输出什么 / 什么行为可复现>
[交付格式] 按 phase-worker 报告格式回传
```

**c) scratchpad 决策日志**：主干和 worker 都读写 `plan.md`/`decisions.md`（工作区或 scratchpad 目录）。**用文件传跨阶段知识，而非靠对话继承** —— 解耦 handoff 与上下文机制，可控可审计，且是 handoff 素材的摊销来源。coordinator 模式已内置类似约定（`getCoordinatorUserContext` 的 scratchpadDir）。

### 档 2 · 确定性重复执行：Workflow 脚本
若这类长任务要可重复、可 resume，把阶段循环写成 Workflow 脚本（需用户显式 opt-in）：`pipeline(阶段们, 执行阶段, 验证阶段, 集成阶段)` —— 每阶段独立流过三段，天然"执行→验收→并入"。verify 阶段用独立 agent 对着成功判据判定，`schema` 强制结构化返回。适合把档 1 的人工协议固化成脚本。

---

## 7. 验收闸门（三档通用，信任基石）

worker 自我报告会**偏乐观**，不能直接采信。每阶段必须过闸：

1. **客观判据优先**：handoff 给的"成功判据"要可机器验证；主干收到报告后**自己或再派只读 verifier**去核（跑测试 / `git diff` / 复现行为），而非信 `Result` 的措辞。
2. **复用现成能力**：内置 **verification-agent**（`built-in/verificationAgent.ts`，`feature('VERIFICATION_AGENT')`，端到端真跑）当独立验收员；**handoff 分类器** `classifyHandoffIfNeeded`（`agentToolUtils.ts`）在 worker 没干完时给主干发警告，异步完成时自动挂在 `<task-notification>` 前 —— **别忽略它**。
3. **终止条件**：worker 内部"反复修"必须有客观成功判据兜底；主干侧设**重派上限**（同阶段打回 ≤2 次仍不达标 → 升级为主干介入或改 plan），否则子树无限打转。

---

## 8. 代价与不适用场景

编排是拿"一个无限膨胀的上下文"换"多个有界上下文 + 协调开销"。按疼痛排序的代价：

1. **Token**：多在上下文重复（N 份系统提示不共享 cache）、验收 pass、打回重做、主干编排 turn。省在主干限高 + worker 脏活跑完即弃。**短任务纯亏；长而脏的任务可能持平甚至更省**，即便更贵也换来质量。
2. **延迟（常比 token 更疼）**：串行阶段延迟之和 + spawn/通知往返 + worktree 建拆 + 验收串行。单体一路往下没有这些。
3. **handoff 信息损耗（质量杀手）**：fresh worker 只知你写进 handoff 的；漏一条就瞎撞/重探/错假设，多阶段累积如传话游戏。单体从无此问题。
4. **编排失败面**：分解错了全错（主干单点判断）、跨阶段问题被孤立、并行合并冲突、信任乐观报告。
5. **丧失全局回溯**：各阶段结果已 commit/已验收，回溯昂贵，易陷局部最优。
6. **复杂度/可调试性**：更多活动部件（task 注册、通知、scratchpad、worktree），work 散在 N 个 sidechain transcript。

**不值得**：短任务、能塞进单上下文、阶段切不干净、需密集全局回溯 —— 单体在成本/延迟/质量全面胜出。
**值得**：真会撑爆上下文窗口的长任务、有独立可并行子任务（墙钟收益）、需隔离跑高风险改动、要可重复自动化的流水线。

---

## 9. 失败模式与对策

| 风险 | 症状 | 对策 |
|---|---|---|
| 跨阶段修复归属不清 | worker 顺手改别阶段的东西/漏改 | phase-worker 纪律禁越界改，只回传 `Out-of-scope TODO`，主干统一调度 |
| 集成/合并成本 | 并行 worker 改同一文件冲突 | 默认**串行**；需并行则每 worker `isolation:"worktree"`，主干合并（`hasWorktreeChanges`→保留有改动的树） |
| handoff 遗漏 | worker 缺上下文瞎撞/重探 | handoff 模板"相关文件+已定决策"必填；草稿膨胀→按 §4.3 改 fork |
| 主干被卷脏 | worker transcript 卷回主干 | 主干只吸 ≤400 词结构化摘要 + 文件清单；中间过程永留子树 |
| 验收信任 | 信了乐观报告，缺陷流入下阶段 | 客观成功判据 + 独立 verifier + 不忽略 handoff 警告 |
| worker 无限打转 | 无客观终止条件 | 每阶段客观判据 + 主干侧重派上限 |
| **误判成 fork（贵）** | 冷/巨/多 turn，一次烧几十万 token | 保守偏置（§4.5）+ author-time 草稿测量 + `maxTurns≤3` 钳制 |

---

## 10. 落地检查清单

- [ ] 选档：先 **档 0 coordinator** 探感觉 → 要串行/强验收/自适应选择上 **档 1** → 要可重复固化为 **档 2 Workflow**。
- [ ] plan 阶段切分：每阶段 **scope 干净、可独立验证、依赖显式**（切不干净是本模式头号死因）。
- [ ] 写 `.claude/agents/phase-worker.md`（档 1）。
- [ ] 约定 `plan.md`/`decisions.md` scratchpad 位置。
- [ ] 每次 spawn：主干**起草 handoff → 量草稿大小 → 路由 primitive**（§4.3）；默认 subagent，草稿膨胀才 fork。
- [ ] fork worker 设 `maxTurns ≤ 3`；长实现一律 subagent。
- [ ] 每阶段过**验收闸门**（客观判据 / 独立 verifier / 不忽略 handoff 警告）。
- [ ] 定**重派上限**与升级路径。
- [ ] 接 telemetry（`tengu_fork_agent_query.cacheHitRate`）校准 §4.1 阈值。

---

## 11. 陷阱

- **fork/subagent 别在 spawn 时预测，在 author-time 决定**：`H` 那一刻才从语义变量变成可测的草稿大小。
- **保守偏置的安全前提是 spawn 前回退**：post-spawn 杀+重开是有损且常冷 cache 的罕见纠错，不能当依据（§4.5）。
- **别让模型算 cache 经济学**：模型说任务性质 + 起草 handoff，harness 量草稿 + 机械态路由。
- **coordinator 与 FORK_SUBAGENT 互斥**：档 0 下 fork 形态不可用。
- **`<task-notification>` 是系统事件不是用户输入**：主干别当用户确认；按 `agentId` 定向投递。
- **异步 worker 用独立 abort controller**：主干 ESC 不杀后台 worker，需 `TaskStop`/`chat:killAgents`。
- **成功判据要客观**："看起来对了"不能作闸门 —— 必须是测试绿 / 命令输出 / 可复现行为。
- **`feature()` 只能放 `if`/三元条件位**（Bun 编译器限制）——涉及的 `COORDINATOR_MODE`/`FORK_SUBAGENT` 等 gate 别赋值给变量或塞 `&&` 链。
