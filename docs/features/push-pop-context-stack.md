# Push/Pop 上下文栈（讨论分支）设计方案

> **状态**：设计定稿，待开发。本文档是开发依据。经多轮代码审查 + 设计迭代修正 9 处（2026-07-22 ~ 07-23，详见 §9）——原方案地基成立，修正均为落地前必须锁定的偏差与迭代。
> **背景**：搜索树协作模型的"用户侧弹栈"操作——用户在主线任务中途 push 出一个继承完整上下文的讨论旁支，自由发散讨论后 pop 回主线：讨论段从上下文中卷掉，只留一份蒸馏 digest，主线不被讨论噪音污染。理论背景见 `AGENT-ORCHESTRATION-DESIGN.md` 与语雀笔记《Agent 与人协作的搜索树模型》§2.2（context 只追加导致回溯残缺）。
> **定位**：纯增量、完全 opt-in 的独立特性。不 push 时零代码路径被激活，对现有 agent 行为无任何影响。与编排 router、fork/subagent 路由零耦合，可独立开发上线。

---

## 1. 目标与非目标

**目标**
- `/push`：在当前对话打一个栈标记，之后的对话即"讨论分支"（继承此刻全部上下文，无需任何复制——就是当前会话继续）。
- `/pop`：结束讨论分支——生成结构化 digest → 截断 messages 回 push 点 → digest 注入主线。可选回滚讨论期间的文件改动。
- 支持嵌套（栈深 ≤ 3）。
- 讨论期间栈感知地管理栈标记：push 后即使忘了 pop 也能无限迭代——auto compact 触发时询问用户（或非交互档默认）压到最近 push 点，保住当前分支、透明告知会移除哪些更老 push 点，绝不静默丢标记（§4.2）。

**非目标（明确不做，留给演进）**
- 路线 A"真分支"：fork 独立会话 + REPL 多会话栈切换 + 并行多分支。本期用路线 B"就地回卷"。
- Agent 自主发起 push（试错 fork 场景）——属编排方案范畴，另行设计。
- 跨会话持久化栈（session 结束栈即失效；resume 场景见 §7.6）。

## 2. 用户体验

```
/push [备注]        压栈。显示 "⑂ 已进入讨论分支 #1: <备注>"，输入框旁常驻栈深指示（如 ⑂1）
（正常多轮对话，可发散、可嵌套 /push）
/push --list        列出栈内所有 push 点（#编号 · 备注 · 预览 · 时间 · 深度）。纯本地读、零 API 成本
                    （不能写成 /push list——list 会被当作备注文本；用 flag 或别名 /stack）
/pop               弹栈顶：生成 digest → 展示给用户确认/编辑 → 应用（截断+注入）
/pop --to #N       跨层弹出：一次性把 #N 之后的全部讨论段（含中间层）蒸馏成单个 digest，
                    回到 #N 标记点，栈上 #N 及以上一并弹出（语义见 §4.7）
/pop --discard     纯丢弃：不生成 digest，直接截断回 push 点（等价 rewind 到标记）
/pop --keep-code   截断对话但不回滚文件改动（默认行为见 §4.4）
```

- pop 的 digest 确认交互（v1 简化版可接受）：先把 digest 以系统消息形式展示 + `AskUserQuestion` 式确认（应用 / 编辑后应用 / 丢弃改 --discard）。v0 最简实现可以直接应用并提示 `ctrl+o` 查看历史（复用现有 summarize 的通知模式）。
- 空栈时 `/pop` 报错提示；栈非空时退出会话前警告。

## 3. 核心机制：就地回卷（路线 B）

**关键复用**：pop 的主体 = 现有 `partialCompactConversation(direction='from')`，即 MessageSelector 里已有的 `summarize_from` 恢复选项的程序化调用。该函数已实现：按消息索引把"该点之后"的段落交给 compact fork（`runForkedAgent`，复用父 cache）总结，保留前段，摘要就地替换后段，且支持 `feedback` 参数注入自定义总结指令——digest 模板正好从这里进。

