const SESSION_DEAD_MARKERS = [
  "login",
  "token \u5931\u6548",
  "token invalid",
  "session",
  "unauthorized",
  "401"
];
const PLAN_LIMIT_MARKERS = ['"code":1005', "1005"];
const QUOTA_EXCEEDED_MARKERS = ["4008", '"code":4008', "quota", "exceeded the quota"];
function classifyTraeError(status, body) {
  const lower = body.toLowerCase();
  for (const marker of PLAN_LIMIT_MARKERS) {
    if (body.includes(marker) && (body.includes("plan") || lower.includes("plan"))) {
      return "hard-plan";
    }
  }
  for (const marker of QUOTA_EXCEEDED_MARKERS) {
    if (body.includes(marker)) return "quota-exceeded";
  }
  if (body.includes("4011") || body.includes('"code":4011')) {
    return "soft-rate";
  }
  if (status === 401) {
    for (const marker of SESSION_DEAD_MARKERS) {
      if (lower.includes(marker.toLowerCase())) return "session-dead";
    }
    return "session-dead";
  }
  if (status === 429) return "soft-rate";
  if (status === 404) return "not-found";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "none";
}
function shouldRotateTraeAccount(kind) {
  return kind !== "none";
}
function recordsTraeRateLimit(kind) {
  return kind === "hard-plan" || kind === "soft-rate" || kind === "not-found" || kind === "quota-exceeded";
}
function isTraeTerminalError(kind) {
  return kind === "session-dead";
}
export {
  classifyTraeError,
  isTraeTerminalError,
  recordsTraeRateLimit,
  shouldRotateTraeAccount
};
