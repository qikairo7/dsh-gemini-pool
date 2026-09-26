import { randomUUID } from "node:crypto";
import { LOBSTERAI_REQUEST_TIMEOUT_MS, parseLobsteraiEnvelope } from "./lobsterai.js";
import { lobsteraiAuthHeaders } from "./lobsterai.js";
const LOBSTERAI_ACTIVITY_SLOT_PATH = "/api/client-activities/slot";
const LOBSTERAI_ACTIVITY_CONTEXT_PATH = "/api/client-activities";
const LOBSTERAI_PROFILE_SUMMARY_PATH = "/api/user/profile-summary";
const LOBSTERAI_SLOT_PLACEMENT = "desktop_sidebar";
const LOBSTERAI_SLOT_CONTAINER_API_VERSION = "2";
const LOBSTERAI_SLOT_PLATFORM = "win32";
const UNPARSABLE_RESPONSE_MESSAGE = "\u8BF7\u6C42\u5931\u8D25\u6216\u54CD\u5E94\u65E0\u6CD5\u89E3\u6790";
async function requestJson(url, credential, product, fetcher, init = { method: "GET" }) {
  try {
    const response = await fetcher(url, {
      method: init.method,
      headers: lobsteraiAuthHeaders(credential, product),
      ...init.body === void 0 ? {} : { body: init.body },
      signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS)
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, message: describeNonJsonResponse(response.status, text) };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, message: UNPARSABLE_RESPONSE_MESSAGE };
    }
    return { ok: true, body: parsed };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
