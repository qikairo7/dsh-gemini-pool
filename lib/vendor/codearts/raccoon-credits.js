import {
  RACCOON_POINTS_PREFIX,
  RACCOON_DESKTOP_PREFIX,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonHeaders
} from "./raccoon.js";
import { RACCOON } from "./raccoon-product.js";
const RACCOON_LOGIN_REWARD_POINTS = 3e3;
const RACCOON_LOGIN_REWARD_EVENT_NAME = "\u684C\u9762\u7AEF\u767B\u5F55\u5956\u52B1";
function parseEnvelope(payload, status) {
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
  const code = typeof record.code === "number" ? record.code : status >= 400 ? status : 0;
  const message = typeof record.message === "string" && record.message.length > 0 ? record.message : typeof record.details === "string" ? record.details : "";
  const data = typeof record.data === "object" && record.data !== null && !Array.isArray(record.data) ? record.data : void 0;
  return { ok: code === 0, code, message, data };
}
function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
async function requestJson(url, credential, product, init, fetcher) {
  try {
    const response = await fetcher(url, {
      method: init.method,
      headers: raccoonHeaders(credential, {
        platform: product.clientPlatform,
        version: product.clientVersion
      }),
      ...init.body === void 0 ? {} : { body: init.body },
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS)
    });
    const parsed = await response.json();
    return parseEnvelope(parsed, response.status);
  } catch (error) {
    return {
      ok: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error),
      data: void 0
    };
  }
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
async function fetchRaccoonCreditBalance(product, credential, fetcher = fetch) {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/balance`,
    credential,
    product,
    { method: "GET" },
    fetcher
  );
  if (!envelope.ok || envelope.data === void 0) return null;
  const available = readNumber(envelope.data.available_points);
  if (available === void 0) return null;
  const packages = [];
  const reward = readNumber(envelope.data.reward_points);
  const daily = readNumber(envelope.data.daily_points);
  const topup = readNumber(envelope.data.topup_points);
  const monthly = readNumber(envelope.data.monthly_points);
  if (reward !== void 0) packages.push(makePackage("\u5956\u52B1\u79EF\u5206", reward));
  if (daily !== void 0) packages.push(makePackage("\u6BCF\u65E5\u79EF\u5206", daily));
  if (monthly !== void 0 && monthly > 0) packages.push(makePackage("\u4F1A\u5458\u79EF\u5206", monthly));
  if (topup !== void 0) packages.push(makePackage("\u5145\u503C\u79EF\u5206", topup));
  return {
    total: available,
    // 极端情形（服务端只给 total 不给分项）也要有至少一个包，否则 UI 空列表
    packages: packages.length > 0 ? packages : [makePackage("\u53EF\u7528\u79EF\u5206", available)],
    expiredTotal: 0
  };
}
async function claimRaccoonLoginReward(product, credential, fetcher = fetch) {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_DESKTOP_PREFIX}/login/points/grant`,
    credential,
    product,
    { method: "POST" },
    fetcher
  );
  if (!envelope.ok) {
    return {
      kind: "failed",
      code: envelope.code,
      message: envelope.message.length > 0 ? envelope.message : "\u9886\u53D6\u767B\u5F55\u5956\u52B1\u5931\u8D25"
    };
  }
  if (envelope.data?.granted !== true) {
    return {
      kind: "already-claimed",
      message: "\u8BE5\u8D26\u53F7\u5DF2\u9886\u53D6\u8FC7\u684C\u9762\u7AEF\u767B\u5F55\u5956\u52B1\uFF08\u6BCF\u53F7\u4E00\u6B21\uFF09"
    };
  }
  const popup = typeof envelope.data.popup === "object" && envelope.data.popup !== null ? envelope.data.popup : void 0;
  const points = readNumber(popup?.points) ?? RACCOON_LOGIN_REWARD_POINTS;
  return { kind: "claimed", credit: points, streakDays: 0, isStreakDay: false };
}
async function fetchRaccoonOnboardingStatus(product, credential, fetcher = fetch) {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/bills?paging.limit=50&paging.offset=0`,
    credential,
    product,
    { method: "GET" },
    fetcher
  );
  if (!envelope.ok || envelope.data === void 0) {
    return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS };
  }
  const items = Array.isArray(envelope.data.items) ? envelope.data.items : [];
  let claimed = false;
  let points = RACCOON_LOGIN_REWARD_POINTS;
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const item = raw;
    if (item.biz_type !== "reward_grant") continue;
    if (item.event_name !== RACCOON_LOGIN_REWARD_EVENT_NAME) continue;
    claimed = true;
    const billPoints = readNumber(item.points);
    if (billPoints !== void 0 && billPoints > 0) points = billPoints;
    break;
  }
  return { claimed, points };
}
const raccoonCreditsForDefaultProduct = {
  fetchBalance: (credential, fetcher) => fetchRaccoonCreditBalance(RACCOON, credential, fetcher),
  claimLoginReward: (credential, fetcher) => claimRaccoonLoginReward(RACCOON, credential, fetcher),
  fetchOnboardingStatus: (credential, fetcher) => fetchRaccoonOnboardingStatus(RACCOON, credential, fetcher)
};
export {
  RACCOON_LOGIN_REWARD_EVENT_NAME,
  RACCOON_LOGIN_REWARD_POINTS,
  claimRaccoonLoginReward,
  fetchRaccoonCreditBalance,
  fetchRaccoonOnboardingStatus,
  raccoonCreditsForDefaultProduct
};
