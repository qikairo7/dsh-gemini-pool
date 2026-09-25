<div align="center">

### dsh-gemini-pool

**The way to use Gemini in DSH — turn your Google AI Pro subscription into a coding model pool**

English · [简体中文](./README.md)

<a href="https://github.com/qikairo7/dsh-gemini-pool/releases"><img src="https://img.shields.io/github/v/release/qikairo7/dsh-gemini-pool?color=369eff&labelColor=black&logo=github&style=flat-square" alt="release"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/stargazers"><img src="https://img.shields.io/github/stars/qikairo7/dsh-gemini-pool?color=ffcb47&labelColor=black&style=flat-square" alt="stars"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/issues"><img src="https://img.shields.io/github/issues/qikairo7/dsh-gemini-pool?color=ff80eb&labelColor=black&style=flat-square" alt="issues"></a>
<a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square" alt="license"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/commits/master"><img src="https://img.shields.io/github/last-commit/qikairo7/dsh-gemini-pool?color=c4f042&labelColor=black&style=flat-square" alt="last commit"></a>
<a href="https://github.com/qikairo7/dsh-gemini-pool/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/qikairo7/dsh-gemini-pool/check.yml?color=7ee787&labelColor=black&label=check&style=flat-square" alt="CI"></a>

[GitHub](https://github.com/qikairo7/dsh-gemini-pool) ·
[Issues](https://github.com/qikairo7/dsh-gemini-pool/issues) ·
[Changelog](./CHANGELOG.md) ·
[Security](./SECURITY.md) ·
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ·
[Upstream](https://github.com/LiZhenNet/dsh-antigravity)

</div>

---

## ✨ What is this

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) cannot reach Gemini on its own. This plugin bridges the gap: through the Google Antigravity / Cloud Code Assist channel, it connects your existing **Google AI Pro subscription** to DSH. No extra API key, no separate bill.

Gemini's strengths line up with coding work: **multimodal** input that reads images, **frontend / UI code generation**, and **image generation** for interface assets. This plugin puts all three inside DSH, billed against your subscription quota.

Have more than one Google account? Add them all to a **pool**: quotas balance across accounts, 429s fail over to the next account, and failing accounts cool down and recover by themselves. Settings shows one card per account with live weekly and 5-hour quota bars.

<p align="center">
  <img src="./assets/images/screenshots/settings-1.png" alt="dsh-gemini-pool settings page" width="78%">
</p>

---

## 🆚 Why you need it

Installing this plugin changes what your Google AI Pro subscription can do:

| | Without: web-only subscription | With: subscription inside DSH |
|---|:---:|:---:|
| Gemini multimodal (vision) | ❌ unavailable while coding | ✅ drop images into the chat |
| Frontend / UI codegen | ❌ no project context in web | ✅ reads your actual codebase |
| Image gen for UI assets | ⚠️ manual copy-paste | ✅ `antigravity_image_generate` auto-saves |
| Multi-account quota | — | ✅ pool scheduling, seamless 429 failover |
| Quota visibility | ❌ black box | ✅ live per-account bars |
| Unhealthy accounts | ❌ keep hitting dead ones | ✅ auto-disable + probe + revive |

> Read "⚠️ Account Ban Risk" below before installing.

---

## ⚠️ Account Ban Risk — Read Before Installing

This is an unofficial third-party tool. It reaches Google endpoints by reusing the Antigravity client identity. **Google has officially confirmed that using third-party tools to access Antigravity resources violates the Terms of Service, and has carried out mass bans** (see the [official gemini-cli announcement](https://github.com/google-gemini/gemini-cli/discussions/20632), Feb 2026 — paid subscribers were affected too).

**Enforcement mechanism** (as published by Google):

- First violation → email notice + recertification form → automatic reinstatement in 1–2 days
- **Second violation → permanent ban**
- Scope: most reports involve the Antigravity / Gemini channel being blocked, and paid quota is forfeited with it; **the community has asked Google twice whether a ban also hits the whole Google account (Gmail / Drive), and Google has never answered directly** — assume the worst
- Enforcement is sampling-based: many third-party users run for months untouched, but **nobody can promise you are not next**

**Three ways to reduce risk**:

1. **Use a throwaway account**: register a separate Google account, never the main one holding your real assets
2. **Keep usage moderate**: the built-in exponential backoff and cooldown help, but do not deliberately push quota limits
3. **Assume the channel can break at any time**: the endpoints belong to Google and policy may tighten

Using this plugin means you understand and accept these risks. This project is not affiliated with Google.

---

## 🆚 How is this different from API relays

You can also pay a relay for Gemini API access by the token. That is a different trade:

| | API relay / reseller | dsh-gemini-pool |
|---|:---:|:---:|
| **Cost** | pay-per-token with a markup | flat subscription, marginal cost ≈ 0 |
| **Model authenticity** | ⚠️ may be silently downgraded | ✅ direct to official endpoints |
| **Privacy** | ⚠️ your code/chats/images pass through the operator's server | ✅ in-process straight to Google, no middleman |
| **Quota visibility** | a single opaque "site balance" | live weekly / 5h bars per account |
| **Exit risk** | relays vanish or degrade, balance gone overnight | no third party touches your money |

The relay has one real advantage: **bans hit the operator's accounts, yours stays clean**. The line is simple — account safety first, light usage, or just trying things out: use a relay. Already subscribed, privacy-conscious, want the real models long-term: use this.

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
# the package name carries the current version from package.json; install the file actually generated under dist/
dsh plugin --profile web add ./dist/dsh-gemini-pool-*.tgz
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

- **Smart balancing (recommended)**: picks the account with the healthiest remaining quota
- **Primary & backup**: fixed primary account, automatic switch when its quota runs out
- **Manual**: lock to one account for debugging or dedicated runs

Credentials are stored in `$DSH_HOME/storages/antigravity-pool-accounts.json`, including access and refresh tokens. Keep that file private. Legacy single-account credentials migrate automatically on upgrade, so you do not have to sign in again.

---

## 🧊 Cooldown & Self-healing

An account that hits 429 enters exponential-backoff cooldown. Repeated failures disable it and hand it to a background probe that revives it once quota recovers. No manual steps.

| Parameter | Default | Description |
|---|---|---|
| `cooldownMs` | 1 min | initial cooldown, doubling on each failure |
| `cooldownMaxMs` | 1 hr | cooldown cap |
| `disableThreshold` | 5 | consecutive failures before disable |
| `probeIntervalMs` | 5 min | background probe interval, auto-revive on success |

Disabled accounts carry a red tag in Settings and a one-click "Re-enable" button. All of these parameters are adjustable in the "Cooldown & Recovery" section.

---

## 🤖 Models

Tick a model in Settings to enable it. Enabled models float to the top, each showing the highest available quota in the pool.

<p>
  <img src="./assets/images/screenshots/settings-2.png" alt="Dispatch strategy and model selector" width="45%">
</p>
<p>
  <img src="./assets/images/screenshots/settings-3.png" alt="Image generation defaults" width="45%">
</p>

| Model | Quota pool |
|---|---|
| Gemini 3.8 / 3.7 / 3.6 / 3.5 Flash | Gemini |
| Gemini 3.1 Pro · Gemini 3.1 Flash Image (image gen) | Gemini |
| Gemini 3 Flash · Gemini 2.5 Pro / Flash | Gemini |
| Claude Opus 4.6 · Claude Sonnet 4.6 · GPT-OSS 120B | Claude & GPT |

Models in the same pool share the weekly and 5-hour quotas. Quota drains in proportion to token cost, so heavier models run out faster.

---

## 📄 License & Credits

[MIT](./LICENSE).

Built on [dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity) by [@LiZhenNet](https://github.com/LiZhenNet), with community contributions from [@Lukeknow0](https://github.com/Lukeknow0), [@miuzel](https://github.com/miuzel), [@grloper](https://github.com/grloper) and [@sereineele](https://github.com/sereineele).