```
/push:
  栈.push({ id, messageUuid: 当前最后一条消息 uuid, note, timestamp, anchorPreview })
  （fileHistory 快照本就按 message 粒度自动记录，无需额外动作）
  anchorPreview = push 那一刻最后一条消息文本截断（~60–80 字符）的快照，供 /push --list
    显示（类比 /resume 的 firstPrompt）。push 时一次性快照、纯本地：省 list 时遍历回查，
    并覆盖 auto compact 退化全量档把标记压成 summary 的边角（常规 up_to 会保留标记，
    见 §4.7；注意此与 pop 无关——pop 只压 push→pop 讨论段）。可选再回填 branchPreview
    （push 后分支第一条 user 消息）。

/pop:
  0. 定位: 投影 compactMessages = getMessagesAfterCompactBoundary(messages)；
     markerIndex = compactMessages.findIndex(m => m.uuid === 标记.messageUuid)
     pivotIndex = markerIndex + 1   ← 关键：partialCompact 会总结 slice(pivotIndex)、
                  保留 slice(0, pivotIndex)。标记记录的是"push 时最后一条消息"，
                  它属于主线、必须保留，所以 pivot 落在它之后一条。传 markerIndex 本身
                  会把主线最后那条（往往正是 push 前刚得出的结论）吞进 digest。
  1. 校验: 栈非空; markerIndex ≠ -1（标记仍在活跃上下文内，复用 onSummarize 同款警告文案）;
     若 pivotIndex ≥ compactMessages.length → push 后无新消息，走 §7.1 空栈快路径（不 fork、直接弹栈）
  2. digest 生成: partialCompactConversation(compactMessages, pivotIndex, ctx, cacheSafeParams,
       feedback = DIGEST_TEMPLATE, direction = 'from',
       options = { promptOverride: DIGEST_PROMPT, summaryFraming: 'digest' })
     —— feedback 只会被追加成 "Additional Instructions"，压不住 base 模板的
        <analysis>/<summary> 结构（详见 §4.6）；四栏模板须走 promptOverride 才生效
     DIGEST_TEMPLATE（四栏）:
       [已裁决结论] 讨论确定了什么 + 关键理由
       [被排除的方案] 讨论中否决了什么 + 否决原因（防止主线重蹈）
       [未决问题] 讨论未收敛的点
       [主线行动项] 对主线任务的具体影响/待办
  3. 用户确认（§2）
  4. 应用: setMessages([前段..., boundaryMarker, summaryMessages, attachments])
     —— 与 REPL onSummarize 现有落地逻辑一致（含 fullscreen scrollback 分支、
     setConversationId(randomUUID())、runPostCompactCleanup）
  5. 文件处理: fileHistoryGetDiffStats(fileHistory, 标记 messageUuid) 有 diff
     → 询问回滚与否（复用 MessageSelector 的 code/conversation/both 三选语义）
  6. 栈.pop()
```

**cache 说明**：pop 后主线前缀 = push 点之前的部分（曾写过 cache 但可能因 TTL 已凉）+ 新 digest，下一次请求会有一次前缀重写——这是路线 B 的固有成本，可接受（本来讨论段接着聊也要为它付 token）。digest 生成本身走 compact fork，讨论刚结束、cache 必热，成本 ≈ 一次 cache-read + 几百 token 输出。

## 4. 设计决策记录

### 4.1 为什么复用 partialCompact 而不是自建截断+注入
`partialCompactConversation('from')` 已处理了全部脏细节：compact 边界投影、snipped 消息、boundaryMarker、attachments/hookResults 保留、fullscreen 与普通模式的 scrollback 差异、conversationId 重置、post-compact 清理。自建等于重写这些。pop 与 summarize_from 的差异只有三点：入口（命令 vs 选择器 UI）、总结指令（digest 模板 vs 通用摘要）、确认交互——全部可以参数化。

