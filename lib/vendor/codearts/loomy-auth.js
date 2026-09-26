import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  LOOMY_AUTH_ERROR_CODE,
  LOOMY_REQUEST_TIMEOUT_MS,
  credentialExpiresAtMs,
  isLoomyExpired,
  parseLoomyEnvelope
} from "./loomy.js";
import { LOOMY } from "./loomy-product.js";
import { LOOMY_SESSION_TTL_SECONDS, loginLoomyBySmsCode, sendLoomySmsCode } from "./loomy-oauth.js";
import {
  startLoomyWechatLoginFlow
} from "./loomy-wechat-login.js";
import { claimLoomyDailyQuota, fetchLoomyCreditBalance, fetchLoomyCreditDetail } from "./loomy-credits.js";
import {
  claimAllLoomyOnboardingTasks,
  fetchLoomyOnboardingTasks
} from "./loomy-onboarding.js";
const LOOMY_CREDENTIAL_REF = "LOOMY_ACCESS_TOKEN";
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
class LoomyAuth extends Service {
  constructor(ctx, options = {}) {
    const product = options.product ?? LOOMY;
    super(ctx, options.serviceName ?? `${product.id}Auth`);
    this.options = options;
    this.product = product;
    this.credentialRefName = this.product.defaultCredentialRef;
  }
  options;
  /** 本实例所属的产品配置。 */
  product;
  /** 本实例默认读写的凭据 ref 名称（`LOOMY_ACCESS_TOKEN`）。 */
  credentialRefName;
  /**
   * ⚠️ **刻意不使用 `RefreshScheduler`。**
   *
   * 那个调度器的存在意义是「在凭据过期前提前触发续期」
   * （`computeFirstRefreshDelayMs` 会在过期前 1 小时触发）。Loomy **无法续期**，
   * 武装它只会得到「1 小时后触发 → 探测 → 必然抛 RefreshTokenExpiredError
   * → 调度器停止」这一串无意义动作。
   *
   * 健康检查改由 `refreshAll(pool)` 承担 —— 它由 `index.ts` 的 30 分钟
   * 定时器驱动，只探测**已过期**的账号，语义与行为都诚实。
   * 故 `scheduleRefresh()` / `stop()` 是**有意为之的空实现**。
   */
  /** 最近一次探测失败的原因（供 `status()` 暴露给 UI）。 */
  lastRefreshError;
  /** 登录会话是否仍活跃；logout()/stop() 置 false。 */
  active = true;
  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  get fetchImpl() {
    return this.options.fetcher ?? fetch;
  }
  /**
   * 下发短信验证码。
   *
   * @returns `msgid` —— 提交验证码时必须原样带回。
   */
  async sendSmsCode(phone) {
    return sendLoomySmsCode(phone, this.product, this.fetchImpl);
  }
  /**
   * 启动**微信扫码**登录（推荐路径）。
   *
   * 起本地服务器承载弹窗页（内联二维码 + 轮询 + 首次绑手机号表单），
   * 立即返回 `loginUrl` —— 与其余 provider 的「两步式」契约一致
   * （`window.open` 只在用户手势窗口内有效，不能等流程跑完再返回）。
   *
   * ⚠️ 与官方 Electron 实现的关键差异：官方用 `BrowserWindow` 的
   * `will-redirect` 截获微信 code，而回调页实测 404；本实现改为
   * **长轮询**直接拿 code（见 `loomy-wechat.ts`），完全不碰回调页。
   */
  async startWechatLogin() {
    this.active = true;
    return startLoomyWechatLoginFlow({
      product: this.product,
      ...this.options.fetcher === void 0 ? {} : { fetcher: this.options.fetcher }
    });
  }
  /**
   * 把微信扫码流程的结果落盘成凭据。
   *
   * 与 `loginWithSmsCode` 分开：微信流程的编排（本地服务器 + 轮询 + 绑定表单）
   * 在 `loomy-wechat-login.ts` 里，本方法只负责「写凭据 + 初始化每日额度」。
   */
  async persistWechatLogin(login, flowOptions = {}) {
    const credential = this.buildCredential(
      login.session,
      login.userid,
      login.phone,
      login.nickname
    );
    const refName = flowOptions.refName ?? this.credentialRefName;
    const ref = credentialRef(refName);
    await this.ctx.credentials.set(ref, JSON.stringify(credential));
    this.lastRefreshError = void 0;
    try {
      await claimLoomyDailyQuota(credential, this.product, this.fetchImpl);
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[loomy] \u5FAE\u4FE1\u767B\u5F55\u540E\u521D\u59CB\u5316\u6BCF\u65E5\u989D\u5EA6\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u767B\u5F55\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {
      access: JSON.stringify(credential),
      expires: credentialExpiresAtMs(credential) ?? 0,
      ref,
      refreshable: false
    };
  }
  /**
   * 用短信验证码登录并持久化凭据。
   *
   * `accountId` + `pool` 同时提供时，登录成功后自动把账号登记进账号池。
   */
  async loginWithSmsCode(phone, code, msgid, flowOptions = {}) {
    this.active = true;
    const result = await loginLoomyBySmsCode(phone, code, msgid, this.product, this.fetchImpl);
    const credential = this.buildCredential(result.session, result.userid, phone);
    const refName = flowOptions.refName ?? this.credentialRefName;
    const ref = credentialRef(refName);
    await this.ctx.credentials.set(ref, JSON.stringify(credential));
    this.lastRefreshError = void 0;
    try {
      await claimLoomyDailyQuota(credential, this.product, this.fetchImpl);
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[loomy] \u767B\u5F55\u540E\u521D\u59CB\u5316\u6BCF\u65E5\u989D\u5EA6\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u767B\u5F55\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`
      );
    }
    return {
      access: JSON.stringify(credential),
      expires: credentialExpiresAtMs(credential) ?? 0,
      ref,
      // ⚠️ 恒 false：Loomy 无续期机制。
      refreshable: false
    };
  }
  /**
   * 构造凭据对象。
   *
   * ⚠️ `expires_at` 由**本地**按 14 天推算 —— 服务端响应里不带到期时间戳，
   * 它只接受登录请求里的 `expire` 参数。
   */
  buildCredential(session, userid, phone, nickname) {
    return {
      access_token: session,
      userid,
      phone,
      ...nickname === void 0 || nickname.length === 0 ? {} : { nickname },
      expires_at: String(Date.now() + LOOMY_SESSION_TTL_SECONDS * 1e3)
    };
  }
  /** 解析当前单凭据（默认 ref）。 */
  async resolveDefaultCredential() {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
    return resolved === void 0 ? void 0 : parseCredential(resolved.value);
  }
  /** 只读登录状态。 */
  async status() {
    const credential = await this.resolveDefaultCredential();
    if (credential === void 0) return { configured: false, refreshable: false };
    const expiresAt = credentialExpiresAtMs(credential);
    return {
      configured: true,
      source: this.credentialRefName,
      ...expiresAt === void 0 ? {} : { expiresAt },
      // ⚠️ 恒 false：Loomy 无续期机制。UI 据此显示「过期需重新登录」。
      refreshable: false,
      ...this.lastRefreshError === void 0 ? {} : { refreshError: this.lastRefreshError }
    };
  }
  /**
   * 探测凭据有效性（**不续期**）。
   *
   * ⚠️ 这是与其余 provider 语义上的关键差异：`refresh()` 在那边意味着
   * 「换一份新凭据」，在这里只能是「确认这份凭据还活着」。
   * 失效时抛 `RefreshTokenExpiredError`，让 UI 明确提示重新登录，
   * 而不是静默假装成功。
   */
  async refresh() {
    const credential = await this.resolveDefaultCredential();
    if (credential === void 0) throw new RefreshTokenExpiredError("\u51ED\u636E\u672A\u914D\u7F6E\uFF0C\u8BF7\u5148\u767B\u5F55");
    await this.probeCredential(credential);
    this.lastRefreshError = void 0;
  }
  /**
   * 探测指定 ref 的凭据有效性（账号卡片「刷新」按钮）。
   *
   * ⚠️ 与 `refresh()` 的区别：`refresh()` 读写默认单凭据 ref，
   * 而账号卡片对应的是 `LOOMY_ACCOUNT_XXX`。用 `refresh()` 刷账号池里的
   * 账号实际刷的是另一个凭据（本插件在 Cline 上踩过同类坑）。
   *
   * ⚠️ **不触碰** `lastRefreshError`：那个状态属于单凭据路径，
   * 被多账号操作污染会让 UI 显示错误的失效提示。
   */
  async refreshAccountCredential(refName) {
    const ref = credentialRef(refName);
    const resolved = await this.ctx.credentials.resolve(ref);
    if (!resolved) throw new Error("\u51ED\u636E\u672A\u914D\u7F6E");
    const credential = parseCredential(resolved.value);
    if (!credential) throw new Error("\u51ED\u636E\u89E3\u6790\u5931\u8D25");
    await this.probeCredential(credential);
  }
  /**
   * 用一次轻量只读请求验证凭据是否仍然有效。
   *
   * 选 `GET /points/records?pageSize=1` 的理由：它是最便宜的只读端点
   * （不消耗积分、不产生任何副作用），且认证语义与其它业务端点一致。
   *
   * @throws {RefreshTokenExpiredError} 收到 `100002`（登录已失效）。
   */
  async probeCredential(credential) {
    let response;
    try {
      response = await this.fetchImpl(
        `${this.product.apiBase}/points/records?pageNo=1&pageSize=1&recordType=all`,
        {
          method: "GET",
          headers: { Accept: "application/json", token: credential.access_token },
          signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS)
        }
      );
    } catch (error) {
      throw new Error(`Loomy \u51ED\u636E\u63A2\u6D4B\u7F51\u7EDC\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw new Error(`Loomy \u51ED\u636E\u63A2\u6D4B\u54CD\u5E94\u4E0D\u662F JSON\uFF08HTTP ${response.status}\uFF09`);
    }
    const envelope = parseLoomyEnvelope(parsed);
    if (envelope.ok) return;
    if (envelope.code === LOOMY_AUTH_ERROR_CODE) {
      throw new RefreshTokenExpiredError(`Loomy \u51ED\u8BC1\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\uFF08${envelope.message}\uFF09`);
    }
    throw new Error(`Loomy \u51ED\u636E\u63A2\u6D4B\u5931\u8D25\uFF1A${envelope.message}`);
  }
  /**
   * 批量探测本产品的账号。
   *
   * ⚠️ **只探测已过期的账号**：Loomy 不可续期，对未过期的账号做探测
   * 纯属白费请求（`refreshAll` 每 30 分钟跑一次）。
   *
   * ⚠️ 按 AGENTS.md 约定，过滤**只看过期状态，不看 `enabled`** ——
   * 停用只影响账号池的自动选号，与凭据健康无关。
   *
   * 单账号失败不影响其他账号。
   */
  async refreshAll(pool) {
    const accounts = await pool.listAccounts(this.product.id);
    for (const entry of accounts) {
      const ref = credentialRef(entry.credentialRef);
      let credential;
      try {
        const resolved = await this.ctx.credentials.resolve(ref);
        if (!resolved) continue;
        credential = parseCredential(resolved.value);
      } catch {
        continue;
      }
      if (credential === void 0) continue;
      if (!isLoomyExpired(credential)) continue;
      try {
        await this.probeCredential(credential);
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          this.ctx.logger?.warn?.(
            `[loomy] \u8D26\u53F7 ${entry.id} \u7684\u51ED\u8BC1\u5DF2\u5931\u6548\uFF08Loomy \u65E0\u7EED\u671F\u7AEF\u70B9\uFF0C\u9700\u91CD\u65B0\u767B\u5F55\uFF09`
          );
        } else {
          this.ctx.logger?.warn?.(
            `[loomy] \u8D26\u53F7 ${entry.id} \u51ED\u8BC1\u63A2\u6D4B\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }
  /** 登出：清除默认单凭据。 */
  async logout() {
    this.active = false;
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName));
    this.lastRefreshError = void 0;
  }
  /**
   * **有意为之的空实现。**
   *
   * 其余 provider 用它武装 `RefreshScheduler`（过期前 1 小时自动续期）。
   * Loomy **无法续期**，武装调度器只会得到一串无意义的「探测 → 必然失败」。
   * 账号健康由 `refreshAll(pool)` 承担（`index.ts` 的 30 分钟定时器驱动）。
   *
   * 保留该方法是**契约要求**：`index.ts` 对全部 provider 统一调用
   * `scheduleRefresh()`，缺了它会以 `is not a function` 崩在启动路径上。
   */
  scheduleRefresh() {
  }
  /**
   * **有意为之的空实现。**
   *
   * 与 `scheduleRefresh()` 同理：没有调度器需要停止。
   * 保留它是契约要求 —— `index.ts` 的 cleanup 对全部 provider 统一调 `stop()`。
   */
  stop() {
    this.active = false;
  }
  // ── 业务能力（供 Jet Hub RPC 调用）────────────────────────────────
  /** 查询积分余额（只读，两池映射成 CreditBalance）。 */
  async fetchCreditBalance(credential) {
    return fetchLoomyCreditBalance(credential, this.product, this.fetchImpl);
  }
  /** 查询积分两池明细（只读）。 */
  async fetchCreditDetail(credential) {
    return fetchLoomyCreditDetail(credential, this.product, this.fetchImpl);
  }
  /** 一键签到：触发每日额度。 */
  async claimDailyQuota(credential) {
    return claimLoomyDailyQuota(credential, this.product, this.fetchImpl);
  }
  /** 查询新手任务状态。 */
  async fetchOnboardingTasks(credential) {
    return fetchLoomyOnboardingTasks(credential, this.product, this.fetchImpl);
  }
  /** 领取全部新手任务（补差额）。 */
  async claimOnboardingTasks(credential) {
    return claimAllLoomyOnboardingTasks(credential, this.product, this.fetchImpl);
  }
}
export {
  LOOMY_CREDENTIAL_REF,
  LoomyAuth,
  RefreshTokenExpiredError
};
