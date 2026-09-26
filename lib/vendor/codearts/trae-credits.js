import {
  TRAE_CHECKIN_CLAIM_PATH,
  TRAE_CHECKIN_STATUS_PATH,
  TRAE_ENT_USAGE_PATH,
  TRAE_REQUEST_TIMEOUT_MS,
  traeCheckinHeaders
} from "./trae.js";
function classifyTraeCheckinError(httpStatus, code) {
  if (httpStatus === 200 && code === 1005) {
    return { type: "PlanLimit", cooldownSecs: 43200 };
  }
  if (httpStatus === 429) {
    return { type: "SoftRate", cooldownSecs: 60 };
  }
  if (httpStatus === 401) {
    return { type: "SessionDead", cooldownSecs: -1 };
  }
  if (httpStatus === 404) {
    return { type: "NotFound", cooldownSecs: 60 };
  }
  if (httpStatus >= 500 && httpStatus < 600) {
    return { type: "Server", cooldownSecs: 600 };
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return { type: "Client", cooldownSecs: 600 };
  }
  if (code !== void 0 && code !== 0) {
    return { type: "BusinessError", cooldownSecs: 300 };
  }
  return { type: "Unknown", cooldownSecs: 0 };
}
const TRAE_CHECKIN_BUSY_CODE = 9074;
function readNumber(source, key) {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function readString(source, key) {
  const value = source[key];
  return typeof value === "string" ? value : "";
}
function readClaimCode(body) {
  const raw = body.code;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return raw === void 0 ? 0 : -1;
}
async function postJson(path, credential, body, fetcher, userId) {
  const uid = userId ?? credential.uid;
  if (uid.length === 0) {
    return { ok: false, message: "\u7F3A\u5C11 user_id\uFF0C\u65E0\u6CD5\u6784\u9020\u8BBE\u5907\u8EAB\u4EFD", httpStatus: 0 };
  }
  try {
    const response = await fetcher(`https://api.trae.cn${path}`, {
      method: "POST",
      headers: traeCheckinHeaders(credential, {}, uid),
      body,
      signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS)
    });
    const httpStatus = response.status;
    const text = await response.text();
    if (!response.ok) {
      const snippet = text.trim().slice(0, 80).replace(/\s+/g, " ");
      return { ok: false, message: `HTTP ${response.status}: ${snippet}`, httpStatus };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, message: `\u975E JSON \u54CD\u5E94: ${text.trim().slice(0, 80)}`, httpStatus };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, message: "\u54CD\u5E94\u4E0D\u662F\u5BF9\u8C61", httpStatus };
    }
    return { ok: true, body: parsed, httpStatus };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), httpStatus: 0 };
  }
}
async function fetchTraeCheckinStatus(credential, _product, fetcher = fetch) {
  const result = await postJson(TRAE_CHECKIN_STATUS_PATH, credential, "{}", fetcher, credential.uid);
  if (!result.ok) return null;
  const body = result.body;
  const code = readClaimCode(body);
  if (code !== 0) return null;
  return {
    active: body.enable === true,
    todayCheckedIn: body.checked_in === true,
    streakDays: readNumber(body, "streak_days") || 0,
    dailyCredit: readNumber(body, "credits") || 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: readNumber(body, "total_credits") || 0,
    checkinDates: [],
    activityName: "",
    themeName: "",
    endTime: ""
  };
}
async function claimTraeDailyCheckin(credential, product, fetcher = fetch, generation = 0, onRotate, userId, retryCount = 3) {
  const uid = userId ?? credential.uid;
  const doClaim = async () => {
    let lastError = { ok: false, httpStatus: 0, message: "", code: 0 };
    for (let attempt = 0; attempt <= Math.max(0, retryCount); attempt++) {
      const result = await postJson(TRAE_CHECKIN_CLAIM_PATH, credential, "{}", fetcher, uid);
      if (result.ok) {
        const c = readClaimCode(result.body);
        return { ok: true, body: result.body, httpStatus: result.httpStatus, message: "", code: c };
      }
      lastError = { ok: false, httpStatus: result.httpStatus, message: result.message, code: 0 };
      if (result.httpStatus > 0) {
        return lastError;
      }
      if (attempt < retryCount) {
        await new Promise((r) => setTimeout(r, 1e3));
      }
    }
    return lastError;
  };
  const response = await doClaim();
  if (!response.ok) {
    return { kind: "failed", code: -1, message: response.message, errorType: "Unknown", cooldownSecs: 0 };
  }
  const body = response.body;
  const code = readClaimCode(body);
  if (code === 9074) {
    return {
      kind: "failed",
      code: 9074,
      message: readString(body, "message") || readString(body, "msg") || "\u7B7E\u5230\u4EBA\u6570\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
      errorType: "BusinessError",
      cooldownSecs: 300
    };
  }
  const msg = readString(body, "message") || readString(body, "msg") || "";
  if (code === 0) {
    const status = await fetchTraeCheckinStatus(credential, product, fetcher);
    return {
      kind: "claimed",
      credit: status?.dailyCredit ?? 0,
      streakDays: status?.streakDays ?? 0,
      isStreakDay: false
    };
  }
  const { type, cooldownSecs } = classifyTraeCheckinError(response.httpStatus, code);
  return {
    kind: "failed",
    code,
    message: msg.length > 0 ? msg : `\u7B7E\u5230\u5931\u8D25\uFF08code=${code}\uFF09`,
    errorType: type,
    cooldownSecs
  };
}
async function fetchTraeCreditBalance(credential, _product, fetcher = fetch) {
  const result = await postJson(
    TRAE_ENT_USAGE_PATH,
    credential,
    JSON.stringify({ require_usage: true, req_source: 2 }),
    fetcher,
    credential.uid
  );
  if (!result.ok) return null;
  const body = result.body;
  const packList = body.user_entitlement_pack_list;
  if (!Array.isArray(packList) || packList.length === 0) return null;
  const packages = [];
  let total = 0;
  let expiredTotal = 0;
  for (const item of packList) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item;
    const base = entry.entitlement_base_info;
    if (typeof base !== "object" || base === null) continue;
    const quota = base.quota;
    if (typeof quota !== "object" || quota === null) continue;
    const creditsLimit = readNumber(quota, "credits_limit");
    if (creditsLimit <= 0) continue;
    const usage = entry.usage;
    const used = typeof usage === "object" && usage !== null ? readNumber(usage, "credits_amount") : 0;
    const pkg = {
      name: readString(base, "name") || "\u8D44\u6E90\u5305",
      unit: "credits",
      remaining: creditsLimit - used,
      total: creditsLimit,
      used,
      active: true,
      cycleStartTime: "",
      cycleEndTime: "",
      expiredTime: ""
    };
    packages.push(pkg);
    total += pkg.remaining;
  }
  return { total, packages, expiredTotal };
}
function makeTraeCheckinStatusHandler(_product) {
  return async (credential) => fetchTraeCheckinStatus(credential, {});
}
function makeTraeClaimHandler(_product) {
  return async (credential) => claimTraeDailyCheckin(credential, {});
}
function makeTraeBalanceHandler(_product) {
  return async (credential) => fetchTraeCreditBalance(credential, {});
}
export {
  TRAE_CHECKIN_BUSY_CODE,
  claimTraeDailyCheckin,
  classifyTraeCheckinError,
  fetchTraeCheckinStatus,
  fetchTraeCreditBalance,
  makeTraeBalanceHandler,
  makeTraeCheckinStatusHandler,
  makeTraeClaimHandler
};
