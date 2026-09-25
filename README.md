<div align="center">

### dsh-gemini-pool

**把多个 Google Gemini 账号，变成一个会自我修复的模型池**

[English](./README.en.md) · 简体中文

<a href="https://github.com/qikairo7/dsh-gemini-pool/releases"><img src="https://img.shields.io/github/v/release/qikairo7/dsh-gemini-pool?color=369eff&labelColor=black&logo=github&style=flat-square" alt="release"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/stargazers"><img src="https://img.shields.io/github/stars/qikairo7/dsh-gemini-pool?color=ffcb47&labelColor=black&style=flat-square" alt="stars"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/issues"><img src="https://img.shields.io/github/issues/qikairo7/dsh-gemini-pool?color=ff80eb&labelColor=black&style=flat-square" alt="issues"></a>
<a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square" alt="license"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/commits/master"><img src="https://img.shields.io/github/last-commit/qikairo7/dsh-gemini-pool?color=c4f042&labelColor=black&style=flat-square" alt="last commit"></a>

[GitHub](https://github.com/qikairo7/dsh-gemini-pool) ·
[Issues](https://github.com/qikairo7/dsh-gemini-pool/issues) ·
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ·
[上游项目](https://github.com/LiZhenNet/dsh-antigravity)

</div>

---

## ✨ 这是什么

dsh-gemini-pool 是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的模型提供插件。它把你手里的多个 Google 账号组成一个统一的账号池——额度自动均衡、429 自动切换、坏号自动冷却与探活恢复。你在对话里永远不会看到「额度用尽，请稍后再试」。

打开设置页，每个账号一张卡片，每周与 5 小时额度实时可见；池子背后，调度、切换、冷却、探活全部自动完成。

<p align="center">
  <img src="./assets/images/screenshots/settings-1.png" alt="dsh-gemini-pool 设置页" width="78%">
</p>

---

## 🆚 为什么需要它

| | 单账号直连 | dsh-gemini-pool |
|---|:---:|:---:|
| 429 / 限频 | ❌ 报错，干等窗口重置 | ✅ 无感切换到健康账号 |
| 多账号管理 | ❌ 手动换号重登 | ✅ 一键加号，全池调度 |
| 额度情况 | ❌ 黑盒 | ✅ 每账号实时额度条 |
| 坏账号 | ❌ 反复撞同一个死号 | ✅ 自动禁用 + 探活复活 |
| 前端生图 | ❌ 手动切模型 | ✅ `antigravity_image_generate` 自动出图 |
| 界面语言 | — | ✅ 中文 / English，明暗双主题 |

---

## 🚀 快速开始

**1. 安装插件**

```sh
dsh plugin --profile web add github:qikairo7/dsh-gemini-pool
```

**2. 登录 Google 账号**

打开 DSH 设置 → **Antigravity** → 点击「＋ 添加 Google 账号」完成授权。想加几个加几个。

**3. 完成**

模型选择器里勾选要用的模型，直接开聊。额度刷新、账号调度全部自动。

<details>
<summary><kbd>离线安装 / 手动安装</kbd></summary>

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-gemini-pool-0.4.0.tgz
```

若 DSH 版本不支持 `dsh plugin add`，手动复制包到 `$DSH_HOME/profiles/web/node_modules/`，并在 `cordis.patch.yml` 中添加：

```yaml
- insert:
    - id: dsh-gemini-pool
      name: dsh-gemini-pool
```

</details>

---

## 💧 账号池与调度

三种调度策略，设置页一键切换：

- **智能均衡（推荐）** — 自动挑选剩余额度最健康的账号
- **主备切换** — 固定主账号，额度耗尽自动切备用
- **手动指定** — 锁定单一账号，用于调试或专跑

凭证存储在 `$DSH_HOME/storages/antigravity-pool-accounts.json`，包含 access/refresh token，请妥善保管。旧版单账号凭证升级时自动迁移，无需重新登录。

---

## 🧊 冷却与自愈

账号遇到 429 后自动进入指数退避冷却，连续失败达阈值则禁用并转入后台探活，额度恢复即自动回归——全程无需人工干预。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `cooldownMs` | 1 分钟 | 首次冷却时长，之后逐次翻倍 |
| `cooldownMaxMs` | 1 小时 | 冷却时长上限 |
| `disableThreshold` | 5 次 | 连续失败达到即禁用该账号 |
| `probeIntervalMs` | 5 分钟 | 后台探活间隔，恢复即自动启用 |

被禁用的账号在设置页显示红色标签，可点「重新启用」一键恢复。以上参数均可在设置页「冷却与恢复」折叠区调整。

---

## 🤖 模型一览

设置页勾选即用，已勾选的模型自动置顶，每个模型实时显示池内最高可用额度。

<p align="center">
  <img src="./assets/images/screenshots/settings-2.png" alt="调度策略与模型选择器" width="48%">
  <img src="./assets/images/screenshots/settings-3.png" alt="默认生图配置" width="40%">
</p>

| 模型 | 额度池 |
|---|---|
| Gemini 3.8 / 3.7 / 3.6 / 3.5 Flash | Gemini |
| Gemini 3.1 Pro · Gemini 3.1 Flash Image（生图） | Gemini |
| Gemini 3 Flash · Gemini 2.5 Pro / Flash | Gemini |
| Claude Opus 4.6 · Claude Sonnet 4.6 · GPT-OSS 120B | Claude & GPT |

同一额度池内共享每周与 5 小时额度；额度按 token 成本比例消耗，越重的模型烧得越快。

---

## 📄 许可证与致谢

[MIT](./LICENSE)。非官方集成，与 Google 无关；请仅在您有权使用的账号上使用。

基于 [@LiZhenNet](https://github.com/LiZhenNet) 的 [dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity) 构建，感谢 [@Lukeknow0](https://github.com/Lukeknow0)、[@miuzel](https://github.com/miuzel)、[@grloper](https://github.com/grloper)、[@sereineele](https://github.com/sereineele) 的社区贡献。
