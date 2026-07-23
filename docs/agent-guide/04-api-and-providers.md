# 04 · API 层与模型 Provider

> 关键文件：`src/services/api/claude.ts`（核心客户端 + provider 分派）、`src/services/api/client.ts`（Anthropic-wire 客户端工厂）、`src/utils/model/providers.ts`（provider 选择）、`src/services/api/{openai,gemini,grok}/`（兼容层）、`packages/@ant/model-provider/`（转换器 + 流适配器库）。
>
> 核心不变量：**所有 provider 路径都收敛到同一下游契约** `AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage>`，所以 `query.ts` 的 agent 循环对 provider 无感知。

## 请求流：query.ts → claude.ts → provider SDK

1. **入口** `query.ts:899`：agent 循环调 `deps.callModel({ messages, systemPrompt, thinkingConfig, tools, signal, options })`。
2. **DI 间接层** `query/deps.ts:23,35`：`callModel` 绑定到 `queryModelWithStreaming`（`productionDeps`）——这是 agent 循环与 API 层之间唯一的缝。
3. **`queryModelWithStreaming`** `claude.ts:774`：薄包装，跑 `withStreamingVCR(...)`（录/放）后委托内部 `queryModel(...)` 生成器 `:792-800`。
4. **`queryModel`** 做共享预处理（工具配对修复 `:1324`、advisor 块剥离 `:1328`、媒体封顶 `:1335`），然后**provider 分叉**：
   - `getAPIProvider()==='openai'` → 动态 `import('./openai/index.js')`，`yield* queryModelOpenAI(...)` `:1343-1356`
   - `'gemini'` → `queryModelGemini(...)` `:1358-1369`
   - `'grok'` → `queryModelGrok(...)` `:1371-1381`
   - 否则 → **Anthropic-native 路径**（firstParty/bedrock/vertex/foundry 共用）
5. **Anthropic-native SDK 调用**：`withRetry` 包 `getAnthropicClient({ maxRetries:0, model, ... })` `:1876`，再 `anthropic.beta.messages.create({...params, stream:true}, {signal, headers}).withResponse()` `:1917-1927`。
6. **客户端构造** `client.ts:84` `getAnthropicClient` 按 env 选具体 SDK：
   - Bedrock → `new BedrockClient(...)` `:153-189`
   - Foundry → `new AnthropicFoundry(...)` `:191-219`
   - Vertex → `new AnthropicVertex(...)` `:221-297`
   - firstParty → `new Anthropic(...)` `:300-315`
   - 前三者返回时 `as unknown as Anthropic`，所以 `claude.ts` 对四者一视同仁。**firstParty/bedrock/vertex/foundry 不是独立 query 函数，只是 client 工厂的分支差异。**

## Provider 选择（`providers.ts:15` `getAPIProvider`）

优先级（返回 `APIProvider` 联合 `providers.ts:6-13`）：
1. `settings.modelType === 'openai'|'gemini'|'grok'`（settings.json，最高）`:19-21`
2. `CLAUDE_CODE_USE_BEDROCK` → `_VERTEX` → `_FOUNDRY` `:23-25`
3. `CLAUDE_CODE_USE_OPENAI` → `_GEMINI` → `_GROK` `:27-29`
4. 默认 `'firstParty'` `:31`

`getAPIProvider()` 每次分派点**实时调用**（不缓存）。所有 flag 经 `isEnvTruthy`。

## 兼容层模式（OpenAI/Gemini/Grok → Anthropic 内部格式）

每个兼容 provider 有 `src/services/api/<x>/index.ts` 的 `queryModel*` 生成器：解析模型 → `normalizeMessagesForAPI` → `toolToAPISchema` 建工具 schema（过滤 server 工具）→ 转换 messages/tools 为 provider 格式 → 调 provider client → 用**流适配器**把裸流包成 Anthropic `BetaRawMessageStreamEvent` → 通用累积循环（三个 provider 完全一致）重组 `AssistantMessage` + `StreamEvent`。

转换/适配原语在 **`packages/@ant/model-provider/`**：

- **OpenAI**（`openai/index.ts:220` `queryModelOpenAI`）：
  - 转换：`anthropicMessagesToOpenAI` / `anthropicToolsToOpenAI` / `anthropicToolChoiceToOpenAI`
  - **流适配器 `adaptOpenAIStreamToAnthropic`**（`model-provider/src/shared/openaiStreamAdapter.ts:36`）：`reasoning_content`→thinking，`tool_calls`→tool_use，usage 经 `normalizeOpenAIUsage`。头注释 `:6-35` 有完整字段映射。
  - 两后端：ChatGPT 订阅 OAuth 用 **Responses** 适配器（`openai/responsesAdapter.ts`，`isChatGPTAuthEnabled()` gate）；否则 Chat Completions。
- **Grok**（`grok/index.ts:51` `queryModelGrok`）：Grok 与 OpenAI 同线，**复用 OpenAI 转换器 + `adaptOpenAIStreamToAnthropic`**，只有 client（`getGrokClient`）+ `resolveGrokModel` 是 Grok 专属。→ **加新 provider 时它是最接近的模板。**
- **Gemini**（`gemini/index.ts:40` `queryModelGemini`）：自有线格式。转换 `anthropicMessagesToGemini` 等；传输 `streamGeminiGenerateContent`（`gemini/client.ts:26`，手写 fetch + SSE）；适配器 `adaptGeminiStreamToAnthropic`（`model-provider/src/providers/gemini/streamAdapter.ts:5`），注意 `GEMINI_THOUGHT_SIGNATURE_FIELD` 特判。

