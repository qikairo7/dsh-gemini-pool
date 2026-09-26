import {
  buildClineCredential,
  isClineRefreshable,
  parseClineTokenPayload,
  clineCredentialExpiresAtMs
} from "./cline.js";
import {
  CLINE_DEVICE_AUTHENTICATE_PATH,
  CLINE_DEVICE_AUTHORIZATION_PATH,
  CLINE_REGISTER_PATH
} from "./cline-product.js";
const CLINE_HTTP_TIMEOUT_MS = 3e4;
const CLINE_DEVICE_AUTH_EXPIRES_MS = 3e5;
const CLINE_DEVICE_AUTH_INTERVAL_MS = 5e3;
const CLINE_POLL_MAX_FAILURES = 5;
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("\u767B\u5F55\u5DF2\u53D6\u6D88"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("\u767B\u5F55\u5DF2\u53D6\u6D88"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function isAborted(signal) {
  return signal?.aborted === true;
}
const SERVER_ERROR_PREFIX = "\u767B\u5F55\u670D\u52A1\u8FD4\u56DE\u5F02\u5E38";
function toMs(value, fallbackMs) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallbackMs;
  return Math.floor(value) * 1e3;
}
async function requestClineDeviceAuthorization(product, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${product.workOsBase}${CLINE_DEVICE_AUTHORIZATION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: product.workOsClientId }).toString(),
    signal: options.signal ?? AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload.error_description === "string" ? ` - ${payload.error_description}` : "";
    throw new Error(`${SERVER_ERROR_PREFIX}\uFF1A\u8BBE\u5907\u7801\u6388\u6743\u5931\u8D25\uFF08HTTP ${response.status}\uFF09${detail}`);
  }
  const deviceCode = typeof payload.device_code === "string" ? payload.device_code : "";
  const userCode = typeof payload.user_code === "string" ? payload.user_code : "";
  const verificationUri = typeof payload.verification_uri === "string" ? payload.verification_uri : "";
  if (deviceCode.length === 0 || userCode.length === 0 || verificationUri.length === 0) {
    throw new Error(`${SERVER_ERROR_PREFIX}\uFF1A\u8BBE\u5907\u7801\u6388\u6743\u54CD\u5E94\u7F3A\u5C11\u5FC5\u8981\u5B57\u6BB5`);
  }
  const verificationUriComplete = typeof payload.verification_uri_complete === "string" && payload.verification_uri_complete.length > 0 ? payload.verification_uri_complete : void 0;
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...verificationUriComplete === void 0 ? {} : { verificationUriComplete },
    expiresInMs: toMs(payload.expires_in, CLINE_DEVICE_AUTH_EXPIRES_MS),
    intervalMs: toMs(payload.interval, CLINE_DEVICE_AUTH_INTERVAL_MS)
  };
}
async function pollClineWorkOsTokens(authorization, options) {
  const fetcher = options.fetcher ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? authorization.expiresInMs);
  let intervalMs = Math.max(1e3, options.pollIntervalMs ?? authorization.intervalMs);
  let failures = 0;
  while (Date.now() <= deadline) {
    if (isAborted(options.signal)) throw new Error("\u767B\u5F55\u5DF2\u53D6\u6D88");
    try {
      const response = await fetcher(`${options.product.workOsBase}${CLINE_DEVICE_AUTHENTICATE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: authorization.deviceCode,
          client_id: options.product.workOsClientId
        }).toString(),
        signal: options.signal ?? AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS)
      });
      const payload = await response.json().catch(() => ({}));
      failures = 0;
      if (response.ok) {
        const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
        const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
        if (accessToken.length === 0 || refreshToken.length === 0) {
          throw new Error(`${SERVER_ERROR_PREFIX}\uFF1AWorkOS token \u54CD\u5E94\u7F3A\u5C11\u5FC5\u8981\u5B57\u6BB5`);
        }
        return { accessToken, refreshToken };
      }
      const errorCode = typeof payload.error === "string" ? payload.error : "";
      switch (errorCode) {
        case "authorization_pending": {
          await sleep(intervalMs, options.signal);
          continue;
        }
        case "slow_down": {
          intervalMs += 1e3;
          await sleep(intervalMs, options.signal);
          continue;
        }
        case "access_denied":
        case "expired_token":
        case "invalid_grant": {
          const detail = typeof payload.error_description === "string" ? payload.error_description : "WorkOS \u6388\u6743\u5931\u8D25";
          throw new Error(`${SERVER_ERROR_PREFIX}\uFF1A${detail}`);
        }
        default: {
          const detail = typeof payload.error_description === "string" ? ` - ${payload.error_description}` : "";
          throw new Error(`${SERVER_ERROR_PREFIX}\uFF1AWorkOS token \u8F6E\u8BE2\u5931\u8D25\uFF08HTTP ${response.status}\uFF09${detail}`);
        }
      }
    } catch (error) {
      if (isAborted(options.signal)) throw new Error("\u767B\u5F55\u5DF2\u53D6\u6D88");
      if (error instanceof Error && error.message.startsWith(SERVER_ERROR_PREFIX)) throw error;
      failures += 1;
      if (failures >= CLINE_POLL_MAX_FAILURES) {
        throw new Error(
          `\u65E0\u6CD5\u8FDE\u63A5 Cline \u767B\u5F55\u670D\u52A1\uFF08\u8FDE\u7EED ${failures} \u6B21\u5931\u8D25\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`
        );
      }
      await sleep(intervalMs, options.signal);
    }
  }
  throw new Error("\u767B\u5F55\u7B49\u5F85\u5DF2\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u767B\u5F55");
}
async function registerClineTokens(workOsTokens, options) {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${options.product.apiBase}${CLINE_REGISTER_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...options.product.clientHeaders
    },
    body: JSON.stringify({
      accessToken: workOsTokens.accessToken,
      refreshToken: workOsTokens.refreshToken
    }),
    signal: options.signal ?? AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload.error === "string" ? ` - ${payload.error}` : "";
    throw new Error(`${SERVER_ERROR_PREFIX}\uFF1Atoken \u6CE8\u518C\u5931\u8D25\uFF08HTTP ${response.status}\uFF09${detail}`);
  }
  return payload;
}
function toLoginFlowResult(credential, loginUrl, userCode) {
  return {
    access: JSON.stringify(credential),
    // 与其它 provider 一致：无法解析过期时间时报 0，而不是抛错 ——
    // 凭据本身可用（只是有效期未知），不该因展示层缺失而登录失败。
    expires: clineCredentialExpiresAtMs(credential) ?? 0,
    loginUrl,
    refreshable: isClineRefreshable(credential),
    ...userCode === void 0 ? {} : { userCode }
  };
}
async function defaultOpenBrowser(url) {
  const { openBrowser } = await import("./login.js");
  openBrowser(url);
}
async function startClineLoginFlow(options) {
  const controller = new AbortController();
  const signal = options.signal === void 0 ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  const authorization = await requestClineDeviceAuthorization(options.product, {
    ...options.fetcher === void 0 ? {} : { fetcher: options.fetcher },
    signal
  });
  const loginUrl = authorization.verificationUriComplete ?? authorization.verificationUri;
  const result = (async () => {
    const workOsTokens = await pollClineWorkOsTokens(authorization, { ...options, signal });
    const registered = await registerClineTokens(workOsTokens, { ...options, signal });
    const payload = parseClineTokenPayload(registered);
    if (payload.accessToken.length === 0) {
      throw new Error("\u767B\u5F55\u54CD\u5E94\u7F3A\u5C11\u8BBF\u95EE\u4EE4\u724C");
    }
    const credential = buildClineCredential(payload, options.product);
    return toLoginFlowResult(credential, loginUrl, authorization.userCode);
  })();
  result.catch(() => {
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
  };
  return {
    loginUrl,
    ...authorization.userCode.length === 0 ? {} : { userCode: authorization.userCode },
    result,
    close
  };
}
async function runClineLoginFlow(options) {
  const open = options.openBrowser ?? defaultOpenBrowser;
  const started = await startClineLoginFlow(options);
  try {
    await open(started.loginUrl);
    return await started.result;
  } finally {
    await started.close();
  }
}
export {
  CLINE_DEVICE_AUTH_EXPIRES_MS,
  CLINE_DEVICE_AUTH_INTERVAL_MS,
  CLINE_HTTP_TIMEOUT_MS,
  CLINE_POLL_MAX_FAILURES,
  pollClineWorkOsTokens,
  registerClineTokens,
  requestClineDeviceAuthorization,
  runClineLoginFlow,
  startClineLoginFlow
};