### 4.2 auto compact 与栈标记的冲突（"忘了 pop"必须能持续迭代）
讨论期间若触发自动 compact，全量 `compactConversation`（`autoCompact.ts:342`，auto compact 走的就是它）会把 push 标记的 messageUuid 压到 compact 边界之前，pop 时校验失败。**关键约束**：push 必须是零风险 opt-in——用户 push 后即使**忘了 pop**，也要能像普通会话一样无限迭代下去，不能因栈非空而失去上下文管理兜底、更不能撞窗口时静默丢标记。

因此**不抑制 auto compact，而是让它栈感知 + 透明**。策略是"**询问优先 + 默认压到最近 push 点**"三档：

1. **交互式触发（用户在 REPL 前，主路径）**：auto compact 触发时弹确认，三选：
   - `[压到最近 push 点 #N]`（**默认高亮**）：走 `partialCompactConversation(direction='up_to', pivot = 栈顶 #N 标记的投影 index)`——压缩 `#N` **之前的全部内容**、完整保留 `#N` 及其之后（用户当前正在进行的分支）。释放空间最多、且保住当前分支。**若栈深 > 1**，同时提示："这会移除更老的 push 点 `#1..#N-1`（它们落在被压缩区，之后无法 /pop 到它们）。" 单层 push（最常见）时 `#N` 即唯一 push 点，等于无损保留它、只压它之前的主线。
   - `[压到指定 push 点]`：展开栈列表让用户选边界——选 `#1`（最老）保留最多 push 点、释放最少；选栈顶释放最多。pivot 取所选标记的投影 index。
   - `[全量压缩]`：走原全量 `compactConversation`，**必须明确提醒后果**："这会移除**全部 N 个** push 点，之后 /pop 全部失效。" 用户若已不在乎所有分支，可主动选此项。
   - 成本提示：`up_to` 方向 summary 落在保留内容之前会使 cache 前缀失效、有一次前缀重建——这是保标记的代价，且本来不 push 到阈值也要 compact，非 push 净新增。
2. **非交互触发（proactive/autonomous loop，无 UI 通道）**：不弹窗，**默认压到最近 push 点 #N**（保当前分支、释放最多），事后用通知告知："已压到 push 点 #N；移除了更老的 `#1..#N-1`（若栈深 > 1）。如需全量压缩可手动 /compact。"
3. **reactive 兜底（撞 API 413，在 catch 里，更无法询问）**：reactive compact 绕过 `shouldAutoCompact`（`autoCompact.ts:236` 注释确认），同样**默认压到最近 push 点**；仅当 `#N` 之前也压无可压、`up_to` 救不出空间时，才退化全量并通知"push 点已全部失效，建议 /rewind"。

**为什么默认"最近"而非"最老"**：auto compact 是救急，压到最近 push 点（栈顶）能释放最多空间（把栈顶之前的一切都压掉），且保住用户此刻正在进行的分支——救急有效性最高。代价是嵌套时牺牲更老的 push 点，故交互档默认选项也**如实提醒**、并留 `[压到指定 push 点]` 给想保留更多 push 层的用户。单层 push 场景下"最近 == 唯一"，无取舍、无损。

**实现锚点**：分支加在 `src/services/compact/autoCompact.ts:270 autoCompactIfNeeded`（它手里已有 `messages/toolUseContext/cacheSafeParams`，`partialCompactConversation` 直接可调）——栈非空时改走 `up_to` partial（pivot = 栈顶或用户选定标记的投影 index）而非全量 `compactConversation`；选择全量档才走原 `compactConversation`。栈状态经模块级 singleton 暴露（参照 `src/bootstrap/state.ts` 的 session-global 模式），供 `autoCompactIfNeeded` 与 `shouldAutoCompact` 读取；不为此给它们加 AppState 参数（侵入面过大）。交互档的确认 UI 复用 REPL 现有的权限/MessageSelector 询问模式（需把决策点从 `autoCompactIfNeeded` 内部上浮到 REPL 层，或回调注入）。压到最近 push 点后，被牺牲的更老 push 点须从 `pushStack` 同步弹出（它们的标记已进 summary、失效）。

