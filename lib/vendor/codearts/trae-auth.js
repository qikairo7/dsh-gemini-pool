import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  TRAE_BATCH_MODELS_PATH,
  TRAE_EXCHANGE_PATH,
  TRAE_REQUEST_TIMEOUT_MS,
  applyTraeRefresh,
  isTraeExpired,
  isTraeRefreshable,
  parseTraeBatchModelList,
  parseTraeExchangeResponse,
  traeCredentialExpiresAtMs,
  traeOAuthHeaders,
  traeSOLOHeaders
} from "./trae.js";
import { TRAE } from "./trae-product.js";
import {
  runTraeLoginFlow,
  startTraeLoginFlow
} from "./trae-oauth.js";
import { classifyTraeError, isTraeTerminalError } from "./trae-errors.js";
import { RefreshScheduler } from "./refresh.js";
const TRAE_CREDENTIAL_REF = "TRAE_ACCESS_TOKEN";
class RefreshTokenExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "RefreshTokenExpiredError";
  }
}
function parseCredential(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && typeof parsed.access_token === "string" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
class TraeAuth extends Service {
  constructor(ctx, options = {}) {
    const product = options.product ?? TRAE;
    super(ctx, options.serviceName ?? `${product.id}Auth`);
    this.options = options;
    this.product = product;
    this.credentialRefName = this.product.defaultCredentialRef;
  }
  options;
  /** 本实例所属的产品配置。 */
  product;
  /** 本实例默认读写的凭据 ref 名称（`TRAE_ACCESS_TOKEN`）。 */
  credentialRefName;
  scheduler = new RefreshScheduler(
    () => this.refresh(),
    (error) => {
      if (error instanceof RefreshTokenExpiredError) {
        this.markRefreshTokenInvalid();
        return;
      }
      this.lastRefreshError = error instanceof Error ? error.message : String(error);
    }
  );
  /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
  refreshTokenInvalid = false;
  lastRefreshError;
  /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
  active = true;
  /**
   * 模型目录缓存（含**空结果**）与拉取时刻。
   *
   * ⚠️ 为什么需要它：适配器的 `ensureRemoteModels` 是**只缓存非空结果**的
   * （全仓库四个适配器同一模式）—— 拉到空数组时 `remoteModels` 保持 undefined，
   * 于是**下一次** `listModels` / `resolveModel` 会再拉一次。
   *
   * 「未登录 TRAE」恰好就是恒空的情形：用户每打开一次模型选择器、每次
   * 解析模型都发起一次真实 HTTP 请求。用户报障的日志刷屏
   * （同一行 `fetchModels: calling …` 重复数十次）正是这么来的。
   *
   * 故这里**连同空结果一起缓存**，并给一个短 TTL（登录后 30s 内即可自愈，
   * 不需要用户重启宿主）。缓存的是「这次拉取的结果」，与是否有凭据无关 ——
   * 无凭据时直接返回空并缓存，避免重复走一遍凭据解析。
   */
  modelsCache;
  /** 模型目录缓存有效期（毫秒）。短 TTL：新登录的账号最多 30s 后可见。 */
  static MODELS_CACHE_TTL_MS = 3e4;
  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  get fetchImpl() {
    return this.options.fetcher ?? fetch;
  }
  /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
  markRefreshTokenInvalid() {
    this.refreshTokenInvalid = true;
    this.lastRefreshError = "refresh_token \u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55";
  }
  /**
   * 运行完整登录流程并持久化凭据。
   */
  async login(flowOptions = {}) {
    this.active = true;
    const flow = await runTraeLoginFlow({
      product: this.product,
      ...this.options.fetcher === void 0 ? {} : { fetcher: this.options.fetcher },
      ...flowOptions
    });
    return this.persistLogin(flow, flowOptions);
  }
  /**
   * 两步式登录：起回调服务器并立即返回 loginUrl。
   */
  async startLogin(flowOptions = {}) {
    this.active = true;
    const started = await startTraeLoginFlow({
      product: this.product,
      ...this.options.fetcher === void 0 ? {} : { fetcher: this.options.fetcher },
      ...flowOptions
    });
    const result = started.result.then((flow) => this.persistLogin(flow, flowOptions));
    result.catch(() => {
    });
    return { loginUrl: started.loginUrl, result, close: started.close };
  }
  /**
   * 持久化一次登录结果。
   */
  async persistLogin(flow, flowOptions = {}) {
    const ref = flowOptions.refName ? credentialRef(flowOptions.refName) : credentialRef(this.credentialRefName);
    await this.ctx.credentials.set(ref, flow.access);
    this.refreshTokenInvalid = false;
    this.lastRefreshError = void 0;
    this.modelsCache = void 0;
    this.scheduleRefresh();
    const credential = parseCredential(flow.access);
    if (flowOptions.accountId !== void 0 && flowOptions.pool !== void 0) {
      await flowOptions.pool.addAccount({
        id: flowOptions.accountId,
        provider: this.product.id,
        nickname: credential?.nickname !== void 0 && credential.nickname.length > 0 ? credential.nickname : flowOptions.accountId,
        enabled: true,
        credentialRef: flowOptions.refName ?? this.credentialRefName,
        createdAt: Date.now(),
        expiresAt: credential ? traeCredentialExpiresAtMs(credential) : void 0,
        refreshable: credential !== void 0 && isTraeRefreshable(credential)
      });
    }
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: flow.refreshable
    };
  }
  /** 报告凭据状态。 */
  async status() {
    const ref = credentialRef(this.credentialRefName);
    const info = await this.ctx.credentials.describe(ref);
    if (!info.configured) return { configured: false, refreshable: false };
    let expiresAt;
    let refreshable = false;
    const resolved = await this.ctx.credentials.resolve(ref);
    if (resolved) {
      const credential = parseCredential(resolved.value);
      if (credential) {
        expiresAt = traeCredentialExpiresAtMs(credential);
        refreshable = isTraeRefreshable(credential) && !this.refreshTokenInvalid;
      }
    }
    return {
      configured: true,
      source: info.source,
      expiresAt,
      refreshable,
      ...this.lastRefreshError === void 0 ? {} : { refreshError: this.lastRefreshError }
    };
  }
  /**
   * 静默续期：ExchangeToken 换新。
   *
   * 终态判定：
   * - HTTP 401/403、或响应体命中 session-dead 标记 → 抛 RefreshTokenExpiredError
   * - 其余错误（网络抖动、5xx、429）→ 抛普通 Error，走可重试路径
   */
  async refresh() {
    const ref = credentialRef(this.credentialRefName);
    const resolved = await this.ctx.credentials.resolve(ref);
    if (!resolved) throw new Error("\u672A\u914D\u7F6E\u51ED\u636E\uFF0C\u8BF7\u5148\u767B\u5F55");
    const credential = parseCredential(resolved.value);
    if (!credential) throw new Error("\u51ED\u636E\u89E3\u6790\u5931\u8D25");
    if (!isTraeRefreshable(credential)) {
      throw new RefreshTokenExpiredError("\u65E0 refresh_token\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    try {
      const refreshed = await this.refreshCredential(credential);
      if (!this.active) return;
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
      this.refreshTokenInvalid = false;
      this.lastRefreshError = void 0;
      this.scheduleRefresh();
    } catch (error) {
      if (error instanceof RefreshTokenExpiredError) this.markRefreshTokenInvalid();
      throw error;
    }
  }
  /**
   * 按凭据 ref 续期指定账号的凭据。
   */
  async refreshAccountCredential(refName) {
    const ref = credentialRef(refName);
    const resolved = await this.ctx.credentials.resolve(ref);
    if (!resolved) throw new Error("\u51ED\u636E\u672A\u914D\u7F6E");
    const credential = parseCredential(resolved.value);
    if (!credential) throw new Error("\u51ED\u636E\u89E3\u6790\u5931\u8D25");
    if (!isTraeRefreshable(credential)) {
      throw new RefreshTokenExpiredError("\u65E0 refresh_token\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    const refreshed = await this.refreshCredential(credential);
    await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
  }
  /**
   * 对一份凭据执行一次续期并返回新凭据（不触碰存储）。
   */
  async refreshCredential(credential) {
    const host = credential.api_host ?? this.product.oauthHost;
    const exchangeBody = {
      ClientID: this.product.clientId,
      RefreshToken: credential.refresh_token,
      ClientSecret: "-",
      UserID: ""
    };
    let response;
    try {
      response = await this.fetchImpl(`${host}${TRAE_EXCHANGE_PATH}`, {
        method: "POST",
        headers: traeOAuthHeaders(this.product),
        body: JSON.stringify(exchangeBody),
        signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error(`TRAE \u7EED\u671F\u7F51\u7EDC\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text().catch(() => "");
    let parsed;
    try {
      const candidate = JSON.parse(text);
      if (typeof candidate === "object" && candidate !== null) {
        parsed = candidate;
      }
    } catch {
      parsed = void 0;
    }
    const exchange = parsed === void 0 ? void 0 : parseTraeExchangeResponse(parsed);
    if (exchange === void 0 || exchange.accessToken.length === 0) {
      const kind = classifyTraeError(response.status, text);
      const noTokenInSuccessResponse = response.ok && parsed !== void 0;
      if (response.status === 401 || response.status === 403 || isTraeTerminalError(kind) || noTokenInSuccessResponse) {
        throw new RefreshTokenExpiredError("TRAE refresh_token \u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
      }
      throw new Error(`TRAE \u7EED\u671F\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\uFF1A${text.slice(0, 200)}`);
    }
    return applyTraeRefresh(credential, exchange);
  }
  /**
   * 批量续期本产品的所有账号。
   *
   * **包含已停用账号**（只按 `refreshable` 过滤）。
   */
  async refreshAll(pool) {
    const accounts = await pool.listAccounts(this.product.id);
    for (const entry of accounts) {
      if (!entry.refreshable) continue;
      try {
        const ref = credentialRef(entry.credentialRef);
        const resolved = await this.ctx.credentials.resolve(ref);
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false });
          continue;
        }
        const credential = parseCredential(resolved.value);
        if (!credential || !isTraeRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false });
          continue;
        }
        const refreshed = await this.refreshCredential(credential);
        await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
        await pool.updateAccount(entry.id, {
          expiresAt: traeCredentialExpiresAtMs(refreshed) ?? void 0,
          refreshable: isTraeRefreshable(refreshed)
        });
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false });
          } catch {
          }
          this.ctx.logger?.warn?.(`[trae] \u8D26\u53F7 ${entry.id} \u7684 refresh_token \u5DF2\u5931\u6548\uFF0C\u5DF2\u6807\u8BB0\u4E3A\u4E0D\u53EF\u7EED\u671F`);
        } else {
          this.ctx.logger?.warn?.(
            `[trae] \u8D26\u53F7 ${entry.id} \u7EED\u671F\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }
  /** 移除已存储的凭据并停止任何待处理的刷新。 */
  async logout() {
    this.active = false;
    this.scheduler.stop();
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName));
    this.modelsCache = void 0;
  }
  /** 停止刷新调度（不清理凭据）。 */
  stop() {
    this.active = false;
    this.scheduler.stop();
  }
  /** 启动时若已有可刷新凭据则安排续期。 */
  scheduleRefresh() {
    void this.ctx.credentials.resolve(credentialRef(this.credentialRefName)).then((resolved) => {
      if (!resolved) return;
      const credential = parseCredential(resolved.value);
      if (!credential || !isTraeRefreshable(credential)) return;
      const expiresAt = traeCredentialExpiresAtMs(credential);
      if (expiresAt !== void 0) this.scheduler.arm(expiresAt);
    });
  }
  /** 从存储重载凭据，返回是否已过期。 */
  async checkExpired() {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
    if (!resolved) return true;
    const credential = parseCredential(resolved.value);
    return credential === void 0 ? true : isTraeExpired(credential);
  }
  /**
   * 获取 TRAE 模型列表（`batch_get_detail_param`）。
   *
   * ## 日志约定（与其它 provider 对齐）
   *
   * **成功路径一律不打印**。早期这里用 `console.warn` 打了「calling / got N
   * models」，而本方法在冷启动阶段会被调用多次（每次 `listModels` /
   * `resolveModel` 都可能触发，见 `TraeAdapter.ensureRemoteModels`），
   * 于是整个日志被同一行刷屏 —— 用户报障「fetch 的 log 似乎太多了」。
   *
   * **「没有凭据」不是异常**：未登录 TRAE 的用户每次列模型都会走到这条分支，
   * 打日志只会制造噪声（用户报障「没有账号不需要显示 no credential
   * resolved from store」）。真正需要关注的失败（HTTP 非 2xx、网络异常）
   * 才记录。
   */
  async fetchModels(pool) {
    const cached = this.modelsCache;
    if (cached !== void 0 && Date.now() - cached.at < TraeAuth.MODELS_CACHE_TTL_MS) {
      return cached.models;
    }
    const models = await this.fetchModelsUncached(pool);
    this.modelsCache = { models, at: Date.now() };
    return models;
  }
  /** 真正发起一次拉取；日志与错误处理见 `fetchModels` 的注释。 */
  async fetchModelsUncached(pool) {
    let credential;
    if (pool) {
      const available = await pool.getAvailableAccount(this.product.id, "").catch(() => void 0);
      if (available) credential = available.credential;
    }
    if (credential === void 0) {
      const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
      if (!resolved) return [];
      credential = parseCredential(resolved.value);
      if (credential === void 0) return [];
    }
    if (credential.access_token.length === 0) return [];
    try {
      const bodyObj = {
        functions: [
          "ui_builder_v2",
          "solo_coder",
          "chat_v3",
          "solo_builder",
          "builder_v3",
          "builder",
          "chat",
          "inline_chat",
          "git_ai",
          "custom_agent_generation",
          "utils",
          "code_reviewer",
          "code_review_summary",
          "solo_agent",
          "solo_agent_remote",
          "solo_work_remote",
          "solo_agent_lite",
          "solo_work_lite",
          "solo_design_lite",
          "solo_design_remote",
          "multimodal",
          "system_diagnosis"
        ],
        agent_type: "",
        current_config_info: { config_name: "", is_custom_model: false },
        mode_type: 0,
        access_type: 0,
        ab_force_vids: "",
        ab_autotest_advanced_mode: 0,
        show_custom_model: true
      };
      const url = `${this.product.agentHost}${TRAE_BATCH_MODELS_PATH}`;
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: traeSOLOHeaders(credential, this.product, false),
        body: JSON.stringify(bodyObj),
        signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) {
        this.warn(`fetchModels: HTTP ${response.status} ${response.statusText}`);
        return [];
      }
      return parseTraeBatchModelList(await response.json());
    } catch (e) {
      this.warn(`fetchModels: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }
  /** 记录一条警告（经 `ctx.logger`，**仅失败路径**调用）。 */
  warn(message) {
    this.ctx.logger?.warn?.(`[trae-auth] ${message}`);
  }
}
export {
  RefreshTokenExpiredError,
  TRAE_CREDENTIAL_REF,
  TraeAuth
};
