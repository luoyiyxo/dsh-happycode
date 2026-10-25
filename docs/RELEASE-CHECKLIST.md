# Release checklist

Everything here is done **by you**. This repository never publishes, pushes or logs
in: the working copy is committed locally and `git remote` is empty on purpose.

```
PENDING BEFORE PUBLISHING
  [ ] real screenshots (menu row, dialog light + dark) replace the rendered previews
  [ ] a short GIF of the dialog in use
```

The dialog artwork in `screenshots/` is a **rendered preview** produced by
`scripts/render-preview.mjs` from the same geometry the client draws — accurate about
layout, honest about being synthetic. Capture the real thing before announcing:

1. Install locally (`pwsh -File scripts/install-local.ps1`) and open the dialog.
2. Save at 2× scale if you can:
   - `screenshots/menu-row.png` — the avatar menu, **HappyCode** between Settings and Feedback
   - `screenshots/dialog-dark.png`
   - `screenshots/dialog-light.png`
3. Record a GIF (5–8 s, under 5 MB): menu → click → dialog → hover a few cells →
   switch year → close. ScreenToGif (Windows), Kap (macOS) or `ffmpeg`/`peek` (Linux).
4. Point the READMEs at it and drop the "rendered preview" sentence:

   ```md
   ![Happycoding Everyday in DeepSeek Harness](screenshots/dialog-dark.png)
   ```
5. Commit: `git add screenshots README.md README.zh.md && git commit -m "docs: real screenshots"`

---

## 0 · Pre-flight (5 minutes)

```sh
cd dsh-happycode
node test/store.test.mjs                 # 29 tests
node test/host.test.mjs                  #  4 tests
node test/client.test.mjs                # 20 tests
node scripts/prepack-check.mjs           # packaging gate
npm pack --dry-run                       # 18 files, ~44 KB, no node_modules
```

`npm pack --dry-run` should list exactly:

```
assets/logo.svg  CHANGELOG.md  client/client.js  cordis.patch.yml  LICENSE
lib/*.js (7)     package.json  README.md  README.zh.md  screenshots/*
```

Bump the version in `package.json` **and** add the matching `## x.y.z` section to
`CHANGELOG.md` before any future release — the prepack gate refuses a version the
changelog does not describe. Semver: new feature → minor, fix → patch.

---

## 1 · GitHub

The repository is already initialised and committed on `main`. Only the remote and
the push are left.

1. Create the repository: <https://github.com/new>
   - name `dsh-happycode`, **Public**, **do not** initialise with a README,
     `.gitignore` or a license (all three already exist here).
2. Add the remote and push:

   ```sh
   git remote add origin https://github.com/luoyiyxo/dsh-happycode.git
   git push -u origin main
   ```

3. Optional but recommended — a `v0.1.0` release:
   <https://github.com/luoyiyxo/dsh-happycode/releases/new?tag=v0.1.0> —
   paste the `0.1.0` section of `CHANGELOG.md` as the body.
   A tag also makes the "What changed" link in the plugin manager point somewhere.
4. Repository settings → **About**: description
   `Your DeepSeek Harness activity as a GitHub-style contribution graph.`, and topics
   `deepseek`, `harness`, `dsh`, `dsh-plugin`, `contribution-graph`, `heatmap`.
5. Confirm GitHub detects the MIT license on the repository page.

---

## 2 · npm

```sh
npm login                       # once
npm whoami                      # sanity check
npm pack --dry-run              # one last look at the file list
npm publish --access public     # dsh-happycode is unscoped
```

After publishing:

```sh
npm view dsh-happycode version
npm view dsh-happycode dist.tarball
```

Prove the published artifact, not just the working copy, on a throwaway profile:

```sh
dsh plugin --profile web add dsh-happycode
```

Rolling back: `npm unpublish dsh-happycode@0.1.0` only works within 72 hours;
otherwise publish a fixed patch and `npm deprecate dsh-happycode@0.1.0 "reason"`.

