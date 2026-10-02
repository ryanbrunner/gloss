# The Gloss mark

A G cut from solid shapes, with a ◆ for its crossbar. It is built the way the
Reeve mark is, on the same tile, in the same inks and at the same weight, so
the two read as one family: the G is the reviewer's, and the ◆, in sky, is
Claude.

| File | Use on | Inks |
| --- | --- | --- |
| `gloss-mark.svg` | Anywhere: favicon, app icon, avatars | `#0e1116` tile (radius 14/64), G in `#e6edf3`, ◆ in `#00a6f4` |
| `gloss-glyph-dark.svg` | Dark grounds, such as the bar's `#0e1116` and `#161b22` | G `#e6edf3`, ◆ `#00a6f4` |
| `gloss-glyph-light.svg` | White and light grounds | G `#0e1116`, ◆ `#0069a8` |
| `gloss-glyph-mono.svg` | One-colour print | everything `#0e1116` |

- **Minimum size:** 16px for the tile, 12px tall for a glyph.
- **Clear space:** at least the stroke's width (11/64 of the tile) on every side.
- **With the word:** the glyph goes first, about as tall as the capitals,
  then "Gloss".
- **In the bar:** `src/bar/logo.ts` draws the same glyph node by node, for
  pages that enforce Trusted Types. Change it with these files.
- **Don't:** recolour the ◆ to anything but sky, add a glow or gradient, or set
  the G in a font.
