/**
 * Live Antigravity model catalog.
 *
 * Antigravity rolls models out per account and lists the same model once per
 * thinking level ("gemini-3.8-flash-low/-medium/-high", plus a "-tiered" id
 * that thinks at the level the request asks). The previous static catalog
 * always advertised every model id and therefore offered models an account
 * did not have (issue #15/#16). This module turns one `fetchAvailableModels`
 * reply into the public model set, folds the level variants into one model
 * per family, and merges the per-account lists into the pool's union.
 *
 * The family folding follows yetone/magpie's Antigravity provider
 * (internal/provider/antigravity_models.go): an id with an effort word after
 * it belongs to the family before that word; a "-tiered" id is the family's
 * default variant; disabled entries are not offered at all.
 */
import {
  MODELS,
  baseModelMatcher,
  compareAntigravityModels,
  modelNameFromId,
} from "./models.js";

/** Effort words Antigravity puts after a family id, highest first. */
const EFFORT_SUFFIXES = [
  ["extra-high", "xhigh"],
  ["xhigh", "xhigh"],
  ["extra-low", "minimal"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
];

/** Public effort order, lowest first. */
export const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh"];

/** Split one runtime id into its family and the level its suffix names. */
export function splitRuntimeModelId(id) {
  const text = String(id || "");
  if (text.endsWith("-tiered") && text.length > "-tiered".length) {
    return { family: text.slice(0, -"-tiered".length), effort: "", tiered: true };
  }
  for (const [word, level] of EFFORT_SUFFIXES) {
    const suffix = `-${word}`;
    if (text.endsWith(suffix) && text.length > suffix.length) {
      return { family: text.slice(0, -suffix.length), effort: level, tiered: false };
    }
  }
  return { family: text, effort: "", tiered: false };
}

/** The level a display name's trailing "(High)" says, if any. */
export function effortFromDisplayName(name) {
  const match = String(name || "").match(/\s*\((minimal|low|medium|high|extra low|extra high|xhigh)\)\s*$/i);
  if (!match) return "";
  const word = match[1].toLowerCase();
  if (word === "extra low") return "minimal";
  if (word === "extra high") return "xhigh";
  return word;
}

/** A display name without the trailing level label. */
export function stripEffortLabel(name) {
  return String(name || "").replace(/\s*\((minimal|low|medium|high|extra low|extra high|xhigh)\)\s*$/i, "").trim();
}

/** Whether a display name spells a family id (dots and spaces normalised). */
function nameSpellsFamily(name, familyId) {
  const stripped = stripEffortLabel(name);
  if (!stripped) return false;
  const normalize = (value) => String(value).toLowerCase().replace(/\./g, "-").replace(/[\s_]+/g, "-");
  return normalize(stripped) === normalize(familyId);
}

function clampFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function modelProviderOf(info) {
  if (typeof info?.modelProvider === "string") return info.modelProvider;
  if (typeof info?.apiProvider === "string") return info.apiProvider;
  return undefined;
}

/**
 * Flatten one `fetchAvailableModels` reply into raw entries worth offering.
 * Internal chat/tab and disabled models are dropped: asking Google for them is
 * the 404 "Requested entity was not found" issue #15 logged.
 */
export function rawModelsFromAvailable(data) {
  const modelsObj = data && typeof data === "object" && data.models && typeof data.models === "object"
    ? data.models
    : {};
  const out = [];
  for (const [id, info] of Object.entries(modelsObj)) {
    if (!info || typeof info !== "object") continue;
    if (info.isInternal === true) continue;
    if (/^(chat_|tab_)/i.test(id)) continue;
    if (info.disabled === true) continue;
    if (!/^(gemini-|claude-|gpt-oss-)/i.test(id) || /\s/.test(id) || /^MODEL_/i.test(id)) continue;
    const quotaInfo = info.quotaInfo && typeof info.quotaInfo === "object" ? info.quotaInfo : {};
    out.push({
      id,
      displayName: typeof info.displayName === "string" ? info.displayName : "",
      maxTokens: positiveNumber(info.maxTokens),
      maxOutputTokens: positiveNumber(info.maxOutputTokens),
      supportsImages: typeof info.supportsImages === "boolean" ? info.supportsImages : undefined,
      remainingFraction: clampFraction(quotaInfo.remainingFraction),
      resetTime: quotaInfo.resetTime ? String(quotaInfo.resetTime) : undefined,
      modelProvider: modelProviderOf(info),
      recommended: info.recommended === true,
    });
  }
  return out;
}

function preferredEffort(raw) {
  const fromName = effortFromDisplayName(raw.displayName);
  if (fromName) return fromName;
  const split = splitRuntimeModelId(raw.id);
  if (split.tiered) return "";
  return split.effort;
}

function quotaOf(variants) {
  const withQuota = variants.filter((raw) => typeof raw.remainingFraction === "number");
  const best = (withQuota.length ? withQuota : variants).reduce((left, right) => {
    const leftValue = typeof left.remainingFraction === "number" ? left.remainingFraction : -1;
    const rightValue = typeof right.remainingFraction === "number" ? right.remainingFraction : -1;
    return rightValue > leftValue ? right : left;
  }, variants[0]);
  return {
    remainingFraction: best?.remainingFraction,
    resetTime: best?.resetTime,
    suggested: best?.recommended === true,
  };
}

function metricsOf(variants, fallback) {
  const numbers = (key) => variants.map((v) => v[key]).filter((v) => typeof v === "number" && v > 0);
  const contextValues = numbers("maxTokens");
  const outputValues = numbers("maxOutputTokens");
  const contextWindow = contextValues.length ? Math.min(...contextValues) : fallback.contextWindow;
  const maxTokens = outputValues.length ? Math.min(...outputValues) : fallback.maxTokens;
  const imageSupport = variants.map((v) => v.supportsImages).filter((v) => typeof v === "boolean");
  const inputModalities = imageSupport.length && imageSupport.every((v) => v === false)
    ? fallback.inputModalities.filter((m) => m !== "image")
    : fallback.inputModalities;
  return { contextWindow, maxTokens, inputModalities };
}

/**
 * Build the runtime map and offered efforts for one family from its variants.
 * A variant's display name wins over its id suffix when it names a level,
 * because Antigravity's ids and names disagree for 3.5 Flash (extra-low is
 * "(Low)" and low is "(Medium)").
 */
function familyRuntime(variants) {
  const byEffort = {};
  let defaultId;
  let tieredId;
  for (const raw of variants) {
    const split = splitRuntimeModelId(raw.id);
    if (split.tiered) {
      tieredId = raw.id;
      continue;
    }
    const effort = preferredEffort(raw);
    if (effort && !byEffort[effort]) byEffort[effort] = raw.id;
    if (!split.effort && !defaultId) defaultId = raw.id;
  }
  defaultId = tieredId || defaultId || byEffort.high || byEffort.medium || byEffort.low || byEffort.minimal || variants[0]?.id;
  for (const effort of EFFORT_ORDER) {
    if (!byEffort[effort]) byEffort[effort] = defaultId;
  }
  const efforts = EFFORT_ORDER.filter((effort) => variants.some((raw) => preferredEffort(raw) === effort));
  return {
    runtimeModels: { "": defaultId, ...byEffort },
    reasoningEfforts: efforts,
  };
}

function makeModel(base, variants) {
  const metrics = metricsOf(variants, base);
  const runtime = familyRuntime(variants);
  const quota = quotaOf(variants);
  const name = base.name || modelNameFromId(base.id);
  // A "-tiered" variant thinks at whatever level the request asks, so it
  // carries the whole family's levels even when Antigravity listed only one
  // concrete level beside it.
  const hasTiered = variants.some((variant) => splitRuntimeModelId(variant.id).tiered);
  const efforts = hasTiered
    ? [...new Set([...runtime.reasoningEfforts, ...(base.reasoningEfforts || [])])].sort(
        (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
      )
    : runtime.reasoningEfforts;
  return {
    id: base.id,
    name,
    inputModalities: metrics.inputModalities,
    contextWindow: metrics.contextWindow,
    maxTokens: metrics.maxTokens,
    reasoningEfforts: efforts.length ? efforts : [...(base.reasoningEfforts || [])],
    available: true,
    remainingFraction: quota.remainingFraction,
    resetTime: quota.resetTime,
    suggested: quota.suggested,
    modelProvider: variants.find((v) => v.modelProvider)?.modelProvider,
    runtimeModels: runtime.runtimeModels,
    source: "live",
  };
}

function displayNameForFamily(family, variants) {
  const spelled = variants.find((raw) => nameSpellsFamily(raw.displayName, family));
  const named = spelled?.displayName || variants.find((raw) => raw.displayName)?.displayName;
  if (named && nameSpellsFamily(named, family)) return stripEffortLabel(named);
  return "";
}

/**
 * Turn one account's raw model list into public models.
 *
 * Known public families keep their stable ids (gemini-3.8-flash etc.) so
 * existing enabledModelIds survive; anything Antigravity adds later (Gemini 4
 * Argon, for example) becomes its own family automatically.
 */
export function buildCatalogFromRawModels(rawModels) {
  const remaining = new Set(rawModels.map((raw) => raw.id));
  const models = [];

  for (const base of MODELS) {
    const matcher = baseModelMatcher(base.id);
    const variants = rawModels.filter((raw) =>
      remaining.has(raw.id) && (matcher(raw.id) || nameSpellsFamily(raw.displayName, base.id)));
    if (!variants.length) continue;
    for (const raw of variants) remaining.delete(raw.id);
    models.push(makeModel(base, variants));
  }

  const families = new Map();
  for (const raw of rawModels) {
    if (!remaining.has(raw.id)) continue;
    const family = splitRuntimeModelId(raw.id).family;
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(raw);
  }
  for (const [family, variants] of families) {
    const fallbackName = displayNameForFamily(family, variants) || modelNameFromId(family);
    const runtime = familyRuntime(variants);
    const metrics = metricsOf(variants, {
      id: family,
      name: fallbackName,
      inputModalities: /gpt-oss/i.test(family) ? ["text"] : ["text", "image"],
      contextWindow: /claude/i.test(family) ? 200000 : /gpt-oss/i.test(family) ? 131072 : 1048576,
      maxTokens: /claude/i.test(family) ? 64000 : /gpt-oss/i.test(family) ? 32768 : 65536,
      reasoningEfforts: [],
    });
    const quota = quotaOf(variants);
    models.push({
      id: family,
      name: fallbackName,
      inputModalities: metrics.inputModalities,
      contextWindow: metrics.contextWindow,
      maxTokens: metrics.maxTokens,
      reasoningEfforts: runtime.reasoningEfforts,
      available: true,
      remainingFraction: quota.remainingFraction,
      resetTime: quota.resetTime,
      suggested: quota.suggested,
      modelProvider: variants.find((v) => v.modelProvider)?.modelProvider,
      runtimeModels: runtime.runtimeModels,
      source: "live",
    });
  }

  // A model name another family also claims is ambiguous; name it by its id.
  const byName = new Map();
  for (const model of models) {
    const key = model.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(model);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const model of group) {
      if (!nameSpellsFamily(model.name, model.id)) model.name = modelNameFromId(model.id);
    }
  }

  return models.sort(compareAntigravityModels);
}

/**
 * Merge every account's catalog into the pool union. A model available on any
 * enabled account is offered; quotas keep the best value found; capabilities
 * keep the least any variant supports so routing never promises more than a
 * guest account can deliver.
 */
export function mergeCatalogModels(lists) {
  const byId = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const model of list) {
      if (!model || typeof model.id !== "string" || !model.id) continue;
      const current = byId.get(model.id);
      if (!current) {
        byId.set(model.id, {
          ...model,
          runtimeModels: { ...(model.runtimeModels || {}) },
          reasoningEfforts: [...(model.reasoningEfforts || [])],
        });
        continue;
      }
      const mergedRuntime = { ...(current.runtimeModels || {}) };
      for (const [effort, id] of Object.entries(model.runtimeModels || {})) {
        if (!mergedRuntime[effort] || effort === "") mergedRuntime[effort] = id;
      }
      const efforts = [...new Set([...(current.reasoningEfforts || []), ...(model.reasoningEfforts || [])])]
        .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
      const currentQuota = typeof current.remainingFraction === "number" ? current.remainingFraction : -1;
      const nextQuota = typeof model.remainingFraction === "number" ? model.remainingFraction : -1;
      const finite = (...values) => values.filter((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
      const contexts = finite(current.contextWindow, model.contextWindow);
      const outputs = finite(current.maxTokens, model.maxTokens);
      byId.set(model.id, {
        ...current,
        ...(nextQuota > currentQuota
          ? { remainingFraction: model.remainingFraction, resetTime: model.resetTime }
          : {}),
        inputModalities: Array.isArray(current.inputModalities) && Array.isArray(model.inputModalities)
          ? current.inputModalities.filter((m) => model.inputModalities.includes(m))
          : current.inputModalities,
        ...(contexts.length ? { contextWindow: Math.min(...contexts) } : {}),
        ...(outputs.length ? { maxTokens: Math.min(...outputs) } : {}),
        reasoningEfforts: efforts,
        runtimeModels: mergedRuntime,
        available: current.available !== false || model.available !== false,
        suggested: current.suggested === true || model.suggested === true,
      });
    }
  }
  return [...byId.values()].sort(compareAntigravityModels);
}

/** Resolve the runtime id one public model sends for a requested effort. */
export function runtimeModelForEffort(model, effort) {
  const map = model?.runtimeModels && typeof model.runtimeModels === "object" ? model.runtimeModels : undefined;
  if (!map) return undefined;
  if (effort === undefined || effort === null || effort === "" || effort === "off") {
    return map[""] || map.default || map.high || map.medium || map.low || map.minimal;
  }
  return map[effort] || map.high || map.medium || map.low || map.minimal || map[""];
}

/** The other runtime variants worth retrying after a 404/5xx. */
export function fallbackRuntimeModels(model, current) {
  const map = model?.runtimeModels && typeof model.runtimeModels === "object" ? model.runtimeModels : undefined;
  if (!map) return [];
  const order = ["", "high", "medium", "low", "xhigh", "minimal"];
  const out = [];
  for (const key of order) {
    const id = map[key];
    if (typeof id === "string" && id && id !== current && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Human label for a public model's quota/setting row. */
export function catalogModelToOption(model, enabled) {
  return {
    id: model.id,
    name: model.name,
    inputModalities: model.inputModalities,
    reasoningEfforts: model.reasoningEfforts,
    enabled,
    available: model.available !== false,
    ...(typeof model.remainingFraction === "number"
      ? { remainingFraction: model.remainingFraction }
      : {}),
    ...(model.resetTime ? { resetTime: model.resetTime } : {}),
    ...(model.suggested ? { suggested: true } : {}),
  };
}