**pivot 语义核对**：`up_to` 的 `messagesToKeep = slice(pivotIndex)`、`messagesToSummarize = slice(0, pivotIndex)`（`compact.ts:810`）。要保留"某标记及之后"，pivot 传**该标记（默认栈顶 #N；用户可选更老层）的 markerIndex 本身**（标记落在 keep 段首）；压到栈顶时，比它更老的 `#1..#N-1` 标记落在 `slice(0, pivotIndex)` 被压区、随之失效并从栈弹出。注意这与 pop 的 `markerIndex+1`（§3，pop 是 `from` 方向、保留标记之前）方向相反，别混。

**兜底文案**：任何一档最终导致标记失效时，pop 复用现有警告（"That message is no longer in the active context…"）+ 建议 /rewind。不做标记重映射（复杂度不值）。

### 4.3 嵌套语义
栈深 ≤ 3（常量，超出时 /push 报错）。每层 pop 只卷掉**栈顶标记之后**的段落，digest 注入后归属于上一层分支（或主线）。嵌套 pop 的 digest 会被外层 pop 再次蒸馏——符合"每层只向上一层回传"的搜索树语义，无需特殊处理。

**token 成本备忘**（用户对 token 敏感，须显式标注）：每次 pop（除 §7.1 快路径外）都会触发一次 compact fork（`runForkedAgent`）API 调用——digest 生成本身走 compact fork，讨论刚结束 cache 必热，单次成本 ≈ 一次 cache-read + 几百 token 输出（见 §3 cache 说明）。嵌套 N 层逐层 pop = N 次 fork 调用，且外层会把内层已注入的 digest 再喂进去二次总结。这是路线 B 蒸馏语义的固有成本，不是 bug，但频繁 push/pop 或深嵌套时是实打实的额外 token，务必让用户可预期（help 文案里说明"pop 会花一次总结调用"）。

### 4.4 文件改动的默认行为
pop 时若讨论段有文件改动：**默认询问**（回滚 / 保留），不静默二选一。理由：讨论分支里"顺手让它改了个实验代码"和"讨论出结论顺便落了盘"都是真实场景，方向不可预设。`--keep-code` / `--discard`（含回滚）作为快捷路径。

### 4.5 digest 注入形式
digest 以 `partialCompact` 的 `summaryMessages` 形式留在对话流中。**须澄清（此前描述有误）**：`CompactionResult.summaryMessages` 的类型是 `UserMessage[]`，由 `createUserMessage({ isCompactSummary: true })` 构造（`compact.ts:1065`）——它是 **user-role 消息**，不是系统消息，也不同于 task-notification。这是 compact 机制的既定形态（compact summary 一直以带 `isCompactSummary` 标记的 user 消息回注），可以接受，但不要在文案/help 里宣称"非伪造用户输入"。

真正需要处理的是**包装话术**：`partialCompactConversation` 内部写死调用 `getCompactUserSummaryMessage(summary, false, transcriptPath)`（`compact.ts:1067`），把总结包进 `"This session is being continued from a previous conversation that ran out of context…"`（`prompt.ts:346`）。这套话术是为"上下文耗尽的全量 compact"设计的，套在"讨论旁支收尾回主线"上会误导模型（让它以为整个会话被截断重启）。因此 pop 需要 `summaryFraming: 'digest'` 选项（见 §5 row 5），用一段"以下是刚结束的讨论旁支的蒸馏结论，主线在此基础上继续"的包装替换默认话术；默认 `'compact'` 不变。

### 4.6 为什么 feedback 参数不足以承载 digest 模板
`partialCompactConversation` 的 `userFeedback` 参数最终只被拼成 `"Additional Instructions:\n<feedback>"` 追加到 base 模板之后（`prompt.ts:285`）。而 base `PARTIAL_COMPACT_PROMPT` 仍强制模型输出 `<analysis>/<summary>` XML 结构，`formatCompactSummary` 还会剥离 `<analysis>`、把 `<summary>` 替换成 `"Summary:"` 段头（`prompt.ts:312`）。所以四栏 digest 模板若只走 feedback，就只是"附加建议"，压不住基础结构，输出格式不可控。

