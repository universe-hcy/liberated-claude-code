# Agent 编排设计方案：主干 + 阶段 worker + fork/subagent 自适应选择

> 这是一份**可移植的设计方案**（与具体 harness 解耦），回答"长流程任务里如何用多 agent 编排出更好效果，以及每个子任务该用 fork 还是普通 subagent"。
>
> 本仓库的**落地配方**（coordinator 模式 / 自定义 worker / Workflow 三档 + `file:line` 锚点）见 [`docs/agent-guide/12-pattern-trunk-orchestrator.md`](./docs/agent-guide/12-pattern-trunk-orchestrator.md)；两种 primitive 的底层机制见 [`docs/agent-guide/11-agents-fork-subagent.md`](./docs/agent-guide/11-agents-fork-subagent.md)。本文聚焦"为什么这么设计"。
>
> **状态**：§1–§2 有现成能力印证；§3–§5 是提出的设计规则，尚未实现。

---

## 1. 问题与总体形态

长流程任务里，单体 agent 的上下文会无限膨胀 → 每 turn 重发全量、注意力被历史噪音稀释（context rot）→ 后期质量下滑。

**形态**：让**主干 agent 只做编排**——持有一条干净 backbone（`plan` + 各阶段**已验收**摘要 + 集成状态），把每个阶段的脏活（探索、实现、沿路调试的死胡同）压进**隔离的 worker**；worker 跑完只回传一段结构化结果。主干始终高海拔、不被噪音污染。

```
主干（orchestrator + integrator + 验收闸门）
  持有: plan + 各阶段【已验收】摘要 + 集成状态。别的都不留。
  循环 每个阶段:
    ├─ 起草该阶段 handoff（此刻决定用哪种 primitive，见 §3–§4）
    ├─ spawn worker（fork 或 subagent）
    ├─ 等结果
    ├─ 验收闸门（§6）: 达标→并入 backbone; 不达标→打回重派
    └─ 越界待办喂回 plan 调度
```

**这不是银弹**。它用 token / 延迟 / 协调复杂度 / handoff 信息损耗风险，换"上下文不膨胀 + 可并行 + 可隔离"。适用边界见 §7。

---

## 2. 两个 primitive 与选择的本质

| primitive | 上下文来源 | 一句话 |
|---|---|---|
| **fork** | 继承父整段对话（字节级，命中父 prompt cache） | worker 什么都知道，但拖着全历史 |
| **subagent** | 全新隔离上下文 + 主干写的策展 handoff | worker 只知该知道的，干净但要写 handoff |

### 2.1 澄清"fork 能 cache 上下文"

fork 让父对话成为一次 **cache read**（约输入 10%），而非全价重写。但三个"没买到"：

1. **便宜 ≠ 免费，更 ≠ 无负担**。worker 仍**携带并每轮重新处理**整段上下文；cache 省的是输入价，**占满上下文窗口 + 稀释注意力**这两项一分没省。
2. **cache 有 TTL**（默认 5min，ephemeral 最长 1h）。fork **只有在父前缀还热时 spawn 才命中**；串行阶段隔久了派 → 父上下文凉了 → fork **全价重写整段历史**，优势归零。
3. **重读税随 turn 数累积**：worker 跑 T 个 turn，就把父前缀重发 T 次（热则 cache-read 价）。

### 2.2 成本公式（阈值从这里反推）

读价 ≈ 输入 10%，5m 冷写 ≈ 125%，输出 ≈ 5× 输入：

```
fork      ≈ d_out(极短指令) + P × (热?0.1 : 1.25) × T          + worker 新 token
subagent  ≈ H_out(生成 handoff,≈5×) + [S_sys(同类缓存) + H(输入) + reReads] + worker 新 token
```

`P`=父上下文 token；`T`=worker turn 数；`H`=handoff 大小。关键对比 = **fork 重读税 `P×0.1×T`(热) vs subagent 的 `H_out`**。代入 P≈100k：`T=1` 打平、`T=3` fork 已亏、`T=20`（长实现）巨亏。**例外**：阶段真需要几乎全部上下文时 `H→P`，subagent 压不小、handoff 逼近"全文摘要"，此时 fork 反超。

### 2.3 决策塌缩成 2×2

|  | **需要少量上下文**（H 小） | **需要几乎全部上下文**（H≈P） |
|---|---|---|
| **少 turn（1–3）** | subagent（小 handoff） | **fork ✓**（且需 cache 热） |
| **多 turn（>3）** | subagent（策展 handoff） | subagent，或 **fork 读→subagent 写**（§5.3） |

