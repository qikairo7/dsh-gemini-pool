import { randomBytes } from "node:crypto";
import {
  RACCOON_QR_STATUS,
  RACCOON_REQUEST_TIMEOUT_MS,
  decodeJwtExpMs,
  encryptRaccoonPhone,
  raccoonHeaders
} from "./raccoon.js";
function parseEnvelope(payload, status) {
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
  const code = typeof record.code === "number" ? record.code : status >= 400 ? status : 0;
  const message = typeof record.message === "string" ? record.message : "";
  const details = typeof record.details === "string" ? record.details : "";
  const data = typeof record.data === "object" && record.data !== null && !Array.isArray(record.data) ? record.data : void 0;
  return { code, message, details, data };
}
function envelopeError(envelope, fallback) {
  const parts = [envelope.message, envelope.details].filter((s) => s.length > 0);
  const text = parts.length > 0 ? parts.join(": ") : fallback;
  return new Error(`raccoon: ${text}`);
}
async function postJson(url, body, fetcher, headers = {}) {
  let response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(
      `raccoon: \u8BF7\u6C42\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`raccoon: \u54CD\u5E94\u4E0D\u662F JSON\uFF08HTTP ${response.status}\uFF09`);
  }
  return { envelope: parseEnvelope(parsed, response.status), status: response.status };
}
function generateQrCode() {
  return randomBytes(16).toString("hex");
}
function buildQrImageUrl(product, code) {
  const params = new URLSearchParams({ code, appname: "\u5546\u6C64\u5C0F\u6D63\u718A\u5B98\u7F51" });
  return `${product.apiBase}/login/mp?${params.toString()}`;
}
async function pollRaccoonQrLogin(product, code, fetcher = fetch) {
  let envelope;
  try {
    const result = await postJson(
      `${product.apiBase}${product.authApiPrefix}/login_with_qrcode_code`,
      { qrcode_code: code },
      fetcher
    );
    envelope = result.envelope;
  } catch {
    return { status: "pending" };
  }
  if (envelope.code !== 0 || envelope.data === void 0) return { status: "pending" };
  const raw = envelope.data.status;
  const status = typeof raw === "string" ? raw : "";
  const expiredAt = typeof envelope.data.expired_at === "string" ? envelope.data.expired_at : void 0;
  if (status === RACCOON_QR_STATUS.canceled) return { status: "canceled" };
  if (status === RACCOON_QR_STATUS.logging) {
    return { status: "logging", ...expiredAt !== void 0 ? { expiredAt } : {} };
  }
  if (status === RACCOON_QR_STATUS.success) {
    const accessToken = typeof envelope.data.access_token === "string" ? envelope.data.access_token : "";
    const refreshToken = typeof envelope.data.refresh_token === "string" ? envelope.data.refresh_token : "";
    if (accessToken.length === 0) return { status: "pending" };
    const expMs = decodeJwtExpMs(accessToken);
    return {
      status: "success",
      accessToken,
      refreshToken,
      ...expMs !== void 0 ? { expiresAt: String(expMs) } : {}
    };
  }
  return { status: "pending" };
}
async function sendRaccoonSmsCode(product, phone, captchaParam, fetcher = fetch) {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/send_sms`,
    {
      captcha_param: captchaParam,
      nation_code: "86",
      phone: encryptRaccoonPhone(phone)
    },
    fetcher
  );
  if (envelope.code !== 0) {
    if (envelope.code === 100006) {
      throw new Error("raccoon: \u56FE\u5F62\u9A8C\u8BC1\u7801\u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u5B8C\u6210\u6ED1\u5757\u9A8C\u8BC1");
    }
    throw envelopeError(envelope, "\u4E0B\u53D1\u77ED\u4FE1\u9A8C\u8BC1\u7801\u5931\u8D25");
  }
}
async function loginRaccoonWithSmsCode(product, phone, smsCode, fetcher = fetch) {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/login_with_sms`,
    {
      nation_code: "86",
      phone: encryptRaccoonPhone(phone),
      sms_code: smsCode
    },
    fetcher
  );
  if (envelope.code !== 0) throw envelopeError(envelope, "\u77ED\u4FE1\u767B\u5F55\u5931\u8D25");
  return credentialFromEnvelope(envelope);
}
function credentialFromEnvelope(envelope) {
  const data = envelope.data ?? {};
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  if (accessToken.length === 0) {
    throw new Error("raccoon: \u767B\u5F55\u54CD\u5E94\u7F3A\u5C11 access_token");
  }
  const expMs = decodeJwtExpMs(accessToken);
  const officeIdentity = typeof data.office_identity === "string" ? data.office_identity : "";
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...expMs !== void 0 ? { expires_at: String(expMs) } : {},
    ...officeIdentity.length > 0 ? { office_identity: officeIdentity } : {}
  };
}
async function exchangeRaccoonAuthorizationCode(product, authorizationCode, fetcher = fetch) {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/login_with_authorization_code`,
    { authorization_code: authorizationCode },
    fetcher
  );
  if (envelope.code !== 0) {
    if (envelope.code === 200035) {
      throw new Error("raccoon: \u6388\u6743\u7801\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u767B\u5F55");
    }
    throw envelopeError(envelope, "\u6388\u6743\u7801\u767B\u5F55\u5931\u8D25");
  }
  return credentialFromEnvelope(envelope);
}
async function refreshRaccoonCredential(product, credential, fetcher = fetch) {
  const { envelope, status } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/refresh`,
    { refresh_token: credential.refresh_token },
    fetcher
  );
  if (status === 401 || envelope.code === 200003) {
    throw new Error("raccoon: \u767B\u5F55\u6001\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
  }
  if (envelope.code !== 0) throw envelopeError(envelope, "\u7EED\u671F\u5931\u8D25");
  const data = envelope.data ?? {};
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (accessToken.length === 0) {
    throw new Error("raccoon: \u7EED\u671F\u54CD\u5E94\u7F3A\u5C11 access_token");
  }
  const nextRefresh = typeof data.refresh_token === "string" && data.refresh_token.length > 0 ? data.refresh_token : credential.refresh_token;
  const expMs = decodeJwtExpMs(accessToken);
  return {
    ...credential,
    access_token: accessToken,
    refresh_token: nextRefresh,
    ...expMs !== void 0 ? { expires_at: String(expMs) } : {}
  };
}
async function fetchRaccoonUserInfo(product, credential, fetcher = fetch) {
  try {
    const response = await fetcher(`${product.apiBase}${product.authApiPrefix}/user_info`, {
      method: "GET",
      headers: raccoonHeaders(credential),
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) return {};
    const envelope = parseEnvelope(await response.json(), response.status);
    if (envelope.code !== 0 || envelope.data === void 0) return {};
    const userId = typeof envelope.data.id === "string" ? envelope.data.id : "";
    const nickname = typeof envelope.data.name === "string" ? envelope.data.name : "";
    const officeIdentity = typeof envelope.data.office_identity === "string" ? envelope.data.office_identity : "";
    const phone = typeof envelope.data.phone === "string" ? envelope.data.phone : "";
    return {
      ...userId.length > 0 ? { userId } : {},
      ...nickname.length > 0 ? { nickname } : {},
      ...officeIdentity.length > 0 ? { officeIdentity } : {},
      ...phone.length > 0 ? { phone } : {}
    };
  } catch {
    return {};
  }
}
export {
  buildQrImageUrl,
  exchangeRaccoonAuthorizationCode,
  fetchRaccoonUserInfo,
  generateQrCode,
  loginRaccoonWithSmsCode,
  pollRaccoonQrLogin,
  refreshRaccoonCredential,
  sendRaccoonSmsCode
};
