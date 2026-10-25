# Screenshots

`dialog-light.svg` and `dialog-dark.svg` are **rendered previews**, not captures:
`scripts/render-preview.mjs` draws them from the same geometry the client uses
(21px cells, 3px gaps, Monday-based columns, Jan–Dec labels, the profile row, the
brand at the right of the title bar) with synthetic data and a made-up identity.

Replace them with real captures before announcing the plugin:

| File | What to capture |
|---|---|
| `menu-row.png` | the avatar menu, the entry between Settings and Feedback |
| `dialog-dark.png` | the dialog, dark theme |
| `dialog-light.png` | the dialog, light theme |
| `happycode.gif` | menu → click → dialog → hover cells → switch year → close |

Keep in mind that a capture of the real dialog also settles the one thing the
preview cannot: whether the account-menu row is wide enough for
`Happycoding Everyday` (it may need the short name `HappyCode` there).

See `docs/RELEASE-CHECKLIST.md` § 1 for the recording suggestions and the README
snippet that points at the GIF.
