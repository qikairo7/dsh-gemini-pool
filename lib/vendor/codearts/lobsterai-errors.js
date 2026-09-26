const LOBSTERAI_HARD_CREDIT_MARKERS = [
  "insufficient credit",
  "no credit",
  "credit exhausted",
  "out of credit",
  "quota exceeded",
  "quota exhaust",
  "payment required",
  "credit not enough",
  "not enough credit",
  "freecreditsused",
  "free credits used",
  // 2026-09 补充（真实缺陷，用户报障）：额度耗尽的**实际文案**是
  // 「免费额度已用完，请升级套餐」，而早期表里只有「额度用尽」「积分用完」
  // ——「已用完」与「用尽」字面不同，于是这个最主要的失败模式判成 `none`
  // （不换号、不记徽章），用户看到「一个账号用完出错但没有切换」。
  // 英文侧同理补上同类文案。
  "free quota",
  "quota used up",
  "upgrade your plan",
  "upgrade to continue",
  "\u79EF\u5206\u4E0D\u8DB3",
  "\u989D\u5EA6\u4E0D\u8DB3",
  "\u4F59\u989D\u4E0D\u8DB3",
  "\u79EF\u5206\u7528\u5B8C",
  "\u989D\u5EA6\u7528\u5C3D",
  "\u6CA1\u6709\u79EF\u5206",
  "\u79EF\u5206\u8017\u5C3D",
  "\u989D\u5EA6\u5DF2\u7528\u5B8C",
  "\u5347\u7EA7\u5957\u9910"
];
const LOBSTERAI_SESSION_DEAD_MARKERS = [
  "40100",
  "40101",
  "token rejected",
  "refresh token was rejected"
];
const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_NOT_FOUND = 404;
function classifyLobsteraiError(status, body) {
  if (status === HTTP_PAYMENT_REQUIRED) return "hard-credit";
  const lower = body.toLowerCase();
  for (const marker of LOBSTERAI_HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard-credit";
  }
  for (const marker of LOBSTERAI_SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return "session-dead";
  }
  if (status === HTTP_TOO_MANY_REQUESTS) return "soft-rate";
  if (status === HTTP_NOT_FOUND) return "not-found";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "none";
}
function classifyLobsteraiStreamError(message) {
  const byKeyword = classifyLobsteraiError(200, message);
  return byKeyword === "none" ? "client" : byKeyword;
}
function shouldRotateLobsteraiAccount(kind) {
  return kind !== "none";
}
function recordsLobsteraiRateLimit(kind) {
  return kind === "hard-credit" || kind === "soft-rate" || kind === "not-found";
}
function isLobsteraiTerminalError(kind) {
  return kind === "session-dead";
}
export {
  LOBSTERAI_HARD_CREDIT_MARKERS,
  LOBSTERAI_SESSION_DEAD_MARKERS,
  classifyLobsteraiError,
  classifyLobsteraiStreamError,
  isLobsteraiTerminalError,
  recordsLobsteraiRateLimit,
  shouldRotateLobsteraiAccount
};
