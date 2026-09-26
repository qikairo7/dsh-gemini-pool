import { createCipheriv, randomBytes } from "node:crypto";
const RACCOON_API_BASE = "https://xiaohuanxiong.com";
const RACCOON_AUTH_PREFIX = "/api/web/auth/v1";
const RACCOON_LLM_PREFIX = "/api/web/llm/v2";
const RACCOON_POINTS_PREFIX = "/api/web/points/v1";
const RACCOON_DESKTOP_PREFIX = "/api/web/desktop/v1";
const RACCOON_PHONE_CIPHER_SECRET = "senseraccoon2023";
const RACCOON_TOKEN_REFRESH_WINDOW_SECONDS = 300;
const RACCOON_REQUEST_TIMEOUT_MS = 6e4;
const RACCOON_QR_POLL_INTERVAL_MS = 2e3;
const RACCOON_LOGIN_TIMEOUT_MS = 5 * 60 * 1e3;
const RACCOON_QR_STATUS = {
  pending: "pending",
  logging: "logging",
  canceled: "canceled",
  success: "success"
};
function decodeJwtExpMs(token) {
  if (typeof token !== "string" || token.length === 0) return void 0;
  const parts = token.split(".");
  if (parts.length < 2) return void 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return void 0;
    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return void 0;
    return exp * 1e3;
  } catch {
    return void 0;
  }
}
function raccoonCredentialExpiresAtMs(credential) {
  const raw = credential.expires_at;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return decodeJwtExpMs(credential.access_token);
}
function isRaccoonExpired(credential) {
  const expiresAt = raccoonCredentialExpiresAtMs(credential);
  return expiresAt !== void 0 && expiresAt <= Date.now();
}
function isRaccoonRefreshable(credential) {
  return typeof credential.refresh_token === "string" && credential.refresh_token.trim().length > 0;
}
function encryptRaccoonPhone(phone, iv) {
  const key = Buffer.from(RACCOON_PHONE_CIPHER_SECRET, "utf8");
  const nonce = iv ?? randomBytes(16);
  const cipher = createCipheriv("aes-128-cfb", key, nonce);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(phone, "utf8")), cipher.final()]);
  return Buffer.concat([nonce, ciphertext]).toString("base64");
}
function formatMultiplier(value) {
  return String(Number(value.toFixed(4)));
}
function raccoonDisplayName(model) {
  const name = typeof model.description === "string" && model.description.length > 0 ? model.description : model.id;
  const effective = model.effectiveMultiplier;
  if (typeof effective !== "number" || !Number.isFinite(effective) || effective < 0) return name;
  if (effective === 0) return `${name} \xB7 \u514D\u8D39`;
  const base = model.baseMultiplier;
  const hasBase = typeof base === "number" && Number.isFinite(base) && base > 0;
  if (hasBase && base > effective) {
    return `${name} \xB7 x${formatMultiplier(base)}\u2192x${formatMultiplier(effective)}`;
  }
  return `${name} \xB7 x${formatMultiplier(effective)}`;
}
function raccoonHeaders(credential, opts = {}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.access_token}`,
    // 个人账号为空串；客户端总是发送该头
    "X-Org-Code": credential.office_identity ?? "",
    "X-Raccoon-Language": "zh"
  };
  if (opts.platform !== void 0 && opts.platform.length > 0) {
    headers["X-Client-Platform"] = opts.platform;
  }
  if (opts.version !== void 0 && opts.version.length > 0) {
    headers["X-Client-Version"] = opts.version;
  }
  if (credential.device_id !== void 0 && credential.device_id.length > 0) {
    headers["X-Client-Device-ID"] = credential.device_id;
  }
  return headers;
}
export {
  RACCOON_API_BASE,
  RACCOON_AUTH_PREFIX,
  RACCOON_DESKTOP_PREFIX,
  RACCOON_LLM_PREFIX,
  RACCOON_LOGIN_TIMEOUT_MS,
  RACCOON_PHONE_CIPHER_SECRET,
  RACCOON_POINTS_PREFIX,
  RACCOON_QR_POLL_INTERVAL_MS,
  RACCOON_QR_STATUS,
  RACCOON_REQUEST_TIMEOUT_MS,
  RACCOON_TOKEN_REFRESH_WINDOW_SECONDS,
  decodeJwtExpMs,
  encryptRaccoonPhone,
  isRaccoonExpired,
  isRaccoonRefreshable,
  raccoonCredentialExpiresAtMs,
  raccoonDisplayName,
  raccoonHeaders
};
