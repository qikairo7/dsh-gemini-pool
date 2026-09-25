# Security Policy

## 报告漏洞

请通过 GitHub 的 **Private Vulnerability Reporting**（仓库 Security 页 → Report a vulnerability）私下报告安全问题，请勿开公开 issue。

## 凭据处理设计（本插件的隐私承诺）

- Google OAuth token 只写入本机 DSH 数据区（`DSH_HOME`）下的凭据文件，不会上传到任何第三方端点；请求只发往 Google 官方端点
- 所有错误在进入日志 / UI 前经过统一脱敏（`redactSecrets`：覆盖 `ya29.`、Bearer、refresh token、JSON 键值等形态）
- 设置页与文档截图应使用占位邮箱；如您在发布物中发现真实账号信息，属安全缺陷，请按上文私下报告
- OAuth 回调服务器仅绑定 loopback；API base 锁定官方域名白名单

## 账号风险提示

使用订阅额度做编程调用存在被 Google 限流 / 封号的社区反馈（README 已如实说明）。这是服务商政策风险，不属于本插件的安全缺陷，但欢迎分享应对经验。
