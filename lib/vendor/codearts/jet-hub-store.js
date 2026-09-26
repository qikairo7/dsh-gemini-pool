import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { hasLegacyNamespaceRegistration, readService, settingsOf } from "./settings-compat.js";
const JET_HUB_NS = "jet-hub";
const jetHubSchema = Schema.object({
  accounts: Schema.array(Schema.any()).default([]),
  disabledModels: Schema.dict(Schema.any()).default({}),
  loomyPermanentLocked: Schema.boolean().default(false)
});
function sanitizeDisabledModels(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result = {};
  for (const [provider, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const perProvider = {};
    for (const [modelId, flag] of Object.entries(value)) {
      if (flag === true) perProvider[modelId] = true;
    }
    if (Object.keys(perProvider).length > 0) result[provider] = perProvider;
  }
  return result;
}
function sanitizeAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  const accounts = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const candidate = entry;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) continue;
    if (typeof candidate.provider !== "string" || candidate.provider.length === 0) continue;
    if (typeof candidate.credentialRef !== "string" || candidate.credentialRef.length === 0) continue;
    accounts.push({
      ...candidate,
      enabled: candidate.enabled !== false,
      refreshable: candidate.refreshable !== false,
      nickname: typeof candidate.nickname === "string" ? candidate.nickname : candidate.id,
      createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now()
    });
  }
  return accounts;
}
class SettingsStore {
  constructor(scope) {
    this.scope = scope;
  }
  scope;
  kind = "settings";
  load() {
    const value = this.scope.get();
    if (value === void 0 || value === null) return void 0;
    return {
      accounts: sanitizeAccounts(value.accounts),
      disabledModels: sanitizeDisabledModels(value.disabledModels),
      // 老文档没有该字段 → 缺省 false（解锁），与既有行为一致。
      loomyPermanentLocked: value.loomyPermanentLocked === true
    };
  }
  async save(state) {
    await this.scope.replace({
      accounts: state.accounts,
      disabledModels: state.disabledModels,
      loomyPermanentLocked: state.loomyPermanentLocked === true
    });
  }
}
class MemoryStore {
  kind = "memory";
  state;
  load() {
    return this.state;
  }
  async save(state) {
    this.state = state;
  }
}
const PROVIDER_BY_REF_PREFIX = {
  CODEARTS: "codearts",
  BUDDY: "buddy",
  WORKBUDDY: "workbuddy",
  LOBSTERAI: "lobsterai",
  QODER: "qoder",
  TRAE: "trae"
};
const ACCOUNT_REF_RE = /^(CODEARTS|BUDDY|WORKBUDDY|LOBSTERAI|QODER|TRAE)_ACCOUNT_([0-9A-Fa-f]{6,})$/;
function extractCredentialRefNames(text) {
  const names = [];
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (!inRefs) continue;
    if (/^\S/.test(line)) break;
    const match = /^\s{2,}([A-Z][A-Z0-9_]*):/.exec(line);
    if (match?.[1] !== void 0) names.push(match[1]);
  }
  return names;
}
function accountFromCredentialRef(ref) {
  const match = ACCOUNT_REF_RE.exec(ref);
  if (match === null) return void 0;
  const provider = PROVIDER_BY_REF_PREFIX[match[1]];
  const suffix = match[2];
  if (provider === void 0 || suffix === void 0) return void 0;
  const id = `${provider}-${suffix.toLowerCase()}`;
  return {
    id,
    provider,
    nickname: id,
    enabled: true,
    credentialRef: ref,
    createdAt: Date.now(),
    refreshable: true
  };
}
class FileStore {
  constructor(home, path, logger) {
    this.home = home;
    this.path = path;
    this.logger = logger;
  }
  home;
  path;
  logger;
  kind = "file";
  load() {
    try {
      if (!existsSync(this.path)) return this.bootstrapFromCredentialRefs();
      const parsed = JSON.parse(readFileSync(this.path, "utf-8"));
      if (typeof parsed !== "object" || parsed === null) return void 0;
      const value = parsed;
      return {
        accounts: sanitizeAccounts(value.accounts),
        disabledModels: sanitizeDisabledModels(value.disabledModels),
        // 老文档没有该字段 → 缺省 false（解锁），与既有行为一致。
        loomyPermanentLocked: value.loomyPermanentLocked === true
      };
    } catch (error) {
      this.logger?.warn(`[jet-hub] \u8BFB\u53D6 ${this.path} \u5931\u8D25\uFF0C\u672C\u6B21\u4EE5\u7A7A\u5217\u8868\u542F\u52A8: ${String(error)}`);
      return void 0;
    }
  }
  async save(state) {
    this.write(state);
  }
  write(state) {
    mkdirSync(join(this.home, "jet-hub"), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, this.path);
  }
  /**
   * 首次启动的数据恢复（**仅在状态文档不存在时**执行一次）。
   *
   * 背景：0.1.7 启动时 `SettingsForms.importLegacyDocument()` 把
   * `$DSH_HOME/settings.yaml` 改名为 `settings.yaml.imported`，并按「section id
   * = profile 条目 id」逐段导入 —— `jet-hub` 不对应任何条目，该段导入失败、
   * 只留在改名后的文件里。于是老用户的账号索引成了孤儿（凭据本体仍在
   * `.credentials.yaml` 中，完好无损）。
   *
   * 这里据凭据 ref 名重建索引：能恢复「有哪些账号、属于哪个 provider、用哪个
   * credentialRef」，**恢复不了**昵称/顺序/限流时间戳（那三项只在旧 settings
   * 文档里，而本项目没有 YAML 解析依赖）。重建结果立即落盘，故只做一次。
   */
  bootstrapFromCredentialRefs() {
    const credentialsPath = join(this.home, ".credentials.yaml");
    try {
      if (!existsSync(credentialsPath)) return void 0;
      const accounts = extractCredentialRefNames(readFileSync(credentialsPath, "utf-8")).flatMap((ref) => accountFromCredentialRef(ref) ?? []);
      if (accounts.length === 0) return void 0;
      const state = { accounts, disabledModels: {}, loomyPermanentLocked: false };
      try {
        this.write(state);
      } catch (error) {
        this.logger?.warn(`[jet-hub] \u6062\u590D\u51FA\u7684\u8D26\u53F7\u672A\u80FD\u843D\u76D8\uFF08\u4EC5\u672C\u6B21\u6709\u6548\uFF09: ${String(error)}`);
      }
      this.logger?.info(
        `[jet-hub] \u5DF2\u4ECE .credentials.yaml \u6062\u590D ${accounts.length} \u4E2A\u8D26\u53F7\uFF08\u6635\u79F0/\u987A\u5E8F/\u9650\u6D41\u6807\u8BB0\u65E0\u6CD5\u6062\u590D\uFF1B\u65E7\u6570\u636E\u4ECD\u5728 settings.yaml.imported \u7684 jet-hub \u6BB5\uFF09`
      );
      return state;
    } catch (error) {
      this.logger?.warn(`[jet-hub] \u8D26\u53F7\u6062\u590D\u5931\u8D25\uFF08\u5FFD\u7565\uFF09: ${String(error)}`);
      return void 0;
    }
  }
}
function resolveJetHubHome(ctx) {
  const override = process.env.DSH_JET_HUB_STATE_DIR;
  if (override !== void 0 && override.trim().length > 0) return override.trim();
  const profileHome = readService(ctx, "profileContext")?.home;
  if (typeof profileHome === "string" && profileHome.length > 0) return profileHome;
  const envHome = process.env.DSH_HOME;
  if (envHome !== void 0 && envHome.trim().length > 0) return envHome.trim();
  return join(homedir(), ".dsh");
}
function createJetHubStore(ctx) {
  const settings = settingsOf(ctx);
  if (hasLegacyNamespaceRegistration(settings) && settings !== void 0) {
    try {
      const scope = settings.register(JET_HUB_NS, jetHubSchema);
      return new SettingsStore(scope);
    } catch (error) {
      ctx.logger?.warn?.(`[jet-hub] settings namespace \u6CE8\u518C\u5931\u8D25\uFF0C\u6539\u7528\u672C\u5730\u72B6\u6001\u6587\u6863: ${String(error)}`);
    }
  }
  const home = resolveJetHubHome(ctx);
  if (home === void 0) {
    ctx.logger?.warn?.("[jet-hub] \u65E0\u6CD5\u5B9A\u4F4D DSH home\uFF0C\u8D26\u53F7\u5217\u8868\u4E0E\u6A21\u578B\u9ED1\u540D\u5355\u4EC5\u5B58\u5728\u4E8E\u5185\u5B58\u4E2D");
    return new MemoryStore();
  }
  return new FileStore(home, join(home, "jet-hub", "state.json"), ctx.logger);
}
export {
  JET_HUB_NS,
  createJetHubStore,
  resolveJetHubHome,
  sanitizeAccounts,
  sanitizeDisabledModels
};
