# Nesty brand assets

The mark is a nest egg: two coins in a woven nest. The nest is `#f3f1ff`, the coins
`#2ee6a8`, on a `#131124` tile. The coins' green is the UIs' colour too: every action in
the extension and on the website, buying, and market caps.

| File                                                     | Use                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| `nesty-icon.svg`                                         | App icon: the mark on its rounded tile (master)                 |
| `nesty-mark.svg`                                         | The mark alone, transparent, for dark backgrounds               |
| `nesty-mark-mono.svg`                                    | One colour (`currentColor`), for light backgrounds and stamps   |
| `nesty-toolbar.svg`                                      | Extension icon: the mark with a dark edge, no tile (master)     |
| `nesty-lockup-on-dark.svg` / `-on-light.svg`             | Icon + wordmark, for headers, README, slides                    |
| `favicon.ico`                                            | Favicon (16 / 32 / 48)                                          |
| `png/icon-{16…1024}.png`                                 | The rounded icon at common sizes (PWA 192 / 512)                |
| `png/apple-touch-icon-180.png`, `png/app-store-1024.png` | Square, no transparency: iOS and the stores round the corners   |
| `png/icon-maskable-512.png`                              | Android / PWA maskable: full bleed, mark inside the safe circle |
| `png/mark-1024.png`                                      | The mark alone                                                  |
| `png/toolbar-{16,32,48,128}.png`                         | Extension icons (copied to `public/icon/`)                      |
| `png/og-1200x630.png`, `png/github-social-1280x640.png`  | Link previews                                                   |
| `png/lockup-on-dark.png`, `png/lockup-on-light.png`      | Wordmark images                                                 |

The extension icons are the mark alone on a transparent ground, filling the box. Its
shapes grown by 2.5 units in the tile colour make an edge that keeps the white nest
visible on a light toolbar. The 128 px one keeps the Chrome Web Store's 16 px transparent
margin.

The wordmark is "nesty" in Barlow Semi Condensed ExtraBold (SIL Open Font License),
tracked −1 % and outlined, its x-height centred on the tile.

## Geometry

Every shape is a plain filled path, no masks, so the files work in any renderer and the
same paths are inlined in `src/ui/NestMark.tsx`. On the 64-unit grid of the icon:

- **Nest:** the lower half of an ellipse centred at (32, 33) with radii 22 × 20, closed
  by the rim `Q 32 39` from (10, 33) to (54, 33); two weave cuts 2.2 wide along
  `M8 37.5 Q31 44 56 41` and `M10 47.5 Q33 50 54 44`.
- **Coins:** radius 9.5 at (36.5, 27) in front and radius 8 at (25.5, 28.5) behind, each
  kept 2 units clear of the nest and of the other coin.
- The whole mark then moves up 3.25 so it sits centred on the tile (corner radius 15).

The PNGs are those SVGs rasterised by Chrome at each size; any SVG renderer gives the same.
