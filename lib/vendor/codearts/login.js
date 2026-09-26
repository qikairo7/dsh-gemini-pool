import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { getRandomValues, randomUUID, randomBytes } from "node:crypto";
import {
  CLIENT_ID,
  REDIRECT_PATH,
  credentialFromTokenResponse,
  exchangeAuthorizationCode,
  generateDpopKeyPair,
  generatePkcePair
} from "./oauth.js";
const CODEARTS_LOGIN_BASE = "https://devcloud.cn-north-4.huaweicloud.com/doer/redirect";
const HUAWEI_AUTH_BASE = "https://auth.huaweicloud.com/authui/login.html";
const CREDENTIAL_ENDPOINT = "https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket";
const PLUGIN_NAME = "snap_jetbrains";
const PLUGIN_VERSION = "26.3.3";
function generateRandomSecret() {
  const bytes = getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function buildLoginUrl(port, ticketId) {
  const callbackUrl = `http://127.0.0.1:${port}/authentication`;
  const redirectUrl = `${CODEARTS_LOGIN_BASE}?IdeaType=jetbrains&auth_callback_url=${encodeURIComponent(callbackUrl)}&plugin-name=${PLUGIN_NAME}&plugin-version=${PLUGIN_VERSION}&ticket_id=${encodeURIComponent(ticketId)}`;
  const loginUrl = `${HUAWEI_AUTH_BASE}?service=${encodeURIComponent(redirectUrl)}`;
  return { redirectUrl, loginUrl };
}
function parseCredentialResponse(data) {
  if (data.credential) {
    const access = data.credential.access ?? "";
    const st = data.credential.securitytoken ?? data.credential.securityToken ?? "";
    if (access && st) {
      return {
        access_key_id: access,
        secret_access_key: data.credential.secret ?? "",
        security_token: st,
        expires_at: data.credential.expires_at ?? data.credential.expiresAt ?? "",
        domain_id: data.domain_id ?? "",
        user_id: data.user_id ?? "",
        user_name: data.user_name ?? ""
      };
    }
  }
  if (data.result) {
    const ak = data.result.accessKeyId ?? "";
    const st = data.result.securityToken ?? "";
    if (ak && st) {
      return {
        access_key_id: ak,
        secret_access_key: data.result.secretAccessKey ?? "",
        security_token: st,
        expires_at: data.result.expiration ?? data.result.expiresAt ?? ""
      };
    }
  }
  return null;
}
function expiresFromCredential(credential) {
  if (credential.expires_at) {
    const parsed = Date.parse(credential.expires_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now() + 864e5;
}
async function pollForCredential(ticketId, secret, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const maxAttempts = options.maxAttempts ?? 120;
  const pluginName = options.pluginName ?? PLUGIN_NAME;
  const pluginVersion = options.pluginVersion ?? PLUGIN_VERSION;
  const url = `${CREDENTIAL_ENDPOINT}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1e3));
    let response;
    try {
      response = await fetcher(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "plugin-name": pluginName,
          "plugin-version": pluginVersion
        }
      });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    let data;
    try {
      data = await response.json();
    } catch {
      continue;
    }
    const credential = data ? parseCredentialResponse(data) : null;
    if (credential) return credential;
  }
  throw new Error("CodeArts login timed out");
}
function openBrowser(url) {
  const win = process.platform === "win32";
  if (win) {
    const args = ["/c", "start", '""', `"${url}"`];
    try {
      const child = spawn("cmd", args, { detached: true, stdio: "ignore", windowsVerbatimArguments: true });
      child.unref();
      return;
    } catch (error) {
      console.error("[codearts-auth] failed to open browser; open manually:", url, error);
      return;
    }
  }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (error) {
    console.error("[codearts-auth] failed to open browser; open manually:", url, error);
  }
}
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400"
};
function pickToken(params) {
  return params.get("token") ?? params.get("access_token") ?? params.get("accessToken") ?? params.get("authCode") ?? "";
}
function startCallbackServer(ticketId, secret, options) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${request.socket.localPort}`);
    if (url.pathname !== "/authentication" && !url.pathname.startsWith("/authentication")) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS).end();
      return;
    }
    const params = url.searchParams;
    const directToken = pickToken(params);
    if (directToken) {
      response.writeHead(200, CORS_HEADERS).end();
      resolveResult({ access: directToken, expires: Date.now() + 864e5, loginUrl: "" });
      return;
    }
    const fingerprint = params.get("fingerprint");
    if (fingerprint) {
      try {
        const decoded = Buffer.from(fingerprint, "base64").toString();
        const fpToken = pickToken(new URL(decoded).searchParams);
        if (fpToken) {
          response.writeHead(200, CORS_HEADERS).end();
          resolveResult({ access: fpToken, expires: Date.now() + 864e5, loginUrl: "" });
          return;
        }
      } catch {
      }
    }
    const callbackSecret = params.get("secret");
    if (callbackSecret) {
      response.writeHead(200, CORS_HEADERS).end();
      void pollForCredential(ticketId, callbackSecret, options).then(
        (credential) => resolveResult({
          access: JSON.stringify(credential),
          expires: expiresFromCredential(credential),
          loginUrl: ""
        }),
        (error) => rejectResult(error)
      );
      return;
    }
    response.writeHead(400).end("Missing token or secret");
  });
  return new Promise((resolveStart, rejectStart) => {
    server.on("error", (error) => rejectStart(error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolveStart({ port, server, result });
    });
  });
}
async function runLoginFlow(options = {}) {
  const ticketId = randomUUID();
  const secret = generateRandomSecret();
  const { port, server, result } = await startCallbackServer(ticketId, secret, options);
  const { loginUrl } = buildLoginUrl(port, ticketId);
  try {
    const opener = options.openBrowser ?? openBrowser;
    await opener(loginUrl);
    const outcome = await result;
    return { ...outcome, loginUrl };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const PORTAL_AUTHORIZE_BASE = "https://codearts.huaweicloud.com/portal/authorize";
const PORTAL_LOGIN_BASE = "https://codearts.huaweicloud.com/portal/login";
function buildPortalLoginResultUrl(succeeded) {
  return `${PORTAL_LOGIN_BASE}?login_succeed=${succeeded}&uri_scheme=${CLIENT_ID}&locale=${OAUTH_LOCALE}`;
}
const LOGIN_PLUGIN_NAME = "snap_AIIDE";
const LOGIN_PLUGIN_VERSION = "5.2.0";
const OAUTH_THEME = "2";
const OAUTH_LOCALE = "zh-cn";
function buildOAuthLoginUrl(port, pkce, ticketId) {
  return `${PORTAL_AUTHORIZE_BASE}?theme=${OAUTH_THEME}&locale=${OAUTH_LOCALE}&uri_scheme=${CLIENT_ID}&client_id=${CLIENT_ID}&port=${port}&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256&ticket_id=${ticketId}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`;
}
function startOAuthCallbackServer(ticketId, pkce, keyPair, options) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${request.socket.localPort}`);
    if (url.pathname !== REDIRECT_PATH && !url.pathname.startsWith(REDIRECT_PATH)) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS).end();
      return;
    }
    const callbackSecret = url.searchParams.get("secret");
    if (callbackSecret) {
      const redirectTo = url.searchParams.get("redirect") ?? buildPortalLoginResultUrl(true);
      response.writeHead(307, { ...CORS_HEADERS, Location: redirectTo }).end();
      void pollForCredential(ticketId, callbackSecret, {
        ...options,
        pluginName: LOGIN_PLUGIN_NAME,
        pluginVersion: LOGIN_PLUGIN_VERSION
      }).then(
        (credential) => resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: "" }),
        (error) => rejectResult(error)
      );
      return;
    }
    const code = url.searchParams.get("code");
    if (code) {
      void exchangeAuthorizationCode(code, pkce.codeVerifier, request.socket.localPort ?? 0, keyPair, options.fetcher).then(
        (token) => {
          const credential = credentialFromTokenResponse(token, pkce, keyPair);
          response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(true) }).end();
          resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: "" });
        },
        (error) => {
          response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(false) }).end();
          rejectResult(error);
        }
      );
      return;
    }
    response.writeHead(400).end("Missing authorization code or secret");
  });
  return listenOnCallbackPort(server).then((port) => ({ port, server, result }));
}
const OAUTH_CALLBACK_TIMEOUT_MS = 18e4;
const MIN_CALLBACK_PORT = 1e4;
function listenOnCallbackPort(server) {
  return new Promise((resolve, reject) => {
    const tryListen = (port) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const assigned = typeof address === "object" && address ? address.port : 0;
        if (assigned >= MIN_CALLBACK_PORT) {
          resolve(assigned);
          return;
        }
        server.close(() => {
          const retry = Math.floor(Math.random() * (65536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT;
          tryListen(retry);
        });
      });
    };
    tryListen(0);
  });
}
async function startOAuthFlow(options = {}) {
  const ticketId = randomBytes(32).toString("hex");
  const pkce = generatePkcePair();
  const keyPair = await generateDpopKeyPair();
  const { port, server, result } = await startOAuthCallbackServer(ticketId, pkce, keyPair, options);
  const loginUrl = buildOAuthLoginUrl(port, pkce, ticketId);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(() => resolve()));
  };
  const resultWithUrl = Promise.race([
    result,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("CodeArts OAuth login timed out")), OAUTH_CALLBACK_TIMEOUT_MS);
      timer.unref?.();
    })
  ]).then((outcome) => ({ ...outcome, loginUrl }));
  resultWithUrl.catch(() => {
  }).finally(() => {
    void close();
  });
  return { loginUrl, result: resultWithUrl, close };
}
async function runOAuthFlow(options = {}) {
  const started = await startOAuthFlow(options);
  try {
    const opener = options.openBrowser ?? openBrowser;
    await opener(started.loginUrl);
    return await started.result;
  } finally {
    await started.close();
  }
}
export {
  CODEARTS_LOGIN_BASE,
  CREDENTIAL_ENDPOINT,
  HUAWEI_AUTH_BASE,
  LOGIN_PLUGIN_NAME,
  LOGIN_PLUGIN_VERSION,
  OAUTH_LOCALE,
  OAUTH_THEME,
  PORTAL_AUTHORIZE_BASE,
  PORTAL_LOGIN_BASE,
  buildLoginUrl,
  buildOAuthLoginUrl,
  buildPortalLoginResultUrl,
  expiresFromCredential,
  generateRandomSecret,
  openBrowser,
  parseCredentialResponse,
  pollForCredential,
  runLoginFlow,
  runOAuthFlow,
  startCallbackServer,
  startOAuthCallbackServer,
  startOAuthFlow
};
