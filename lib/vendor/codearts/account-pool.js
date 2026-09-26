import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createJetHubStore, sanitizeAccounts, sanitizeDisabledModels } from "./jet-hub-store.js";
import { JET_HUB_NS } from "./jet-hub-store.js";
const EMPTY_MODEL_SET = /* @__PURE__ */ new Set();
class AccountPool {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = createJetHubStore(ctx);
    if (this.store.kind === "memory") {
      this.ctx.logger?.warn?.("[jet-hub] \u65E0\u53EF\u7528\u6301\u4E45\u5316\u540E\u7AEF\uFF0C\u8D26\u53F7\u5217\u8868\u4E0E\u6A21\u578B\u9ED1\u540D\u5355\u4EC5\u5B58\u5728\u4E8E\u5185\u5B58\u4E2D");
    }
  }
  ctx;
  /** 持久化后端；两个后端都不可用时是仅内存实现。 */
  store;
  /**
   * 账号列表的**权威进程内副本**。
   *
   * 不直接把后端的读取结果当读源：后端的落盘快照在写入后未必立即反映到
   * 下一次读取，而本类的每次写入都是「读 → 改 → 整体写回」。
   * 若以滞后快照为读源，并发/连续的 updateModelRateLimit 会互相覆盖
   * （典型表现：多个账号触发限流后，落盘文档里一条 modelRateLimits
   * 都没有）。因此首次载入后，这份副本即为唯一读源。
   */
  cache = [];
  /**
   * 模型黑名单的**权威进程内副本**（与 {@link cache} 同理：载入一次后即以
   * 本副本为准）。
   */
  modelCache = {};
  /**
   * Loomy「锁定永久积分」的**权威进程内副本**（与 {@link cache} 同理）。
   *
   * ⚠️ 这是**全局**开关（不分账号）。三处写入点都必须携带它，
   * 否则会被整体写入抹掉 —— 与 `disabledModels` 当年踩过的坑同型。
   */
  loomyPermanentLockedCache = false;
  /** 是否已完成首次载入。 */
  loaded = false;
  /** 首次访问时从后端载入账号列表与黑名单。 */
  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const state = this.store.load();
    if (state === void 0) return;
    this.cache = state.accounts;
    this.modelCache = state.disabledModels;
    this.loomyPermanentLockedCache = state.loomyPermanentLocked === true;
  }
  /** 读取账号列表（进程内权威副本）。 */
  readAccounts() {
    this.ensureLoaded();
    return this.cache;
  }
  /**
   * 持久化账号列表（同时更新进程内权威副本）。
   *
   * **必须连同黑名单一起写回**：两种后端都是整体写入，
   * 只写 `{ accounts }` 会把同一文档里的 `disabledModels` 抹掉。
   */
  async writeAccounts(accounts) {
    this.cache = accounts;
    this.loaded = true;
    if (this.store.kind === "memory") {
      this.ctx.logger?.warn?.("[jet-hub] \u65E0\u6301\u4E45\u5316\u540E\u7AEF\uFF0C\u8D26\u53F7\u53D8\u66F4\u672A\u843D\u76D8");
      return;
    }
    await this.store.save({
      accounts,
      disabledModels: this.modelCache,
      loomyPermanentLocked: this.loomyPermanentLockedCache
    });
  }
  /**
   * 读取某 provider 的模型黑名单（被关闭的模型 id 集合）。
   *
   * 适配器只调用这一个方法，因此进程内副本就是它们的读源：设置页改开关
   * 后，下一次 `listModels` 立即生效，无需重启或重新注册适配器。
   */
  disabledModelsFor(provider) {
    this.ensureLoaded();
    const perProvider = this.modelCache[provider];
    if (perProvider === void 0) return EMPTY_MODEL_SET;
    const disabled = Object.keys(perProvider).filter((id) => perProvider[id] === true);
    return disabled.length > 0 ? new Set(disabled) : EMPTY_MODEL_SET;
  }
  /**
   * 列出某 provider 的模型黑名单，供设置页渲染开关。
   *
   * 返回**全部键**（含显式设为 false 的），以便 UI 区分"从未设置过"与
   * "曾被关闭又打开"——两者对用户都是"开"，但保留记录便于排查。
   */
  listDisabledModels(provider) {
    this.ensureLoaded();
    return { ...this.modelCache[provider] ?? {} };
  }
  /**
   * 打开/关闭某个模型。
   *
   * 关闭时写入 `true`；打开时**删除该键**而不是写 `false` —— 保持黑名单
   * 里只留真正被关闭的模型，`disabledModelsFor` 的语义因此始终是
   * "键存在且为 true 即隐藏"，配置文件也不会随开关操作无限膨胀。
   */
  async setModelDisabled(provider, modelId, disabled) {
    const next = { ...this.modelCache };
    const perProvider = { ...next[provider] ?? {} };
    if (disabled) perProvider[modelId] = true;
    else delete perProvider[modelId];
    if (Object.keys(perProvider).length === 0) delete next[provider];
    else next[provider] = perProvider;
    await this.writeModels(next);
  }
  /**
   * 批量关闭一批模型（Jet Hub 模型列表的「关闭全部」）。
   *
   * 语义是**按当前列表逐项加入黑名单**，与 {@link setModelDisabled} 的关闭方向
   * 一致，只是**一次落盘**：逐条调用会写 N 次完整文档（30 个模型就是 30 次
   * 整体重写 + 30 次目录广播），且中途失败会留下「关了一半」的黑名单。
   *
   * 空列表直接返回、不落盘：没有变更就不该产生一次无意义的写入与广播。
   * 注意这与 {@link clearDisabledModels} **不对称** —— 后者的语义是「清空」，
   * 即使传入空列表也仍有事可做（详见该方法注释）。
   */
  async setModelsDisabled(provider, modelIds) {
    if (modelIds.length === 0) return;
    this.ensureLoaded();
    const next = { ...this.modelCache };
    const perProvider = { ...next[provider] ?? {} };
    for (const id of modelIds) perProvider[id] = true;
    next[provider] = perProvider;
    await this.writeModels(next);
  }
  /**
   * 清空某 provider 的全部关闭项（Jet Hub 模型列表的「打开全部」）。
   *
   * ⚠️ **刻意不看模型目录**：直接删掉该 provider 在黑名单里的**全部**键，
   * 而不是按当前目录逐个删。理由是「曾被关闭、后来从服务端目录里下线」的
   * 历史遗留键 —— 按目录删的话它们永远清不掉，黑名单会积累死键，残留键
   * 将来若被同名模型复用还会莫名隐藏它。
   *
   * 该 provider 本就无关闭项时直接返回、不落盘。
   */
  async clearDisabledModels(provider) {
    this.ensureLoaded();
    if (this.modelCache[provider] === void 0) return;
    const next = { ...this.modelCache };
    delete next[provider];
    await this.writeModels(next);
  }
  /** 持久化模型黑名单（同时更新进程内权威副本）。 */
  async writeModels(disabledModels) {
    this.modelCache = disabledModels;
    this.loaded = true;
    if (this.store.kind === "memory") {
      this.ctx.logger?.warn?.("[jet-hub] \u65E0\u6301\u4E45\u5316\u540E\u7AEF\uFF0C\u6A21\u578B\u9ED1\u540D\u5355\u53D8\u66F4\u672A\u843D\u76D8");
      return;
    }
    await this.store.save({
      accounts: this.cache,
      disabledModels,
      loomyPermanentLocked: this.loomyPermanentLockedCache
    });
  }
  /**
   * Loomy「锁定永久积分」是否开启。
   *
   * 锁定后选号**只允许消耗今日赠送额度**，永久积分不参与 ——
   * 只剩永久积分的账号在锁定期间等同于不可用（用户语义）。
   */
  loomyPermanentLocked() {
    this.ensureLoaded();
    return this.loomyPermanentLockedCache;
  }
  /**
   * 设置 Loomy「锁定永久积分」开关（持久化）。
   *
   * ⚠️ **必须连同账号与黑名单一起写回**：两种后端都是整体写入，
   * 只写本字段会把同一文档里的另外两份数据抹掉。
   */
  async setLoomyPermanentLocked(locked) {
    this.ensureLoaded();
    this.loomyPermanentLockedCache = locked;
    if (this.store.kind === "memory") {
      this.ctx.logger?.warn?.("[jet-hub] \u65E0\u6301\u4E45\u5316\u540E\u7AEF\uFF0CLoomy \u6C38\u4E45\u79EF\u5206\u9501\u5B9A\u672A\u843D\u76D8");
      return;
    }
    await this.store.save({
      accounts: this.cache,
      disabledModels: this.modelCache,
      loomyPermanentLocked: locked
    });
  }
  /** 列出某个 provider 的所有账号（含状态信息） */
  async listAccounts(provider) {
    const filtered = this.readAccounts().filter((a) => a.provider === provider);
    const results = [];
    for (const entry of filtered) {
      const status = { ...entry };
      try {
        const info = await this.ctx.credentials.describe(credentialRef(entry.credentialRef));
        status.source = info.source;
      } catch {
      }
      results.push(status);
    }
    return results;
  }
  /** 列出所有 provider 的账号 */
  async listAllAccounts() {
    return this.readAccounts();
  }
  /**
   * 清理「凭据域名与当前产品配置不符」的账号。
   *
   * 用途：WorkBuddy provider 从中国版（copilot.tencent.com）改造为国际版
   * （www.workbuddy.ai）后，旧账号存的仍是中国版凭据 —— 它们的
   * `token.domain` 指向旧端点，用新 endpoint 发请求必然失败（且会一直续期失败）。
   * 这类条目已无修复价值，直接删除，让用户在 Jet Hub 重新登录。
   *
   * 判据是**凭据里记录的 domain 与产品配置的 apiDomain 不一致**（而不是简单按
   * provider 名删），这样只清理真正失配的条目，不会误删已在新端点登录的账号。
   *
   * @returns 被删除的账号 id 列表（供调用方记日志）。
   */
  async pruneAccountsWithForeignDomain(product) {
    const removed = [];
    for (const entry of this.readAccounts()) {
      if (entry.provider !== product.id) continue;
      let domain = "";
      try {
        const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef));
        if (resolved === void 0) continue;
        const parsed = JSON.parse(resolved.value);
        domain = typeof parsed.domain === "string" ? parsed.domain : "";
      } catch {
        continue;
      }
      if (domain.length === 0) continue;
      if (domain !== product.apiDomain) {
        await this.removeAccount(entry.id);
        removed.push(entry.id);
      }
    }
    return removed;
  }
  /** 添加新账号（登录成功后调用） */
  async addAccount(entry) {
    const accounts = [...this.readAccounts(), entry];
    await this.writeAccounts(accounts);
  }
  /** 更新账号部分字段 */
  async updateAccount(id, patch) {
    const accounts = this.readAccounts();
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx === -1) throw new Error(`Account ${id} not found`);
    const next = [...accounts];
    next[idx] = { ...next[idx], ...patch };
    await this.writeAccounts(next);
  }
  /** 删除账号（同时清理凭据） */
  async removeAccount(id) {
    const accounts = this.readAccounts();
    const entry = accounts.find((a) => a.id === id);
    if (!entry) return;
    try {
      await this.ctx.credentials.unset(credentialRef(entry.credentialRef));
    } catch {
    }
    await this.writeAccounts(accounts.filter((a) => a.id !== id));
  }
  /**
   * 重排某 provider 下账号的顺序（Jet Hub 拖拽排序）。
   *
   * ## 为什么顺序有实际意义
   *
   * 账号列表的数组顺序就是 {@link getAvailableAccount} 的**候选优先级**：
   * 自动选号、限流后的换号重试都按这个顺序取「第一个可用账号」。
   * 因此拖拽不是 UI 装饰，它直接决定实际用哪个账号发请求。
   *
   * ## 只动本 provider 的槽位
   *
   * 账号存在**一个全局数组**里（各 provider 混排，靠 `provider` 字段区分），
   * 而设置页是按 provider 分组渲染的。因此这里取「该 provider 账号原本占用的
   * 那些下标」，把新顺序填回这些下标 —— 其他 provider 的账号**位置不变**。
   *
   * 不这么做（例如把该 provider 的账号整体挪到数组头部）会让拖拽 CodeArts
   * 的顺序顺带改变 Buddy 账号的相对位置，属于跨面板的意外副作用。
   *
   * ## 校验：必须是同一集合的一个排列
   *
   * `orderedIds` 必须恰好包含该 provider 的**全部**账号 id（顺序可变、集合不可变）。
   * 不满足就抛错而不是「尽力而为」：
   * - 少了某个 id（前端列表过期，期间账号被别处新增）→ 若静默忽略，那个账号
   *   会莫名其妙掉到末尾，用户看到的是"顺序自己变了"；
   * - 多了未知 id → 说明前端状态与服务端不一致。
   * 两种情况都让用户刷新重试，比悄悄改数据安全。
   *
   * @param provider - provider id
   * @param orderedIds - 该 provider 全部账号 id 的目标顺序
   */
  async reorderAccounts(provider, orderedIds) {
    const accounts = this.readAccounts();
    const indices = [];
    const currentIds = [];
    accounts.forEach((entry, index) => {
      if (entry.provider === provider) {
        indices.push(index);
        currentIds.push(entry.id);
      }
    });
    const expected = new Set(currentIds);
    const got = new Set(orderedIds);
    const sameSet = orderedIds.length === currentIds.length && got.size === orderedIds.length && orderedIds.every((id) => expected.has(id));
    if (!sameSet) {
      throw new Error(
        `\u8D26\u53F7\u5217\u8868\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\uFF08\u671F\u671B ${currentIds.length} \u4E2A\u8D26\u53F7\uFF0C\u6536\u5230 ${orderedIds.length} \u4E2A\uFF09`
      );
    }
    const next = [...accounts];
    indices.forEach((accountIndex, position) => {
      const id = orderedIds[position];
      const source = accounts.find((a) => a.id === id);
      if (source !== void 0) next[accountIndex] = source;
    });
    await this.writeAccounts(next);
    this.ctx.logger?.info?.(`[jet-hub] \u5DF2\u91CD\u6392 ${provider} \u8D26\u53F7\u987A\u5E8F: ${orderedIds.join(", ")}`);
  }
  /**
   * 按凭据内容反查账号 id（供适配器记录"当前用的是哪个账号"）。
   *
   * 适配器不持有 ctx，也不该直接访问本类的私有凭据存储，
   * 因此这里集中做「遍历已启用账号 → 解析凭据 → 比对标识字段」。
   * @param provider - provider 名称（'buddy' | 'workbuddy' | 'codearts'）。
   * @param identity - 比对用的标识值：CodeBuddy 系传 access_token，CodeArts 传 access_key_id。
   * @returns 匹配到的账号 id；无匹配返回空串。
   */
  async findAccountIdByCredential(provider, identity) {
    if (identity.length === 0) return "";
    const identifierKey = provider === "codearts" ? "access_key_id" : "access_token";
    for (const entry of this.readAccounts()) {
      if (entry.provider !== provider || !entry.enabled) continue;
      const resolved = await this.resolveCredentialByRef(entry.credentialRef);
      if (resolved === void 0) continue;
      if (resolved[identifierKey] === identity) return entry.id;
    }
    return "";
  }
  /** 解析某个 credentialRef 下的凭据 JSON；不可用时返回 undefined。 */
  async resolveCredentialByRef(refName) {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(refName));
      if (!resolved) return void 0;
      const parsed = JSON.parse(resolved.value);
      return typeof parsed === "object" && parsed !== null ? parsed : void 0;
    } catch {
      return void 0;
    }
  }
  /** 按 id 查找账号条目（含已停用账号）。 */
  findAccount(id) {
    return this.readAccounts().find((a) => a.id === id);
  }
  /** 列出某 provider 的全部账号（含已停用），供「重测所有 / 重置所有」使用。 */
  listAccountsByProvider(provider) {
    return this.readAccounts().filter((a) => a.provider === provider);
  }
  /**
   * 该 provider 是否**至少有一个已登录（凭据可用）的账号**。
   *
   * 供适配器的 `listModels` 做门控：没有已登录账号时返回空目录，让 DSH 的
   * `buildModelCatalog` 把整个 provider 分组隐藏（它显式
   * `.filter(group => group.models.length > 0)`），从而显著减少模型选择
   * 列表里用不上的条目（用户需求：「没有已登录账号就不显示该供应商的所有
   * 模型」）。
   *
   * ## 为什么判据是「凭据可解析」而不是「有条目」
   *
   * 1. **`logout()` 只清凭据、保留账号条目**（删除条目是另一条路径
   *    `removeAccount`）。若只看「有没有条目」，用户登出后模型仍会显示，
   *    门控形同虚设。
   * 2. **不看 `enabled`**：停用只应影响「自动选号」，与「是否已登录」无关。
   *    这与续期调度器「只按 `refreshable` 过滤、不看 `enabled`」是同一条
   *    既有约定（停用账号同样参与积分领取），故这里保持一致。
   *
   * ⚠️ **这是异步的**：需要逐个解析凭据。但只解析到**第一个可用账号**即返回
   * （短路），多账号场景下通常第一次就命中。
   *
   * ⚠️ **本方法只用于「目录展示」的门控**，绝不能用于路由判定 ——
   * DSH 约定 `listModels` 结果仅供参考，隐藏目录不等于拒绝请求
   * （被隐藏的模型仍可 `resolveModel` / 正常收发）。
   */
  async hasLoggedInAccount(provider) {
    for (const entry of this.listAccountsByProvider(provider)) {
      const credential = await this.resolveCredentialByRef(entry.credentialRef);
      if (credential !== void 0) return true;
    }
    return false;
  }
  /**
   * 按账号 id 解析凭据（**不检查 enabled**）。
   *
   * 限流重测必须能对已停用账号发请求（用户明确要求"停用的账号也能发送"），
   * 因此这里刻意与 {@link getAvailableAccount} 的过滤条件区分开：自动选择
   * 只认启用账号，而按 id 的显式探测认全部账号。
   * @returns 凭据对象；账号不存在或凭据不可用时返回 undefined。
   */
  async resolveCredentialForAccount(id) {
    const entry = this.findAccount(id);
    if (entry === void 0) return void 0;
    const parsed = await this.resolveCredentialByRef(entry.credentialRef);
    if (parsed === void 0) return void 0;
    return parsed;
  }
  /**
   * 清除限流标记。
   *
   * @param accountId - 目标账号。
   * @param modelIds - 要清除的模型；省略时清除该账号的**全部**标记。
   * @returns 实际清除的标记数。
   */
  async clearModelRateLimits(accountId, modelIds) {
    const accounts = this.readAccounts();
    const idx = accounts.findIndex((a) => a.id === accountId);
    if (idx === -1) return 0;
    const entry = accounts[idx];
    const current = entry.modelRateLimits;
    if (!current || Object.keys(current).length === 0) return 0;
    const limits = { ...current };
    let removed = 0;
    const targets = modelIds ?? Object.keys(limits);
    for (const modelId of targets) {
      if (Object.prototype.hasOwnProperty.call(limits, modelId)) {
        delete limits[modelId];
        removed++;
      }
    }
    if (removed === 0) return 0;
    const next = [...accounts];
    const updated = { ...entry };
    if (Object.keys(limits).length === 0) delete updated.modelRateLimits;
    else updated.modelRateLimits = limits;
    next[idx] = updated;
    await this.writeAccounts(next);
    this.ctx.logger?.info?.(
      `[jet-hub] \u5DF2\u6E05\u9664\u9650\u6D41\u6807\u8BB0: \u8D26\u53F7 ${accountId} \u6A21\u578B ${targets.join(", ")}\uFF08\u5171 ${removed} \u6761\uFF09`
    );
    return removed;
  }
  /**
   * 获取指定 provider + 模型的下一个可用账号。
   *
   * `modelId` 为空串时**不做限流过滤**——调用方（provider 的
   * resolveCredential 入口）此时还不知道要发哪个模型，只能退化为
   * "任取一个启用账号"。但 `enabled` 过滤在任何情况下都生效：
   * 停用账号绝不参与自动选择，空 modelId 也不例外。
   *
   * @param provider - provider id（`this.product.id`，不要写死字面量）
   * @param modelId - 目标模型；空串表示不按模型过滤
   * @param excludeAccountIds - 需要跳过的账号 id。
   *
   * **为什么需要 `excludeAccountIds`**：调用方在「请求级轮换」时会逐个换号
   * 重试，必须能拿到**下一个**账号而不是每次都拿回同一个。
   * 本池默认按「重置时间最早到期」排序，当失败类别**不写限流标记**时
   * （如 5xx / 请求错误 —— 它们不是限流，不该留徽章），
   * 刚失败的账号仍是排序第一，调用方若不排除它就会原地打转、
   * 换号形同虚设。Go 侧对应的是 `PickExcluding(tried)`（`pool.go:131`）。
   *
   * 在池这一层排除（而非让调用方自己跳过）是必要的：调用方只能拿到
   * 「池认为最优的一个」，无法枚举候选自己去重。
   */
  async getAvailableAccount(provider, modelId, excludeAccountIds) {
    const candidates = this.readAccounts().filter((a) => a.provider === provider && a.enabled).filter((a) => excludeAccountIds === void 0 || !excludeAccountIds.has(a.id)).filter((a) => {
      if (modelId.length === 0) return true;
      if (!a.modelRateLimits) return true;
      const resetAt = a.modelRateLimits[modelId];
      return resetAt === void 0 || resetAt === 0 || Date.now() >= resetAt;
    });
    if (candidates.length === 0) return null;
    const failures = [];
    for (const entry of candidates) {
      let resolved;
      try {
        resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef));
      } catch (error) {
        failures.push(`${entry.id}: \u8BFB\u53D6\u51ED\u636E\u5931\u8D25 (${String(error)})`);
        continue;
      }
      if (!resolved) {
        failures.push(`${entry.id}: \u51ED\u636E\u672A\u914D\u7F6E`);
        continue;
      }
      try {
        const credential = JSON.parse(resolved.value);
        if (failures.length > 0) {
          this.ctx.logger?.warn?.(
            `[jet-hub] ${failures.length} \u4E2A ${provider} \u8D26\u53F7\u4E0D\u53EF\u7528\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${failures.join("; ")}`
          );
        }
        return { entry, credential };
      } catch (error) {
        failures.push(`${entry.id}: \u51ED\u636E JSON \u635F\u574F (${String(error)})`);
        continue;
      }
    }
    if (failures.length > 0) {
      this.ctx.logger?.warn?.(
        `[jet-hub] \u6CA1\u6709\u53EF\u7528\u7684 ${provider} \u8D26\u53F7\uFF1A${failures.join("; ")}`
      );
    }
    return null;
  }
  /**
   * 更新某账号某模型的重置时间。
   *
   * 关键：基于**读取到的最新账号列表**做局部合并，再把整个列表写回。
   * settings scope 的 get() 返回的是服务内部快照，可能滞后于磁盘；
   * 但 replace() 是整体替换，因此这里每次都在最新快照上合并，
   * 避免"写 A 的限流 → 读旧快照 → 写 B 的限流"把 A 的记录抹掉。
   */
  async updateModelRateLimit(accountId, modelId, resetAtMs) {
    const accounts = this.readAccounts();
    const idx = accounts.findIndex((a) => a.id === accountId);
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] updateModelRateLimit: \u8D26\u53F7 ${accountId} \u4E0D\u5728\u8D26\u53F7\u5217\u8868\u4E2D\uFF08\u5DF2\u77E5: ${accounts.map((a) => a.id).join(", ") || "\u7A7A"}\uFF09`
      );
      return;
    }
    const next = [...accounts];
    const entry = { ...next[idx] };
    entry.modelRateLimits = { ...entry.modelRateLimits, [modelId]: resetAtMs };
    next[idx] = entry;
    await this.writeAccounts(next);
    this.ctx.logger?.info?.(
      `[jet-hub] \u5DF2\u8BB0\u5F55\u9650\u6D41: \u8D26\u53F7 ${accountId} \u6A21\u578B ${modelId} \u91CD\u7F6E\u4E8E ${new Date(resetAtMs).toISOString()}`
    );
  }
  /** 清理已过期的重置时间记录 */
  async sweepExpiredRateLimits() {
    const accounts = this.readAccounts();
    let changed = false;
    const next = accounts.map((entry) => {
      if (!entry.modelRateLimits) return entry;
      const limits = { ...entry.modelRateLimits };
      for (const [modelId, resetAtMs] of Object.entries(limits)) {
        if (resetAtMs > 0 && Date.now() >= resetAtMs) {
          delete limits[modelId];
          changed = true;
        }
      }
      return { ...entry, modelRateLimits: limits };
    });
    if (changed) await this.writeAccounts(next);
  }
  /**
   * 记录 TRAE 签到设备轮换代次（命中 9074 后由积分领取流程调用）。
   *
   * 与 {@link updateModelRateLimit} 同款：在**最新快照**上做局部合并后整体
   * 写回，避免与并发的账号操作互相覆盖。
   *
   * 只接受比现值**更大**的代次，防止乱序/重复回调把代次写回小值而让同一个
   * 被限流的设备号复活。
   */
  async updateTraeCheckinDeviceGeneration(accountId, generation) {
    if (!Number.isFinite(generation) || generation <= 0) return;
    const accounts = this.readAccounts();
    const idx = accounts.findIndex((a) => a.id === accountId);
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] updateTraeCheckinDeviceGeneration: \u8D26\u53F7 ${accountId} \u4E0D\u5728\u8D26\u53F7\u5217\u8868\u4E2D`
      );
      return;
    }
    const current = accounts[idx].traeCheckinDeviceGeneration ?? 0;
    if (generation <= current) return;
    const next = [...accounts];
    next[idx] = { ...next[idx], traeCheckinDeviceGeneration: generation };
    await this.writeAccounts(next);
    this.ctx.logger?.info?.(`[jet-hub] \u8D26\u53F7 ${accountId} \u7B7E\u5230\u8BBE\u5907\u4EE3\u6B21 \u2192 ${generation}`);
  }
  /** 读取 TRAE 签到设备轮换代次（未设置时为 0）。 */
  traeCheckinDeviceGenerationFor(accountId) {
    const entry = this.readAccounts().find((a) => a.id === accountId);
    const value = entry?.traeCheckinDeviceGeneration;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  }
  /**
   * 读取当前完整状态快照（账号列表 + 模型黑名单）。
   *
   * 供备份导出使用：返回的副本与进程内权威副本解耦，调用方修改返回值
   * 不会污染池的运行时状态。`disabledModels` 是嵌套结构，必须深拷贝
   * （浅拷贝会让内层 provider 表仍共享引用）。
   */
  getStateSnapshot() {
    this.ensureLoaded();
    const disabledModels = {};
    for (const [provider, models] of Object.entries(this.modelCache)) {
      disabledModels[provider] = { ...models };
    }
    return {
      accounts: [...this.cache],
      disabledModels,
      loomyPermanentLocked: this.loomyPermanentLockedCache
    };
  }
  /**
   * 整体替换账号列表与模型黑名单（备份导入用）。
   *
   * 与 {@link writeAccounts} / {@link writeModels} 的约定一致：整体写入时
   * 必须同时携带账号与黑名单，否则会把另一份数据抹掉。这里一次落盘完成
   * 两件事，避免中间态。
   *
   * ⚠️ 导入数据来自用户提供的备份文件（可能被手工编辑），因此先经
   * `sanitizeAccounts` / `sanitizeDisabledModels` 归一化：只保留可用的
   * 账号条目与显式 `true` 的黑名单项，坏条目直接丢弃而不是写进池里
   * 反复触发选号失败。
   */
  async replaceAll(accounts, disabledModels, loomyPermanentLocked) {
    const next = sanitizeAccounts(accounts);
    this.cache = next;
    this.modelCache = sanitizeDisabledModels(disabledModels);
    if (loomyPermanentLocked !== void 0) {
      this.loomyPermanentLockedCache = loomyPermanentLocked === true;
    }
    this.loaded = true;
    if (this.store.kind === "memory") {
      this.ctx.logger?.warn?.("[jet-hub] \u65E0\u6301\u4E45\u5316\u540E\u7AEF\uFF0C\u5907\u4EFD\u5BFC\u5165\u4EC5\u5B58\u5728\u4E8E\u5185\u5B58\u4E2D");
      return;
    }
    await this.store.save({
      accounts: next,
      disabledModels: this.modelCache,
      loomyPermanentLocked: this.loomyPermanentLockedCache
    });
  }
}
async function providerCatalogVisible(accountPool, provider) {
  if (!resolveHideWithoutAccountFlag(process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT)) return true;
  if (accountPool === void 0) return true;
  if (typeof accountPool.hasLoggedInAccount !== "function") return true;
  try {
    return await accountPool.hasLoggedInAccount(provider);
  } catch {
    return true;
  }
}
function resolveHideWithoutAccountFlag(raw) {
  if (raw === void 0) return true;
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}
export {
  AccountPool,
  JET_HUB_NS,
  providerCatalogVisible
};
