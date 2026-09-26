import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  LOOMY_WECHAT_POLL_STATUS,
  fetchLoomyWechatQrImage,
  fetchLoomyWechatUuid,
  pollLoomyWechatOnce
} from "./loomy-wechat.js";
import {
  bindLoomyCheckCode,
  bindLoomySendMsg,
  bindLoomySkip,
  bindLoomyThirdAccount
} from "./loomy-oauth.js";
function resolveOpenCommand(platform) {
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  if (platform === "darwin") return { command: "open", args: [] };
  return { command: "xdg-open", args: [] };
}
const LOOMY_WECHAT_LOGIN_TIMEOUT_MS = 5 * 60 * 1e3;
const LOOMY_WECHAT_QR_PATH = "/wechat/qr";
const LOOMY_WECHAT_POLL_PATH = "/wechat/poll";
const LOOMY_WECHAT_COMPLETE_PATH = "/wechat/complete";
async function startLoomyWechatLoginFlow(options) {
  const fetcher = options.fetcher ?? fetch;
  const product = options.product;
  const state = {
    uuid: "",
    lastErrcode: "",
    wechatCode: "",
    rcode: "",
    bind: 0,
    nickname: "",
    bindMsgid: ""
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
  state.uuid = await fetchLoomyWechatUuid(randomUUID(), fetcher);
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      state,
      product,
      fetcher,
      settleOk,
      settleErr
    }).catch((error) => {
      try {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(`\u5185\u90E8\u9519\u8BEF\uFF1A${error instanceof Error ? error.message : String(error)}`);
      } catch {
      }
    });
  });
  const port = await listenOnRandomPort(server);
  const loginUrl = `http://127.0.0.1:${port}${LOOMY_WECHAT_QR_PATH}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(() => resolve()));
  };
  const timeoutMs = options.timeoutMs ?? LOOMY_WECHAT_LOGIN_TIMEOUT_MS;
  const timer = setTimeout(() => {
    settleErr(new Error(`Loomy \u5FAE\u4FE1\u767B\u5F55\u8D85\u65F6\uFF08${Math.round(timeoutMs / 1e3)} \u79D2\u5185\u672A\u5B8C\u6210\uFF09`));
  }, timeoutMs);
  timer.unref?.();
  result.catch(() => {
  }).finally(() => {
    clearTimeout(timer);
    void close();
  });
  return { loginUrl, result, close };
}
async function handleRequest(request, response, deps) {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${request.socket.localPort ?? 0}`);
  const { state } = deps;
  if (url.pathname === LOOMY_WECHAT_QR_PATH) {
    const qrDataUrl = await fetchLoomyWechatQrImage(state.uuid, deps.fetcher);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(renderQrPage(qrDataUrl));
    return;
  }
  if (url.pathname === LOOMY_WECHAT_POLL_PATH) {
    if (state.wechatCode.length > 0) {
      writeJson(response, { status: LOOMY_WECHAT_POLL_STATUS.confirmed });
      return;
    }
    const polled = await pollLoomyWechatOnce(state.uuid, state.lastErrcode, deps.fetcher);
    if (polled.errcode.length > 0) state.lastErrcode = polled.errcode;
    if (polled.status === LOOMY_WECHAT_POLL_STATUS.confirmed && polled.code.length > 0) {
      state.wechatCode = polled.code;
      try {
        const auth = await bindLoomyThirdAccount(polled.code, deps.product, deps.fetcher);
        state.rcode = auth.rcode;
        state.bind = auth.bind;
        state.nickname = auth.nickname ?? "";
        if (auth.bind === 1) {
          const login = await bindLoomySkip(auth.rcode, deps.product, deps.fetcher);
          deps.settleOk({ ...login, phone: "", ...state.nickname.length > 0 ? { nickname: state.nickname } : {} });
          writeJson(response, { status: "done", message: "\u767B\u5F55\u6210\u529F\uFF0C\u53EF\u4EE5\u5173\u95ED\u6B64\u7A97\u53E3\u4E86" });
          return;
        }
        writeJson(response, { status: "need_phone" });
        return;
      } catch (error) {
        deps.settleErr(error);
        writeJson(response, { status: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    writeJson(response, { status: polled.status });
    return;
  }
  if (url.pathname === LOOMY_WECHAT_COMPLETE_PATH && request.method === "POST") {
    const body = await readJsonBody(request);
    const action = typeof body.action === "string" ? body.action : "";
    try {
      if (action === "send_sms") {
        const phone = String(body.phone ?? "");
        state.bindMsgid = await bindLoomySendMsg(state.rcode, phone, deps.product, deps.fetcher);
        writeJson(response, { ok: true });
        return;
      }
      if (action === "verify_sms") {
        const phone = String(body.phone ?? "");
        const code = String(body.code ?? "");
        const login = await bindLoomyCheckCode(
          state.rcode,
          code,
          state.bindMsgid,
          deps.product,
          deps.fetcher
        );
        deps.settleOk({
          session: login.session,
          userid: login.userid,
          phone: login.phone.length > 0 ? login.phone : phone,
          ...state.nickname.length > 0 ? { nickname: state.nickname } : {}
        });
        writeJson(response, { ok: true, done: true });
        return;
      }
      writeJson(response, { ok: false, message: `\u672A\u77E5 action: ${action}` });
    } catch (error) {
      writeJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) });
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
        reject(new Error("Loomy \u5FAE\u4FE1\u767B\u5F55\u670D\u52A1\u5668\u672A\u80FD\u83B7\u5F97\u7AEF\u53E3"));
        return;
      }
      resolve(port);
    });
  });
}
function renderQrPage(qrDataUrl) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loomy \u5FAE\u4FE1\u767B\u5F55</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 28px 32px; box-shadow: 0 4px 24px rgba(0,0,0,.08);
          text-align: center; width: 320px; }
  h1 { font-size: 17px; margin: 0 0 4px; font-weight: 600; }
  .sub { font-size: 13px; color: #8a9099; margin-bottom: 18px; }
  .qr { width: 220px; height: 220px; display: block; margin: 0 auto; border: 1px solid #eceef1; border-radius: 8px; }
  .status { margin-top: 16px; font-size: 13px; color: #4e5969; min-height: 20px; }
  .status[data-tone="ok"] { color: #0f9d58; font-weight: 600; }
  .status[data-tone="err"] { color: #d93026; }
  .form { display: none; margin-top: 18px; text-align: left; }
  .form[data-show="1"] { display: block; }
  .form label { display: block; font-size: 12px; color: #8a9099; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px; margin-bottom: 10px;
          border: 1px solid #d9dde3; border-radius: 6px; }
  button { width: 100%; padding: 9px; font-size: 14px; border: 0; border-radius: 6px;
           background: #07c160; color: #fff; cursor: pointer; }
  button:disabled { background: #c9cdd4; cursor: not-allowed; }
  button.ghost { background: #f2f3f5; color: #1f2329; margin-top: 8px; }
  .row { display: flex; gap: 8px; }
  .row input { margin-bottom: 10px; }
  .row button { width: auto; white-space: nowrap; padding: 8px 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>\u4F7F\u7528\u5FAE\u4FE1\u626B\u7801\u767B\u5F55 Loomy</h1>
    <div class="sub">\u6253\u5F00\u5FAE\u4FE1\u626B\u4E00\u626B\uFF0C\u626B\u63CF\u4E0B\u65B9\u4E8C\u7EF4\u7801</div>
    <img class="qr" id="qr" alt="\u5FAE\u4FE1\u767B\u5F55\u4E8C\u7EF4\u7801" src="${qrDataUrl}">
    <div class="status" id="status">\u7B49\u5F85\u626B\u7801\u2026</div>

    <div class="form" id="phoneForm">
      <label for="phone">\u9996\u6B21\u4F7F\u7528\u9700\u7ED1\u5B9A\u624B\u673A\u53F7</label>
      <div class="row">
        <input id="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="\u624B\u673A\u53F7">
        <button id="sendBtn" type="button">\u83B7\u53D6\u9A8C\u8BC1\u7801</button>
      </div>
      <input id="code" type="text" inputmode="numeric" maxlength="6" placeholder="\u77ED\u4FE1\u9A8C\u8BC1\u7801">
      <button id="verifyBtn" type="button">\u5B8C\u6210\u7ED1\u5B9A\u5E76\u767B\u5F55</button>
    </div>
  </div>

<script>
(function () {
  var statusEl = document.getElementById('status');
  var formEl = document.getElementById('phoneForm');
  var phoneEl = document.getElementById('phone');
  var codeEl = document.getElementById('code');
  var sendBtn = document.getElementById('sendBtn');
  var verifyBtn = document.getElementById('verifyBtn');
  var stopped = false;

  function setStatus(text, tone) {
    statusEl.textContent = text;
    if (tone) statusEl.setAttribute('data-tone', tone);
    else statusEl.removeAttribute('data-tone');
  }

  function post(payload) {
    return fetch('${LOOMY_WECHAT_COMPLETE_PATH}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); });
  }

  // \u8F6E\u8BE2\u5FAA\u73AF\uFF1A408/405 \u7EE7\u7EED\uFF1Bneed_phone \u5207\u5230\u7ED1\u5B9A\u8868\u5355\uFF1Bdone \u505C\u6B62\u3002
  function poll() {
    if (stopped) return;
    fetch('${LOOMY_WECHAT_POLL_PATH}')
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.status === 'done') {
          stopped = true;
          setStatus(res.message || '\u767B\u5F55\u6210\u529F\uFF0C\u53EF\u4EE5\u5173\u95ED\u6B64\u7A97\u53E3\u4E86', 'ok');
          formEl.setAttribute('data-show', '0');
          return;
        }
        if (res.status === 'need_phone') {
          stopped = true;
          setStatus('\u5DF2\u626B\u7801\uFF0C\u8BF7\u7ED1\u5B9A\u624B\u673A\u53F7');
          formEl.setAttribute('data-show', '1');
          return;
        }
        if (res.status === 'expired') {
          stopped = true;
          setStatus('\u4E8C\u7EF4\u7801\u5DF2\u5931\u6548\uFF0C\u8BF7\u5173\u95ED\u7A97\u53E3\u540E\u91CD\u8BD5', 'err');
          return;
        }
        if (res.status === 'cancelled') {
          stopped = true;
          setStatus('\u4F60\u5DF2\u53D6\u6D88\u6388\u6743\uFF0C\u8BF7\u5173\u95ED\u7A97\u53E3\u540E\u91CD\u8BD5', 'err');
          return;
        }
        if (res.status === 'error') {
          setStatus(res.message || '\u5FAE\u4FE1\u6388\u6743\u5931\u8D25', 'err');
          stopped = true;
          return;
        }
        // \u26A0\uFE0F scanned\uFF08404\uFF09\u53EA\u662F\u300C\u5DF2\u626B\u7801\u5F85\u786E\u8BA4\u300D\uFF0C**\u5FC5\u987B\u7EE7\u7EED\u8F6E\u8BE2**\u7B49 405\u3002
        // \u65E9\u671F\u628A 404/405 \u8BFB\u53CD\uFF0C\u5BFC\u81F4\u6B64\u5904\u6C38\u8FDC\u505C\u5728\u300C\u5DF2\u626B\u7801\uFF0C\u8BF7\u5728\u624B\u673A\u4E0A\u786E\u8BA4\u300D\u3002
        if (res.status === 'scanned') setStatus('\u5DF2\u626B\u7801\uFF0C\u8BF7\u5728\u624B\u673A\u4E0A\u786E\u8BA4');
        else setStatus('\u7B49\u5F85\u626B\u7801\u2026');
        setTimeout(poll, 1200);
      })
      .catch(function () {
        // \u7F51\u7EDC\u6296\u52A8\u4E0D\u7EC8\u6B62\u8F6E\u8BE2\uFF08\u957F\u8F6E\u8BE2\u5076\u53D1\u5931\u8D25\u662F\u5E38\u6001\uFF09\u3002
        setTimeout(poll, 2000);
      });
  }

  sendBtn.addEventListener('click', function () {
    var phone = (phoneEl.value || '').replace(/\\D/g, '');
    if (phone.length !== 11) { setStatus('\u8BF7\u8F93\u5165 11 \u4F4D\u624B\u673A\u53F7', 'err'); return; }
    sendBtn.disabled = true;
    setStatus('\u6B63\u5728\u53D1\u9001\u9A8C\u8BC1\u7801\u2026');
    post({ action: 'send_sms', phone: phone })
      .then(function (res) {
        if (res.ok) setStatus('\u9A8C\u8BC1\u7801\u5DF2\u53D1\u9001\u81F3 ' + phone);
        else setStatus(res.message || '\u53D1\u9001\u5931\u8D25', 'err');
      })
      .catch(function () { setStatus('\u53D1\u9001\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5', 'err'); })
      .finally(function () { sendBtn.disabled = false; });
  });

  verifyBtn.addEventListener('click', function () {
    var phone = (phoneEl.value || '').replace(/\\D/g, '');
    var code = (codeEl.value || '').replace(/\\D/g, '');
    if (phone.length !== 11) { setStatus('\u8BF7\u8F93\u5165 11 \u4F4D\u624B\u673A\u53F7', 'err'); return; }
    if (code.length === 0) { setStatus('\u8BF7\u8F93\u5165\u77ED\u4FE1\u9A8C\u8BC1\u7801', 'err'); return; }
    verifyBtn.disabled = true;
    setStatus('\u6B63\u5728\u5B8C\u6210\u7ED1\u5B9A\u2026');
    post({ action: 'verify_sms', phone: phone, code: code })
      .then(function (res) {
        if (res.ok && res.done) setStatus('\u767B\u5F55\u6210\u529F\uFF0C\u53EF\u4EE5\u5173\u95ED\u6B64\u7A97\u53E3\u4E86', 'ok');
        else setStatus(res.message || '\u9A8C\u8BC1\u7801\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5', 'err');
      })
      .catch(function () { setStatus('\u7ED1\u5B9A\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5', 'err'); })
      .finally(function () { verifyBtn.disabled = false; });
  });

  poll();
})();
</script>
</body>
</html>`;
}
export {
  LOOMY_WECHAT_COMPLETE_PATH,
  LOOMY_WECHAT_LOGIN_TIMEOUT_MS,
  LOOMY_WECHAT_POLL_PATH,
  LOOMY_WECHAT_QR_PATH,
  resolveOpenCommand,
  startLoomyWechatLoginFlow
};
