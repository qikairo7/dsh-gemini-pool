import {
  LOOMY_REQUEST_TIMEOUT_MS,
  parseLoomyEnvelope
} from "./loomy.js";
const LOOMY_DAILY_QUOTA_DESCRIPTION = "\u6BCF\u65E5\u8D60\u9001\u989D\u5EA6\uFF08\u6D88\u8017\u540E\u4E0D\u56DE\u8865\uFF09";
async function tryRequestLoomy(credential, product, path, init, fetcher) {
  const headers = { Accept: "application/json", token: credential.access_token };
  let payload;
  if (init.body !== void 0) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(init.body);
  }
  let response;
  try {
    response = await fetcher(`${product.apiBase}${path}`, {
      method: init.method,
      headers,
      ...payload === void 0 ? {} : { body: payload },
      signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    return { ok: false, code: "NETWORK", message: error instanceof Error ? error.message : String(error) };
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, code: `HTTP_${response.status}`, message: `\u54CD\u5E94\u4E0D\u662F JSON\uFF08HTTP ${response.status}\uFF09` };
  }
  const envelope = parseLoomyEnvelope(parsed);
  if (!envelope.ok) {
    return { ok: false, code: envelope.code, message: envelope.message };
  }
  return { ok: true, data: envelope.data };
}
function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
async function fetchLoomyCreditDetail(credential, product, fetcher = fetch) {
  const result = await tryRequestLoomy(
    credential,
    product,
    "/points/records?pageNo=1&pageSize=1&recordType=all",
    { method: "GET" },
    fetcher
  );
  if (!result.ok) return null;
  const permanent = readNumber(result.data?.balance);
  const daily = readNumber(result.data?.dailyBalance);
  const available = readNumber(result.data?.availableBalance);
  if (permanent === void 0) return null;
  const total = available ?? permanent + (daily ?? 0);
  return {
    permanent,
    daily: daily ?? 0,
    total,
    dailyQuota: readNumber(result.data?.dailyQuota),
    dailyConsumed: readNumber(result.data?.dailyConsumed),
    dailyCycleDate: typeof result.data?.dailyCycleDate === "string" ? result.data.dailyCycleDate : void 0
  };
}
function makePackage(name, remaining) {
  return {
    name,
    unit: "\u79EF\u5206",
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: "",
    cycleEndTime: "",
    expiredTime: ""
  };
}
async function fetchLoomyCreditBalance(credential, product, fetcher = fetch) {
  const detail = await fetchLoomyCreditDetail(credential, product, fetcher);
  if (detail === null) return null;
  return {
    total: detail.total,
    packages: [
      makePackage("\u6C38\u4E45\u79EF\u5206", detail.permanent),
      makePackage("\u6BCF\u65E5\u8D60\u9001", detail.daily)
    ],
    // 两池都视为有效额度，没有「已失效」概念。
    expiredTotal: 0
  };
}
async function claimLoomyDailyQuota(credential, product, fetcher = fetch) {
  const result = await tryRequestLoomy(
    credential,
    product,
    "/points/first-login",
    { method: "POST", body: {} },
    fetcher
  );
  if (!result.ok) {
    return { kind: "failed", code: -1, message: result.message };
  }
  const dailyQuota = readNumber(result.data?.dailyQuota);
  const dailyBalance = readNumber(result.data?.dailyBalance);
  const alreadyProcessed = result.data?.alreadyProcessed === true;
  if (alreadyProcessed) {
    return {
      kind: "already-claimed",
      message: dailyQuota === void 0 ? "\u4ECA\u65E5\u989D\u5EA6\u5DF2\u521D\u59CB\u5316" : `\u4ECA\u65E5\u989D\u5EA6\u5DF2\u521D\u59CB\u5316\uFF08\u6BCF\u65E5 ${dailyBalance ?? 0}/${dailyQuota}\uFF09`
    };
  }
  const dailyConsumed = readNumber(result.data?.dailyConsumed);
  const granted = dailyQuota !== void 0 && dailyConsumed !== void 0 ? Math.max(0, dailyQuota - dailyConsumed) : dailyQuota ?? 0;
  return { kind: "claimed", credit: granted, streakDays: 0, isStreakDay: false };
}
export {
  LOOMY_DAILY_QUOTA_DESCRIPTION,
  claimLoomyDailyQuota,
  fetchLoomyCreditBalance,
  fetchLoomyCreditDetail
};
