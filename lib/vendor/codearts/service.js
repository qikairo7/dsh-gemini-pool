import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { runLoginFlow, runOAuthFlow, startOAuthFlow } from "./login.js";
import {
  RefreshTokenExpiredError,
  credentialFromTokenResponse,
  exchangeRefreshToken,
  keyPairFromStoredJwk
} from "./oauth.js";
import {
  fetchCodeArtsRemoteModels,
  saveModelsCache,
  setMemoryCache
} from "./models.js";
const CODEARTS_CREDENTIAL_REF = "CODEARTS_ACCESS_TOKEN";
function parseCredential(value) {
  try {
    return JSON.parse(value);
  } catch {
    return void 0;
  }
}
class CodeArtsAuth extends Service {
  /** 登录会话是否仍处于活跃状态；stop() 置 false，防止在途刷新回写已登出凭据。 */
  active = true;
  /** 用于测试的可注入 fetch；默认为全局 fetch。 */
  fetchImpl = fetch;
  constructor(ctx, options = {}) {
    super(ctx, "codeartsAuth");
    if (options.fetcher) this.fetchImpl = options.fetcher;
  }
  /** 运行登录流程（默认新式 OAuth；flow: 'ticket' 走旧流程回退）并持久化凭据。 */
  async login(options = {}) {
    this.active = true;
    const flow = options.flow === "ticket" ? await runLoginFlow(options) : await runOAuthFlow(options);
    return this.persistLogin(flow, options);
  }
  /**
   * **两步式登录**：起回调服务器并立即返回登录 URL，由调用方先打开窗口。
   *
   * 为什么需要它（真实缺陷）：Jet Hub 的「+ 新建账号」原先调用阻塞式
   * {@link login}，而浏览器只在用户点击后的短暂窗口（transient activation，
   * 约 5 秒）内允许 `window.open`。等阻塞调用返回时手势早已过期，
   * `window.open` 被弹窗拦截器拒绝并返回 `null`，前端兜底逻辑便执行
   * `window.location.href = loginUrl`，把**整个设置页**跳转到登录页
   * ——用户看到的正是「主页面直接跳转过去了」。
   *
   * 与 CodeBuddy 系的做法对齐（那边是后端不 await、立即返回 loginUrl），
   * 因此三者现在都是「点击 → 弹出小窗 → 轮询等待」的同一交互。
   *
   * 调用方拿到 `loginUrl` 后应当**立即** `window.open`，再 await `result`。
   */
  async startLogin(options = {}) {
    this.active = true;
    const started = await startOAuthFlow(options);
    const result = started.result.then((flow) => this.persistLogin(flow, options));
    result.catch(() => {
    });
    return { loginUrl: started.loginUrl, result, close: started.close };
  }
  /**
   * 持久化一次登录结果：写凭据、按需登记账号池。
   *
   * 抽成独立方法供 {@link login} 与 {@link startLogin} 共用 ——
   * 两条路径的差别只在「何时返回 loginUrl」，落库逻辑必须完全一致，
   * 否则两步式路径会静默缺少账号登记。
   *
   * ⚠️ 单凭据模式移除后，**凭据一律写入账号池条目对应的 ref**
   * （Jet Hub 传入的 `CODEARTS_ACCOUNT_XXX`）。`refName` 缺省时仍回退到历史常量
   * `CODEARTS_CREDENTIAL_REF`，但**已无任何读取方**，仅为兼容既有调用签名。
   */
  async persistLogin(flow, options = {}) {
    const refName = options.refName ?? CODEARTS_CREDENTIAL_REF;
    const ref = credentialRef(refName);
    await this.ctx.credentials.set(ref, flow.access);
    if (options.pool) {
      void this.refreshModels(options.pool).catch(() => {
      });
    }
    const credential = parseCredential(flow.access);
    if (options.accountId && options.pool) {
      const expiresAt = credential?.expires_at ? Date.parse(credential.expires_at) : void 0;
      await options.pool.addAccount({
        id: options.accountId,
        provider: "codearts",
        nickname: options.accountId,
        enabled: true,
        credentialRef: refName,
        createdAt: Date.now(),
        expiresAt: Number.isNaN(expiresAt) ? void 0 : expiresAt,
        refreshable: Boolean(credential?.refresh_token)
      });
    }
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: Boolean(credential?.refresh_token)
    };
  }
  /**
   * 按凭据 ref 续期**指定账号**的凭据。
   *
   * 这是 Jet Hub 账号卡片「刷新」按钮与定时调度器走的路径，读写的是账号池条目
   * 对应的 `CODEARTS_ACCOUNT_XXX`。
   *
   * ⚠️ 早期这里的方法注释在对比一个 `refresh()` —— 那个方法读写固定单凭据 ref
   * `CODEARTS_ACCESS_TOKEN`，**已随单凭据模式一并移除**。当时用 `refresh()`
   * 去刷账号池里的账号会刷到另一个凭据上（真实缺陷），这也是 `account.refresh`
   * RPC 一定要按 `entry.credentialRef` 分派的原因。现在只剩本方法这一条路径。
   */
  async refreshAccountCredential(refName) {
    const ref = credentialRef(refName);
    const resolved = await this.ctx.credentials.resolve(ref);
    if (!resolved) throw new Error("\u51ED\u636E\u672A\u914D\u7F6E");
    const credential = parseCredential(resolved.value);
    if (!credential?.refresh_token || !credential.code_verifier || !credential.dpop_private_key_jwk) {
      throw new Error("\u65E0 refresh_token\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    const keyPair = keyPairFromStoredJwk(credential.dpop_private_key_jwk);
    const token = await exchangeRefreshToken(credential.refresh_token, credential.code_verifier, keyPair, this.fetchImpl);
    const refreshed = credentialFromTokenResponse(token, { codeVerifier: credential.code_verifier, codeChallenge: "" }, keyPair);
    refreshed.domain_id = credential.domain_id;
    refreshed.user_id = credential.user_id;
    refreshed.user_name = credential.user_name;
    if (credential.model_rate_limits) refreshed.model_rate_limits = credential.model_rate_limits;
    await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
  }
  /**
   * 批量续期所有 codearts 账号。
   *
   * **包含已停用账号**（只按 `refreshable` 过滤）：停用只应影响账号池的自动
   * 选号，不该让凭据烂掉 —— 否则用户重新启用时只能重新登录。
   * 详见 `BuddyAuth.refreshAll` 的注释（同一缺陷）。
   *
   * 单账号失败不影响其他账号。
   */
  async refreshAll(pool) {
    const accounts = await pool.listAccounts("codearts");
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
        if (!credential?.refresh_token || !credential.code_verifier || !credential.dpop_private_key_jwk) {
          await pool.updateAccount(entry.id, { refreshable: false });
          continue;
        }
        const keyPair = keyPairFromStoredJwk(credential.dpop_private_key_jwk);
        const token = await exchangeRefreshToken(credential.refresh_token, credential.code_verifier, keyPair, this.fetchImpl);
        const refreshed = credentialFromTokenResponse(token, { codeVerifier: credential.code_verifier, codeChallenge: "" }, keyPair);
        refreshed.domain_id = credential.domain_id;
        refreshed.user_id = credential.user_id;
        refreshed.user_name = credential.user_name;
        if (credential.model_rate_limits) {
          refreshed.model_rate_limits = credential.model_rate_limits;
        }
        await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
        const expiresAt = refreshed.expires_at ? Date.parse(refreshed.expires_at) : void 0;
        await pool.updateAccount(entry.id, {
          expiresAt: expiresAt !== void 0 && !Number.isNaN(expiresAt) ? expiresAt : void 0,
          refreshable: Boolean(refreshed.refresh_token)
        });
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false });
          } catch {
          }
        }
      }
    }
  }
  /**
   * 停止服务：置 inactive，阻止在途刷新回写。
   *
   * 单凭据模式移除后这里不再需要停调度器 —— 登录态与续期都归属账号池条目，
   * 续期由 `src/index.ts` 的多账号调度器（{@link refreshAll}）驱动。
   */
  stop() {
    this.active = false;
  }
  /**
   * 用**账号池里某个可用账号**的凭据从远端拉取模型列表；非空时更新内存缓存与磁盘。
   *
   * ⚠️ **必须传 `pool`**：CodeArts 已移除「单凭据模式」，不再有
   * `CODEARTS_ACCESS_TOKEN` 那样的固定 ref 可读 —— 凭据一律来自账号池条目
   * （`CODEARTS_ACCOUNT_XXX`）。早期签名不接收 `pool` 并直接读固定 ref，
   * 移除单凭据后那样会恒返回空列表。
   *
   * 为什么用「可用账号」而不是遍历全部账号：模型目录是**账号无关**的（同一个
   * 华为云账号体系下发同一份目录），取第一个能解析出 AK/SK 的账号即可，
   * 无需为每个账号各拉一次。
   */
  async refreshModels(pool) {
    if (!this.active) return [];
    const credential = await this.firstUsableCredential(pool);
    if (credential === void 0) return [];
    const models = await fetchCodeArtsRemoteModels(credential, this.fetchImpl);
    if (models.length > 0) {
      setMemoryCache(models);
      saveModelsCache(models);
    }
    return models;
  }
  /**
   * 取账号池里第一个**凭据可解析且含 AK/SK** 的账号凭据。
   *
   * 按 `readAccounts()` 的既有顺序（用户的 Jet Hub 拖拽顺序）遍历，短路返回。
   * `getAvailableAccount` 不适合这里：它会按 `enabled` 与限流状态过滤，而
   * 「拉模型目录」既不需要账号处于启用状态、也与限流无关。
   */
  async firstUsableCredential(pool) {
    for (const entry of pool.listAccountsByProvider("codearts")) {
      const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef));
      if (!resolved) continue;
      const credential = parseCredential(resolved.value);
      if (credential?.access_key_id && credential.secret_access_key) return credential;
    }
    return void 0;
  }
}
export {
  CODEARTS_CREDENTIAL_REF,
  CodeArtsAuth
};
