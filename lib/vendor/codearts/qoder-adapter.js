import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { providerCatalogVisible } from "./account-pool.js";
import { settingsNamespaceFor } from "./settings-compat.js";
import { isQoderExpired } from "./qoder.js";
import { QoderEncryptedInfer } from "./qoder-wasm.js";
import { unwrapQoderEnvelopeStream } from "./qoder-envelope.js";
import { QODER } from "./qoder-product.js";
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages
} from "./openai-compat.js";
const PROVIDER = "qoder";
function buildQoderTools(tools) {
  if (tools === void 0 || tools.length === 0) return [];
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...tool.description.length > 0 ? { description: tool.description } : {},
      ...tool.parameters === void 0 ? {} : { parameters: tool.parameters }
    }
  }));
}
function qoderContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((block) => typeof block === "object" && block !== null && block.type === "text").map((block) => String(block.text)).join("");
  }
  return "";
}
function buildQoderHistory(messages) {
  const history = [];
  for (const message of messages) {
    if (typeof message.role !== "string") continue;
    const content = qoderContentText(message.content);
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : void 0;
    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : void 0;
    if (content.length === 0 && toolCalls === void 0 && toolCallId === void 0) continue;
    history.push({
      role: message.role,
      content,
      ...toolCalls === void 0 ? {} : { tool_calls: toolCalls },
      ...toolCallId === void 0 ? {} : { tool_call_id: toolCallId }
    });
  }
  return history;
}
function resolveFirstTokenTimeoutMs() {
  return Number.parseInt(process.env.DSH_QODER_SSE_FIRST_TOKEN_TIMEOUT_MS ?? "", 10) || 12e4;
}
function resolveChunkTimeoutMs() {
  return Number.parseInt(process.env.DSH_QODER_SSE_CHUNK_TIMEOUT_MS ?? "", 10) || 12e4;
}
class QoderAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
    this.product = options.product ?? QODER;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallbackIndex = new Map(
      (this.product.fallbackModels ?? []).map((model) => [model.id, model])
    );
  }
  options;
  product;
  fetchImpl;
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
   * 模型接受的输入模态。
   *
   * 按**模型**判定（兜底表的 `supportsImage`），不是按 provider 一刀切。
   * 未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
   * 也不要报一个服务端不认的模态（请求会失败）。
   *
   * ⚠️ 兜底表是本地估计值，不是远端权威数据 —— 见 `qoder-product.ts` 的说明。
   */
  inputModalitiesFor(model) {
    return this.fallbackIndex.get(model)?.supportsImage === true ? ["text", "image"] : ["text"];
  }
  /**
   * 模型目录。
   *
   * **不发任何网络请求**：Qoder 的模型列表端点需要 WASM 签名
   * （`qoder_auth_wasm`），本插件不实现，故恒用产品兜底表。
   * 见设计文档 §2.6 与 `qoder-product.ts` 的 `fallbackModels` 说明。
   */
  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率/免费标记）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
   */
  listAllModels() {
    return this.product.fallbackModels.map((model) => ({ id: model.id, name: qoderDisplayName(model) }));
  }
  async listModels(_provider) {
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return [];
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
    const source = this.product.fallbackModels;
    const listed = disabled === void 0 || disabled.size === 0 ? source : source.filter((model) => !disabled.has(model.id));
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 `name`（**不是** `description`）：composer 的模型切换菜单
      // 只渲染 name，description 仅用于 /model 弹窗。见 qoderDisplayName。
      name: qoderDisplayName(model),
      inputModalities: this.inputModalitiesFor(model.id)
    }));
  }
  async resolveModel(provider, model, _signal) {
    const entry = this.fallbackIndex.get(model);
    const resolved = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: this.inputModalitiesFor(model)
    };
    if (entry !== void 0) resolved.context = { contextWindow: entry.contextWindow };
    return resolved;
  }
  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `LobsteraiAdapter` 同款 shim。
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
          `qoder: \u6A21\u578B "${options.model}" \u4E0D\u652F\u6301\u56FE\u7247\u8F93\u5165`,
          "UNSUPPORTED_CONTENT"
        );
      }
      if (this.options.readImage === void 0) {
        throw new LlmError("qoder: \u56FE\u7247\u8F93\u5165\u9700\u8981\u9644\u4EF6\u670D\u52A1", "UNSUPPORTED_CONTENT");
      }
      imageUrls = /* @__PURE__ */ new Map();
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref);
        if (image === void 0) continue;
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`);
      }
    }
    let credential = await this.options.resolveCredential();
    if (credential === void 0 || isQoderExpired(credential)) {
      await this.options.refresh();
      credential = await this.options.resolveCredential();
    }
    if (credential === void 0 || credential.access_token.length === 0) {
      throw new LlmError("qoder: no usable credential; log in first", "MISSING_CREDENTIAL");
    }
    credential = await this.ensureUid(credential);
    const messages = serializeMessages(options.messages, imageUrls);
    const systemText = options.system !== void 0 && options.system.length > 0 ? options.system : void 0;
    const userMessages = messages.filter((m) => m.role === "user");
    const lastUser = userMessages.at(-1);
    const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
    const history = buildQoderHistory(messages);
    const tools = buildQoderTools(options.tools);
    const fallback = this.fallbackIndex.get(options.model);
    const buildRequest = async (c) => {
      const client = await QoderEncryptedInfer.create({
        user: {
          uid: c.uid,
          securityOauthToken: c.security_oauth_token ?? c.access_token
        },
        machineId: c.machine_id,
        metadata: { ...this.product.clientMetadata },
        host: this.product.encryptedInferBase
      });
      return client.prepareInfer({
        modelKey: options.model,
        userText,
        ...systemText !== void 0 ? { systemText } : {},
        isReasoning: fallback?.supportsThinking ?? false,
        history,
        // 工具定义：这是模型**唯一**能学到函数 schema 的通道，
        // 缺了它模型只能用正文 XML 臆造调用（真实缺陷）。
        tools,
        ...options.maxTokens !== void 0 ? { maxTokens: options.maxTokens } : {},
        ...options.reasoningEffort !== void 0 ? { reasoningEffort: options.reasoningEffort } : {},
        ...fallback?.supportsImage !== void 0 ? { isVl: fallback.supportsImage } : {},
        // 官方 `model_config` 的 display_name / max_input_tokens 必须带上。
        ...fallback?.name !== void 0 ? { displayName: fallback.name } : {},
        ...fallback?.contextWindow !== void 0 ? { maxInputTokens: fallback.contextWindow } : {},
        // ⚠️ **`business` 必填**，否则服务端把请求路由到错误的后端节点。
        //
        // 实测（2026-09-20）：不带 `business` 时 `qfmodel`（Qwen3.8-Flash）
        // 恒落到故障节点 `oa_qwen-plus-2025-04-28` 并返回
        // `[FAIL]node:... msg:Execution failed`；补上 `business` 后立即正常
        // （其余模型如 `qmodel_38max` 恰好不受影响，故早期排查易误判为
        // 「该模型服务端故障」）。`agent` / `sec_scan` 等取值都能通。
        //
        // 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
        // —— 服务端按 `business.type` 选路由池，缺字段会走异常分支。
        business: { type: "agent" }
      });
    };
    let response = await this.sendEncrypted(await buildRequest(credential), options);
    if (response.status === 401 || response.status === 403) {
      await this.options.refresh();
      const refreshed = await this.options.resolveCredential();
      if (refreshed === void 0 || refreshed.access_token.length === 0) {
        throw new LlmError("qoder: credential expired and refresh failed", "AUTH", { status: response.status });
      }
      credential = await this.ensureUid(refreshed);
      response = await this.sendEncrypted(await buildRequest(credential), options);
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new LlmError(`qoder: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status });
    }
    yield* consumeOpenAiSse(unwrapQoderEnvelopeStream(response, "qoder"), { signal: options.signal }, {
      label: "qoder",
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs()
    });
  }
  /**
   * 确保凭据带 **`uid`**（加密推理必需），必要时经注入钩子补齐。
   *
   * ⚠️ 缺 uid 时**不能静默用空串发请求** —— 那样 WASM 会产出签名无效的
   * 请求，服务端回 `Signature invalid (101)`，用户看到的是「签名错误」
   * 而非「凭据不完整」，极难定位（真实缺陷）。这里宁可明确报错。
   */
  async ensureUid(credential) {
    if (credential.uid !== void 0 && credential.uid.length > 0) return credential;
    const patched = await this.options.resolveUid?.(credential);
    if (patched?.uid !== void 0 && patched.uid.length > 0) return patched;
    throw new LlmError(
      "qoder: \u51ED\u636E\u7F3A\u5C11 uid\uFF0C\u52A0\u5BC6\u63A8\u7406\u65E0\u6CD5\u7B7E\u540D\uFF08\u8BF7\u91CD\u65B0\u767B\u5F55\u8BE5\u8D26\u53F7\uFF09",
      "MISSING_CREDENTIAL"
    );
  }
  /** 发送一次**加密**推理请求（`agent_chat_generation`）。 */
  async sendEncrypted(request, options) {
    const headers = new Headers(request.headers);
    headers.set("Accept", "text/event-stream");
    try {
      return await this.fetchImpl(request.url, {
        method: "POST",
        headers,
        body: request.body,
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (isTransportError(error)) {
        throw new LlmError(
          `qoder: transport error: ${error instanceof Error ? error.message : String(error)}`,
          "TRANSPORT",
          { cause: error }
        );
      }
      throw error;
    }
  }
}
function promotionActiveNow(promotion, now) {
  const { windowStart, windowEnd } = promotion;
  if (windowStart === void 0 || windowEnd === void 0) return promotion.active;
  const toMinutes = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (m === null) return void 0;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h < 24 && min < 60 ? h * 60 + min : void 0;
  };
  const start = toMinutes(windowStart);
  const end = toMinutes(windowEnd);
  if (start === void 0 || end === void 0) return promotion.active;
  const utc8 = new Date(now.getTime() + 8 * 36e5);
  const minutes = utc8.getUTCHours() * 60 + utc8.getUTCMinutes();
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
function qoderDisplayName(model, now = /* @__PURE__ */ new Date()) {
  const promo = model.promotion;
  const before = promo?.beforePromotionPriceFactor;
  const discount = promo?.discountFactor;
  const hasPromo = promo !== void 0 && before !== void 0 && discount !== void 0;
  const active = hasPromo && promotionActiveNow(promo, now);
  if (model.priceFactor === 0) return `${model.name} \xB7 \u514D\u8D39`;
  if (hasPromo && active) {
    const effective = Number((before * discount).toFixed(4));
    return `${model.name} \xB7 x${before}\u2192x${effective}`;
  }
  const price = hasPromo ? before : model.priceFactor;
  return price !== void 0 ? `${model.name} \xB7 x${price}` : model.name;
}
function registerQoderLlm(ctx, options) {
  const product = options.product ?? QODER;
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: []
    }
  ]);
  const adapter = new QoderAdapter(options);
  ctx.llm.registerAdapter([product.id], adapter);
  return adapter;
}
export {
  PROVIDER,
  QoderAdapter,
  buildQoderHistory,
  buildQoderTools,
  promotionActiveNow,
  qoderDisplayName,
  registerQoderLlm
};
