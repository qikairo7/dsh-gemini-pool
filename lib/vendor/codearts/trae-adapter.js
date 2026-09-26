import { LlmAdapter, LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { providerCatalogVisible } from "./account-pool.js";
import { settingsNamespaceFor } from "./settings-compat.js";
import {
  TRAE_MAX_CONTEXT_TOKENS,
  clampTraeMaxTokens,
  isTraeExpired,
  parseTraeSSELine,
  isTraeModelCallable,
  traeMaxModeFields,
  traeSOLOHeaders,
  transformToSOLOBody
} from "./trae.js";
import { TRAE } from "./trae-product.js";
import { classifyTraeError, recordsTraeRateLimit, shouldRotateTraeAccount } from "./trae-errors.js";
import { normalizeHarnessMessages } from "./message-shape.js";
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveEmptyResponseReason, resolveToolPairing, splitThinkTaggedContent, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from "./sse.js";
const PROVIDER = "trae";
const TRAE_EFFORT_NAMES = {
  light: "Light",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  extra_high: "Extra High",
  xhigh: "XHigh",
  max: "Max"
};
const TRAE_EFFORT_RANK = {
  off: 0,
  none: 0,
  minimal: 1,
  light: 2,
  low: 3,
  medium: 4,
  high: 5,
  extra_high: 6,
  xhigh: 7,
  max: 8
};
function strongestTraeEffort(options) {
  if (options.length === 0) return void 0;
  if (options.includes("max")) return "max";
  let best;
  let bestRank = -1;
  for (const option of options) {
    const rank = Object.prototype.hasOwnProperty.call(TRAE_EFFORT_RANK, option) ? TRAE_EFFORT_RANK[option] : void 0;
    if (rank !== void 0 && rank > bestRank) {
      best = option;
      bestRank = rank;
    }
  }
  return best ?? options[options.length - 1];
}
function defaultTraeEffort(config, fallback) {
  const declared = config.defaultLevel;
  if (declared !== void 0 && declared.length > 0 && config.options.includes(declared)) {
    return declared;
  }
  return fallback;
}
function resolveFirstTokenTimeoutMs() {
  return Number.parseInt(process.env.DSH_TRAE_SSE_FIRST_TOKEN_TIMEOUT_MS ?? "", 10) || 12e4;
}
function resolveChunkTimeoutMs() {
  return Number.parseInt(process.env.DSH_TRAE_SSE_CHUNK_TIMEOUT_MS ?? "", 10) || 12e4;
}
const TRAE_RATE_LIMIT_FALLBACK_MS = 36e5;
const TRAE_MAX_ROTATE = 3;
const TRAE_MACHINE_ID_ROTATE_EVERY = 4;
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
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
function serializeTraeMessages(messages, imageUrls) {
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
        function: {
          name: String(block.name),
          arguments: normalizeToolArguments(String(block.arguments))
        }
      }));
      const text2 = contentToText(content2);
      wire.push({
        role: "assistant",
        content: text2.length === 0 && toolCalls.length > 0 ? null : text2,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
      });
      continue;
    }
    if (message.role === "system") {
      wire.push({ role: "system", content: contentToText(message.content) });
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const toolResults = content.filter(
      (block) => typeof block === "object" && block !== null && block.type === "tool-result"
    );
    const text = contentToText(message.content);
    const parts = imageUrls === void 0 ? void 0 : userContentParts(content, imageUrls);
    if (parts !== void 0) {
      flushToolImages();
      wire.push({ role: "user", content: parts });
    } else if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      if (!keepResultIds.has(String(result.toolCallId))) continue;
      const innerParts = imageUrls === void 0 ? void 0 : Array.isArray(result.content) ? userContentParts(result.content, imageUrls) : void 0;
      if (innerParts !== void 0) {
        pendingToolImages.push(...innerParts.filter((part) => part.type === "image_url"));
      }
      wire.push({
        role: "tool",
        tool_call_id: String(result.toolCallId),
        content: contentToText(result.content) || (innerParts !== void 0 ? TOOL_RESULT_IMAGE_TEXT : "(no output)")
      });
    }
    flushToolImages();
  }
  return wire;
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
function traeStreamErrorMessage(code, message, model) {
  const base = `trae: ${message} (code=${code})`;
  if (code !== 4001) return base;
  return `${base} \u2014\u2014 \u6A21\u578B\u300C${model}\u300D\u4E0D\u88AB\u4E0A\u6E38\u63A5\u53D7\uFF1A\u5B83\u901A\u5E38\u662F\u300C\u4EC5\u53EF\u89C1\u4F46\u4E0D\u53EF\u8C03\u7528\u300D\u7684\u81EA\u5B9A\u4E49\u6A21\u578B\uFF08\u9700\u5148\u5728 TRAE IDE \u5185\u81EA\u884C\u914D\u7F6E\u4F9B\u5E94\u5546\uFF09\uFF0C\u8BF7\u6539\u7528\u6A21\u578B\u5217\u8868\u4E2D\u7684\u5176\u5B83\u6A21\u578B`;
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
function traeDisplayName(model) {
  const rate = model.creditsRate;
  if (rate === void 0) return model.name;
  const current = rate === 0 ? "\u514D\u8D39" : `x${rate}`;
  const original = model.originalCreditsRate;
  if (original !== void 0 && original > rate) {
    return `${model.name} \xB7 x${original}\u2192${current}`;
  }
  return `${model.name} \xB7 ${current}`;
}
class TraeAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
    this.product = options.product ?? TRAE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallbackIndex = new Map(
      (this.product.fallbackModels ?? []).map((model) => [model.id, model])
    );
  }
  options;
  product;
  fetchImpl;
  /** 动态模型缓存。 */
  remoteModels;
  /** 远端模型元数据索引。 */
  remoteMeta = /* @__PURE__ */ new Map();
  /** 产品级兜底模型索引。 */
  fallbackIndex;
  /**
   * 已发起的 chat 请求计数（仅在启用机器指纹轮换时使用，见
   * {@link TraeAdapter.machineIdGeneration}）。
   */
  sendCount = 0;
  providerInfo(provider) {
    const id = typeof provider === "string" && provider.length > 0 ? provider : this.product.id;
    return { id, name: this.product.displayName };
  }
  /** 懒加载远端模型目录（仅拉取一次）。 */
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
   * 模型接受的输入模态 —— **逐模型**判定，不是按 provider 一刀切。
   *
   * 判据是远端 `display_config.multimodal`（见
   * {@link TraeRemoteModel.multimodal} 的实测记录）：
   *
   * - `true` → `['text', 'image']`
   * - `false` / **未声明** → `['text']`（保守：兜底表没有该字段，
   *   且「远端没说」不等于「远端支持」）
   *
   * ⚠️ **这里返回的 `image` 是 DSH 的准入闸门**：不声明 `image` 时，图片会在
   * **附件入库阶段**就被拒（`session/attachment-invalid`），用户看到
   * 「当前模型不支持图片」——而图根本没发到上游。因此漏报 `image` 不只是
   * 「少个功能」，而是「连降级成文本占位符的机会都没有」。
   *
   * **历史缺陷**（Issue #IKHDKC）：早期这里恒返回 `['text']`（参数名甚至是
   * `_model`，即刻意忽略模型），理由是「SOLO 通道未见图片能力」—— 实测证伪：
   * 远端一直在目录里声明该能力，且直发图片后模型真的看得见。
   */
  inputModalitiesFor(model) {
    return this.remoteMeta.get(model)?.multimodal === true ? ["text", "image"] : ["text"];
  }
  /**
   * 该模型所属的聊天通道（`function`）。
   *
   * ⚠️ **模型只在列出它的通道里可调用**：发错通道上游会回流内
   * `code=4001 param is invalid`（实测 `glm-5.1` 在 `solo_work_lite` 报错、
   * 在 `solo_agent_remote` 正常；`glm-5-turbo` 恰好相反）。
   * 远端目录里每条模型都带自己的 `function`；查不到时回退默认通道。
   */
  channelFor(model) {
    const channel = this.remoteMeta.get(model)?.function;
    return channel !== void 0 && channel.length > 0 ? channel : this.product.function;
  }
  /**
   * 模型的上下文窗口：远端优先，兜底表次之。
   *
   * ⚠️ 开启 Max 模式时改用 `context_window_tokens.max`（1M）。两者**不能混用**：
   * 未开 Max 却声明 1M 会让 DSH 把超长上下文直接发出去，而上游按 200K 校验后
   * 拒绝（输入被截断或 4xx）。
   */
  contextWindowFor(model) {
    const meta = this.remoteMeta.get(model);
    if (this.maxModeFor(model)) {
      return meta?.maxContextWindow ?? TRAE_MAX_CONTEXT_TOKENS;
    }
    return meta?.contextWindow ?? this.fallbackIndex.get(model)?.contextWindow;
  }
  /**
   * 该模型本次是否启用 **Max 模式**（1M 上下文）。
   *
   * 三个条件缺一不可（对齐 `Trae2api-cn/trae_remote_client.py:249-277`）：
   * 1. 产品级开关（`DSH_TRAE_MAX_MODE`）未关 —— **默认开启**，用户要求
   *    「上下文用最大的那一档」；显式设 `0` / `false` 才关回 200K；
   * 2. 远端 `display_config.max_mode === true` —— **绝不**给未标记的模型硬套
   *    Max 参数，上游会拒绝（`_max_mode_requested` 的注释明写
   *    "Never fabricate max limits for a model the account config does not mark"）；
   * 3. 若配置了白名单，模型须在其中。
   */
  maxModeFor(model) {
    if (this.product.maxMode !== true) return false;
    const meta = this.remoteMeta.get(model);
    if (meta === void 0 || meta.maxMode !== true) return false;
    const whitelist = this.product.maxModeModels;
    if (whitelist !== void 0 && whitelist.length > 0 && !whitelist.includes("*")) {
      return whitelist.includes(model);
    }
    return true;
  }
  /**
   * 模型可选的推理强度档位（`reasoning_effort_config`）。
   *
   * TRAE 的 `options` 是**单值字符串**（既是产品侧档位名、也是 wire 值），
   * 与 LobsterAI 的 `level` / `openclawLevel` 双字段形态不同，故不需要映射表
   * 之外的转换（命名仅用于展示）。
   *
   * 不声明 `reasoning` 的两种情形：
   * - 远端没有该配置 → UI 显示「当前模型未提供推理等级」（而不是给个发了没用的档位）
   * - `support_thinking === false` → 远端明确说不支持思考
   *
   * `defaultEffort` 必须落在 `efforts` 内（DSH 会拿它直接发请求），远端数据
   * 不一致时退化为不声明默认值。
   */
  reasoningFor(model) {
    const config = this.remoteMeta.get(model)?.reasoningConfig;
    if (config === void 0) return void 0;
    if (config.supportThinking === false) return void 0;
    if (config.options.length === 0) return void 0;
    const efforts = config.options.map((option) => ({
      id: ReasoningEffortId(option),
      name: TRAE_EFFORT_NAMES[option] ?? option
    }));
    const fallback = strongestTraeEffort(config.options);
    const chosen = defaultTraeEffort(config, fallback);
    return {
      efforts,
      ...chosen !== void 0 ? { defaultEffort: ReasoningEffortId(chosen) } : {}
    };
  }
  /**
   * 模型的输出上限：远端优先 → 兜底表 → 产品级兜底值。
   *
   * ⚠️ 实测远端主流模型声明的是 **32000**，而兜底表旧值写的 128000 会让
   * DSH 索要一个上游不接受的值。远端可用时一律以远端为准。
   */
  maxOutputTokensFor(model) {
    const meta = this.remoteMeta.get(model);
    if (this.maxModeFor(model) && meta?.maxModeOutputTokens !== void 0) {
      return meta.maxModeOutputTokens;
    }
    return meta?.maxOutputTokens ?? this.product.fallbackMaxOutputTokens;
  }
  /**
   * 静态兜底模型目录。
   *
   * 始终过滤 `isHidden === true` 的条目（这些是上游内部/隐藏模型，不应出现在
   * 对话模型目录中）。与远端路径的过滤逻辑一致（`parseTraeBatchModelList` 中也
   * 硬性过滤 `isHidden === true`）。
   */
  staticFallbackModels() {
    return this.product.fallbackModels.filter((model) => model.isHidden !== true).map((model) => ({ id: model.id, name: model.name }));
  }
  /**
   * 完整模型目录（**不应用用户黑名单**）。
   *
   * ## 为什么需要它
   *
   * `listModels` 会按用户黑名单过滤（Jet Hub「显示列表」开关），于是**被关闭的
   * 模型不在其返回值里**。而设置页必须把关闭的模型也渲染出来（否则用户无法重新
   * 打开），RPC 层只能凭黑名单的 key（裸 id）补回 —— 那条路径拿不到展示名，
   * 只能回退成裸 id，**倍率与模型显示名随之丢失**（用户报障：「关闭的就没有显示
   * 倍率，关闭的应该也显示倍率」）。
   *
   * 故这里提供「不过滤黑名单」的目录，由 `model.list` 端点使用：它据此拿到
   * 每个 id 的**真实展示名（含倍率）**，再自行回填 `disabled` 状态。
   * 对话框模型选择器读的仍是 `listModels`（已过滤），可见性行为不变。
   */
  listAllModels() {
    const source = this.remoteModels === void 0 ? this.staticFallbackModels() : this.remoteModels.filter((model) => isTraeModelCallable(model) && model.isHidden !== true);
    return source.map((model) => ({ id: model.id, name: traeDisplayName(model) }));
  }
  async listModels(_provider) {
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return [];
    await this.ensureRemoteModels();
    const source = this.listAllModels();
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
    const listed = disabled === void 0 || disabled.size === 0 ? source : source.filter((model) => !disabled.has(model.id));
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      // ⚠️ 逐模型判定（远端 `display_config.multimodal`）—— 早期这里硬编码
      // `['text']`，导致 DSH 在附件准入阶段就拒掉图片（Issue #IKHDKC）。
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
      // ⚠️ 与 listModels 同源：必须逐模型判定，否则准入闸门仍会拦下图。
      inputModalities: this.inputModalitiesFor(model)
    };
    const contextWindow = this.contextWindowFor(model);
    if (contextWindow !== void 0) resolved.context = { contextWindow };
    const maxTokens = this.maxOutputTokensFor(model);
    if (maxTokens !== void 0) resolved.defaultMaxTokens = maxTokens;
    const reasoning = this.reasoningFor(model);
    if (reasoning !== void 0) resolved.reasoning = reasoning;
    return resolved;
  }
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    };
  }
  async *stream(options) {
    await this.ensureRemoteModels();
    let credential = await this.options.resolveCredential();
    if (credential === void 0 || isTraeExpired(credential)) {
      await this.options.refresh();
      credential = await this.options.resolveCredential();
    }
    if (credential === void 0 || credential.access_token.length === 0) {
      throw new LlmError("trae: no usable credential; log in first", "MISSING_CREDENTIAL");
    }
    let currentAccountId = "";
    if (this.options.accountPool) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id,
          credential.access_token
        );
      } catch {
      }
    }
    const imageRefs = /* @__PURE__ */ new Map();
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs);
    }
    let imageUrls;
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes("image")) {
        throw new LlmError(
          `trae: model "${options.model}" does not accept image input.`,
          "UNSUPPORTED_CONTENT"
        );
      }
      if (this.options.readImage === void 0) {
        throw new LlmError(
          "trae: image input requires the attachment service; confirm the profile loads @deepseek-ai/dsh-attachment-local.",
          "UNSUPPORTED_CONTENT"
        );
      }
      imageUrls = /* @__PURE__ */ new Map();
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref);
        if (image === void 0) continue;
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`);
      }
    }
    const wireMessages = serializeTraeMessages(options.messages, imageUrls);
    const openaiBody = {
      model: options.model,
      messages: wireMessages,
      stream: true
    };
    if (options.tools !== void 0 && options.tools.length > 0) {
      openaiBody.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
    }
    if (options.temperature !== void 0) openaiBody.temperature = options.temperature;
    const maxTokens = clampTraeMaxTokens(options.maxTokens);
    if (maxTokens !== void 0) openaiBody.max_tokens = maxTokens;
    if (options.stop !== void 0 && options.stop.length > 0) openaiBody.stop = options.stop;
    if (options.reasoningEffort !== void 0) {
      openaiBody.reasoning_effort = options.reasoningEffort;
    }
    if (this.maxModeFor(options.model)) {
      const meta = this.remoteMeta.get(options.model);
      Object.assign(
        openaiBody,
        traeMaxModeFields(
          meta?.maxContextWindow ?? TRAE_MAX_CONTEXT_TOKENS,
          meta?.maxModeOutputTokens
        )
      );
    }
    if (options.system !== void 0 && options.system.length > 0) {
      openaiBody.messages = [
        { role: "system", content: options.system },
        ...wireMessages
      ];
    }
    openaiBody.messages = trimTraeHistory(openaiBody.messages);
    const bodyObj = transformToSOLOBody(openaiBody, void 0, this.channelFor(options.model));
    const body = JSON.stringify(bodyObj);
    let response = await this.send(credential, body, options);
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      await this.options.refresh();
      const refreshed = await this.options.resolveCredential();
      if (refreshed === void 0 || refreshed.access_token.length === 0) {
        throw new LlmError("trae: credential expired and refresh failed", "AUTH", { status: response.status });
      }
      credential = refreshed;
      response = await this.send(credential, body, options);
    }
    if (!response.ok) {
      let errorText = await response.text().catch(() => "");
      let lastStatus = response.status;
      let lastKind = classifyTraeError(response.status, errorText);
      if (this.options.accountPool && shouldRotateTraeAccount(lastKind)) {
        const tried = /* @__PURE__ */ new Set();
        if (currentAccountId) tried.add(currentAccountId);
        const maxRotate = TRAE_MAX_ROTATE - 1;
        for (let round = 0; round < maxRotate; round++) {
          if (currentAccountId && recordsTraeRateLimit(lastKind)) {
            await this.options.accountPool.updateModelRateLimit(
              currentAccountId,
              options.model,
              Date.now() + TRAE_RATE_LIMIT_FALLBACK_MS
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
          lastStatus = response.status;
          lastKind = classifyTraeError(response.status, errorText);
          if (!shouldRotateTraeAccount(lastKind)) break;
        }
        throw new LlmError(
          `trae: \u6A21\u578B ${options.model} \u6240\u6709\u8D26\u53F7\u5747\u4E0D\u53EF\u7528\uFF08${errorDetail(errorText)}\uFF09`,
          lastKind === "quota-exceeded" ? "QUOTA_EXCEEDED" : httpErrorCode(lastStatus),
          { status: lastStatus }
        );
      }
      if (lastKind === "quota-exceeded") {
        throw new LlmError(`trae: \u79EF\u5206\u4E0D\u8DB3\uFF08${errorDetail(errorText)}\uFF09`, "QUOTA_EXCEEDED", { status: lastStatus });
      }
      throw new LlmError(`trae: ${errorDetail(errorText)}`, httpErrorCode(lastStatus), { status: lastStatus });
    }
    for (let attempt = 0; ; attempt++) {
      try {
        yield* this.consumeSse(response, options);
        return;
      } catch (error) {
        const empty = error instanceof LlmError && error.message.includes("upstream returned no events");
        if (!empty || attempt >= 1) throw error;
        if (options.signal?.aborted) throw error;
        response = await this.send(credential, body, options);
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new LlmError(`trae: ${errorDetail(text)}`, httpErrorCode(response.status), { status: response.status });
        }
      }
    }
  }
  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  async send(credential, body, options) {
    this.sendCount += 1;
    const headers = new Headers(
      traeSOLOHeaders(credential, this.product, true, this.machineIdGeneration())
    );
    try {
      return await this.fetchImpl(`${this.product.agentHost}/api/agent/v3/llm_utils_chat`, {
        method: "POST",
        headers,
        body,
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (isTransportError(error)) {
        throw new LlmError(`trae: transport error: ${errorMessage(error)}`, "TRANSPORT", { cause: error });
      }
      throw error;
    }
  }
  /**
   * 当前应使用的机器指纹代次。
   *
   * **默认恒为 0（不轮换）** —— 只有显式设置
   * `DSH_TRAE_ROTATE_MACHINE_ID=1` 时才按每 4 次请求递增一代。
   *
   * 默认关闭的原因见 {@link deriveRotatingMachineId}：轮换能降低端点风控，
   * 但会让设备身份漂移，与「machine_id 登录后绝不变」的既定约束冲突。
   * 该开关是出现集中 401/风控时的第一个可尝试手段。
   */
  machineIdGeneration() {
    if (process.env.DSH_TRAE_ROTATE_MACHINE_ID !== "1") return 0;
    return Math.floor(this.sendCount / TRAE_MACHINE_ID_ROTATE_EVERY);
  }
  /**
   * 消费 SOLO 自定义 SSE 流，转为 OpenAI StreamChunk。
   *
   * SOLO 事件格式（solosse.go）：
   * ```
   * event:output
   * data:{"response":"<增量>","reasoning_content":"<思考增量>","tool_calls":<null|数组>}
   *
   * event:token_usage
   * data:{"prompt_tokens":21,"completion_tokens":142,...}
   *
   * event:done
   * data:{"finish_reason":"stop"}
   *
   * event:error
   * data:{"code":4008,"message":"quota exceeded"}
   * ```
   */
  async *consumeSse(response, options) {
    if (!response.body) throw new LlmError("trae: empty model response body", "EMPTY_RESPONSE");
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
    let currentEvent = "";
    let currentData = "";
    let gotAnyContent = false;
    let sawAnyUpstreamEvent = false;
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
          result = await readWithIdleTimeout(reader, timeoutMs, "trae", options.signal, phase);
          if (!result.done) firstTokenReceived = true;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (error instanceof LlmError) throw error;
          if (isTransportError(error)) {
            throw new LlmError(`trae: sse transport error: ${errorMessage(error)}`, "TRANSPORT", { cause: error });
          }
          throw error;
        }
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim().length === 0) {
            if (currentEvent.length > 0) {
              const ev = parseTraeSSELine(currentEvent, currentData);
              currentEvent = "";
              currentData = "";
              if (ev === void 0) continue;
              sawAnyUpstreamEvent = true;
              switch (ev.event) {
                case "output": {
                  const delta = {};
                  if (ev.response !== void 0 && ev.response.length > 0) {
                    delta.content = ev.response;
                    gotAnyContent = true;
                  }
                  if (ev.reasoningContent !== void 0 && ev.reasoningContent.length > 0) {
                    delta.reasoning_content = ev.reasoningContent;
                  }
                  if (ev.toolCalls !== void 0 && ev.toolCalls.length > 0) {
                    delta.tool_calls = ev.toolCalls;
                  }
                  if (Object.keys(delta).length > 0) {
                    if (delta.content !== void 0) {
                      let block = blocks.find((c) => c.kind === "text");
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
                    if (delta.reasoning_content !== void 0) {
                      if (loopGuard !== void 0) {
                        if (loopGuard.observe(delta.reasoning_content)) loopDetected = true;
                      }
                      if (!loopDetected) {
                        const emit = suppressor.feed(delta.reasoning_content);
                        if (emit !== void 0) {
                          let block = blocks.find((c) => c.kind === "reasoning");
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
                    if (delta.tool_calls !== void 0) {
                      const calls = delta.tool_calls;
                      for (const call of calls) {
                        const wireIndex = typeof call.index === "number" ? call.index : 0;
                        if (typeof call.id === "string" && call.id.length > 0) toolIds.set(wireIndex, call.id);
                        const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`;
                        let block = toolCalls.get(wireIndex);
                        if (block === void 0) {
                          block = { index: nextIndex++, text: "", callId, announced: false };
                          toolCalls.set(wireIndex, block);
                        }
                        block.callId = callId;
                        const callFn = call.function;
                        const fn = typeof callFn === "object" && callFn !== null ? callFn : void 0;
                        if (fn !== void 0 && typeof fn.name === "string" && fn.name.length > 0) {
                          block.name = fn.name;
                        }
                        const fragment = fn !== void 0 && typeof fn.arguments === "string" ? fn.arguments : "";
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
                    }
                  }
                  break;
                }
                case "token_usage": {
                  if (ev.usage !== void 0) {
                    const promptTokens = typeof ev.usage.prompt_tokens === "number" ? ev.usage.prompt_tokens : 0;
                    const completionTokens = typeof ev.usage.completion_tokens === "number" ? ev.usage.completion_tokens : 0;
                    const reasoningTokens = typeof ev.usage.reasoning_tokens === "number" ? ev.usage.reasoning_tokens : void 0;
                    yield {
                      type: "usage",
                      usage: {
                        inputTokens: promptTokens,
                        outputTokens: completionTokens,
                        ...reasoningTokens !== void 0 && reasoningTokens > 0 ? { reasoningTokens } : {}
                      }
                    };
                  }
                  break;
                }
                case "done":
                  if (ev.finishReason !== void 0) {
                    finishReason = ev.finishReason;
                  }
                  streamEnded = true;
                  break;
                case "error": {
                  if (ev.errorCode !== void 0 && ev.errorMessage !== void 0) {
                    throw new LlmError(
                      traeStreamErrorMessage(ev.errorCode, ev.errorMessage, options.model),
                      ev.errorCode === 1005 || ev.errorCode === 4008 ? "QUOTA_EXCEEDED" : "SERVER"
                    );
                  }
                  break;
                }
              }
            }
            continue;
          }
          const trimmed = line.trim();
          if (trimmed.startsWith("event:")) {
            currentEvent = trimmed.slice(6).trim();
          } else if (trimmed.startsWith("data:")) {
            currentData += trimmed.slice(5);
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
    if (!sawAnyUpstreamEvent) {
      throw new LlmError(
        "trae: upstream returned no events (empty response before first model event)",
        "TRANSPORT"
      );
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
function resolveMaxHistoryChars() {
  const raw = Number.parseInt(process.env.DSH_TRAE_MAX_HISTORY_CHARS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 48e4;
}
function wireMessageSize(message) {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 0;
  }
}
function trimTraeHistory(messages, maxChars = resolveMaxHistoryChars()) {
  let total = messages.reduce((sum, message) => sum + wireMessageSize(message), 0);
  if (total <= maxChars) return messages;
  const drop = /* @__PURE__ */ new Set();
  let index = 0;
  while (index < messages.length && total > maxChars) {
    if (messages[index].role === "system") {
      index += 1;
      continue;
    }
    const roundStart = index;
    let roundEnd = index + 1;
    if (Array.isArray(messages[index].tool_calls) && messages[index].tool_calls.length > 0) {
      while (roundEnd < messages.length && messages[roundEnd].role === "tool") roundEnd++;
    }
    for (let cursor = roundStart; cursor < roundEnd; cursor++) {
      drop.add(cursor);
      total -= wireMessageSize(messages[cursor]);
    }
    index = roundEnd;
  }
  return messages.filter((_, position) => !drop.has(position));
}
function registerTraeLlm(ctx, options) {
  const product = options.product ?? TRAE;
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      // 0.1.7 起 settings 命名空间只能是 profile 条目 id（见 settingsNamespaceFor）。
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: []
    }
  ]);
  const adapter = new TraeAdapter(options);
  ctx.llm.registerAdapter([product.id], adapter);
  return adapter;
}
export {
  PROVIDER,
  TraeAdapter,
  registerTraeLlm,
  traeDisplayName
};
