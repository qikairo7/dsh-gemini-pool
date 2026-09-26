import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  LOBSTERAI_CALLBACK_PATH,
  LOBSTERAI_EXCHANGE_PATH,
  LOBSTERAI_LOGIN_TIMEOUT_MS,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  isLobsteraiRefreshable,
  lobsteraiCredentialExpiresAtMs,
  lobsteraiAnonymousHeaders,
  parseLobsteraiEnvelope,
  parseLobsteraiTokenPayload,
  buildLobsteraiCredential
} from "./lobsterai.js";
function createLobsteraiLoginSession(nowMs = Date.now()) {
  return { uuid: randomUUID(), firstKeyfrom: String(nowMs) };
}
function buildLobsteraiLoginUrl(port, state, product) {
  const redirectUri = `http://127.0.0.1:${port}${LOBSTERAI_CALLBACK_PATH}`;
  const query = new URLSearchParams({
    source: "electron",
    redirect_uri: redirectUri,
    state
  });
  return `${product.portalBase}/portal#/login?${query.toString()}`;
}
async function exchangeLobsteraiAuthCode(code, session, clientVersion, product, fetcher = fetch, signal) {
  const body = {
    authCode: code,
    firstKeyfrom: session.firstKeyfrom,
    latestKeyfrom: String(Date.now()),
    uuid: session.uuid,
    version: clientVersion
  };
  const signalToUse = signal === void 0 ? AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS) : AbortSignal.any([AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS), signal]);
  let response;
  try {
    response = await fetcher(`${product.apiBase}${LOBSTERAI_EXCHANGE_PATH}`, {
      method: "POST",
      headers: lobsteraiAnonymousHeaders(product),
      body: JSON.stringify(body),
      signal: signalToUse
    });
  } catch (error) {
    throw new Error(`LobsterAI exchange \u7F51\u7EDC\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`LobsterAI exchange \u54CD\u5E94\u4E0D\u662F JSON\uFF08HTTP ${response.status}\uFF09`);
  }
  const envelope = parseLobsteraiEnvelope(parsed);
  if (!envelope.ok) {
    throw new Error(`LobsterAI exchange \u5931\u8D25\uFF1A${envelope.message}`);
  }
  const payload = parseLobsteraiTokenPayload(envelope.data);
  if (payload.accessToken.length === 0) {
    throw new Error("LobsterAI exchange \u54CD\u5E94\u7F3A\u5C11 accessToken");
  }
  return buildLobsteraiCredential(payload, {
    uuid: session.uuid,
    firstKeyfrom: session.firstKeyfrom,
    latestKeyfrom: body.latestKeyfrom
  });
}
function toLoginFlowResult(credential, loginUrl) {
  return {
    access: JSON.stringify(credential),
    // 与 Buddy 侧一致：无法解析过期时间时报告 0，而不是抛错 ——
    // 凭据本身可用（只是有效期未知），不该因为展示层的缺失而登录失败。
    expires: lobsteraiCredentialExpiresAtMs(credential) ?? 0,
    loginUrl,
    refreshable: isLobsteraiRefreshable(credential)
  };
}
async function defaultOpenBrowser(url) {
  const { openBrowser } = await import("./login.js");
  openBrowser(url);
}
async function startLobsteraiLoginFlow(options) {
  const fetcher = options.fetcher ?? fetch;
  const { product, clientVersion } = options;
  const session = createLobsteraiLoginSession();
  const state = randomUUID();
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  result.catch(() => {
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${request.socket.localPort}`);
    if (!url.pathname.startsWith(LOBSTERAI_CALLBACK_PATH)) {
      response.writeHead(404).end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const gotState = url.searchParams.get("state");
    if (code === null || code.length === 0 || gotState !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("\u767B\u5F55\u56DE\u8C03\u53C2\u6570\u65E0\u6548");
      return;
    }
    void exchangeLobsteraiAuthCode(code, session, clientVersion, product, fetcher, options.signal).then((credential) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<html><body><h2>\u767B\u5F55\u6210\u529F\uFF0C\u53EF\u4EE5\u5173\u95ED\u6B64\u7A97\u53E3\u4E86</h2></body></html>");
      const port2 = request.socket.localPort ?? 0;
      resolveResult(toLoginFlowResult(credential, buildLobsteraiLoginUrl(port2, state, product)));
    }).catch((error) => {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("\u767B\u5F55\u6362\u53D6\u51ED\u636E\u5931\u8D25");
      rejectResult(error);
    });
  });
  const port = await listenOnRandomPort(server);
  const loginUrl = buildLobsteraiLoginUrl(port, state, product);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(() => resolve()));
  };
  const resultWithTimeout = Promise.race([
    result,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`LobsterAI \u767B\u5F55\u8D85\u65F6\uFF08${Math.round((options.timeoutMs ?? LOBSTERAI_LOGIN_TIMEOUT_MS) / 1e3)} \u79D2\u5185\u672A\u5B8C\u6210\uFF09`)),
        options.timeoutMs ?? LOBSTERAI_LOGIN_TIMEOUT_MS
      );
      timer.unref?.();
    })
  ]);
  resultWithTimeout.catch(() => {
  }).finally(() => {
    void close();
  });
  return { loginUrl, result: resultWithTimeout, close };
}
async function runLobsteraiLoginFlow(options) {
  const open = options.openBrowser ?? defaultOpenBrowser;
  const started = await startLobsteraiLoginFlow(options);
  try {
    await open(started.loginUrl);
    return await started.result;
  } finally {
    await started.close();
  }
}
function listenOnRandomPort(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      if (port === 0) {
        reject(new Error("LobsterAI \u767B\u5F55\u56DE\u8C03\u670D\u52A1\u5668\u672A\u80FD\u83B7\u5F97\u7AEF\u53E3"));
        return;
      }
      resolve(port);
    });
  });
}
export {
  buildLobsteraiLoginUrl,
  createLobsteraiLoginSession,
  exchangeLobsteraiAuthCode,
  runLobsteraiLoginFlow,
  startLobsteraiLoginFlow
};