**对策**：给 `partialCompactConversation` 加可选 `promptOverride?: string`，在 `getPartialCompactPrompt` 处用它**替换**（而非追加）base 模板；不传时保持现行为。DIGEST_PROMPT 自带四栏结构说明，不再依赖 `formatCompactSummary` 的标签处理（或让 DIGEST_PROMPT 也产出 `<summary>` 以复用现有格式化）。此项与 §4.5 的 `summaryFraming` 合并为同一个可选 `options` bag，一次性加到 `partialCompactConversation` 签名，纯增量、不改默认调用方（onSummarize 不传 options 即维持原行为）。

### 4.7 跨层 pop（`/pop --to #N`）与栈查看（`/push --list`）
**`/pop --to #N`（跨层弹出）**：栈内有多层（如 `#1 #2 #3`）时，允许一次回到指定层 `#N`，而非只能逐层弹栈顶。语义定义：
- **回到 #N 标记点**：`#N` 之后的全部讨论段（含中间层 `#N+1..栈顶` 的内容）一次性蒸馏成**单个** digest，回卷到 `#N` 标记处，栈上 `#N` 及以上所有层一并弹出，digest 归属 `#N` 的上一层（或主线）。等价于"对 #N 做一次 pop"。
- **实现**：`pivotIndex = #N 标记的投影 index + 1`（同 §3 pop 的 `from` 方向逻辑，只是标记选 `#N` 而非栈顶），一次 `partialCompactConversation(direction='from')` 调用。
- **token 优势**：相比逐层 pop 的 **N 次 fork**（每层各生成 digest、层层二次蒸馏，见 §4.3），`--to #N` 只花 **1 次 fork**——对 token 敏感场景是明显收益。
- **trade-off**：一次性蒸馏会把中间层 `#N+1..栈顶` 的结论混进一份 digest，丢失分层结构。默认走一次性（省 token）；若确需保留逐层 digest，走 `/pop --to #N --layered`（N 次 fork），此变体列为演进、非本期必做。
- **边界**：`#N` 不存在（编号越界）或标记已失效 → 复用 §4.2 兜底文案。`--to` 指向栈顶 == 普通 `/pop`。

**`/push --list`（栈查看）**：列出 `pushStack` 全部标记——`#编号 · 备注 · 预览 · 相对时间 · 深度`。纯读本地 `pushStack` 状态，**零 API token**，不触发任何 fork。命名用 flag（`--list`）或独立别名 `/stack`，**不可用 `/push list`**：`/push` 的位置参数是自由备注文本，`list` 会被吞成备注。栈为空时提示"当前无 push 点"。

**预览（类比 /resume 的 firstPrompt）**：每行的"预览"取 marker 里 push 时快照的 `anchorPreview`（push 那一刻最后一条消息片段，代表"从哪岔开"），若有回填的 `branchPreview`（push 后分支第一条 user 消息，代表"这分支在聊什么"）则优先显示后者；`note` 备注作为并列字段。这些都是**已有对话原文的截断**，和 `/resume` 一样纯读、不调模型、零 token。**为什么 push 时快照而非 list 时现算**（澄清：与 pop 无关，pop 只压 push→pop 讨论段、保留 push 前主线）：① 省掉 list 时遍历 messages 按 uuid 回查；② 常规栈感知 up_to auto compact（§4.2，默认压到栈顶 #N）会保留"#N 及之后"，仍在栈里的 `#N` 其 `anchorPreview`/`branchPreview` 原文都在——所以此档现算其实也取得到（被压掉的更老 `#1..#N-1` 已从栈弹出、不再需要预览）；③ 但**退化全量 / reactive 全量兜底档**（§4.2 第3档）会把标记连同原文一起压成 summary，此时现算落空，快照可覆盖这个边角；④ 不依赖 messages 数组当前状态。渲染可复用 resume 列表的 FuzzyPicker/行组件样式（`src/commands/resume/resume.tsx`）。

