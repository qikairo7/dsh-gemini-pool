import { LlmAdapter, LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { providerCatalogVisible } from "./account-pool.js";
import { settingsNamespaceFor } from "./settings-compat.js";
import { isClineExpired, clineHeaders } from "./cline.js";
import {
  clineDisplayName,
  loadClineModels
} from "./cline-models.js";
import {
  CLINE,
  CLINE_CHAT_PATH,
  CLINE_DEFAULT_REASONING_EFFORT,
  CLINE_REASONING_EFFORTS
} from "./cline-product.js";
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages
} from "./openai-compat.js";
const PROVIDER = "cline";
const CLINE_MAX_ROTATE = 3;
const CLINE_MAX_OUTPUT_TOKENS = 943718;
function clampClineMaxTokens(value) {
  if (value === void 0 || !Number.isFinite(value)) return void 0;
  const integer = Math.floor(value);
  if (integer <= 0) return void 0;
  return Math.min(integer, CLINE_MAX_OUTPUT_TOKENS);
}
function sanitizeClineToolParameters(value) {
  if (Array.isArray(value)) return value.map(sanitizeClineToolParameters);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "enum" && Array.isArray(raw)) {
      const cleaned = raw.filter((item) => !(typeof item === "string" && item.trim().length === 0));
      if (cleaned.length > 0) out[key] = cleaned;
      continue;
    }
    out[key] = sanitizeClineToolParameters(raw);
  }
  return out;
}
function resolveFirstTokenTimeoutMs() {
  return Number.parseInt(process.env.DSH_CLINE_SSE_FIRST_TOKEN_TIMEOUT_MS ?? "", 10) || 12e4;
}
function resolveChunkTimeoutMs() {
  return Number.parseInt(process.env.DSH_CLINE_SSE_CHUNK_TIMEOUT_MS ?? "", 10) || 12e4;
}
class ClineAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
    this.product = options.product ?? CLINE;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  options;
  product;
  fetchImpl;
  /** 远端模型目录缓存（首次成功后填充）。 */
  remoteModels;
  /** 正在进行中的目录加载（避免并发重复请求）。 */
  loading;
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
   * 模型接受的输入模态。
   *
   * 按**模型**判定（内嵌目录的 `capabilities` 含 `images`），不是按 provider
   * 一刀切。未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
   * 也不要报一个服务端不认的模态（请求会失败）。
   */
  inputModalitiesFor(model) {
    const entry = this.remoteModels?.find((candidate) => candidate.id === model);
    return entry?.supportsImage === true ? ["text", "image"] : ["text"];
  }
  /**
   * 懒加载远端模型目录。
   *
   * `resolveModel` 可能先于 `listModels` 被调用（如直接进入会话），
   * 此时同样触发远端拉取。
   *
   * ⚠️ **并发去重**：`listModels` 与 `resolveModel` 会在启动时被 DSH 并发调用，
   * 不去重会打出多份重复的远端请求（两个端点各一次，乘以并发数）。
   */
  async ensureRemoteModels() {
    if (this.remoteModels !== void 0) return;
    if (this.loading !== void 0) {
      await this.loading;
      return;
    }
    this.loading = (async () => {
      try {
        const credential = await this.options.resolveCredential();
        const load = this.options.loadModels ?? ((opts) => loadClineModels(this.product, {
          ...opts.credential === void 0 ? {} : { credential: opts.credential },
          fetcher: this.fetchImpl
        }));
        const { models, warnings } = await load({
          ...credential === void 0 ? {} : { credential }
        });
        if (models.length > 0) this.remoteModels = models;
        for (const warning of warnings) {
          console.warn(`[cline] \u6A21\u578B\u76EE\u5F55\u6765\u6E90\u5931\u8D25\uFF1A${warning}`);
        }
      } catch (error) {
        console.warn(`[cline] \u6A21\u578B\u76EE\u5F55\u62C9\u53D6\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.loading = void 0;
      }
    })();
    await this.loading;
  }
  /** 兜底目录（远端不可用时的静态表，含 5 个免费模型）。 */
  fallbackCatalog() {
    return this.product.fallbackModels.map((model) => ({
      id: model.id,
      name: model.name,
      isFree: model.isFree === true,
      ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
      ...model.supportsImage === void 0 ? {} : { supportsImage: model.supportsImage },
      ...model.description === void 0 ? {} : { description: model.description }
    }));
  }
  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（免费标记）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
   *
   * ⚠️ 本方法是**同步**的（与 RPC 层 `ModelCatalogSource` 契约一致），
   * 故它只能读已缓存的目录。首次调用若缓存为空会触发一次**后台**加载，
   * 由下一次调用（或 DSH 的目录刷新）拿到结果 —— 而 `model.list` 端点
   * 之前一定会先走 `ctx.llm.listModels()`（那会 await 加载完成），
   * 故实际使用中不会读到空目录。
   */
  listAllModels() {
    const source = this.remoteModels ?? this.fallbackCatalog();
    if (this.remoteModels === void 0) void this.ensureRemoteModels();
    return source.map((model) => ({ id: model.id, name: clineDisplayName(model) }));
  }
  async listModels(_provider) {
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return [];
    await this.ensureRemoteModels();
    const source = this.remoteModels ?? this.fallbackCatalog();
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
    const listed = disabled === void 0 || disabled.size === 0 ? source : source.filter((model) => !disabled.has(model.id));
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 免费标记拼进 `name`（**不是** `description`）：composer 的模型切换菜单
      // 只渲染 name，description 仅用于 /model 弹窗。
      name: clineDisplayName(model),
      ...model.description === void 0 ? {} : { description: model.description },
      inputModalities: this.inputModalitiesFor(model.id)
    }));
  }
  async resolveModel(provider, model, _signal) {
    await this.ensureRemoteModels();
    const source = this.remoteModels ?? this.fallbackCatalog();
    const entry = source.find((candidate) => candidate.id === model);
    const resolved = {
      provider,
      id: model,
      // ⚠️ `resolveModel` 的 `name` **不带**免费标记（与 Qoder/TRAE 一致）：
      // 标记只属于「选择列表」语境；会话记录里带上它会污染历史展示。
      name: entry?.name ?? model,
      inputModalities: this.inputModalitiesFor(model)
    };
    if (entry?.contextWindow !== void 0) resolved.context = { contextWindow: entry.contextWindow };
    const maxTokens = clampClineMaxTokens(entry?.maxTokens);
    if (maxTokens !== void 0) resolved.defaultMaxTokens = maxTokens;
    resolved.reasoning = {
      efforts: CLINE_REASONING_EFFORTS.map((effort) => ({
        id: ReasoningEffortId(effort.id),
        name: effort.name
      })),
      defaultEffort: ReasoningEffortId(CLINE_DEFAULT_REASONING_EFFORT)
    };
    return resolved;
  }
  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `QoderAdapter` 同款 shim。
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    };
  }
  async *stream(options) {
    const imageRefs = /* @__PURE__ */ new Map();
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs);
    }
    let imageUrls;
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes("image")) {
        throw new LlmError(
          `cline: \u6A21\u578B "${options.model}" \u4E0D\u652F\u6301\u56FE\u7247\u8F93\u5165`,
          "UNSUPPORTED_CONTENT"
        );
      }
      if (this.options.readImage === void 0) {
        throw new LlmError("cline: \u56FE\u7247\u8F93\u5165\u9700\u8981\u9644\u4EF6\u670D\u52A1", "UNSUPPORTED_CONTENT");
      }
      imageUrls = /* @__PURE__ */ new Map();
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref);
        if (image === void 0) continue;
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`);
      }
    }
    let credential = await this.options.resolveCredential();
    if (credential === void 0 || isClineExpired(credential)) {
      await this.options.refresh();
      credential = await this.options.resolveCredential();
    }
    if (credential === void 0 || credential.access_token.length === 0) {
      throw new LlmError("cline: no usable credential; log in first", "MISSING_CREDENTIAL");
    }
    const messages = serializeMessages(options.messages, imageUrls);
    const bodyObj = {
      model: options.model,
      messages: options.system !== void 0 && options.system.length > 0 ? [{ role: "system", content: options.system }, ...messages] : messages,
      stream: true
    };
    if (options.tools !== void 0 && options.tools.length > 0) {
      bodyObj.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          // ⚠️ parameters 必须清洗后再下发：harness 的工具 schema 里可能带
          // 空串 `enum` 成员，Gemini 系会直接 400（见 sanitizeClineToolParameters）。
          parameters: sanitizeClineToolParameters(tool.parameters)
        }
      }));
    }
    if (options.temperature !== void 0) bodyObj.temperature = options.temperature;
    const maxTokens = clampClineMaxTokens(options.maxTokens);
    if (maxTokens !== void 0) bodyObj.max_tokens = maxTokens;
    if (options.stop !== void 0 && options.stop.length > 0) bodyObj.stop = options.stop;
    if (options.reasoningEffort !== void 0) {
      bodyObj.reasoning_effort = options.reasoningEffort;
    }
    const body = JSON.stringify(bodyObj);
    let currentAccountId = "";
    let response = await this.send(credential, body, options);
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      const forbiddenText = await response.text().catch(() => "");
      if (isClineRegionForbidden(response.status, forbiddenText)) {
        throw new LlmError(
          `cline: ${errorDetail(forbiddenText)}`,
          "PERMISSION_DENIED",
          { status: response.status }
        );
      }
      await this.options.refresh();
      const refreshed = await this.options.resolveCredential();
      if (refreshed === void 0 || refreshed.access_token.length === 0) {
        throw new LlmError("cline: credential expired and refresh failed", "AUTH", { status: response.status });
      }
      credential = refreshed;
      response = await this.send(credential, body, options);
    }
    if (!response.ok) {
      let errorText = await response.text().catch(() => "");
      const shouldRotate = isClineRotatableFailure(response.status, errorText);
      if (this.options.accountPool !== void 0 && shouldRotate) {
        const tried = /* @__PURE__ */ new Set();
        if (currentAccountId.length > 0) tried.add(currentAccountId);
        const maxRotate = CLINE_MAX_ROTATE - 1;
        for (let round = 0; round < maxRotate; round++) {
          if (currentAccountId.length > 0 && recordsClineRateLimit(response.status, errorText)) {
            await this.options.accountPool.updateModelRateLimit(
              currentAccountId,
              options.model,
              Date.now() + CLINE_RATE_LIMIT_FALLBACK_MS
            );
          }
          const next = await this.options.accountPool.getAvailableAccount(
            this.product.id,
            options.model,
            tried
          );
          if (next === null || next === void 0 || tried.has(next.entry.id)) break;
          tried.add(next.entry.id);
          credential = next.credential;
          currentAccountId = next.entry.id;
          response = await this.send(credential, body, options);
          if (response.ok) {
            yield* this.consume(response, options);
            return;
          }
          errorText = await response.text().catch(() => "");
          if (!isClineRotatableFailure(response.status, errorText)) break;
        }
        throw new LlmError(
          `cline: \u6A21\u578B ${options.model} \u7684\u6240\u6709\u8D26\u53F7\u5747\u4E0D\u53EF\u7528\uFF08\u9650\u6D41\u6216\u989D\u5EA6\u8017\u5C3D\uFF09\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5`,
          "QUOTA_EXCEEDED"
        );
      }
      throw new LlmError(
        `cline: ${errorDetail(errorText)}`,
        httpErrorCode(response.status),
        { status: response.status }
      );
    }
    yield* this.consume(response, options);
  }
  /** 消费 OpenAI 兼容 SSE（共享实现）。 */
  consume(response, options) {
    return consumeOpenAiSse(response, { ...options.signal === void 0 ? {} : { signal: options.signal } }, {
      label: "cline",
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs()
    });
  }
  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  async send(credential, body, options) {
    try {
      return await this.fetchImpl(`${this.product.apiBase}${CLINE_CHAT_PATH}`, {
        method: "POST",
        // ⚠️ 头里的 Authorization 必须是**带 workos: 前缀**的值
        //（见 src/cline.ts 的 clineBearerValue 注释）。
        headers: {
          ...clineHeaders(credential, this.product),
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body,
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      if (isTransportError(error)) {
        throw new LlmError(
          `cline: transport error: ${error instanceof Error ? error.message : String(error)}`,
          "TRANSPORT",
          { cause: error }
        );
      }
      throw error;
    }
  }
}
const CLINE_RATE_LIMIT_FALLBACK_MS = 36e5;
function isClineRotatableFailure(status, body) {
  if (status === 429 || status === 402) return true;
  const lower = body.toLowerCase();
  return CLINE_CREDIT_MARKERS.some((marker) => lower.includes(marker));
}
const CLINE_CREDIT_MARKERS = [
  "insufficient",
  "quota",
  "rate limit",
  "too many requests",
  "balance",
  "credit",
  "payment required",
  "exceeded",
  "\u79EF\u5206\u4E0D\u8DB3",
  "\u989D\u5EA6\u4E0D\u8DB3",
  "\u4F59\u989D\u4E0D\u8DB3",
  "\u9891\u7387\u9650\u5236",
  "\u8D85\u51FA\u9650\u5236"
];
function recordsClineRateLimit(status, _body) {
  return status === 429 || status === 402;
}
function isClineRegionForbidden(status, body) {
  if (status !== 403) return false;
  const lower = body.toLowerCase();
  return CLINE_REGION_FORBIDDEN_MARKERS.some((marker) => lower.includes(marker));
}
const CLINE_REGION_FORBIDDEN_MARKERS = [
  "not available in your region",
  "access forbidden",
  "region not supported",
  "not available in your country"
];
function registerClineLlm(ctx, options) {
  const product = options.product ?? CLINE;
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: []
    }
  ]);
  const adapter = new ClineAdapter(options);
  ctx.llm.registerAdapter([product.id], adapter);
  return adapter;
}
export {
  CLINE_CREDIT_MARKERS,
  ClineAdapter,
  PROVIDER,
  isClineRegionForbidden,
  isClineRotatableFailure,
  recordsClineRateLimit,
  registerClineLlm,
  sanitizeClineToolParameters
};