function describeNonJsonResponse(status, text) {
  if (status === 401 || status === 403) {
    return `\u51ED\u636E\u5DF2\u5931\u6548\uFF08HTTP ${status}\uFF09\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u8BE5\u8D26\u53F7`;
  }
  const snippet = text.trim().slice(0, 80).replace(/\s+/g, " ");
  return `\u670D\u52A1\u7AEF\u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94\uFF08HTTP ${status}\uFF09\uFF1A${snippet}`;
}
function readBool(source, key) {
  return source[key] === true;
}
function readNumber(source, key) {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return 0;
}
function readActions(source, key) {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}
async function fetchLobsteraiActivitySlot(credential, product, clientVersion, fetcher = fetch) {
  const query = new URLSearchParams({
    placement: LOBSTERAI_SLOT_PLACEMENT,
    clientVersion,
    containerApiVersion: LOBSTERAI_SLOT_CONTAINER_API_VERSION,
    platform: LOBSTERAI_SLOT_PLATFORM
  });
  const result = await requestJson(
    `${product.apiBase}${LOBSTERAI_ACTIVITY_SLOT_PATH}?${query.toString()}`,
    credential,
    product,
    fetcher
  );
  if (!result.ok) return null;
  const envelope = parseLobsteraiEnvelope(result.body);
  if (!envelope.ok) return null;
  const activity = typeof envelope.data.activity === "object" && envelope.data.activity !== null ? envelope.data.activity : {};
  const activityCode = typeof activity.activityCode === "string" ? activity.activityCode : "";
  return {
    slotState: typeof envelope.data.slotState === "string" ? envelope.data.slotState : "",
    activityCode,
    configRevision: readNumber(activity, "configRevision")
  };
}
async function fetchLobsteraiActivityContext(credential, product, slot, fetcher = fetch) {
  const query = new URLSearchParams({ configRevision: String(slot.configRevision) });
  const url = `${product.apiBase}${LOBSTERAI_ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(slot.activityCode)}/context?${query.toString()}`;
  const result = await requestJson(url, credential, product, fetcher);
  if (!result.ok) return null;
  const envelope = parseLobsteraiEnvelope(result.body);
  if (!envelope.ok) return null;
  const state = typeof envelope.data.state === "object" && envelope.data.state !== null ? envelope.data.state : {};
  return {
    claimedToday: readBool(state, "claimedToday"),
    actions: readActions(envelope.data, "actions")
  };
}
async function claimLobsteraiDailyCheckin(credential, product, clientVersion, fetcher = fetch) {
  const slot = await fetchLobsteraiActivitySlot(credential, product, clientVersion, fetcher);
  if (slot === null) {
    return { kind: "failed", code: -1, message: "\u6D3B\u52A8\u69FD\u4F4D\u67E5\u8BE2\u5931\u8D25" };
  }
  if (slot.slotState !== "available" || slot.activityCode.length === 0) {
    return { kind: "inactive", message: `\u65E0\u53EF\u7528\u6D3B\u52A8\uFF08slotState=${slot.slotState}\uFF09` };
  }
  const context = await fetchLobsteraiActivityContext(credential, product, slot, fetcher);
  if (context === null) {
    return { kind: "failed", code: -1, message: "\u6D3B\u52A8\u4E0A\u4E0B\u6587\u67E5\u8BE2\u5931\u8D25" };
  }
  if (context.claimedToday) {
    return { kind: "already-claimed", message: "\u4ECA\u5929\u5DF2\u7B7E\u5230" };
  }
  if (!context.actions.includes("check_in")) {
    return { kind: "inactive", message: "\u5F53\u524D\u4E0D\u53EF\u7B7E\u5230" };
  }
  const url = `${product.apiBase}${LOBSTERAI_ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(slot.activityCode)}/actions/check_in`;
  const result = await requestJson(url, credential, product, fetcher, {
    method: "POST",
    body: JSON.stringify({
      configRevision: slot.configRevision,
      // 客户端幂等键（对齐 sigin.py:63 的 uuid4）：服务端据此去重。
      idempotencyKey: randomUUID(),
      payload: {}
    })
  });
  if (!result.ok) {
    return { kind: "failed", code: -1, message: result.message };
  }
  const envelope = parseLobsteraiEnvelope(result.body);
  if (!envelope.ok) {
    return { kind: "failed", code: envelope.code, message: envelope.message };
  }
  const bodyResult = typeof envelope.data.result === "object" && envelope.data.result !== null ? envelope.data.result : {};
  const credit = ["creditsGranted", "rewardCredits", "credits"].map((key) => bodyResult[key]).find((value) => typeof value === "number" && Number.isFinite(value)) ?? 0;
  const message = typeof bodyResult.message === "string" ? bodyResult.message : "";
  return {
    kind: "claimed",
    credit,
    // LobsterAI 的签到响应不含连续天数概念（那是 CodeBuddy 的活动机制）。
    streakDays: 0,
    isStreakDay: false,
    ...message.length > 0 ? { delayedMessage: message } : {}
  };
}
async function fetchLobsteraiCreditBalance(credential, product, fetcher = fetch) {
  const result = await requestJson(
    `${product.apiBase}${LOBSTERAI_PROFILE_SUMMARY_PATH}`,
    credential,
    product,
    fetcher
  );
  if (!result.ok) return null;
  const envelope = parseLobsteraiEnvelope(result.body);
  if (!envelope.ok) return null;
  const packages = [];
  const items = envelope.data.creditItems;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const record = item;
      const remaining = readNumber(record, "creditsRemaining");
      const type = typeof record.type === "string" ? record.type : "";
      const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : "";
      packages.push({
        name: type.length > 0 ? type : "\u79EF\u5206\u5305",
        unit: "credit",
        remaining,
        // LobsterAI 只下发剩余量，不区分「周期总额/已用」。
        // 用 remaining 充当 total 会让「剩余/总额」显示成 1:1；
        // 这里如实置 0，UI 的 `formatPackageLine` 对 0 会显示 '?'（不误导）。
        total: 0,
        used: 0,
        // 无 Status 字段可依据：有 expiresAt 且已过期才算失效。
        active: !(expiresAt.length > 0 && Number.isFinite(Date.parse(expiresAt.replace(" ", "T"))) && Date.now() >= Date.parse(expiresAt.replace(" ", "T"))),
        cycleStartTime: "",
        cycleEndTime: "",
        expiredTime: expiresAt
      });
    }
  }
  const total = roundCredits(Math.max(0, readNumber(envelope.data, "totalCreditsRemaining")));
  if (total === 0 && packages.length === 0) return null;
  const expiredTotal = roundCredits(
    packages.reduce((sum, pkg) => sum + (pkg.active ? 0 : Math.max(0, pkg.remaining)), 0)
  );
  return { total, packages, expiredTotal };
}
function roundCredits(value) {
  return Math.round(value * 100) / 100;
}
export {
  LOBSTERAI_ACTIVITY_CONTEXT_PATH,
  LOBSTERAI_ACTIVITY_SLOT_PATH,
  LOBSTERAI_PROFILE_SUMMARY_PATH,
  LOBSTERAI_SLOT_CONTAINER_API_VERSION,
  LOBSTERAI_SLOT_PLACEMENT,
  LOBSTERAI_SLOT_PLATFORM,
  claimLobsteraiDailyCheckin,
  fetchLobsteraiActivityContext,
  fetchLobsteraiActivitySlot,
  fetchLobsteraiCreditBalance
};
