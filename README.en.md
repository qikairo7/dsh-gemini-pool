<div align="center">

### dsh-gemini-pool

**Turn multiple Google Gemini accounts into one self-healing model pool**

English · [简体中文](./README.md)

<a href="https://github.com/qikairo7/dsh-gemini-pool/releases"><img src="https://img.shields.io/github/v/release/qikairo7/dsh-gemini-pool?color=369eff&labelColor=black&logo=github&style=flat-square" alt="release"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/stargazers"><img src="https://img.shields.io/github/stars/qikairo7/dsh-gemini-pool?color=ffcb47&labelColor=black&style=flat-square" alt="stars"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/issues"><img src="https://img.shields.io/github/issues/qikairo7/dsh-gemini-pool?color=ff80eb&labelColor=black&style=flat-square" alt="issues"></a>
<a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square" alt="license"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/commits/master"><img src="https://img.shields.io/github/last-commit/qikairo7/dsh-gemini-pool?color=c4f042&labelColor=black&style=flat-square" alt="last commit"></a>

[GitHub](https://github.com/qikairo7/dsh-gemini-pool) ·
[Issues](https://github.com/qikairo7/dsh-gemini-pool/issues) ·
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ·
[Upstream](https://github.com/LiZhenNet/dsh-antigravity)

</div>

---

## ✨ What is this

dsh-gemini-pool is a model provider plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It pools your Google accounts into one scheduling layer — quotas auto-balanced, 429s auto-failed-over, unhealthy accounts auto-cooled and probed back to life. You never see "quota exceeded" in your session.

Open the settings page and every account is a card with live weekly and 5-hour quota bars; behind the scenes, scheduling, failover, cooldown and probing are fully automatic.

<p align="center">
  <img src="./assets/images/screenshots/settings-1.png" alt="dsh-gemini-pool settings page" width="78%">
</p>

---

## 🆚 Why you need it

| | Single account | dsh-gemini-pool |
|---|:---:|:---:|
| 429 / rate limits | ❌ error out until reset | ✅ seamless failover to a healthy account |
| Multiple accounts | ❌ manual re-login to switch | ✅ one-click add, pool-wide scheduling |
| Quota visibility | ❌ black box | ✅ live per-account quota bars |
| Unhealthy accounts | ❌ keep hitting the same dead one | ✅ auto-disable + probe + revive |
| Frontend images | ❌ manual model switching | ✅ `antigravity_image_generate` tool |
| UI language | — | ✅ English / 简体中文, light & dark |

---

## 🚀 Quick Start

**1. Install the plugin**

```sh
dsh plugin --profile web add github:qikairo7/dsh-gemini-pool
```

**2. Sign in with Google**

Open DSH Settings → **Antigravity** → click "＋ Add Google Account" and authorize. Add as many as you like.

**3. Done**

Tick the models you want in the model selector and start chatting. Quota refresh and scheduling are automatic.

<details>
<summary><kbd>Offline / manual install</kbd></summary>

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-gemini-pool-0.4.0.tgz
```

If your DSH does not support `dsh plugin add`, copy the package into `$DSH_HOME/profiles/web/node_modules/` and add to `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-gemini-pool
      name: dsh-gemini-pool
```

</details>

---

## 💧 Account Pool & Scheduling

Three strategies, one click to switch in Settings:

- **Smart Balancing (recommended)** — picks the account with the healthiest remaining quota
- **Primary & Backup** — fixed primary, automatic switch when exhausted
- **Manual** — lock to one account for debugging or dedicated runs

Credentials live in `$DSH_HOME/storages/antigravity-pool-accounts.json` (contains access/refresh tokens — keep it private). Legacy single-account credentials migrate automatically on upgrade.

---

## 🧊 Cooldown & Self-healing

On 429, an account enters exponential-backoff cooldown; repeated failures disable it and hand it to a background prober that revives it as soon as quota recovers — no manual babysitting.

| Parameter | Default | Description |
|---|---|---|
| `cooldownMs` | 1 min | initial cooldown, doubling on each failure |
| `cooldownMaxMs` | 1 hr | cooldown cap |
| `disableThreshold` | 5 | consecutive failures before disable |
| `probeIntervalMs` | 5 min | background probe interval, auto-revive on success |

Disabled accounts show a red tag in Settings with a one-click "Re-enable" button. All parameters are adjustable in the "Cooldown & Recovery" section.

---

## 🤖 Models

Tick to enable in Settings; enabled models float to the top with live best-quota percentages.

<p align="center">
  <img src="./assets/images/screenshots/settings-2.png" alt="Dispatch strategy and model selector" width="48%">
  <img src="./assets/images/screenshots/settings-3.png" alt="Image generation defaults" width="40%">
</p>

| Model | Quota pool |
|---|---|
| Gemini 3.8 / 3.7 / 3.6 / 3.5 Flash | Gemini |
| Gemini 3.1 Pro · Gemini 3.1 Flash Image | Gemini |
| Gemini 3 Flash · Gemini 2.5 Pro / Flash | Gemini |
| Claude Opus 4.6 · Claude Sonnet 4.6 · GPT-OSS 120B | Claude & GPT |

Models in the same pool share weekly and 5-hour quotas; quota drains proportionally to token cost.

---

## 📄 License & Credits

[MIT](./LICENSE). Unofficial integration, not affiliated with Google; use only with accounts you are authorized to access.

Built on [dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity) by [@LiZhenNet](https://github.com/LiZhenNet), with contributions from [@Lukeknow0](https://github.com/Lukeknow0), [@miuzel](https://github.com/miuzel), [@grloper](https://github.com/grloper) and [@sereineele](https://github.com/sereineele).