## 5. 实现改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/commands/push/index.ts` + `push.ts`（新建） | 命令定义（参照 `src/commands/rewind/index.ts` 的 `Command` 结构）+ 压栈逻辑 + `--list` 子路径（读 `pushStack` 渲染列表，零 API，§4.7）；备选别名 `/stack` |
| 2 | `src/commands/pop/index.ts` + `pop.ts`（新建） | 命令定义 + §3 pop 流程编排 + `--to #N` 跨层弹出（pivot 选 #N 标记、一次 fork、弹出 #N 及以上，§4.7）+ `--discard` / `--keep-code` |
| 3 | `src/commands.ts` | 注册两个命令（`:186` import 区 + `:359` 注册区，参照 rewind） |
| 4 | `src/state/AppState.tsx` / `AppStateStore.ts` | 新增 `pushStack: PushMarker[]` 状态（默认 `[]`）。`PushMarker = { id, messageUuid, note, timestamp, anchorPreview, branchPreview? }`——`anchorPreview` push 时快照、`branchPreview` push 后分支首条 user 消息回填（供 `--list` 显示，§4.7） |
| 5 | `src/services/compact/compact.ts` | `partialCompactConversation`（`:801`）**必须**加可选 `options` bag（`promptOverride` + `summaryFraming`），承载 digest 四栏模板和"讨论旁支收尾"包装话术。feedback 单独用不够（§4.6）。纯增量：不传 options = 现行为，onSummarize 调用点不动 |
| 6 | REPL 层（`src/screens/REPL.tsx`） | 把 `onSummarize`（`:6554`）的落地逻辑抽出为可复用函数供 pop 调用（目前内联在 MessageSelector 的 prop 里）。抽出时**须剥离 resubmit 行为**：`onSummarize` 末尾 `textForResubmit(message)`→`setInputValue/setInputMode`（`:6646`）是"回到用户消息重编辑"专属，pop 不需要也不应回填输入框——把它留在 onSummarize 调用侧，或加 `resubmit=false` 参数。抽出函数入参从 `message: UserMessage` 改为按 `pivotUuid` 在投影后 compactMessages 内 `find`（pop 标记可能是 assistant/tool 消息，非 UserMessage）。另含栈深指示 UI |
| 7 | `src/services/compact/autoCompact.ts` | **不抑制**，改栈感知（§4.2 三档）：`autoCompactIfNeeded`（`:270`）栈非空时改走 `partialCompactConversation(up_to, pivot=栈顶或用户选定标记 index)` 而非全量 `compactConversation`（`:342`）——**默认压到最近 push 点 #N**（保当前分支、释放最多）。交互档决策点上浮到 REPL 弹三选确认（压到最近#N默认 / 压到指定# / 全量+提醒移除全部 push）；非交互/reactive 档默认压到最近 + 事后通知移除了哪些老 push。压缩后被牺牲的老 push 点须从 `pushStack` 同步弹出。栈状态经模块级 singleton 暴露 |
| 8 | `scripts/defines.ts` / `build.ts` / `scripts/dev.ts` | 新增 feature flag `PUSH_POP`（dev 默认开，build 按需）；代码中 `feature('PUSH_POP')` 只放 if/三元条件位 |
| 9 | 测试 | 见 §6 |

**关键现有锚点**（开发前重新核实行号）：
- `src/commands/rewind/index.ts` — Command 定义模板
- `src/screens/REPL.tsx:2965` — `openMessageSelector` 注入 ToolUseContext 的模式（pop 若需 REPL 能力，同款注入）
- `src/screens/REPL.tsx:6554` — `onSummarize` 完整落地逻辑（pop 应用阶段的参照实现）
- `src/components/MessageSelector.tsx:215` — `onSelectRestoreOption`（code/conversation/both 三选语义 + summarize 选项）
- `src/services/compact/compact.ts:801` — `partialCompactConversation`（`messagesToKeep = slice(0, pivot)`、`messagesToSummarize = slice(pivot)`；`:1065` summaryMessages 构造；`:1067` 写死 `getCompactUserSummaryMessage`）
- `src/services/compact/prompt.ts:275` — `getPartialCompactPrompt`（feedback 追加为 "Additional Instructions"）；`:338/:346` — `getCompactUserSummaryMessage`（"ran out of context" 包装话术）
- `src/services/compact/autoCompact.ts:270` — `autoCompactIfNeeded`（栈感知主锚点：栈非空改走 up_to partial，§4.2）；`:189 shouldAutoCompact`、`:342 compactConversation`（全量，reactive/交互全量档走它）
- `src/utils/fileHistory.ts` — `fileHistoryGetDiffStats` 等快照 API

