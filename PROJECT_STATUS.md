# PROJECT_STATUS

本文件记录 `dsh-gemini-pool` 插件的当前状态，供下一个会话接手。写于 2026-09-26。

路径一律相对本仓库根目录。仓库根 = 本文件所在目录。

---

## 0. 一句话定位

本仓库没有 M0–M9 里程碑体系，也没有 PLAN.md。当前状态：**v0.5.3 已发布，功能冻结在「可用」状态；本会话的工作全部在仓库之外**——向 10 个 DSH 插件市场提交收录，仓库代码零改动。

---

## 1. 任务坐标

仓库内没有 TASKS.md，没有任务卡编号，因此没有「做到 TASK-几」可言。

本会话完成的是仓库外的分发工作。剩余关键路径按依赖顺序：

1. 等 9 个 PR 的维护者审核（阻塞在别人手上，无法推进）。
2. `billLiao/awesome-dsh-plugin` 的 PR 可能被要求改开 issue，需回应。
3. `bruc3van` 的作者自荐区要星数 > 10 才能进，当前 0 星，只能等。
4. 星数上去之后再回头补自荐区。

---

## 2. 已完成

### 2.1 v0.5.3（上一会话完成，本会话已复核）

产物路径：`lib/client.js`。修复内容：`GeminiSettingsPage({ ctx })` 渲染体里用了 `localeRev` / `setLocaleRev`，但从未声明，导致设置卡片白屏。加一行 `useState` 声明。

验收证据（本会话实跑）：

```
npm run check
ℹ tests 33
ℹ pass 33
ℹ fail 0
ℹ duration_ms 630.4534
```

`npm run check` 定义在 `package.json`：6 个文件的 `node --check`，加 `node --test`。

### 2.2 插件市场收录（本会话主体工作）

10 个市场，9 个走 PR，1 个走网页接口。全部为公开可见动作，截至 2026-09-26 20:43 实测状态如下。

| 市场 | 星数 | 状态 |
|---|---|---|
| `awesome-dsh-plugin/awesome-dsh-plugin` | 16950 | PR #5901 OPEN，CI pass |
| `AdamPlatin123/dsh-plugin-radar` | 1467 | PR #825 OPEN |
| `beancookie/awesome-dsh-plugin` | 153 | PR #200 OPEN |
| `Alex-Yanggg/awesome-DSH-plugin` | 99 | PR #142 OPEN |
| `kejixiaoliang/awesome-dsh-plugins` | 43 | PR #104 OPEN |
| `dshworks/awesome-dsh-plugins` | 16 | PR #113 OPEN，CI pass |
| `billLiao/awesome-dsh-plugin` | 15 | PR #14 OPEN |
| `white0dew/awesome-dsh-plugins` | 12 | PR #18 OPEN |
| `cccakeee/awesome-dsh-plugins` | 8 | PR #27 OPEN |
| `dsh-plugin.market` | — | 已入库，无 PR |

免提交的 2 个：

- `bruc3van/awesome-dsh-plugin`（367★）：2026-09-26 已被维护者审核通过，写进了它的 `data/approved.json`，并渲染进 `catalog/media-vision.md`。
- `bradeGithub/DSH-Plugins-Marketplace`（167★）：靠 `dsh-plugin` topic 自动抓取，已收录。

`dsh-plugin.market` 的入库回执：

```
GET https://dsh-plugin.market/api/plugins/qikairo7/dsh-gemini-pool
HTTP 200
verificationStatus = FORMAT_VERIFIED
packageVersion = 0.5.3
```

### 2.3 完整提交手册

手册在**仓库之外**的工作区：`../prompts/awesome-lists-submission-playbook.md`（相对本仓库是上一级目录）。它记录了每个清单的插入格式、校验命令、本次 PR 结果，以及踩到的两个坑。

这个文件不在本仓库里，换设备不会跟着走。第 10 节把继续执行所需的要点摘了出来。

---

## 3. 关键决策

仓库内没有 DECISIONS.md。本会话新增的裁决如下。

**D1：描述文案改为事实陈述，删除宣传语。**

原描述是「DSH 用上 Gemini 的方式 —— 让你的 Google AI Pro 订阅成为编程模型池：多模态 / 前端生成 / 生图 / 多账号调度」。

