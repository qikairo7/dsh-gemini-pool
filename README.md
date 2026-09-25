# dsh-gemini-pool

<p align="center">
  <img src="./assets/images/screenshots/settings-1.png" alt="Gemini Pool settings page" width="100%" />
</p>

English | [简体中文](./README.zh.md)

Multi-account Google Gemini / Antigravity / Cloud Code Assist provider for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — smart
quota balancing, exponential cooldown with auto-failover, background health probing, frontend image generation, and a
bilingual card-based settings UI with light/dark theme support.

This is a DSH Web plugin. It registers a DSH `LlmAdapter`
under provider route `antigravity`, stores OAuth credentials under DSH home,
talks to the Cloud Code Assist streaming API directly, and provides full bilingual (English & Simplified Chinese) i18n support in the Web settings page.

> Unofficial integration. This project is not affiliated with or endorsed by
> Google. Use it only with accounts and services you are authorized to access.

## Install into DSH Web

### Option 1: Direct from GitHub

```sh
dsh plugin --profile web add github:qikairo7/dsh-gemini-pool
```

### Option 2: From Local Release Tarball

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-gemini-pool-0.4.0.tgz
```

The package declares a DSH bundle patch, so installation automatically mounts
the host plugin and browser settings page.

If your DSH version does not support `dsh plugin add`, copy the package into
the Web profile manually:

```sh
cp -R dsh-gemini-pool "$DSH_HOME/profiles/web/node_modules/"
```

Then add the plugin to the profile `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-gemini-pool
      name: dsh-gemini-pool
```

Restart DSH:

```sh
dsh web
```

## Multi-Account Pool & Login

Open **Settings > Antigravity** to manage Google Gemini accounts:

- **Smart Balancing**: Automatically selects the account with the highest remaining quota.
- **Seamless 429 Failover**: Automatically retries using backup accounts when rate-limited (`RESOURCE_EXHAUSTED`), eliminating client errors.
- **Backward Compatible**: Automatically migrates existing single `antigravity-oauth.json` into Account 1.
- **Frontend Image Generation Tool**: Integrates `antigravity_image_generate` to automatically generate web illustrations using `gemini-3.1-flash-image` into `./assets/images`.

Click **「＋ Add Google Account」** to append additional accounts into the pool.

Credentials are stored at:

```text
$DSH_HOME/storages/antigravity-pool-accounts.json
```

Keep that file private. It contains access and refresh tokens.

## Cooldown & Recovery

When an account encounters 429 (rate limits or individual quota exhausted), it enters an exponential cooldown state machine without blocking the pool:

| Parameter | Default | Description |
| --- | --- | --- |
| `cooldownMs` | `60000` (1 min) | Initial cooldown base time |
| `cooldownMaxMs` | `3600000` (1 hr) | Maximum cooldown duration cap |
| `disableThreshold` | `5` | Consecutively failed attempts before account status becomes `disabled` |
| `probeIntervalMs` | `300000` (5 min) | Background probe interval to test disabled accounts and automatically restore them |

Accounts marked as `disabled` are removed from scheduling candidates and can be manually re-enabled in Settings with the **「Re-enable」** button, or restored automatically by the background probe once quota recovers.

## Models

After login, select the **Antigravity** provider in DSH's model picker. Use the
model selector in **Settings > Antigravity** to enable or disable individual
models (enabled models are prioritized at the top of the list) — the live remaining quota percentage is shown next to each one.

<p align="center">
  <img src="./assets/images/screenshots/settings-2.png" alt="Dispatch strategy and model selector" width="52%" />
  <img src="./assets/images/screenshots/settings-3.png" alt="Image generation defaults" width="42%" />
</p>

Registered model IDs:

| Model ID | Name | Quota pool |
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

Models in the same quota pool share a weekly limit and a 5-hour limit. Quota is
consumed proportionally to token cost, so heavier models (e.g. Claude Opus)
drain the pool faster than lighter ones.

The plugin resolves these public IDs to runtime model IDs using the live
`fetchAvailableModels` catalog when available, with static routing fallbacks.

## License

MIT

## Credits

Built on [dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity) by
[@LiZhenNet](https://github.com/LiZhenNet), with community contributions from
[@Lukeknow0](https://github.com/Lukeknow0), [@miuzel](https://github.com/miuzel),
[@grloper](https://github.com/grloper) and [@sereineele](https://github.com/sereineele).
