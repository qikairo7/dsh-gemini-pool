import { createHash, randomUUID, randomBytes } from "node:crypto";
const QODER_REQUEST_TIMEOUT_MS = 3e4;
const QODER_LOGIN_TIMEOUT_MS = 3e5;
const QODER_POLL_INTERVAL_MS = 1e3;
const QODER_POLL_MAX_FAILURES = 5;
const QODER_DEVICE_SELECT_PATH = "/device/selectAccounts";
const QODER_POLL_PATH = "/api/v1/deviceToken/poll";
const QODER_REFRESH_PATH = "/api/v1/deviceToken/refresh";
const QODER_USERINFO_PATH = "/api/v1/userinfo";
const QODER_CHAT_PATH = "/model/v1/chat/completions";
const PKCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
function createQoderPkce() {
  const length = 43 + Math.floor(86 * Math.random());
  const bytes = randomBytes(length);
  let verifier = "";
  for (let i = 0; i < length; i++) {
    verifier += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length];
  }
  const challenge = createHash("sha256").update(verifier).digest().toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}
function createQoderDeviceSession(machineId) {
  return {
    pkce: createQoderPkce(),
    nonce: randomUUID(),
    machineId: machineId ?? randomUUID()
  };
}
function buildQoderAuthUrl(session, product) {
  const query = new URLSearchParams({
    challenge: session.pkce.challenge,
    challenge_method: "S256",
    nonce: session.nonce,
    machine_id: session.machineId,
    client_id: product.clientId
  });
  return `${product.authBase}${QODER_DEVICE_SELECT_PATH}?${query.toString()}`;
}
function buildQoderPollUrl(session, product) {
  const query = new URLSearchParams({
    nonce: session.nonce,
    verifier: session.pkce.verifier,
    challenge_method: "S256"
  });
  return `${product.openApiBase}${QODER_POLL_PATH}?${query.toString()}`;
}
function readString(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return void 0;
}
function readTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1e3) : Math.round(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function parseQoderTokenPayload(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { accessToken: "" };
  }
  const source = value;
  const accessToken = readString(source, ["token", "device_token", "access_token"]) ?? "";
  const refreshToken = readString(source, ["refresh_token", "refreshToken"]);
  const expiresAt = readTimestamp(source.expires_at ?? source.expiresAt);
  const refreshTokenExpiresAt = readTimestamp(
    source.refresh_token_expires_at ?? source.refreshTokenExpiresAt
  );
  const uid = readString(source, ["user_id", "userId"]);
  const userName = readString(source, ["user_name", "userName"]);
  return {
    accessToken,
    ...refreshToken === void 0 ? {} : { refreshToken },
    ...expiresAt === void 0 ? {} : { expiresAt },
    ...refreshTokenExpiresAt === void 0 ? {} : { refreshTokenExpiresAt },
    ...uid === void 0 ? {} : { uid },
    ...userName === void 0 ? {} : { userName }
  };
}
function buildQoderCredential(payload, extra) {
  const nickname = extra.nickname !== void 0 && extra.nickname.length > 0 ? extra.nickname : payload.userName;
  return {
    security_oauth_token: payload.accessToken,
    access_token: payload.accessToken,
    ...payload.refreshToken === void 0 ? {} : { refresh_token: payload.refreshToken },
    ...payload.expiresAt === void 0 ? {} : { expire_time: payload.expiresAt },
    ...payload.refreshTokenExpiresAt === void 0 ? {} : { refresh_token_expire_time: payload.refreshTokenExpiresAt },
    machine_id: extra.machineId,
    ...payload.uid === void 0 ? {} : { uid: payload.uid },
    ...nickname === void 0 || nickname.length === 0 ? {} : { nickname }
  };
}
function qoderCredentialExpiresAtMs(credential) {
  return credential.expire_time;
}
function isQoderRefreshable(credential) {
  return typeof credential.refresh_token === "string" && credential.refresh_token.length > 0;
}
function isQoderExpired(credential, nowMs = Date.now()) {
  const expiresAt = qoderCredentialExpiresAtMs(credential);
  return expiresAt !== void 0 && expiresAt <= nowMs;
}
function qoderRefreshBody(credential) {
  return {
    refresh_token: credential.refresh_token ?? "",
    machine_id: credential.machine_id
  };
}
function qoderBearerToken(credential) {
  const token = credential.security_oauth_token;
  if (typeof token === "string" && token.length > 0) return token;
  return typeof credential.access_token === "string" ? credential.access_token : "";
}
function qoderChatHeaders(credential, product, requestId, sessionId) {
  return {
    Authorization: `Bearer ${qoderBearerToken(credential)}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "X-Request-ID": requestId,
    "X-Session-ID": sessionId,
    "User-Agent": `${product.userAgentPrefix}/1.0.0`
  };
}
function applyQoderRefresh(credential, payload) {
  const next = buildQoderCredential(payload, {
    machineId: credential.machine_id,
    ...credential.nickname === void 0 ? {} : { nickname: credential.nickname }
  });
  if (next.refresh_token === void 0 && credential.refresh_token !== void 0) {
    next.refresh_token = credential.refresh_token;
  }
  if (next.uid === void 0 && credential.uid !== void 0) {
    next.uid = credential.uid;
  }
  return next;
}
async function fetchQoderUserNickname(credential, product, fetcher = fetch) {
  try {
    const response = await fetcher(`${product.openApiBase}${QODER_USERINFO_PATH}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.security_oauth_token || credential.access_token}`
      }
    });
    if (!response.ok) return void 0;
    const body = await response.json();
    if (typeof body !== "object" || body === null) return void 0;
    const name = body.name;
    if (typeof name !== "string") return void 0;
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : void 0;
  } catch {
    return void 0;
  }
}
function withQoderNickname(credential, nickname) {
  if (nickname === void 0 || nickname.length === 0) return credential;
  return { ...credential, nickname };
}
export {
  QODER_CHAT_PATH,
  QODER_DEVICE_SELECT_PATH,
  QODER_LOGIN_TIMEOUT_MS,
  QODER_POLL_INTERVAL_MS,
  QODER_POLL_MAX_FAILURES,
  QODER_POLL_PATH,
  QODER_REFRESH_PATH,
  QODER_REQUEST_TIMEOUT_MS,
  QODER_USERINFO_PATH,
  applyQoderRefresh,
  buildQoderAuthUrl,
  buildQoderCredential,
  buildQoderPollUrl,
  createQoderDeviceSession,
  createQoderPkce,
  fetchQoderUserNickname,
  isQoderExpired,
  isQoderRefreshable,
  parseQoderTokenPayload,
  qoderBearerToken,
  qoderChatHeaders,
  qoderCredentialExpiresAtMs,
  qoderRefreshBody,
  withQoderNickname
};
