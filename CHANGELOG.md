# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## Unreleased

### Added
- 视觉旁路：主模型无视觉时贴图由池内 Gemini 转述为文字回喂。新增 `antigravity_read_image` 工具（接受附件哈希前缀 / 本地路径 / data: URL / http(s) 公网图片链接）、贴图准入 shim（给纯文本模型的 `resolveModelInfo` 补报 image 模态，`ANTIGRAVITY_VISION_ENABLED=false` 或 `visionEnabled: false` 可关）、`visionEnabled` / `visionModel` 池配置字段
- 自动看图桥接（llm/stream）：无视觉主模型贴图时，发往模型的请求里图片块自动替换为池内 Gemini 的文字转述，模型无感获得看图能力；同一张图进程内缓存只转述一次，转述失败自动退回宿主占位路径不阻塞对话，转述文本附原始哈希可供 `antigravity_read_image` 显式细看；`visionEnabled` 开关同时控制贴图准入与自动转述
- `antigravity_read_image` 支持 http(s) 图片 URL：仅限公网地址（DNS 解析后逐记录校验，防 loopback / 内网 / 云元数据目标与 DNS rebinding）、redirect 手动跟随且每跳重校验（上限 3 跳）、15 秒超时、仅接受 image/* 响应、10 MiB 字节上限（content-length 预检 + 流式计数双保险）
- 设置页新增「视觉旁路」卡片：`visionEnabled` 开关与 `visionModel` 代看模型下拉（非生图 Gemini 模型），与自动桥接共享同一开关语义

### Security
- CI 加固：`.github/workflows/check.yml` 的 actions/checkout 与 actions/setup-node 从 mutable tag 钉到 commit SHA（dependabot 仍会提 PR 更新）；`.github/dependabot.yml` 两组依赖各加 14 天冷却期，降低新发布版本的供应链风险
- `buildModelMatchRegex` 入口加输入类型与长度防御（超 200 字符直接返回永不匹配模式），动态正则路径不再可能被超长输入触达（semgrep ReDoS 基线项，原实现输入已转义、风险本就很低）

### Fixed
- 生图结果卡片的渲染文本此前显示 undefined：DSH 宿主调用工具 `output.render` 时第一个参数是调用入参、第二个才是 execute 返回值，`antigravity_image_generate` 的 render 按单参数声明取错了位置。改为双参形态，路径与 markdown 从返回值取

## v0.7.3 — 2026-09-30

### Added
- `package.json` 的 `engines` 新增 `dsh` 声明：`">=0.1.7-rc.2 <0.3.0"`。npm 包发布后，dsh-market 插件市场的卡片会读取 npm manifest 里的 `engines.dsh` 显示宿主版本要求（此前 GitHub-only 分发，市场显示「未声明宿主要求」）。范围下限对齐 devDependencies 钉住的 0.1.7-rc.2，0.2.0-rc.2 宿主在范围内

### 验证
- `npm run check` 34 项全绿；`npm pack --dry-run` 核对发布清单

## v0.7.2 — 2026-09-29

### Changed
- README（中英同步）：删除 v0.6.0 曾融合 dsh-codearts-auth 的历史叙述句——历史归 CHANGELOG，不挂在 README 给新用户添噪音；「快速开始」新增环境要求声明：适配 DSH 0.2.0-rc.2（`dsh --version` 查看）

### 验证
- 文档-only 变更；`npm run check` 34 项全绿，确认无意外波及

## v0.7.1 — 2026-09-29

### Fixed
- **带图会话整轮失败（严重，[PR #3](https://github.com/qikairo7/dsh-gemini-pool/pull/3)，作者 [tensor-x](https://github.com/tensor-x)）**：`prepareRequestImages` 调用宿主 `attachments.readImageRequest` 时传的是 `{ maxPixels, maxBytes }`，而 DSH 的 `ImageRequestTarget` 契约要求 `width` / `height` 为安全正整数（`dsh-attachment` 的 `validateTarget` 逐一校验，缺 width 即抛 `Image request width must be a positive integer.`）——消息里只要有图片附件，本轮请求在组装阶段就抛错。修复为从附件 ref 自带的 `width` / `height` 出发，vendored 一份 `dsh-attachment` 的规范函数 `requestImageDimensions(width, height, maxPixels)`（按 `REQUEST_IMAGE_MAX_PIXELS` = 2048×2048 等比缩小），与 `{ maxBytes }` 合并成合法 target 传入。附件 ref 的 `width` / `height` 由 DSH 附件存储发布时写入（`ImageAttachmentRef` 必填字段），插件侧直接使用即类型安全；未带 `attachmentId` 的 inline 图仍走原有 legacy base64 路径，不受影响

### Added
- `test/adapter-image-target.test.mjs`（作者 tensor-x）：走真实路径的回归测试——真实 `AccountPoolManager` + `AntigravityPoolAdapter` 构造，fake attachments 捕获实际收到的 target，断言 `width` / `height` / `maxBytes` 均为安全正整数

### Removed
- 移除过期的 `PROJECT_STATUS.md`：内容冻结在 v0.5.3 时代（2026-09-26），与当前仓库状态不符；仓库现状以 README 与 CHANGELOG 为准

### 验证
- 守卫先证红：在未修复的 master（ad8fecb）上仅带入新测试文件运行，1 项失败（`AssertionError: width must be positive int`，旧代码传出的 target 无 width），精确复现线上症状；修复分支上 `npm run check` 34 项全绿（含 `node --check` 六文件）

## v0.7.0 — 2026-09-28

### Removed
- **移除融合的 dsh-codearts-auth provider，回归 Gemini 单渠道**：不再捆绑 `codearts` / `buddy` / `workbuddy` / `lobsterai` / `qoder` / `trae` / `cline` / `loomy` / `raccoon` 九条第三方路由。需要这些通道请单独安装 [dsh-codearts-auth](https://gitee.com/iJetLi/deepseek-harness-codearts)（作者 Jet，MIT）
  - 删除 `lib/vendor/codearts/`（77 个文件，含 `qoder-auth-wasm.wasm`）及 `lib/index.js` 中对上游 `apply(ctx)` 的调用；`lib/client.js` 移除 id 为 `dsh-codearts-auth` 的 Jet Hub 客户端块，文件约 196KB → 65KB
  - 设置页只剩 Antigravity（Gemini 账号池）面板，`antigravity` 路由行为不变
- `package.json`：移除 `dependencies` 里的 `jose`（仅上游使用，运行时零依赖）；`description` 与 `keywords` 去掉 Cloud Code Assist，改标 `gemini`

### Changed
- 插件 `inject` 由 `["llm", "credentials", "commands"]` 回落为 `["llm"]`（`export const inject` 与 `apply.inject` 同步），不再依赖宿主的 credentials / commands 服务
- `test/client-render.test.mjs`：`loadGeminiSource()` 的截取逻辑保留，注释更新为单模块现状

### 验证
- `npm run check`：`node --check` 全部通过，`node --test` 33 项全绿（渲染回归、池状态机、探活、适配器错误路径）

## v0.6.0 — 2026-09-26

### Added
- **融合 dsh-codearts-auth 的 9 条 provider 路由**：`codearts`、`buddy`、`workbuddy`、`lobsterai`、`qoder`、`trae`、`cline`、`loomy`、`raccoon`。装本插件即同时具备这 9 条通道与原有的 `antigravity`，不必再单独安装 [dsh-codearts-auth](https://gitee.com/iJetLi/deepseek-harness-codearts)（作者 Jet，MIT）
  - 复用而非重写：上游 TypeScript 源码经 esbuild 转译为 ESM 后整体置于 `lib/vendor/codearts/`（77 个文件，含 `qoder-auth-wasm.wasm`），其 MIT 许可证原文保留在同目录 `LICENSE`。本插件只做了接入，没有改上游实现
  - 接入方式：`lib/index.js` 的 `apply()` 末尾调用上游的 `apply(ctx)`，一个调用注册全部 9 条路由，与 `ctx.llm.registerAdapter` 同源（上下游都从 `@deepseek-ai/dsh-llm` 取 `LlmAdapter`）
  - 前端同理：上游 Jet Hub 客户端 bundle 以独立的 `window.__ModuleLoader__.load({ id: "dsh-codearts-auth" })` 块并入 `lib/client.js`，与本插件的设置页块并列，各自注册 `settings.section`
  - **失败隔离**：这 9 条路由依赖宿主的 `credentials` / `commands` 服务。上游 `apply()` 包在 try/catch 内，服务缺失或版本不匹配时只放弃这 9 条路由并打一条 warn，`antigravity` 路由照常注册
- `package.json`：`dependencies` 新增 `jose`（DPoP 签名，上游运行时依赖）；`peerDependencies` 新增 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/schemastery`（均 optional，由宿主提供）

### Changed
- 插件 `inject` 由 `["llm"]` 改为 `["llm", "credentials", "commands"]`（`export const inject` 与 `apply.inject` 同步）
- `test/client-render.test.mjs` 与 `test/client-render-populated.test.mjs`：新增 `loadGeminiSource()`，只取 `lib/client.js` 中 id 为 `dsh-gemini-pool` 的那个模块块做静态扫描与执行；`__ModuleLoader__.load` 的桩也改为按 id 过滤。原因是 client.js 现在含两个模块块，不区分会让上游 Jet Hub 块的组件覆盖被捕获的本插件组件，导致 7 项渲染测试误报失败

### 本版本未覆盖的验证
- **9 条融合路由的真实登录与调用未做端到端验证** —— 需要各平台的真实账号，当前环境没有。已验证的是：77 个 vendor 模块可正常 import、上游 `apply()` 可被调用、失败隔离生效（无宿主服务时只 warn 不崩）、原有 33 项测试全绿
- `npm install` 在本机需用 `--legacy-peer-deps`：仓库原有的 `@deepseek-ai/dsh-host-webserver` 与 `dsh-invariants` peer 冲突在本次改动前就存在，未在本次修改

## v0.5.3 — 2026-09-26

### Fixed
- **设置页整页空白（严重）**：设置页组件引用了两个从未声明的变量（`localeRev` / `setLocaleRev`，本意是语言切换后重渲染）。该引用位于组件渲染函数体内，一执行就抛 `ReferenceError`，React 随即卸载整个设置分区——表现就是「打开设置，插件卡片是空白的」。补上缺失的状态声明。已用真实渲染测试复现：修复前 18 项渲染测试中 13 项失败（失败栈为 `ReferenceError: localeRev is not defined at GeminiSettingsPage`），修复后 33 项全绿

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
