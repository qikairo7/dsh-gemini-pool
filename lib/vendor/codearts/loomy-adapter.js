import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { providerCatalogVisible } from "./account-pool.js";
import { settingsNamespaceFor } from "./settings-compat.js";
import {
  isLoomyChatModel,
  isLoomyExpired,
  loomyChatHeaders,
  loomyDisplayName,
  splitLoomyRate
} from "./loomy.js";
import { LOOMY } from "./loomy-product.js";
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages
} from "./openai-compat.js";
const PROVIDER = "loomy";
function readInputModalities(entry) {
  const capabilities = entry.capabilities;
  if (typeof capabilities !== "object" || capabilities === null) return [];
  const raw = capabilities.input_modalities;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => typeof item === "string").map((item) => item.toLowerCase());
}
function parseLoomyRemoteModels(payload) {
  const list = Array.isArray(payload) ? payload : typeof payload === "object" && payload !== null && Array.isArray(payload.data) ? payload.data : [];
  const models = [];
  for (const item of list) {
    if (!isLoomyChatModel(item)) continue;
    const entry = item;
    const id = String(entry.id);
    const rawName = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id;
    const contextWindow = Number(entry.context_length);
    const capabilities = typeof entry.capabilities === "object" && entry.capabilities !== null ? entry.capabilities : {};
    models.push({
      id,
      name: loomyDisplayName(rawName),
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
      supportsImage: readInputModalities(entry).includes("image"),
      supportsThinking: capabilities.reasoning === true
    });
  }
  return models;
}
function fallbackToRemote(model) {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    // 兜底表不声明图片能力：宁可少报（用户改用文本描述），
    // 也不要报一个服务端可能不认的模态。
    supportsImage: false,
    supportsThinking: true
  };
}
class LoomyAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
    this.product = options.product ?? LOOMY;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]));
  }
  options;
  product;
  fetchImpl;
  /** 兜底模型索引（id → 条目）。 */
  fallbackIndex;
  /** 远端模型缓存（含展示名与能力）；未拉取时为 undefined。 */
  remoteModels;
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
  /** 完整目录（**不套黑名单**），带最终展示名。设置页需要它渲染被关闭的模型。 */
  listAllModels() {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote);
    return source.map((model) => ({ id: model.id, name: model.name }));
  }
  /** 取（并缓存）远端模型目录；失败时回退兜底表。 */
  async loadModels() {
    if (this.remoteModels !== void 0) return this.remoteModels;
    if (this.options.fetchRemoteModels !== void 0) {
      try {
        const fetched = await this.options.fetchRemoteModels();
        if (fetched.length > 0) {
          this.remoteModels = fetched;
          return fetched;
        }
      } catch {
      }
    }
    const fallback = this.product.fallbackModels.map(fallbackToRemote);
    this.remoteModels = fallback;
    return fallback;
  }
  inputModalitiesFor(model) {
    return model?.supportsImage === true ? ["text", "image"] : ["text"];
  }
  async listModels(_provider) {
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return [];
    const all = await this.loadModels();
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
    const listed = disabled === void 0 || disabled.size === 0 ? all : all.filter((model) => !disabled.has(model.id));
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
      name: model.name,
      inputModalities: this.inputModalitiesFor(model)
    }));
  }
  async resolveModel(provider, model, _signal) {
    const all = await this.loadModels();
    const entry = all.find((item) => item.id === model);
    const fallback = this.fallbackIndex.get(model);
    const bareName = fallback !== void 0 ? splitLoomyRate(fallback.name).name : model;
    const resolved = {
      provider,
      id: model,
      name: entry !== void 0 ? splitLoomyRate(entry.name).name : bareName,
      inputModalities: this.inputModalitiesFor(entry)
    };
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow;
    if (contextWindow !== void 0 && contextWindow > 0) {
      resolved.context = { contextWindow };
    }
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
    const all = await this.loadModels();
    const entry = all.find((item) => item.id === options.model);
    let imageUrls;
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes("image")) {
        throw new LlmError(`loomy: \u6A21\u578B "${options.model}" \u4E0D\u652F\u6301\u56FE\u7247\u8F93\u5165`, "UNSUPPORTED_CONTENT");
      }
      if (this.options.readImage === void 0) {
        throw new LlmError("loomy: \u56FE\u7247\u8F93\u5165\u9700\u8981\u9644\u4EF6\u670D\u52A1", "UNSUPPORTED_CONTENT");
      }
      imageUrls = /* @__PURE__ */ new Map();
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref);
        if (image === void 0) continue;
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`);
      }
    }
    let credential = await this.options.resolveCredential(options.model);
    if (credential === void 0 || isLoomyExpired(credential)) {
      await this.options.refresh();
      credential = await this.options.resolveCredential(options.model);
    }
    if (credential === void 0 || credential.access_token.length === 0) {
      throw new LlmError("loomy: no usable credential; log in first", "MISSING_CREDENTIAL");
    }
    const messages = serializeMessages(options.messages, imageUrls);
    const wireMessages = options.system !== void 0 && options.system.length > 0 ? [{ role: "system", content: options.system }, ...messages] : messages;
    const buildBody = () => JSON.stringify({
      model: options.model,
      messages: wireMessages,
      stream: true,
      ...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {},
      ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
      ...options.stop !== void 0 && options.stop.length > 0 ? { stop: options.stop } : {},
      ...options.tools !== void 0 && options.tools.length > 0 ? {
        tools: options.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            ...tool.description.length > 0 ? { description: tool.description } : {},
            ...tool.parameters === void 0 ? {} : { parameters: tool.parameters }
          }
        }))
      } : {}
    });
    const send = async (token) => {
      try {
        return await this.fetchImpl(`${this.product.apiBase}/chat/completions`, {
          method: "POST",
          // ⚠️ chat 端点只认 Bearer（业务端点才认 token），这里两个都发。
          headers: loomyChatHeaders(token),
          body: buildBody(),
          signal: options.signal
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (isTransportError(error)) {
          throw new LlmError(
            `loomy: transport error: ${error instanceof Error ? error.message : String(error)}`,
            "TRANSPORT",
            { cause: error }
          );
        }
        throw error;
      }
    };
    let response = await send(credential.access_token);
    if (response.status === 401 || response.status === 403) {
      await this.options.refresh();
      const refreshed = await this.options.resolveCredential();
      if (refreshed === void 0 || refreshed.access_token.length === 0) {
        throw new LlmError("loomy: credential expired and refresh failed", "AUTH", { status: response.status });
      }
      response = await send(refreshed.access_token);
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new LlmError(`loomy: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status });
    }
    yield* consumeOpenAiSse(response, { signal: options.signal }, {
      label: "loomy",
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs()
    });
  }
}
function resolveFirstTokenTimeoutMs() {
  const raw = Number(process.env.DSH_LOOMY_FIRST_TOKEN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 12e4;
}
function resolveChunkTimeoutMs() {
  const raw = Number(process.env.DSH_LOOMY_CHUNK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 12e4;
}
function registerLoomyLlm(ctx, options) {
  const product = options.product ?? LOOMY;
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: []
    }
  ]);
  const adapter = new LoomyAdapter(options);
  ctx.llm.registerAdapter([product.id], adapter);
  return adapter;
}
export {
  LoomyAdapter,
  PROVIDER,
  parseLoomyRemoteModels,
  registerLoomyLlm
};
