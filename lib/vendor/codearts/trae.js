import { createHash } from "node:crypto";
import { jwtExpiresAtMs } from "./buddy.js";
import { TRAE_CHANNELS } from "./trae-product.js";
const TRAE_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
const TRAE_MODELS_PATH = "/api/ide/v1/get_detail_param";
const TRAE_BATCH_MODELS_PATH = "/api/ide/v1/batch_get_detail_param";
const TRAE_EXCHANGE_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken";
const TRAE_USER_INFO_PATH = "/cloudide/api/v3/trae/GetUserInfo";
const TRAE_CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const TRAE_CHECKIN_CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
const TRAE_ENT_USAGE_PATH = "/trae/api/v2/pay/ide_user_ent_usage";
const TRAE_CALLBACK_PATH = "/authorize";
const TRAE_REQUEST_TIMEOUT_MS = 3e4;
const TRAE_LOGIN_TIMEOUT_MS = 10 * 60 * 1e3;
function traeCredentialExpiresAtMs(credential) {
  const raw = credential.expires_at;
  if (typeof raw === "string" && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      return value > 1e12 ? value : value * 1e3;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return jwtExpiresAtMs(credential.access_token);
}
function isTraeExpired(credential) {
  const expiresAt = traeCredentialExpiresAtMs(credential);
  return expiresAt === void 0 ? false : Date.now() >= expiresAt;
}
function isTraeRefreshable(credential) {
  return typeof credential.refresh_token === "string" && credential.refresh_token.length > 0;
}
function traeSOLOHeaders(credential, product, stream, machineIdGeneration = 0) {
  const headers = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": product.userAgent,
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    "X-Cloudide-Token": credential.access_token,
    "X-Ide-Token": credential.access_token,
    "X-Uid": credential.uid,
    "X-App-Id": product.appId,
    "X-App-Version": "default",
    "X-Ide-Version": product.ideVersion,
    "X-Ide-Version-Code": product.ideVersionCode,
    "X-App-Version-Code": product.ideVersionCode,
    "X-Ide-Version-Type": "stable",
    "X-Device-Type": "macos",
    "X-OS-Version": product.osVersion,
    "X-Device-Brand": product.deviceBrand,
    "Request-Traffic-Type": "prod"
  };
  if (credential.machine_id.length > 0) {
    headers["X-Machine-Id"] = deriveRotatingMachineId(credential.machine_id, machineIdGeneration);
  }
  if (credential.device_id.length > 0) {
    headers["X-Device-Id"] = credential.device_id;
  }
  return headers;
}
function traeUgHeaders(credential, product, checkinDeviceGeneration = 0) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": product.userAgent,
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    "X-User-Region": "CN"
  };
  if (credential.device_id.length > 0) {
    headers["X-Device-Id"] = deriveCheckinDeviceId(credential.device_id, checkinDeviceGeneration);
  }
  return headers;
}
function traeCheckinHeaders(credential, product, userId) {
  const deviceId = deriveDeviceId15(userId);
  const marketUserId = deriveMarketUserId(userId);
  const sessionId = deriveSessionId(userId);
  const traceId = `00-${randomHex(16)}-01`;
  const requestId = uuidV4();
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN",
    "User-Agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    "X-Market-Client-Id": "VSCode 1.107.1",
    "X-Market-User-Id": marketUserId,
    "X-User-Region": "CN",
    "X-Device-Id": deviceId,
    "X-Lgw-Req-Sdk-Type": "3",
    "Package-Type": "stable_cn",
    "X-Lscbd-Aid": "787976",
    "X-Lscbd-Platform": "windows",
    "App-Version": product.ideVersion,
    "X-Tt-Trace-Id": traceId,
    "Vscode-Sessionid": sessionId,
    "X-Request-Id": requestId,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "none"
  };
}
function deriveDeviceId15(userId) {
  return seededDigits(15, userId, "devid");
}
function deriveMarketUserId(userId) {
  const bs = seededStream(userId, "market", 16);
  bs[6] = bs[6] & 15 | 64;
  bs[8] = bs[8] & 63 | 128;
  const hex = bs.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function deriveSessionId(userId) {
  const bytes = seededStream(userId, "sess", 32);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
function seededStream(seed, salt, nbytes) {
  const prefix = `${salt}:${seed}`;
  const result = [];
  let counter = 0;
  while (result.length < nbytes) {
    const counterBuf = new Uint8Array(4);
    counterBuf[0] = counter >> 24 & 255;
    counterBuf[1] = counter >> 16 & 255;
    counterBuf[2] = counter >> 8 & 255;
    counterBuf[3] = counter & 255;
    const h = createHash("sha256");
    h.update(prefix, "utf8");
    h.update(counterBuf);
    for (const b of h.digest()) {
      result.push(b);
      if (result.length >= nbytes) break;
    }
    counter++;
  }
  return result.slice(0, nbytes);
}
function seededDigits(n, seed, salt) {
  const bs = seededStream(seed, salt, n);
  return bs.map((b) => (b % 10).toString()).join("");
}
function uuidV4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : r & 3 | 8).toString(16);
  });
}
function randomHex(n) {
  const buf = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}
