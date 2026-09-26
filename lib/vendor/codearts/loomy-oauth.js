import { randomUUID } from "node:crypto";
import { LOOMY_REQUEST_TIMEOUT_MS, parseLoomyEnvelope } from "./loomy.js";
import { loomyAuthHeaders } from "./loomy-sign.js";
const LOOMY_SMS_CODE_TTL_SECONDS = 300;
const LOOMY_SESSION_TTL_SECONDS = 1209600;
function buildLoomyAccountBody(product, param) {
  return {
    base: {
      appid: product.appId,
      modelid: "Web",
      version: "1.0.0",
      devid: "web",
      // ⚠️ 硬编码 macOS：客户端在 Windows 上发的也是这个值，照抄不要改。
      ua: "Loomy|Desktop|Electron|macOS",
      traceid: randomUUID().replace(/-/g, "")
    },
    param
  };
}
async function postLoomyAccount(path, body, product, fetcher) {
  const serialized = JSON.stringify(body);
  const headers = loomyAuthHeaders({
    accessKeyId: product.accessKeyId,
    accessKeySecret: product.accessKeySecret,
    method: "POST",
    path,
    body: serialized,
    contentType: "application/json"
  });
  let response;
  try {
    response = await fetcher(`${product.accountBase}${path}`, {
      method: "POST",
      headers,
      body: serialized,
      signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(
      `\u8BAF\u98DE\u8D26\u53F7\u8BF7\u6C42\u5931\u8D25\uFF08${path}\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`\u8BAF\u98DE\u8D26\u53F7\u54CD\u5E94\u4E0D\u662F JSON\uFF08${path}\uFF0CHTTP ${response.status}\uFF09`);
  }
  const envelope = parseLoomyEnvelope(parsed);
  if (!envelope.ok) {
    throw new Error(envelope.message.length > 0 ? envelope.message : `\u8BAF\u98DE\u8D26\u53F7\u8BF7\u6C42\u5931\u8D25\uFF08${path}\uFF09`);
  }
  return envelope.data;
}
async function sendLoomySmsCode(phone, product, fetcher = fetch) {
  const body = buildLoomyAccountBody(product, {
    ccode: "86",
    phone,
    expire: LOOMY_SMS_CODE_TTL_SECONDS
  });
  const data = await postLoomyAccount("/login/phone/sendMsgCode", body, product, fetcher);
  const msgid = typeof data?.msgid === "string" ? String(data.msgid) : "";
  if (msgid.length === 0) {
    throw new Error("\u77ED\u4FE1\u9A8C\u8BC1\u7801\u54CD\u5E94\u7F3A\u5C11 msgid");
  }
  return msgid;
}
async function loginLoomyBySmsCode(phone, code, msgid, product, fetcher = fetch) {
  const body = buildLoomyAccountBody(product, {
    ccode: "86",
    phone,
    mcode: code,
    msgid,
    expire: LOOMY_SESSION_TTL_SECONDS
  });
  const data = await postLoomyAccount("/login/phone/checkCode", body, product, fetcher);
  const record = data ?? {};
  const session = typeof record.session === "string" ? record.session : "";
  const userid = typeof record.userid === "string" ? record.userid : "";
  if (session.length === 0) throw new Error("\u767B\u5F55\u54CD\u5E94\u7F3A\u5C11 session");
  if (userid.length === 0) throw new Error("\u767B\u5F55\u54CD\u5E94\u7F3A\u5C11 userid");
  return { session, userid };
}
async function bindLoomyThirdAccount(code, product, fetcher = fetch) {
  const body = buildLoomyAccountBody(product, {
    tcode: { code },
    type: "wx"
  });
  const data = await postLoomyAccount("/login/thirdAccount/bind/auth", body, product, fetcher);
  const record = data ?? {};
  const rcode = typeof record.rcode === "string" ? record.rcode : "";
  if (rcode.length === 0) {
    throw new Error("\u5FAE\u4FE1\u6388\u6743\u54CD\u5E94\u7F3A\u5C11 rcode");
  }
  const bind = record.bind === 1 ? 1 : 0;
  return {
    bind,
    rcode,
    ...typeof record.isnew === "number" ? { isnew: record.isnew } : {},
    ...typeof record.nickname === "string" && record.nickname.length > 0 ? { nickname: record.nickname } : {},
    ...typeof record.headpic === "string" && record.headpic.length > 0 ? { headpic: record.headpic } : {}
  };
}
async function bindLoomySendMsg(rcode, phone, product, fetcher = fetch) {
  const body = buildLoomyAccountBody(product, {
    rcode,
    phone,
    ccode: "86",
    expire: LOOMY_SMS_CODE_TTL_SECONDS
  });
  const data = await postLoomyAccount("/login/thirdAccount/bind/sendMsg", body, product, fetcher);
  const msgid = typeof data?.msgid === "string" ? String(data.msgid) : "";
  if (msgid.length === 0) throw new Error("\u7ED1\u5B9A\u624B\u673A\u53F7\u54CD\u5E94\u7F3A\u5C11 msgid");
  return msgid;
}
async function bindLoomyCheckCode(rcode, mcode, msgid, product, fetcher = fetch) {
  const body = buildLoomyAccountBody(product, {
    rcode,
    mcode,
    msgid,
    expire: LOOMY_SESSION_TTL_SECONDS
  });
  const data = await postLoomyAccount("/login/thirdAccount/bind/checkCode", body, product, fetcher);
  const record = data ?? {};
  const session = typeof record.session === "string" ? record.session : "";
  const userid = typeof record.userid === "string" ? record.userid : "";
  const phone = typeof record.phone === "string" ? record.phone : "";
  if (session.length === 0) throw new Error("\u7ED1\u5B9A\u767B\u5F55\u54CD\u5E94\u7F3A\u5C11 session");
  if (userid.length === 0) throw new Error("\u7ED1\u5B9A\u767B\u5F55\u54CD\u5E94\u7F3A\u5C11 userid");
  return { session, userid, phone };
}
async function bindLoomySkip(rcode, product, fetcher = fetch) {
  const body = buildLoomyAccountBody(product, {
    rcode,
    expire: LOOMY_SESSION_TTL_SECONDS
  });
  const data = await postLoomyAccount("/login/thirdAccount/bind/skip", body, product, fetcher);
  const record = data ?? {};
  const session = typeof record.session === "string" ? record.session : "";
  const userid = typeof record.userid === "string" ? record.userid : "";
  if (session.length === 0) throw new Error("\u5FAE\u4FE1\u767B\u5F55\u54CD\u5E94\u7F3A\u5C11 session");
  if (userid.length === 0) throw new Error("\u5FAE\u4FE1\u767B\u5F55\u54CD\u5E94\u7F3A\u5C11 userid");
  return { session, userid };
}
export {
  LOOMY_SESSION_TTL_SECONDS,
  LOOMY_SMS_CODE_TTL_SECONDS,
  bindLoomyCheckCode,
  bindLoomySendMsg,
  bindLoomySkip,
  bindLoomyThirdAccount,
  buildLoomyAccountBody,
  loginLoomyBySmsCode,
  sendLoomySmsCode
};
