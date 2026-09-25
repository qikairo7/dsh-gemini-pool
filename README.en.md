<div align="center">

### dsh-gemini-pool

**The way to use Gemini in DSH — turn your Google AI Pro subscription into a coding model pool**

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

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) cannot talk to Gemini directly. This plugin is the bridge: via the Google Antigravity / Cloud Code Assist channel, it plugs your existing **Google AI Pro subscription** straight into DSH — no extra API keys, your subscription quota just works.

Why Gemini? Best-in-class **multimodal** understanding, excellent **frontend/UI code generation**, and built-in **image generation** for interface assets — exactly the capabilities that matter most when coding, now billed against a subscription you may already pay for.

More than one Google account? Pool them all: quotas auto-balanced, 429s fail over seamlessly, unhealthy accounts cool down and self-heal. Every account is a card with live weekly and 5-hour quota bars — scheduling is fully automatic.

<p align="center">
  <img src="./assets/images/screenshots/settings-1.png" alt="dsh-gemini-pool settings page" width="78%">
</p>

---

## 🆚 Why you need it

With or without this plugin, your Google AI Pro subscription lives two different lives:

| | Without: web-only subscription | With: subscription inside DSH |
|---|:---:|:---:|
| Gemini multimodal (vision) | ❌ unavailable while coding | ✅ drop images into the chat |
| Frontend / UI codegen | ❌ no project context in web | ✅ reads your actual codebase |
| Image gen for UI assets | ⚠️ manual copy-paste | ✅ `antigravity_image_generate` auto-saves |
| Multi-account quota | — | ✅ pool scheduling, seamless 429 failover |
| Quota visibility | ❌ black box | ✅ live per-account bars |
| Unhealthy accounts | ❌ keep hitting dead ones | ✅ auto-disable + probe + revive |

---

## ⚠️ Account Ban Risk — Read Before Installing

This is an unofficial third-party tool that accesses Google endpoints by impersonating the Antigravity client. **Google has officially confirmed that using third-party tools to access Antigravity resources violates the Terms of Service, and has carried out mass bans** (see the [official gemini-cli announcement](https://github.com/google-gemini/gemini-cli/discussions/20632), Feb 2026 — paid subscribers were affected too).

**Enforcement ladder** (per Google's own post):

- First violation → email notice + recertification form → automatic reinstatement in 1–2 days
- **Second violation → permanent ban**
- Scope: most reports involve the Antigravity / Gemini channel being blocked (paid quota forfeited); **whether bans extend to the whole Google account (Gmail / Drive) has never been answered by Google** — assume the worst
- Enforcement is sampling-based: many third-party users run for months untouched, but **nobody can promise you're next-proof**

**Three ways to reduce risk**:

1. **Use a dedicated account** — never your primary Google account
2. **Stay moderate** — the built-in exponential backoff helps, but don't stress-test quota limits
3. **Accept that the channel can die anytime** — the endpoints belong to Google and policy may tighten

Using this plugin means you understand and accept these risks. This project is not affiliated with Google.

---

## 🆚 How is this different from API relays

You could also buy Gemini API access from a paid relay — but that's a different animal:

| | API relay / reseller | dsh-gemini-pool |
|---|:---:|:---:|
| **Cost** | pay-per-token with a markup | flat subscription, marginal cost ≈ 0 |
| **Model authenticity** | ⚠️ may be silently downgraded | ✅ direct to official endpoints |
| **Privacy** | ⚠️ your code/chats/images pass through the operator's server | ✅ in-process straight to Google, no middleman |
| **Quota visibility** | a single opaque "site balance" | live weekly / 5h bars per account |
| **Exit risk** | relays vanish or degrade, balance gone overnight | no third party touches your money |

The relay's one real advantage: **bans hit the operator's accounts, not yours**. So the line is simple — account-safety-first, light usage, or just trying things out: use a relay. Already subscribed, privacy-conscious, want real models long-term: use this.

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

[MIT](./LICENSE).

Built on [dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity) by [@LiZhenNet](https://github.com/LiZhenNet), with contributions from [@Lukeknow0](https://github.com/Lukeknow0), [@miuzel](https://github.com/miuzel), [@grloper](https://github.com/grloper) and [@sereineele](https://github.com/sereineele).
