# Startup images

Drop pictures here (`.png`, `.jpg`, `.gif`, `.bmp`, …) and pi's startup panel
draws one with [catimg](https://github.com/posva/catimg) in truecolor
(`bash scripts/install-catimg.sh` builds it; `install.sh` does this for you).
Everything here except this README is gitignored.

Choose which one in `agent/settings.json`:

```json
"startupFetch": {
  "mode": "cycle",
  "style": "half",
  "height": 13
}
```

| `mode` | Shows |
|---|---|
| `fixed` | `image` (a file name in this folder, or an absolute / `~/` path). Without `image`, the first file by name |
| `cycle` | the next image by name on every pi start, wrapping around |
| `random` | a random image on every pi start, never the same one twice in a row |
| `off` | no image; the ASCII distro logo |

`style` is how the picture is drawn — switch it with `/fetch style` (a picker)
or `/fetch style sextant`; `/fetch mode random` likewise sets the mode. Both
are saved to settings.json.

| `style` | Drawn with | Per cell |
|---|---|---|
| `block` | catimg full blocks `█` | 1 pixel |
| `half` (default) | catimg half blocks `▀`, exact colors | 1×2 |
| `quad` | chafa quadrants `▚` | 2×2 |
| `sextant` | chafa sextants `🬗` | 2×3 |
| `octant` | chafa octants (needs a recent font) | 2×4 |
| `braille` | chafa braille `⣿` — sharp edges, colors bleed | 2×4 dots |
| `ascii` | chafa, ASCII characters only | — |
| `pixels` | real pixels: Kitty graphics (kitty, Ghostty, WezTerm, herdr); iTerm2 falls back | native |

Finer styles sharpen outlines but each cell still has only two colors; a
chafa style without chafa installed (`bash scripts/install-chafa.sh`), or
`pixels` on a terminal without graphics, falls back to `half`. Animated GIFs
show their first frame.

`height` is in terminal rows (4–40, default 13); wide images are capped at 40
columns. `/fetch` advances to the next pick and redraws; `/fetch list` lists
this folder. With no images or `NO_COLOR` set, the panel quietly shows the ASCII distro
logo; a configured image without catimg shows it with a one-time warning.
chafa styles read png/jpg/gif/webp (whatever loaders it was built with), not
bmp/tga/psd/pnm — those fall back to `half`.