## 6. 测试计划

- **单元**（`src/commands/__tests__/` 就近）：压栈/弹栈/嵌套深度限制/空栈 pop；标记失效校验分支；digest 模板拼装；**`--list` 渲染**（空栈提示、多层编号/备注/深度）；**`--to #N` 的 pivot 计算**（选 #N 标记而非栈顶、越界报错、指向栈顶 == 普通 pop）。mock 规范遵循 CLAUDE.md（log/debug 用共享 mock，不 mock 纯函数）。
- **集成**（`tests/integration/`）：push → 若干消息 → pop 后 messages 形状（前段保留、boundaryMarker、digest 在位）；`--discard` 路径；嵌套两层逐层 pop；**`/pop --to #1` 跨层**（断言：#1 之后全部蒸馏成单个 digest、栈弹到 #1 之前、只 1 次 fork）；**栈非空时 auto compact 走 up_to partial 而非全量**（断言：默认压到栈顶 #N，压缩后**栈顶标记 messageUuid 仍在活跃上下文、其后讨论段完整保留**；嵌套时更老的 `#1..#N-1` 被压进 summary 并从 pushStack 同步弹出）；非交互档默认压到最近 + 通知；`#N` 之前压无可压时退化全量并置失效标志。
- 完成后 `bun run precheck` 零错误。

## 7. 边界情况备忘

1. push 后 0 条新消息就 pop → 直接弹栈，不生成 digest（无内容可蒸馏）。判据即 §3 step 1 的 `pivotIndex ≥ compactMessages.length`（等价 `partialCompact` 会抛 "Nothing to summarize after"）。**建议扩展**：讨论段极短（新增消息估算 token < 阈值，如复用 `tokenCountWithEstimation` 算 `slice(pivotIndex)`）时也跳过蒸馏、原样保留——因为**每次 pop = 一次 compact fork API 调用**（见 §4.3 token 成本备忘），为几百 token 的短讨论付一次 fork 不划算。
2. pop 的 digest fork 失败（网络/超时）→ 栈不弹、状态不变，提示重试或 `--discard`。
3. 讨论段含子 agent spawn（后台任务仍在跑）→ pop 前警告存在活跃后台任务（复用现有 background task 计数），建议先处理。
4. `--discard` 且有文件改动 → 同 §4.4 询问（discard 只是跳过 digest，不代表默认丢代码）。
5. 与 `/rewind` 的关系：rewind 是无标记的手动选点恢复（丢弃式），pop 是有标记的蒸馏式回卷；两者共享底层，文档/help 里说明区别。
6. `--resume` 会话恢复：栈状态不持久化，恢复后栈为空；若上次会话在分支中未 pop，讨论内容仍在 transcript 里（无害，只是失去了自动弹栈点）。

## 8. 演进方向（不在本期）

- **路线 A 真分支**：fork 独立会话 + 主线冻结 + 并行多分支 + 分支请求保活共享前缀 cache。将来服务 beam search 场景。
- **Agent 自主 push**：模型在不确定点自发起试错分支（编排方案 §5.1 热扇出的交互式变体），触发判据在编排方案中另行设计。
- digest 模板按讨论类型自适应（方案裁决型 / 排查型 / 开放发散型）。

## 9. 代码审查 + 设计迭代修正记录（2026-07-22 ~ 07-23）

按当前代码核实后修正/迭代的 9 处（1–6 为 07-22 代码审查偏差，7–9 为 07-23 设计迭代；原方案地基成立，以下为落地前必须锁定）：

