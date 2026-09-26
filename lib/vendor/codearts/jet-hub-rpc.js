import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { LOOMY } from "./loomy-product.js";
import { RACCOON } from "./raccoon-product.js";
import { LOOMY_TASK_POINTS, LOOMY_TASK_TITLES } from "./loomy-onboarding.js";
import { LOBSTERAI } from "./lobsterai-product.js";
import { QODER } from "./qoder-product.js";
import { TRAE } from "./trae-product.js";
import { CLINE } from "./cline-product.js";
import { isLobsteraiRefreshable, lobsteraiCredentialExpiresAtMs } from "./lobsterai.js";
import {
  fetchQoderUserNickname,
  isQoderRefreshable,
  qoderCredentialExpiresAtMs,
  withQoderNickname
} from "./qoder.js";
import { claimQoderDailyCheckin, fetchQoderCreditBalance } from "./qoder-credits.js";
import { isTraeRefreshable, traeCredentialExpiresAtMs } from "./trae.js";
import { fetchClineCreditBalance } from "./cline-credits.js";
import {
  clineCredentialExpiresAtMs,
  isClineRefreshable
} from "./cline.js";
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from "./buddy-oauth.js";
import { credentialExpiresAtMs } from "./buddy.js";
import {
  claimDailyCheckin,
  fetchCheckinStatus,
  fetchCreditBalance
} from "./credits.js";
import { CODEBUDDY, productById } from "./product.js";
import {
  claimLobsteraiDailyCheckin,
  fetchLobsteraiCreditBalance
} from "./lobsterai-credits.js";
import {
  claimCodeArtsDailyCheckin,
  fetchCodeArtsAccountInfoDetailed
} from "./codearts-credits.js";
import {
  claimTraeDailyCheckin,
  fetchTraeCheckinStatus,
  fetchTraeCreditBalance
} from "./trae-credits.js";
import {
  resetAccount,
  resetAllAccounts,
  retestAccount,
  retestAllAccounts
} from "./account-probe.js";
import { exportBackup, importBackup } from "./backup.js";
const JET_HUB_API_PATH = "/api/jet-hub";
const JET_HUB_ENDPOINT = "jet-hub";
function shortId() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function parseBuddyCredential(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && typeof parsed.access_token === "string" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function parseCodeArtsCredential(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && typeof parsed.access_key_id === "string" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function parseLobsteraiCredential(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && typeof parsed.access_token === "string" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function parseQoderCredential(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && typeof parsed.access_token === "string" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function parseTraeCredential(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && typeof parsed.access_token === "string" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function parseClineCredential(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && typeof parsed.access_token === "string" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function buildRaccoonNickname(credential, fallbackId) {
  const nickname = typeof credential.nickname === "string" ? credential.nickname.trim() : "";
  const phone = typeof credential.phone === "string" ? credential.phone.trim() : "";
  const userId = typeof credential.user_id === "string" ? credential.user_id.trim() : "";
  const suffix = phone.length >= 4 ? phone.slice(-4) : userId.length > 0 ? userId : "";
  if (nickname.length > 0) {
    return suffix.length > 0 && !nickname.includes(suffix) ? `${nickname} (${suffix})` : nickname;
  }
  if (suffix.length > 0) return `Raccoon ${suffix}`;
  return fallbackId;
}
function computeClaimSummary(outcomes) {
  const summary = {
    claimed: 0,
    totalCredit: 0,
    alreadyClaimed: 0,
    inactive: 0,
    failed: 0
  };
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case "claimed":
        summary.claimed += 1;
        summary.totalCredit += outcome.credit;
        break;
      case "already-claimed":
        summary.alreadyClaimed += 1;
        break;
      case "inactive":
        summary.inactive += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      default: {
        const exhaustive = outcome;
        void exhaustive;
        summary.failed += 1;
        break;
      }
    }
  }
  return summary;
}
async function collectCreditsStatus(accounts, product, deps) {
  const fetcher = deps.fetcher ?? fetch;
  const fetchStatus = deps.fetchStatus ?? (async (credential, product2) => fetchCheckinStatus(
    credential,
    product2,
    fetcher
  ));
  const results = [];
  for (const entry of accounts) {
    let status = null;
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef));
      if (resolved !== void 0) {
        const credential = JSON.parse(resolved.value);
        status = await fetchStatus(credential, product);
      }
    } catch (error) {
      deps.warn?.(`[jet-hub] credits.status \u8D26\u53F7 ${entry.id} \u5931\u8D25: ${String(error)}`);
      status = null;
    }
    results.push({ accountId: entry.id, nickname: entry.nickname, status });
  }
  return results;
}
async function collectClaimResults(accounts, product, deps) {
  const fetcher = deps.fetcher ?? fetch;
  const fetchStatus = deps.fetchStatus ?? (async (credential, product2) => fetchCheckinStatus(
    credential,
    product2,
    fetcher
  ));
  const claim = deps.claim ?? (async (credential, product2) => claimDailyCheckin(
    credential,
    product2,
    fetcher
  ));
  const precheck = deps.precheckStatus !== false;
  const results = [];
  const outcomes = [];
  for (const entry of accounts) {
    let outcome;
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef));
      if (resolved === void 0) {
        outcome = { kind: "failed", code: -1, message: "\u51ED\u636E\u672A\u914D\u7F6E" };
      } else {
        const credential = JSON.parse(resolved.value);
        if (!precheck) {
          outcome = await claim(credential, product, entry);
        } else {
          const status = await fetchStatus(credential, product);
          if (status !== null && !status.active) {
            outcome = { kind: "inactive", message: "\u7B7E\u5230\u6D3B\u52A8\u672A\u5F00\u542F" };
          } else if (status !== null && status.todayCheckedIn) {
            outcome = { kind: "already-claimed", message: "\u4ECA\u5929\u5DF2\u7B7E\u5230" };
          } else {
            outcome = await claim(credential, product, entry);
          }
        }
      }
    } catch (error) {
      deps.warn?.(`[jet-hub] credits.claimAll \u8D26\u53F7 ${entry.id} \u5931\u8D25: ${String(error)}`);
      outcome = {
        kind: "failed",
        code: -1,
        message: error instanceof Error ? error.message : String(error)
      };
    }
    outcomes.push(outcome);
    results.push({ accountId: entry.id, nickname: entry.nickname, outcome });
  }
  return { results, summary: computeClaimSummary(outcomes) };
}
async function collectCreditBalances(accounts, product, deps) {
  const fetcher = deps.fetcher ?? fetch;
  const fetchBalance = deps.fetchBalance ?? (async (credential, product2) => fetchCreditBalance(
    credential,
    product2,
    fetcher
  ));
  const fetchDetailed = deps.fetchBalanceDetailed;
  const results = [];
  for (const entry of accounts) {
    let balance = null;
    let error;
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef));
      if (resolved === void 0) {
        error = "\u51ED\u636E\u672A\u914D\u7F6E";
      } else {
        const credential = JSON.parse(resolved.value);
        if (fetchDetailed !== void 0) {
          const detailed = await fetchDetailed(credential, product);
          balance = detailed.balance;
          error = detailed.error;
          if (balance === null && error === void 0) error = "\u4F59\u989D\u67E5\u8BE2\u5931\u8D25";
        } else {
          balance = await fetchBalance(credential, product);
          if (balance === null) error = "\u4F59\u989D\u67E5\u8BE2\u5931\u8D25";
        }
      }
    } catch (caught) {
      deps.warn?.(`[jet-hub] credits.balances \u8D26\u53F7 ${entry.id} \u5931\u8D25: ${String(caught)}`);
      error = caught instanceof Error ? caught.message : String(caught);
      balance = null;
    }
    results.push({
      accountId: entry.id,
      nickname: entry.nickname,
      balance,
      ...error === void 0 ? {} : { error }
    });
  }
  return results;
}
function llmServiceOf(ctx) {
  return ctx.get("llm");
}
function registerJetHubRpc(ctx, pool, codearts, buddy, workbuddy, lobsterai, qoder, trae, cline, loomy, raccoon, modelAdapters) {
  ctx.inject(["connection"], (connectionCtx) => {
    registerJetHubEndpoints(
      connectionCtx,
      pool,
      codearts,
      buddy,
      workbuddy,
      lobsterai,
      qoder,
      trae,
      cline,
      loomy,
      raccoon,
      modelAdapters
    );
  });
}
function broadcastCatalogChanged(ctx) {
  try {
    ctx.emit("llm/adapters-updated");
  } catch (error) {
    ctx.logger.warn(`[jet-hub] \u5E7F\u64AD\u6A21\u578B\u76EE\u5F55\u53D8\u66F4\u4E8B\u4EF6\u5931\u8D25\uFF1A${String(error)}`);
  }
}
function registerJetHubEndpoints(ctx, pool, codearts, buddy, workbuddy, lobsterai, qoder, trae, cline, loomy, raccoon, modelAdapters) {
  const connection = ctx.connection ?? ctx.get("connection");
  if (!connection || typeof connection.fetch?.register !== "function") {
    ctx.logger.warn("[jet-hub] connection.fetch not available, RPC endpoints not registered");
    return;
  }
  const pendingSmsMsgid = /* @__PURE__ */ new Map();
  connection.fetch.register({
    path: JET_HUB_API_PATH,
    methods: ["POST"],
    requestBody: "buffered",
    async fetch(request) {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
      }
      let message;
      try {
        message = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      const rpcId = typeof message.rpcId === "string" ? message.rpcId : "invalid-request";
      const call = message.payload;
      if (message.type !== "client-request" || typeof message.rpcId !== "string" || message.method !== JET_HUB_ENDPOINT || !call || typeof call.method !== "string" || !Object.prototype.hasOwnProperty.call(call, "payload")) {
        return reply(rpcId, { ok: false, error: { code: "gateway/bad-request", message: "Invalid Jet Hub management request." } });
      }
      try {
        const result = await handleMethod(call.method, call.payload, request.signal);
        return reply(rpcId, result);
      } catch (error) {
        const message2 = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`[jet-hub] ${String(call.method)} failed: ${message2}`);
        return reply(rpcId, {
          ok: false,
          error: { code: "jet-hub/handler-failed", message: message2 }
        });
      }
    }
  });
  async function handleMethod(method, payload, _signal) {
    switch (method) {
      case "account.list": {
        const req = payload;
        const accounts = await pool.listAccounts(req.provider);
        return { ok: true, value: { accounts } };
      }
      case "account.create": {
        const req = payload;
        const { provider } = req;
        const id = `${provider}-${shortId()}`;
        const suffix = shortId().toUpperCase();
        const refName = `${provider.toUpperCase()}_ACCOUNT_${suffix}`;
        const product = productById(provider);
        if (product !== void 0) {
          let state;
          let authUrl;
          try {
            const authState = await fetchAuthState(void 0, void 0, product);
            state = authState.state;
            authUrl = decorateLoginUrl(authState.authUrl, product);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`\u65E0\u6CD5\u83B7\u53D6 ${product.displayName} \u767B\u5F55\u5730\u5740\uFF08Host \u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25\uFF09\uFF1A${reason}`);
          }
          const ref = credentialRef(refName);
          await pool.addAccount({
            id,
            provider: product.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now()
          });
          runBuddyLoginFlow({ openBrowser: () => {
          }, state, product }).then(async (flow) => {
            await ctx.credentials.set(ref, flow.access);
            (product.id === CODEBUDDY.id ? buddy : workbuddy).scheduleRefresh();
            const credential = parseBuddyCredential(flow.access);
            await pool.updateAccount(id, {
              nickname: credential?.nickname ?? id,
              // Buddy 的 expires_at 是字符串形式的毫秒时间戳，
              // 必须用 credentialExpiresAtMs 解析（Date.parse 对纯数字串会得到 NaN）。
              expiresAt: credential ? credentialExpiresAtMs(credential) : void 0,
              refreshable: Boolean(credential?.refresh_token)
            });
          }).catch((err) => {
            ctx.logger.warn(`[jet-hub] background ${product.id} login failed for ${id}: ${err}`);
            void pool.removeAccount(id).catch(() => {
            });
          });
          return { ok: true, value: { accountId: id, loginUrl: authUrl } };
        } else if (provider === "codearts") {
          const started = await codearts.startLogin({ refName });
          await pool.addAccount({
            id,
            provider: "codearts",
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now()
          });
          started.result.then(async (loginResult) => {
            const credential = parseCodeArtsCredential(loginResult.access);
            await pool.updateAccount(id, {
              nickname: credential?.user_name !== void 0 && credential.user_name.length > 0 ? credential.user_name : id,
              expiresAt: credential?.expires_at !== void 0 ? Number.isNaN(Date.parse(credential.expires_at)) ? void 0 : Date.parse(credential.expires_at) : void 0,
              refreshable: Boolean(credential?.refresh_token)
            });
          }).catch((error) => {
            ctx.logger.warn(`[jet-hub] background codearts login failed for ${id}: ${String(error)}`);
            void pool.removeAccount(id).catch(() => {
            });
          });
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
        } else if (provider === LOBSTERAI.id) {
          const started = await lobsterai.startLogin({ refName });
          await pool.addAccount({
            id,
            provider: LOBSTERAI.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now()
          });
          started.result.then(async (loginResult) => {
            const credential = parseLobsteraiCredential(loginResult.access);
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== void 0 && credential.nickname.length > 0 ? credential.nickname : id,
              expiresAt: credential !== void 0 ? lobsteraiCredentialExpiresAtMs(credential) : void 0,
              refreshable: credential !== void 0 && isLobsteraiRefreshable(credential)
            });
          }).catch((error) => {
            ctx.logger.warn(`[jet-hub] background ${LOBSTERAI.id} login failed for ${id}: ${String(error)}`);
            void pool.removeAccount(id).catch(() => {
            });
          });
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
        } else if (provider === QODER.id) {
          const started = await qoder.startLogin({ refName });
          await pool.addAccount({
            id,
            provider: QODER.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now()
          });
          started.result.then(async (loginResult) => {
            const credential = parseQoderCredential(loginResult.access);
            let nickname = credential?.nickname;
            if ((nickname === void 0 || nickname.length === 0) && credential !== void 0) {
              nickname = await fetchQoderUserNickname(credential, QODER);
              if (nickname !== void 0 && loginResult.access.length > 0) {
                const updated = withQoderNickname(credential, nickname);
                await ctx.credentials.set(credentialRef(refName), JSON.stringify(updated));
              }
            }
            await pool.updateAccount(id, {
              nickname: nickname !== void 0 && nickname.length > 0 ? nickname : id,
              expiresAt: credential !== void 0 ? qoderCredentialExpiresAtMs(credential) : void 0,
              refreshable: credential !== void 0 && isQoderRefreshable(credential)
            });
          }).catch((error) => {
            ctx.logger.warn(`[jet-hub] background ${QODER.id} login failed for ${id}: ${String(error)}`);
            void pool.removeAccount(id).catch(() => {
            });
          });
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
        } else if (provider === TRAE.id) {
          const started = await trae.startLogin({ refName });
          await pool.addAccount({
            id,
            provider: TRAE.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now()
          });
          started.result.then(async (loginResult) => {
            const credential = parseTraeCredential(loginResult.access);
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== void 0 && credential.nickname.length > 0 ? credential.nickname : id,
              expiresAt: credential !== void 0 ? traeCredentialExpiresAtMs(credential) : void 0,
              refreshable: credential !== void 0 && isTraeRefreshable(credential)
            });
          }).catch((error) => {
            ctx.logger.warn(`[jet-hub] background ${TRAE.id} login failed for ${id}: ${String(error)}`);
            void pool.removeAccount(id).catch(() => {
            });
          });
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
        } else if (provider === CLINE.id) {
          const started = await cline.startLogin({ refName });
          await pool.addAccount({
            id,
            provider: CLINE.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now()
          });
          started.result.then(async (loginResult) => {
            const credential = parseClineCredential(loginResult.access);
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== void 0 && credential.nickname.length > 0 ? credential.nickname : id,
              expiresAt: credential !== void 0 ? clineCredentialExpiresAtMs(credential) : void 0,
              refreshable: credential !== void 0 && isClineRefreshable(credential)
            });
          }).catch((error) => {
            ctx.logger.warn(`[jet-hub] background ${CLINE.id} login failed for ${id}: ${String(error)}`);
            void pool.removeAccount(id).catch(() => {
            });
          });
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
        } else if (provider === LOOMY.id) {
          await pool.addAccount({
            id,
            provider: LOOMY.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now()
          });
          let started;
          try {
            started = await loomy.startWechatLogin();
          } catch (error) {
            void pool.removeAccount(id).catch(() => {
            });
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`\u65E0\u6CD5\u542F\u52A8 Loomy \u5FAE\u4FE1\u767B\u5F55\uFF08\u83B7\u53D6\u4E8C\u7EF4\u7801\u5931\u8D25\uFF09\uFF1A${reason}`);
          }
          started.result.then(async (login) => {
            const result = await loomy.persistWechatLogin(login, { refName });
            const credential = JSON.parse(result.access);
            await pool.updateAccount(id, {
              // 用手机号尾号让多账号可区分（Loomy 无独立昵称接口；
              // 微信昵称可能有，优先用它）。
              nickname: login.nickname !== void 0 && login.nickname.length > 0 ? login.nickname : credential.phone.length >= 4 ? `Loomy ${credential.phone.slice(-4)}` : id,
              expiresAt: result.expires > 0 ? result.expires : void 0,
              // ⚠️ 恒 false：Loomy 无续期端点。
              refreshable: false
            });
          }).catch((error) => {
            ctx.logger.warn(`[jet-hub] background ${LOOMY.id} wechat login failed for ${id}: ${String(error)}`);
            void pool.removeAccount(id).catch(() => {
            });
          });
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } };
        } else if (provider === RACCOON.id) {
          await pool.addAccount({
            id,
            provider: RACCOON.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now()
          });
          let raccoonStarted;
          try {
            raccoonStarted = await raccoon.startLogin();
          } catch (error) {
            void pool.removeAccount(id).catch(() => {
            });
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`\u65E0\u6CD5\u542F\u52A8 Raccoon \u767B\u5F55\uFF08\u672C\u5730\u767B\u5F55\u9875\u542F\u52A8\u5931\u8D25\uFF09\uFF1A${reason}`);
          }
          raccoonStarted.result.then(async (credential) => {
            const result = await raccoon.persistLogin(credential, { refName });
            const saved = JSON.parse(result.access);
            await pool.updateAccount(id, {
              // ⚠️ 服务端的 `name` 是**自动生成的默认名**（本机账号是
              // `RaccoonAva`，即「Raccoon」+ 随机串），微信扫码**不回传微信昵称**
              //（`wechat_bindings` 只有绑定 id 与时间，无昵称/头像）。
              // 它是账号的**正式名字**（JWT payload 里也有 `name`，官方客户端
              // 就显示它），故**保留**；但若注册第二个账号，服务端很可能又给一个
              // 相近的默认名 → 多账号重名、无法区分。
              //
              // 故追加**手机号尾号**消歧：`RaccoonAva (6665)`。
              // 与 Loomy 的 `Loomy 2222` 同策略（那边没有真实名字可用，
              // 这边有，所以保留原名再挂尾号）。
              nickname: buildRaccoonNickname(saved, id),
              expiresAt: result.expires > 0 ? result.expires : void 0,
              // ⚠️ raccoon **有** refresh 端点，与 Loomy（恒 false）不同。
              refreshable: result.refreshable
            });
          }).catch((error) => {
            ctx.logger.warn(`[jet-hub] background ${RACCOON.id} login failed for ${id}: ${String(error)}`);
            void pool.removeAccount(id).catch(() => {
            });
          });
          return { ok: true, value: { accountId: id, loginUrl: raccoonStarted.loginUrl } };
        } else {
          return { ok: false, error: { code: "bad-request", message: `unknown provider: ${provider}` } };
        }
      }
      case "account.update": {
        const req = payload;
        await pool.updateAccount(req.accountId, req.patch);
        return { ok: true, value: void 0 };
      }
      case "account.delete": {
        const req = payload;
        await pool.removeAccount(req.accountId);
        return { ok: true, value: void 0 };
      }
      // 拖拽排序：重写该 provider 账号在池中的顺序。
      // 该顺序是自动选号与限流换号的候选优先级，因此不是纯 UI 操作。
      case "account.reorder": {
        const req = payload;
        if (typeof req.provider !== "string" || req.provider.length === 0) {
          return { ok: false, error: { code: "bad-request", message: "provider \u5FC5\u586B" } };
        }
        if (!Array.isArray(req.orderedIds) || req.orderedIds.some((id) => typeof id !== "string")) {
          return { ok: false, error: { code: "bad-request", message: "orderedIds \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4" } };
        }
        try {
          await pool.reorderAccounts(req.provider, req.orderedIds);
        } catch (error) {
          return {
            ok: false,
            error: {
              code: "bad-request",
              message: error instanceof Error ? error.message : String(error)
            }
          };
        }
        return { ok: true, value: void 0 };
      }
      case "account.refresh": {
        const req = payload;
        try {
          const accounts = await pool.listAllAccounts();
          const entry = accounts.find((a) => a.id === req.accountId);
          if (!entry) throw new Error(`Account ${req.accountId} not found`);
          switch (entry.provider) {
            case "codearts":
              await codearts.refreshAccountCredential(entry.credentialRef);
              break;
            case "buddy":
              await buddy.refreshAccountCredential(entry.credentialRef);
              break;
            case "workbuddy":
              await workbuddy.refreshAccountCredential(entry.credentialRef);
              break;
            case LOBSTERAI.id:
              await lobsterai.refreshAccountCredential(entry.credentialRef);
              break;
            case QODER.id:
              await qoder.refreshAccountCredential(entry.credentialRef);
              break;
            case TRAE.id:
              await trae.refreshAccountCredential(entry.credentialRef);
              break;
            case CLINE.id:
              await cline.refreshAccountCredential(entry.credentialRef);
              break;
            case LOOMY.id:
              await loomy.refreshAccountCredential(entry.credentialRef);
              break;
            case RACCOON.id:
              await raccoon.refreshAccountCredential(entry.credentialRef);
              break;
            default:
              throw new Error(`Unknown provider: ${entry.provider}`);
          }
          return { ok: true, value: { success: true } };
        } catch (error) {
          return {
            ok: true,
            value: {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          };
        }
      }
      case "login.poll": {
        const req = payload;
        const accounts = await pool.listAllAccounts();
        const entry = accounts.find((a) => a.id === req.accountId);
        if (!entry) return { ok: true, value: { done: false } };
        const ref = credentialRef(entry.credentialRef);
        const resolved = await ctx.credentials.resolve(ref);
        if (!resolved) return { ok: true, value: { done: false } };
        return { ok: true, value: { done: true, success: true } };
      }
      /**
       * 下发短信验证码（**仅 Loomy，备用登录路径**）。
       *
       * ⚠️ 主路径是**微信扫码**（`account.create` 返回本地弹窗页）。
       * 本端点与 `login.submitSms` 保留为**可独立调用的备用路径** ——
       * 不依赖 `account.create` 的中间态（早期版本从内存表取手机号，
       * 改微信登录后那张表不再被填充，会退化成坏死的死代码）。
       *
       * 手机号由**本端点自己接收**，故可脱离 `account.create` 单独使用。
       */
      case "login.sendSms": {
        const req = payload;
        if (req.provider !== LOOMY.id) {
          return { ok: false, error: { code: "bad-request", message: `unsupported provider: ${req.provider}` } };
        }
        const phone = typeof req.phone === "string" ? req.phone.trim() : "";
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          return { ok: false, error: { code: "bad-request", message: "\u9700\u8981 11 \u4F4D\u6709\u6548\u624B\u673A\u53F7\uFF08phone\uFF09" } };
        }
        const msgid = await loomy.sendSmsCode(phone);
        pendingSmsMsgid.set(req.accountId, { phone, msgid });
        return { ok: true, value: { msgid } };
      }
      /**
       * 提交短信验证码完成登录（**仅 Loomy，备用登录路径**）。
       *
       * 成功后：写凭据 → 回填账号昵称/有效期 → 清理中间态。
       */
      case "login.submitSms": {
        const req = payload;
        if (req.provider !== LOOMY.id) {
          return { ok: false, error: { code: "bad-request", message: `unsupported provider: ${req.provider}` } };
        }
        const pending = pendingSmsMsgid.get(req.accountId);
        if (pending === void 0 || pending.msgid.length === 0) {
          return {
            ok: true,
            value: { done: false, error: "\u8BF7\u5148\u53D1\u9001\u9A8C\u8BC1\u7801" }
          };
        }
        const account = pool.findAccount(req.accountId);
        if (account === void 0) {
          return {
            ok: true,
            value: { done: false, error: "\u8D26\u53F7\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF09" }
          };
        }
        try {
          const result = await loomy.loginWithSmsCode(pending.phone, req.code, pending.msgid, {
            refName: account.credentialRef
          });
          const credential = JSON.parse(result.access);
          await pool.updateAccount(req.accountId, {
            // Loomy 无昵称接口，用手机号尾号让多账号可区分（比 `loomy-xxxx` 有用）。
            nickname: credential.phone.length >= 4 ? `Loomy ${credential.phone.slice(-4)}` : req.accountId,
            expiresAt: result.expires > 0 ? result.expires : void 0,
            // ⚠️ 恒 false：Loomy 无续期端点。
            refreshable: false
          });
          pendingSmsMsgid.delete(req.accountId);
          return { ok: true, value: { done: true } };
        } catch (error) {
          return {
            ok: true,
            value: {
              done: false,
              error: error instanceof Error ? error.message : String(error)
            }
          };
        }
      }
      /**
       * 查询新手任务 / 一次性奖励状态（**Loomy** 的新手任务、**raccoon** 的登录奖励，只读）。
       *
       * ⚠️ 只读：**不得**在此触发任何 `complete`/`claim`（面板挂载时会调用它）。
       * ⚠️ 两个 provider 共用本端点，故判据是「属于其中之一」而非只认 Loomy。
       */
      case "onboarding.status": {
        const req = payload;
        if (req.provider !== LOOMY.id && req.provider !== RACCOON.id) {
          return { ok: false, error: { code: "bad-request", message: `unsupported provider: ${req.provider}` } };
        }
        const account = pool.findAccount(req.accountId);
        if (account === void 0) {
          return { ok: false, error: { code: "bad-request", message: "\u8D26\u53F7\u4E0D\u5B58\u5728" } };
        }
        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
        if (!resolved) {
          return { ok: false, error: { code: "bad-request", message: "\u51ED\u636E\u672A\u914D\u7F6E" } };
        }
        if (req.provider === RACCOON.id) {
          const credential2 = JSON.parse(resolved.value);
          const status = await raccoon.fetchOnboardingStatus(credential2);
          return {
            ok: true,
            value: {
              // ⚠️ `tasks` 是 `Record<key, boolean>`（完成状态），不是数组。
              tasks: { desktop_login_reward: status.claimed },
              earned: status.claimed ? status.points : 0,
              total: status.points,
              titles: { desktop_login_reward: "\u684C\u9762\u7AEF\u767B\u5F55\u5956\u52B1\uFF08\u6BCF\u53F7\u4E00\u6B21\uFF09" },
              points: { desktop_login_reward: status.points }
            }
          };
        }
        const credential = JSON.parse(resolved.value);
        const state = await loomy.fetchOnboardingTasks(credential);
        return {
          ok: true,
          value: {
            tasks: state.tasks,
            earned: state.earned,
            total: state.total,
            titles: { ...LOOMY_TASK_TITLES },
            points: { ...LOOMY_TASK_POINTS }
          }
        };
      }
      /**
       * Loomy「锁定永久积分」开关（读 / 写）。
       *
       * **用户需求**：锁定后选号只允许消耗今日赠送额度，永久积分不参与 ——
       * 只剩永久积分的账号在锁定期间等同于不可用（「锁定后没有临时积分后找
       * 可用账号就是没有可用账号」）。解锁后恢复「没临时积分就用永久积分」。
       *
       * ⚠️ 这是**全局**开关（不分账号），持久化在 `$DSH_HOME/jet-hub/state.json`
       * 的 `loomyPermanentLocked` 字段（或老契约的 settings 文档）。
       *
       * ⚠️ `locked` 省略时**只读**（供面板初始化），给出布尔值才写入。
       */
      case "loomy.permanentLock": {
        const req = payload;
        if (req.locked === void 0) {
          return { ok: true, value: { locked: pool.loomyPermanentLocked() } };
        }
        if (typeof req.locked !== "boolean") {
          return { ok: false, error: { code: "bad-request", message: "locked \u5FC5\u987B\u662F\u5E03\u5C14\u503C" } };
        }
        await pool.setLoomyPermanentLocked(req.locked);
        try {
          ctx.emit("llm/adapters-updated");
        } catch (error) {
          ctx.logger?.warn?.(`[jet-hub] \u5E7F\u64AD llm/adapters-updated \u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u5DF2\u4FDD\u5B58\u7684\u5F00\u5173\uFF09: ${String(error)}`);
        }
        return { ok: true, value: { locked: pool.loomyPermanentLocked() } };
      }
      /**
       * 领取新手任务 / 一次性奖励（**Loomy** 的新手任务、**raccoon** 的登录奖励，一次性）。
       *
       * ⚠️ 这是**写**操作，且**每号只能领一次** —— 与 `credits.claimAll`
       *（每日签到）语义完全不同，故独立端点。
       */
      case "onboarding.claim": {
        const req = payload;
        if (req.provider !== LOOMY.id && req.provider !== RACCOON.id) {
          return { ok: false, error: { code: "bad-request", message: `unsupported provider: ${req.provider}` } };
        }
        const account = pool.findAccount(req.accountId);
        if (account === void 0) {
          return { ok: false, error: { code: "bad-request", message: "\u8D26\u53F7\u4E0D\u5B58\u5728" } };
        }
        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
        if (!resolved) {
          return { ok: false, error: { code: "bad-request", message: "\u51ED\u636E\u672A\u914D\u7F6E" } };
        }
        if (req.provider === RACCOON.id) {
          const credential2 = JSON.parse(resolved.value);
          const outcome = await raccoon.claimLoginReward(credential2);
          if (outcome.kind === "failed") {
            return { ok: false, error: { code: "bad-request", message: outcome.message } };
          }
          const claimed = outcome.kind === "claimed" ? [{ key: "desktop_login_reward", title: "\u684C\u9762\u7AEF\u767B\u5F55\u5956\u52B1", points: outcome.credit }] : [];
          const points = outcome.kind === "claimed" ? outcome.credit : (await raccoon.fetchOnboardingStatus(credential2)).points;
          return {
            ok: true,
            value: {
              claimed,
              skipped: outcome.kind === "already-claimed" ? ["desktop_login_reward"] : [],
              // 该项目累计已领 = 满分（无论本次是否新增）。
              earned: points,
              total: points
            }
          };
        }
        const credential = JSON.parse(resolved.value);
        const result = await loomy.claimOnboardingTasks(credential);
        return {
          ok: true,
          value: {
            claimed: result.claimed.map((item) => ({
              key: item.key,
              title: LOOMY_TASK_TITLES[item.key] ?? item.key,
              points: item.points
            })),
            skipped: result.skipped,
            earned: result.earned,
            total: result.total
          }
        };
      }
      // ── 限流标记：重测（发真实请求验证）──
      // 标记只反映"上一次 429 时的快照"，服务端常在重置时间前提前放行。
      // 重测发一次最小对话请求：正常返回才清除标记，仍受限则保留并回报原因。
      case "account.retest": {
        const req = payload;
        const account = await retestAccount(pool, req.accountId);
        return {
          ok: true,
          value: { accounts: [account], clearedCount: account.cleared.length }
        };
      }
      // 重测该 provider 下的全部账号。**包含已停用账号**——用户明确要求
      // 停用账号也能重测（停用只影响自动选择，不影响手动排查）。
      case "account.retestAll": {
        const req = payload;
        const value = await retestAllAccounts(pool, req.provider);
        return { ok: true, value };
      }
      // ── 限流标记：重置（不发请求，直接清除）──
      case "account.reset": {
        const req = payload;
        const value = await resetAccount(pool, req.accountId);
        return { ok: true, value };
      }
      case "account.resetAll": {
        const req = payload;
        const value = await resetAllAccounts(pool, req.provider);
        return { ok: true, value };
      }
      // ── 每日签到（积分领取）──
      // 查询某 provider 下全部启用账号的签到状态。
      //
      // 四个 provider 分属**三套互不相同的协议**，各自在自己的分支里处理：
      //   - CodeBuddy 系（buddy / workbuddy）：`productById()` 取 BuddyProduct，
      //     走 `collectCreditsStatus` 的默认实现；
      //   - `lobsterai`：slot → context 三步，无独立状态端点；
      //   - `codearts`：华为云 SDK-HMAC-SHA256 签名，无独立状态端点。
      //
      // ⚠️ 只有 CodeBuddy 系能经 `productById()` 解析出产品配置；后两者
      // **必须各自提前分支**，否则会落到下面的 bad-request。历史上 CodeArts
      // 就是因此恒回 `unsupported provider: codearts`（客户端在面板挂载时
      // 无条件调用 credits.balances，于是每打开一次设置页都在控制台报错并把
      // 账号卡片标成查询失败）。现在 CodeArts 已有真实实现，该 bad-request
      // 只对**未知** provider 生效。
      case "credits.status": {
        const req = payload;
        if (req.provider === "codearts") {
          const accounts2 = await pool.listAccounts(req.provider);
          return {
            ok: true,
            value: {
              accounts: accounts2.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null }))
            }
          };
        }
        if (req.provider === LOBSTERAI.id) {
          const accounts2 = await pool.listAccounts(req.provider);
          return {
            ok: true,
            value: {
              accounts: accounts2.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null }))
            }
          };
        }
        if (req.provider === TRAE.id) {
          const accounts2 = await pool.listAccounts(req.provider);
          return {
            ok: true,
            value: {
              accounts: accounts2.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null }))
            }
          };
        }
        if (req.provider === CLINE.id) {
          const accounts2 = await pool.listAccounts(req.provider);
          return {
            ok: true,
            value: {
              accounts: accounts2.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null }))
            }
          };
        }
        if (req.provider === LOOMY.id) {
          const accounts2 = await pool.listAccounts(req.provider);
          return {
            ok: true,
            value: {
              accounts: accounts2.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null }))
            }
          };
        }
        const product = productById(req.provider);
        if (product === void 0) {
          return { ok: false, error: { code: "bad-request", message: `unsupported provider: ${req.provider}` } };
        }
        const accounts = await pool.listAccounts(req.provider);
        const results = await collectCreditsStatus(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg)
        });
        return { ok: true, value: { accounts: results } };
      }
      // 一键领取：逐账号顺序执行（并发易触发风控），单个账号失败不中断整体。
      case "credits.claimAll": {
        const req = payload;
        const accounts = await pool.listAccounts(req.provider);
        if (req.provider === QODER.id) {
          const value2 = await collectClaimResults(accounts, void 0, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential) => claimQoderDailyCheckin(credential, QODER),
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          return { ok: true, value: value2 };
        }
        if (req.provider === "codearts") {
          const value2 = await collectClaimResults(accounts, void 0, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential) => claimCodeArtsDailyCheckin(credential),
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          return { ok: true, value: value2 };
        }
        if (req.provider === LOBSTERAI.id) {
          const clientVersion = await lobsterai.resolveClientVersion();
          const value2 = await collectClaimResults(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential, product2) => claimLobsteraiDailyCheckin(credential, product2, clientVersion),
            // 领取流程内部已做 slot/context 预检，不需要外部再查一次状态。
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          return { ok: true, value: value2 };
        }
        if (req.provider === TRAE.id) {
          const value2 = await collectClaimResults(accounts, void 0, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            // ⚠️ **必须开启状态预检**（`precheckStatus` 默认为 true，不要传 false）。
            //
            // TRAE 的 claim 对「今天已签到」是**幂等**的：实测重复领取同样返回
            // `{code:0, message:"success"}`，与真正领取成功**无法区分**。
            // 早期照抄 LobsterAI 传了 `precheckStatus: false`（那是「领取流程内部
            // 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号
            // 被报成「领取成功」（用户报障：显示成功但 +0 积分）。
            // 判据只能是 status 端点的 `checked_in`。
            fetchStatus: (credential) => fetchTraeCheckinStatus(credential, TRAE, fetch),
            claim: (credential, _product, entry) => claimTraeDailyCheckin(
              credential,
              TRAE,
              fetch,
              pool.traeCheckinDeviceGenerationFor(entry.id),
              (next) => pool.updateTraeCheckinDeviceGeneration(entry.id, next)
            ),
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          return { ok: true, value: value2 };
        }
        if (req.provider === LOOMY.id) {
          const values = [];
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
            if (!resolved) {
              values.push({
                accountId: account.id,
                nickname: account.nickname,
                outcome: { kind: "failed", code: -1, message: "\u51ED\u636E\u672A\u914D\u7F6E" }
              });
              continue;
            }
            let credential;
            try {
              credential = JSON.parse(resolved.value);
            } catch {
              values.push({
                accountId: account.id,
                nickname: account.nickname,
                outcome: { kind: "failed", code: -1, message: "\u51ED\u636E\u89E3\u6790\u5931\u8D25" }
              });
              continue;
            }
            const outcome = await loomy.claimDailyQuota(credential);
            values.push({ accountId: account.id, nickname: account.nickname, outcome });
          }
          return {
            ok: true,
            value: {
              summary: computeClaimSummary(values.map((v) => v.outcome)),
              results: values
            }
          };
        }
        if (req.provider === CLINE.id) {
          return {
            ok: false,
            error: {
              code: "bad-request",
              message: "Cline \u4E0D\u652F\u6301\u6BCF\u65E5\u7B7E\u5230\uFF08\u5176\u540E\u7AEF\u6CA1\u6709\u7B7E\u5230\u63A5\u53E3\uFF09"
            }
          };
        }
        if (req.provider === RACCOON.id) {
          return {
            ok: false,
            error: {
              code: "bad-request",
              message: "Raccoon Work \u4E0D\u652F\u6301\u6BCF\u65E5\u7B7E\u5230\uFF08\u6BCF\u65E5\u79EF\u5206\u7531\u670D\u52A1\u7AEF\u81EA\u52A8\u53D1\u653E\uFF1B\u767B\u5F55\u5956\u52B1\u8BF7\u5728\u300C\u65B0\u624B\u4EFB\u52A1\u300D\u4E2D\u9886\u53D6\uFF09"
            }
          };
        }
        const product = productById(req.provider);
        if (product === void 0) {
          return { ok: false, error: { code: "bad-request", message: `unsupported provider: ${req.provider}` } };
        }
        const value = await collectClaimResults(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg)
        });
        return { ok: true, value };
      }
      // 积分余额（Credits Balance）：逐账号顺序查询。
      //
      // 独立于 account.list 的原因：余额要为每个账号发一次网络请求，而
      // account.list 是打开面板就会调的轻量操作。混在一起会让账号列表被
      // 网络耗时拖慢，且一次查询失败会让整份列表都取不到。
      case "credits.balances": {
        const req = payload;
        const accounts = await pool.listAccounts(req.provider);
        if (req.provider === "codearts") {
          const values2 = await collectCreditBalances(accounts, void 0, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalanceDetailed: async (credential) => {
              const result = await fetchCodeArtsAccountInfoDetailed(credential);
              if (!result.ok) return { balance: null, error: `\u8D26\u6237\u4FE1\u606F\u67E5\u8BE2\u5931\u8D25\uFF1A${result.message}` };
              const info = result.info;
              if (!info.isCreditPackage) {
                return {
                  balance: null,
                  error: info.isTokenPackage ? "Token \u8BA1\u8D39\u8D26\u6237\uFF0C\u65E0\u79EF\u5206\u4F59\u989D" : "\u975E\u79EF\u5206\u8BA1\u8D39\u8D26\u6237\uFF0C\u65E0\u79EF\u5206\u4F59\u989D"
                };
              }
              if (info.credit === void 0) return { balance: null, error: "\u672A\u8FD4\u56DE\u79EF\u5206\u6570\u636E" };
              return { balance: info.credit };
            },
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          return { ok: true, value: { accounts: values2 } };
        }
        if (req.provider === LOBSTERAI.id) {
          const values2 = await collectCreditBalances(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product2) => fetchLobsteraiCreditBalance(credential, product2),
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          return { ok: true, value: { accounts: values2 } };
        }
        if (req.provider === QODER.id) {
          const values2 = [];
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
            if (!resolved) {
              values2.push({
                accountId: account.id,
                nickname: account.nickname,
                balance: null,
                error: "\u51ED\u636E\u672A\u914D\u7F6E"
              });
              continue;
            }
            let credential;
            try {
              credential = JSON.parse(resolved.value);
            } catch {
              values2.push({
                accountId: account.id,
                nickname: account.nickname,
                balance: null,
                error: "\u51ED\u636E\u89E3\u6790\u5931\u8D25"
              });
              continue;
            }
            const balance = await fetchQoderCreditBalance(credential, QODER);
            values2.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // 查不到时带上原因，卡片显示原因而非 0（与其它 provider 同约定）。
              ...balance === null ? { error: "\u79EF\u5206\u67E5\u8BE2\u5931\u8D25\uFF08\u51ED\u636E\u5931\u6548\u6216\u54CD\u5E94\u5F02\u5E38\uFF09" } : {}
            });
          }
          return { ok: true, value: { accounts: values2 } };
        }
        if (req.provider === TRAE.id) {
          const values2 = await collectCreditBalances(accounts, TRAE, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product2) => fetchTraeCreditBalance(credential, product2),
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          return { ok: true, value: { accounts: values2 } };
        }
        if (req.provider === CLINE.id) {
          const values2 = [];
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
            if (!resolved) {
              values2.push({
                accountId: account.id,
                nickname: account.nickname,
                balance: null,
                error: "\u51ED\u636E\u672A\u914D\u7F6E"
              });
              continue;
            }
            let credential;
            try {
              credential = JSON.parse(resolved.value);
            } catch {
              values2.push({
                accountId: account.id,
                nickname: account.nickname,
                balance: null,
                error: "\u51ED\u636E\u89E3\u6790\u5931\u8D25"
              });
              continue;
            }
            const result = await fetchClineCreditBalance(credential, CLINE);
            values2.push({
              accountId: account.id,
              nickname: account.nickname,
              balance: result.balance,
              // 查不到时带上**具体原因**（含 HTTP 状态码与错误体摘要），
              // 而不是笼统一句「查询失败」—— 卡片显示原因而非 0
              //（0 是「已用光」的语义，会误导用户）。
              ...result.balance === null ? { error: result.error ?? "\u79EF\u5206\u67E5\u8BE2\u5931\u8D25\uFF08\u51ED\u636E\u5931\u6548\u6216\u54CD\u5E94\u5F02\u5E38\uFF09" } : {}
            });
          }
          return { ok: true, value: { accounts: values2 } };
        }
        if (req.provider === LOOMY.id) {
          const values2 = [];
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
            if (!resolved) {
              values2.push({
                accountId: account.id,
                nickname: account.nickname,
                balance: null,
                error: "\u51ED\u636E\u672A\u914D\u7F6E"
              });
              continue;
            }
            let credential;
            try {
              credential = JSON.parse(resolved.value);
            } catch {
              values2.push({
                accountId: account.id,
                nickname: account.nickname,
                balance: null,
                error: "\u51ED\u636E\u89E3\u6790\u5931\u8D25"
              });
              continue;
            }
            const balance = await loomy.fetchCreditBalance(credential);
            values2.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // 查不到时带原因（不显示成 0，0 是「已用光」的语义）。
              ...balance === null ? { error: "\u79EF\u5206\u67E5\u8BE2\u5931\u8D25\uFF08\u51ED\u636E\u5931\u6548\u6216\u54CD\u5E94\u5F02\u5E38\uFF09" } : {}
            });
          }
          return { ok: true, value: { accounts: values2 } };
        }
        if (req.provider === RACCOON.id) {
          const values2 = [];
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef));
            if (!resolved) {
              values2.push({
                accountId: account.id,
                nickname: account.nickname,
                balance: null,
                error: "\u51ED\u636E\u672A\u914D\u7F6E"
              });
              continue;
            }
            let credential;
            try {
              credential = JSON.parse(resolved.value);
            } catch {
              values2.push({
                accountId: account.id,
                nickname: account.nickname,
                balance: null,
                error: "\u51ED\u636E\u89E3\u6790\u5931\u8D25"
              });
              continue;
            }
            const balance = await raccoon.fetchCreditBalance(credential);
            values2.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // ⚠️ 查不到时带原因（**不显示成 0** —— 0 是「已用光」的语义，
              // 把「查询失败」显示成 0 会让用户以为自己积分没了）。
              ...balance === null ? { error: "\u79EF\u5206\u67E5\u8BE2\u5931\u8D25\uFF08\u51ED\u636E\u5931\u6548\u6216\u54CD\u5E94\u5F02\u5E38\uFF09" } : {}
            });
          }
          return { ok: true, value: { accounts: values2 } };
        }
        const product = productById(req.provider);
        if (product === void 0) {
          return { ok: false, error: { code: "bad-request", message: `unsupported provider: ${req.provider}` } };
        }
        const values = await collectCreditBalances(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg)
        });
        return { ok: true, value: { accounts: values } };
      }
      // ── 模型列表可见性（黑名单开关）──
      //
      // 列表来自 `ctx.llm.listModels()`——**适配器播报的权威目录**，正是
      // 对话框模型选择器读的同一份数据（会话控制器的 buildModelCatalog）。
      // 这样设置页展示的模型集合与实际可选集合永远一致，不会出现
      // 「设置在某个模型上，选择器里却找不到它」。
      case "model.list": {
        const req = payload;
        const llm = llmServiceOf(ctx);
        if (llm === void 0) {
          return { ok: false, error: { code: "bad-request", message: "llm \u670D\u52A1\u4E0D\u53EF\u7528" } };
        }
        let models;
        try {
          models = await llm.listModels(req.provider);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { ok: false, error: { code: "bad-request", message: `\u8BFB\u53D6\u6A21\u578B\u5217\u8868\u5931\u8D25\uFF1A${reason}` } };
        }
        const disabledMap = pool.listDisabledModels(req.provider);
        const catalogSource = modelAdapters?.[req.provider];
        const all = catalogSource?.listAllModels();
        let catalog;
        if (all !== void 0) {
          catalog = [...all];
          const known = new Set(catalog.map((model) => model.id));
          for (const id of Object.keys(disabledMap)) {
            if (disabledMap[id] === true && !known.has(id)) catalog.push({ id, name: id });
          }
        } else {
          const listedIds = new Set(models.map((model) => model.id));
          const filteredOut = Object.keys(disabledMap).filter((id) => disabledMap[id] === true && !listedIds.has(id));
          catalog = [
            ...models.map((model) => ({ id: model.id, name: model.name })),
            // 这些模型已被适配器过滤掉，拿不到原始 name，回退为 id。
            ...filteredOut.map((id) => ({ id, name: id }))
          ];
        }
        const value = {
          models: catalog.map((model) => ({
            id: model.id,
            name: model.name,
            disabled: disabledMap[model.id] === true
          }))
        };
        return { ok: true, value };
      }
      // 打开/关闭某个模型。写入后**不重建适配器**：适配器的 listModels 每次
      // 都直接读账号池的黑名单，因此下一次调用即返回新目录。
      //
      // ⚠️ 但「适配器立刻返回新目录」**不等于**「界面立刻更新」—— 客户端把
      // `modelCatalog` 的响应缓存在带 `status === 'ready'` 短路的 store 里，
      // 只在转发事件上失效（详见下方 emit 的注释）。不广播就等于开关只写进了
      // 磁盘、界面一直显示旧目录。
      case "model.setDisabled": {
        const req = payload;
        if (typeof req.provider !== "string" || typeof req.modelId !== "string" || req.modelId.length === 0) {
          return { ok: false, error: { code: "bad-request", message: "provider \u4E0E modelId \u5FC5\u586B" } };
        }
        await pool.setModelDisabled(req.provider, req.modelId, req.disabled === true);
        ctx.logger.info(
          `[jet-hub] ${req.disabled === true ? "\u5173\u95ED" : "\u6253\u5F00"}\u6A21\u578B ${req.provider}/${req.modelId}`
        );
        broadcastCatalogChanged(ctx);
        const value = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider)
        };
        return { ok: true, value };
      }
      /**
       * 批量打开/关闭某 provider 的全部模型（Jet Hub 模型列表的
       * 「打开全部 / 关闭全部」）。
       *
       * 两个方向的语义**刻意不对称**（需求明确规定）：
       *
       * - `disabled: true`（关闭全部）：按**当前目录**逐项加入黑名单，故需要读
       *   模型目录。目录优先取适配器的 `listAllModels()`（不套黑名单的全量目录，
       *   与 `model.list` 同源），缺失时退化为 `llm.listModels()`。
       * - `disabled: false`（打开全部）：直接清空该 provider 的黑名单条目，
       *   **不读目录** —— 这样「曾被关闭、后来从服务端目录里下线」的历史遗留键
       *   才能被清掉（按目录删的话它们永远留在配置里）。
       *
       * 为什么不做成前端循环调用 `model.setDisabled`：那会发 N 次请求、写 N 次
       * 完整文档、广播 N 次 `llm/adapters-updated`，且中途失败会留下「关了一半」
       * 的黑名单。批量端点只落盘一次、只广播一次。
       */
      case "model.setAllDisabled": {
        const req = payload;
        if (typeof req.provider !== "string" || typeof req.disabled !== "boolean") {
          return {
            ok: false,
            error: { code: "bad-request", message: "provider \u4E0E disabled\uFF08\u5E03\u5C14\uFF09\u5FC5\u586B" }
          };
        }
        if (req.disabled) {
          let ids;
          const all = modelAdapters?.[req.provider]?.listAllModels();
          if (all !== void 0) {
            ids = all.map((model) => model.id);
          } else {
            const llm = llmServiceOf(ctx);
            if (llm === void 0) {
              return { ok: false, error: { code: "bad-request", message: "llm \u670D\u52A1\u4E0D\u53EF\u7528" } };
            }
            try {
              ids = (await llm.listModels(req.provider)).map((model) => model.id);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              return { ok: false, error: { code: "bad-request", message: `\u8BFB\u53D6\u6A21\u578B\u5217\u8868\u5931\u8D25\uFF1A${reason}` } };
            }
          }
          await pool.setModelsDisabled(req.provider, ids);
          ctx.logger.info(`[jet-hub] \u5173\u95ED ${req.provider} \u7684\u5168\u90E8 ${ids.length} \u4E2A\u6A21\u578B`);
        } else {
          await pool.clearDisabledModels(req.provider);
          ctx.logger.info(`[jet-hub] \u6253\u5F00 ${req.provider} \u7684\u5168\u90E8\u6A21\u578B`);
        }
        broadcastCatalogChanged(ctx);
        const value = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider)
        };
        return { ok: true, value };
      }
      // ── 账号备份（导出 / 导入）──
      //
      // 目的：更换 DSH 版本时迁移账号凭据。备份文件是**自包含**的 JSON
      // （账号索引 + 凭据原文 + 模型黑名单，见 src/backup.ts），与 DSH 版本
      // 无关 —— 导入时按**当前版本**的存储契约重建，天然跨版本。
      //
      // 安全约定：加密在浏览器侧完成（PBKDF2 + AES-GCM），RPC 只接收/返回
      // 明文载荷；明文 JSON 不经过本层持久化与日志。
      case "backup.export": {
        const result = await exportBackup(pool, ctx.credentials);
        const value = {
          payload: result.payload,
          warnings: result.warnings
        };
        return { ok: true, value };
      }
      // 导入 = 整体替换（还原快照，不是合并）。写入顺序刻意「先凭据、后账号池」：
      // 账号池整体替换成功后，门控（hasLoggedInAccount）与黑名单立即反映新状态；
      // 若凭据写入中途失败（非法 ref 等），只跳过该条、不中断整体。
      case "backup.import": {
        const req = payload;
        const result = await importBackup(ctx.credentials, pool, req.payload);
        broadcastCatalogChanged(ctx);
        const value = {
          credentialsImported: result.credentialsImported,
          accountsImported: result.accountsImported,
          skipped: result.skipped,
          expiredAccounts: result.expiredAccounts,
          missingCredentials: result.missingCredentials
        };
        return { ok: true, value };
      }
      // 账号池统计（导入前的覆盖提示用）：缺 expiresAt 的条目疑似 DSH 版本
      // 切换后自动恢复的产物（反推不读凭据值，故无有效期）。前端据此在
      // 确认导入前提示用户「有 N 个自动恢复的账号将被整体覆盖」。
      case "backup.status": {
        const state = pool.getStateSnapshot();
        const value = {
          accounts: state.accounts.length,
          withoutExpiry: state.accounts.filter((entry) => entry.expiresAt === void 0).length
        };
        return { ok: true, value };
      }
      default:
        return { ok: false, error: { code: "bad-request", message: `unknown method: ${method}` } };
    }
  }
}
function reply(rpcId, result) {
  const value = typeof result === "object" && result !== null && result.ok === false ? { ...result, error: { ...result.error, details: {} } } : result;
  return Response.json({ type: "server-response", rpcId, result: value });
}
export {
  JET_HUB_API_PATH,
  buildRaccoonNickname,
  collectClaimResults,
  collectCreditBalances,
  collectCreditsStatus,
  computeClaimSummary,
  registerJetHubRpc
};
