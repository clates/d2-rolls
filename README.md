# D2R Rolls

Fuzzy search for Diablo II: Resurrected (Reign of the Warlock) uniques, set items and bases, showing
every roll range. Ranges are highlighted; fixed mods are dimmer.

Search matches item, set, base and type names plus mod text, with common shorthand (`fcr`, `ias`,
`mf`, `ed`, `ll`, `cb`, `allres`…). Put a number in the query to find what can roll it: `37 fire res`
finds the items whose Fire Resist range covers 37 and highlights the line. `"Quoted phrases"` match
as one term. The query lives in `?q=`, so every search is a shareable link; click an item's name to
link to it alone. `/` focuses search, `Esc` clears.

## Data

Everything comes from a local D2R install, so it matches the patch you're playing:

- `tools/extract.py` reads the game's CASC storage via [CascLib] and writes the data tables and
  English strings to `raw/`, and the HD inventory sprites to `public/img/` as webp.
- `tools/build-data.mjs` turns `raw/` into `public/items.json`. Mod text comes from
  [d2itemtoolkit], a reimplementation of the game's tooltip engine. Each item is rendered at its
  minimum and maximum rolls, and the two tooltips are merged line by line into `{lo-hi}` ranges.

`raw/` and `public/img/` are committed, so CI doesn't need the game. After a patch:

```sh
git clone https://github.com/ladislav-zezula/CascLib && cmake -S CascLib -B CascLib/build \
  -DCASC_BUILD_SHARED_LIB=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5 && make -C CascLib/build
CASCLIB=CascLib/build/libcasc.so python3 tools/extract.py   # optional arg: game dir
npm run data
```

## Develop

```sh
npm install
npm run data   # regenerate public/items.json
npm run dev
```

Pushing to `main` deploys to GitHub Pages (Settings → Pages → Source: GitHub Actions).

Diablo II game data and art are © Blizzard Entertainment. This is a fan-made reference tool.

[CascLib]: https://github.com/ladislav-zezula/CascLib
[d2itemtoolkit]: https://github.com/ResurrectedTrader/D2ItemToolkit
