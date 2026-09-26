import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter,
  LlmError,
  ReasoningEffortId
} from "@deepseek-ai/dsh-llm";
import { providerCatalogVisible } from "./account-pool.js";
import { settingsNamespaceFor } from "./settings-compat.js";
import { isRateLimited, parseRateLimitError } from "./llm-adapter.js";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import {
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
  credentialExpiresAtMs,
  formatCreditsRate
} from "./buddy.js";
import { CODEBUDDY, resolveUserAgent } from "./product.js";
import { normalizeHarnessMessages } from "./message-shape.js";
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveEmptyResponseReason, resolveToolPairing, splitThinkTaggedContent, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from "./sse.js";
const CHAT_API_BASE = "https://copilot.tencent.com/v2";
function isDeepSeekModel(model) {
  return /^deepseek/i.test(model.trim());
}
const PROVIDER = "buddy";
const DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "hy4-preview",
  "hy4-preview-x",
  "hy3",
  "hy3-x",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "kimi-k3-1",
  "kimi-k2.7",
  "kimi-k2.6",
  "minimax-m3"
];
const DEFAULT_MODEL = "deepseek-v4-flash";
const CONTEXT_WINDOWS = /* @__PURE__ */ new Map([
  ["deepseek-v4-flash", 1e6],
  ["deepseek-v4-pro", 1e6],
  ["hy4-preview", 1e6],
  ["hy4-preview-x", 1e6],
  ["hy3", 192e3],
  ["hy3-x", 192e3],
  ["glm-5.3", 1e6],
  ["glm-5.3-flash", 1e6],
  ["glm-5.2", 1e6],
  ["glm-5.1", 2e5],
  ["glm-5v-turbo", 2e5],
  ["kimi-k3-1", 1e6],
  ["kimi-k2.7", 256e3],
  ["kimi-k2.6", 256e3],
  ["minimax-m3", 512e3]
]);
const IMAGE_MODELS = /* @__PURE__ */ new Set([
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-sg",
  "deepseek-v4-pro",
  "hy4-preview",
  "hy4-preview-f",
  "hy4-preview-x",
  "hy3",
  "hy3-x",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "kimi-k3",
  "kimi-k3-1",
  "kimi-k2.8-preview",
  "kimi-k2.7",
  "kimi-k2.6",
  "minimax-m3"
]);
const REASONING_EFFORTS = /* @__PURE__ */ new Map([
  ["deepseek-v4-flash", ["low", "high", "max"]],
  ["deepseek-v4.1-flash", ["low", "high", "max"]],
  ["deepseek-v4-pro", ["low", "high", "xhigh"]],
  ["hy4-preview", ["high"]],
  ["hy4-preview-x", ["high"]],
  ["hy3", ["low", "high"]],
  ["hy3-x", ["low", "high"]],
  ["glm-5.3", ["low", "high", "max"]],
  ["glm-5.3-flash", ["low", "high", "max"]],
  ["glm-5.2", ["high", "xhigh"]]
]);
const EFFORT_NAMES = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
};
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => typeof block === "object" && block !== null && block.type === "text").map((block) => String(block.text)).join("");
}
const TOOL_RESULT_IMAGE_TEXT = "Attached image(s) from tool result:";
function serializeMessages(messages, imageUrls) {
  const wire = [];
  let pendingToolImages = [];
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    wire.push({
      role: "user",
      content: [{ type: "text", text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages]
    });
    pendingToolImages = [];
  };
  const normalized = normalizeHarnessMessages(messages);
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);
  for (const message of normalized) {
    if (message.role === "assistant") {
      const content2 = stripCourseLeakFromHistoryContent(
        message.role,
        Array.isArray(message.content) ? message.content : []
      );
      const toolCallBlocks = content2.filter((block) => typeof block === "object" && block !== null && block.type === "tool-call").filter((block) => keepCallIds.has(String(block.id)));
      const toolCalls = toolCallBlocks.map((block) => ({
        id: String(block.id),
        type: "function",
        function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) }
      }));
      const reasoning = content2.filter((block) => typeof block === "object" && block !== null && block.type === "reasoning").map((block) => String(block.text)).join("");
      const text2 = contentToText(content2);
      flushToolImages();
      wire.push({
        role: "assistant",
        // 正文为空且有工具调用时 content 必须为 null（对齐 openai_chat.rs）。
        content: text2.length === 0 && toolCalls.length > 0 ? null : text2,
        reasoning_content: reasoning,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
      });
      continue;
    }
    if (message.role === "system") {
      flushToolImages();
      wire.push({ role: "system", content: contentToText(message.content) });
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const toolResults = content.filter((block) => typeof block === "object" && block !== null && block.type === "tool-result");
    const text = contentToText(message.content);
    const regular = content.filter((block) => !(typeof block === "object" && block !== null && block.type === "tool-result"));
    const regularImageUrls = imageUrls;
    const parts = regularImageUrls === void 0 ? void 0 : userContentParts(regular, regularImageUrls);
    if (parts !== void 0) {
      flushToolImages();
      wire.push({ role: "user", content: parts });
    } else if (text.length > 0 || toolResults.length === 0) {
      flushToolImages();
      wire.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      if (!keepResultIds.has(String(result.toolCallId))) continue;
      let resultText = "(no output)";
      if (regularImageUrls !== void 0 && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, regularImageUrls);
        if (resultParts !== void 0) {
          pendingToolImages.push(...resultParts.filter((part) => part.type !== "text"));
          const joined = resultParts.filter((part) => part.type === "text").map((part) => String(part.text)).join("");
          if (joined.length > 0) resultText = joined;
        } else {
          resultText = contentToText(result.content) || "(no output)";
        }
      } else {
        resultText = contentToText(result.content) || "(no output)";
      }
      wire.push({
        role: "tool",
        tool_call_id: String(result.toolCallId),
        content: resultText
      });
    }
  }
  flushToolImages();
  return wire;
}
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}
function errorDetail(body) {
  try {
    const data = JSON.parse(body);
    const error = typeof data.error === "object" && data.error !== null ? data.error : void 0;
    const parts = [
      typeof error?.code === "string" ? error.code : void 0,
      typeof error?.type === "string" ? error.type : void 0,
      typeof error?.message === "string" ? error.message : void 0,
      typeof data.message === "string" ? data.message : void 0
    ].filter((value) => value !== void 0);
    if (parts.length > 0) return parts.join(" ");
  } catch {
  }
  return body;
}
function httpErrorCode(status, body) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(body)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}
function resolveFirstTokenTimeoutMs() {
  return Number.parseInt(process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS ?? "", 10) || 12e4;
}
function resolveChunkTimeoutMs() {
  return Number.parseInt(process.env.DSH_BUDDY_SSE_CHUNK_TIMEOUT_MS ?? "", 10) || 12e4;
}
function isTransportError(error) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes("terminated")) return true;
  if (error.name.startsWith("UND_ERR_")) return true;
  if (message.includes("fetch failed")) return true;
  if (message.includes("econnreset") || message.includes("epipe") || message.includes("socket hang up")) return true;
  return false;
}
function userContentParts(content, imageUrls) {
  const parts = [];
  let hasImage = false;
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw;
    if (block.type === "text") {
      const text = String(block.text ?? "");
      if (text.length > 0) parts.push({ type: "text", text });
      continue;
    }
    if (block.type === "image") {
      hasImage = true;
      const url = block.attachment?.attachmentId === void 0 ? void 0 : imageUrls.get(String(block.attachment.attachmentId));
      parts.push(url === void 0 ? { type: "text", text: "[image unavailable]" } : { type: "image_url", image_url: { url } });
      continue;
    }
    if (block.type === "tool-result" && Array.isArray(block.content)) {
      const inner = userContentParts(block.content, imageUrls);
      if (inner !== void 0) {
        hasImage = true;
        parts.push(...inner);
      } else {
        const text = contentToText(block.content);
        if (text.length > 0) parts.push({ type: "text", text });
      }
    }
  }
  return hasImage && parts.length > 0 ? parts : void 0;
}
function collectImages(content, refs) {
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw;
    if (block.type === "image" && typeof block.attachment?.attachmentId === "string") {
      refs.set(block.attachment.attachmentId, block.attachment);
      continue;
    }
    if (block.type === "tool-result" && Array.isArray(block.content)) collectImages(block.content, refs);
  }
}
class BuddyAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
    this.product = options.product ?? CODEBUDDY;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, "");
    const fallback = this.product.fallbackModels ?? [];
    this.productFallbackIndex = new Map(fallback.map((model) => [model.id, model]));
    this.productFallbackContextWindows = new Map(
      fallback.filter((model) => model.contextWindow !== void 0).map((model) => [model.id, model.contextWindow])
    );
  }
  options;
  /** 本适配器所属的产品配置（默认 CodeBuddy）。 */
  product;
  fetchImpl;
  /**
   * 前缀缓存会话标识（prompt_cache_key）。同一会话内所有请求复用同一 key，
   * 服务端据此把相同前缀的 KV 缓存跨请求复用；缺失时缓存命中恒为 0。
   */
  sessionId;
  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  remoteModels;
  /** 远端下发的模型元数据（id → 能力），listModels/resolveModel/stream 共用。 */
  remoteMeta = /* @__PURE__ */ new Map();
  /** 远端下发的模型上下文窗口（/v3/config data.models[].maxInputTokens）。 */
  remoteContextWindows = /* @__PURE__ */ new Map();
  /**
   * 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。
   * 远端缺失时补位；构造时一次性建立，只读。
   */
  productFallbackIndex;
  /** 产品级兜底上下文窗口（构造时从 fallbackModels 提取）。 */
  productFallbackContextWindows;
  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * DSH 会强制校验 `info.id === provider` 且 `info.name` 为非空字符串；
   * 模型设置页还会用该 id 计算 `deriveKeyRef(provider)`（内部调用
   * `provider.toUpperCase()`）。因此这里对入参做防御性归一化：
   * 一旦 `provider` 不是字符串（例如上游传入了 undefined），
   * 直接回退到本适配器所属产品的 id，避免
   * `undefined.toUpperCase is not a function` 在客户端炸开。
   *
   * 展示名同样来自产品配置：CodeBuddy 为 'CodeBuddy (腾讯)'，
   * WorkBuddy 为 'WorkBuddy'。
   */
  providerInfo(provider) {
    const id = typeof provider === "string" && provider.length > 0 ? provider : this.product.id;
    return { id, name: this.product.displayName };
  }
  /**
   * 模型列表：优先使用 /v3/config 动态拉取的远端列表，否则回退静态默认。
   * 动态拉取失败时静默回退（与 Rust fetch_models 的 Vec::new() 语义一致）。
   */
  /**
   * 懒加载远端模型目录（仅拉取一次）。listModels 与 resolveModel 共用：
   * resolveModel 可能先于 listModels 被调用（如直接进入会话），此时同样
   * 触发一次远端拉取，保证 /v3/config 的 maxInputTokens 能生效。
   */
  async ensureRemoteModels() {
    if (this.remoteModels !== void 0 || this.options.fetchRemoteModels === void 0) return;
    try {
      const models = await this.options.fetchRemoteModels();
      if (models.length > 0) {
        const reconciled = this.reconcileWithFallback(models);
        this.remoteModels = reconciled;
        this.remoteMeta = new Map(reconciled.map((model) => [model.id, model]));
        this.remoteContextWindows = new Map(
          reconciled.filter((model) => model.contextWindow !== void 0).map((model) => [model.id, model.contextWindow])
        );
      }
    } catch {
    }
  }
  /**
   * 用产品兜底表校正远端结果。
   *
   * 为什么需要校正：服务端按**认证上下文**决定返回哪些模型，插件的 CLI
   * token 拿到的集合可能是残缺甚至错的 —— 实测 WorkBuddy 国际版的 CLI token
   * 只拿到 13 个内部别名（含实际不可用的 `o4-mini`），而 IDE 用的是 20 个
   * （含全部 GPT 系列）。此时若直接采信远端，模型选择器会缺掉用户真正要用的模型。
   *
   * 有产品兜底表时以它为准：
   * - 只保留兜底表里声明的 id（远端多出来的别名/内部模型被丢弃）；
   * - 兜底表声明但远端缺失的模型补进来（用兜底表的元数据）；
   * - ⚠️ **例外：被 agent 引用的模型即使不在兜底表也保留**（见下）。
   *
   * ⚠️ **为什么需要那个例外**：两个端点下发的 id 集合**不同**，而兜底表是
   * 编译期快照、只覆盖其中一套。实测（2026-09-21）`hy4-preview-f`
   * —— 新用户限时免费变体 —— **只由 `/v3/config` 下发**，且被
   * `craft`/`ask`/`plan` 三个 agent 引用（即服务端声明「对话里可选」），
   * 但**不在兜底表**里。白名单重建会把它丢掉，于是用户看不到那个免费变体，
   * 而 IDE 里能看到（用户报障「hy4 preview 现在 ide 是免费我们还是 0.29」）。
   *
   * 判据用 `agentReferenced`（服务端自己的「可选」信号）而非猜测 id 后缀 ——
   * 后缀规则不统一（`-f` / `-x` / `-sg` / `-ioa` 含义各异），猜错会放进
   * 不可用的模型。未标记的内部别名（如 `default`）不会被误留。
   */
  reconcileWithFallback(models) {
    const fallback = this.product.fallbackModels;
    if (fallback === void 0 || fallback.length === 0) return [...models];
    const remoteById = new Map(models.map((model) => [model.id, model]));
    const reconciled = fallback.map((entry) => {
      const remote = remoteById.get(entry.id);
      return {
        id: entry.id,
        name: remote?.name ?? entry.name,
        ...entry.contextWindow !== void 0 || remote?.contextWindow !== void 0 ? { contextWindow: remote?.contextWindow ?? entry.contextWindow } : {},
        // 输出上限同样「远端优先、兜底补位」：远端不下发时兜底表给保守值，
        // 两边都没有则留 undefined（不编造，见 resolveModel 的说明）。
        ...entry.maxOutputTokens !== void 0 || remote?.maxOutputTokens !== void 0 ? { maxOutputTokens: remote?.maxOutputTokens ?? entry.maxOutputTokens } : {},
        ...entry.supportsImages !== void 0 || remote?.supportsImages !== void 0 ? { supportsImages: remote?.supportsImages ?? entry.supportsImages } : {},
        ...entry.reasoningEfforts !== void 0 || remote?.reasoningEfforts !== void 0 ? { reasoningEfforts: [...remote?.reasoningEfforts ?? entry.reasoningEfforts ?? []] } : {},
        ...entry.defaultReasoningEffort !== void 0 || remote?.defaultReasoningEffort !== void 0 ? { defaultReasoningEffort: remote?.defaultReasoningEffort ?? entry.defaultReasoningEffort } : {},
        // 计费倍率只可能来自远端（兜底表是编译期快照，价格会变，不写死）。
        // 注意本函数是**白名单式重建**：不在这里显式搬运的字段会被静默丢弃，
        // 新增远端字段时必须同步加一行，否则 listModels 看不到它。
        ...remote?.creditsRate !== void 0 ? { creditsRate: remote.creditsRate } : {},
        ...remote?.discountedCreditsRate !== void 0 ? { discountedCreditsRate: remote.discountedCreditsRate } : {}
      };
    });
    const known = new Set(reconciled.map((model) => model.id));
    for (const model of models) {
      if (model.agentReferenced !== true || known.has(model.id)) continue;
      known.add(model.id);
      reconciled.push({ ...model });
    }
    return reconciled;
  }
  /**
   * 远端能力字段被实测证伪、需要强制覆盖为「支持图片」的模型。
   *
   * 为什么需要它：上游两个模型端点对同一模型的能力声明会互相矛盾。
   * 实测 `glm-5.1`（2026-09）：
   * - scoped 端点 `/console/enterprises/personal/models` → `supportsImages: false`
   * - `/v3/config` → `supportsImages: true`
   * - 真实请求（纯红图 + 问颜色）→ 答出「红色」，**确实能看到图片**
   *
   * 由于 `fetchModels` 优先采用 scoped 端点，若不覆盖，`glm-5.1` 会被判成
   * 纯文本，用户贴图时直接吃 host 的 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝
   * （前端文案「当前模型不支持图片」），而图片根本到不了上游。
   *
   * 为什么用显式白名单而不是「兜底表 true 优先」这类通用规则：通用规则会让
   * 兜底表永久压过远端，一旦某模型真的下线或能力变更，用户会被放行后被上游
   * 400 拒绝 —— 错误更晚、更难懂。白名单只覆盖已实测确认的个案，新增条目
   * 必须先有真实请求证据。
   */
  static IMAGE_CAPABILITY_OVERRIDES = /* @__PURE__ */ new Set([
    // scoped 端点误报 false，实测能看图。
    "glm-5.1"
  ]);
  /**
   * 模型接受的输入模态：远端 supportsImages 优先，静态表兜底；
   * {@link IMAGE_CAPABILITY_OVERRIDES} 中的模型强制为支持图片。
   */
  inputModalitiesFor(model) {
    const supportsImages = BuddyAdapter.IMAGE_CAPABILITY_OVERRIDES.has(model) || (this.remoteMeta.get(model)?.supportsImages ?? this.productFallbackMeta.get(model)?.supportsImages ?? IMAGE_MODELS.has(model));
    return supportsImages ? ["text", "image"] : ["text"];
  }
  /** 模型可选的思考等级：远端 supportedEfforts 优先，产品兜底表次之，通用静态表最后。 */
  effortsFor(model) {
    return this.remoteMeta.get(model)?.reasoningEfforts ?? this.productFallbackMeta.get(model)?.reasoningEfforts ?? REASONING_EFFORTS.get(model) ?? [];
  }
  /**
   * 模型声明的默认思考等级（远端 `reasoning.defaultEffort` 优先，产品兜底表次之）。
   *
   * 用途：composer 未选档位时补 `reasoning_effort`（deepseek 系不带档位 = 不思考）。
   * 若声明值不在该模型的支持档内（远端数据不一致）则视为未声明，由调用方回退。
   */
  defaultEffortFor(model) {
    const declared = this.remoteMeta.get(model)?.defaultReasoningEffort ?? this.productFallbackMeta.get(model)?.defaultReasoningEffort;
    return declared !== void 0 && this.effortsFor(model).includes(declared) ? declared : void 0;
  }
  /**
   * 产品级兜底模型目录（`product.fallbackModels`）。
   *
   * 用于远端不可用或远端未覆盖到该模型时。与 `remoteMeta` 分开存放，
   * 使远端一旦可用就自动优先，而产品兜底只在缺失时补位。
   */
  get productFallbackMeta() {
    return this.productFallbackIndex;
  }
  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率 + 同名消歧）。
   *
   * 设置页（Jet Hub「显示列表」）必须把**被关闭的**模型也渲染出来，否则用户
   * 无法重新打开；而 `listModels` 会按黑名单过滤掉它们，RPC 层只能凭黑名单的
   * key（裸 id）补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率随之丢失**
   * （用户报障：「关闭的就没有显示倍率」）。
   *
   * ⚠️ 同名消歧必须基于**未过滤**的全量集合：`displayNameFor(model, source)`
   * 而非 `listed`。用过滤后的集合会让「关掉其中一个同名模型」改变另一个的
   * 变体标记，名字随开关跳变。
   */
  listAllModels() {
    const source = this.remoteModels ?? this.staticFallbackModels();
    return source.map((model) => ({ id: model.id, name: displayNameFor(model, source) }));
  }
  async listModels(_provider) {
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return [];
    await this.ensureRemoteModels();
    const source = this.remoteModels ?? this.staticFallbackModels();
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
    const listed = disabled === void 0 || disabled.size === 0 ? source : source.filter((model) => !disabled.has(model.id));
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: displayNameFor(model, listed),
      inputModalities: this.inputModalitiesFor(model.id)
    }));
  }
  /**
   * 静态兜底模型目录：优先用产品自带的 `fallbackModels`，否则用通用默认表。
   *
   * 产品兜底表存在的原因：模型池由服务端按认证上下文下发，插件的 CLI
   * token 未必能取到完整集合（实测 WorkBuddy 国际版经 CLI token 只能拿到
   * 13 个别名，拿不到 GPT 系列）。产品兜底表提供该产品权威的完整清单。
   */
  staticFallbackModels() {
    const productModels = this.product.fallbackModels;
    if (productModels !== void 0 && productModels.length > 0) {
      return productModels.map((model) => ({ id: model.id, name: model.name }));
    }
    return DEFAULT_MODELS.map((id) => ({ id, name: id }));
  }
  async resolveModel(provider, model, _signal) {
    await this.ensureRemoteModels();
    const contextWindow = this.remoteContextWindows.get(model) ?? this.productFallbackContextWindows.get(model) ?? CONTEXT_WINDOWS.get(model);
    const resolved = {
      provider,
      id: model,
      name: this.remoteMeta.get(model)?.name ?? this.productFallbackIndex.get(model)?.name ?? model,
      inputModalities: this.inputModalitiesFor(model)
    };
    if (contextWindow !== void 0) resolved.context = { contextWindow };
    const maxOutputTokens = positiveMaxTokens(
      this.remoteMeta.get(model)?.maxOutputTokens ?? this.productFallbackMeta.get(model)?.maxOutputTokens
    );
    if (maxOutputTokens !== void 0) resolved.defaultMaxTokens = maxOutputTokens;
    const efforts = this.effortsFor(model);
    if (efforts.length > 0) {
      const remoteDefault = this.remoteMeta.get(model)?.defaultReasoningEffort ?? this.productFallbackIndex.get(model)?.defaultReasoningEffort;
      resolved.reasoning = {
        efforts: efforts.map((id) => ({
          id: ReasoningEffortId(id),
          name: EFFORT_NAMES[id] ?? id
        })),
        ...remoteDefault !== void 0 && efforts.includes(remoteDefault) ? { defaultEffort: ReasoningEffortId(remoteDefault) } : {}
      };
    }
    return resolved;
  }
  /**
   * 兼容 0.1.1-rc.2：新版 LlmRuntime.prepareCall() 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * （0.1.0-rc.6）的 LlmAdapter 基类尚未提供该方法，缺少时会在每轮请求
   * 开始时抛 `registration.adapter.prepareCall is not a function`。这里把
   * 模型解析与分发绑定到同一个适配器实例（与 CodeArtsAdapter 同款 shim）。
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    };
  }
  async *stream(options) {
    let credential = await this.options.resolveCredential();
    if (credential === void 0 || isCredentialExpired(credential)) {
      await this.options.refresh();
      credential = await this.options.resolveCredential();
    }
    if (credential === void 0 || credential.access_token.length === 0) {
      throw new LlmError("buddy: no usable credential; log in first with /buddy-login", "MISSING_CREDENTIAL");
    }
    let currentAccountId = "";
    if (this.options.accountPool && credential) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id,
          credential.access_token
        );
        if (currentAccountId === "") {
          console.warn(`[${this.product.id}] \u5F53\u524D\u51ED\u636E\u672A\u5339\u914D\u5230\u8D26\u53F7\u6C60\u6761\u76EE\uFF0C\u9650\u6D41\u8BB0\u5F55\u5C06\u88AB\u8DF3\u8FC7`);
        }
      } catch (error) {
        console.warn(`[${this.product.id}] \u8D26\u53F7\u5339\u914D\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u672C\u6B21\u8BF7\u6C42\uFF09:`, error);
      }
    }
    await this.ensureRemoteModels();
    const imageRefs = /* @__PURE__ */ new Map();
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs);
    }
    let imageUrls;
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes("image")) {
        throw new LlmError(`buddy: model "${options.model}" does not accept image input.`, "UNSUPPORTED_CONTENT");
      }
      if (this.options.readImage === void 0) {
        throw new LlmError("buddy: image input requires the attachment service.", "UNSUPPORTED_CONTENT");
      }
      imageUrls = /* @__PURE__ */ new Map();
      for (const [id, ref] of imageRefs) {
        let image;
        try {
          image = await this.options.readImage(ref);
        } catch (error) {
          throw new LlmError(
            `buddy: \u8BFB\u53D6\u56FE\u7247\u9644\u4EF6\u5931\u8D25\uFF08${id}\uFF09\uFF1A${errorMessage(error)}`,
            "UNSUPPORTED_CONTENT",
            { cause: error }
          );
        }
        if (image === void 0) {
          throw new LlmError(
            `buddy: \u56FE\u7247\u9644\u4EF6\u8BFB\u53D6\u4E0D\u5230\u5185\u5BB9\uFF08${id}\uFF09\uFF1B\u9644\u4EF6\u670D\u52A1\u53EF\u80FD\u672A\u5C31\u7EEA\uFF0C\u6216\u8BE5\u5BF9\u8C61\u5DF2\u4E0D\u5B58\u5728\u3002`,
            "UNSUPPORTED_CONTENT"
          );
        }
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`);
      }
    }
    const messages = serializeMessages(options.messages, imageUrls);
    if (options.system !== void 0 && options.system.length > 0) {
      messages.unshift({ role: "system", content: options.system });
    }
    const tools = options.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
    const bodyObj = {
      model: options.model,
      messages,
      stream: true,
      // prompt_cache_key 让服务端启用前缀缓存并在 usage 中返回缓存命中，
      // 缺少该字段时命中恒为 0（与 codearts 同款修复，见 llm-adapter.ts）。
      // 实证（2026 实测 deepseek-v4-flash，同一段 8k token 前缀）：
      //   不带该字段 → prompt_tokens=8027, prompt_cache_hit_tokens=0,    credit=0.34
      //   带该字段   → prompt_tokens=8027, prompt_cache_hit_tokens=7808, credit=0.02
      // 仅此一个字段的差异，费用差约 17 倍。同 key 重复请求稳定命中同一前缀。
      prompt_cache_key: this.sessionId
    };
    if (tools !== void 0 && tools.length > 0) bodyObj.tools = tools;
    if (options.temperature !== void 0) bodyObj.temperature = options.temperature;
    if (options.stop !== void 0 && options.stop.length > 0) bodyObj.stop = options.stop;
    const maxTokens = positiveMaxTokens(
      options.maxTokens ?? this.remoteMeta.get(options.model)?.maxOutputTokens ?? this.productFallbackMeta.get(options.model)?.maxOutputTokens
    );
    if (maxTokens !== void 0) bodyObj.max_tokens = maxTokens;
    const deepseek = isDeepSeekModel(options.model);
    if (deepseek) {
      bodyObj.thinking = { type: "enabled" };
    }
    const efforts = this.effortsFor(options.model);
    if (options.reasoningEffort !== void 0 && efforts.includes(options.reasoningEffort)) {
      bodyObj.reasoning_effort = options.reasoningEffort;
    } else if (deepseek && efforts.length > 0) {
      bodyObj.reasoning_effort = this.defaultEffortFor(options.model) ?? (efforts.includes("high") ? "high" : efforts[0]);
    }
    const body = JSON.stringify(bodyObj);
    let response = await this.send(credential, body, options);
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      await this.options.refresh();
      credential = await this.options.resolveCredential();
      if (credential === void 0 || credential.access_token.length === 0) {
        throw new LlmError("buddy: credential expired and refresh failed", "AUTH", { status: response.status });
      }
      response = await this.send(credential, body, options);
    }
    if (!response.ok) {
      let errorText = await response.text().catch(() => "");
      if (this.options.accountPool && isRateLimited(errorText)) {
        const tried = /* @__PURE__ */ new Set();
        if (currentAccountId) tried.add(currentAccountId);
        for (; ; ) {
          const parsed = parseRateLimitError(errorText, options.model);
          if (!parsed) break;
          if (currentAccountId) {
            await this.options.accountPool.updateModelRateLimit(
              currentAccountId,
              parsed.modelId,
              parsed.resetTimeMs
            );
          }
          const next = await this.options.accountPool.getAvailableAccount(
            this.product.id,
            options.model,
            tried
          );
          if (!next || tried.has(next.entry.id)) break;
          tried.add(next.entry.id);
          credential = next.credential;
          currentAccountId = next.entry.id;
          response = await this.send(credential, body, options);
          if (response.ok) {
            yield* this.consumeSse(response, options);
            return;
          }
          errorText = await response.text().catch(() => "");
          if (!isRateLimited(errorText)) {
            throw new LlmError(`buddy: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), { status: response.status });
          }
        }
        throw new LlmError(`buddy: \u6A21\u578B ${options.model} \u6240\u6709\u8D26\u53F7\u5747\u53D7\u9650\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5`, "QUOTA_EXCEEDED");
      }
      throw new LlmError(`buddy: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), { status: response.status });
    }
    yield* this.consumeSse(response, options);
  }
  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  async send(credential, body, options) {
    const headers = new Headers(attributionHeaders());
    headers.set("Authorization", `Bearer ${credential.access_token}`);
    headers.set("Accept", "text/event-stream");
    headers.set("Content-Type", "application/json");
    headers.set(HTTP_HEADER_DOMAIN, credential.domain ?? this.product.apiDomain);
    headers.set(HTTP_HEADER_PRODUCT_CODE, this.product.productCode);
    headers.set("X-Agent-Purpose", "conversation");
    headers.set("X-IDE-Name", this.product.attributionName);
    headers.set("X-IDE-Type", this.product.attributionName);
    headers.set("X-IDE-Version", this.product.clientVersion);
    headers.set(HTTP_HEADER_PRODUCT, this.product.attributionName);
    headers.set("User-Agent", resolveUserAgent(this.product, options.model));
    try {
      return await this.fetchImpl(`${this.product.endpoint}/v2/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (isTransportError(error)) {
        throw new LlmError(`buddy: transport error: ${errorMessage(error)}`, "TRANSPORT", { cause: error });
      }
      throw error;
    }
  }
  /**
   * 消费 SSE 响应并产出 StreamChunk。
   *
   * CodeBuddy 返回标准 OpenAI SSE：`delta.content` 为正文、
   * `delta.reasoning_content` 为思考、`delta.tool_calls` 为工具调用。
   * 流式工具调用仅首个分片携带真实 id（chatcmpl-tool-xxx），后续参数分片
   * 只有 index——按 index 缓存 id 保证同一工具的所有分片 id 一致。
   */
  async *consumeSse(response, options) {
    if (!response.body) throw new LlmError("buddy: empty model response body", "EMPTY_RESPONSE");
    const blocks = [];
    let nextIndex = 0;
    const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : void 0;
    let loopDetected = false;
    const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : void 0;
    let proseLoopDetected = false;
    let proseHasThinkTag = false;
    const suppressor = createBlankReasoningSuppressor();
    const toolCalls = /* @__PURE__ */ new Map();
    const toolOrder = [];
    const toolIds = /* @__PURE__ */ new Map();
    let buffer = "";
    let streamEnded = false;
    let finishReason;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let firstTokenReceived = false;
    try {
      for (; ; ) {
        if (streamEnded) break;
        let result;
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs();
          const phase = firstTokenReceived ? "chunk" : "first-token";
          result = await readWithIdleTimeout(reader, timeoutMs, "buddy", options.signal, phase);
          if (!result.done) firstTokenReceived = true;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (error instanceof LlmError) throw error;
          if (isTransportError(error)) {
            throw new LlmError(`buddy: sse transport error: ${errorMessage(error)}`, "TRANSPORT", { cause: error });
          }
          throw error;
        }
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            streamEnded = true;
            break;
          }
          let data;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          if (data.error !== void 0) {
            throw new LlmError(`buddy: ${data.error.message ?? "unknown error"}`, "SERVER");
          }
          const choice = data.choices?.[0];
          const delta = choice?.delta;
          if (typeof choice?.finish_reason === "string") {
            finishReason = choice.finish_reason;
          }
          if (delta?.content) {
            let block = blocks.find((candidate) => candidate.kind === "text");
            if (block === void 0) {
              block = { index: nextIndex++, kind: "text", text: "" };
              blocks.push(block);
              yield { type: "block-start", index: block.index, blockType: "text" };
            }
            if (proseLoopGuard !== void 0) {
              if (proseLoopGuard.observe(delta.content)) proseLoopDetected = true;
            }
            if (!proseHasThinkTag && delta.content.includes("think:")) proseHasThinkTag = true;
            if (!proseLoopDetected) {
              block.text += delta.content;
              yield { type: "text-delta", index: block.index, text: delta.content };
            }
          }
          if (delta?.reasoning_content) {
            if (loopGuard !== void 0) {
              if (loopGuard.observe(delta.reasoning_content)) loopDetected = true;
            }
            if (!loopDetected) {
              const emit = suppressor.feed(delta.reasoning_content);
              if (emit !== void 0) {
                let block = blocks.find((candidate) => candidate.kind === "reasoning");
                if (block === void 0) {
                  block = { index: nextIndex++, kind: "reasoning", text: "" };
                  blocks.push(block);
                  yield { type: "block-start", index: block.index, blockType: "reasoning" };
                }
                block.text = suppressor.text();
                yield { type: "reasoning-delta", index: block.index, text: emit };
              }
            }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0;
            if (typeof call.id === "string" && call.id.length > 0) {
              toolIds.set(wireIndex, call.id);
            }
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`;
            let block = toolCalls.get(wireIndex);
            if (block === void 0) {
              block = { index: nextIndex++, text: "", callId, announced: false };
              toolCalls.set(wireIndex, block);
            }
            block.callId = callId;
            if (typeof call.function?.name === "string" && call.function.name.length > 0) {
              block.name = call.function.name;
            }
            const fragment = call.function?.arguments ?? "";
            block.text += fragment;
            if (!block.announced) {
              if (!hasUsableToolName(block.name)) continue;
              block.announced = true;
              toolOrder.push(block.index);
              yield { type: "block-start", index: block.index, blockType: "tool-call" };
              yield {
                type: "tool-call-delta",
                index: block.index,
                id: ToolCallId(callId),
                name: block.name,
                argumentsDelta: block.text
              };
              continue;
            }
            yield {
              type: "tool-call-delta",
              index: block.index,
              id: ToolCallId(callId),
              ...block.name !== void 0 ? { name: block.name } : {},
              argumentsDelta: fragment
            };
          }
          if (data.usage) {
            const promptTokens = data.usage.prompt_tokens ?? 0;
            const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens ?? data.usage.prompt_cache_hit_tokens ?? 0;
            const cacheWriteTokens = data.usage.prompt_tokens_details?.cache_write_tokens;
            const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
            yield {
              type: "usage",
              usage: {
                // 与 codearts 一致：inputTokens 只计**未命中缓存**的部分，
                // 命中部分单列 cacheReadTokens，否则缓存命中率显示会偏大。
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
                ...cacheWriteTokens !== void 0 && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
                ...reasoningTokens !== void 0 && reasoningTokens > 0 ? { reasoningTokens } : {}
              }
            };
          }
        }
        if (loopDetected) {
          await reader.cancel().catch(() => {
          });
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    let blockCount = 0;
    const textBlock = blocks.find((block) => block.kind === "text");
    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find((candidate) => candidate.index === index);
      if (!hasUsableToolName(block.name)) continue;
      blockCount += 1;
      yield {
        type: "block-end",
        index,
        block: {
          type: "tool-call",
          id: ToolCallId(block.callId ?? ""),
          name: block.name,
          // 仅把"无参数工具下发的空分片"补成 {}；**残缺参数保持原样**，
          // 由 max-tokens 判定触发重试。切勿把残缺 JSON 也补成 {}——那会
          // 伪造出合法外观，让 harness 报 `missing required property` 而
          // 非重试，掩盖真正的分片丢失。
          arguments: isTruncatedArguments(block.text) ? block.text : normalizeToolArguments(block.text)
        }
      };
    }
    if (textBlock !== void 0) {
      let textOut = textBlock.text;
      if (proseHasThinkTag) {
        const split = splitThinkTaggedContent(textBlock.text);
        if (split !== void 0) {
          if (split.reasoning !== "") {
            const existing = blocks.find((candidate) => candidate.kind === "reasoning");
            if (existing === void 0) {
              blocks.push({ index: nextIndex++, kind: "reasoning", text: split.reasoning });
            } else {
              existing.text += split.reasoning;
            }
            suppressor.feed(split.reasoning);
          }
          textOut = split.text;
        }
      }
      const truncated = proseLoopDetected && proseLoopGuard?.cutAt !== void 0 ? textOut.slice(0, proseLoopGuard.cutAt) : textOut;
      const cleaned = stripCourseLeakIfEnabled(truncated);
      if (cleaned !== "") {
        blockCount += 1;
        yield { type: "block-end", index: textBlock.index, block: { type: "text", text: cleaned } };
      }
    }
    const reasoningBlock = blocks.find((block) => block.kind === "reasoning");
    if (reasoningBlock !== void 0 && reasoningBlock.text.trim() !== "") {
      const suppressedReasoning = suppressor.text();
      const reasoningText = loopDetected && loopGuard?.cutAt !== void 0 ? suppressedReasoning.slice(0, loopGuard.cutAt) : suppressedReasoning;
      const cleanedReasoning = stripCourseLeakIfEnabled(reasoningText);
      if (cleanedReasoning !== "") {
        blockCount += 1;
        yield { type: "block-end", index: reasoningBlock.index, block: { type: "reasoning", text: cleanedReasoning } };
      }
    }
    const argsTruncated = [...toolCalls.values()].some((block) => isTruncatedArguments(block.text));
    const droppedUnnamedCalls = [...toolCalls.values()].some((block) => !block.announced);
    const reason = loopDetected ? { kind: "max-tokens" } : finishReason === "length" || finishReason === void 0 && toolOrder.length > 0 || argsTruncated || droppedUnnamedCalls && toolOrder.length === 0 ? { kind: "max-tokens" } : finishReason === "tool_calls" || toolOrder.length > 0 ? { kind: "tool-calls" } : { kind: "stop" };
    yield { type: "finish", reason: resolveEmptyResponseReason(reason, blockCount) };
  }
}
function isCredentialExpired(credential) {
  const expiresAt = credentialExpiresAtMs(credential);
  return expiresAt === void 0 ? false : Date.now() >= expiresAt;
}
function displayNameFor(model, all) {
  const suffix = displaySuffix(model, all);
  return suffix.length > 0 ? `${model.name} \xB7 ${suffix}` : model.name;
}
function displaySuffix(model, all) {
  const parts = [];
  const rate = formatCreditsRate(model.creditsRate, model.discountedCreditsRate);
  if (rate !== void 0) parts.push(rate);
  const variant = variantLabelFor(model, all);
  if (variant.length > 0) parts.push(variant);
  return parts.join(" ");
}
function variantLabelFor(model, all) {
  const group = all.filter((candidate) => candidate.name === model.name);
  if (group.length <= 1) return "";
  const prefix = commonPrefix(group.map((candidate) => candidate.id));
  const variant = model.id.slice(prefix.length).replace(/^-+/, "");
  return variant.toUpperCase();
}
function commonPrefix(values) {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
}
function positiveMaxTokens(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function registerBuddyLlm(ctx, options) {
  const product = options.product ?? CODEBUDDY;
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: []
    }
  ]);
  const adapter = new BuddyAdapter(options);
  ctx.llm.registerAdapter([product.id], adapter);
  return adapter;
}
export {
  BuddyAdapter,
  CHAT_API_BASE,
  DEFAULT_MODEL,
  PROVIDER,
  registerBuddyLlm
};
