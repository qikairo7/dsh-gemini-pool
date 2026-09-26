import { createServer } from "node:http";
import {
  RACCOON_LOGIN_TIMEOUT_MS
} from "./raccoon.js";
import {
  buildQrImageUrl,
  generateQrCode,
  loginRaccoonWithSmsCode,
  pollRaccoonQrLogin,
  sendRaccoonSmsCode
} from "./raccoon-oauth.js";
import { RACCOON } from "./raccoon-product.js";
import { renderQrSvg } from "./raccoon-qr.js";
const RACCOON_LOGIN_PAGE_PATHS = {
  login: "/raccoon/login",
  poll: "/raccoon/poll",
  smsSend: "/raccoon/sms/send",
  smsVerify: "/raccoon/sms/verify"
};
async function startRaccoonLoginFlow(options = {}) {
  const product = options.product ?? RACCOON;
  const fetcher = options.fetcher ?? fetch;
  const state = {
    qrCode: generateQrCode(),
    phone: "",
    lastExpiredAt: void 0
  };
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  result.catch(() => {
  });
  let settled = false;
  const settleOk = (value) => {
    if (settled) return;
    settled = true;
    resolveResult(value);
  };
  const settleErr = (error) => {
    if (settled) return;
    settled = true;
    rejectResult(error);
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, { state, product, fetcher, settleOk }).catch(
      (error) => {
        try {
          response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(`\u5185\u90E8\u9519\u8BEF\uFF1A${error instanceof Error ? error.message : String(error)}`);
        } catch {
        }
      }
    );
  });
  const port = await listenOnRandomPort(server);
  const loginUrl = `http://127.0.0.1:${port}${RACCOON_LOGIN_PAGE_PATHS.login}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    settleErr(new Error("raccoon: \u767B\u5F55\u6D41\u7A0B\u5DF2\u5173\u95ED"));
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  };
  const timeoutMs = options.timeoutMs ?? RACCOON_LOGIN_TIMEOUT_MS;
  const timer = setTimeout(() => {
    settleErr(new Error(`raccoon: \u767B\u5F55\u8D85\u65F6\uFF08${Math.round(timeoutMs / 1e3)} \u79D2\u5185\u672A\u5B8C\u6210\uFF09`));
  }, timeoutMs);
  timer.unref?.();
  void result.catch(() => {
  }).finally(() => {
    clearTimeout(timer);
    if (!closed) {
      closed = true;
      void new Promise((resolve) => {
        server.close(() => resolve());
      });
    }
  });
  return { loginUrl, result, close };
}
async function handleRequest(request, response, deps) {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${request.socket.localPort ?? 0}`);
  const { state, product } = deps;
  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.login) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(renderRaccoonLoginPage(product, state.qrCode));
    return;
  }
  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.poll) {
    const polled = await pollRaccoonQrLogin(product, state.qrCode, deps.fetcher);
    if (polled.status === "success" && polled.accessToken !== void 0) {
      const credential = {
        access_token: polled.accessToken,
        refresh_token: polled.refreshToken ?? "",
        ...polled.expiresAt !== void 0 ? { expires_at: polled.expiresAt } : {}
      };
      deps.settleOk(credential);
      writeJson(response, { status: "success" });
      return;
    }
    if (polled.expiredAt !== void 0) state.lastExpiredAt = polled.expiredAt;
    if (polled.status === "canceled") {
      state.qrCode = generateQrCode();
    }
    writeJson(response, {
      status: polled.status,
      ...polled.expiredAt !== void 0 ? { expiredAt: polled.expiredAt } : {},
      // code 变化时把新二维码给页面（页面据此换图）
      ...polled.status === "canceled" ? { qr: renderQrSvg(buildQrImageUrl(product, state.qrCode)) } : {}
    });
    return;
  }
  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.smsSend && request.method === "POST") {
    const body = await readJsonBody(request);
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    const captchaParam = typeof body.captchaParam === "string" ? body.captchaParam : "";
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, message: "\u8BF7\u8F93\u5165\u6709\u6548\u7684 11 \u4F4D\u624B\u673A\u53F7" }));
      return;
    }
    try {
      await sendRaccoonSmsCode(product, phone, captchaParam, deps.fetcher);
      state.phone = phone;
      writeJson(response, { ok: true });
    } catch (error) {
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }
  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.smsVerify && request.method === "POST") {
    const body = await readJsonBody(request);
    const smsCode = typeof body.smsCode === "string" ? body.smsCode.trim() : "";
    if (state.phone.length === 0) {
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, message: "\u8BF7\u5148\u83B7\u53D6\u624B\u673A\u9A8C\u8BC1\u7801" }));
      return;
    }
    if (smsCode.length === 0) {
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, message: "\u8BF7\u8F93\u5165\u9A8C\u8BC1\u7801" }));
      return;
    }
    try {
      const credential = await loginRaccoonWithSmsCode(product, state.phone, smsCode, deps.fetcher);
      deps.settleOk(credential);
      writeJson(response, { ok: true });
    } catch (error) {
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
}
function writeJson(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buf = chunk;
    total += buf.length;
    if (total > 64 * 1024) throw new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error("\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
}
function listenOnRandomPort(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      if (port === 0) {
        reject(new Error("raccoon: \u672C\u5730\u767B\u5F55\u9875\u670D\u52A1\u5668\u672A\u80FD\u83B7\u5F97\u7AEF\u53E3"));
        return;
      }
      resolve(port);
    });
  });
}
function renderRaccoonLoginPage(product, qrCode) {
  const code = qrCode ?? generateQrCode();
  const qrSvg = renderQrSvg(buildQrImageUrl(product, code), { size: 200 });
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raccoon Work \u767B\u5F55</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 20px 24px 24px; box-shadow: 0 4px 24px rgba(0,0,0,.08);
          text-align: center; width: 320px; }
  h1 { font-size: 16px; margin: 0 0 14px; font-weight: 600; }
  .tabs { display: flex; gap: 4px; background: #f2f3f5; border-radius: 8px; padding: 4px; margin-bottom: 16px; }
  .tabs button { flex: 1; padding: 7px; font-size: 13px; border: 0; border-radius: 6px;
                 background: transparent; color: #4e5969; cursor: pointer; }
  .tabs button[data-active="1"] { background: #fff; color: #1f2329; font-weight: 600;
                                  box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .pane { display: none; }
  .pane[data-show="1"] { display: block; }
  /* \u4E8C\u7EF4\u7801\u5BB9\u5668\uFF1ASVG \u81EA\u9002\u5E94\u586B\u5145\uFF08SVG \u81EA\u5E26 width/height \u4E0E viewBox\uFF09 */
  .qr { width: 200px; height: 200px; display: block; margin: 0 auto; border: 1px solid #eceef1;
        border-radius: 8px; padding: 6px; box-sizing: content-box; background: #fff; }
  .qr svg { display: block; width: 100%; height: 100%; }
  .sub { font-size: 12px; color: #8a9099; margin: 10px 0 0; }
  .status { margin-top: 12px; font-size: 13px; color: #4e5969; min-height: 20px; }
  .status[data-tone="ok"] { color: #0f9d58; font-weight: 600; }
  .status[data-tone="err"] { color: #d93026; }
  label { display: block; font-size: 12px; color: #8a9099; margin-bottom: 4px; text-align: left; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px; margin-bottom: 10px;
          border: 1px solid #d9dde3; border-radius: 6px; }
  button.primary { width: 100%; padding: 9px; font-size: 14px; border: 0; border-radius: 6px;
                   background: #8E6BF2; color: #fff; cursor: pointer; }
  button.primary:disabled { background: #c9cdd4; cursor: not-allowed; }
  .row { display: flex; gap: 8px; align-items: flex-start; }
  .row input { margin-bottom: 10px; }
  #captcha-element { margin-bottom: 10px; }
</style>
</head>
<body>
  <div class="card">
    <h1>\u767B\u5F55 Raccoon Work</h1>

    <div class="tabs">
      <button id="tabQr" data-active="1" type="button">\u5FAE\u4FE1\u626B\u7801</button>
      <button id="tabSms" data-active="0" type="button">\u77ED\u4FE1\u767B\u5F55</button>
    </div>

    <div class="pane" id="paneQr" data-show="1">
      <div class="qr" id="qrBox">${qrSvg}</div>
      <p class="sub">\u6253\u5F00\u5FAE\u4FE1\u626B\u4E00\u626B\uFF0C\u626B\u63CF\u4E0A\u65B9\u4E8C\u7EF4\u7801</p>
      <div class="status" id="qrStatus">\u7B49\u5F85\u626B\u7801\u2026</div>
    </div>

    <div class="pane" id="paneSms" data-show="0">
      <label for="phone">\u624B\u673A\u53F7</label>
      <div class="row">
        <input id="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="\u8BF7\u8F93\u5165 11 \u4F4D\u624B\u673A\u53F7">
        <button class="primary" id="sendCode" type="button" style="width:auto;white-space:nowrap;padding:9px 12px;">\u83B7\u53D6\u9A8C\u8BC1\u7801</button>
      </div>
      <div id="captcha-element"></div>
      <label for="smsCode">\u9A8C\u8BC1\u7801</label>
      <input id="smsCode" type="text" inputmode="numeric" maxlength="6" placeholder="\u8BF7\u8F93\u5165 6 \u4F4D\u9A8C\u8BC1\u7801">
      <button class="primary" id="doLogin" type="button">\u767B\u5F55</button>
      <div class="status" id="smsStatus"></div>
    </div>
  </div>

<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
<script>
(function () {
  'use strict';
  var POLL_INTERVAL_MS = 2000;
  var paths = ${JSON.stringify(RACCOON_LOGIN_PAGE_PATHS)};

  // \u2500\u2500 Tab \u5207\u6362 \u2500\u2500
  var tabQr = document.getElementById('tabQr');
  var tabSms = document.getElementById('tabSms');
  var paneQr = document.getElementById('paneQr');
  var paneSms = document.getElementById('paneSms');
  function selectTab(sms) {
    tabQr.setAttribute('data-active', sms ? '0' : '1');
    tabSms.setAttribute('data-active', sms ? '1' : '0');
    paneQr.setAttribute('data-show', sms ? '0' : '1');
    paneSms.setAttribute('data-show', sms ? '1' : '0');
  }
  tabQr.addEventListener('click', function () { selectTab(false); });
  tabSms.addEventListener('click', function () { selectTab(true); });

  // \u2500\u2500 \u626B\u7801\u8F6E\u8BE2 \u2500\u2500
  var qrStatus = document.getElementById('qrStatus');
  var qrBox = document.getElementById('qrBox');
  var pollTimer = null;
  function setQrStatus(text, tone) {
    qrStatus.textContent = text;
    if (tone) { qrStatus.setAttribute('data-tone', tone); } else { qrStatus.removeAttribute('data-tone'); }
  }
  function pollOnce() {
    fetch(paths.poll).then(function (r) { return r.json(); }).then(function (data) {
      if (data.status === 'success') {
        setQrStatus('\u767B\u5F55\u6210\u529F\uFF0C\u53EF\u4EE5\u5173\u95ED\u6B64\u7A97\u53E3\u4E86', 'ok');
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        setTimeout(function () { window.close(); }, 1200);
        return;
      }
      if (data.status === 'logging') { setQrStatus('\u5DF2\u626B\u7801\uFF0C\u8BF7\u5728\u5FAE\u4FE1\u4E2D\u786E\u8BA4\u2026'); return; }
      if (data.status === 'canceled') {
        if (data.qr) { qrBox.innerHTML = data.qr; }
        setQrStatus('\u4E8C\u7EF4\u7801\u5DF2\u5237\u65B0\uFF0C\u8BF7\u91CD\u65B0\u626B\u7801');
        return;
      }
      setQrStatus('\u7B49\u5F85\u626B\u7801\u2026');
    }).catch(function () {
      // \u8F6E\u8BE2\u5076\u53D1\u5931\u8D25\u4E0D\u6253\u65AD\uFF08\u4E0B\u4E00\u6B21\u7EE7\u7EED\uFF09
    });
  }
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  pollOnce();

  // \u2500\u2500 \u77ED\u4FE1\u767B\u5F55 \u2500\u2500
  var smsStatus = document.getElementById('smsStatus');
  var phoneInput = document.getElementById('phone');
  var smsCodeInput = document.getElementById('smsCode');
  var sendBtn = document.getElementById('sendCode');
  var loginBtn = document.getElementById('doLogin');
  var captchaInstance = null;
  var pendingCaptcha = null;

  function setSmsStatus(text, tone) {
    smsStatus.textContent = text || '';
    if (tone) { smsStatus.setAttribute('data-tone', tone); } else { smsStatus.removeAttribute('data-tone'); }
  }

  function submitSmsSend(captchaParam) {
    var phone = (phoneInput.value || '').trim();
    if (!/^1[3-9]\\d{9}$/.test(phone)) {
      setSmsStatus('\u8BF7\u8F93\u5165\u6709\u6548\u7684 11 \u4F4D\u624B\u673A\u53F7', 'err');
      return;
    }
    sendBtn.disabled = true;
    setSmsStatus('\u53D1\u9001\u4E2D\u2026');
    fetch(paths.smsSend, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone, captchaParam: captchaParam || '' })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok) { setSmsStatus('\u9A8C\u8BC1\u7801\u5DF2\u53D1\u9001\uFF0C\u8BF7\u67E5\u6536\u77ED\u4FE1', 'ok'); }
      else { setSmsStatus((data && data.message) || '\u53D1\u9001\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5', 'err'); }
    }).catch(function () {
      setSmsStatus('\u53D1\u9001\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5', 'err');
    }).finally(function () {
      sendBtn.disabled = false;
    });
  }

  // \u963F\u91CC\u4E91\u6ED1\u5757\uFF1A\u771F\u5B9E\u52A0\u8F7D\u5B98\u65B9\u811A\u672C\uFF08SceneId / prefix \u6765\u81EA\u5BA2\u6237\u7AEF\u914D\u7F6E\uFF09\u3002
  function initCaptcha() {
    if (typeof window.initAliyunCaptcha !== 'function') { return false; }
    window.initAliyunCaptcha({
      SceneId: '${product.aliyunCaptcha.sceneId}',
      prefix: '${product.aliyunCaptcha.prefix}',
      mode: 'popup',
      element: '#captcha-element',
      button: '#sendCode',
      captchaVerifyCallback: function (captchaParam) {
        pendingCaptcha = captchaParam;
        submitSmsSend(captchaParam);
        return { captchaResult: true, bizResult: true };
      },
      onBizResultCallback: function () { return null; },
      getInstance: function (instance) { captchaInstance = instance; return null; },
      slideStyle: { width: 320, height: 40 },
      language: 'cn'
    });
    return true;
  }
  var captchaReady = initCaptcha();
  sendBtn.addEventListener('click', function () {
    if (!captchaReady) { captchaReady = initCaptcha(); }
    if (!captchaReady) {
      // \u811A\u672C\u672A\u52A0\u8F7D\uFF08\u79BB\u7EBF/\u88AB\u62E6\u622A\uFF09\uFF1A\u9000\u5316\u4E3A\u76F4\u63A5\u63D0\u4EA4\uFF0C\u8BA9\u670D\u52A1\u7AEF\u62A5\u660E\u786E\u539F\u56E0
      // \uFF08\u5B9E\u6D4B\u4F1A\u56DE captcha_verify_error\uFF0C\u9875\u9762\u636E\u6B64\u63D0\u793A\u7528\u6237\uFF09\u3002
      setSmsStatus('\u9A8C\u8BC1\u7801\u7EC4\u4EF6\u672A\u52A0\u8F7D\uFF0C\u6B63\u5728\u5C1D\u8BD5\u76F4\u63A5\u53D1\u9001\u2026');
      submitSmsSend('');
    }
  });

  loginBtn.addEventListener('click', function () {
    var code = (smsCodeInput.value || '').trim();
    if (!code) { setSmsStatus('\u8BF7\u8F93\u5165\u9A8C\u8BC1\u7801', 'err'); return; }
    loginBtn.disabled = true;
    setSmsStatus('\u767B\u5F55\u4E2D\u2026');
    fetch(paths.smsVerify, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: code })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok) {
        setSmsStatus('\u767B\u5F55\u6210\u529F\uFF0C\u53EF\u4EE5\u5173\u95ED\u6B64\u7A97\u53E3\u4E86', 'ok');
        setTimeout(function () { window.close(); }, 1200);
      } else {
        setSmsStatus((data && data.message) || '\u9A8C\u8BC1\u7801\u4E0D\u6B63\u786E\uFF0C\u8BF7\u91CD\u8BD5', 'err');
      }
    }).catch(function () {
      setSmsStatus('\u767B\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5', 'err');
    }).finally(function () {
      loginBtn.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;
}
export {
  RACCOON_LOGIN_PAGE_PATHS,
  renderRaccoonLoginPage,
  startRaccoonLoginFlow
};