**只有一格是 fork**：`少 turn ∧ 高上下文依赖 ∧ cache 热 ∧ 装得下窗口`。其余全 subagent。

### 2.4 handoff 生成成本 = 横轴成因

`H_out` 是 subagent 侧真金白银，但**不是"总结整段上下文"**：读是沉没的（主干本就持有全上下文）；handoff 是**索引不是复述**（给 `file:line` + 决策引用 + 成功判据，让 worker 自己 Read）；且经 scratchpad/验收 digest **摊销**。而 `H_out` 随上下文依赖度上升——正是 2×2 横轴的机制。由此得到操作信号：

> **当 handoff 草稿开始膨胀成"整段上下文摘要"时——停。这就是 fork 的触发信号。**（§4.3 把它做成可测量的路由。）

---

## 3. 谁来决定：模型 vs harness

**结论：绝大部分归 harness；只从模型抽一个不可约的语义位，且刻意不把"fork vs subagent"做成模型可见的裸参数。** 三个决定变量可观测性天差地别：

| 变量 | 谁知道 | 为什么 |
|---|---|---|
| 上下文依赖度 `H` | 模型（粗）→ **author 时变可测** | 语义/意图，harness 事前读不出 |
| cache 热度 / TTL | **harness**（精确） | 距父上次请求多久、ephemeral 标记 |
| 窗口压力 `P/W` | **harness**（精确） | token 数确定可知 |
| turn 数 `T` | **harness 观测 + 钳制** | 只有跑起来才知道；用 `maxTurns` 钳住而非预测 |
| 递归/模式互斥/隔离/并行时机 | **harness** | 机械不变量 |

**原则**：别让模型推理 cache 经济学（TTL、token 账、读写价——二阶运维推理它不可靠）。**模型说 WHAT**（任务性质 + 起草 handoff，它擅长），**harness 决定 HOW**（量草稿 + 机械态 → 路由），并能**运行时推翻**模型粗估。

**核心洞察——决策推迟到 author-time**：`H` 事前是隐藏语义变量，但**在模型起草 handoff 那一刻，它 = 草稿 token 数**，变成可测量。于是"要不要 fork"成为模型**本就要做的事**（写 scoped 简报）的副产品，模型全程没在算 cache。

---

## 4. 选择规则与 enforcement（提出的设计）

可作为一个 "primitive router" 挂在 spawn 路径上：接收模型起草的 handoff 草稿 + 任务性质，输出 primitive + 参数。

### 4.1 门序列（默认值可调）

```
硬门:  G1 已在 fork child 内   → subagent
       G2 coordinator/编排模式  → worker subagent（与 fork 互斥）
       G3 任务性质==长实现/写   → subagent（fork 必亏）
       G4 需并行写文件         → subagent + worktree
热度门: G5 age > 0.8×TTL       → subagent  (5m→240s; 1h ephemeral→2880s)
窗口门: G6 P > 0.40×W          → subagent  (fork worker 从 P 起步，留 ≥60% 空间)
依赖门: G7 handoff 草稿膨胀(H_draft > 0.30·P) → fork; 否则 → subagent（默认）
全过 fork 条件 → fork；决策点有 N 个并行请求 → 成批热扇出（§5.1）
```

### 4.2 别"预测" turn 数，直接"钳住"

> **给 fork worker 设 `maxTurns ≤ 3`（硬上限）。**

"少 turn"从假设变约束。任务真需要更多 turn → 撞上限、没干完 → 这就是"分错格了"的信号（它其实属长实现/subagent）。用一次便宜失败换分类纠正，胜过事前猜。

### 4.3 author-time 草稿测量路由（主机制）

```
模型:  起草 handoff（本就要做）
harness: 量草稿 token 数 H_draft + 机械态（G5/G6/maxTurns）
         H_draft 小            → 提交 subagent（用这份草稿当 handoff）
         H_draft 膨胀(>0.30·P)  → 弃草稿，改走 fork（继承即可，省掉昂贵总结）
```

接口物 = **handoff 草稿大小**。连"语义轴"都转成机械测量，harness 无需信任模型判断——量草稿即可。

### 4.4 三层纠错

| 层 | 时机 | 代价 | 机制 |
|---|---|---|---|
| **author-time** | spawn 前 | ≈免费、无损 | 草稿膨胀→当场改 fork。**主机制** |
| **post-spawn** | 这一 turn | **有损**：worker 活作废 + 父 cache 可能已凉 | subagent 立刻空转/喊缺上下文→杀+重开或补 handoff。少用 |
| **telemetry** | 跨 spawn | 后台 | 用 fork-query 的 `cacheHitRate`/实测 T 校准阈值 |

