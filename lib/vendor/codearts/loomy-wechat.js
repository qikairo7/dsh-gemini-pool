const LOOMY_WECHAT_APP_ID = "wx18d60be432287cf8";
const LOOMY_WECHAT_REDIRECT_URI = "https://loomy.xunfei.cn/oauth/wechat/callback";
const LOOMY_WECHAT_POLL_TIMEOUT_MS = 4e4;
const LOOMY_WECHAT_POLL_STATUS = Object.freeze({
  /** 408：等待扫码（常态）。 */
  waiting: "waiting",
  /** 404：已扫码，等待用户在手机上点确认。**继续轮询**。 */
  scanned: "scanned",
  /** 405：**已确认**，`wx_code` 就在这一帧。 */
  confirmed: "confirmed",
  /** 403：用户取消。 */
  cancelled: "cancelled",
  /** 402：二维码失效，需重新获取 uuid。 */
  expired: "expired",
  /** 网络/解析异常：调用方应继续轮询（瞬时不代表失败）。 */
  error: "error"
});
const WECHAT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UUID_PATTERN = /^[A-Za-z0-9_\-=+/]{6,64}$/;
function buildLoomyWechatAuthUrl(state) {
  return `https://open.weixin.qq.com/connect/qrconnect?appid=${encodeURIComponent(LOOMY_WECHAT_APP_ID)}&redirect_uri=${encodeURIComponent(LOOMY_WECHAT_REDIRECT_URI)}&response_type=code&scope=snsapi_login&state=${encodeURIComponent(state)}#wechat_redirect`;
}
function extractLoomyWechatUuid(html) {
  if (typeof html !== "string" || html.length === 0) return "";
  const fromImg = html.match(/\/connect\/qrcode\/([A-Za-z0-9_\-=+/]+)/);
  if (fromImg !== null) {
    const candidate = String(fromImg[1] ?? "");
    if (UUID_PATTERN.test(candidate)) return candidate;
  }
  const fromPoll = html.match(/l\/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)/);
  if (fromPoll !== null) {
    const candidate = String(fromPoll[1] ?? "");
    if (UUID_PATTERN.test(candidate)) return candidate;
  }
  return "";
}
function buildLoomyWechatQrImageUrl(uuid) {
  return `https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`;
}
async function fetchLoomyWechatUuid(state, fetcher = fetch) {
  const authUrl = buildLoomyWechatAuthUrl(state);
  let response;
  try {
    response = await fetcher(authUrl, {
      headers: { "User-Agent": WECHAT_UA, Referer: "https://open.weixin.qq.com/" },
      signal: AbortSignal.timeout(3e4)
    });
  } catch (error) {
    throw new Error(`\u5FAE\u4FE1\u6388\u6743\u9875\u62C9\u53D6\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`\u5FAE\u4FE1\u6388\u6743\u9875\u8FD4\u56DE HTTP ${response.status}`);
  }
  const html = await response.text();
  const uuid = extractLoomyWechatUuid(html);
  if (uuid.length === 0) {
    throw new Error("\u5FAE\u4FE1\u6388\u6743\u9875\u672A\u5305\u542B\u4E8C\u7EF4\u7801 uuid\uFF08\u9875\u9762\u7ED3\u6784\u53EF\u80FD\u5DF2\u53D8\u5316\uFF09");
  }
  return uuid;
}
async function fetchLoomyWechatQrImage(uuid, fetcher = fetch) {
  const url = buildLoomyWechatQrImageUrl(uuid);
  let response;
  try {
    response = await fetcher(url, {
      headers: { "User-Agent": WECHAT_UA, Referer: "https://open.weixin.qq.com/" },
      signal: AbortSignal.timeout(3e4)
    });
  } catch (error) {
    throw new Error(`\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u4E0B\u8F7D\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u8FD4\u56DE HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const mime = detectImageMime(bytes);
  if (mime === "" || bytes.length < 200) {
    throw new Error("\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u54CD\u5E94\u4E0D\u662F\u56FE\u7247\uFF08\u53EF\u80FD\u662F\u9519\u8BEF\u9875\uFF09");
  }
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}
function detectImageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return "image/gif";
  return "";
}
async function pollLoomyWechatOnce(uuid, lastErrcode, fetcher = fetch) {
  const query = `uuid=${encodeURIComponent(uuid)}` + (lastErrcode.length > 0 ? `&last=${encodeURIComponent(lastErrcode)}` : "") + `&_=${Date.now()}`;
  const url = `https://long.open.weixin.qq.com/connect/l/qrconnect?${query}`;
  let body;
  try {
    const response = await fetcher(url, {
      headers: { "User-Agent": WECHAT_UA, Referer: buildLoomyWechatAuthUrl("") },
      signal: AbortSignal.timeout(LOOMY_WECHAT_POLL_TIMEOUT_MS)
    });
    body = await response.text();
  } catch (error) {
    return {
      status: LOOMY_WECHAT_POLL_STATUS.error,
      code: "",
      errcode: error instanceof Error ? error.message : "network"
    };
  }
  const errcode = (body.match(/wx_errcode\s*=\s*(\d+)/) ?? [])[1] ?? "";
  const code = (body.match(/wx_code\s*=\s*'([^']*)'/) ?? [])[1] ?? "";
  if (errcode === "405") {
    return code.length > 0 ? { status: LOOMY_WECHAT_POLL_STATUS.confirmed, code, errcode } : { status: LOOMY_WECHAT_POLL_STATUS.scanned, code: "", errcode };
  }
  if (errcode === "404") return { status: LOOMY_WECHAT_POLL_STATUS.scanned, code: "", errcode };
  if (errcode === "403") return { status: LOOMY_WECHAT_POLL_STATUS.cancelled, code: "", errcode };
  if (errcode === "402") return { status: LOOMY_WECHAT_POLL_STATUS.expired, code: "", errcode };
  return { status: LOOMY_WECHAT_POLL_STATUS.waiting, code: "", errcode };
}
export {
  LOOMY_WECHAT_APP_ID,
  LOOMY_WECHAT_POLL_STATUS,
  LOOMY_WECHAT_POLL_TIMEOUT_MS,
  LOOMY_WECHAT_REDIRECT_URI,
  buildLoomyWechatAuthUrl,
  buildLoomyWechatQrImageUrl,
  extractLoomyWechatUuid,
  fetchLoomyWechatQrImage,
  fetchLoomyWechatUuid,
  pollLoomyWechatOnce
};
