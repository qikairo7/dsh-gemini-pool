# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## v0.4.1 — 2026-09-25

### Fixed
- 账号成功响应不再清零累计失败计数：间歇性坏号的退避阶梯与 `disableThreshold` 退役机制恢复生效（新增 `clearCooldownUntil()` 只清冷却窗口；`clearCooldown()` 保留手动解禁的全重置语义）
- 禁用账号的探活恢复改走真实 `streamGenerateContent` 文本通道（1-token 最小探测）：配额元数据查询不再能"假阳性复活"被限流的账号
- 账号池整体耗尽时报 `EXHAUSTED` 而非 `AUTH`，不再误导用户重新登录
- 生图路径与流路径统一使用同一配额/限流判定（收紧后的 `isQuotaOrRateLimitError`），400 类错误文本中偶然出现的 "quota" 字样不再误伤账号
- 流式输出中途遭遇 429 时同样标记冷却（不再换号续流，保持响应完整性）
- 生图成功路径补漏 `await`；`files` 字段修正（README.zh.md → README.en.md）

### Added
- GitHub Actions：push / PR 自动跑 `npm run check`（零依赖，无 install）
- 6 项行为回归测试（冷却语义 / 探活通道与模型 / 池耗尽错误码 / 中流 429 / 生图误判），全部先以失败态验证过对应 bug 真实存在

## v0.4.0 — 2026-09-25

### Added
- 首次公开版本：Google AI Pro / Ultra 订阅账号池接入 DSH（Antigravity / Cloud Code Assist 通道）
- 多账号额度均衡、429 自动切换、坏号冷却与探活恢复、设置页账号卡片与每周 / 5 小时额度展示、生图工具接入