改为：「多账号 Google Gemini 提供商：按剩余额度挑选账号，遇 429 指数退避切换，后台探活已禁用账号。」

原因：多个清单的收录规则明文拒收无法核实的宣传语（beancookie 写「描述只说功能，不带营销词」，bruc3van 写「不使用无法核实的宣传语」）。「前端生成」「生图」这类词会被维护者拿去对代码核。GitHub 仓库 description 也已同步改成同一句。

**D2：`billLiao` 分类放错的条目，按任务要求提 PR，同时在 PR 里公开说明与仓库规则的冲突。**

该仓库 `CONTRIBUTING.md` 写着「If the entry already exists in the wrong category, open an issue instead.」——分类放错请开 issue。我按手册提了 PR，并在 PR #14 留言说明这一点，请维护者决定是关掉改开 issue 还是直接合并。没有静默违反规则。

**D3：`white0dew` 必须同步改硬编码计数，否则构建失败。**

该仓库把「已审核条目数」写死在两个脚本里。追加第 12 条不同步改，`generate-content` 与 `validate-content` 全部报错。改动依据是该仓库自己的先例（提交 `060a399` 明文写着 counters bumped 10 -> 11）。

**D4：`cccakeee` 的分类页不手写，交给生成器。**

那两个页面由 `scripts/generate_docs.py` 从 CSV 生成。手写会被下次生成覆盖，还会让仓库不同步。只写 CSV 行。

---

## 4. 领域术语

`CONTEXT.md`：**未创建**。仓库内没有这个文件。

本会话涉及、且后续会反复用到的术语：

- **provider route `antigravity`**：插件注册的 LLM 路由名。不能改。
- **API 前缀 `/antigravity/api`**：插件 HTTP 端点前缀。不能改。
- **账号池**：多个 Google 账号组成调度池，按剩余额度挑账号，遇 429 换号。
- **探活（probe）**：后台用 1-token 最小请求 `streamGenerateContent` 探测已禁用账号是否恢复。
- **cooldown**：账号失败后进入冷却期，到期前不参与调度。
- **manifest 门禁**：多数清单要求 `package.json` 声明 `dsh.bundle.patch`。本仓库满足。

---

## 5. 仓库与提交状态

以下全部用命令实取，非印象。

| 项 | 值 |
|---|---|
| 远端 | `https://github.com/qikairo7/dsh-gemini-pool.git`（公开） |
| 当前分支 | `master` |
| HEAD commit | `825e97d docs: correct the falsification counts in CHANGELOG v0.5.3` |
| 最近 5 条提交 | `825e97d` / `5a4553b` / `198bac6` / `42df42e` / `5ecd692` |
| 工作树 | 干净（`git status --porcelain` 无输出） |
| 未推送 commit | 0 |
| 里程碑 tag | 无「里程碑」tag；版本 tag 有 v0.4.0、v0.4.1、v0.5.0、v0.5.1、v0.5.2、v0.5.3 |
| 追踪文件数 | 38 |
| 本会话新增 commit | 见文末「归档」；本文件所在 commit |

注意：工作区根目录（本仓库的上一级）**不是** git 仓库。整个工作区只有本仓库和若干无关目录，`git rev-parse` 在上一级会报 `fatal: not a git repository`。

---

## 6. 测试与验证结果

命令 → 实际输出：

```
$ npm run check
ℹ tests 33
ℹ suites 0
ℹ pass 33
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 630.4534
```

未覆盖的部分：

- **真实 Google 端点未测**。单测全部用 fake，不发真实网络请求。登录、额度查询、429 切换、探活的真实行为没有自动化覆盖。
- **浏览器渲染未跑**。`test/client-render.test.mjs` 与 `test/client-render-populated.test.mjs` 用 `new Function` 加 DOM/React shim 跑真实渲染函数，但不是真浏览器。真实浏览器里的表现需要人工确认。
- **`npm run pack:dist` 在 Windows 上不可用**。脚本写的是 `mkdir -p dist`，Windows 会把 `-p` 当成目录名。打 tgz 请用 `npm pack`（先手动建好 `dist` 目录，`--pack-destination` 不建目录）。

---

## 7. 已知问题

**7.1 封号风险（不是 bug，是产品事实）**

