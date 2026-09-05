# How the migration works

This is the method, not the diary. `FINDINGS.md` is the diary — every defect with the evidence
that found it. Read this first.

## 1. The channel

Pixso's plugin API is a member-for-member clone of Figma's: same globals, same node types, same
style and variable APIs. So the migration is not a file conversion. It is **read through one
plugin API, write through the other**, with a pure-data payload in between. No `.fig` binary, no
importer, no format reverse-engineering.

Read side: Pixso desktop, `eval_script` over its MCP.
Write side: any channel that can execute Figma plugin-API JavaScript.

Everything below is about what has to be in that payload, and how we know it arrived.

## 2. What travels, and in what shape

The payload is a flat depth-first array. Each entry is `{p: parentIndex, d: properties}`. Flat,
not nested, because the builder creates nodes in the same order and the verifier walks the built
tree in the same order — index `i` means the same node in the source, in the payload, and in the
result. That correspondence is what makes the acceptance test possible at all.

Repeated values (paint arrays, effects, fonts, constraints) are interned into a dictionary and
referenced by index. Property names are single characters. Defaults are dropped. This is not
premature optimisation: the payload has to cross a channel, and 18 719 nodes come to 4 MB.

Five things need a specific decision, and each one was arrived at by a defect.

### Vector geometry travels as SVG

`node.exportAsync({format: "SVG"})` in Pixso, `figma.createNodeFromSvg()` in Figma. Not vertices.

Transferring `vectorPaths` or `vectorNetwork` fails on: boolean operation semantics, per-vertex
corner radii that `vectorPaths` cannot express, Pixso's `handleMirroring: "RIGHT_ANGLE"` which
Figma rejects, boolean children using a different coordinate origin, and rotated containers. The
renderer resolves all of it, and the SVG is the renderer's own answer.

The wrapper frame is sized to the node's **geometry** box, not its inked box, with the ink offset
inside it. A 1 px hairline is a zero-height line with a 1 px stroke: sizing the wrapper to the ink
adds a pixel of layout height per item, and a vertical stack accumulates it.

### Placement travels as a matrix

`relativeTransform = inverse(parentAbsolute) × nodeAbsolute`, both read as `absoluteTransform`.

Never `x`/`y`/`rotation`. Groups are coordinate-transparent in both tools but become
coordinate-establishing frames on rebuild; boolean children use a different origin; a rotated node
reports its transform origin rather than its top-left. One matrix is right in all four cases.

### Text travels as content plus per-range style

`characters` plus the node's own text properties, and — where the fills differ along the string —
explicit ranges recovered with `getRangeFills`, applied on the other side with `setRangeFills`.

### Images travel as bytes

The image hash is the SHA-1 of the image bytes on both sides. Upload the same bytes and the hash
the payload already carries resolves untouched. Where Pixso holds no local bytes (remote library),
the smallest node carrying the fill is rendered and the hash remapped.

### Fonts are loaded, and substitution is recorded

A font that will not load falls back, and the substitution is reported by name. Missing fonts are
acceptable by the owner's decision — content must not be lost — but a substituted font draws to a
different width, which the text-override detector must not read as a lost override.

## 3. What deliberately does not travel

**Library links.** Pixso component keys do not resolve in Figma. Matching would have to go through
names and variant property strings, and guessing wrong silently rebinds a layer to the wrong
component. By the owner's decision: transfer first, relink by hand in Figma afterwards.

## 4. The acceptance test is two independent measures

Neither is sufficient. Both were proved insufficient alone, on this project.

**Measure one — the in-sandbox verifier.** It composes the expected absolute transform of every
node from the stored matrices and compares the resulting min-corner against `absoluteBoundingBox`
in Figma, splitting the result by *effective* visibility. Its first run reported 855 of 1486 nodes
more than 1 px out, worst 1230 px — on a page that looked correct.

**Measure two — 1:1 pixel comparison.** Render each screen from both tools at native size and
compare block by block. Per-side stroke weights and per-range text fills were both lost while the
verifier stayed green, because the verifier measures geometry and both defects were paint.

Interpreting measure two needs care: a block-difference count treats a block as hit on one pixel
over threshold, and those cluster in text. The number that matters is the magnitude distribution.
On `Диво Метрика / Каталог`: 68% of pixels identical, 30% differing by 1–15 levels out of 255,
0.17% by more than 47, 0.01% by more than 191. Mean difference over differing pixels: 3.3 levels.
What is left is glyph hinting, not content.

## 5. The rule that governs repair passes

The build repairs itself in places — degenerate hug/stretch chains, layout differences between the
engines. Three rules, each learned the hard way:

1. **A repair pass must measure with exactly the same rule as the acceptance test.** Written
   against local `x`/`y` instead, the flow pass fired on 92 pilot nodes that were not misplaced,
   including hidden subtrees whose Pixso coordinates are stale by design, and blew 33 sizes up to
   twice their width.
2. **Never act on a batch reading.** Re-read the node immediately before changing it. The same
   payload produced 23 flow fixes through one channel and 520 through another, because the passes
   were reading a layout that had not settled; the 497 spurious fixes pinned their parents to the
   wrong width.
3. **Undo a change that did not help.** After acting, measure again; if the delta did not improve,
   put it back. Counted and reported, so the next run either confirms the diagnosis with numbers or
   contradicts it.

## 6. Pixso answers wrongly, not just incompletely

This is the part that generalises least and matters most. Three cases so far where Pixso returns a
confident answer that is not what the node means — no error, no `mixed`, no null:

1. **`strokeWeight` is a single number even when the four side weights differ.** A frame with only
   a bottom border reports `strokeWeight: 1`, and Figma draws a full box. 218 visible nodes on one
   section. Fixed by carrying `strokeTopWeight` / `Right` / `Bottom` / `Left` and setting them
   after `strokeWeight`, which resets them.
2. **`getStyledTextSegments` returns an empty array.** For every node, every field set. Mixed text
   styling is invisible through it, and `fills` comes back as `mixed` with nothing to reconstruct
   from. `getRangeFills(i, i+1)` does work; runs are rebuilt character by character and coalesced.
   90 nodes on one section, every one of them a `#` prefix in a different colour.
3. **Some instance text overrides are never disclosed.** `characters`, `componentProperties`,
   `overrides`, `get_node_dsl` (even with `isDetachInstance`), `design_to_code` and the SVG export
   all return the component default while the renderer draws the real string. Detected by comparing
   the width Pixso inked against the width Figma measures for the disclosed string — ink bounds
   exclude side bearings, so a faithful string always measures *wider* here, and the inequality
   inverts only when Pixso drew something longer. Those nodes are rebuilt from the Pixso render as
   vector: exact pixels, not editable text.

The lesson for the next surface: **do not trust a single API answer about anything that has a
visual consequence.** Cross-check it against something the renderer produced.

## 7. What is left, and what it is

- **Text rasterisation.** The two engines hint Cyrillic differently at small sizes. Content and
  position match; the pixels do not. Not fixable and not a defect.
- **Gradient interpolation** differs slightly in the colour picker. Same category.
- **Hidden nodes sit at different coordinates.** Pixso's own stored coordinates for them are
  stale, and Pixso keeps hidden children in the auto-layout flow while Figma drops them. Visible
  layout is corrected; the hidden nodes are left where the source says.
- **One unexplained difference:** placeholder text Figma draws where Pixso draws nothing. The
  `absoluteRenderBounds === null` hypothesis was tested and does not explain it. Open.
