import { signRequestHuawei } from "./sign.js";
const CODEARTS_SNAP_ENGINE_URL = "https://snap-access.cn-north-4.myhuaweicloud.com";
const CODEARTS_PACKAGE_INFO_PATH = "/snap-manager/v1/statistics/plugin";
const CODEARTS_OPS_DELIVERY_PATH = "/v1/ops/delivery";
const CODEARTS_OPS_CLAIM_PATH = "/v1/ops/claim";
const CODEARTS_OPS_CONFIRM_PATH = "/v1/ops/confirm";
const CODEARTS_OPS_CHANNEL = "IDE";
const CODEARTS_DAILY_LOGIN_TYPE = "USER_LOGIN";
const CLAIMED_STATUSES = ["CLAIMED", "CONFIRMED", "CONSUMED"];
const REQUEST_TIMEOUT_MS = 3e4;
const SNAP_EXTRA_HEADERS = {
  "Agent-Type": "PromptCenter",
  "X-Language": "zh-cn"
};
const CREDIT_METRIC_LABELS = {
  usageTotalPackageCredit: "\u603B\u79EF\u5206\u5305",
  usageBasicPackageCredit: "\u57FA\u7840\u79EF\u5206\u5305",
  usageOnDemandPackageCredit: "\u6309\u9700\u79EF\u5206\u5305",
  usageBonusPackageCredit: "\u8D60\u9001\u79EF\u5206\u5305"
};
const TOTAL_CREDIT_METRIC = "usageTotalPackageCredit";
const UNPARSABLE_RESPONSE_MESSAGE = "\u8BF7\u6C42\u5931\u8D25\u6216\u54CD\u5E94\u65E0\u6CD5\u89E3\u6790";
function describeHttpFailure(status, text) {
  let detail = "";
  try {
    const parsed = JSON.parse(text);
    const code = typeof parsed.error_code === "string" ? parsed.error_code : "";
    const msg = typeof parsed.error_msg === "string" ? parsed.error_msg : "";
    detail = [code, msg].filter((part) => part.length > 0).join(" ");
  } catch {
    detail = text.trim().slice(0, 200);
  }
  return detail.length > 0 ? `HTTP ${status}\uFF1A${detail}` : `HTTP ${status}`;
}
function readBool(source, key) {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}
function readNumber(source, key) {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
function readString(source, key) {
  const value = source[key];
  return typeof value === "string" ? value : "";
}
function readIdentifier(source, key) {
  const value = source[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
function readRecord(source, key) {
  const value = source[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function unwrapSnapEnvelope(raw) {
  const code = raw.code;
  const hasCode = typeof code === "number";
  if (hasCode) {
    if (code !== 0) {
      const message = readString(raw, "message") || readString(raw, "msg");
      return { ok: false, code, message: message.length > 0 ? message : `\u4E1A\u52A1\u7801 ${code}` };
    }
    const data = raw.data;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return { ok: true, data };
    }
    return { ok: false, code, message: "\u54CD\u5E94\u7F3A\u5C11 data \u5B57\u6BB5" };
  }
  return { ok: true, data: raw };
}
async function signedSnapRequest(method, url, credential, body, fetcher) {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential;
  if (!ak || !sk) {
    return { ok: false, code: -1, message: "\u51ED\u636E\u7F3A\u5C11 AK/SK" };
  }
  try {
    const payload = body === void 0 ? new Uint8Array() : new TextEncoder().encode(body);
    const signed = await signRequestHuawei(ak, sk, st, method, url, payload);
    const headers = new Headers();
    signed.forEach((value, key) => {
      if (key !== "host") headers.set(key, value);
    });
    for (const [key, value] of Object.entries(SNAP_EXTRA_HEADERS)) headers.set(key, value);
    const response = await fetcher(url, {
      method,
      headers,
      ...body === void 0 ? {} : { body },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, code: response.status, message: describeHttpFailure(response.status, text) };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, code: -1, message: UNPARSABLE_RESPONSE_MESSAGE };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, code: -1, message: UNPARSABLE_RESPONSE_MESSAGE };
    }
    return unwrapSnapEnvelope(parsed);
  } catch (error) {
    return {
      ok: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
function parseCreditBalance(metrics) {
  if (!Array.isArray(metrics)) return void 0;
  const packages = [];
  let totalRemain;
  let sawAnyCreditMetric = false;
  for (const item of metrics) {
    if (typeof item !== "object" || item === null) continue;
    const record = item;
    const name = readString(record, "name");
    const label = CREDIT_METRIC_LABELS[name];
    if (label === void 0) continue;
    sawAnyCreditMetric = true;
    const amount = readNumber(record, "package_credit_amount");
    const used = readNumber(record, "package_credit_used");
    const remain = readNumber(record, "package_credit_remain");
    if (name === TOTAL_CREDIT_METRIC) totalRemain = remain;
    if (amount <= 0 && remain <= 0) continue;
    packages.push({
      name: label,
      unit: "credit",
      remaining: remain,
      total: amount,
      used,
      // `statistics/plugin` 不下发资源包的有效性/周期字段（那是腾讯侧的形态）。
      // 这里如实置为有效、周期留空，而不是臆造一个到期时间。
      active: true,
      cycleStartTime: "",
      cycleEndTime: "",
      expiredTime: ""
    });
  }
  if (!sawAnyCreditMetric) return void 0;
  const total = roundCredits(
    totalRemain ?? packages.reduce((sum, pkg) => sum + pkg.remaining, 0)
  );
  return { total, packages, expiredTotal: 0 };
}
async function fetchCodeArtsAccountInfo(credential, fetcher = fetch) {
  const result = await fetchCodeArtsAccountInfoDetailed(credential, fetcher);
  return result.ok ? result.info : null;
}
async function fetchCodeArtsAccountInfoDetailed(credential, fetcher = fetch) {
  const url = `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_PACKAGE_INFO_PATH}`;
  const result = await signedSnapRequest("GET", url, credential, void 0, fetcher);
  if (!result.ok) return { ok: false, message: result.message };
  const data = result.data;
  const pkg = readRecord(data, "package");
  const packageNameCn = readString(pkg, "package_name_cn");
  const packageNameEn = readString(pkg, "package_name_en");
  return {
    ok: true,
    info: {
      isCreditPackage: readBool(pkg, "is_credit_package"),
      isTokenPackage: readBool(pkg, "is_token_package"),
      specCode: readString(pkg, "spec_code"),
      packageName: packageNameCn.length > 0 ? packageNameCn : packageNameEn,
      packageStatus: readString(pkg, "status"),
      credit: parseCreditBalance(data.metrics)
    }
  };
}
function parseActivity(item) {
  return {
    // 用 readIdentifier 而非 readString：实测 campaignId 是**数字** 1。
    campaignId: readIdentifier(item, "campaignId"),
    type: readString(item, "type"),
    title: readString(item, "title"),
    claimable: readBool(item, "claimable"),
    status: readString(item, "status"),
    // 可领积分数：实测字段名是 `benefitAmount`（值 1000）。
    // 保留另两个候选名作兼容回退，取不到才为 0。
    amount: readNumber(item, "benefitAmount") || readNumber(item, "amount") || readNumber(item, "creditAmount")
  };
}
async function fetchCodeArtsOpsActivities(credential, fetcher = fetch) {
  const result = await fetchCodeArtsOpsActivitiesDetailed(credential, fetcher);
  return result.ok ? result.activities : null;
}
async function fetchCodeArtsOpsActivitiesDetailed(credential, fetcher = fetch) {
  const url = `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_DELIVERY_PATH}?channel=${CODEARTS_OPS_CHANNEL}`;
  const result = await signedSnapRequest("GET", url, credential, void 0, fetcher);
  if (!result.ok) return { ok: false, message: result.message };
  const items = result.data.items;
  if (!Array.isArray(items)) return { ok: false, message: "\u54CD\u5E94\u7F3A\u5C11 items \u5B57\u6BB5" };
  return {
    ok: true,
    activities: items.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item)).map(parseActivity)
  };
}
function findDailyCheckinActivity(activities) {
  return activities.find((activity) => activity.type === CODEARTS_DAILY_LOGIN_TYPE);
}
async function claimCodeArtsDailyCheckin(credential, fetcher = fetch) {
  const infoResult = await fetchCodeArtsAccountInfoDetailed(credential, fetcher);
  if (!infoResult.ok) {
    return { kind: "failed", code: -1, message: `\u8D26\u6237\u4FE1\u606F\u67E5\u8BE2\u5931\u8D25\uFF1A${infoResult.message}` };
  }
  const info = infoResult.info;
  if (!info.isCreditPackage) {
    return {
      kind: "inactive",
      message: info.isTokenPackage ? "Token \u8BA1\u8D39\u8D26\u6237\uFF0C\u4E0D\u5728\u79EF\u5206\u6D3B\u52A8\u8303\u56F4" : "\u975E\u79EF\u5206\u8BA1\u8D39\u8D26\u6237\uFF0C\u4E0D\u5728\u79EF\u5206\u6D3B\u52A8\u8303\u56F4"
    };
  }
  const activitiesResult = await fetchCodeArtsOpsActivitiesDetailed(credential, fetcher);
  if (!activitiesResult.ok) {
    return { kind: "failed", code: -1, message: `\u6D3B\u52A8\u5217\u8868\u67E5\u8BE2\u5931\u8D25\uFF1A${activitiesResult.message}` };
  }
  const activity = findDailyCheckinActivity(activitiesResult.activities);
  if (activity === void 0) {
    return { kind: "inactive", message: "\u672A\u627E\u5230\u6BCF\u65E5\u7B7E\u5230\u6D3B\u52A8" };
  }
  if (!activity.claimable) {
    return CLAIMED_STATUSES.includes(activity.status) ? { kind: "already-claimed", message: "\u4ECA\u5929\u5DF2\u9886\u53D6" } : { kind: "inactive", message: `\u5F53\u524D\u4E0D\u53EF\u9886\u53D6\uFF08status=${activity.status}\uFF09` };
  }
  if (activity.campaignId.length === 0) {
    return { kind: "failed", code: -1, message: "\u6D3B\u52A8\u7F3A\u5C11 campaignId\uFF0C\u65E0\u6CD5\u9886\u53D6" };
  }
  const claimResult = await signedSnapRequest(
    "POST",
    `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_CLAIM_PATH}`,
    credential,
    JSON.stringify({ campaignId: activity.campaignId, channel: CODEARTS_OPS_CHANNEL }),
    fetcher
  );
  if (!claimResult.ok) {
    return { kind: "failed", code: claimResult.code, message: claimResult.message };
  }
  const benefitId = claimResult.data.id;
  if (benefitId !== null && benefitId !== void 0) {
    await signedSnapRequest(
      "POST",
      `${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_OPS_CONFIRM_PATH}`,
      credential,
      JSON.stringify({ campaignId: activity.campaignId }),
      fetcher
    );
  }
  const claimCredit = readNumber(claimResult.data, "benefitAmount") || readNumber(claimResult.data, "credit") || readNumber(claimResult.data, "credits") || readNumber(claimResult.data, "creditAmount") || readNumber(claimResult.data, "amount");
  return {
    kind: "claimed",
    credit: claimCredit > 0 ? claimCredit : activity.amount,
    // CodeArts 的活动不下发连续签到天数概念（那是 CodeBuddy 的机制）。
    streakDays: 0,
    isStreakDay: false
  };
}
function roundCredits(value) {
  return Math.round(value * 100) / 100;
}
export {
  CODEARTS_DAILY_LOGIN_TYPE,
  CODEARTS_OPS_CHANNEL,
  CODEARTS_OPS_CLAIM_PATH,
  CODEARTS_OPS_CONFIRM_PATH,
  CODEARTS_OPS_DELIVERY_PATH,
  CODEARTS_PACKAGE_INFO_PATH,
  CODEARTS_SNAP_ENGINE_URL,
  claimCodeArtsDailyCheckin,
  fetchCodeArtsAccountInfo,
  fetchCodeArtsAccountInfoDetailed,
  fetchCodeArtsOpsActivities,
  fetchCodeArtsOpsActivitiesDetailed,
  findDailyCheckinActivity
};
