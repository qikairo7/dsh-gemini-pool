const LOOMY_BALANCE_TIER = Object.freeze({
  /** 有今日赠送额度（`dailyBalance > 0`）—— 优先消耗它（每天刷新、不用会浪费）。 */
  daily: 0,
  /** 只剩永久积分（`permanentBalance > 0`）。 */
  permanent: 1,
  /** 无余额 / 查询失败。 */
  none: 2
});
function loomyBalanceTier(balance, options = {}) {
  const daily = positiveNumber(balance.dailyBalance);
  if (daily > 0) return LOOMY_BALANCE_TIER.daily;
  if (options.allowPermanent === false) return LOOMY_BALANCE_TIER.none;
  const permanent = positiveNumber(balance.permanentBalance);
  if (permanent > 0) return LOOMY_BALANCE_TIER.permanent;
  return LOOMY_BALANCE_TIER.none;
}
function loomyTierUsable(tier) {
  return tier !== LOOMY_BALANCE_TIER.none;
}
function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function rankLoomyAccountsByBalance(accounts, options = {}) {
  return accounts.map((account, index) => ({ account, index, tier: loomyBalanceTier(account, options) })).sort((a, b) => a.tier - b.tier || a.index - b.index).map((entry) => entry.account);
}
export {
  LOOMY_BALANCE_TIER,
  loomyBalanceTier,
  loomyTierUsable,
  rankLoomyAccountsByBalance
};
