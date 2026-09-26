const LOOMY_API_BASE = "https://loomyad.xunfei.cn/api/v1";
const LOOMY_ACCOUNT_BASE = "https://account.xfinfr.com";
const LOOMY_OK_CODE = "000000";
const LOOMY_AUTH_ERROR_CODE = "100002";
const LOOMY_BAD_REQUEST_CODE = "100001";
const LOOMY_REQUEST_TIMEOUT_MS = 6e4;
function parseLoomyEnvelope(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, code: "", message: "\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61", data: void 0 };
  }
  const record = payload;
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.desc === "string" && record.desc.length > 0 ? record.desc : typeof record.message === "string" ? record.message : "";
  if (code !== LOOMY_OK_CODE) {
    return {
      ok: false,
      code,
      message: message.length > 0 ? message : `\u4E1A\u52A1\u9519\u8BEF ${code || "(\u7F3A\u5C11 code)"}`,
      data: void 0
    };
  }
  return { ok: true, code, message, data: record.data };
}
function splitLoomyRate(rawName) {
  const original = typeof rawName === "string" ? rawName.trim() : "";
  if (original.length === 0) return { name: "", rate: "" };
  const bracketed = original.match(/^(.*?)\s*[（(]\s*(x\s*[\d.]+)\s*[)）]\s*$/i);
  if (bracketed !== null) {
    const name = String(bracketed[1] ?? "").trim();
    const rate = String(bracketed[2] ?? "").replace(/\s+/g, "").toLowerCase();
    if (name.length > 0) return { name, rate };
    return { name: original, rate: "" };
  }
  const normalized = original.match(/^(.*?)\s*·\s*(x\s*[\d.]+)\s*$/i);
  if (normalized !== null) {
    const name = String(normalized[1] ?? "").trim();
    const rate = String(normalized[2] ?? "").replace(/\s+/g, "").toLowerCase();
    if (name.length > 0) return { name, rate };
  }
  return { name: original, rate: "" };
}
function loomyDisplayName(rawName) {
  const { name, rate } = splitLoomyRate(rawName);
  return rate.length > 0 ? `${name} \xB7 ${rate}` : name;
}
function isLoomyChatModel(entry) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const record = entry;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  return id.length > 0 && record.type === "chat";
}
function credentialExpiresAtMs(credential) {
  const raw = credential.expires_at;
  if (typeof raw !== "string" || raw.trim().length === 0) return void 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : void 0;
}
function isLoomyExpired(credential) {
  const expiresAt = credentialExpiresAtMs(credential);
  return expiresAt !== void 0 && expiresAt <= Date.now();
}
function isLoomyRefreshable(_credential) {
  return false;
}
function loomyBusinessHeaders(token) {
  return { Accept: "application/json", token };
}
function loomyChatHeaders(token) {
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    token
  };
}
export {
  LOOMY_ACCOUNT_BASE,
  LOOMY_API_BASE,
  LOOMY_AUTH_ERROR_CODE,
  LOOMY_BAD_REQUEST_CODE,
  LOOMY_OK_CODE,
  LOOMY_REQUEST_TIMEOUT_MS,
  credentialExpiresAtMs,
  isLoomyChatModel,
  isLoomyExpired,
  isLoomyRefreshable,
  loomyBusinessHeaders,
  loomyChatHeaders,
  loomyDisplayName,
  parseLoomyEnvelope,
  splitLoomyRate
};
