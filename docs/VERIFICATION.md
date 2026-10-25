# Verification record

Specification **v6.0** §14, item by item. "Automated" means a test in `test/`
proves it; "manual" means it was checked in the running install.

Environment: DSH Desktop `0.2.1-rc.2`, Node `24.21.0`, Windows 11, time zone
`Asia/Shanghai` (UTC+8), 16 real sessions across 4 workspaces.

## Change history

All six revision rounds shipped together as **0.1.0** — the plugin was debugged in a
local directory install and never published before this release, so the rounds are
listed by spec revision rather than by version. Every round was client-side except
one server field added in the v5 round; the injector, the indexer, the cache format
and the counting rules never moved.

| # | Change | Round | Where |
|---|---|---|---|
| R1–R5 | single year view, legend in the card, 14–16px cells, centred title, year list = current ∪ active | v3 | `client/client.js`, `lib/store.js` |
| R6 | content block centred vertically | v4 | superseded by R9 |
| R7 | cells 20–21px (floor 14px), dialog `min(1500px, 94vw)` | v4 | `client/client.js` |
| R8 | month and weekday labels 18px | v4 | `client/client.js` |
| R9 | height follows the content, no min-height, no vertical centring | v5 | `client/client.js` |
| R10 | brand "Happycoding Everyday", right-aligned at 24px | v5 | superseded by R12/R13 |
| R11 | profile row (avatar, name, `Coding since …`) + `firstActivity` | v5 | `client/client.js`, `lib/store.js` |
| R12 | **menu row back to the short name `HappyCode`**, dialog keeps the brand | v6 | `client/client.js` |
| R13 | **brand centred in a 90px band at 28–30px** (24px floor), close pinned top-right | v6 | `client/client.js` |
| R14 | **profile row horizontal** — 120px rounded avatar, name 24px, since 16px, text column bottom-aligned | v6 | `client/client.js` |
| R15 | **vertical rhythm** — 40px band→profile, 36px profile→total, 24px bottom | v6 | `client/client.js` |

## v6 acceptance checklist

| # | Acceptance item | Status | Evidence |
|---|---|---|---|
| 1 | The account-menu row reads "HappyCode" (short name, not renamed) | **automated** | `client.test.mjs` — the injected row's text and `aria-label` are both `HappyCode`, still between Settings and Feedback |
| 2 | Title band: "Happycoding Everyday" centred, bold, ≈28–30px; close button top-right unchanged | **automated + manual** | `client.test.mjs` — `.hc-title` is `clamp(24px,2vw,30px)` / 600 / `text-align:center` / nowrap; `.hc-header` is 90px tall with `justify-content:center`; `.hc-close` is `position:absolute; right:16px` |
| 3 | Profile row is horizontal: avatar left, name (24px bold) over `Coding since` (16px) to its right, text column bottom-aligned with the avatar | **automated** | `client.test.mjs` — `.hc-profile` is `align-items:flex-end` with a 24px gap; `.hc-avatar` is 120px with a 24px radius; `.hc-profile-name` 24px, `.hc-profile-since` 16px |
| 4 | Vertical rhythm: 40px band→profile, 36px profile→total, balanced, no dead space | **automated** | `client.test.mjs` — `.hc-profile{margin-top:40px}`, `.hc-summary{margin-top:36px}`, `.hc-cardrow{margin-top:20px}`, body bottom padding 24px |
| 5 | Height follows the content; centred in both full-screen and small windows | **automated + manual** | `.hc-panel` has no `min-height` (asserted); the overlay centres with `margin:auto` |
| 6 | No e-mail in the profile row; the row hides when neither avatar nor name is available | **automated** | `client.test.mjs` — four identity cases, including a launcher labelled `luo***@example.com` that yields no row and no `@` |
| 7 | Regression: cells 20–21px, labels 18px, legend inside the card bottom-right | **automated** | The sizing test (21 → 17 → 14px) and the legend-placement test are unchanged and green |
| 8 | Year picker follows R5 (current year always listed, up to three, descending) | **automated** | `store.test.mjs` — `2026 → [2026, 2025, 2024]`, `2027 → [2027, 2026, 2025]`, `2029 → [2029, 2028, 2027]` |
| 9 | Three spot-checked days match the raw logs; both hover states tooltip, with ordinals | **automated + live data** | Independent count: `2026-10-24 → 8/11/0 = 19`; `client.test.mjs` asserts both tooltip strings |
| 10 | Light and dark themes, following the host | **automated + manual** | `client.test.mjs` asserts `data-hc-theme="dark"` from the theme service |
| 11 | Changing a weight recalculates immediately | **automated** | `store.test.mjs` (1/1/3 → 4/1/3 changes the totals) |
| 12 | Empty state works; a corrupt session does not break the rest | **automated** | `client.test.mjs` (empty title/body) and `store.test.mjs` (reserved block type → skipped) |
| 13 | Zero network requests | **automated** | `scripts/prepack-check.mjs` rejects any URL in the client bundle except the SVG namespace; the avatar mirrors only an image the host already loaded |
| 14 | The `npm pack` artifact installs, and `package.json.name` is still `dsh-happycode` | **manual** | `prepack-check.mjs` pins the name; the local install is used for the visual check |

> **Avatar size.** v5 specified a 56px circle; v6 asks for "the current ~120px
> rounded square". Both numbers are explicit in v6 (FR-14 and the prompt), so the
> avatar is 120px with a 24px radius. If the intent was to keep the 56px circle,
> it is two declarations in `.hc-avatar`.

## Live install (the server half as shipped in 0.1.0)

```
GET /dsh-happycode/api/status
  sessions indexed : 16          active days     : 2
  zone             : Asia/Shanghai|-480
  zstd available   : true        unreadable logs : 0

GET /dsh-happycode/api/graph?year=2026
  total 983, thresholds 9/19/39, availableYears [2026]
  firstActivity { date: '2026-10-24', source: 'activity' }
  2026-10-24  m=8   t=11   f=0   value=19   level=2
  2026-10-25  m=30  t=271  f=95  value=586  level=4
```

`2026-10-24 = 19` matches an independent count taken straight from the raw logs.

## Measured numbers

| Metric | Requirement | Measured |
|---|---|---|
| First index, 16 sessions / 1.3 MB of logs | ≤ 30 s at 500 sessions | **88 ms** |
| Incremental refresh, nothing changed | ≤ 2 s | **6 ms** |
| Popup opening from a warm cache | ≤ 300 ms to first paint | served from `daily.json` in a single local request |
| Cell size at the 1500px design width | 20–21px | **21px** (gap 3px) |
| Dialog height at this machine's data | follows the content | 90 (band) + 40 + 120 (avatar) + 36 + 26 + 20 + 224 (card) + 24 ≈ **580px** |

## What the automated suite covers

```
test/store.test.mjs   29 tests  zstd framing, torn tails, counting rules,
                                cache reuse/invalidation, deletion, corruption,
                                projection-cache skipping, year windows, the R5
                                year list, firstActivity, quartiles, routes,
                                path resolution
test/host.test.mjs     4 tests  cordis entry, global try/catch, one route per path,
                                degradation without a web server
test/client.test.mjs  20 tests  menu injection and cleanup, short menu name, title
                                band, dialog open/close, no range switch, legend
                                placement, responsive cell sizing, stylesheet sizes,
                                profile row layout and its fallbacks, tooltips,
                                padding cells, year switch, empty/error states, theme
```

Run them with `npm test`. The client tests boot the real bundle in jsdom against a
fake host menu and account launcher with the same DOM shape the DSH client renders.