### 4.5 保守偏置 + 回退分界

- **默认 subagent，fork 要证据确凿才给**：失败成本不对称——误判成 fork = 冷/巨/多 turn 烧几十万 token；误判成 subagent = 顶多重探一轮。边界模糊一律倒向 subagent。
- **保守之所以安全，是因为主回退在 spawn 前（author-time，无损）**：不会因保守而漏掉 fork 收益。
- ⚠️ **别拿 post-spawn 回退当保守的依据**：拖到 subagent 烧了几 turn 再回退，父 cache 往往已冷，fork 意义都没了。膨胀检查必须在"提交 spawn"之前完成。

### 4.6 校准

先用保守默认；每次 spawn 记 primitive/`P`/`age`/实测 `T`/token/`cacheHitRate`。目标：被判 fork 的 spawn，`cacheHitRate > 0.7` 且 `T ≤ 3`。fork 们 cacheHitRate 普遍低 → 收紧 G5；频繁超 T=3 → 修任务性质分类；subagent 频繁重读父内文件 → 放宽 G7。

### 4.7 warmth 时钟

author-time 升级要**趁热**：主干若在 spawn 前磨蹭很久，父 cache 老化，升级到的 fork 就没那么热。authoring 应是一个 trunk turn（秒级）。

---

## 5. 三种编排形态

- **5.1 热扇出（fork 主场）**：决策点上需基于当前完整上下文同时探 N 个变体 → 立刻并发 spawn N 个 fork（cache 正热各命中一次读），短指令、干几 turn 就回。比 N 个 subagent 便宜且零 handoff 损耗。
- **5.2 冷串行阶段（subagent 主场）**：顺序阶段隔时间派、各干很久、各只要切片 → fork 是陷阱（冷 cache 全价重写 + 拖巨大上下文 + 多 turn 重读）。策展 handoff 的 subagent 胜。
- **5.3 fork 读 → subagent 写（组合拳）**：当 `H→P`（高依赖、难蒸馏）→ 用热 fork 便宜地读全上下文产出无损简报（1–2 turn），再交 fresh subagent 长实现。注意：主干自己也持有热的全上下文，多数时候直接写简报即可，只有想**并行**为多阶段生成简报或**卸载** synthesis 时才值得用 fork 分析员。

---

## 6. 验收闸门（信任基石）

worker 自我报告**偏乐观**，不能直接采信。每阶段必须：① **客观判据优先**——handoff 给可机器验证的成功判据，主干自己或派只读 verifier 去核（跑测试 / `git diff` / 复现行为），而非信措辞；② **独立 verifier** + 不忽略"没干完"的 handoff 警告；③ **终止条件**——worker 内部"反复修"要有客观判据兜底，主干侧设**重派上限**（同阶段打回 ≤2 次仍不达标 → 主干介入或改 plan）。

---

## 7. 代价与不适用场景

按疼痛排序：① **Token**（上下文重复、验收 pass、打回、编排 turn；但主干限高 + worker 脏活跑完即弃，长而脏的任务可能持平甚至更省）；② **延迟**（常比 token 更疼：串行 + spawn/通知往返 + worktree 建拆 + 验收串行）；③ **handoff 信息损耗**（质量杀手，多阶段累积如传话游戏）；④ **编排失败面**（分解错了全错、跨阶段问题孤立、并行合并冲突、信任乐观报告）；⑤ **丧失全局回溯**（结果已 commit，回溯昂贵，易陷局部最优）；⑥ **复杂度/可调试性**。

- **不值得**：短任务、能塞进单上下文、阶段切不干净、需密集全局回溯 —— 单体全面胜出。
- **值得**：真会撑爆窗口的长任务、有独立可并行子任务、需隔离跑高风险改动、要可重复自动化的流水线。

---

## 8. 一页速记

1. 主干只做编排，持干净 backbone；脏活留隔离 worker；只回传结构化摘要。
2. 每阶段选 primitive：**默认 subagent**，只有`少turn∧高依赖∧热∧装得下`才 fork。
3. **别在 spawn 时预测，在 author-time 决定**——`H` 那一刻 = 草稿大小，可测。
4. 模型说任务性质 + 起草 handoff；harness 量草稿 + 机械态路由；能运行时推翻。
5. fork worker `maxTurns ≤ 3`（钳住而非预测）；长实现一律 subagent。
6. 保守偏置安全的前提是 **spawn 前回退**；post-spawn 杀+重开是昂贵罕见纠错。
7. 每阶段过验收闸门（客观判据 / 独立 verifier / 重派上限）。
8. 这是长任务专用重型工具，不是默认武器。
