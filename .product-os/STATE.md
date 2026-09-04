# State

## Now

- **Task:** Pixso -> Figma migration. Pilot section `Яга Статьи` (1855 source nodes).
- **Status:** pilot section transfers with **measured** parity, not eyeballed:
  1486/1486 nodes built, 326 subtrees carried as SVG (324 vector + 2 rendered text), 0 property failures,
  0 relativeTransform failures, size 1640x2157 exact.
  **728 visible nodes, 0 of them more than 0.5 px out of position; max size delta 0.07 px.**
  Current rebuild root in Figma: `73:8`. Payload carrier image:
  `1d99a57bf19679bd582b0249173b1a010b29fbaa` (node `73:7` — do not delete it, the image is
  garbage-collected with its last carrier frame).
- **Next step:** run a second section end to end (`Диво Мера` 1951 own nodes, or `Яга` 2746) to
  confirm the pipeline generalises, then the whole file (6 sections, 87 403 nodes).

## Pipeline (tools/, run in this order)

1. `px-export.mjs <rootId> <ir.json>` — chunked node tree, styles, component defs.
2. `px-svg.mjs <ir.json> <rootId> <svg.json>` — outermost VECTOR/BOOLEAN/STAR/POLYGON/LINE
   subtrees via `exportAsync({format:"SVG"})`, deduplicated by content hash.
3. `px-bounds.mjs` — `absoluteRenderBounds` for those, `px-abs.mjs` — `absoluteTransform` for all.
4. `pack4.mjs` — one PNG carrier holding the tree, the SVG assets, the builder (`PAY.B`) and the
   verifier (`PAY.V`). Written with stored deflate blocks so unpacking in-sandbox is trivial.
5. Upload the PNG with `upload_assets` + `curl`, then run the ~1.2 KB bootstrap in `use_figma`:
   it decodes the carrier and runs `PAY.B` then `PAY.V` through the AsyncFunction constructor.

## What is settled

- No Figma plugin needed. `use_figma` runs Plugin API JS directly; it mirrors Pixso `eval_script`.
- **Vector geometry travels as SVG.** Pixso `exportAsync({format:"SVG"})` + Figma
  `createNodeFromSvg`. This is the single most important decision in the pipeline — see
  `docs/FINDINGS.md`, fix round 4.
- **Placement travels as `relativeTransform`**, derived from `absoluteTransform` on both sides.
  Never x/y/rotation: groups, booleans and rotated nodes all use different origins.
- Pixso keys do NOT resolve in Figma. Library relinking is manual, by owner's decision.
- Image hashes are content-addressed and transfer verbatim once the bytes are uploaded.

## Direction (set by owner 2026-09-03)

Transfer 1:1 first. Do NOT auto-relink to the Figma libraries — that is done by hand in Figma
afterwards. Same for fonts: missing fonts are acceptable, content must not be lost.

## Open questions

- **Pixso API blind spot (handled, not solved):** for some instance text overrides no Pixso API
  discloses the applied string — plugin API, DSL, design_to_code and SVG export all return the
  component default while the renderer draws the real text. Detected automatically by comparing
  Pixso inked width with the width Figma measures for the same string; flagged nodes are rebuilt
  from the Pixso render as vector. Pilot: 2 of 178 text nodes. Those two layers are not editable
  text. Owner may prefer to retype them instead — the build reports every flagged node by name.
- **Fonts missing in Figma:** `Rostelecom Basis`, `PP Neue Machina`, `Hack`. One substitution in
  this section. Owner-side fix.

## Checkpoint

- **Updated:** 2026-09-04
- **Verified by:** in-sandbox verifier `PAY.V` against rebuild `66:8`; pixel diff of the two full
  renders (`out/section-pixso.png` vs `out/section-figma-v9.png`) with `tools/diffmap.mjs`.
  Remaining strong pixel differences are text rasterisation plus the 3 override-text nodes above.
- **Resume from:** `docs/FINDINGS.md`. Pixso MCP `http://127.0.0.1:3667/mcp` needs the desktop app
  open on the target file.
