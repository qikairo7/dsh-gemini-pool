import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { signRequestHuawei } from "./sign.js";
const OPENGW_GATEWAY_CONFIG_URL = "https://opengw.developer.huaweicloud.com/api/v1/gateway/config";
const SNAP_MODEL_BUILTIN_URL = "https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin";
const CODEARTS_MODELS_CACHE_FILENAME = "codearts_models.json";
const CODEARTS_BENEFIT_CACHE_FILENAME = "codearts_benefit_models.json";
const CODEARTS_BENEFIT_FALLBACK = ["glm-5.3-flash", "deepseek-v4.1-flash"];
const FETCH_TIMEOUT_MS = 1e4;
const MODEL_REFRESH_INTERVAL_MS = 2 * 36e5;
let memoryCache;
let benefitMemoryCache;
function normalizeModelId(id) {
  if (id.length > 5) {
    const suffix = id.slice(-5);
    if (suffix.startsWith("-") && /^\d{4}$/.test(suffix.slice(1))) {
      return id.slice(0, -5);
    }
  }
  return id;
}
function parseModelInfo(m, seen) {
  const rawId = m["model_id"];
  if (typeof rawId !== "string" || rawId.length === 0) return void 0;
  const id = normalizeModelId(rawId);
  if (id.includes("-VL-") || id.endsWith("-VL")) return void 0;
  const rawName = m["model_name"];
  const name = typeof rawName === "string" && rawName.length > 0 ? normalizeModelId(rawName) : id;
  if (seen.has(id)) return void 0;
  seen.add(id);
  return { id, name };
}
function extractJsonArray(text, path) {
  try {
    let value = JSON.parse(text);
    for (const key of path) {
      if (typeof value !== "object" || value === null) return void 0;
      value = value[key];
    }
    return Array.isArray(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
async function fetchSignedGet(fetcher, url, ak, sk, st, extraUnsignedHeaders) {
  const signed = await signRequestHuawei(ak, sk, st, "GET", url, new Uint8Array());
  const headers = new Headers();
  signed.forEach((v, k) => {
    if (k !== "host") headers.set(k, v);
  });
  if (extraUnsignedHeaders !== void 0) {
    for (const [k, v] of Object.entries(extraUnsignedHeaders)) headers.set(k, v);
  }
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) return void 0;
    return await response.text();
  } catch {
    return void 0;
  }
}
async function fetchCodeArtsRemoteModels(credential, fetcher = fetch) {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential;
  if (!ak || !sk) return [];
  const models = [];
  const seen = /* @__PURE__ */ new Set();
  const benefitIds = [];
  const gatewayText = await fetchSignedGet(fetcher, OPENGW_GATEWAY_CONFIG_URL, ak, sk, st);
  if (gatewayText !== void 0) {
    const arr = extractJsonArray(gatewayText, ["result", "models"]);
    if (arr !== void 0) {
      for (const item of arr) {
        if (typeof item === "object" && item !== null) {
          const entry = item;
          const rawId = typeof entry["model_id"] === "string" ? entry["model_id"] : "";
          const mi = parseModelInfo(entry, seen);
          if (mi) {
            if (rawId.length > 0 && normalizeModelId(rawId) === rawId) benefitIds.push(mi.id);
            models.push(mi);
          }
        }
      }
    }
  }
  const snapText = await fetchSignedGet(fetcher, SNAP_MODEL_BUILTIN_URL, ak, sk, st, {
    "Content-Type": "application/json",
    "Agent-Type": "PromptCenter",
    "X-Language": "zh-cn"
  });
  if (snapText !== void 0) {
    const arr = extractJsonArray(snapText, ["builtinModels"]);
    if (arr !== void 0) {
      for (const item of arr) {
        if (typeof item === "object" && item !== null) {
          const mi = parseModelInfo(item, seen);
          if (mi) models.push(mi);
        }
      }
    }
  }
  if (benefitIds.length > 0) {
    setBenefitMemoryCache(benefitIds);
    saveBenefitCache(benefitIds);
  }
  return models;
}
function cacheDir() {
  const override = process.env.DSH_CODEARTS_CACHE_DIR;
  if (override !== void 0 && override.length > 0) return override;
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) return void 0;
  return `${home}/.cache/deveco`;
}
function modelsCachePath() {
  const dir = cacheDir();
  return dir === void 0 ? void 0 : `${dir}/${CODEARTS_MODELS_CACHE_FILENAME}`;
}
function benefitCachePath() {
  const dir = cacheDir();
  return dir === void 0 ? void 0 : `${dir}/${CODEARTS_BENEFIT_CACHE_FILENAME}`;
}
function saveModelsCache(models) {
  const path = modelsCachePath();
  if (!path) return;
  const dir = path.slice(0, path.lastIndexOf("/"));
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(models), "utf-8");
    renameSync(tmp, path);
  } catch {
  }
}
function loadModelsCache() {
  const path = modelsCachePath();
  if (!path) return void 0;
  try {
    if (!existsSync(path)) return void 0;
    const text = readFileSync(path, "utf-8");
    const models = JSON.parse(text);
    return Array.isArray(models) && models.length > 0 ? models : void 0;
  } catch {
    return void 0;
  }
}
function availableCodeArtsModels() {
  if (memoryCache !== void 0) return memoryCache;
  const disk = loadModelsCache();
  if (disk !== void 0) {
    memoryCache = disk;
    return disk;
  }
  return void 0;
}
function setMemoryCache(models) {
  memoryCache = models;
}
function saveBenefitCache(ids) {
  const path = benefitCachePath();
  if (!path) return;
  const dir = path.slice(0, path.lastIndexOf("/"));
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(ids), "utf-8");
    renameSync(tmp, path);
  } catch {
  }
}
function loadBenefitCache() {
  const path = benefitCachePath();
  if (!path) return void 0;
  try {
    if (!existsSync(path)) return void 0;
    const text = readFileSync(path, "utf-8");
    const ids = JSON.parse(text);
    if (!Array.isArray(ids) || ids.length === 0) return void 0;
    return ids.filter((id) => typeof id === "string");
  } catch {
    return void 0;
  }
}
function setBenefitMemoryCache(ids) {
  benefitMemoryCache = ids;
}
function isCodeArtsBenefitModel(model) {
  if (benefitMemoryCache === void 0) benefitMemoryCache = loadBenefitCache();
  if (benefitMemoryCache !== void 0 && benefitMemoryCache.includes(model)) return true;
  return CODEARTS_BENEFIT_FALLBACK.includes(model);
}
export {
  CODEARTS_BENEFIT_FALLBACK,
  MODEL_REFRESH_INTERVAL_MS,
  OPENGW_GATEWAY_CONFIG_URL,
  SNAP_MODEL_BUILTIN_URL,
  availableCodeArtsModels,
  fetchCodeArtsRemoteModels,
  isCodeArtsBenefitModel,
  loadBenefitCache,
  loadModelsCache,
  normalizeModelId,
  saveBenefitCache,
  saveModelsCache,
  setBenefitMemoryCache,
  setMemoryCache
};
