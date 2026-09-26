import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createUserMessage, LlmError } from "@deepseek-ai/dsh-llm";
import { BuddyAdapter } from "./buddy-adapter.js";
import { LobsteraiAdapter } from "./lobsterai-adapter.js";
import { TraeAdapter } from "./trae-adapter.js";
import { CodeArtsAdapter, isRateLimited, parseRateLimitError } from "./llm-adapter.js";
import { productById } from "./product.js";
import { lobsteraiProductById } from "./lobsterai-product.js";
const TRAE_PROVIDER_ID = "trae";
const PROBE_PROMPT = "\u53EA\u56DE\u7B54\u4E24\u4E2A\u5B57\uFF1A\u6536\u5230";
const PROBE_SYSTEM = "You are a helpful assistant.";
const PROBE_TIMEOUT_MS = 12e4;
function isRateLimitFailure(error) {
  if (error instanceof LlmError) {
    if (error.code === "RATE_LIMIT" || error.code === "QUOTA_EXCEEDED" || error.code === "QUOTA") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return isRateLimited(message);
}
async function probeWithAdapter(entry, credential, modelId, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const ref = credentialRef(entry.credentialRef);
  const buddyProduct = productById(entry.provider);
  const lobsteraiProduct = lobsteraiProductById(entry.provider);
  let adapter;
  if (buddyProduct !== void 0) {
    adapter = new BuddyAdapter({
      credentialRef: ref,
      resolveCredential: async () => credential,
      refresh: async () => {
      },
      product: buddyProduct
    });
  } else if (lobsteraiProduct !== void 0) {
    adapter = new LobsteraiAdapter({
      credentialRef: ref,
      resolveCredential: async () => credential,
      refresh: async () => {
      },
      product: lobsteraiProduct
    });
  } else if (entry.provider === TRAE_PROVIDER_ID) {
    adapter = new TraeAdapter({
      credentialRef: ref,
      resolveCredential: async () => credential,
      refresh: async () => {
      }
    });
  } else {
    adapter = new CodeArtsAdapter({
      credentialRef: ref,
      resolveCredential: async () => credential,
      refresh: async () => {
      }
    });
  }
  try {
    for await (const _chunk of adapter.stream({
      provider: entry.provider,
      model: modelId,
      messages: [createUserMessage({
        content: [{ type: "text", text: PROBE_PROMPT }],
        source: { kind: "user" }
      })],
      // ⚠️ **必须传 system**，否则 WorkBuddy 网关返回 400 + code 11128
      // 「first message is not system prompt」（伪装成安全策略拦截），
      // 使重测恒不可用。详见 PROBE_SYSTEM 的注释。
      system: PROBE_SYSTEM,
      signal
    })) {
    }
    return { modelId, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isRateLimitFailure(error)) {
      const parsed = parseRateLimitError(message, modelId);
      return {
        modelId,
        ok: false,
        message: `\u4ECD\u53D7\u9650\uFF1A${message}`,
        ...parsed !== null ? { resetTimeMs: parsed.resetTimeMs } : {}
      };
    }
    return { modelId, ok: false, message: `\u65E0\u6CD5\u786E\u8BA4\uFF1A${message}` };
  }
}
function makeDefaultProbe(pool, timeoutMs) {
  return async (entry, modelId) => {
    const credential = await pool.resolveCredentialForAccount(entry.id);
    if (credential === void 0) {
      return { modelId, ok: false, message: "\u65E0\u6CD5\u786E\u8BA4\uFF1A\u51ED\u636E\u4E0D\u53EF\u7528" };
    }
    return probeWithAdapter(entry, credential, modelId, timeoutMs);
  };
}
async function retestAccount(pool, accountId, deps = {}) {
  const entry = pool.findAccount(accountId);
  if (entry === void 0) {
    return { accountId, tested: 0, cleared: [], stillLimited: [], error: `\u8D26\u53F7 ${accountId} \u4E0D\u5B58\u5728` };
  }
  const modelIds = Object.keys(entry.modelRateLimits ?? {});
  const result = {
    accountId,
    nickname: entry.nickname,
    tested: modelIds.length,
    cleared: [],
    stillLimited: []
  };
  if (modelIds.length === 0) return result;
  const probe = deps.probe ?? makeDefaultProbe(pool, deps.timeoutMs ?? PROBE_TIMEOUT_MS);
  for (const modelId of modelIds) {
    const outcome = await probe(entry, modelId);
    if (outcome.ok) result.cleared.push(modelId);
    else result.stillLimited.push(outcome);
  }
  if (result.cleared.length > 0) {
    await pool.clearModelRateLimits(accountId, result.cleared);
  }
  for (const outcome of result.stillLimited) {
    if (outcome.resetTimeMs === void 0) continue;
    await pool.updateModelRateLimit(accountId, outcome.modelId, outcome.resetTimeMs);
  }
  return result;
}
async function retestAllAccounts(pool, provider, deps = {}) {
  const entries = pool.listAccountsByProvider(provider);
  const accounts = [];
  for (const entry of entries) {
    accounts.push(await retestAccount(pool, entry.id, deps));
  }
  return {
    accounts,
    clearedCount: accounts.reduce((sum, a) => sum + a.cleared.length, 0)
  };
}
async function resetAccount(pool, accountId) {
  const cleared = await pool.clearModelRateLimits(accountId);
  return { clearedCount: cleared, accountCount: cleared > 0 ? 1 : 0 };
}
async function resetAllAccounts(pool, provider) {
  const entries = pool.listAccountsByProvider(provider);
  let clearedCount = 0;
  let accountCount = 0;
  for (const entry of entries) {
    const cleared = await pool.clearModelRateLimits(entry.id);
    if (cleared > 0) {
      clearedCount += cleared;
      accountCount++;
    }
  }
  return { clearedCount, accountCount };
}
export {
  resetAccount,
  resetAllAccounts,
  retestAccount,
  retestAllAccounts
};
