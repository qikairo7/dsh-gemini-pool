import { credentialRef } from "@deepseek-ai/dsh-credentials";
import Schema from "@deepseek-ai/schemastery";
import { registerCodeArtsLlm } from "./llm-adapter.js";
import { registerBuddyLlm } from "./buddy-adapter.js";
import { registerLobsteraiLlm } from "./lobsterai-adapter.js";
import { registerQoderLlm } from "./qoder-adapter.js";
import { registerTraeLlm } from "./trae-adapter.js";
import { registerClineLlm } from "./cline-adapter.js";
import { registerLoomyLlm, parseLoomyRemoteModels } from "./loomy-adapter.js";
import { registerRaccoonLlm } from "./raccoon-adapter.js";
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from "./service.js";
import { BUDDY_CREDENTIAL_REF, BuddyAuth } from "./buddy-auth.js";
import { LobsteraiAuth } from "./lobsterai-auth.js";
import { QoderAuth } from "./qoder-auth.js";
import { TraeAuth } from "./trae-auth.js";
import { ClineAuth } from "./cline-auth.js";
import { LoomyAuth } from "./loomy-auth.js";
import { RaccoonAuth } from "./raccoon-auth.js";
import { LOOMY } from "./loomy-product.js";
import { LoomyBalanceSelector } from "./loomy-balance-selector.js";
import { RACCOON } from "./raccoon-product.js";
import { AccountPool } from "./account-pool.js";
import { hasLegacyNamespaceRegistration, settingsOf, suppressAutoSettingsPage } from "./settings-compat.js";
import { buildRaccoonNickname, registerJetHubRpc } from "./jet-hub-rpc.js";
import { CODEBUDDY, WORKBUDDY } from "./product.js";
import { LOBSTERAI } from "./lobsterai-product.js";
import { QODER } from "./qoder-product.js";
import { TRAE } from "./trae-product.js";
import { CLINE } from "./cline-product.js";
const name = "codearts-auth";
const inject = ["credentials", "commands", "llm"];
const Config = Schema.object({
  providers: Schema.dict(Schema.any()).default({}).volatile()
});
function registerProviderSettings(ctx, ...namespaces) {
  const settings = settingsOf(ctx);
  if (!hasLegacyNamespaceRegistration(settings) || settings?.register === void 0) return;
  for (const ns of namespaces) {
    try {
      settings.register(ns, Config);
    } catch (error) {
      ctx.logger.warn(`[codearts-auth] settings namespace "${ns}" \u6CE8\u518C\u5931\u8D25: ${String(error)}`);
    }
  }
  try {
    const descriptors = settings.describe?.({ redactSecrets: true }) ?? [];
    const registered = descriptors.map((v) => v.ns);
    const missing = namespaces.filter((ns) => !registered.includes(ns));
    if (missing.length > 0) {
      ctx.logger.warn(`[codearts-auth] provider namespace \u672A\u751F\u6548: ${missing.join(", ")}`);
    }
    ctx.logger.info(`[codearts-auth] settings.describe ok, namespaces: ${registered.join(", ")}`);
  } catch (error) {
    ctx.logger.error(
      `[codearts-auth] settings.describe \u5931\u8D25\uFF08\u5C06\u5BFC\u81F4\u6A21\u578B\u8BBE\u7F6E\u9875/sidebar settings API \u4E0D\u53EF\u7528\uFF09: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
  }
}
function makeReadImage(ctx) {
  return async (attachment) => {
    const attachments = ctx.get("attachments");
    if (attachments?.readImage === void 0) {
      throw new Error(
        "codearts-auth: \u9644\u4EF6\u670D\u52A1\uFF08attachments\uFF09\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u628A\u56FE\u7247\u5185\u8054\u8FDB\u8BF7\u6C42\uFF1B\u8BF7\u786E\u8BA4\u5F53\u524D profile \u5DF2\u88C5\u8F7D @deepseek-ai/dsh-attachment-local\u3002"
      );
    }
    const stored = await attachments.readImage(attachment);
    return { data: stored.data, mediaType: stored.ref.mediaType };
  };
}
function apply(ctx) {
  suppressAutoSettingsPage(ctx);
  registerProviderSettings(
    ctx,
    "llm-buddy",
    "llm-workbuddy",
    "llm-codearts",
    "llm-lobsterai",
    "llm-qoder",
    "llm-trae",
    "llm-cline",
    "llm-loomy",
    "llm-raccoon"
  );
  const service = new CodeArtsAuth(ctx);
  const pool = new AccountPool(ctx);
  void pool.pruneAccountsWithForeignDomain(WORKBUDDY).then((removed) => {
    if (removed.length > 0) {
      ctx.logger.info(
        `[jet-hub] \u5DF2\u6E05\u7406 ${removed.length} \u4E2A WorkBuddy \u65E7\u7248\uFF08\u4E2D\u56FD\u7248\uFF09\u8D26\u53F7\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\uFF1A${removed.join(", ")}`
      );
    }
  }).catch((error) => {
    ctx.logger.warn(`[jet-hub] \u6E05\u7406 WorkBuddy \u65E7\u7248\u8D26\u53F7\u5931\u8D25\uFF1A${String(error)}`);
  });
  const codearts = registerCodeArtsLlm(ctx, {
    credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount("codearts", "");
      return available?.credential;
    },
    // 续期按**账号池里的具体账号**走：`refreshAccountCredential` 读写的是
    // `CODEARTS_ACCOUNT_XXX`，而旧的 `service.refresh()` 读写的是已废弃的
    // 单凭据 ref —— 那会刷到另一个（不存在的）凭据上。
    refresh: async () => {
      const available = await pool.getAvailableAccount("codearts", "");
      if (available) await service.refreshAccountCredential(available.entry.credentialRef);
    },
    fetchRemoteModels: () => service.refreshModels(pool),
    accountPool: pool
  });
  const buddy = new BuddyAuth(ctx);
  const buddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(BUDDY_CREDENTIAL_REF),
    resolveCredential: async () => {
      if (pool) {
        const available = await pool.getAvailableAccount("buddy", "");
        if (available) return available.credential;
      }
      const resolved = await ctx.credentials.resolve(credentialRef(BUDDY_CREDENTIAL_REF));
      if (!resolved) return void 0;
      try {
        return JSON.parse(resolved.value);
      } catch {
        return void 0;
      }
    },
    refresh: () => buddy.refresh(),
    fetchRemoteModels: () => buddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: CODEBUDDY
  });
  const workbuddy = new BuddyAuth(ctx, { product: WORKBUDDY });
  const workbuddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(WORKBUDDY.defaultCredentialRef),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount("workbuddy", "");
      if (available) return available.credential;
      const resolved = await ctx.credentials.resolve(credentialRef(WORKBUDDY.defaultCredentialRef));
      if (!resolved) return void 0;
      try {
        return JSON.parse(resolved.value);
      } catch {
        return void 0;
      }
    },
    refresh: () => workbuddy.refresh(),
    fetchRemoteModels: () => workbuddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: WORKBUDDY
  });
  const lobsterai = new LobsteraiAuth(ctx);
  const lobsteraiAdapter = registerLobsteraiLlm(ctx, {
    credentialRef: credentialRef(LOBSTERAI.defaultCredentialRef),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount(LOBSTERAI.id, "");
      if (available) return available.credential;
      const resolved = await ctx.credentials.resolve(credentialRef(LOBSTERAI.defaultCredentialRef));
      if (!resolved) return void 0;
      try {
        return JSON.parse(resolved.value);
      } catch {
        return void 0;
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(LOBSTERAI.id, "");
      if (available) await lobsterai.refreshAccountCredential(available.entry.credentialRef);
      else await lobsterai.refresh();
    },
    fetchRemoteModels: () => lobsterai.fetchModels(pool),
    resolveClientVersion: () => lobsterai.resolveClientVersion(),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: LOBSTERAI
  });
  const qoder = new QoderAuth(ctx);
  const qoderAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER.defaultCredentialRef),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount(QODER.id, "");
      if (available) return available.credential;
      const resolved = await ctx.credentials.resolve(credentialRef(QODER.defaultCredentialRef));
      if (!resolved) return void 0;
      try {
        return JSON.parse(resolved.value);
      } catch {
        return void 0;
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(QODER.id, "");
      if (available) await qoder.refreshAccountCredential(available.entry.credentialRef);
      else await qoder.refresh();
    },
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: QODER
  });
  const trae = new TraeAuth(ctx);
  const traeAdapter = registerTraeLlm(ctx, {
    credentialRef: credentialRef(TRAE.defaultCredentialRef),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount(TRAE.id, "");
      if (available) return available.credential;
      const resolved = await ctx.credentials.resolve(credentialRef(TRAE.defaultCredentialRef));
      if (!resolved) return void 0;
      try {
        return JSON.parse(resolved.value);
      } catch {
        return void 0;
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(TRAE.id, "");
      if (available) await trae.refreshAccountCredential(available.entry.credentialRef);
      else await trae.refresh();
    },
    fetchRemoteModels: () => trae.fetchModels(pool),
    // 图片字节桥接：TRAE 上游**支持图片**（见 Issue #IKHDKC 的实测记录），
    // 但模态按模型判定（远端 `display_config.multimodal`），故这里只负责读字节。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: TRAE
  });
  const cline = new ClineAuth(ctx);
  const clineAdapter = registerClineLlm(ctx, {
    credentialRef: credentialRef(CLINE.defaultCredentialRef),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount(CLINE.id, "");
      if (available) return available.credential;
      const resolved = await ctx.credentials.resolve(credentialRef(CLINE.defaultCredentialRef));
      if (!resolved) return void 0;
      try {
        return JSON.parse(resolved.value);
      } catch {
        return void 0;
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(CLINE.id, "");
      if (available) await cline.refreshAccountCredential(available.entry.credentialRef);
      else await cline.refresh();
    },
    // 图片字节桥接：Cline 内嵌目录的 `capabilities` 含 `images`，
    // 模态按模型判定（见 ClineAdapter.inputModalitiesFor）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: CLINE
  });
  const loomy = new LoomyAuth(ctx);
  const resolveLoomyCredentialByRef = async (refName) => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName));
    if (!resolved) return void 0;
    try {
      return JSON.parse(resolved.value);
    } catch {
      return void 0;
    }
  };
  const loomyBalanceSelector = new LoomyBalanceSelector({
    product: LOOMY,
    resolveCredential: resolveLoomyCredentialByRef
  });
  const loomyAdapter = registerLoomyLlm(ctx, {
    credentialRef: credentialRef(LOOMY.defaultCredentialRef),
    /**
     * 解析本轮该用哪个账号的凭据。
     *
     * ⚠️ `modelId` 由适配器传入（见 `LoomyAdapterOptions.resolveCredential`
     * 的签名说明）—— **必须透传给 `getAvailableAccount`**，否则模型级限流
     * 过滤失效（早期实现传空串 `''`，等于「不按模型过滤」）。
     */
    resolveCredential: async (modelId) => {
      const candidates = pool.listAccountsByProvider(LOOMY.id).filter((a) => a.enabled).filter((a) => {
        const key = modelId ?? "";
        if (key.length === 0) return true;
        if (!a.modelRateLimits) return true;
        const resetAt = a.modelRateLimits[key];
        return resetAt === void 0 || resetAt === 0 || Date.now() >= resetAt;
      }).map((a) => ({ id: a.id, credentialRef: a.credentialRef }));
      const allowPermanent = !pool.loomyPermanentLocked();
      if (candidates.length > 0) {
        const picked = await loomyBalanceSelector.select(candidates, { allowPermanent });
        if (picked !== void 0) {
          const credential = await resolveLoomyCredentialByRef(picked.account.credentialRef);
          if (credential !== void 0) return credential;
        } else if (!allowPermanent) {
          throw new Error(
            "Loomy\uFF1A\u6CA1\u6709\u53EF\u7528\u8D26\u53F7\u3002\u5DF2\u9501\u5B9A\u6C38\u4E45\u79EF\u5206\uFF0C\u800C\u6240\u6709\u8D26\u53F7\u7684\u4ECA\u65E5\u8D60\u9001\u989D\u5EA6\u90FD\u5DF2\u7528\u5C3D\uFF08\u6216\u4F59\u989D\u67E5\u8BE2\u5931\u8D25\uFF09\u3002\u8BF7\u5728 Jet Hub \u7684 Loomy \u9762\u677F\u89E3\u9501\u6C38\u4E45\u79EF\u5206\uFF0C\u6216\u7B49\u5F85\u660E\u65E5\u989D\u5EA6\u5237\u65B0\u3002"
          );
        }
      }
      const resolved = await ctx.credentials.resolve(credentialRef(LOOMY.defaultCredentialRef));
      if (!resolved) return void 0;
      try {
        return JSON.parse(resolved.value);
      } catch {
        return void 0;
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(LOOMY.id, "");
      if (available) await loomy.refreshAccountCredential(available.entry.credentialRef);
      else await loomy.refresh();
    },
    // 远端模型目录：GET /api/v1/models。
    // ⚠️ 必须用 **token 头**（业务端点），不是 Bearer —— 带错会得到
    // `100002 缺少 token`，表现为「模型列表永远停在兜底表」。
    // 失败时返回空数组，由适配器回退兜底表。
    fetchRemoteModels: async () => {
      const available = await pool.getAvailableAccount(LOOMY.id, "");
      const resolved = available !== null && available !== void 0 ? { value: JSON.stringify(available.credential) } : await ctx.credentials.resolve(credentialRef(LOOMY.defaultCredentialRef));
      if (resolved === void 0) return [];
      let credential;
      try {
        credential = JSON.parse(resolved.value);
      } catch {
        return [];
      }
      const response = await fetch(`${LOOMY.apiBase}/models`, {
        headers: { Accept: "application/json", token: credential.access_token },
        signal: AbortSignal.timeout(3e4)
      });
      if (!response.ok) return [];
      return parseLoomyRemoteModels(await response.json());
    },
    // 图片字节桥接：按模型能力判定（远端 capabilities.input_modalities 含 image）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: LOOMY
  });
  const raccoon = new RaccoonAuth(ctx);
  const raccoonAdapter = registerRaccoonLlm(ctx, {
    credentialRef: credentialRef(RACCOON.defaultCredentialRef),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount(RACCOON.id, "");
      if (available) return available.credential;
      const resolved = await ctx.credentials.resolve(credentialRef(RACCOON.defaultCredentialRef));
      if (!resolved) return void 0;
      try {
        return JSON.parse(resolved.value);
      } catch {
        return void 0;
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(RACCOON.id, "");
      if (available) await raccoon.refreshAccountCredential(available.entry.credentialRef);
      else await raccoon.refresh();
    },
    // 远端模型目录：委托给 RaccoonAuth.fetchModels（它负责 Bearer 头与
    // visible 过滤 + raccoonDisplayName 生成含倍率的展示名）。
    // 失败时返回空数组，由适配器回退兜底表。
    fetchRemoteModels: () => raccoon.fetchModels(pool),
    // 图片字节桥接：按模型能力判定（远端 tags 含 vision）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: RACCOON
  });
  void raccoon.repairAccountNicknames(pool, buildRaccoonNickname).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] \u5DF2\u4FEE\u6B63 ${repaired.length} \u4E2A Raccoon \u8D26\u53F7\u7684\u663E\u793A\u540D\uFF08\u8FFD\u52A0\u624B\u673A\u53F7\u5C3E\u53F7\u4EE5\u4FBF\u533A\u5206\uFF09\uFF1A${repaired.join(", ")}`
      );
    }
  }).catch((error) => {
    ctx.logger.warn(`[jet-hub] \u4FEE\u6B63 Raccoon \u8D26\u53F7\u663E\u793A\u540D\u5931\u8D25\uFF1A${String(error)}`);
  });
  const REFRESH_INTERVAL_MS = 30 * 60 * 1e3;
  async function refreshAllCredentials() {
    try {
      await service.refreshAll(pool);
    } catch {
    }
    try {
      await buddy.refreshAll(pool);
    } catch {
    }
    try {
      await workbuddy.refreshAll(pool);
    } catch {
    }
    try {
      await lobsterai.refreshAll(pool);
    } catch {
    }
    try {
      await qoder.refreshAll(pool);
    } catch {
    }
    try {
      await trae.refreshAll(pool);
    } catch {
    }
    try {
      await cline.refreshAll(pool);
    } catch {
    }
    try {
      await loomy.refreshAll(pool);
    } catch {
    }
    try {
      await raccoon.refreshAll(pool);
    } catch {
    }
  }
  pool.listAllAccounts().then((accounts) => {
    const hasRefreshable = accounts.some((a) => a.refreshable);
    if (hasRefreshable) {
      const refreshTimer = setInterval(() => void refreshAllCredentials(), REFRESH_INTERVAL_MS);
      refreshTimer.unref?.();
      ctx.effect(() => () => {
        clearInterval(refreshTimer);
        service.stop();
        buddy.stop();
        workbuddy.stop();
        lobsterai.stop();
        qoder.stop();
        trae.stop();
        cline.stop();
        loomy.stop();
      }, "jet-hub: multi-account refresh scheduler");
    }
  });
  ctx.effect(() => () => {
    service.stop();
    buddy.stop();
    workbuddy.stop();
    lobsterai.stop();
    qoder.stop();
    trae.stop();
    cline.stop();
    loomy.stop();
  }, "codearts-auth.scheduler (legacy)");
  const modelAdapters = {
    // `codearts` 是 registerCodeArtsLlm 返回的**适配器实例**（与 CodeArtsAuth
    // 服务实例 `service` 不同名，故这里可以简写）。
    codearts,
    buddy: buddyAdapter,
    workbuddy: workbuddyAdapter,
    lobsterai: lobsteraiAdapter,
    qoder: qoderAdapter,
    trae: traeAdapter,
    cline: clineAdapter,
    loomy: loomyAdapter,
    raccoon: raccoonAdapter
  };
  registerJetHubRpc(ctx, pool, service, buddy, workbuddy, lobsterai, qoder, trae, cline, loomy, raccoon, modelAdapters);
  ctx.provide("accountPool", pool);
}
export {
  Config,
  apply,
  inject,
  makeReadImage,
  name
};
