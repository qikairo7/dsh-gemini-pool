import { fetchLoomyCreditDetail } from "./loomy-credits.js";
import {
  loomyBalanceTier,
  loomyTierUsable,
  rankLoomyAccountsByBalance
} from "./loomy-balance-rank.js";
const LOOMY_BALANCE_CACHE_TTL_MS = 6e4;
class LoomyBalanceSelector {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  cache = /* @__PURE__ */ new Map();
  /** 清空缓存（凭据变化、手动刷新余额后调用）。 */
  invalidate(accountId) {
    if (accountId === void 0) this.cache.clear();
    else this.cache.delete(accountId);
  }
  /**
   * 查一个账号的余额（带 TTL 缓存）。
   *
   * ⚠️ **查询失败不抛错**：返回 `ok: false` 的条目，由分档逻辑归入最后一档。
   * 让「一个号查不到」不至于让整个选号失败。
   */
  async balanceOf(account) {
    const now = this.deps.now?.() ?? Date.now();
    const ttl = this.deps.ttlMs ?? LOOMY_BALANCE_CACHE_TTL_MS;
    const cached = this.cache.get(account.id);
    if (cached !== void 0 && now - cached.at < ttl) return cached.value;
    const value = await this.fetchBalance(account);
    this.cache.set(account.id, { at: now, value });
    return value;
  }
  /** 真正发请求查一次余额。 */
  async fetchBalance(account) {
    let credential;
    try {
      credential = await this.deps.resolveCredential(account.credentialRef);
    } catch (error) {
      return {
        id: account.id,
        ok: false,
        error: `\u8BFB\u53D6\u51ED\u636E\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (credential === void 0) {
      return { id: account.id, ok: false, error: "\u51ED\u636E\u672A\u914D\u7F6E\u6216\u5DF2\u5931\u6548" };
    }
    const detail = await fetchLoomyCreditDetail(
      credential,
      this.deps.product,
      this.deps.fetcher ?? fetch
    );
    if (detail === null) {
      return { id: account.id, ok: false, error: "\u4F59\u989D\u67E5\u8BE2\u5931\u8D25\uFF08\u51ED\u636E\u5931\u6548\u6216\u54CD\u5E94\u5F02\u5E38\uFF09" };
    }
    return {
      id: account.id,
      ok: true,
      dailyBalance: detail.daily,
      permanentBalance: detail.permanent
    };
  }
  /**
   * 从候选账号中按余额优先选一个。
   *
   * 排序规则见 `rankLoomyAccountsByBalance`：
   * 有今日额度 → 只剩永久 → 无余额/查不到。**档内保持传入顺序**。
   *
   * ⚠️ 返回的是**第一个**候选（而不是随机），因为档内顺序 = 用户手动顺序。
   *
   * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：只剩永久积分的账号
   * 落入 `none` 档（不可用）。若**全部候选都不可用**，本方法返回 `undefined`
   * —— 调用方据此报「无可用账号」的明确错误（用户要求），而不是硬着头皮
   * 用永久积分。
   *
   * @param candidates - 已按 `enabled` 与模型限流过滤过的候选（顺序即手动优先级）。
   * @param options - `allowPermanent` 为 false 时禁止消耗永久积分。
   * @returns 选中的账号 + 其余额；**无可用账号**时返回 undefined。
   */
  async select(candidates, options = {}) {
    if (candidates.length === 0) return void 0;
    const balances = await Promise.all(candidates.map((c) => this.balanceOf(c)));
    const byId = new Map(candidates.map((c, i) => [c.id, { account: c, balance: balances[i] }]));
    const ranked = rankLoomyAccountsByBalance(
      balances.map((b) => ({ ...b, id: b.id })),
      options
    );
    const first = ranked[0];
    if (first === void 0) return void 0;
    if (options.allowPermanent === false && !loomyTierUsable(loomyBalanceTier(first, options))) {
      return void 0;
    }
    const picked = byId.get(first.id);
    return picked;
  }
}
export {
  LOOMY_BALANCE_CACHE_TTL_MS,
  LoomyBalanceSelector
};