The display name on the npm page comes from `description` / README — it is
"Happycoding Everyday"; the package itself stays `dsh-happycode`.

---

## 3 · awesome-dsh-plugin

Catalog: <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> — one PR, one
entry, merged by the maintainers. The site and the plugin market both read from it
(<https://awesome-dsh-plugin.com/plugins.json>), so nothing else needs submitting.

### Entry

The registry entry shape, matched to what `plugins.json` actually carries:

```json
{
  "name": "dsh-happycode",
  "owner": "luoyiyxo",
  "url": "https://github.com/luoyiyxo/dsh-happycode",
  "category": "usage",
  "description": {
    "en": "Happycoding Everyday — turns your DeepSeek Harness activity into a GitHub-style contribution graph: a HappyCode row in the account menu opens a centred dialog with your profile row, the year's activity as a five-shade heatmap, a year picker and a tooltip on every day. Read-only, local-only, zero network requests; the weights behind each day's value are configurable.",
    "zh": "Happycoding Everyday——把你在 DeepSeek Harness 的活动变成 GitHub 风格的年度贡献热力图：账号菜单里的 HappyCode 入口打开一个居中弹窗，含个人资料行、五档配色的年度热力图、年份选择器与逐格 tooltip。全本地计算、只读会话日志、零网络请求；每日贡献值的三项权重可配置。"
  },
  "npm": "dsh-happycode",
  "version": "0.1.0",
  "install": "dsh plugin --profile web add dsh-happycode",
  "capabilities": ["fs-read"]
}
```

Notes for the PR:

| Field | Value / why |
|---|---|
| `name` / `owner` | must match the repository path `luoyiyxo/dsh-happycode` |
| `category` | `usage` — the spec's suggestion. `ui` (UI Enhancements) is equally defensible: the graph lives in a host dialog. The maintainers may move it; that is fine |
| `description` | bilingual, one sentence of what it does and one of what it never does |
| `npm` / `version` | the registry maps npm packages for install and update checks |
| `install` | the one-line command users get from the market |
| `capabilities` | `fs-read` only — it reads `~/.dsh/sessions` and the projection cache; no shell, no writes outside its own cache, no network |
| `screenshots` | optional; add the GitHub raw URLs after step 0 if the market should show them |

### How to submit

1. Fork <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>.
2. Add the entry in the file the repository's `contributing.md` designates (the
   catalog is generated from its entries — do not hand-edit `plugins.json`).
3. Commit with `feat(entries): add dsh-happycode (usage)` and open the PR.
4. In the PR body: one paragraph on what it does, the install command, and a note
   that it needs DSH `0.2.1+` (declared in `engines.dsh`).
5. The entry goes live on the site and in the market once merged — usually within a
   day.

---

## 4 · Verification record (fill in as you go)

| Check | Result |
|---|---|
| 53 tests green on this machine | |
| `npm pack` dry run lists 18 files, ~44 KB | |
| Repository pushed, license detected, topics set | |
| `npm publish` succeeded, `npm view` shows 0.1.0 | |
| Installed from the registry into a throwaway profile | |
| Account-menu row reads **HappyCode** | |
| Dialog: centred, brand in the 90px band, closes three ways | |
| Profile row: avatar, name, "Coding since …", no e-mail | |
| Cells 21px, labels 18px, legend inside the card | |
| Year picker: current year plus up to two active years | |
| Tooltips match three hand-checked days | |
| Weights change recalculates | |
| Dark and light themes | |
| Corrupt session skipped, rest intact | |
| DevTools → Network empty after the dialog opens | |
| Market entry merged | |

---

## 5 · After it is listed

- The update path is the plugin manager: bump `version`, add the changelog section,
  `npm publish`, write the GitHub release — existing installs see "update available"
  with a *What changed* link. Nobody reinstalls anything.
- Anyone reporting a bug can paste `GET /dsh-happycode/api/status`; it carries counts,
  the time zone and error strings, never session content.
- Keep `docs/data-schema.md` honest: a change to the counting rules belongs there
  before it belongs in code.
