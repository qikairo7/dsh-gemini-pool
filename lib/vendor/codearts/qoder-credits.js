import { roundCredits } from "./credits.js";
import { withQoderMachineHeadersAsync } from "./qoder-machine.js";
import { qoderBearerToken } from "./qoder.js";
const QODER_USAGE_PATH = "/sash/api/v2/me/usage";
const QODER_CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
const QODER_CREDITS_TIMEOUT_MS = 15e3;
const NOT_ACTIVATED_HINT = "\u8BE5\u8D26\u53F7\u5C1A\u672A\u5728 Qoder \u4FA7\u5F00\u901A\u6BCF\u65E5\u9886\u53D6\uFF08\u6BCF\u65E5 100 Credits\uFF09\u3002\u8BF7\u5148\u7528 Qoder \u5B98\u65B9\u5BA2\u6237\u7AEF\u767B\u5F55\u4E00\u6B21\u8BE5\u8D26\u53F7\uFF0C\u5F00\u901A\u540E\u518D\u56DE\u6765\u9886\u53D6\u3002";
function isQoderNotActivated(campaigns, usageBody) {
  if (campaigns === void 0) return false;
  const hasBenefit = campaigns.campaigns.some((c) => c.actionType === "CLAIM_BENEFIT");
  if (hasBenefit) return false;
  if (typeof usageBody !== "object" || usageBody === null) return false;
  const usage = usageBody.qoderUsage;
  if (typeof usage !== "object" || usage === null) return false;
  const record = usage;
  return record.addOnQuota === void 0;
}
async function fetchQoderUsageRaw(credential, product, fetcher = fetch) {
  try {
    const response = await fetcher(`${product.openApiBase}${QODER_USAGE_PATH}`, {
      method: "GET",
      headers: await creditsHeaders(credential, product),
      signal: AbortSignal.timeout(QODER_CREDITS_TIMEOUT_MS)
    });
    if (!response.ok) return void 0;
    return await response.json();
  } catch {
    return void 0;
  }
}
async function creditsHeaders(credential, product) {
  return await withQoderMachineHeadersAsync({
    Accept: "application/json",
    Authorization: `Bearer ${qoderBearerToken(credential)}`,
    // 桌面 app 身份（`'10'`）；服务端据此进入活动下发分支。
    "Cosy-ClientType": product.sashClientType,
    "User-Agent": "Qoder"
  });
}
function readNumber(source, key) {
  if (typeof source !== "object" || source === null) return void 0;
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function readString(source, key) {
  if (typeof source !== "object" || source === null) return void 0;
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function toPackage(name, quota, options = {}) {
  const total = readNumber(quota, "total");
  const used = readNumber(quota, "used");
  const remainingRaw = readNumber(quota, "remaining");
  if (total === void 0 && used === void 0 && remainingRaw === void 0) return void 0;
  const totalValue = Math.max(0, total ?? 0);
  const usedValue = Math.max(0, used ?? 0);
  const remaining = remainingRaw !== void 0 ? Math.max(0, remainingRaw) : Math.max(0, totalValue - usedValue);
  return {
    name,
    unit: readString(quota, "unit") ?? "credits",
    remaining,
    total: totalValue,
    used: usedValue,
    active: options.active ?? true,
    cycleStartTime: "",
    cycleEndTime: "",
    expiredTime: options.expiredTime ?? ""
  };
}
async function fetchQoderCreditBalance(credential, product, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`${product.openApiBase}${QODER_USAGE_PATH}`, {
      method: "GET",
      headers: await creditsHeaders(credential, product),
      signal: AbortSignal.timeout(QODER_CREDITS_TIMEOUT_MS)
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const root = body;
  if (root.displayMode === "enterprise") return null;
  const usage = root.qoderUsage;
  if (typeof usage !== "object" || usage === null) return null;
  const packages = [];
  const userQuota = toPackage("\u5957\u9910\u989D\u5EA6", usage.userQuota);
  if (userQuota !== void 0) packages.push(userQuota);
  const addOnQuota = toPackage("\u8D44\u6E90\u5305", usage.addOnQuota);
  if (addOnQuota !== void 0) packages.push(addOnQuota);
  const dedicated = usage.dedicatedResourcePackages;
  if (Array.isArray(dedicated)) {
    for (const item of dedicated) {
      const pkg = toPackage(
        readString(item, "name") ?? readString(item, "id") ?? "\u4E13\u7528\u8D44\u6E90\u5305",
        item,
        { expiredTime: readString(item, "expiresAt") ?? readString(item, "expires_at") ?? "" }
      );
      if (pkg !== void 0) packages.push(pkg);
    }
  }
  if (packages.length === 0) return null;
  const total = roundCredits(packages.reduce((sum, pkg) => sum + pkg.remaining, 0));
  return { total, packages, expiredTotal: 0 };
}
function describeQoderBalance(balance) {
  if (balance === null) return "\u67E5\u8BE2\u5931\u8D25";
  if (balance.total === 0) return "\u4F59\u989D 0";
  return `${balance.total} credits\uFF08${balance.packages.length} \u4E2A\u5305\uFF09`;
}
function parseQoderCampaigns(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return void 0;
  const root = body;
  const raw = root.campaigns;
  const campaigns = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = readString(item, "campaignId");
      if (id === void 0) continue;
      campaigns.push({
        campaignId: id,
        ...readString(item, "campaignKey") !== void 0 ? { campaignKey: readString(item, "campaignKey") } : {},
        ...readString(item, "actionType") !== void 0 ? { actionType: readString(item, "actionType") } : {},
        ...readString(item, "claimStatus") !== void 0 ? { claimStatus: readString(item, "claimStatus") } : {},
        ...benefitAmount(item) !== void 0 ? { amount: benefitAmount(item) } : {}
      });
    }
  }
  return {
    showCampaign: root.showCampaign === true,
    claimable: root.claimable === true,
    campaigns
  };
}
function benefitAmount(item) {
  if (typeof item !== "object" || item === null) return void 0;
  return readNumber(item.benefit, "amount");
}
async function loadCampaigns(credential, product, fetcher) {
  let response;
  try {
    response = await fetcher(`${product.openApiBase}${QODER_CAMPAIGNS_PATH}`, {
      method: "GET",
      headers: await creditsHeaders(credential, product),
      signal: AbortSignal.timeout(QODER_CREDITS_TIMEOUT_MS)
    });
  } catch {
    return void 0;
  }
  if (!response.ok) return void 0;
  let body;
  try {
    body = await response.json();
  } catch {
    return void 0;
  }
  return parseQoderCampaigns(body);
}
async function fetchQoderCheckinStatus(credential, product, fetcher = fetch) {
  const parsed = await loadCampaigns(credential, product, fetcher);
  if (parsed === void 0) return null;
  const claimable = claimableCampaigns(parsed);
  const benefitCampaigns = parsed.campaigns.filter((c) => c.actionType === "CLAIM_BENEFIT");
  const claimedBenefit = benefitCampaigns.filter((c) => c.claimStatus === "CLAIMED");
  const todayCheckedIn = claimedBenefit.length > 0 && claimable.length === 0;
  let actionRequired = false;
  if (!todayCheckedIn && claimable.length === 0) {
    const usage = await fetchQoderUsageRaw(credential, product, fetcher);
    actionRequired = isQoderNotActivated(parsed, usage);
  }
  return {
    active: true,
    // 真有「领过」的领分类活动、且当前无可领项 ⇒ 今天已领。
    // 列表为空 / 仅 VIEW_DETAILS / 请求头不完整导致的空态，一律判**未领**。
    todayCheckedIn,
    streakDays: 0,
    dailyCredit: claimable[0]?.amount ?? benefitCampaigns[0]?.amount ?? 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: [],
    activityName: benefitCampaigns[0]?.campaignKey ?? "",
    themeName: "",
    endTime: "",
    // 只在为 true 时才带上该字段，保持既有响应形状最小变化
    ...actionRequired ? { actionRequired: true } : {}
  };
}
function claimableCampaigns(parsed) {
  return parsed.campaigns.filter(
    (c) => c.actionType === "CLAIM_BENEFIT" && c.claimStatus === "CLAIMABLE"
  );
}
function parseClaimResult(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const root = body;
  return {
    ...readString(root, "status") !== void 0 ? { status: readString(root, "status") } : {},
    ...typeof root.replayed === "boolean" ? { replayed: root.replayed } : {},
    ...benefitAmount(root) !== void 0 ? { amount: benefitAmount(root) } : {}
  };
}
async function claimQoderCampaign(credential, product, campaignId, fetcher = fetch) {
  const url = `${product.openApiBase}${QODER_CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`;
  let response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { ...await creditsHeaders(credential, product), "Content-Type": "application/json" },
      body: "",
      signal: AbortSignal.timeout(QODER_CREDITS_TIMEOUT_MS)
    });
  } catch (error) {
    return { kind: "failed", code: -1, message: error instanceof Error ? error.message : String(error) };
  }
  const text = await response.text().catch(() => "");
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return { kind: "failed", code: response.status, message: describeNonJson(response.status, text) };
  }
  if (!response.ok) {
    return { kind: "failed", code: response.status, message: describeNonJson(response.status, text) };
  }
  const result = parseClaimResult(body);
  if (result.replayed === true) {
    return { kind: "already-claimed", message: "\u4ECA\u5929\u5DF2\u9886\u53D6" };
  }
  if (result.status !== void 0 && result.status !== "CLAIMED") {
    return { kind: "failed", code: -1, message: `\u9886\u53D6\u672A\u6210\u529F\uFF08status=${result.status}\uFF09` };
  }
  return { kind: "claimed", credit: result.amount ?? 0, streakDays: 0, isStreakDay: false };
}
function describeNonJson(status, text) {
  if (status === 401 || status === 403) return `\u51ED\u636E\u5DF2\u5931\u6548\uFF08HTTP ${status}\uFF09\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u8BE5\u8D26\u53F7`;
  const snippet = text.trim().slice(0, 80).replace(/\s+/g, " ");
  return `\u670D\u52A1\u7AEF\u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94\uFF08HTTP ${status}\uFF09\uFF1A${snippet}`;
}
async function claimQoderDailyCheckin(credential, product, fetcher = fetch) {
  const parsed = await loadCampaigns(credential, product, fetcher);
  if (parsed === void 0) {
    return { kind: "failed", code: -1, message: "\u6D3B\u52A8\u5217\u8868\u67E5\u8BE2\u5931\u8D25" };
  }
  const targets = claimableCampaigns(parsed);
  if (targets.length === 0) {
    const claimedBefore = parsed.campaigns.some(
      (c) => c.actionType === "CLAIM_BENEFIT" && c.claimStatus === "CLAIMED"
    );
    if (claimedBefore) return { kind: "already-claimed", message: "\u4ECA\u5929\u5DF2\u9886\u53D6" };
    const usage = await fetchQoderUsageRaw(credential, product, fetcher);
    if (isQoderNotActivated(parsed, usage)) {
      return { kind: "inactive", message: NOT_ACTIVATED_HINT, actionRequired: true };
    }
    return { kind: "inactive", message: "\u5F53\u524D\u6CA1\u6709\u53EF\u9886\u53D6\u7684\u6D3B\u52A8" };
  }
  let total = 0;
  let firstError;
  for (const target of targets) {
    const outcome = await claimQoderCampaign(credential, product, target.campaignId, fetcher);
    if (outcome.kind === "claimed") total += outcome.credit;
    else if (outcome.kind === "failed" && firstError === void 0) firstError = outcome.message;
  }
  if (total > 0) return { kind: "claimed", credit: total, streakDays: 0, isStreakDay: false };
  if (firstError !== void 0) return { kind: "failed", code: -1, message: firstError };
  return { kind: "already-claimed", message: "\u4ECA\u5929\u5DF2\u9886\u53D6" };
}
export {
  QODER_CAMPAIGNS_PATH,
  QODER_USAGE_PATH,
  claimQoderCampaign,
  claimQoderDailyCheckin,
  describeQoderBalance,
  fetchQoderCheckinStatus,
  fetchQoderCreditBalance,
  fetchQoderUsageRaw,
  isQoderNotActivated,
  parseQoderCampaigns
};
