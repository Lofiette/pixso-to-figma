# State

## Now

- **Task:** Pixso -> Figma migration, 1:1.
- **Status:** the run is a single deterministic command, no model in the loop:

  ```
  node tools/migrate.mjs <pixsoSectionId>
  ```

  It needs Pixso desktop with its MCP on `127.0.0.1:3667`, and the `pix-to-fig runner` plugin
  open in the target Figma file (one-time install: Plugins -> Development -> Import plugin from
  manifest -> `figma-plugin/manifest.json`).

- **Sections done:**
  - `Яга Статьи` (1855 nodes) — pilot. 1486/1486 built, 728 visible nodes none more than 0.5 px
    out, max size delta 0.03 px, 0 failures.
  - `Диво Мера` (18 837 nodes) — 18 719/18 719 built, 5623 visible nodes none more than 0.5 px
    out, max size delta 0.05 px, 0 failures, size 3780x15990 exact.
- **Next:** `Диво Бот` (17 512), `Стрелка` (6063), `Диво Сервис` (5858), then `Яга` (37 241).

## Pipeline

`migrate.mjs` runs, in order: `px-export` -> `px-svg` -> `px-bounds` / `px-abs` / `px-textink` ->
`px-textruns` -> `px-images` -> `pack4` -> build (plugin) -> optional second pass for undisclosed
text overrides -> verify (plugin). It exits non-zero unless the acceptance table is clean, and
leaves everything in `out/run/`, with `out/run/report.json` holding the build and check reports.

The plugin holds no migration logic: the builder and verifier travel inside the job as `PAY.B` and
`PAY.V`, so the algorithm lives only in `tools/builder4.js`.

The older agent-driven path still works — `pack4` writes a PNG carrier next to the JSON and
`tools/bootstrap.mjs` emits the reader for it — for any Figma MCP that can execute plugin-API JS.

## What is settled

- **Vector geometry travels as SVG** (`exportAsync` -> `createNodeFromSvg`), sized to the node's
  **geometry** box with the ink offset inside it.
- **Placement travels as `relativeTransform`**, from `absoluteTransform` on both sides. Never
  x/y/rotation.
- **The build verifies itself**, and any repair pass must use the same measure as the acceptance
  test or it becomes a defect generator (proved: measuring local x/y broke 33 sizes).
- **Screenshots are not an acceptance test — and neither is the verifier alone.** It measures
  geometry. Per-side strokes and per-range text fills were both lost while it stayed green; only a
  1:1 pixel comparison found them.
- Pixso keys do NOT resolve in Figma. Library relinking is manual, by owner's decision.
- Image hashes are the SHA-1 of the bytes on both sides, so the same bytes land on the same hash.

## Pixso answers wrongly, not just incompletely

Three cases found so far where Pixso returns a confident answer that is not what the node means:

1. `strokeWeight` is a single number even when the four side weights differ (218 visible nodes on
   `Диво Мера`). Not reported as `mixed`.
2. `getStyledTextSegments` returns an **empty array** for every node and every field set. Mixed
   text styling is invisible through it; `getRangeFills` works and is what `px-textruns.mjs` uses.
3. Some instance text overrides are never disclosed — `characters`, `componentProperties`,
   `overrides`, DSL, `design_to_code` and the SVG export all return the component default while the
   renderer draws the real string. Detected by comparing Pixso's inked width against the width
   Figma measures, then rebuilt from the render as vector. 1 node on `Диво Мера`.

## Direction (set by owner)

Transfer 1:1 first. Do NOT auto-relink to the Figma libraries — done by hand afterwards. Missing
fonts are acceptable; content must not be lost. **No hand-patching of layouts: everything must be a
rule in code that runs without a model.**

## Open

- One visual difference is diagnosed but unresolved: text Figma draws where Pixso draws nothing
  (`Заголовок` placeholders). The `absoluteRenderBounds === null` hypothesis was tested and does
  not explain it — 0 of those nodes are effectively visible.
- Colour-picker gradients interpolate slightly differently between the two renderers (~24 px on a
  24 px block). No data behind it.
- Fonts missing in the Figma account: `Rostelecom Basis`, `PP Neue Machina`, `Manrope`, `Hack`.
  Owner-side.

## Checkpoint

- **Updated:** 2026-09-04
- **Verified by:** in-sandbox verifier against the rebuild, plus 1:1 pixel comparison of three
  screens and the `Interface style` block with `tools/diffmap.mjs`.
- **Resume from:** `docs/FINDINGS.md`, fix rounds 6 and 7.