## 各兼容层关键 env

| Provider | 必填 | 可选 / 模型映射 |
|----------|------|-----------------|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL`、`OPENAI_ORG_ID`、`OPENAI_PROJECT_ID`；模型 `OPENAI_MODEL` > `OPENAI_DEFAULT_{HAIKU/SONNET/OPUS}_MODEL` > `ANTHROPIC_DEFAULT_*` > 内置表 > 透传；`OPENAI_MAX_TOKENS`、`CLAUDE_CODE_EFFORT_LEVEL` |
| Grok | `GROK_API_KEY` 或 `XAI_API_KEY` | `GROK_BASE_URL`（默认 `https://api.x.ai/v1`）；模型 `GROK_MODEL` > `GROK_MODEL_MAP`(JSON) > `GROK_DEFAULT_*` > `ANTHROPIC_DEFAULT_*` |
| Gemini | `GEMINI_API_KEY`（`x-goog-api-key`）| `GEMINI_BASE_URL`；模型 `GEMINI_MODEL` > `GEMINI_DEFAULT_*` > `ANTHROPIC_DEFAULT_*`，**都没设则抛错** |
| 共享 | — | `API_TIMEOUT_MS`、代理 `getProxyFetchOptions` |
| Anthropic-native | `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` | Bedrock `AWS_REGION`/`AWS_BEARER_TOKEN_BEDROCK`；Foundry `ANTHROPIC_FOUNDRY_*`；Vertex `ANTHROPIC_VERTEX_PROJECT_ID`/`CLOUD_ML_REGION` |

启用兼容层：`CLAUDE_CODE_USE_OPENAI=1` / `CLAUDE_CODE_USE_GEMINI=1` / `CLAUDE_CODE_USE_GROK=1`，或经 `/login` 配置。

## 添加新 provider

**A. Anthropic-wire 兼容后端（像 bedrock/vertex/foundry）——最简单：**
1. `APIProvider` 联合加字面量（`providers.ts:6-13`）。
2. `getAPIProvider` 加选择分支（`modelType` 或 `CLAUDE_CODE_USE_X` env）`:19-31`。
3. `getAnthropicClient` 加 client 工厂分支（`client.ts`，仿 `:153/191/221`），动态 import SDK 返回 `as unknown as Anthropic`。**`claude.ts` 无需改**。

**B. 非 Anthropic-wire provider（像 openai/gemini/grok）：**
1. A 的步骤 1-2。
2. 建 `src/services/api/<x>/client.ts`（client + env 配置，`getXClient`）。
3. 建 `src/services/api/<x>/index.ts` 导出 `queryModelX(...)`——**复制 `grok/index.ts` 及其累积循环**（最近模板）。
4. 在 `packages/@ant/model-provider/src/providers/<x>/` 加转换器 + `resolveXModel` + `adaptXStreamToAnthropic`，从 `model-provider/src/index.ts` 导出。
5. 在 `queryModel`（`claude.ts` `:1343/1358/1371` 旁）加分派分支：动态 import + `yield* queryModelX(...)`。
6. 接成本/langfuse（`addToTotalSessionCost`、`recordLLMObservation`）。

## 添加/改兼容层（适配器模式）

契约是 **`AsyncGenerator<BetaRawMessageStreamEvent>`**。写 `async function*`：
- 发一个 `message_start`（合成 `msg_…` id）；
- 每内容块 `content_block_start` → `content_block_delta`（`text_delta` / `input_json_delta` 工具参数 / `thinking_delta`+`signature_delta`）→ `content_block_stop`；
- 发 `message_delta`（带 `stop_reason` + 归一化 usage），再 `message_stop`。

然后 `index.ts` 的累积循环消费它——**你不用重写那个循环**。规则：
- provider 说 OpenAI Chat Completions 线格式 → 原样复用 OpenAI 转换器 + `adaptOpenAIStreamToAnthropic`（Grok 就这么干），只给不同 client + `resolveXModel`。
- usage 归一化必须走 `normalizeOpenAIUsage`/`updateOpenAIUsage`（`shared/openaiUsage.ts`），保证 cache/read/write token 字段正确。
- 模型映射固定优先级 `X_MODEL` > `X_DEFAULT_{FAMILY}_MODEL` > `ANTHROPIC_DEFAULT_{FAMILY}_MODEL` > 表/透传。
- 适配器有单测在 `model-provider/src/shared/__tests__/` 与 `providers/*/__tests__/`，加对应测试。

## ⚠️ 架构注意：`@ant/model-provider` 的现状

该包是**部分抽取的抽象**：目前只拥有纯/无状态部分（转换器、模型映射、流适配器、usage 归一化、类型），被 `src/services/api/*` 兼容层消费。它的 `registerClientFactories`/`registerHooks` DI 机制和"core query 函数"（`index.ts:5`）**尚未从 `src/` 接线**（`src/` 中无 `registerClientFactories(...)` 调用，`getClientFactories()` 会抛）。**实际 query 编排仍在 `src/services/api/claude.ts`**。把这个包当"转换器/适配器库"，不是 query 引擎。
