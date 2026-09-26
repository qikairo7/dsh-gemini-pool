import {
  QODER_LOGIN_TIMEOUT_MS,
  QODER_POLL_INTERVAL_MS,
  QODER_POLL_MAX_FAILURES,
  buildQoderAuthUrl,
  buildQoderCredential,
  buildQoderPollUrl,
  createQoderDeviceSession,
  isQoderRefreshable,
  parseQoderTokenPayload,
  qoderCredentialExpiresAtMs
} from "./qoder.js";
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
const SERVER_ERROR_PREFIX = "\u767B\u5F55\u670D\u52A1\u8FD4\u56DE\u5F02\u5E38";
function isAborted(signal) {
  return signal?.aborted === true;
}
async function pollQoderDeviceToken(session, options) {
  const fetcher = options.fetcher ?? fetch;
  const pollUrl = buildQoderPollUrl(session, options.product);
  const interval = options.pollIntervalMs ?? QODER_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? QODER_LOGIN_TIMEOUT_MS);
  let failures = 0;
  while (Date.now() < deadline) {
    if (isAborted(options.signal)) throw new Error("\u767B\u5F55\u5DF2\u53D6\u6D88");
    try {
      const response = await fetcher(pollUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        ...options.signal === void 0 ? {} : { signal: options.signal }
      });
      failures = 0;
      if (response.status === 404) {
        await sleep(interval, options.signal);
        continue;
      }
      if (!response.ok) {
        throw new Error(`${SERVER_ERROR_PREFIX}\uFF08HTTP ${response.status}\uFF09`);
      }
      const payload = parseQoderTokenPayload(await response.json());
      if (payload.accessToken.length > 0) return payload;
      await sleep(interval, options.signal);
    } catch (error) {
      if (isAborted(options.signal)) throw new Error("\u767B\u5F55\u5DF2\u53D6\u6D88");
      if (error instanceof Error && error.message.startsWith(SERVER_ERROR_PREFIX)) throw error;
      failures += 1;
      if (failures >= QODER_POLL_MAX_FAILURES) {
        throw new Error(
          `\u65E0\u6CD5\u8FDE\u63A5 Qoder \u767B\u5F55\u670D\u52A1\uFF08\u8FDE\u7EED ${failures} \u6B21\u5931\u8D25\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`
        );
      }
      await sleep(interval, options.signal);
    }
  }
  throw new Error("\u767B\u5F55\u7B49\u5F85\u5DF2\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u767B\u5F55");
}
function toLoginFlowResult(credential, loginUrl, machineId) {
  return {
    access: JSON.stringify(credential),
    // 与其它 provider 一致：无法解析过期时间时报 0，而不是抛错 ——
    // 凭据本身可用（只是有效期未知），不该因展示层缺失而登录失败。
    expires: qoderCredentialExpiresAtMs(credential) ?? 0,
    loginUrl,
    refreshable: isQoderRefreshable(credential),
    machineId
  };
}
async function defaultOpenBrowser(url) {
  const { openBrowser } = await import("./login.js");
  openBrowser(url);
}
async function startQoderLoginFlow(options) {
  const session = createQoderDeviceSession();
  const loginUrl = buildQoderAuthUrl(session, options.product);
  const controller = new AbortController();
  const signal = options.signal === void 0 ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  const result = (async () => {
    const payload = await pollQoderDeviceToken(session, { ...options, signal });
    if (payload.accessToken.length === 0) {
      throw new Error("\u767B\u5F55\u54CD\u5E94\u7F3A\u5C11\u8BBF\u95EE\u4EE4\u724C");
    }
    const credential = buildQoderCredential(payload, { machineId: session.machineId });
    return toLoginFlowResult(credential, loginUrl, session.machineId);
  })();
  result.catch(() => {
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
  };
  return { loginUrl, result, close };
}
async function runQoderLoginFlow(options) {
  const open = options.openBrowser ?? defaultOpenBrowser;
  const started = await startQoderLoginFlow(options);
  try {
    await open(started.loginUrl);
    return await started.result;
  } finally {
    await started.close();
  }
}
export {
  pollQoderDeviceToken,
  runQoderLoginFlow,
  startQoderLoginFlow
};
