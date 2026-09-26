import { createServer } from "node:http";
import { credentialExpiresAtMs } from "./buddy.js";
import {
  TRAE_EXCHANGE_PATH,
  TRAE_LOGIN_TIMEOUT_MS,
  TRAE_REQUEST_TIMEOUT_MS,
  TRAE_USER_INFO_PATH,
  buildTraeCredential,
  generateDeviceId,
  generateMachineId,
  parseTraeExchangeResponse,
  parseTraeUserInfoResponse,
  traeOAuthHeaders
} from "./trae.js";
const TRAE_CALLBACK_PORT = 18080;
function machineTraceId(machineId, deviceId) {
  const joined = machineId + deviceId;
  return joined.length >= 16 ? joined.slice(-16) : joined.padStart(16, "0");
}
function buildTraeLoginURL(product, machineId, deviceId, callbackUrl) {
  const params = new URLSearchParams({
    login_version: "1",
    auth_from: "solo",
    login_channel: "native_ide",
    plugin_version: product.pluginVersion,
    auth_type: "local",
    client_id: product.clientId,
    redirect: "0",
    login_trace_id: machineTraceId(machineId, deviceId),
    // ⚠️ 参数名必须是 auth_callback_url（见函数注释）。
    auth_callback_url: callbackUrl,
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: "PC",
    x_device_type: "PC",
    x_os_version: "1.0",
    x_app_version: product.ideVersion,
    x_app_type: "stable"
  });
  return `${product.consoleHost}/authorization?${params.toString()}`;
}
function parseJsonParam(raw) {
  if (raw === null || raw.length === 0) return void 0;
  const candidates = [raw];
  try {
    const unescaped = decodeURIComponent(raw);
    if (unescaped !== raw) candidates.push(unescaped);
  } catch {
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
    }
  }
  return void 0;
}
function jsonString(source, key) {
  if (source === void 0) return "";
  const value = source[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
function fixNicknameMojibake(raw, uid) {
  if (raw.length === 0) return raw;
  for (const encoding of ["latin1"]) {
    try {
      const fixed = Buffer.from(raw, encoding).toString("utf8");
      if (fixed.length > 0 && !fixed.includes("\uFFFD") && [...fixed].every((ch) => ch.charCodeAt(0) >= 32)) {
        return fixed;
      }
    } catch {
    }
  }
  if (!/[\u4e00-\u9fff]/.test(raw)) return `\u7528\u6237${uid.slice(-4)}`;
  return raw;
}
function parseTraeCallback(rawUrl) {
  const result = parseTraeCallbackDetailed(rawUrl);
  return result.ok ? result.info : void 0;
}
function parseTraeCallbackDetailed(rawUrl) {
  let query;
  try {
    query = new URL(rawUrl.startsWith("http") ? rawUrl : `http://127.0.0.1${rawUrl}`).searchParams;
  } catch {
    return { ok: false, reason: "\u56DE\u8C03 URL \u65E0\u6CD5\u89E3\u6790", authCodeFlow: false };
  }
  const userInfo = parseJsonParam(query.get("userInfo"));
  const userJwt = parseJsonParam(query.get("userJwt"));
  let refreshToken = query.get("refreshToken") ?? "";
  const uid = jsonString(userInfo, "UserID");
  const nicknameRaw = jsonString(userInfo, "ScreenName");
  const enterpriseId = jsonString(userInfo, "TenantID");
  const jwtToken = jsonString(userJwt, "Token");
  const jwtRefresh = jsonString(userJwt, "RefreshToken");
  if (refreshToken.length === 0) refreshToken = jwtRefresh;
  const authCodeInfo = parseJsonParam(query.get("authCodeInfo"));
  const authCodeCandidates = [
    query.get("code") ?? "",
    query.get("authCode") ?? "",
    jsonString(authCodeInfo, "code"),
    jsonString(authCodeInfo, "authCode"),
    // authCodeInfo 为**纯 code 字符串**（非 JSON）时 parseJsonParam 解不出，
    // 故把原始值也作为兜底候选放在最后 —— 前面能解出 JSON 字段时不会走到这里。
    query.get("authCodeInfo") ?? ""
  ];
  const authCode = authCodeCandidates.find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  const info = {
    refreshToken,
    // 仅在「无 refreshToken」时才用 userJwt.Token 兜底（login.sh:186-195）。
    accessToken: refreshToken.length === 0 ? jwtToken : "",
    uid,
    nickname: fixNicknameMojibake(nicknameRaw, uid),
    enterpriseId
  };
  if (authCode.length > 0) info.authCode = authCode;
  if (info.refreshToken.length === 0 && info.accessToken.length === 0) {
    if (authCode.length > 0) {
      return {
        ok: false,
        authCodeFlow: true,
        reason: "\u4E0A\u6E38\u8FD4\u56DE\u4E86 PKCE \u6388\u6743\u7801\uFF08code/authCodeInfo\uFF09\uFF0C\u672C\u5B9E\u73B0\u6682\u4E0D\u652F\u6301\u8BE5\u6D41\u7A0B\uFF1B\u8BF7\u786E\u8BA4 TRAE \u6388\u6743\u9875\u662F\u5426\u5DF2\u5207\u6362\u5230\u65B0\u6D41\u7A0B"
      };
    }
    return {
      ok: false,
      authCodeFlow: false,
      reason: "\u56DE\u8C03\u672A\u643A\u5E26 refreshToken / userJwt.Token / code"
    };
  }
  return { ok: true, info };
}
async function exchangeTraeCallback(callback, session, product, fetcher = fetch, nowMs = Date.now()) {
  let exchange;
  if (callback.refreshToken.length > 0) {
    const exchangeBody = {
      ClientID: product.clientId,
      RefreshToken: callback.refreshToken,
      ClientSecret: "-",
      UserID: ""
    };
    const exchangeResp = await fetcher(`${product.oauthHost}${TRAE_EXCHANGE_PATH}`, {
      method: "POST",
      headers: traeOAuthHeaders(product),
      body: JSON.stringify(exchangeBody),
      signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS)
    });
    if (!exchangeResp.ok) {
      const text = await exchangeResp.text().catch(() => "");
      throw new Error(`TRAE ExchangeToken \u5931\u8D25\uFF08HTTP ${exchangeResp.status}\uFF09\uFF1A${text.length > 200 ? text.slice(0, 200) : text}`);
    }
    const parsed = parseTraeExchangeResponse(await exchangeResp.json());
    if (parsed === void 0) throw new Error("TRAE ExchangeToken \u54CD\u5E94\u7F3A\u5C11 Token");
    exchange = parsed;
  } else {
    exchange = {
      accessToken: callback.accessToken,
      refreshToken: "",
      tokenExpireAt: 0,
      tokenExpireDuration: 0,
      refreshExpireAt: 0
    };
  }
  let userInfo = {
    uid: callback.uid,
    screenName: callback.nickname,
    enterpriseId: callback.enterpriseId
  };
  try {
    const uHeaders = traeOAuthHeaders(product);
    uHeaders["X-Cloudide-Token"] = exchange.accessToken;
    const userInfoResp = await fetcher(`${product.oauthHost}${TRAE_USER_INFO_PATH}`, {
      method: "POST",
      headers: uHeaders,
      body: JSON.stringify({ ReqSource: "IDE", IDEVersion: product.ideVersion }),
      signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS)
    });
    if (userInfoResp.ok) {
      const fetched = parseTraeUserInfoResponse(await userInfoResp.json());
      if (fetched !== void 0) {
        userInfo = {
          uid: fetched.uid,
          screenName: fetched.screenName.length > 0 ? fetched.screenName : userInfo.screenName,
          enterpriseId: fetched.enterpriseId.length > 0 ? fetched.enterpriseId : userInfo.enterpriseId
        };
      }
    }
  } catch {
  }
  if (userInfo.uid.length === 0) {
    throw new Error("TRAE \u672A\u80FD\u786E\u5B9A uid\uFF08\u56DE\u8C03 userInfo \u4E0E GetUserInfo \u5747\u4E3A\u7A7A\uFF09");
  }
  if (exchange.accessToken.length === 0) {
    throw new Error("TRAE \u6362 token \u540E\u6CA1\u6709 accessToken");
  }
  return buildTraeCredential(exchange, userInfo, session, nowMs);
}
function listenOrReject(server, port, onError) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onListenError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      onError?.(error);
      reject(error);
    };
    server.once("error", onListenError);
    server.listen(port, "127.0.0.1", () => {
      settled = true;
      server.removeListener("error", onListenError);
      server.on("error", () => {
      });
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}
async function listenWithFallback(server, preferredPort) {
  try {
    return await listenOrReject(server, preferredPort);
  } catch (error) {
    const code = error.code;
    if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
    return await listenOrReject(server, 0);
  }
}
async function runTraeLoginFlow(options) {
  const machineId = generateMachineId();
  const deviceId = generateDeviceId();
  const preferredPort = options.callbackPort ?? TRAE_CALLBACK_PORT;
  const { callback, port } = await startCallbackServer(preferredPort, options.product.consoleHost);
  const callbackUrl = `http://127.0.0.1:${port}/authorize`;
  const loginUrl = buildTraeLoginURL(options.product, machineId, deviceId, callbackUrl);
  const credential = await exchangeTraeCallback(
    callback,
    { machineId, deviceId },
    options.product,
    options.fetcher
  );
  const access = JSON.stringify(credential);
  const expires = credentialExpiresAtMs(credential) ?? 0;
  return {
    access,
    expires,
    loginUrl,
    refreshable: credential.refresh_token.length > 0
  };
}
async function startTraeLoginFlow(options) {
  const machineId = generateMachineId();
  const deviceId = generateDeviceId();
  const preferredPort = options.callbackPort ?? TRAE_CALLBACK_PORT;
  const server = createServer();
  let resultTimer;
  let rejectResult;
  let loginUrl = "";
  const resultPromise = new Promise((resolve, reject) => {
    rejectResult = reject;
    resultTimer = setTimeout(() => {
      server.close();
      reject(new Error("TRAE \u767B\u5F55\u8D85\u65F6"));
    }, TRAE_LOGIN_TIMEOUT_MS);
    resultTimer.unref?.();
    server.on("request", (req, res) => {
      const url = req.url ?? "";
      if (!url.startsWith("/authorize")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const parsed = parseTraeCallbackDetailed(url);
      if (!parsed.ok) {
        if (resultTimer) clearTimeout(resultTimer);
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`TRAE \u767B\u5F55\u56DE\u8C03\u65E0\u6548\uFF1A${parsed.reason}`);
        server.close();
        reject(new Error(`TRAE \u767B\u5F55\u56DE\u8C03\u65E0\u6548\uFF1A${parsed.reason}`));
        return;
      }
      const callback = parsed.info;
      exchangeTraeCallback(callback, { machineId, deviceId }, options.product, options.fetcher).then((credential) => {
        if (resultTimer) clearTimeout(resultTimer);
        const access = JSON.stringify(credential);
        const expires = credentialExpiresAtMs(credential) ?? 0;
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`TRAE \u767B\u5F55\u6210\u529F\uFF1A${credential.nickname ?? credential.uid}\u3002\u53EF\u4EE5\u5173\u95ED\u6B64\u9875\u9762\u8FD4\u56DE\u9762\u677F\u3002`);
        server.close();
        resolve({
          access,
          expires,
          loginUrl,
          refreshable: credential.refresh_token.length > 0
        });
      }).catch((error) => {
        if (resultTimer) clearTimeout(resultTimer);
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`TRAE \u767B\u5F55\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
        server.close();
        reject(error);
      });
    });
  });
  resultPromise.catch(() => {
  });
  let actualPort;
  try {
    actualPort = await listenWithFallback(server, preferredPort);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const message = `TRAE \u56DE\u8C03\u7AEF\u53E3\u65E0\u6CD5\u76D1\u542C\uFF08${reason}\uFF09\uFF1B\u7AEF\u53E3\u53EF\u80FD\u5DF2\u88AB\u5176\u5B83\u7A0B\u5E8F\u5360\u7528\uFF0C\u8BF7\u91CA\u653E\u540E\u91CD\u8BD5\u3002`;
    rejectResult?.(new Error(message));
    throw new Error(message);
  }
  const callbackUrl = `http://127.0.0.1:${actualPort}/authorize`;
  loginUrl = buildTraeLoginURL(options.product, machineId, deviceId, callbackUrl);
  return {
    loginUrl,
    result: resultPromise,
    // 关闭时**必须**同时清掉兜底超时定时器：否则用户在浏览器里点了取消、
    // 前端调 close() 之后，那个 10 分钟的定时器仍会挂着并最终 reject 一个
    // 无人消费的 Promise（未处理拒绝告警）。
    close: () => new Promise((resolve) => {
      if (resultTimer) clearTimeout(resultTimer);
      server.close(() => resolve());
    })
  };
}
async function startCallbackServer(port = TRAE_CALLBACK_PORT, _consoleHost, timeoutMs = TRAE_LOGIN_TIMEOUT_MS) {
  const server = createServer();
  let timer;
  let actualPort = port;
  const result = new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = req.url ?? "";
      if (!url.startsWith("/authorize")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const parsed = parseTraeCallbackDetailed(url);
      if (!parsed.ok) {
        if (timer) clearTimeout(timer);
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`TRAE \u767B\u5F55\u56DE\u8C03\u65E0\u6548\uFF1A${parsed.reason}`);
        server.close();
        reject(new Error(`TRAE \u767B\u5F55\u56DE\u8C03\u65E0\u6548\uFF1A${parsed.reason}`));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("\u5DF2\u6536\u5230 TRAE \u6388\u6743\uFF0C\u6B63\u5728\u6362\u53D6\u51ED\u636E\u2026\u53EF\u4EE5\u5173\u95ED\u6B64\u9875\u9762\u3002");
      server.close();
      resolve({ callback: parsed.info, port: actualPort });
    });
    timer = setTimeout(() => {
      server.close();
      reject(new Error("TRAE \u767B\u5F55\u56DE\u8C03\u8D85\u65F6"));
    }, timeoutMs);
    timer.unref?.();
  });
  result.catch(() => {
  });
  let resolvedPort;
  try {
    resolvedPort = await listenWithFallback(server, port);
  } catch (error) {
    if (timer) clearTimeout(timer);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`TRAE \u56DE\u8C03\u7AEF\u53E3 ${port} \u65E0\u6CD5\u76D1\u542C\uFF08${reason}\uFF09\uFF1B\u7AEF\u53E3\u53EF\u80FD\u5DF2\u88AB\u5360\u7528\u3002`);
  }
  actualPort = resolvedPort;
  server.once("close", () => {
    if (timer) clearTimeout(timer);
  });
  return result;
}
export {
  buildTraeLoginURL,
  exchangeTraeCallback,
  fixNicknameMojibake,
  machineTraceId,
  parseTraeCallback,
  parseTraeCallbackDetailed,
  runTraeLoginFlow,
  startCallbackServer,
  startTraeLoginFlow
};
