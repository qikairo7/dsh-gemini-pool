# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## v0.5.3 — 2026-09-26

### Fixed
- **设置页整页空白（严重）**：设置页组件引用了两个从未声明的变量（`localeRev` / `setLocaleRev`，本意是语言切换后重渲染）。该引用位于组件渲染函数体内，一执行就抛 `ReferenceError`，React 随即卸载整个设置分区——表现就是「打开设置，插件卡片是空白的」。补上缺失的状态声明。已用真实渲染测试复现：修复前渲染测试全红，修复后全绿

### Added
- **客户端渲染回归测试（9 项）**：此前所有检查都是静态的（语法检查、i18n 键覆盖、模块导入、HTTP 接口探测），全部通过却漏掉了「组件根本渲染不出来」这类问题。新增测试会真正执行组件渲染函数：
  - `test/client-render.test.mjs`——空数据渲染不抛错、渲染输出非空且含预期标题、所有被调用的 `set*` 与 hook 依赖项都有声明
  - `test/client-render-populated.test.mjs`——用真实接口响应（已脱敏）渲染，断言账号行、额度行、模型列表都出现在输出里，并断言「打开面板即自动刷新额度」这条行为
  - 两个文件都做了反向验证：把修复回退后测试确实变红，确认它们真能抓住这个缺陷
- `scripts/build-status-fixture.mjs`——从本机 `/antigravity/api/status` 抓取真实响应生成测试夹具，自动脱敏（邮箱、账号 id、令牌），若发现未脱敏邮箱则拒绝写入。该脚本刻意放在 `test/` 之外，避免被 `node --test` 自动执行而改写已提交的夹具

## v0.5.2 — 2026-09-25

### Fixed
- **账号在重启后丢失（严重）**：账号池加载校验的是一个实际不存在的字段（`accessToken`），而账号真正持有的是 `access` / `refresh`——导致每次进程重启从磁盘读回时，已保存的账号在校验阶段抛错、被静默吞掉，池加载为空（有旧凭证文件时甚至被单账号迁移覆盖）。改为校验真正的持久字段 `refresh`（access 是临时令牌、可按需刷新，legacy 迁移账号允许为空）。已用「保存→新实例重载」实测复现并验证修复
- **损坏的池文件不再静默丢弃**：池文件存在但无法解析时立即报错（携带文件路径与原因），不再静默清空并让迁移逻辑覆盖可恢复的文件

### Added
- 3 项账号池持久化回归测试（重载存活 / 空 access 仍可加载 / 损坏文件报错且不被覆盖）

### Changed
- 设置页无障碍与打磨：表单控件与 `<label>` 显式关联、额度条补 `role="progressbar"` 与 aria 值、错误/保存提示加 live region、折叠区补 `aria-expanded`、`:focus-visible` 焦点环、点按反馈与 `prefers-reduced-motion` 适配；「当前使用」标签补中英双语（行为、接口、数据流未变）
- 文档梳理：README 中英去营销腔并对齐、修英文版破损 HTML 与语义漂移、CHANGELOG/SECURITY 轻度润色

## v0.5.1 — 2026-09-25

### Fixed
- **请求失败路径崩溃修复**：`triedEndpoints` / `lastNetworkError` 原声明在候选循环内部、却在循环外的错误分支被引用，导致任一请求彻底失败时抛 `ReferenceError` 而非分类后的 `LlmError`。该 `ReferenceError` 无法被 `isQuotaOrRateLimitError()` 识别，使得账号在「所有候选均 429」的常见场景下既不进入冷却、也不自动切号——多账号 429 容灾在该路径下形同虚设。现将两变量提升至请求级作用域
- **并发刷新令牌加锁**：同一账号的多路请求 / 后台探活并发触发刷新时，会用同一个（旧的）`refresh_token` 同时打 Google 令牌端点；Google 每次刷新都会轮换 refresh_token，并发刷新可能互相作废并导致账号被刷废。新增 `refreshAccountTokenOnce()` 按账号合并在途刷新

### Added
- 回归测试：所有候选 429 耗尽时须抛出限流错误（非 ReferenceError）并正确记一次冷却

### Docs
- README 手动安装示例的包名去掉写死版本号，改用 `dsh-gemini-pool-*.tgz` 通配

## v0.5.0 — 2026-09-25

### Changed
- **探活恢复改为递减信任制**：后台探活成功后账号重新启用，但 `failureCount` 只递减 1（新 `recordProbeSuccess()`）——一次探活成功不再把真实失败史一笔勾销，账号需连续多次探活成功才能完全重获信任；设置页手动「重新启用」仍为全重置语义

### Security / Hardening
- 生图产物落盘前校验大小（上限 20 MiB），拒绝无界 base64 写盘
- 设置页 Web API 请求体上限 2 MiB，超限拒绝
- 账号池加载：结构性损坏（缺 `id` / `accessToken`）立即报错并携带坏值，不再静默吞掉坏条目
- 设置页表单：冷却参数未配置时显示为空，不再用硬编码默认值伪装成“已配置”
- 可重试状态码收敛为 `RETRYABLE_STATUSES` / `PROBE_RETRYABLE_STATUSES` 两个单一常量（原先三处独立硬编码数组）

### Added
- 3 项探活恢复行为测试（递减信任 / 不穿透零下限 / 手动解禁全重置）

### Internal
- 诊断单例显式化：`lib/diagnostics.js`（`createDiagnostics()` 工厂 + 共享实例），为后续模块拆分铺路
- 模块拆分持续推进：`lib/models.js`、`lib/text-and-format.js` 已剥离（行为零变化，导出面 32 不变）

## v0.4.1 — 2026-09-25

### Fixed
- 账号成功响应不再清零累计失败计数：间歇性坏号的退避阶梯与 `disableThreshold` 退役机制恢复生效（新增 `clearCooldownUntil()` 只清冷却窗口；`clearCooldown()` 保留手动解禁的全重置语义）
- 禁用账号的探活恢复改走真实 `streamGenerateContent` 文本通道（1-token 最小探测）：配额元数据查询不再能“假阳性复活”被限流的账号
- 账号池整体耗尽时报 `EXHAUSTED` 而非 `AUTH`，不再误导用户重新登录
- 生图路径与流路径统一使用同一配额/限流判定（收紧后的 `isQuotaOrRateLimitError`），400 类错误文本中偶然出现的 "quota" 字样不再误伤账号
- 流式输出中途遭遇 429 时同样标记冷却（不再换号续流，保持响应完整性）
- 生图成功路径补漏 `await`；修正 `package.json` 的 `files` 字段：把已改名的 README.zh.md 更正为 README.en.md

### Added
- GitHub Actions：push / PR 自动跑 `npm run check`（零依赖，无 install）
- 6 项行为回归测试（冷却语义 / 探活通道与模型 / 池耗尽错误码 / 中流 429 / 生图误判），全部先以失败态验证过对应 bug 真实存在

## v0.4.0 — 2026-09-25

### Added
- 首次公开版本：Google AI Pro / Ultra 订阅账号池接入 DSH（Antigravity / Cloud Code Assist 通道）
- 多账号额度均衡、429 自动切换、坏号冷却与探活恢复、设置页账号卡片与每周 / 5 小时额度展示、生图工具接入
