import { roundCredits } from "./credits.js";
import { clineAuthHeaders } from "./cline.js";
const CLINE_CREDITS_TIMEOUT_MS = 3e4;
const CLINE_BALANCE_SCALE = 1e5;
function readNumber(source, key) {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return void 0;
}
function toClineCreditBalance(rawBalance) {
  const total = roundCredits(rawBalance / CLINE_BALANCE_SCALE);
  const pkg = {
    name: "Cline \u8D26\u6237\u4F59\u989D",
    unit: "USD",
    remaining: total,
    total,
    used: 0,
    active: true,
    cycleStartTime: "",
    cycleEndTime: "",
    expiredTime: ""
  };
  return { total, packages: [pkg], expiredTotal: 0 };
}
function parseClineBalanceResponse(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61" };
  }
  const record = value;
  const serverError = typeof record.error === "string" && record.error.trim().length > 0 ? record.error.trim() : void 0;
  if (record.success === false || serverError !== void 0 && record.success !== true) {
    return { error: serverError ?? "\u670D\u52A1\u7AEF\u8FD4\u56DE\u5931\u8D25" };
  }
  const data = typeof record.data === "object" && record.data !== null && !Array.isArray(record.data) ? record.data : void 0;
  if (data === void 0) return { error: "\u54CD\u5E94\u7F3A\u5C11 data \u5B57\u6BB5" };
  const rawBalance = readNumber(data, "balance");
  if (rawBalance === void 0) return { error: "\u54CD\u5E94\u7F3A\u5C11 balance \u5B57\u6BB5" };
  return { rawBalance };
}
async function fetchClineCreditBalance(credential, product, fetcher = fetch, options = {}) {
  const userId = credential.account_id;
  if (typeof userId !== "string" || userId.trim().length === 0) {
    return { balance: null, error: "\u51ED\u636E\u7F3A\u5C11\u8D26\u53F7 id\uFF0C\u65E0\u6CD5\u67E5\u8BE2\u4F59\u989D" };
  }
  const url = `${product.apiBase}/api/v1/users/${encodeURIComponent(userId.trim())}/balance`;
  let response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: clineAuthHeaders(credential.access_token, product),
      signal: options.signal ?? AbortSignal.timeout(CLINE_CREDITS_TIMEOUT_MS)
    });
  } catch (error) {
    return { balance: null, error: `\u4F59\u989D\u67E5\u8BE2\u7F51\u7EDC\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}` };
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    return { balance: null, error: `\u4F59\u989D\u54CD\u5E94\u4E0D\u662F JSON\uFF08HTTP ${response.status}\uFF09` };
  }
  if (!response.ok) {
    const detail = parseClineBalanceResponse(parsed);
    return {
      balance: null,
      error: detail.error !== void 0 ? `\u4F59\u989D\u67E5\u8BE2\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\uFF1A${detail.error}` : `\u4F59\u989D\u67E5\u8BE2\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`
    };
  }
  const result = parseClineBalanceResponse(parsed);
  if (result.rawBalance === void 0) {
    return { balance: null, ...result.error === void 0 ? {} : { error: result.error } };
  }
  return {
    balance: toClineCreditBalance(result.rawBalance),
    rawBalance: result.rawBalance
  };
}
export {
  CLINE_BALANCE_SCALE,
  CLINE_CREDITS_TIMEOUT_MS,
  fetchClineCreditBalance,
  parseClineBalanceResponse,
  toClineCreditBalance
};
