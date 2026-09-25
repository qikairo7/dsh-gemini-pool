<div align="center">

<a href="https://github.com/qikairo7/dsh-gemini-pool">
  <picture>
    <img src="./assets/images/screenshots/settings-1.png" alt="dsh-gemini-pool 设置页" width="100%">
  </picture>
</a>

### dsh-gemini-pool

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的
多账号 Google Gemini / Antigravity 模型提供商

[English](./README.md) | 简体中文

<a href="https://github.com/qikairo7/dsh-gemini-pool/releases"><img src="https://img.shields.io/github/v/release/qikairo7/dsh-gemini-pool?color=369eff&labelColor=black&logo=github&style=flat-square" alt="release"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/stargazers"><img src="https://img.shields.io/github/stars/qikairo7/dsh-gemini-pool?color=ffcb47&labelColor=black&style=flat-square" alt="stars"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/issues"><img src="https://img.shields.io/github/issues/qikairo7/dsh-gemini-pool?color=ff80eb&labelColor=black&style=flat-square" alt="issues"></a>
<a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square" alt="license"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/commits/master"><img src="https://img.shields.io/github/last-commit/qikairo7/dsh-gemini-pool?color=c4f042&labelColor=black&style=flat-square" alt="last commit"></a>

<a href="https://github.com/qikairo7/dsh-gemini-pool">GitHub</a> ·
<a href="https://github.com/qikairo7/dsh-gemini-pool/issues">Issues</a> ·
<a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ·
<a href="https://github.com/LiZhenNet/dsh-antigravity">上游项目</a>

</div>

***

<details>
  <summary><kbd>目录</kbd></summary>

- [为什么选 dsh-gemini-pool](#为什么选-dsh-gemini-pool)
- [安装](#安装到-dsh-web)
- [登录与账号池管理](#登录与账号池管理)
- [冷却与恢复](#冷却与恢复)
- [模型列表](#模型列表)
- [许可证](#许可证)
- [致谢](#致谢)

</details>

<br>

## 为什么选 dsh-gemini-pool

dsh-gemini-pool 把单个 Antigravity OAuth 登录变成一个会自我修复的账号池：
你添加的每个 Google 账号都成为独立展示额度条的调度候选，被限流的账号自动轮换、
冷却、探活、恢复——全程你的会话看不到一条报错。

| 能力 | 单账号裸用 | dsh-gemini-pool |
|---|---|---|
| **429 / 限频处理** | ❌ 窗口重置前一直报错 | ✅ 无感切换 + 指数退避冷却 |
| **多 Google 账号** | ❌ 一次只能登一个 | ✅ 全池智能均衡调度 |
| **额度可见** | ❌ 黑盒 | ✅ 每账号每周 + 5 小时实时额度条 |
| **坏账号处理** | ❌ 反复撞同一个死号 | ✅ 自动禁用、后台探活、一键重新启用 |
| **前端生图** | ❌ | ✅ `antigravity_image_generate` 工具 |
| **双语设置界面** | — | ✅ 中文 / English，明暗双主题 |

> 非官方集成。本项目与 Google 无关，亦未获得 Google 认可。请仅在您有权访问的账号和服务中使用。

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

## 冷却与恢复

当账号遇到 429（限频或额度用尽）时，会自动进入指数退避冷却，不阻断池内其他账号调度：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `cooldownMs` | `60000` (1分钟) | 初始冷却基础时长 |
| `cooldownMaxMs` | `3600000` (1小时) | 最大冷却时长上限 |
| `disableThreshold` | `5` | 连续失败达到该次数后状态转为 `disabled`（已禁用） |
| `probeIntervalMs` | `300000` (5分钟) | 后台自动探活间隔，检测已禁用账号是否恢复额度 |

已禁用的账号不会参与调度。您可以在设置页点击 **「重新启用」** 按钮手动恢复，或者等待后台探活成功后自动恢复为活跃状态。

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

## 许可证

[MIT](./LICENSE)

## 致谢

基于 [@LiZhenNet](https://github.com/LiZhenNet) 的
[dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity) 构建，感谢
[@Lukeknow0](https://github.com/Lukeknow0)、[@miuzel](https://github.com/miuzel)、
[@grloper](https://github.com/grloper)、[@sereineele](https://github.com/sereineele) 的社区贡献。
