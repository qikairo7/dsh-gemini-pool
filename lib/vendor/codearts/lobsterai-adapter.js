import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId
} from "@deepseek-ai/dsh-llm";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { providerCatalogVisible } from "./account-pool.js";
import { settingsNamespaceFor } from "./settings-compat.js";
import { parseRateLimitError } from "./llm-adapter.js";
import {
  LOBSTERAI_CHAT_PATH,
  LOBSTERAI_MODELS_PATH,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  isLobsteraiExpired,
  lobsteraiChatHeaders,
  lobsteraiKeyfromBody,
  readNumberField,
  readStringField
} from "./lobsterai.js";
import { LOBSTERAI } from "./lobsterai-product.js";
import {
  classifyLobsteraiError,
  classifyLobsteraiStreamError,
  recordsLobsteraiRateLimit,
  shouldRotateLobsteraiAccount
} from "./lobsterai-errors.js";
import { normalizeHarnessMessages } from "./message-shape.js";
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveEmptyResponseReason, resolveToolPairing, splitThinkTaggedContent, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from "./sse.js";
const PROVIDER = "lobsterai";
const EFFORT_NAMES = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
};
const LOBSTERAI_RATE_LIMIT_FALLBACK_MS = 36e5;
const LOBSTERAI_MAX_ROTATE = 3;
const THINKING_LEVELS = /* @__PURE__ */ new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const OPENCLAW_THINKING_LEVELS = /* @__PURE__ */ new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
function parseLobsteraiThinkingConfig(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const record = value;
  const rawOptions = record.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return void 0;
  const options = [];
  const seenLevels = /* @__PURE__ */ new Set();
  const seenWireLevels = /* @__PURE__ */ new Set();
  for (const raw of rawOptions) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
    const entry = raw;
    const level = typeof entry.level === "string" ? entry.level : "";
    const openclawLevel = typeof entry.openclawLevel === "string" ? entry.openclawLevel : "";
    if (!THINKING_LEVELS.has(level) || !OPENCLAW_THINKING_LEVELS.has(openclawLevel)) return void 0;
    if (seenLevels.has(level) || seenWireLevels.has(openclawLevel)) return void 0;
    if (level === "off" !== (openclawLevel === "off")) return void 0;
    seenLevels.add(level);
    seenWireLevels.add(openclawLevel);
    options.push({ level, openclawLevel });
  }
  if (options.length === 1 && options[0].level === "off") return void 0;
  const defaultLevel = typeof record.defaultLevel === "string" ? record.defaultLevel : "";
  if (!seenLevels.has(defaultLevel)) return void 0;
  return { options, defaultLevel };
}
function readLobsteraiModelArray(body) {
  if (typeof body !== "object" || body === null) return [];
  const record = body;
  if ((readNumberField(record, "code") ?? -1) !== 0) return [];
  const data = record.data;
  if (Array.isArray(data)) return data;
  if (typeof data === "object" && data !== null) {
    const nested = data.data;
    if (Array.isArray(nested)) return nested;
  }
  return [];
}
function parseLobsteraiModels(body) {
  const raw = readLobsteraiModelArray(body);
  const models = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item;
    const id = readStringField(record, "modelId");
    if (id.length === 0) continue;
    const name = readStringField(record, "modelName");
    const model = { id, name: name.length > 0 ? name : id };
    const contextWindow = readNumberField(record, "contextWindow");
    if (contextWindow !== void 0 && contextWindow > 0) model.contextWindow = contextWindow;
    const maxTokens = readNumberField(record, "maxTokens");
    if (maxTokens !== void 0 && maxTokens > 0) model.maxTokens = maxTokens;
    if (typeof record.supportsImage === "boolean") model.supportsImage = record.supportsImage;
    if (typeof record.supportsThinking === "boolean") model.supportsThinking = record.supportsThinking;
    const thinkingConfig = parseLobsteraiThinkingConfig(record.thinkingConfig);
    if (thinkingConfig !== void 0) model.thinkingConfig = thinkingConfig;
    if (Array.isArray(record.requestCapabilities)) {
      const capabilities = record.requestCapabilities.filter((c) => typeof c === "string");
      if (capabilities.length > 0) model.requestCapabilities = capabilities;
    }
    const description = readStringField(record, "description");
    if (description.length > 0) model.description = description;
    const costMultiplier = readNumberField(record, "costMultiplier");
    if (costMultiplier !== void 0 && costMultiplier > 0) model.costMultiplier = costMultiplier;
    models.push(model);
  }
  return models;
}
function buildLobsteraiModelsQuery(credential, clientVersion) {
  const body = lobsteraiKeyfromBody(credential, clientVersion);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string" && value.length > 0) params.set(key, value);
  }
  return params.toString();
}
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => typeof block === "object" && block !== null && block.type === "text").map((block) => String(block.text)).join("");
}
const TOOL_RESULT_IMAGE_TEXT = "Attached image(s) from tool result:";
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
function serializeMessages(messages, imageUrls) {
  const wire = [];
  const normalized = normalizeHarnessMessages(messages);
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);
  let pendingToolImages = [];
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    wire.push({
      role: "user",
      content: [{ type: "text", text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages]
    });
    pendingToolImages = [];
  };
  for (const message of normalized) {
    if (message.role === "assistant") {
      const content2 = stripCourseLeakFromHistoryContent(
        message.role,
        Array.isArray(message.content) ? message.content : []
      );
      const toolCalls = content2.filter((block) => typeof block === "object" && block !== null && block.type === "tool-call").filter((block) => keepCallIds.has(String(block.id))).map((block) => ({
        id: String(block.id),
        type: "function",
        function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) }
      }));
      const reasoning = content2.filter((block) => typeof block === "object" && block !== null && block.type === "reasoning").map((block) => String(block.text)).join("");
      const text2 = contentToText(content2);
      flushToolImages();
      wire.push({
        role: "assistant",
        // 正文为空且有工具调用时 content 必须为 null（OpenAI 规范）。
        content: text2.length === 0 && toolCalls.length > 0 ? null : text2,
        ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
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
    const parts = imageUrls === void 0 ? void 0 : userContentParts(regular, imageUrls);
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
      if (imageUrls !== void 0 && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, imageUrls);
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
class LobsteraiStreamError extends LlmError {
  constructor(message, kind, detail, options) {
    super(message, kind === "hard-credit" ? "QUOTA_EXCEEDED" : "SERVER", options);
    this.kind = kind;
    this.detail = detail;
  }
  kind;
  detail;
}
function buildLobsteraiFailure(input) {
  const { kind, status, text, model, fromStream, exhausted } = input;
  const detail = fromStream ? text : errorDetail(text);
  if (kind === "hard-credit") {
    const prefix = exhausted ? `lobsterai: \u6A21\u578B ${model} \u6240\u6709\u8D26\u53F7\u5747\u4E0D\u53EF\u7528` : "lobsterai: \u79EF\u5206\u4E0D\u8DB3";
    return new LlmError(`${prefix}\uFF08${detail}\uFF09`, "QUOTA_EXCEEDED", { status });
  }
  if (exhausted) {
    return new LlmError(
      `lobsterai: \u6A21\u578B ${model} \u6240\u6709\u8D26\u53F7\u5747\u4E0D\u53EF\u7528\uFF08${detail}\uFF09`,
      fromStream ? "SERVER" : httpErrorCode(status),
      { status }
    );
  }
  return new LlmError(`lobsterai: ${detail}`, fromStream ? "SERVER" : httpErrorCode(status), { status });
}
function errorDetail(body) {
  try {
    const data = JSON.parse(body);
    const parts = [
      typeof data.code === "number" || typeof data.code === "string" ? `code=${String(data.code)}` : void 0,
      typeof data.message === "string" ? data.message : void 0,
      typeof data.msg === "string" ? data.msg : void 0
    ].filter((value) => value !== void 0);
    if (parts.length > 0) return parts.join(" ");
  } catch {
  }
  return body;
}
function httpErrorCode(status) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) return "INVALID_REQUEST";
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
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
function resolveFirstTokenTimeoutMs() {
  return Number.parseInt(process.env.DSH_LOBSTERAI_SSE_FIRST_TOKEN_TIMEOUT_MS ?? "", 10) || 12e4;
}
function resolveChunkTimeoutMs() {
  return Number.parseInt(process.env.DSH_LOBSTERAI_SSE_CHUNK_TIMEOUT_MS ?? "", 10) || 12e4;
}
class LobsteraiAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
    this.product = options.product ?? LOBSTERAI;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallbackIndex = new Map(
      (this.product.fallbackModels ?? []).map((model) => [model.id, model])
    );
  }
  options;
  product;
  fetchImpl;
  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  remoteModels;
  /** 远端下发的模型元数据（id → 条目），listModels/resolveModel 共用。 */
  remoteMeta = /* @__PURE__ */ new Map();
  /** 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。 */
  fallbackIndex;
  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
   * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider) {
    const id = typeof provider === "string" && provider.length > 0 ? provider : this.product.id;
    return { id, name: this.product.displayName };
  }
  /**
   * 懒加载远端模型目录（仅拉取一次）。
   *
   * `listModels` 与 `resolveModel` 共用：`resolveModel` 可能先于 `listModels`
   * 被调用（如直接从历史会话进入），此时同样需要触发一次拉取。
   */
  async ensureRemoteModels() {
    if (this.remoteModels !== void 0 || this.options.fetchRemoteModels === void 0) return;
    try {
      const models = await this.options.fetchRemoteModels();
      if (models.length > 0) {
        this.remoteModels = models;
        this.remoteMeta = new Map(models.map((model) => [model.id, model]));
      }
    } catch {
    }
  }
  /**
   * 模型接受的输入模态。
   *
   * 远端 `supportsImage` 是权威来源（实测 26 个模型里 19 个为 true）。
   * 远端未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
   * 也不要报一个服务端不认的模态（请求会以 400 失败）。
   */
  inputModalitiesFor(model) {
    return this.remoteMeta.get(model)?.supportsImage === true ? ["text", "image"] : ["text"];
  }
  /**
   * 模型的上下文窗口：远端权威值优先，兜底表估值次之。
   *
   * 兜底表统一写 131072，而实测远端多数模型返回 1000000 —— 采信估值会让
   * DSH 在远未用满窗口时就触发上下文压缩。
   */
  contextWindowFor(model) {
    return this.remoteMeta.get(model)?.contextWindow ?? this.fallbackIndex.get(model)?.contextWindow;
  }
  /**
   * 模型可选的思考档位。
   *
   * ## `id` 与 `name` 的来源**不同**（这是本方法最容易搞错的地方）
   *
   * - **`id` = `openclawLevel`（wire 值）**：DSH 会把选中的 id 原样写进请求体的
   *   `reasoning_effort`，故必须是服务端认的取值。⚠️ wire 侧**没有 `max`** ——
   *   实测直接发 `reasoning_effort: 'max'` 与不带参数**无差异**（走服务端默认），
   *   发 `'xhigh'` 才真正触发最高档。
   * - **`name` = `level`（产品侧档位名）**：纯展示。远端把 `level: 'max'` 映射到
   *   `openclawLevel: 'xhigh'`，用户在产品侧看到的就是 **Max**。
   *
   * ⚠️ **历史缺陷**（用户报障 / Issue #IKHCZF）：早期用 `openclawLevel` 同时查
   * 展示名表，于是最强档显示成 **XHigh**，与产品侧命名 **Max** 不一致 ——
   * 用户按 IDE 里的「Max」找，界面上却只有「XHigh」。
   * 根因是把「wire 值」与「展示名」当成同一个概念。
   *
   * 无 `thinkingConfig` 的模型不声明 `reasoning`，UI 显示「当前模型未提供推理等级」，
   * 而不是给一个发了也没用的档位。
   */
  reasoningFor(model) {
    const config = this.remoteMeta.get(model)?.thinkingConfig;
    if (config === void 0) return void 0;
    const defaultWire = config.options.find((option) => option.level === config.defaultLevel)?.openclawLevel;
    return {
      efforts: config.options.map((option) => ({
        id: ReasoningEffortId(option.openclawLevel),
        // 展示名优先用**产品侧 `level`**（含 `max`），再回退到按 wire 值查表。
        // 回退分支只为兼容「上游只给 wire 值」的异常形态，正常不会走到。
        name: EFFORT_NAMES[option.level] ?? EFFORT_NAMES[option.openclawLevel] ?? option.level
      })),
      ...defaultWire !== void 0 ? { defaultEffort: ReasoningEffortId(defaultWire) } : {}
    };
  }
  /**
   * 静态兜底模型目录。
   *
   * **不做 buddy 那样的「以兜底表为准」裁剪**（`reconcileWithFallback`）：
   * LobsterAI 的远端接口是**权威的**（产品兜底表本身就是从它实测抄来的），
   * 远端可用时应完全采信，兜底只在远端整体失败时顶替。
   *
   * ⚠️ 兜底表**不含 `costMultiplier`**：它是编译期快照，而价格会变；
   * 远端整体失败时拿不到权威倍率，此时**不显示**倍率（不猜）。
   */
  staticFallbackModels() {
    return this.product.fallbackModels.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow
    }));
  }
  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
   */
  listAllModels() {
    const source = this.remoteModels ?? this.staticFallbackModels();
    return source.map((model) => ({ id: model.id, name: displayNameFor(model) }));
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
      // 倍率写进 name（**不是** description）：composer 的模型切换菜单只渲染
      // `name`，description 仅用于 /model 弹窗。见 displayNameFor 的说明。
      name: displayNameFor(model),
      ...model.description !== void 0 ? { description: model.description } : {},
      // 远端 supportsImage 权威；未声明时保守报 text（见 inputModalitiesFor）。
      inputModalities: this.inputModalitiesFor(model.id)
    }));
  }
  async resolveModel(provider, model, _signal) {
    await this.ensureRemoteModels();
    const remoteName = this.remoteMeta.get(model)?.name;
    const resolved = {
      provider,
      id: model,
      name: remoteName ?? this.fallbackIndex.get(model)?.name ?? model,
      inputModalities: this.inputModalitiesFor(model)
    };
    const contextWindow = this.contextWindowFor(model);
    if (contextWindow !== void 0) resolved.context = { contextWindow };
    const maxTokens = this.remoteMeta.get(model)?.maxTokens;
    if (maxTokens !== void 0) resolved.defaultMaxTokens = maxTokens;
    const reasoning = this.reasoningFor(model);
    if (reasoning !== void 0) resolved.reasoning = reasoning;
    return resolved;
  }
  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` 同款 shim。
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    };
  }
  /** 解析客户端版本号（未注入时用兜底值）。 */
  async clientVersion() {
    if (this.options.resolveClientVersion === void 0) return this.product.fallbackClientVersion;
    try {
      return await this.options.resolveClientVersion();
    } catch {
      return this.product.fallbackClientVersion;
    }
  }
  async *stream(options) {
    await this.ensureRemoteModels();
    const imageRefs = /* @__PURE__ */ new Map();
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs);
    }
    let imageUrls;
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes("image")) {
        throw new LlmError(
          `lobsterai: \u6A21\u578B "${options.model}" \u4E0D\u652F\u6301\u56FE\u7247\u8F93\u5165`,
          "UNSUPPORTED_CONTENT"
        );
      }
      if (this.options.readImage === void 0) {
        throw new LlmError("lobsterai: \u56FE\u7247\u8F93\u5165\u9700\u8981\u9644\u4EF6\u670D\u52A1", "UNSUPPORTED_CONTENT");
      }
      imageUrls = /* @__PURE__ */ new Map();
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref);
        if (image === void 0) continue;
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`);
      }
    }
    let credential = await this.options.resolveCredential();
    if (credential === void 0 || isLobsteraiExpired(credential)) {
      await this.options.refresh();
      credential = await this.options.resolveCredential();
    }
    if (credential === void 0 || credential.access_token.length === 0) {
      throw new LlmError("lobsterai: no usable credential; log in first", "MISSING_CREDENTIAL");
    }
    let currentAccountId = "";
    if (this.options.accountPool) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id,
          credential.access_token
        );
        if (currentAccountId === "") {
          console.warn("[lobsterai] \u5F53\u524D\u51ED\u636E\u672A\u5339\u914D\u5230\u8D26\u53F7\u6C60\u6761\u76EE\uFF0C\u9650\u6D41\u8BB0\u5F55\u5C06\u88AB\u8DF3\u8FC7");
        }
      } catch (error) {
        console.warn("[lobsterai] \u8D26\u53F7\u5339\u914D\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u672C\u6B21\u8BF7\u6C42\uFF09:", error);
      }
    }
    const messages = serializeMessages(options.messages, imageUrls);
    if (options.system !== void 0 && options.system.length > 0) {
      messages.unshift({ role: "system", content: options.system });
    }
    const tools = options.tools?.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));
    const bodyObj = {
      model: options.model,
      messages,
      // **恒为 true**：上游只支持 SSE，stream:false 会返回 500
      // （`client.go:168-195` prepareChatBody 强制改写）。
      stream: true
    };
    if (tools !== void 0 && tools.length > 0) bodyObj.tools = tools;
    if (options.temperature !== void 0) bodyObj.temperature = options.temperature;
    if (options.maxTokens !== void 0) bodyObj.max_tokens = options.maxTokens;
    if (options.stop !== void 0 && options.stop.length > 0) bodyObj.stop = options.stop;
    if (options.reasoningEffort !== void 0) {
      bodyObj.reasoning_effort = options.reasoningEffort;
    }
    const body = JSON.stringify(bodyObj);
    let response = await this.send(credential, body, options);
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      await this.options.refresh();
      const refreshed = await this.options.resolveCredential();
      if (refreshed === void 0 || refreshed.access_token.length === 0) {
        throw new LlmError("lobsterai: credential expired and refresh failed", "AUTH", { status: response.status });
      }
      credential = refreshed;
      response = await this.send(credential, body, options);
    }
    const tried = /* @__PURE__ */ new Set();
    if (currentAccountId) tried.add(currentAccountId);
    let lastStatus = response.status;
    let lastKind = "none";
    let lastText = "";
    let lastFromStream = false;
    for (let attempt = 0; ; attempt++) {
      if (response.ok) {
        let emitted = false;
        try {
          for await (const chunk of this.consumeSse(response, options)) {
            emitted = true;
            yield chunk;
          }
          return;
        } catch (error) {
          if (!(error instanceof LobsteraiStreamError)) throw error;
          if (emitted) throw error;
          lastFromStream = true;
          lastStatus = response.status;
          lastKind = error.kind;
          lastText = error.detail;
        }
      } else {
        lastFromStream = false;
        lastText = await response.text().catch(() => "");
        lastStatus = response.status;
        lastKind = classifyLobsteraiError(lastStatus, lastText);
      }
      if (currentAccountId && recordsLobsteraiRateLimit(lastKind)) {
        const parsed = parseRateLimitError(lastText, options.model);
        await this.options.accountPool.updateModelRateLimit(
          currentAccountId,
          parsed?.modelId ?? options.model,
          // `parseRateLimitError` 内部要求错误体是 JSON（它 `JSON.parse` 取 msg），
          // 而部分上游/网关会用**纯文本** 429。此时它返回 null，这里用
          // 「1 小时后」兜底 —— 与它自己 JSON 路径下的 fallback 同一口径，
          // 也与本插件「标记只是快照、可主动重测」的语义一致。
          parsed?.resetTimeMs ?? Date.now() + LOBSTERAI_RATE_LIMIT_FALLBACK_MS
        );
      }
      if (!this.options.accountPool || !shouldRotateLobsteraiAccount(lastKind)) {
        throw buildLobsteraiFailure({
          kind: lastKind,
          status: lastStatus,
          text: lastText,
          model: options.model,
          fromStream: lastFromStream,
          exhausted: false
        });
      }
      if (attempt >= LOBSTERAI_MAX_ROTATE - 1) {
        throw buildLobsteraiFailure({
          kind: lastKind,
          status: lastStatus,
          text: lastText,
          model: options.model,
          fromStream: lastFromStream,
          exhausted: true
        });
      }
      const next = await this.options.accountPool.getAvailableAccount(
        this.product.id,
        options.model,
        tried
      );
      if (!next || tried.has(next.entry.id)) {
        throw buildLobsteraiFailure({
          kind: lastKind,
          status: lastStatus,
          text: lastText,
          model: options.model,
          fromStream: lastFromStream,
          exhausted: true
        });
      }
      tried.add(next.entry.id);
      credential = next.credential;
      currentAccountId = next.entry.id;
      response = await this.send(credential, body, options);
    }
  }
  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  async send(credential, body, options) {
    const clientVersion = await this.clientVersion();
    const headers = new Headers(lobsteraiChatHeaders(credential, this.product, clientVersion));
    try {
      return await this.fetchImpl(`${this.product.apiBase}${LOBSTERAI_CHAT_PATH}`, {
        method: "POST",
        headers,
        body,
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (isTransportError(error)) {
        throw new LlmError(`lobsterai: transport error: ${errorMessage(error)}`, "TRANSPORT", { cause: error });
      }
      throw error;
    }
  }
  /**
   * 消费 SSE 响应并产出 `StreamChunk`。
   *
   * 上游返回标准 OpenAI SSE。移植了 Go 侧 `Aggregate` 的三处兼容处理：
   * 1. **容忍 `data:` 后无空格**（`sse.go:37-39` 注释写明「龙虾上游实测无空格」）——
   *    这里靠 `line.slice(5).trim()` 天然兼容两种形态；
   * 2. `reasoning_content` 单独成块（`sse.go:74-76`）；
   * 3. `tool_calls` 按 `index` 合并（首片带 id/name，后续只带 arguments 片段）。
   *
   * 额外保留 buddy 适配器里两条实测得出的防坑规则（与厂商无关，属协议层）：
   * - **`function.name` 只允许非空覆盖**：后续分片带空串 `""`，
   *   直接覆盖会清空已解析出的工具名 → `unknown tool ""`；
   * - **`finish_reason` 映射顺序**：`length` / 中途断流 / 参数残缺一律归为
   *   `max-tokens`，否则 harness 会执行残缺 JSON 参数并污染会话历史。
   */
  async *consumeSse(response, options) {
    if (!response.body) throw new LlmError("lobsterai: empty model response body", "EMPTY_RESPONSE");
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
    let gotAnyContent = false;
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
          result = await readWithIdleTimeout(reader, timeoutMs, "lobsterai", options.signal, phase);
          if (!result.done) firstTokenReceived = true;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (error instanceof LlmError) throw error;
          if (isTransportError(error)) {
            throw new LlmError(`lobsterai: sse transport error: ${errorMessage(error)}`, "TRANSPORT", { cause: error });
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
            const detail = data.error.message ?? "unknown error";
            throw new LobsteraiStreamError(
              `lobsterai: ${detail}`,
              classifyLobsteraiStreamError(detail),
              detail
            );
          }
          const choice = data.choices?.[0];
          const delta = choice?.delta;
          if (typeof choice?.finish_reason === "string") {
            finishReason = choice.finish_reason;
          }
          const deltaContent = delta?.content;
          const textDelta = typeof deltaContent === "string" && deltaContent.length > 0 ? deltaContent : !gotAnyContent && typeof choice?.message?.content === "string" ? choice.message.content : void 0;
          if (textDelta !== void 0 && textDelta.length > 0) {
            if (typeof deltaContent === "string" && deltaContent.length > 0) gotAnyContent = true;
            let block = blocks.find((candidate) => candidate.kind === "text");
            if (block === void 0) {
              block = { index: nextIndex++, kind: "text", text: "" };
              blocks.push(block);
              yield { type: "block-start", index: block.index, blockType: "text" };
            }
            if (proseLoopGuard !== void 0) {
              if (proseLoopGuard.observe(textDelta)) proseLoopDetected = true;
            }
            if (!proseHasThinkTag && textDelta.includes("think:")) proseHasThinkTag = true;
            if (!proseLoopDetected) {
              block.text += textDelta;
              yield { type: "text-delta", index: block.index, text: textDelta };
            }
          }
          if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) {
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
            if (typeof call.id === "string" && call.id.length > 0) toolIds.set(wireIndex, call.id);
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
            const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
            yield {
              type: "usage",
              usage: {
                // inputTokens 只计**未命中缓存**的部分，命中部分单列
                // cacheReadTokens，否则缓存命中率显示会偏大。
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
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
      blockCount += 1;
      yield {
        type: "block-end",
        index,
        block: {
          type: "tool-call",
          id: ToolCallId(block.callId ?? ""),
          name: block.name,
          // 仅把「无参数工具下发的空分片」补成 {}；**残缺参数保持原样**，
          // 由 max-tokens 判定触发重试 —— 把残缺 JSON 补成 {} 会伪造出
          // 合法外观，让 harness 报 missing required property 而非重试。
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
function displayNameFor(model) {
  if (model.costMultiplier === void 0) return model.name;
  return `${model.name} \xB7 x${model.costMultiplier}`;
}
function registerLobsteraiLlm(ctx, options) {
  const product = options.product ?? LOBSTERAI;
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: []
    }
  ]);
  const adapter = new LobsteraiAdapter(options);
  ctx.llm.registerAdapter([product.id], adapter);
  return adapter;
}
function buildLobsteraiModelsUrl(product, credential, clientVersion) {
  const query = buildLobsteraiModelsQuery(credential, clientVersion);
  const base = `${product.apiBase}${LOBSTERAI_MODELS_PATH}`;
  return query.length > 0 ? `${base}?${query}` : base;
}
const LOBSTERAI_MODELS_TIMEOUT_MS = LOBSTERAI_REQUEST_TIMEOUT_MS;
export {
  LOBSTERAI_MODELS_TIMEOUT_MS,
  LobsteraiAdapter,
  PROVIDER,
  buildLobsteraiModelsQuery,
  buildLobsteraiModelsUrl,
  parseLobsteraiModels,
  parseLobsteraiThinkingConfig,
  readLobsteraiModelArray,
  registerLobsteraiLlm
};