现象：插件复用 Antigravity 客户端身份访问 Google 接口。Google 已官方确认这属于服务条款违规，2026 年 2 月有过大规模封禁，付费用户也被波及。

影响：使用者可能被封号。

规避：`README.md` 与 `README.en.md` 顶部有专门的「封号风险，使用前必读」章节，引用 gemini-cli 官方公告。给市场提交的条目也都带了这个披露（`cccakeee` 的 CSV 里 `risk_level` 记为 `medium`）。

**7.2 `.gitignore` 缺三项**

现象：`build`、`.env`、`*.local` 没有被忽略。

影响：目前仓库里没有这类文件，暂时无实际影响。但 `.env` 一旦出现就会被 `git add .` 带进去。

规避：本会话已补。见第 5 节所在 commit。

**7.3 `billLiao` 的分类修正可能被下次同步覆盖**

现象：那个仓库的 `data/plugins.json` 是生成器的数据源，里面仍是旧分类和旧描述。分类规则在 `scripts/dsh_classify.py`。

影响：如果维护者不改分类规则，下次同步会把旧行加回来。

规避：PR #14 的描述里已经请维护者去修分类规则。无法从我们这边根治。

**7.4 几个 PR 的 CI 显示「等待批准」**

现象：`beancookie` #200、`kejixiaoliang` #104、`Alex-Yanggg` #142、`white0dew` #18 的 CI 结论是 `action_required`。

影响：无。这是 GitHub 对首次贡献者的默认人工闸门，不是失败。

规避：等维护者点批准。本地跑同样的命令都通过。

---

## 8. 尝试过但失败的方案

**8.1 用 `gh api` 加 `--jq` 读大 JSON，失败。**

做了什么：`gh api repos/.../contents/data/plugins.json --jq '.content' | %{ base64 解码 } | Out-File`，再用 node 解析。

失败原因：PowerShell 的管道把 6.9 MB 的 JSON 截断了，node 报 `Unexpected end of JSON input`。

结论：改用 node 脚本直接 `fetch` raw.githubusercontent.com，或者用 `gh api ... > file.json` 重定向到文件再读。**不要再试管道解码大 JSON。**

**8.2 PowerShell 内联 `node -e` 脚本被吞引号，失败。**

做了什么：把多行 node 脚本塞进 `node -e "..."`。

失败原因：PowerShell 解析 `"` 和 `^{commit}` 时当成 scriptblock 处理。

结论：写成 `.mjs` 脚本文件再跑。**不要再试内联长脚本。**

**8.3 给 `white0dew` 只改源数据就提交，会构建失败。**

做了什么：手册原写法是只改 `data/sources/reviewed-catalog-additions.json`。

失败原因：`scripts/generate-content.mjs` 写死 `records.length !== 11`，`scripts/validate-content.mjs` 写死两处 `!== 11`，两处基数 `8561`。加第 12 条全部报错。

结论：必须同步改成 12 与 8562。**不要再试「只改源数据」。**

**8.4 给 `cccakeee` 手写分类页表格行，会被覆盖。**

做了什么：手册原写法给了现成的 markdown 表格行。

失败原因：那两个页面由 `scripts/generate_docs.py` 从 CSV 生成。

结论：只写 CSV，跑生成器。**不要再试手写分类页。**

---

## 9. 刻意简化与已知天花板

`git grep -nE "(#|//) ?ponytail:"` 无输出。本仓库**没有 ponytail 标记**。

下面是本会话识别出的、未打标记但属于同类性质的天花板：

- `package.json` 的 `pack:dist` 脚本在 Windows 上不可用（`mkdir -p`）。ceiling：只在 Unix 上能跑。upgrade：换成 `node -e "fs.mkdirSync(...)"` 或 `New-Item -ItemType Directory -Force`。no-trigger：不影响发布流程，发布走 `npm pack`。
- `test/client-render*.test.mjs` 用 `new Function` 加手写 DOM shim 跑渲染，不是真浏览器。ceiling：测不出真实浏览器里的 CSS 与布局问题。upgrade：接 Playwright。no-trigger：设置卡片白屏这类 JS 异常能测出来，够用。
- 单测全部用 fake，不打真实 Google 端点。ceiling：登录与 429 切换的真实行为无自动化覆盖。upgrade：加一个可选的真实端点冒烟测试（需凭据，默认跳过）。no-trigger：真实行为由人工验证。

