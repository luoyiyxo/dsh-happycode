# Screenshots

Real captures of the running plugin (DSH Desktop `0.2.1-rc.2`, Windows 11, a
1500px-wide dialog at 1× scale):

| File | Shows |
|---|---|
| `dialog-light.png` | the dialog in the light theme: title band, profile row, the year's heatmap, year picker, legend |
| `dialog-dark.png` | the same in the dark theme |

Both frames are 1:1 captures of the dialog itself — the panel spans almost the whole
image, which is why there is no surrounding backdrop.

Still missing, and welcome as a follow-up PR:

| File | What to capture |
|---|---|
| `menu-row.png` | the avatar menu with **HappyCode** between Settings and Feedback |
| `happycode.gif` | menu → click → dialog → hover a few cells → switch year → close |

`scripts/render-preview.mjs` can still draw an SVG preview of the layout (same
geometry as the client) when a screenshot is not convenient; its output is not
committed.