function traeOAuthHeaders(product) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": product.userAgent
  };
}
function parseTraeExchangeResponse(data) {
  const result = data.Result ?? data.result;
  if (typeof result !== "object" || result === null) return void 0;
  const r = result;
  const accessToken = readStringField(r, "Token") || readStringField(r, "token") || readStringField(r, "accessToken");
  const refreshToken = readStringField(r, "RefreshToken") || readStringField(r, "refreshToken");
  if (accessToken.length === 0) return void 0;
  return {
    accessToken,
    refreshToken,
    tokenExpireAt: readNumberField(r, "TokenExpireAt") ?? readNumberField(r, "tokenExpireAt") ?? 0,
    tokenExpireDuration: readNumberField(r, "TokenExpireDuration") ?? readNumberField(r, "tokenExpireDuration") ?? 0,
    refreshExpireAt: readNumberField(r, "RefreshExpireAt") ?? readNumberField(r, "refreshExpireAt") ?? 0
  };
}
function parseTraeUserInfoResponse(data) {
  const result = data.Result ?? data.result;
  if (typeof result !== "object" || result === null) return void 0;
  const r = result;
  const uid = readStringField(r, "UserID") || readStringField(r, "userId") || readStringField(r, "uid");
  if (uid.length === 0) return void 0;
  return {
    uid,
    screenName: readStringField(r, "ScreenName") || readStringField(r, "screenName") || uid,
    enterpriseId: readStringField(r, "EnterpriseID") || readStringField(r, "enterpriseId") || ""
  };
}
function buildTraeCredential(exchange, userInfo, session, nowMs = Date.now()) {
  let expiresAt;
  if (exchange.tokenExpireAt > 1e12) {
    expiresAt = String(exchange.tokenExpireAt);
  } else if (exchange.tokenExpireAt > 0) {
    expiresAt = String(exchange.tokenExpireAt * 1e3);
  } else if (exchange.tokenExpireDuration > 0) {
    expiresAt = String(nowMs + exchange.tokenExpireDuration * 1e3);
  } else {
    const exp = jwtExpiresAtMs(exchange.accessToken);
    expiresAt = exp === void 0 ? "" : String(exp);
  }
  return {
    access_token: exchange.accessToken,
    refresh_token: exchange.refreshToken,
    expires_at: expiresAt,
    uid: userInfo.uid,
    nickname: userInfo.screenName,
    machine_id: session.machineId,
    device_id: session.deviceId,
    enterprise_id: userInfo.enterpriseId
  };
}
function applyTraeRefresh(previous, exchange, nowMs = Date.now()) {
  let expiresAt;
  if (exchange.tokenExpireAt > 1e12) {
    expiresAt = String(exchange.tokenExpireAt);
  } else if (exchange.tokenExpireAt > 0) {
    expiresAt = String(exchange.tokenExpireAt * 1e3);
  } else if (exchange.tokenExpireDuration > 0) {
    expiresAt = String(nowMs + exchange.tokenExpireDuration * 1e3);
  } else {
    const exp = jwtExpiresAtMs(exchange.accessToken);
    expiresAt = exp === void 0 ? "" : String(exp);
  }
  return {
    ...previous,
    access_token: exchange.accessToken,
    // refresh_token 也会被轮换，新值不为空时才更新。
    refresh_token: exchange.refreshToken.length > 0 ? exchange.refreshToken : previous.refresh_token,
    expires_at: expiresAt
  };
}
function isTraeModelCallable(model) {
  return model.isCustomModel !== true && model.isEnabled !== false;
}
function isTraeModelUsable(model, options = {}) {
  if (!isTraeModelCallable(model)) return false;
  if (options.hideInternal === true && model.isHidden === true) return false;
  return true;
}
function readContextWindowField(entry) {
  const raw = entry.context_window_tokens ?? entry.ContextWindowTokens;
  if (typeof raw !== "object" || raw === null) return void 0;
  const record = raw;
  const value = readNumberField(record, "dev") ?? readNumberField(record, "Dev") ?? readNumberField(record, "max") ?? readNumberField(record, "Max");
  return value !== void 0 && value > 0 ? Math.trunc(value) : void 0;
}
function readMaxContextWindowField(entry) {
  const raw = entry.context_window_tokens ?? entry.ContextWindowTokens;
  if (typeof raw !== "object" || raw === null) return void 0;
  const record = raw;
  const value = readNumberField(record, "max") ?? readNumberField(record, "Max");
  return value !== void 0 && value > 0 ? Math.trunc(value) : void 0;
}
function readDetailMaxTokens(entry, preferredSuffix = "__dev") {
  const raw = entry.model_detail_list ?? entry.ModelDetailList;
  if (!Array.isArray(raw) || raw.length === 0) return void 0;
  const details = raw.filter(
    (item) => typeof item === "object" && item !== null
  );
  const preferred = details.find((item) => readStringField(item, "model_name").endsWith(preferredSuffix));
  const chosen = preferred ?? details[0];
  if (chosen === void 0) return void 0;
  const value = readNumberField(chosen, "max_tokens") ?? readNumberField(chosen, "MaxTokens");
  return value !== void 0 && value > 0 ? Math.trunc(value) : void 0;
}
function readReasoningEffortConfig(entry) {
  const raw = entry.reasoning_effort_config ?? entry.ReasoningEffortConfig;
  if (typeof raw !== "object" || raw === null) return void 0;
  const record = raw;
  const options = [];
  const rawOptions = record.options ?? record.Options;
  if (Array.isArray(rawOptions)) {
    for (const item of rawOptions) {
      if (typeof item === "string" && item.trim().length > 0) {
        options.push(item.trim());
      } else if (typeof item === "object" && item !== null) {
        const obj = item;
        const wire = readStringField(obj, "openclawLevel") || readStringField(obj, "level") || readStringField(obj, "Level");
        if (wire.trim().length > 0) options.push(wire.trim());
      }
    }
  }
  const defaultLevel = readStringField(record, "default_level") || readStringField(record, "DefaultLevel");
  const supportThinking = readBooleanField(record, "support_thinking") ?? readBooleanField(record, "SupportThinking");
  if (options.length === 0 && defaultLevel.length === 0 && supportThinking === void 0) {
    return void 0;
  }
  return {
    options,
    ...defaultLevel.length > 0 ? { defaultLevel } : {},
    ...supportThinking === void 0 ? {} : { supportThinking }
  };
}
function readConsumptionRate(entry) {
  const raw = entry.display_contact_config ?? entry.DisplayContactConfig;
  if (typeof raw !== "string" || raw.length === 0) return void 0;
  const config = parseJsonObject(raw);
  if (config === void 0) return void 0;
  const rate = config.consumption_rate ?? config.ConsumptionRate;
  if (typeof rate !== "object" || rate === null) return void 0;
  const rateRecord = rate;
  if (readBooleanField(rateRecord, "enable") === false) return void 0;
  const data = rateRecord.data ?? rateRecord.Data;
  if (typeof data !== "object" || data === null) return void 0;
  const value = readNumberField(data, "rate");
  return value !== void 0 && value >= 0 ? value : void 0;
}
function readActivityDiscount(entry, nowSec = Math.floor(Date.now() / 1e3)) {
  const raw = entry.display_contact_config ?? entry.DisplayContactConfig;
  if (typeof raw !== "string" || raw.length === 0) return void 0;
  const config = parseJsonObject(raw);
  if (config === void 0) return void 0;
  const discount = config.activity_discount ?? config.ActivityDiscount;
  if (typeof discount !== "object" || discount === null) return void 0;
  const discountRecord = discount;
  if (readBooleanField(discountRecord, "enable") === false) return void 0;
  const data = discountRecord.data ?? discountRecord.Data;
  if (typeof data !== "object" || data === null) return void 0;
  const dataRecord = data;
  const current = dataRecord.current ?? dataRecord.Current;
  if (typeof current !== "object" || current === null) return void 0;
  const currentRecord = current;
  const type = (readStringField(currentRecord, "discount_type") || readStringField(currentRecord, "discountType")).trim().toLowerCase();
  if (type.length === 0 || type === "none") return void 0;
  const before = readNumberField(currentRecord, "before_consumption_rate") ?? readNumberField(currentRecord, "beforeConsumptionRate");
  const after = readNumberField(currentRecord, "consumption_rate") ?? readNumberField(currentRecord, "consumptionRate");
  if (before === void 0 || before <= 0) return void 0;
  if (after !== void 0 && before <= after) return void 0;
  let endsAtSec;
  for (const value of Object.values(dataRecord)) {
    if (typeof value !== "object" || value === null) continue;
    const end = readNumberField(value, "end_at") ?? readNumberField(value, "endAt");
    if (end !== void 0 && end > 0) {
      endsAtSec = end;
      break;
    }
  }
  if (endsAtSec !== void 0 && endsAtSec <= nowSec) return void 0;
  return endsAtSec === void 0 ? { originalRate: before } : { originalRate: before, endsAtSec };
}
function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
    return parsed;
  } catch {
    return void 0;
  }
}
function parseTraeConfigEntry(entry, channel) {
  const id = readStringField(entry, "config_name") || readStringField(entry, "ConfigName");
  if (id.length === 0) return void 0;
  const display = entry.display_config ?? entry.DisplayConfig;
  const displayRecord = typeof display === "object" && display !== null ? display : void 0;
  const name = displayRecord !== void 0 ? readStringField(displayRecord, "display_name") || id : id;
  const isCustomModel = displayRecord === void 0 ? void 0 : readBooleanField(displayRecord, "is_custom_model") ?? readBooleanField(displayRecord, "IsCustomModel");
  const isHidden = readBooleanField(entry, "is_invisible_to_user") ?? readBooleanField(entry, "IsInvisibleToUser");
  const isEnabled = readBooleanField(entry, "config_switch") ?? readBooleanField(entry, "ConfigSwitch");
  const usage = readStringField(entry, "usage") || readStringField(entry, "Usage");
  const contextWindow = readContextWindowField(entry);
  const maxOutputTokens = readDetailMaxTokens(entry);
  const maxMode = displayRecord === void 0 ? void 0 : readBooleanField(displayRecord, "max_mode") ?? readBooleanField(displayRecord, "MaxMode");
  const maxContextWindow = readMaxContextWindowField(entry);
  const maxModeOutputTokens = readDetailMaxTokens(entry, "__max");
  const multimodal = displayRecord === void 0 ? void 0 : readBooleanField(displayRecord, "multimodal") ?? readBooleanField(displayRecord, "Multimodal");
  const toolResponseMultimodal = displayRecord === void 0 ? void 0 : readBooleanField(displayRecord, "tool_response_multimodal") ?? readBooleanField(displayRecord, "ToolResponseMultimodal");
  const reasoningConfig = readReasoningEffortConfig(entry);
  const creditsRate = readConsumptionRate(entry);
  const discount = readActivityDiscount(entry);
  return {
    id,
    name,
    ...channel === void 0 ? {} : { function: channel },
    ...isCustomModel === void 0 ? {} : { isCustomModel },
    ...isHidden === void 0 ? {} : { isHidden },
    ...isEnabled === void 0 ? {} : { isEnabled },
    ...usage.length > 0 ? { usage } : {},
    ...reasoningConfig === void 0 ? {} : { reasoningConfig },
    ...maxMode === void 0 ? {} : { maxMode },
    ...multimodal === void 0 ? {} : { multimodal },
    ...toolResponseMultimodal === void 0 ? {} : { toolResponseMultimodal },
    ...maxContextWindow === void 0 ? {} : { maxContextWindow },
    ...maxModeOutputTokens === void 0 ? {} : { maxModeOutputTokens },
    ...contextWindow === void 0 ? {} : { contextWindow },
    ...maxOutputTokens === void 0 ? {} : { maxOutputTokens },
    ...creditsRate === void 0 ? {} : { creditsRate },
    ...discount === void 0 ? {} : { originalCreditsRate: discount.originalRate },
    ...discount?.endsAtSec === void 0 ? {} : { discountEndsAtSec: discount.endsAtSec }
  };
}
function parseTraeModelList(body) {
  if (typeof body !== "object" || body === null) return [];
  const record = body;
  const list = record.config_info_list ?? record.ConfigInfoList ?? record.data;
  if (!Array.isArray(list)) return [];
  const models = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const model = parseTraeConfigEntry(item, void 0);
    if (model !== void 0) models.push(model);
  }
  return models;
}
function parseTraeBatchModelList(body, channelPriority = TRAE_CHANNELS) {
  if (typeof body !== "object" || body === null) return [];
  const record = body;
  const groups = record.function_configs ?? record.FunctionConfigs;
  if (!Array.isArray(groups)) return [];
  const rankOf = (channel) => {
    if (channel === void 0) return Number.MAX_SAFE_INTEGER;
    const index = channelPriority.indexOf(channel);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const byId = /* @__PURE__ */ new Map();
  const chosenRank = /* @__PURE__ */ new Map();
  for (const group of groups) {
    if (typeof group !== "object" || group === null) continue;
    const g = group;
    const channel = readStringField(g, "function") || readStringField(g, "Function");
    const list = g.config_info_list ?? g.ConfigInfoList;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const model = parseTraeConfigEntry(item, channel.length > 0 ? channel : void 0);
      if (model === void 0) continue;
      if (model.usage !== void 0 && model.usage !== "chat_completion") continue;
      if (model.isEnabled === false) continue;
      if (model.isHidden === true) continue;
      const incumbent = byId.get(model.id);
      if (incumbent === void 0) {
        byId.set(model.id, model);
        chosenRank.set(model.id, rankOf(model.function));
        continue;
      }
      const incumbentHasEffort = declaresReasoningOptions(incumbent);
      const candidateHasEffort = declaresReasoningOptions(model);
      if (incumbentHasEffort && !candidateHasEffort) continue;
      if (incumbentHasEffort && candidateHasEffort) {
        const current = chosenRank.get(model.id) ?? Number.MAX_SAFE_INTEGER;
        if (current !== Number.MAX_SAFE_INTEGER && rankOf(model.function) >= current) continue;
      }
      byId.set(model.id, model);
      chosenRank.set(model.id, rankOf(model.function));
    }
  }
  return [...byId.values()];
}
function declaresReasoningOptions(model) {
  const config = model.reasoningConfig;
  if (config === void 0) return false;
  if (config.supportThinking === false) return false;
  return config.options.length > 0;
}
function generateMachineId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function generateDeviceId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function deriveCheckinDeviceId(baseDeviceId, generation) {
  if (!Number.isFinite(generation) || generation <= 0) return baseDeviceId;
  return createHash("sha256").update(`${baseDeviceId}#gen${Math.floor(generation)}`, "utf8").digest("hex").slice(0, 32);
}
function deriveRotatingMachineId(baseMachineId, generation) {
  if (!Number.isFinite(generation) || generation <= 0) return baseMachineId;
  return createHash("sha256").update(`${baseMachineId}#machine${Math.floor(generation)}`, "utf8").digest("hex").slice(0, 32);
}
const TRAE_DEFAULT_MAX_COMPLETION_TOKENS = 64e3;
function resolveTraeMaxCompletionTokens() {
  const raw = Number.parseInt(process.env.DSH_TRAE_MAX_COMPLETION_TOKENS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return TRAE_DEFAULT_MAX_COMPLETION_TOKENS;
}
function clampTraeMaxTokens(value, limit = resolveTraeMaxCompletionTokens()) {
  if (value === void 0 || !Number.isFinite(value) || value <= 0) return value;
  if (limit <= 0) return value;
  return Math.min(value, limit);
}
function readStringField(source, key) {
  const value = source[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
function readNumberField(source, key) {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return void 0;
}
function readBooleanField(source, key) {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "true") return true;
  if (value === 0 || value === "false") return false;
  return void 0;
}
const TRAE_DEFAULT_MODEL = "glm-5.2";
const TRAE_FUNCTION = "solo_work_lite";
const TRAE_MAX_CONTEXT_TOKENS = 1e6;
const TRAE_MAX_PROMPT_TOKENS = 936e3;
const TRAE_MAX_OUTPUT_TOKENS = 64e3;
const TRAE_MAX_MODE_TYPE = 1;
function traeMaxModeFields(maxContext, outputMax) {
  const context = maxContext > 0 ? maxContext : TRAE_MAX_CONTEXT_TOKENS;
  return {
    model_auto_selection: {
      strategy: "max",
      fallback_to_advance_model: null,
      entitlement_id: null
    },
    model_selection_strategy: "max",
    mode_type: TRAE_MAX_MODE_TYPE,
    context_window_size: context,
    prompt_max_tokens: TRAE_MAX_PROMPT_TOKENS,
    max_tokens: outputMax !== void 0 && outputMax > 0 ? outputMax : TRAE_MAX_OUTPUT_TOKENS
  };
}
function transformToSOLOBody(openaiBody, modelMapping, channel) {
  const body = {
    ...openaiBody,
    stream: true,
    function: channel !== void 0 && channel.length > 0 ? channel : TRAE_FUNCTION
  };
  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    body.messages = msgs.map((msg) => transformSOLOMessage(msg));
  }
  const model = typeof body.model === "string" ? body.model : "";
  const baseModel = model.includes("__") ? model.split("__")[0] : model;
  const configName = modelMapping && modelMapping.length > 0 ? modelMapping : baseModel || TRAE_DEFAULT_MODEL;
  body.config_name = configName;
  body.model = configName;
  normalizeToolChoice(body);
  normalizeTools(body);
  return body;
}
function transformSOLOMessage(msg) {
  const result = { ...msg };
  if (result.role === "assistant") {
    const tcs = result.tool_calls;
    if (Array.isArray(tcs)) {
      const kept = [];
      for (const tc of tcs) {
        if (typeof tc !== "object" || tc === null) continue;
        const t = tc;
        if (typeof t.function === "object" && t.function !== null) {
          t.function_call = t.function;
          delete t.function;
        }
        const fc = t.function_call;
        if (fc === void 0 || typeof fc.name !== "string" || fc.name.trim().length === 0) continue;
        kept.push(t);
      }
      if (kept.length > 0) {
        result.tool_calls = kept;
      } else {
        delete result.tool_calls;
      }
    }
  }
  const content = result.content;
  if (content === null || content === void 0) {
  } else if (typeof content === "string") {
    result.content = [{ type: "text", text: content }];
  }
  return result;
}
function normalizeToolChoice(body) {
  const tc = body.tool_choice;
  if (tc === void 0) return;
  const suppress = () => {
    delete body.tools;
    delete body.functions;
  };
  if (typeof tc === "string") {
    if (tc.toLowerCase().trim() === "none") {
      delete body.tool_choice;
      suppress();
    }
    return;
  }
  if (typeof tc === "object" && tc !== null) {
    const v = tc;
    const typ = typeof v.type === "string" ? v.type.toLowerCase().trim() : "";
    switch (typ) {
      case "none":
        delete body.tool_choice;
        suppress();
        break;
      case "auto":
      case "required":
        body.tool_choice = typ;
        break;
      case "function": {
        const fn = v.function;
        let name = typeof fn?.name === "string" ? fn.name : "";
        if (name.length === 0) name = typeof v.name === "string" ? v.name : "";
        if (name.trim().length > 0) {
          body.tool_choice = name.trim();
        } else {
          body.tool_choice = "auto";
        }
        break;
      }
      default:
        delete body.tool_choice;
    }
    return;
  }
  delete body.tool_choice;
}
function normalizeTools(body) {
  const raw = body.tools;
  if (!Array.isArray(raw) || raw.length === 0) return;
  const out = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = item;
    const fn = t.function;
    if (fn === void 0) continue;
    const params = fn.parameters;
    if (typeof params === "object" && params !== null) {
      fn.parameters = JSON.stringify(params);
    }
    out.push(t);
  }
  if (out.length > 0) {
    body.tools = out;
  } else {
    delete body.tools;
  }
}
function parseTraeSSELine(eventName, dataLine) {
  const event = eventName.trim();
  if (dataLine.length === 0) return { event };
  let raw;
  try {
    raw = JSON.parse(dataLine);
  } catch {
    return { event };
  }
  const ev = { event };
  switch (event) {
    case "output":
      if (typeof raw.response === "string") ev.response = raw.response;
      if (typeof raw.reasoning_content === "string") ev.reasoningContent = raw.reasoning_content;
      if (raw.tool_calls !== null && raw.tool_calls !== void 0) {
        if (Array.isArray(raw.tool_calls)) {
          ev.toolCalls = normalizeTraeToolCalls(raw.tool_calls);
        }
      }
      break;
    case "token_usage":
      ev.usage = raw;
      break;
    case "done":
      if (typeof raw.finish_reason === "string") ev.finishReason = raw.finish_reason;
      break;
    case "error":
      if (typeof raw.code === "number") ev.errorCode = raw.code;
      if (typeof raw.message === "string") ev.errorMessage = raw.message;
      break;
  }
  return ev;
}
function normalizeTraeToolCalls(calls) {
  return calls.map((call) => {
    if (typeof call !== "object" || call === null) return call;
    const c = { ...call };
    if (typeof c.function_call === "object" && c.function_call !== null) {
      c.function = { ...c.function_call };
      delete c.function_call;
    }
    if (typeof c.function === "object" && c.function !== null) {
      const fn = c.function;
      delete fn.namespace;
      delete fn.partial_arguments;
    }
    return c;
  });
}
function buildOpenAIChunk(id, delta, finishReason, usage) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model: "",
    choices: [
      {
        index: 0,
        delta
      }
    ]
  };
  if (finishReason !== void 0) {
    chunk.choices[0] = {
      ...chunk.choices[0],
      finish_reason: finishReason
    };
  }
  if (usage !== void 0) {
    chunk.usage = usage;
  }
  return `data: ${JSON.stringify(chunk)}

`;
}
const OPENAI_DONE = "data: [DONE]\n\n";
function aggregateTraeSSE(lines) {
  const result = {
    content: "",
    reasoningContent: "",
    toolCalls: [],
    finishReason: "stop",
    usage: void 0
  };
  let st;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      if (st !== void 0) {
        const ev = parseTraeSSELine(st.event, st.data);
        st = void 0;
        if (ev === void 0) continue;
        switch (ev.event) {
          case "output":
            if (ev.response !== void 0) result.content += ev.response;
            if (ev.reasoningContent !== void 0) result.reasoningContent += ev.reasoningContent;
            if (ev.toolCalls !== void 0 && ev.toolCalls.length > 0) {
              result.toolCalls.push(...ev.toolCalls);
            }
            break;
          case "token_usage":
            result.usage = ev.usage;
            break;
          case "done":
            if (ev.finishReason !== void 0) result.finishReason = ev.finishReason;
            break;
          case "error":
            result.error = { code: ev.errorCode ?? -1, message: ev.errorMessage ?? "unknown error" };
            break;
        }
      }
      continue;
    }
    if (line.startsWith("event:")) {
      const newEvent = line.slice(6).trim();
      if (st !== void 0) st.event = newEvent;
      else st = { event: newEvent, data: "" };
      continue;
    }
    if (line.startsWith("data:")) {
      const data = line.slice(5);
      if (st !== void 0) st.data += data;
      continue;
    }
  }
  return result;
}
export {
  OPENAI_DONE,
  TRAE_BATCH_MODELS_PATH,
  TRAE_CALLBACK_PATH,
  TRAE_CHAT_PATH,
  TRAE_CHECKIN_CLAIM_PATH,
  TRAE_CHECKIN_STATUS_PATH,
  TRAE_DEFAULT_MAX_COMPLETION_TOKENS,
  TRAE_DEFAULT_MODEL,
  TRAE_ENT_USAGE_PATH,
  TRAE_EXCHANGE_PATH,
  TRAE_FUNCTION,
  TRAE_LOGIN_TIMEOUT_MS,
  TRAE_MAX_CONTEXT_TOKENS,
  TRAE_MAX_MODE_TYPE,
  TRAE_MAX_OUTPUT_TOKENS,
  TRAE_MAX_PROMPT_TOKENS,
  TRAE_MODELS_PATH,
  TRAE_REQUEST_TIMEOUT_MS,
  TRAE_USER_INFO_PATH,
  aggregateTraeSSE,
  applyTraeRefresh,
  buildOpenAIChunk,
  buildTraeCredential,
  clampTraeMaxTokens,
  deriveCheckinDeviceId,
  deriveRotatingMachineId,
  generateDeviceId,
  generateMachineId,
  isTraeExpired,
  isTraeModelCallable,
  isTraeModelUsable,
  isTraeRefreshable,
  parseTraeBatchModelList,
  parseTraeExchangeResponse,
  parseTraeModelList,
  parseTraeSSELine,
  parseTraeUserInfoResponse,
  readActivityDiscount,
  readBooleanField,
  readConsumptionRate,
  readNumberField,
  readStringField,
  resolveTraeMaxCompletionTokens,
  traeCheckinHeaders,
  traeCredentialExpiresAtMs,
  traeMaxModeFields,
  traeOAuthHeaders,
  traeSOLOHeaders,
  traeUgHeaders,
  transformToSOLOBody
};
