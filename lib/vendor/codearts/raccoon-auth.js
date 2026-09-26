import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  isRaccoonExpired,
  isRaccoonRefreshable,
  raccoonDisplayName,
  decodeJwtExpMs
} from "./raccoon.js";
import {
  claimRaccoonLoginReward,
  fetchRaccoonCreditBalance,
  fetchRaccoonOnboardingStatus
} from "./raccoon-credits.js";
import {
  fetchRaccoonUserInfo,
  refreshRaccoonCredential
} from "./raccoon-oauth.js";
import { RACCOON } from "./raccoon-product.js";
import {
  startRaccoonLoginFlow
} from "./raccoon-login-page.js";
const RACCOON_CREDENTIAL_REF = "RACCOON_ACCESS_TOKEN";
class RefreshTokenExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "RefreshTokenExpiredError";
  }
}
function parseRaccoonCredential(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && typeof parsed.access_token === "string" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function normalizeRemoteModel(entry) {
  const id = typeof entry.name === "string" ? entry.name.trim() : "";
  if (id.length === 0) return void 0;
  if (entry.visible === false) return void 0;
  const params = typeof entry.params === "object" && entry.params !== null ? entry.params : {};
  const description = typeof entry.description === "string" && entry.description.length > 0 ? entry.description : id;
  const effective = typeof entry.billing_effective_multiplier === "number" ? entry.billing_effective_multiplier : Number.NaN;
  const base = typeof entry.billing_multiplier === "number" ? entry.billing_multiplier : Number.NaN;
  const rawStatus = typeof entry.billing_status === "string" ? entry.billing_status : "";
  const status = rawStatus === "discount" || rawStatus === "limited_free" ? rawStatus : "normal";
  const statusNote = typeof entry.billing_status_note === "string" ? entry.billing_status_note : "";
  const meta = {
    id,
    description,
    effectiveMultiplier: effective,
    baseMultiplier: base,
    status,
    statusNote
  };
  const readPositiveInt = (value) => {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  const tags = Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === "string").map((t) => t.toLowerCase()) : [];
  return {
    id,
    name: raccoonDisplayName(meta),
    contextWindow: readPositiveInt(params.context_window ?? entry.context_window),
    maxTokens: readPositiveInt(params.max_tokens),
    supportsImage: tags.includes("vision") || tags.includes("image") || tags.includes("image-understanding")
  };
}
class RaccoonAuth extends Service {
  constructor(ctx, options = {}) {
    const product = options.product ?? RACCOON;
    super(ctx, options.serviceName ?? `${product.id}Auth`);
    this.options = options;
    this.product = product;
    this.credentialRefName = this.product.defaultCredentialRef;
  }
  options;
  /** 本实例所属的产品配置。 */
  product;
  /** 本实例默认读写的凭据 ref 名称。 */
  credentialRefName;
  /** 最近一次续期失败的原因（供 `status()` 暴露给 UI）。 */
  lastRefreshError;
  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  get fetchImpl() {
    return this.options.fetcher ?? fetch;
  }
  /**
   * 启动登录（微信扫码 + 短信双路径）。
   *
   * 起本地服务器承载弹窗页，**立即返回 `loginUrl`** —— 与其余 provider 的
   * 「两步式」契约一致（`window.open` 只在用户手势窗口内有效，
   * 不能等流程跑完再返回）。
   */
  async startLogin() {
    return startRaccoonLoginFlow({
      product: this.product,
      ...this.options.fetcher === void 0 ? {} : { fetcher: this.options.fetcher }
    });
  }
  /**
   * 把登录结果落盘成凭据。
   *
   * 与 `startLogin` 分开：流程编排（本地服务器 + 轮询 + 表单）在
   * `raccoon-login-page.ts` 里，本方法只负责「补全用户信息 + 写凭据 +
   * 静默领取一次性登录奖励」。
   */
  async persistLogin(credential, flowOptions = {}) {
    const refName = flowOptions.refName ?? this.credentialRefName;
    let enriched = credential;
    if (credential.nickname === void 0 || credential.user_id === void 0 || credential.phone === void 0) {
      const info = await fetchRaccoonUserInfo(this.product, credential, this.fetchImpl);
      enriched = {
        ...credential,
        ...info.userId !== void 0 && credential.user_id === void 0 ? { user_id: info.userId } : {},
        ...info.nickname !== void 0 && credential.nickname === void 0 ? { nickname: info.nickname } : {},
        ...info.officeIdentity !== void 0 && credential.office_identity === void 0 ? { office_identity: info.officeIdentity } : {},
        // ⚠️ 手机号专门为**多账号消歧**而存：远端的 `name` 是自动生成的默认名
        //（实测 `RaccoonAva`），微信扫码不回传微信昵称，故多个账号会重名。
        ...info.phone !== void 0 && credential.phone === void 0 ? { phone: info.phone } : {}
      };
    }
    const ref = credentialRef(refName);
    await this.ctx.credentials.set(ref, JSON.stringify(enriched));
    this.lastRefreshError = void 0;
    try {
      await claimRaccoonLoginReward(this.product, enriched, this.fetchImpl);
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[raccoon] \u767B\u5F55\u540E\u9886\u53D6\u767B\u5F55\u5956\u52B1\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u767B\u5F55\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {
      access: JSON.stringify(enriched),
      expires: decodeJwtExpMs(enriched.access_token) ?? 0,
      ref,
      refreshable: isRaccoonRefreshable(enriched)
    };
  }
  /** 只读登录状态。 */
  async status() {
    const credential = await this.resolveDefaultCredential();
    if (credential === void 0) return { configured: false, refreshable: false };
    const expiresAt = decodeJwtExpMs(credential.access_token);
    return {
      configured: true,
      source: this.credentialRefName,
      ...expiresAt === void 0 ? {} : { expiresAt },
      refreshable: isRaccoonRefreshable(credential),
      ...this.lastRefreshError === void 0 ? {} : { refreshError: this.lastRefreshError }
    };
  }
  /** 解析默认 ref 的凭据。 */
  async resolveDefaultCredential() {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
      return resolved === void 0 ? void 0 : parseRaccoonCredential(resolved.value);
    } catch {
      return void 0;
    }
  }
  /**
   * 续期默认单凭据。
   *
   * @throws {RefreshTokenExpiredError} refresh_token 失效（需重新登录）。
   */
  async refresh() {
    const credential = await this.resolveDefaultCredential();
    if (credential === void 0) throw new RefreshTokenExpiredError("\u51ED\u636E\u672A\u914D\u7F6E\uFF0C\u8BF7\u5148\u767B\u5F55");
    if (!isRaccoonRefreshable(credential)) {
      throw new RefreshTokenExpiredError("\u51ED\u636E\u7F3A\u5C11 refresh_token\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    try {
      const next = await refreshRaccoonCredential(this.product, credential, this.fetchImpl);
      await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next));
      this.lastRefreshError = void 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastRefreshError = message;
      if (message.includes("\u91CD\u65B0\u767B\u5F55")) throw new RefreshTokenExpiredError(message);
      throw error;
    }
  }
  /**
   * 续期**指定 ref**（账号卡片「刷新」按钮）。
   *
   * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref —— 账号池里的是
   * `RACCOON_ACCOUNT_XXX`，用 `refresh()` 会刷错凭据。
   * ⚠️ **不触碰** `lastRefreshError`：那属于单凭据路径，
   * 被多账号操作污染会让 UI 显示错误的失效提示。
   */
  async refreshAccountCredential(refName) {
    const ref = credentialRef(refName);
    const resolved = await this.ctx.credentials.resolve(ref);
    if (!resolved) throw new Error("\u51ED\u636E\u672A\u914D\u7F6E");
    const credential = parseRaccoonCredential(resolved.value);
    if (!credential) throw new Error("\u51ED\u636E\u89E3\u6790\u5931\u8D25");
    if (!isRaccoonRefreshable(credential)) {
      throw new RefreshTokenExpiredError("\u51ED\u636E\u7F3A\u5C11 refresh_token\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    try {
      const next = await refreshRaccoonCredential(this.product, credential, this.fetchImpl);
      await this.ctx.credentials.set(ref, JSON.stringify(next));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("\u91CD\u65B0\u767B\u5F55")) throw new RefreshTokenExpiredError(message);
      throw error;
    }
  }
  /**
   * 批量续期本产品的账号。
   *
   * ⚠️ **只按 `refreshable` 过滤，不看 `enabled`**：停用只影响账号池的
   * 自动选号，与「凭据是否需要保持新鲜」无关。早期按 `enabled` 过滤导致
   * 两个停用账号的 refresh_token 在停用期间被放到失效（真实缺陷，见 AGENTS.md）。
   *
   * 单账号失败不影响其他账号（且**必须留日志**：曾完全静默的实现
   * 让「续期永远失败但 UI 显示可续期」无法排查）。
   */
  async refreshAll(pool) {
    const accounts = await pool.listAccounts(this.product.id);
    for (const entry of accounts) {
      if (!entry.refreshable) continue;
      const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef));
      if (!resolved) continue;
      const credential = parseRaccoonCredential(resolved.value);
      if (credential === void 0) continue;
      if (!isRaccoonExpired(credential)) continue;
      try {
        await this.refreshAccountCredential(entry.credentialRef);
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          this.ctx.logger?.warn?.(`[raccoon] \u8D26\u53F7 ${entry.id} \u7684 refresh_token \u5DF2\u5931\u6548\uFF0C\u9700\u91CD\u65B0\u767B\u5F55`);
        } else {
          this.ctx.logger?.warn?.(
            `[raccoon] \u8D26\u53F7 ${entry.id} \u7EED\u671F\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }
  /** 登出：清除默认单凭据。 */
  async logout() {
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName));
    this.lastRefreshError = void 0;
  }
  /**
   * 拉取远端模型目录。
   *
   * ⚠️ 失败时返回**空数组**：适配器据此回退兜底表。
   * 让模型目录失败不抛错，是为了不让整个 provider 在模型选择器里报错。
   */
  async fetchModels(pool) {
    const credential = await this.resolveForFetchModels(pool);
    if (credential === void 0) return [];
    try {
      const response = await this.fetchImpl(
        `${this.product.apiBase}${this.product.llmApiPrefix}/model_catalog`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.access_token}`,
            "X-Org-Code": credential.office_identity ?? "",
            "X-Raccoon-Language": "zh"
          },
          signal: AbortSignal.timeout(2e4)
        }
      );
      if (!response.ok) return [];
      const payload = await response.json();
      return parseRaccoonModelCatalog(payload);
    } catch {
      return [];
    }
  }
  /** 取一个可用凭据（先账号池，再默认 ref）。 */
  async resolveForFetchModels(pool) {
    if (pool !== void 0) {
      try {
        const available = await pool.getAvailableAccount(this.product.id, "");
        if (available !== null && available !== void 0) {
          const credential = available.credential;
          if (typeof credential?.access_token === "string") return credential;
        }
      } catch {
      }
    }
    return this.resolveDefaultCredential();
  }
  /** 查询积分余额（供 Jet Hub 账号卡片）。 */
  async fetchCreditBalance(credential) {
    return fetchRaccoonCreditBalance(this.product, credential, this.fetchImpl);
  }
  /** 领取一次性登录奖励。 */
  async claimLoginReward(credential) {
    return claimRaccoonLoginReward(this.product, credential, this.fetchImpl);
  }
  /** 查询一次性登录奖励是否已领。 */
  async fetchOnboardingStatus(credential) {
    return fetchRaccoonOnboardingStatus(this.product, credential, this.fetchImpl);
  }
  /**
   * 一次性修复**老账号**的昵称与凭据字段（启动时调用）。
   *
   * ## 为什么需要它
   *
   * 早期实现有两处不足，导致**已登录的账号不会自动更正**：
   *
   * 1. 账号昵称直接用了服务端的 `name`（实测 `RaccoonAva` —— 它是服务端
   *    **自动生成的默认名**，注册第二个账号时会重名、无法区分）；
   * 2. 凭据里**没有存 `phone`**（后来才发现 `user_info.phone` 可用于消歧）。
   *
   * 光改代码只影响**新登录**的账号，老账号的昵称/凭据仍是旧值。
   * 故这里主动补一次：读凭据 → 缺 `phone` 就拉一次 `user_info` 补上 →
   * 用 `buildRaccoonNickname` 重算昵称并写回账号池。
   *
   * ## 语义约束
   *
   * - **幂等**：昵称已是目标形态时不写（避免每次启动都落盘）。
   * - **失败不阻塞启动**：单个账号失败只记日志，抛错由调用方 catch。
   * - **不发写请求**：只调只读的 `user_info`，不碰积分领取端点。
   * - `buildNickname` 由调用方注入（它依赖 `jet-hub-rpc` 里的纯函数，
   *   而那个模块依赖本模块 —— 注入避免循环依赖）。
   *
   * @returns 被修复的账号 id 列表（供日志）。
   */
  async repairAccountNicknames(pool, buildNickname) {
    const repaired = [];
    let entries;
    try {
      entries = await pool.listAccounts(this.product.id);
    } catch {
      return repaired;
    }
    for (const entry of entries) {
      try {
        const ref = credentialRef(entry.credentialRef);
        const resolved = await this.ctx.credentials.resolve(ref);
        if (!resolved) continue;
        const credential = parseRaccoonCredential(resolved.value);
        if (credential === void 0) continue;
        let next = credential;
        if (credential.phone === void 0 || credential.user_id === void 0) {
          const info = await fetchRaccoonUserInfo(this.product, credential, this.fetchImpl);
          const patched = {
            ...credential,
            ...info.phone !== void 0 && credential.phone === void 0 ? { phone: info.phone } : {},
            ...info.userId !== void 0 && credential.user_id === void 0 ? { user_id: info.userId } : {},
            ...info.nickname !== void 0 && credential.nickname === void 0 ? { nickname: info.nickname } : {},
            ...info.officeIdentity !== void 0 && credential.office_identity === void 0 ? { office_identity: info.officeIdentity } : {}
          };
          const changed = JSON.stringify(patched) !== JSON.stringify(credential);
          if (changed) {
            await this.ctx.credentials.set(ref, JSON.stringify(patched));
            next = patched;
          }
        }
        const target = buildNickname(next, entry.id);
        if (target !== entry.nickname) {
          await pool.updateAccount(entry.id, { nickname: target });
          repaired.push(entry.id);
        }
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[raccoon] \u4FEE\u590D\u8D26\u53F7 ${entry.id} \u7684\u6635\u79F0\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u4F7F\u7528\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return repaired;
  }
}
function parseRaccoonModelCatalog(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const root = payload;
  if (root.code !== 0) return [];
  const data = typeof root.data === "object" && root.data !== null && !Array.isArray(root.data) ? root.data : void 0;
  if (data === void 0) return [];
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const chat = categories.find((c) => {
    return typeof c === "object" && c !== null && !Array.isArray(c) && c.type === "chat";
  });
  if (chat === void 0) return [];
  const models = Array.isArray(chat.models) ? chat.models : [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const raw of models) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const model = normalizeRemoteModel(raw);
    if (model === void 0 || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}
export {
  RACCOON_CREDENTIAL_REF,
  RaccoonAuth,
  RefreshTokenExpiredError,
  parseRaccoonCredential,
  parseRaccoonModelCatalog
};
