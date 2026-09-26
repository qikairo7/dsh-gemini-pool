function readString(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return void 0;
}
function parseClineTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1e3) : Math.round(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function parseClineTokenPayload(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { accessToken: "" };
  }
  const envelope = value;
  const inner = typeof envelope.data === "object" && envelope.data !== null && !Array.isArray(envelope.data) ? envelope.data : envelope;
  const accessToken = readString(inner, ["accessToken", "access_token"]) ?? "";
  const refreshToken = readString(inner, ["refreshToken", "refresh_token"]);
  const expiresAt = parseClineTimestamp(inner.expiresAt ?? inner.expires_at ?? inner.expire_time);
  const userInfo = typeof inner.userInfo === "object" && inner.userInfo !== null && !Array.isArray(inner.userInfo) ? inner.userInfo : void 0;
  const accountId = userInfo === void 0 ? readString(inner, ["accountId", "account_id"]) : readString(userInfo, ["clineUserId", "accountId"]) ?? readString(inner, ["accountId", "account_id"]);
  const email = userInfo === void 0 ? readString(inner, ["email"]) : readString(userInfo, ["email"]) ?? readString(inner, ["email"]);
  const firstName = userInfo === void 0 ? void 0 : readString(userInfo, ["firstName"]);
  const lastName = userInfo === void 0 ? void 0 : readString(userInfo, ["lastName"]);
  const displayName = [firstName, lastName].filter((part) => part !== void 0).join(" ").trim();
  return {
    accessToken,
    ...refreshToken === void 0 ? {} : { refreshToken },
    ...expiresAt === void 0 ? {} : { expiresAt },
    ...accountId === void 0 ? {} : { accountId },
    ...email === void 0 ? {} : { email },
    ...displayName.length === 0 ? {} : { displayName }
  };
}
function clineBearerValue(accessToken, product) {
  const token = accessToken.trim();
  if (token.length === 0) return "";
  return token.startsWith(product.tokenPrefix) ? token : `${product.tokenPrefix}${token}`;
}
function buildClineCredential(payload, product, fallback = {}) {
  const accountId = payload.accountId ?? fallback.accountId;
  const email = payload.email ?? fallback.email;
  const nickname = email ?? (payload.displayName !== void 0 && payload.displayName.length > 0 ? payload.displayName : accountId);
  return {
    access_token: clineBearerValue(payload.accessToken, product),
    ...payload.refreshToken === void 0 ? {} : { refresh_token: payload.refreshToken },
    ...payload.expiresAt === void 0 ? {} : { expire_time: payload.expiresAt },
    ...accountId === void 0 ? {} : { account_id: accountId },
    ...email === void 0 ? {} : { email },
    ...nickname === void 0 ? {} : { nickname }
  };
}
function applyClineRefresh(credential, payload, product) {
  const next = {
    ...credential,
    access_token: clineBearerValue(payload.accessToken, product)
  };
  if (payload.refreshToken !== void 0) next.refresh_token = payload.refreshToken;
  if (payload.expiresAt !== void 0) next.expire_time = payload.expiresAt;
  if (payload.accountId !== void 0) next.account_id = payload.accountId;
  if (payload.email !== void 0) next.email = payload.email;
  return next;
}
function clineCredentialExpiresAtMs(credential) {
  return credential.expire_time;
}
function isClineRefreshable(credential) {
  return typeof credential.refresh_token === "string" && credential.refresh_token.length > 0;
}
function isClineExpired(credential, nowMs = Date.now()) {
  const expiresAt = clineCredentialExpiresAtMs(credential);
  return expiresAt !== void 0 && expiresAt <= nowMs;
}
function clineRefreshBody(credential) {
  return {
    refreshToken: credential.refresh_token ?? "",
    grantType: "refresh_token"
  };
}
function clineHeaders(credential, product, extra = {}) {
  const bearer = clineBearerValue(credential.access_token, product);
  return {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
    ...product.clientHeaders,
    ...extra
  };
}
function clineAuthHeaders(accessToken, product, extra = {}) {
  return {
    Authorization: `Bearer ${clineBearerValue(accessToken, product)}`,
    Accept: "application/json",
    ...product.clientHeaders,
    ...extra
  };
}
export {
  applyClineRefresh,
  buildClineCredential,
  clineAuthHeaders,
  clineBearerValue,
  clineCredentialExpiresAtMs,
  clineHeaders,
  clineRefreshBody,
  isClineExpired,
  isClineRefreshable,
  parseClineTimestamp,
  parseClineTokenPayload
};
