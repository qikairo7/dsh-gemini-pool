# dsh-gemini-pool

<p align="center">
  <img src="./assets/images/screenshots/settings-1.png" alt="Gemini Pool 设置页" width="100%" />
</p>

[English](./README.md) | 简体中文

多账号 Google Gemini / Antigravity / Cloud Code Assist 模型提供商插件，适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：智能额度均衡、429 指数退避与自动无感故障转移、后台探活、前端生图、中英双语卡片式设置页（明暗主题支持）。

这是一个 DSH Web 插件。它在 provider 路由 `antigravity` 下注册 DSH `LlmAdapter`，OAuth 凭证存储于 DSH home 目录下，直接与 Cloud Code Assist 流式 API 通信，并且 Web 设置页面完整支持中英文双语国际化（i18n）。

> 非官方集成。本项目与 Google 无关，亦未获得 Google 认可。请仅在您有权访问的账号和服务中使用。

---

## 安装到 DSH Web

### 方式一：直接从 GitHub 安装

```sh
dsh plugin --profile web add github:qikairo7/dsh-gemini-pool
```

### 方式二：通过本地 Release 包安装

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-gemini-pool-0.4.0.tgz
```

该 package 声明了 DSH bundle patch，安装后会自动挂载 host 插件与浏览器设置页面。

如果您的 DSH 版本暂不支持 `dsh plugin add`，可手动复制到 Web profile：

```sh
cp -R dsh-gemini-pool "$DSH_HOME/profiles/web/node_modules/"
```

然后在 profile 的 `cordis.patch.yml` 中添加该插件：

```yaml
- insert:
    - id: dsh-gemini-pool
      name: dsh-gemini-pool
```

重启 DSH：

```sh
dsh web
```

---

## 登录与账号池管理

打开 **设置（Settings）> Antigravity**，支持添加和管理多个 Google 账号：

- **智能均衡（默认推荐）**：自动挑选剩余配额最健康的账号发起请求。
- **429 无感故障转移（Failover）**：当某一账号达到短期速率限制或配额耗尽时，毫秒级自动切换至备用账号重试，前端零感知报错。
- **无损向后兼容**：初次升级将自动把原 `antigravity-oauth.json` 迁移为账号池主账号，无需重新登录。
- **前端生图工具集成**：注册 `antigravity_image_generate` 工具，主模型编写前端代码时可直接在后台调起 `gemini-3.1-flash-image` 生成插画素材并自动保存至 `./assets/images`。

点击 **「＋ 添加 Google 账号」** 可持续追加账号，卡片实时展示各账号独立的 Gemini（绿条）与 Claude（青条）配额进度条。

凭证存储路径：

```text
$DSH_HOME/storages/antigravity-pool-accounts.json
```

> 请妥善保管该文件，其中包含 access token 与 refresh token。

---

## 冷却与恢复

当账号遇到 429（限频或额度用尽）时，会自动进入指数退避冷却，不阻断池内其他账号调度：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `cooldownMs` | `60000` (1分钟) | 初始冷却基础时长 |
| `cooldownMaxMs` | `3600000` (1小时) | 最大冷却时长上限 |
| `disableThreshold` | `5` | 连续失败达到该次数后状态转为 `disabled`（已禁用） |
| `probeIntervalMs` | `300000` (5分钟) | 后台自动探活间隔，检测已禁用账号是否恢复额度 |

已禁用的账号不会参与调度。您可以在设置页点击 **「重新启用」** 按钮手动恢复，或者等待后台探活成功后自动恢复为活跃状态。

---

---

## 模型列表

登录后，在 DSH 模型选择器中选择 **Antigravity** 提供商。您可以在 **设置 > Antigravity** 的模型选择器中按需勾选或关闭单个模型（已勾选的模型将自动置顶展示），每个模型副标题均会显示其实时可用额度百分比。

<p align="center">
  <img src="./assets/images/screenshots/settings-2.png" alt="调度策略与模型选择器" width="52%" />
  <img src="./assets/images/screenshots/settings-3.png" alt="默认生图配置" width="42%" />
</p>

支持注册的模型 ID：

| 模型 ID | 名称 | 额度池 |
|---|---|---|
| `gemini-3.8-flash` | Gemini 3.8 Flash | Gemini |
| `gemini-3.7-flash` | Gemini 3.7 Flash | Gemini |
| `gemini-3.6-flash` | Gemini 3.6 Flash | Gemini |
| `gemini-3.5-flash` | Gemini 3.5 Flash | Gemini |
| `gemini-3.1-pro` | Gemini 3.1 Pro | Gemini |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | Gemini |
| `gemini-3-flash` | Gemini 3 Flash | Gemini |
| `gemini-2.5-pro` | Gemini 2.5 Pro | Gemini |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Gemini |
| `claude-opus-4-6` | Claude Opus 4.6 | Claude & GPT (3P) |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Claude & GPT (3P) |
| `gpt-oss-120b` | GPT-OSS 120B | Claude & GPT (3P) |

同一额度池内的模型共享 5 小时与每周额度。额度按 Token 成本比例扣除，因此较重的大模型（如 Claude Opus）消耗额度速度会快于轻量模型。

插件会在可用时通过实时的 `fetchAvailableModels` 目录将这些公开 ID 解析为内部运行时模型 ID，并自带静态路由兜底。

---

## 许可证

[MIT](./LICENSE)

## 致谢

基于 [@LiZhenNet](https://github.com/LiZhenNet) 的
[dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity) 构建，感谢
[@Lukeknow0](https://github.com/Lukeknow0)、[@miuzel](https://github.com/miuzel)、
[@grloper](https://github.com/grloper)、[@sereineele](https://github.com/sereineele) 的社区贡献。
