import { clineHeaders } from "./cline.js";
import {
  CLINE_MODELS_PATH,
  CLINE_RECOMMENDED_MODELS_PATH
} from "./cline-product.js";
const CLINE_MODELS_TIMEOUT_MS = 2e4;
const FREE_ID_SUFFIX = ":free";
const FREE_ID_PREFIX = "cline-free/";
function isClineFreeModel(id, remoteFreeIds = /* @__PURE__ */ new Set(), fallback) {
  if (remoteFreeIds.has(id)) return true;
  if (id.endsWith(FREE_ID_SUFFIX)) return true;
  if (id.startsWith(FREE_ID_PREFIX)) return true;
  return fallback?.isFree === true;
}
function clineDisplayName(model) {
  return model.isFree ? `${model.name} \xB7 \u514D\u8D39` : model.name;
}
function nameFromId(id) {
  const slash = id.indexOf("/");
  const tail = slash >= 0 ? id.slice(slash + 1) : id;
  return tail.replace(FREE_ID_SUFFIX, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function parseEntryList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id.length === 0) continue;
    const name = typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : void 0;
    const description = typeof record.description === "string" && record.description.trim().length > 0 ? record.description.trim() : void 0;
    out.push({ id, ...name === void 0 ? {} : { name }, ...description === void 0 ? {} : { description } });
  }
  return out;
}
function parseClineRecommendedModels(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { free: [], recommended: [], clinePass: [] };
  }
  const record = value;
  return {
    free: parseEntryList(record.free),
    recommended: parseEntryList(record.recommended),
    clinePass: parseEntryList(record.clinePass)
  };
}
function parseClineRemoteModelIds(value) {
  if (typeof value !== "object" || value === null) return [];
  const data = value.data;
  if (!Array.isArray(data)) return [];
  const ids = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const id = item.id;
    if (typeof id === "string" && id.trim().length > 0) ids.push(id.trim());
  }
  return ids;
}
function mergeClineModels(product, remote) {
  const fallbackIndex = new Map(product.fallbackModels.map((model) => [model.id, model]));
  const remoteFreeIds = new Set(remote.freeIds);
  const entryIndex = new Map(remote.entries.map((entry) => [entry.id, entry]));
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const build = (id) => {
    const fallback = fallbackIndex.get(id);
    const entry = entryIndex.get(id);
    const name = fallback?.name ?? entry?.name ?? nameFromId(id);
    const description = entry?.description ?? fallback?.description;
    return {
      id,
      name,
      isFree: isClineFreeModel(id, remoteFreeIds, fallback),
      ...fallback?.contextWindow === void 0 ? {} : { contextWindow: fallback.contextWindow },
      ...fallback?.maxTokens === void 0 ? {} : { maxTokens: fallback.maxTokens },
      ...fallback?.supportsImage === void 0 ? {} : { supportsImage: fallback.supportsImage },
      ...description === void 0 ? {} : { description }
    };
  };
  const push = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(build(id));
  };
  for (const id of remote.freeIds) push(id);
  for (const model of product.fallbackModels) push(model.id);
  for (const entry of remote.entries) push(entry.id);
  for (const id of remote.remoteIds) push(id);
  return out;
}
async function fetchClineRemoteModels(product, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const warnings = [];
  const recommendedPromise = (async () => {
    try {
      const response = await fetcher(`${product.apiBase}${CLINE_RECOMMENDED_MODELS_PATH}`, {
        method: "GET",
        headers: { Accept: "application/json", ...product.clientHeaders },
        signal: options.signal ?? AbortSignal.timeout(CLINE_MODELS_TIMEOUT_MS)
      });
      if (!response.ok) {
        warnings.push(`recommended-models HTTP ${response.status}`);
        return { free: [], recommended: [], clinePass: [] };
      }
      return parseClineRecommendedModels(await response.json());
    } catch (error) {
      warnings.push(`recommended-models ${error instanceof Error ? error.message : String(error)}`);
      return { free: [], recommended: [], clinePass: [] };
    }
  })();
  const modelsPromise = (async () => {
    if (options.credential === void 0) return [];
    try {
      const response = await fetcher(`${product.apiBase}${CLINE_MODELS_PATH}`, {
        method: "GET",
        headers: clineHeaders(options.credential, product),
        signal: options.signal ?? AbortSignal.timeout(CLINE_MODELS_TIMEOUT_MS)
      });
      if (!response.ok) {
        warnings.push(`models HTTP ${response.status}`);
        return [];
      }
      return parseClineRemoteModelIds(await response.json());
    } catch (error) {
      warnings.push(`models ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  })();
  const [recommended, remoteIds] = await Promise.all([recommendedPromise, modelsPromise]);
  return {
    freeIds: recommended.free.map((entry) => entry.id),
    remoteIds,
    // `recommended` 与 `clinePass` 都进 entries：前者让推荐模型拿到
    // description，后者保证订阅制模型也能在列表里被发现（它们不是免费，
    // 但用户可能在 Cline 里已订阅）。
    entries: [...recommended.free, ...recommended.recommended, ...recommended.clinePass],
    warnings
  };
}
async function loadClineModels(product, options = {}) {
  const remote = await fetchClineRemoteModels(product, options);
  return { models: mergeClineModels(product, remote), warnings: remote.warnings };
}
export {
  CLINE_MODELS_TIMEOUT_MS,
  clineDisplayName,
  fetchClineRemoteModels,
  isClineFreeModel,
  loadClineModels,
  mergeClineModels,
  parseClineRecommendedModels,
  parseClineRemoteModelIds
};