---

## 10. 下一步开发顺序

第一条必须精确到文件与函数。

**第 1 步：处理 `billLiao` PR #14 的规则冲突。**

- 目标：`https://github.com/billLiao/awesome-dsh-plugin/pull/14`
- 动作：等维护者回应。若要求改开 issue，就在该仓库开一个 issue，正文用 PR 描述里已写好的内容（分类理由 + 生成器规则待修），然后关掉 PR。
- 验收：该 PR 状态变为 merged 或 closed，且若 closed 则对应的 issue 已创建。

**第 2 步：核对 9 个 PR 的最新状态。**

- 动作：`gh search prs --author qikairo7 --state open --limit 40 --json repository,number,title,url`。逐个看是否有维护者留言要求改动。
- 验收：每个 PR 都有明确去向（merged / 被要求改动 / 仍待审）。

**第 3 步：处理 CI 的 `action_required`。**

- 目标：`beancookie` #200、`kejixiaoliang` #104、`Alex-Yanggg` #142、`white0dew` #18。
- 动作：不需要我们做任何事。若维护者久不批准，可以在 PR 里礼貌催一次。
- 验收：CI 从 `action_required` 变为 pass 或 fail。

**第 4 步：等星数 > 10 后补 `bruc3van` 自荐区。**

- 目标：`bruc3van/awesome-dsh-plugin` 的 `SHOWCASE.md`。
- 动作：在该文件的「作者自荐」与「Author showcase」两个列表末尾各追加一行（中英对应）。规则见该仓库 `CONTRIBUTING.md` 的「作者自荐」节。CI 会校验星数 > 10，不达标直接拒。
- 验收：PR 提交且 CI 通过。

**第 5 步（可选）：修 `pack:dist` 的 Windows 兼容。**

- 目标：`package.json` 的 `scripts.pack:dist`。
- 预期改动：把 `mkdir -p dist && npm pack --pack-destination dist` 换成跨平台写法。
- 验收：Windows 上跑 `npm run pack:dist` 能产出 tgz。

---

## 11. 待确认

| # | 问题 | 阻塞等级 | 默认假设 |
|---|---|---|---|
| 1 | `billLiao` 要求改开 issue 吗 | 中 | 等维护者回应；不主动关 PR |
| 2 | 是否需要把提交手册复制进仓库 | 低 | 不复制。手册是工作区文件，与本插件源码无关 |
| 3 | `AdamPlatin123` 要求 `@dsh-external/*` scope 吗 | 低 | 不改 `package.json`。该要求写在 PR 模板自检清单里，不是硬门禁 |
| 4 | 是否要发布到 npm | 低 | 暂不发布。当前安装方式是 `dsh plugin --profile web add github:qikairo7/dsh-gemini-pool` |

---

## 12. 建议调用的 skills

按下一步的性质挑：

**第 1、2 步（处理 PR 与 review 回应）**

- `my-voice` — 写 PR 描述、回复 review 时按这个风格。本会话的 PR 正文就是按它写的。
- `pr` — 写 PR 正文。

**第 5 步（改 `package.json` 脚本）**

- `ponytail` — 这是个最小改动，它会把方案压到最短。
- `verification-before-completion` — 声称修好之前必须先在 Windows 上实跑一次。

**通用**

- `port-guard` — 收工前查本会话有没有留下后台进程或占用端口。
- `jev-skill-select` — 拿不准用哪个 skill 时问它。

---

## 归档

以下内容已完成，保留供追溯。

**本会话（2026-09-26）**

- 完成 9 个 PR + 1 个市场入库。清单见第 2.2 节。
- 更新 GitHub 仓库 description 为事实陈述。
- 修正提交手册里的两处错误（第 8.3、8.4 节）。
- 补 `.gitignore` 的 `build`、`.env`、`*.local`。
- 复核 v0.5.3：`npm run check` 33 通过 0 失败。

**上一会话**

- v0.5.3：修复设置卡片白屏。产物 `lib/client.js`。
- v0.5.2：修复账号池持久化（重载后账号丢失）。
- v0.5.1：修复请求失败的 `ReferenceError`，合并并发 token 刷新。
- v0.5.0 / v0.4.1 / v0.4.0：见 `CHANGELOG.md`。
