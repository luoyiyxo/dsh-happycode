# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and from 0.1.0 the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html): a new feature
bumps the minor version, a fix bumps the patch version.

## 0.1.0 — 2026-10-25

First release. Everything below was built and verified against DSH Desktop
`0.2.1-rc.2` on Windows before this version was cut.

### Added

**Entry and container**

- A **HappyCode** row in the sidebar account menu, between Settings and Feedback.
  The host builds that menu from a hardcoded array, so the row is a clone of the
  host's own Settings row — typography, spacing and hover state come from the host
  itself — and it joins the menu's keyboard traversal because the host's navigation
  queries the DOM. A 16px layered heat-grid glyph marks the row.
- A **centred modal** modelled on the host's Settings dialog: Escape, a backdrop
  click and the top-right button all close it; it stays centred at any window size;
  `min(1500px, 94vw)` wide with no fixed height, so it grows with its content and
  scrolls internally past 88vh.
- A **90px title band** carrying "Happycoding Everyday" centred at
  `clamp(24px, 2vw, 30px)`, with the close button pinned to the corner.
- A **profile row**: 120px rounded avatar, the account name at 24px and
  `Coding since Oct 2026` at 16px, the text column bottom-aligned with the avatar.

**The graph**

- A **GitHub-cloned contribution heatmap** for one calendar year: Monday-based
  columns, January–December labels, Mon/Wed/Fri row labels, blank padding cells at
  both ends so no neighbouring year leaks in, a ring on today, and the Less–More
  legend inside the card under the grid.
- **Cells sized to the card** — `(width − label column − chart gap) / 53 − gap`,
  21px at the 1500px design width, 14px floor, recomputed on resize; below the
  floor the card scrolls horizontally.
- **A tooltip on every cell**, filled or not: `19 contributions on October 24th.`
  and `No contributions on October 23rd.`, GitHub's wording with ordinals.
- **Quartile bucketing** over the selected year (25th/50th/75th percentile of the
  non-zero days), falling back to GitHub's fixed thresholds with fewer than eight
  active days or when the quartiles collapse.
- **Light and dark GitHub palettes**, following the host theme live, with text and
  borders from host design tokens.
- **A year picker** on the right of the card: the current year ∪ years with
  activity, newest three, descending, so 1 January of a new year still shows a
  (blank) graph.

**Data**

- A session indexer that decodes DSH's concatenated-Zstandard JSONL logs (the
  511 KB sample on the development machine held 126 frames, and Node's one-shot
  decoder reads only the first), streams the rows, attributes each event to a local
  calendar day, and caches `{messages, tools, edits}` per day.
- Counting rules calibrated against real logs: a message turn is a `user/message`
  whose source is a real user (injected runtime context and skill catalogs are
  excluded), a tool call is a `tool/call`, and a file edit is a tool call by
  `write` / `edit` / `str_replace_editor` and friends. Sub-agent sessions are
  skipped, so a delegated turn is never counted twice.
- **Incremental caching** in `<profile>/.dsh-happycode/`: `sessions.json` keeps the
  per-session day map (so a deleted log is subtracted rather than rescanning),
  `daily.json` is the materialised union, and both carry a schema version and a
  time-zone signature — a mismatch rebuilds instead of serving wrong days.
- **HTTP routes**: `GET /dsh-happycode/api/graph?year=YYYY` (with `total`, `days`,
  `thresholds`, `availableYears` and `firstActivity`), `GET|POST .../settings`,
  `POST .../refresh`, `GET .../status`.
- **Configurable weights** — three numbers (default 1 / 1 / 3) and a Recalculate
  button on the plugin's page under Plugins.

### Notes

- 53 automated tests: decoding and framing, counting rules, cache reuse and
  invalidation, year windows, the year list, routes, the account-menu injection,
  the dialog, the profile row and its fallbacks.
- Measured on the development machine: 16 sessions / 1.3 MB of logs index in 88 ms,
  an unchanged refresh takes 6 ms.
- Read-only on `~/.dsh/sessions/` and the session projection cache; the only
  writable path is `<profile>/.dsh-happycode/`.
- No network requests at runtime. The avatar is mirrored from the host's own
  already-loaded image, never fetched; the account name is refused when the host's
  fallback turns out to be a masked e-mail.
