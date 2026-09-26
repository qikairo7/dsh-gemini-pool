import { createHash } from "node:crypto";
import { jwtExpiresAtMs } from "./buddy.js";
const LOBSTERAI_EXCHANGE_PATH = "/api/auth/exchange";
const LOBSTERAI_REFRESH_PATH = "/api/auth/refresh";
const LOBSTERAI_MODELS_PATH = "/api/models/available";
const LOBSTERAI_CHAT_PATH = "/api/proxy/v1/chat/completions";
const LOBSTERAI_CALLBACK_PATH = "/auth/callback";
const LOBSTERAI_REQUEST_TIMEOUT_MS = 3e4;
const LOBSTERAI_LOGIN_TIMEOUT_MS = 10 * 60 * 1e3;
const LOBSTERAI_VERSION_CACHE_TTL_MS = 12 * 60 * 60 * 1e3;
function readStringField(source, key) {
  const value = source[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
function readNumberField(source, key) {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return void 0;
}
function parseLobsteraiEnvelope(body) {
  if (typeof body !== "object" || body === null) {
    return { ok: false, code: -1, message: "\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61" };
  }
  const record = body;
  const code = readNumberField(record, "code") ?? -1;
  const message = readStringField(record, "msg") || readStringField(record, "message");
  if (code !== 0) {
    return { ok: false, code, message: message.length > 0 ? message : `code=${code}` };
  }
  const data = record.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      ok: false,
      code,
      message: message.length > 0 ? message : "data \u4E3A\u7A7A\uFF08accessToken \u53EF\u80FD\u5DF2\u5931\u6548\uFF09"
    };
  }
  return { ok: true, data };
}
function lobsteraiCredentialExpiresAtMs(credential) {
  const raw = credential.expires_at;
  if (typeof raw === "string" && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      return value > 1e12 ? value : value * 1e3;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return jwtExpiresAtMs(credential.access_token);
}
function isLobsteraiExpired(credential) {
  const expiresAt = lobsteraiCredentialExpiresAtMs(credential);
  return expiresAt === void 0 ? false : Date.now() >= expiresAt;
}
function isLobsteraiRefreshable(credential) {
  return typeof credential.refresh_token === "string" && credential.refresh_token.length > 0;
}
function lobsteraiKeyfromBody(credential, clientVersion) {
  const body = {
    firstKeyfrom: credential.first_keyfrom ?? "",
    // 直接用凭据里**存储的**值，不取当前时刻 —— 严格对齐 Go 的
    // `KeyfromBody()`（`auth.go:37-50`）：它读的就是 `a.LatestKeyfrom`，
    // 而 `RefreshToken`（`client.go:137-145`）从不更新该字段。
    // 因此 Go 每次续期发的都是「登录时的那一刻」，本插件照做。
    latestKeyfrom: credential.latest_keyfrom ?? "",
    version: clientVersion
  };
  if (credential.uuid !== void 0 && credential.uuid.length > 0) body.uuid = credential.uuid;
  if (credential.user_id !== void 0 && credential.user_id.length > 0) body.userId = credential.user_id;
  return body;
}
function lobsteraiRefreshBody(credential, clientVersion) {
  return {
    ...lobsteraiKeyfromBody(credential, clientVersion),
    refreshToken: credential.refresh_token
  };
}
function parseLobsteraiTokenPayload(data) {
  const user = typeof data.user === "object" && data.user !== null ? data.user : {};
  const expiresIn = readNumberField(data, "expiresIn");
  return {
    accessToken: readStringField(data, "accessToken"),
    refreshToken: readStringField(data, "refreshToken"),
    ...expiresIn === void 0 ? {} : { expiresIn },
    userId: readStringField(user, "id"),
    yid: readStringField(user, "yid"),
    accountUserId: readStringField(user, "userId"),
    nickname: readStringField(user, "nickname")
  };
}
function resolveLobsteraiUid(payload) {
  for (const candidate of [payload.userId, payload.accountUserId, payload.yid]) {
    if (candidate !== void 0 && candidate.length > 0) return candidate;
  }
  return createHash("sha256").update(payload.accessToken).digest("hex").slice(0, 16);
}
function buildLobsteraiCredential(payload, session) {
  const expiresAt = payload.expiresIn !== void 0 && payload.expiresIn > 0 ? String(Date.now() + payload.expiresIn * 1e3) : (() => {
    const exp = jwtExpiresAtMs(payload.accessToken);
    return exp === void 0 ? "" : String(exp);
  })();
  const uid = resolveLobsteraiUid(payload);
  return {
    access_token: payload.accessToken,
    refresh_token: payload.refreshToken,
    expires_at: expiresAt,
    uid,
    user_id: payload.accountUserId !== void 0 && payload.accountUserId.length > 0 ? payload.accountUserId : payload.yid ?? "",
    nickname: payload.nickname ?? "",
    uuid: session.uuid,
    first_keyfrom: session.firstKeyfrom,
    latest_keyfrom: session.latestKeyfrom
  };
}
function applyLobsteraiRefresh(previous, payload, nowMs = Date.now()) {
  const expiresAt = payload.expiresIn !== void 0 && payload.expiresIn > 0 ? String(nowMs + payload.expiresIn * 1e3) : (() => {
    const exp = jwtExpiresAtMs(payload.accessToken);
    return exp === void 0 ? previous.expires_at ?? "" : String(exp);
  })();
  return {
    ...previous,
    access_token: payload.accessToken,
    // refresh 响应可能不返回新 refreshToken（沿用旧的），不能覆盖成空串。
    refresh_token: payload.refreshToken.length > 0 ? payload.refreshToken : previous.refresh_token,
    expires_at: expiresAt
  };
}
function lobsteraiAuthHeaders(credential, product, accept = "application/json") {
  return {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: accept,
    "Content-Type": "application/json",
    "User-Agent": product.userAgent
  };
}
function lobsteraiChatHeaders(credential, product, clientVersion) {
  return {
    ...lobsteraiAuthHeaders(credential, product, "text/event-stream, application/json"),
    "X-LobsterAI-Client-Capabilities": product.clientCapabilities,
    "X-LobsterAI-Client-Version": clientVersion
  };
}
function lobsteraiModelsHeaders(credential, product, clientVersion) {
  return {
    ...lobsteraiAuthHeaders(credential, product, "application/json"),
    "X-LobsterAI-Client-Capabilities": product.clientCapabilities,
    "X-LobsterAI-Client-Version": clientVersion
  };
}
function lobsteraiAnonymousHeaders(product) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": product.userAgent
  };
}
function parseClientVersion(raw) {
  if (typeof raw !== "string") return void 0;
  const trimmed = raw.trim();
  if (!/^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) return void 0;
  return trimmed;
}
function parseClientVersionFromUpdate(body) {
  if (typeof body !== "object" || body === null) return void 0;
  const outer = body.data;
  if (typeof outer !== "object" || outer === null) return void 0;
  const value = outer.value;
  if (typeof value !== "object" || value === null) return void 0;
  return parseClientVersion(value.version);
}
class LobsteraiClientVersionResolver {
  constructor(options = {}) {
    this.options = options;
  }
  options;
  cached;
  cachedAt = 0;
  /**
   * 解析当前客户端版本号。
   *
   * 顺序：进程内缓存（未过期）→ 请求上游更新接口 → 兜底常量。
   *
   * **失败不回退到抛错**（与 `sigin.py:73-76` 的「整个脚本放弃签到」不同）：
   * 返回 `fallbackClientVersion` 并在返回值里标出 `source`，
   * 让调用方能决定是否记日志。理由见 `LOBSTERAI_FALLBACK_CLIENT_VERSION` 说明。
   */
  async resolve(product) {
    const now = this.options.now?.() ?? Date.now();
    const ttl = this.options.ttlMs ?? LOBSTERAI_VERSION_CACHE_TTL_MS;
    if (this.cached !== void 0 && now - this.cachedAt < ttl) {
      return { version: this.cached, source: "cache" };
    }
    const fetched = this.options.fetcher ?? fetch;
    try {
      const response = await fetched(product.clientVersionApi, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": product.userAgent },
        signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS)
      });
      if (response.ok) {
        const version = parseClientVersionFromUpdate(await response.json());
        if (version !== void 0) {
          this.cached = version;
          this.cachedAt = now;
          return { version, source: "remote" };
        }
      }
    } catch {
    }
    return { version: product.fallbackClientVersion, source: "fallback" };
  }
  /** 清空缓存（测试与「强制刷新版本号」场景用）。 */
  clear() {
    this.cached = void 0;
    this.cachedAt = 0;
  }
}
export {
  LOBSTERAI_CALLBACK_PATH,
  LOBSTERAI_CHAT_PATH,
  LOBSTERAI_EXCHANGE_PATH,
  LOBSTERAI_LOGIN_TIMEOUT_MS,
  LOBSTERAI_MODELS_PATH,
  LOBSTERAI_REFRESH_PATH,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  LOBSTERAI_VERSION_CACHE_TTL_MS,
  LobsteraiClientVersionResolver,
  applyLobsteraiRefresh,
  buildLobsteraiCredential,
  isLobsteraiExpired,
  isLobsteraiRefreshable,
  lobsteraiAnonymousHeaders,
  lobsteraiAuthHeaders,
  lobsteraiChatHeaders,
  lobsteraiCredentialExpiresAtMs,
  lobsteraiKeyfromBody,
  lobsteraiModelsHeaders,
  lobsteraiRefreshBody,
  parseClientVersion,
  parseClientVersionFromUpdate,
  parseLobsteraiEnvelope,
  parseLobsteraiTokenPayload,
  readNumberField,
  readStringField,
  resolveLobsteraiUid
};