1. **§3 off-by-one（严重）**：pop 应传 `pivotIndex = markerIndex + 1`，不是"标记索引"。`partialCompact` 保留 `slice(0, pivot)`、总结 `slice(pivot)`（含 pivot），传 markerIndex 会把主线 push 前的最后一条消息卷进 digest。
2. **§4.5 digest 注入定性（严重）**：`summaryMessages` 实为 `UserMessage[]`（`isCompactSummary`），非"系统侧消息"；且内容被写死包进"ran out of context"全量 compact 话术，语义误导。修复=`summaryFraming: 'digest'` 选项替换包装文案。
3. **§4.6 feedback 承载模板不足**：feedback 只追加成 "Additional Instructions"，压不住 base 模板的 `<analysis>/<summary>` 结构。修复=加可选 `promptOverride` 替换 base 模板（与 summaryFraming 合并为一个 options bag）。
4. **§5 row 6 抽函数须剥离 resubmit**：`onSummarize` 末尾 `textForResubmit`→回填输入框是 summarize_from 专属，pop 不应触发；且入参须从 `UserMessage` 改为按 uuid find（pop 标记可能非 UserMessage）。
5. **§4.2 auto-compact 从"抑制"改为"栈感知 + 透明"**（2026-07-22 二轮讨论定）：抑制方案会让"忘了 pop"的用户撞窗口时被 reactive 全量 compact 静默抹掉标记，违背 push 零风险定位。改为"询问优先 + 无损默认"三档——交互档弹确认（保留讨论分支 vs 全量+告知移除 push 点），非交互/reactive 档默认无损 `up_to` partial。锚点从 `shouldAutoCompact` 移到 `autoCompactIfNeeded:270`（改走 up_to partial 而非全量）。栈状态经模块级 singleton 传递。**注意：本条的"默认无损 up_to（压到最老、保所有 push）"后被第 9 条迭代为"询问 + 默认压到最近 push 点"，以第 9 条为最终态。**
6. **§4.3 / §7.1 token 成本显式化**：标注"每次 pop = 一次 compact fork 调用"；短讨论段走跳过蒸馏快路径。
7. **§4.7 新增跨层 pop + 栈查看**（2026-07-23 三轮讨论，决定纳入本期）：`/pop --to #N` 一次蒸馏回到指定层（1 次 fork，省于逐层 N 次）；`/push --list` 零成本列出栈。命名坑：`/push list` 会被吞成备注，须用 flag 或 `/stack` 别名。
8. **§4.7 / §3 `--list` 带对话预览**（2026-07-23）：类比 `/resume` 的 firstPrompt，每个 push 点显示已有对话原文的截断预览（`anchorPreview` push 时快照 + 可选 `branchPreview`），纯读零 token。push 时快照而非 list 时现算——防讨论期 auto compact 压掉原文后回查落空。PushMarker 结构相应扩字段。
9. **§4.2 auto compact 交互档改为"询问 + 默认压到最近 push 点"**（2026-07-23 用户明确要求）：原方案默认压到最老标记（保所有 push、释放最少）。改为：触发先问全量 vs partial——全量档移除**全部** push 点且必须提醒；partial 档默认压到**最近**（栈顶）push 点 #N（救急释放最多、保当前分支），栈深>1 时提醒会移除更老的 #1..#N-1，并留 `[压到指定 push 点]` 给想保留更多层的用户。非交互/reactive 档默认压到最近 + 事后通知。被牺牲的老 push 点从 pushStack 同步弹出。

统一收敛点：改动 2、3 都落在"给 `partialCompactConversation` 加一个可选 `options` bag（`promptOverride` + `summaryFraming`）"，纯增量、不改现有 onSummarize 调用点——这是本期唯一需要动 compact 服务签名的地方。`--to #N` 与 `--list` 均复用既有机制（前者复用 pop 的 `from` 蒸馏、只换 pivot；后者纯读 `pushStack`），不新增 compact/API 表面。
