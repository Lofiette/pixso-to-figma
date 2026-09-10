# Pixso -> Figma migration: verified findings

Source file: `[Дизайн-сток] Каталог концептов на Сове` (`GH37oTm3Jid4I3CI1baDDw`), Pixso plugin API 2.0.0.
All numbers below were measured, not estimated. All Pixso access was read-only.

## The file

| | |
|---|---|
| Pages | 2 (`Экраны`, `Обложка`) |
| Nodes | 87 403, max depth 23 |
| Own nodes (excluding instance internals) | 8 329 |
| Instances | 36 606 (42% of all nodes) |
| Local components | 1 |
| Local styles | 0 paint / 0 text / 0 effect / 0 grid |
| Local variables | 0 collections, 0 bindings |
| Sections on `Экраны` | Диво Бот, Яга Статьи, Диво Сервис, Диво Мера, Яга, Стрелка |
| Unique remote component keys | 315 across 87 component sets |
| Unique remote style refs | 301 |
| Fonts | Inter (Regular/Medium/Semi Bold), Rostelecom Basis (Regular/Medium/Bold), PP Neue Machina (Regular/Ultrabold), Hack Regular |

## The decisive finding

This file is a **consumer**, not a source: 313 of 315 component keys and 100% of styles are remote.
A naive migration would produce ~36 600 detached instances.

But Pixso materialises every remote definition the file actually uses on a hidden page
`Internal Only Canvas` (4 133 children), which is **not** in `pixso.root.children` yet is fully
reachable:

- `instance.mainComponent` resolves for 100% of instances and returns a **traversable** node;
- `pixso.getNodeById(mainComponent.id)` works and returns the full subtree.

So a **self-contained export of the used subset is possible without opening the library file.**

## What does NOT work

`pixso.importComponentByKeyAsync(key)` fails for **93 of 171** keys in the pilot section with
`The component with key:"..." could not be found.` — the library is not published to this file.
It must not be used as the resolution path. Resolve through `mainComponent` + `getNodeById`.

## eval_script quirks (cost hours; write them down)

1. **Top-level `await` must be the first top-level statement.** Any top-level statement before it
   yields `SyntaxError: expecting ';'`. Nested `await` inside a loop or function is unaffected.
2. **Hard timeout around 15 s per call.** A full 87k-node walk with property reads exceeds it.
   Chunk the work and split a batch in half on failure.
3. `Object.keys(node)` returns only `id` — every other property is a prototype getter, so generic
   serialisation is impossible. The exporter carries an explicit property schema.
4. `fontName` carries a Pixso-only `hash` field that must be stripped for Figma.
5. Errors are thrown as **strings**, not `Error` objects — `e.message` is `undefined`.

## Pilot export: section `Яга Статьи` (`6:307143`)

`node tools/px-export.mjs 6:307143 out/ir.json`

| | |
|---|---|
| Tree nodes | 1 855 |
| Component definitions | **171 / 171 resolved** (3 065 nodes inside) |
| Styles | **112 / 112 resolved** |
| Orphan instances | **0** |
| Warnings | 0 |
| IR size | 10.8 MB |

Captured: 1 458 auto-layout frames, 1 319 vector path sets, 4 515 constraint sets, 4 450 corner
radii, 460 text nodes with font/size/lineHeight/letterSpacing/alignment/style ref, 1 459 instances
all with `componentProperties`, 1 009 with overrides, 733 stroked nodes, 8 effect nodes.
Styles resolve to real values (`font/body/m-strong` -> Inter Medium 16, `light/bg/surface1` -> paint).
Image bytes extract via `getImageByHash(h).getBytesAsync()` — verified on 3 images (284 B / 54 kB / 20 kB).

## Still open

- **No write channel into Figma.** Figma's local MCP is not running (3845/3846/8080 all refused).
  Figma's REST API cannot create layers. The only write path is a **Figma plugin**.
- **Fonts**: `Rostelecom Basis` and `PP Neue Machina` are not stock Figma fonts and must be
  installed on the machine running the importer, or mapped.
- **The library file itself.** The used subset is recoverable from consumer files, but a real
  Figma library (with unused variants, descriptions, publishing metadata) needs the source file.
- **Scale**: one of six sections produced a 10.8 MB IR. The whole file will be ~100-200 MB,
  which is fine on disk but needs streaming into the Figma plugin.

---

# Import side (Figma)

## Write channel

`use_figma` executes Plugin API JavaScript against a fileKey. No Figma plugin, no manifest, no
localhost relay. It mirrors Pixso `eval_script` exactly. Limits: 50 000 chars per call,
`loadAllPagesAsync` / `createImageAsync` / `setPluginData` unsupported, page switch only via
`await figma.setCurrentPageAsync(page)`.

## Two things the Plugin API cannot reproduce

`.fig` import puts a file into a "missing library" / "missing font" state and keeps the content.
Construction through the Plugin API cannot:

1. **Create an instance pointing at a component key that does not resolve.** So instances are
   rebuilt against local components created from the IR; relinking to the real library is a
   manual step in Figma afterwards.
2. **Create text in a font that is not installed.** `loadFontAsync` throws, and `characters`
   cannot be set without a loaded font. Missing fonts are substituted with Inter and every
   substitution is recorded in `fontSubstitutions` with the node id and the wanted family.

Fonts absent from this Figma account: `Rostelecom Basis`, `PP Neue Machina`, `Hack`
(1938 families available; Inter complete including `Semi Bold`). Installing those three makes the
transfer exact and empties the substitution ledger.

## Pilot rebuild — node `2:390318` ("фрейм 1", 760x64, 13 nodes)

| | v1 | v2 (fixed) |
|---|---|---|
| Nodes created | 13 / 13 | 13 / 13 |
| Property failures | 0 | 0 |
| Root size | 760x64 (exact) | 760x64 (exact) |
| Root fills | **white (wrong)** | empty (correct) |
| Heading `textAutoResize` | **NONE (lost)** | HEIGHT (correct) |
| Font substitutions | 0 | 0 |

Rendered output is visually identical to the Pixso source, down to the same line break
("страхование / жизни?"). Screenshots: `out/source-pixso.png`, `out/rebuilt-figma.png`.

## Two real bugs the diff harness caught

1. **Empty `fills` must be emitted explicitly.** Pruning `fills: []` as "empty" let Figma apply its
   default white frame fill. **981 of the 1855 pilot nodes have no fill**, so this silently
   repainted over half the tree. Fix: never drop empty `fills`/`strokes`/`effects`.
2. **`resize()` resets `textAutoResize`.** Set geometry first, then text properties, and apply
   `textAutoResize` last.

Also filtered: Pixso emits `strokeCap: "unable"` and mixed-value sentinels that Figma rejects.

## Known non-defect delta

An auto-layout child's `x` differs (101 in Pixso, 112 in Figma). Positions of auto-layout children
are derived by the layout engine, not stored. Recorded in the ledger as a derived value, not a loss.

---

# Transport: the PNG data channel

Inlining payloads into `use_figma` does not scale and is not even reliable:

- `use_figma` caps `code` at 50 000 chars. The 1855-node section packs to 470 KB of JSON -> 19 calls.
- Compressing to deflate+base64 got it to 2 calls, but **a 14 028-char base64 blob cannot be
  transcribed reliably** — the first attempt corrupted mid-stream and `JSON.parse` failed at
  char 85 814. The same payload decoded perfectly from disk, so the loss was in transcription.

**Solution:** `upload_assets` returns a single-use URL. Raw bytes are POSTed to it with `curl`
straight from disk, so the payload never passes through the agent's context at all.

The payload is carried as a greyscale PNG: JSON bytes become the scanlines, and PNG's own zlib
does the compressing. Inside `use_figma`, `figma.getImageByHash(h).getBytesAsync()` returns the
file byte-for-byte (verified: 328-byte probe returned 328 bytes, IHDR intact). A ~3 KB
raw-DEFLATE inflate (puff-style canonical Huffman, tested against six round-trip cases) unpacks
it in-sandbox.

| | |
|---|---|
| Section JSON | 345 944 bytes |
| PNG carrier | 34 645 bytes (10.0x) |
| Decode in Figma | 338 ms |
| Script size | constant, ~7 KB, independent of payload |
| Calls needed | **1** |

The sandbox has no network at all (`fetch`, `XMLHttpRequest`, `WebSocket` all undefined), but it
does have `figma.base64Decode`, `atob` and `Uint8Array`. No `TextDecoder`, so UTF-8 is decoded by
hand.

# Full section rebuild — `6:307143` "Яга Статьи"

| | Pixso | Figma | |
|---|---|---|---|
| Nodes | 1855 | **1855** | exact |
| Section size | 1640x2157 | **1640x2157** | exact |
| TEXT nodes | 178 | **178** | exact |
| Distinct strings | 57 | **57** | exact |
| Total characters | 5633 | **5633** | exact |
| Build time | — | 10.3 s | |

## Remaining deltas — all four are fixable

1. **143 boolean operations flattened to frames.** Figma has no `figma.createBooleanOperation()`,
   and `createVector()` cannot hold children. They are rebuilt as transparent frames, so the
   children survive but the boolean is not applied and subtracted areas render solid — this is why
   icons look like dark blobs. Fix: build the children, then apply
   `figma.union/subtract/intersect/exclude` in a second pass.
2. **Instance text overrides are not in `characters`.** The Pixso render shows "Добавить статью" and
   "Копировать ссылку", but the Plugin API returns the component default "Item text" for those
   nodes — verified identical on both sides (3x "Item text", 0x the overridden strings). The real
   values live in the instance's `componentProperties` / `overrides`, which the IR already captures
   but the builder does not yet apply.
3. **5 image fills rejected.** Pixso's IMAGE paint carries `imageThumbnail`, `originalImageWidth`,
   `originalImageHeight`, `scalingFactor` and `filters`, which Figma's `fills` validator refuses.
   Fix: strip to Figma's ImagePaint shape and re-create the bitmap with `figma.createImage(bytes)`.
4. **1 font substitution** — `Rostelecom Basis Medium` -> `Inter Regular`, recorded in the ledger.

---

# Fix round 2 — clean run

Payload `out/section3.png` (34 586 B) -> uploaded -> rebuilt in one `use_figma` call.

| | Pixso | Figma | |
|---|---|---|---|
| Total nodes | 1855 | **1855** | exact |
| Max depth | 13 | **13** | exact |
| Section size | 1640x2157 | **1640x2157** | exact |
| TEXT | 178 | **178** | exact |
| Characters | 5633 | **5633** | exact |
| VECTOR | 517 | **517** | exact |
| BOOLEAN_OPERATION | 143 | **143** | exact, real boolean nodes |
| ELLIPSE / RECTANGLE | 46 / 43 | **46 / 43** | exact |
| FRAME + GROUP + INSTANCE | 337 + 5 + 585 = 927 | **927 FRAME** | deliberate flattening |
| Image fills | 5 | **5** | applied |
| Property failures | — | **0** | |

## What the three fixes were

1. **Boolean operations — 143/143 applied, 0 failures.** Figma has no
   `createBooleanOperation()`, so they are built as placeholder frames and collapsed in a second
   pass, deepest-first, with `figma.union / subtract / intersect / exclude` (140 UNION, 3 SUBTRACT).
   The frame's visual properties and position are copied onto the resulting boolean node. This was
   the visible defect: icons rendered as solid blobs because subtracted areas were not cut out.
2. **Image fills — `filters.hue` is the culprit.** Bisecting the paint object field by field showed
   every property is accepted except `hue`, which exists in Pixso's ImageFilters and not in Figma's:
   `Unrecognized key(s) in object: 'hue' at [0].filters`. Also stripped `originalImageWidth`,
   `originalImageHeight` and `imageThumbnail`.
   **Image hashes need no remapping** — both tools address images by SHA-1 of the bytes, so the
   Pixso `imageHash` resolves in Figma verbatim once the bytes are uploaded. Verified on 4 images
   (64x64 PNG 284 B, 200x200 PNG 54 kB, 480x320 JPG 20 kB, 3276x4096 JPG 1.75 MB) — every Figma
   hash came back identical to the Pixso one. The hash also keeps resolving after the carrier
   frame is deleted.
3. **Instance text overrides — not a defect.** Previously logged as lost. Both Pixso channels
   disagree with the Pixso *renderer*, not with us: `characters` returns "Item text" x3,
   `get_node_dsl` returns "Item text" x3, and no entry in the 46-item `overrides` array touches
   `characters`. The strings "Добавить статью" / "Копировать ссылку" appear in no Pixso API
   response at all. The transfer is faithful to the file data; the screenshot renders something the
   API does not expose.

## The only remaining delta

One font substitution: `Rostelecom Basis Medium` -> `Inter Regular`, on a single node. Installing
`Rostelecom Basis`, `PP Neue Machina` and `Hack` for the Figma account clears it. This is an
environment gap, not a pipeline defect.

---

# Fix round 3 — icons

The first "clean" run was clean by the numbers and wrong on screen. Four real defects, found by
cropping the same region from both tools and comparing at 4-8x zoom rather than eyeballing a
full-page render.

## 1. `figma.union` was the wrong semantics

Pixso renders a `BOOLEAN_OPERATION` **like a group**: children are drawn with their own paint and
the node's own `fills` are inert. Evidence: across all 143 boolean nodes the parent fill is the
same constant `SOLID 14,17,23` and it **never once** matches a child's paint (0/143), while the
children carry the real strokes. Applying a true union destroyed interior detail — the bell lost
its clapper, the info icon's dot fused into the ring, the house lost its door.

Fix: build them as unpainted frame containers and let the children paint themselves.

## 2. `vectorPaths` silently drops per-vertex corner radius — 37% of vectors affected

The bell body exports as `M 14 14 L 0 14 L 1 0 L 13 0 L 14 14 Z`, a straight trapezoid, yet Pixso
renders a domed bell. The dome is not in the path and not in the segment tangents (all zero) — it
is `cornerRadius: 9` on the two top **vertices**, which the `vectorPaths` representation cannot
express. **189 of 517 vector nodes carry per-vertex radii.**

Fix: export `vectorNetwork` (vertices with cornerRadius, segments with tangents, regions) and
apply it with `setVectorNetworkAsync`. Result: 517/517 applied, 0 failures, 0 fallbacks.

## 3. Pixso emits a `handleMirroring` value Figma rejects

`RIGHT_ANGLE` is Pixso-only; Figma accepts `NONE | ANGLE | ANGLE_AND_LENGTH`. This rejected
431 of 517 networks until it was stripped (2214 occurrences). It is an editor hint, not geometry.
The truncated error text hid this — the full message had to be captured deliberately.

## 4. Boolean-operation children use a different coordinate origin

For 41% of boolean nodes `min(child.x, child.y)` equals the boolean's own origin exactly, and
another 53 differ by exactly `(0.5, 0.5)` — half a stroke width. Placing children relative to the
container therefore double-counted the offset. Rebasing them fixed 369 nodes and restored the
bullet and chevron markers in the navigation tree.

## Result

Sidebar rail, tree markers, toolbar and header icons now match the Pixso render icon for icon:
house with door, magnifier, **bell with clapper**, clock, info with separate dot, gear, bullets,
chevrons, star, pin, kebab.

## Residual — 1 known miss

29 of 143 boolean containers carry a rotation (90, -90, -180). Rotating the substitute frame moves
its children, because Figma rotates about the untransformed top-left while Pixso reports the
post-rotation bounding origin. One visible symptom: a `Chevron right` marker in the navigation tree
does not appear.

The robust fix is not more offset arithmetic: **`relativeTransform` is available on all 1855 nodes**
(verified) and on the Figma side too. Transferring the matrix instead of `x`/`y`/`rotation` removes
this whole class of error. That is the next change.

---

# Fix round 4 — SVG geometry, absolute transforms, measured acceptance

The trigger was a second report that the icons were still wrong, plus a colleague's independent
implementation at `github.com/divulture/Pixso2Figma`. Reading that repository produced one decisive
fact, and re-checking with a *measured* acceptance test instead of screenshots produced five more.

## The fact worth taking: Pixso can export SVG

`node.exportAsync({ format: "SVG" })` works in Pixso through `eval_script` and returns SVG bytes.
Figma's `figma.createNodeFromSvg()` accepts that markup verbatim, including Pixso's own
`customFrame` attribute, and produces a FRAME wrapping real editable VECTOR nodes with correct
vector networks. Pixso rejects Figma's `SVG_STRING` format with a ZodError; only `"SVG"` is valid.

This removes, at a stroke, every defect from fix round 3:

| Round-3 problem | Why SVG removes it |
|---|---|
| boolean operation semantics | the renderer resolves the boolean into one `evenodd` path |
| `vectorPaths` loses per-vertex `cornerRadius` (189/517) | the path is already flattened |
| `handleMirroring: "RIGHT_ANGLE"` rejected (2214) | no handles are transferred |
| boolean children use a different origin (369 rebased) | children are not transferred at all |
| 29 rotated boolean containers displaced | rotation is baked into the exported geometry |

**Measured:** 324 outermost vector subtrees (`VECTOR`, `BOOLEAN_OPERATION`, `STAR`, `POLYGON`,
`LINE`) exported in 45 s, 0 failures, deduplicated to **102 unique SVGs / 122 KB**. They subsume
369 child nodes, so the rebuilt tree is 1486 nodes instead of 1855.

Rotation is baked: `Vector 781` is 25x0 with `rotation: 90`, and its exported viewBox is `0 0 9 25`
— the *render* bounds of the rotated, stroked line. So an SVG node is placed at its
`absoluteRenderBounds` with no rotation of its own.

## Placement: transfer the matrix, not x/y/rotation

`absoluteTransform` is available on every Pixso node. Storing `inverse(parentAbsolute) x
nodeAbsolute` and assigning it to `relativeTransform` fixes three separate coordinate bugs at once:
rotated nodes, boolean children, and **GROUPs** — which are coordinate-transparent in both tools but
become coordinate-establishing FRAMEs on rebuild.

## A payload that carries its own code

The builder and the verifier now travel inside the PNG carrier as `PAY.B` and `PAY.V` and are run
with the AsyncFunction constructor (`eval`, `new Function` and AsyncFunction all work in the Figma
sandbox — verified). The carrier is written with `deflateSync(level: 0)`, so unpacking it in-sandbox
is a stored-block walk of about ten lines instead of a hand-written 2.4 KB inflate. The PNG grows
from 57 KB to 397 KB, which costs nothing because it is POSTed straight from disk with `curl`.
What has to be typed by hand each run is now a fixed ~1.2 KB bootstrap.

## The acceptance test that found everything else

Screenshots are not an acceptance test. The verifier composes the expected absolute transform of
every node from the stored matrices, compares it with `absoluteBoundingBox` in Figma, and splits the
result by *effective* visibility. The first run said: **855 of 1486 nodes more than 1 px out, worst
1230 px** — while the page still looked correct. Five defects, each found by data:

1. **`layoutPositioning: "ABSOLUTE"` was ignored.** Children of auto-layout parents were never given
   a transform, so `side menu / bottom` — an absolutely positioned child — was laid out in the flow
   and dragged its whole subtree 273 px up the rail.
2. **`absoluteRenderBounds` is null on 198 of 324 vector nodes** (143 of them visible), and
   `absoluteBoundingBox` excludes the stroke while the exported SVG is sized to the render bounds.
   Recovered by reading the SVG's own viewBox and outsetting symmetrically around the geometry box.
3. **Figma ignores rotation on auto-layout flow children; Pixso does not.** 20 `Divider` rectangles
   are 24x1 rotated 90 degrees. The quarter turn is now baked into the size (1x24) and the stored
   matrix flattened to the visual top-left, so size and transform keep describing the same box.
4. **Degenerate hug/stretch chains resolve differently.** In the `Popover` subtree every child is
   `layoutAlign: STRETCH` inside a hugging parent, so Figma had nothing to hug and settled 33 px
   narrower. Repaired by pinning the axis and resizing to the source, interleaved with the
   placement pass (`repair, place, repair, place`) because resizing a parent moves constrained
   children.
5. **Pixso GROUPs do not clip and report no `clipsContent`; `createFrame()` and
   `createNodeFromSvg()` both default to clipping.** Every group-turned-frame was cutting off strokes
   and shadows that render outside its box. Visible symptom: the two-bar `Article` icon rendered its
   9 px strokes at half weight. One line — `if (d.m === undefined) clipsContent = false` — fixed it.
   Verified pixel row by pixel row: both renders now ink rows 542-550 in `rgb(68,83,113)`.

## Result

```
nodes            1486 / 1486        svg nodes 324, 0 failures
size             1640 x 2157        exact
visible nodes    728
position         0 of 728 more than 0.5 px out      max delta 0.00
size             max delta 0.07 px over all 1486 nodes
transforms       0 relativeTransform failures
fonts            1 substitution (Rostelecom Basis Medium -> Inter Regular)
```

545 hidden nodes sit at different coordinates. That is not a defect: Pixso's own stored coordinates
for hidden children are stale — in `side menu / content / tabs` the three visible children are at
0/36/72 with the parent hugging to 108, while the four hidden ones claim 72/108/144/144.

> **Correction.** An earlier version of this paragraph also said hidden children are excluded from
> auto-layout flow *in both tools*. That is wrong. Pixso keeps them in the flow; Figma does not.
> The second section proved it — see "Fix round 6".

## The one content gap left, and it is Pixso's

Pixso's Plugin API returns the component's **default** string for some instance text overrides. In
the pilot's `DropdownMenu` the canvas shows "Добавить статью" / "Копировать ссылку" while every API
surface — `characters`, `componentProperties["item text#1230:67"].value`, the 12-entry `overrides`
array, `componentPropertyReferences` — reports `"Item text"`. The box is right (119 px wide, which
is the width of the *rendered* string, not of "Item text"); only the glyphs are wrong.

`exportAsync({format:"SVG"})` on a TEXT node converts glyphs to paths, so the string cannot be
recovered that way either — but it does confirm the renderer draws something else: the viewBox is
119x20, not the 59x20 that "Item text" measures.

102 of 178 text nodes are property-driven and almost all of them report the correct string. The
failure is confined to that one instance subtree — 3 nodes in this section. Options: leave the
placeholder string (editable, wrong text), or import those nodes as SVG (exact pixels, not
editable text).

## What was NOT taken from the colleague's repository

Its architecture is two hand-installed dev plugins with a JSON file passed between them by the
user. This pipeline needs no plugin install and no manual file handoff, and it can verify itself
against the source. Its icon handling exports icons *by reference* with an optional SVG snapshot;
here SVG is the primary representation for all vector geometry. Its `MAX_SVG_JOBS = 500` cap would
truncate a full-file run. The parts worth having were the SVG-export discovery, the `SVG` vs
`SVG_STRING` format note, and the confirmation that per-call timeouts are needed around
`exportAsync`.

---

# Fix round 5 — the dropdown, and how far Pixso's API blind spot goes

Owner reported the dropdown on the first artboard still did not match. Measured first: the panel,
the rounded highlight, the corner radii, the two drop shadows and every icon land on **identical
pixel columns** (panel 381-569, highlight 384-490, shadow falloff within 1-2 levels of 255). The
whole mismatch was two strings.

## The blind spot is real, and it is total

The Pixso renderer draws "Добавить статью" / "Копировать ссылку". Confirmed with a fresh
`get_export_image` PNG straight from the desktop app — not a stale reference render.

Every programmatic surface disagrees. All five checked:

| Surface | Returns |
|---|---|
| Plugin API `characters` on the resolved instance child | `"Item text"` |
| `componentProperties["item text#1230:67"].value` | `"Item text"` |
| `overrides` / `overriddenFields` (12 entries) | never mentions `characters` |
| exhaustive sweep of every readable property on every node of the subtree | 0 hits for "Добавить" |
| `findAllWithCriteria({types:["TEXT"]})` over all **12 345** text nodes on the page | 0 hits |
| `get_node_dsl` with `isDetachInstance: true` | `"Item text"` |
| `design_to_code` (html) | `"Item text"` |
| `get_export_image` SVG | glyphs flattened to paths, no `<text>` |

So the string exists in the document — the renderer draws it — and no API discloses it. That is a
Pixso defect, and nothing in the pipeline can read around it.

## Detecting it without guessing

`absoluteRenderBounds` on a TEXT node is the **inked** extent of the glyphs actually drawn. Ink
bounds exclude side bearings, so for a faithful string the same text always measures a little
*wider* in Figma than Pixso inked it. The inequality only inverts when Pixso drew something longer
than the string it handed us.

The packer now carries that inked width per single-line TEXT node (`d["8"]`), and the builder
measures the same string on a **clone** — after the font, size and letter spacing are applied,
which matters: measuring before `fontSize` is set reports every node at the default 12 px and
produces 50 false positives out of 74.

Result on the pilot: **2 nodes of 178**, both in `DropdownMenu`. Third item genuinely is "Item text"
(inked 57, drew 51) and is correctly left alone.

## The remedy, and its cost

For a flagged node the renderer is the only faithful source, so `px-textsvg.mjs` exports that node
through `exportAsync({format:"SVG"})` and it is rebuilt as vector. The exported viewBox equals the
node's own box (119x20, 135x20), so it drops straight onto the node's transform with no offset
arithmetic.

**Cost, stated plainly: those two layers are vector outlines, not editable text.** Everything else
about them is preserved — name, position, size, layer order. This is a deliberate trade: the owner
asked for content not to be lost, and a layer reading "Item text" loses content, while a vector
layer loses only editability. It applies to 2 of 178 text nodes here (~1 %), and the build reports
every flagged node by name, so they are trivial to retype by hand if editability is preferred.

## Result

```
nodes            1486 / 1486     svg 326 (324 vector + 2 rendered text)
size             1640 x 2157     exact
visible nodes    728             0 more than 0.5 px out of position
size delta       max 0.07 px over all 1486
failures         0 property, 0 relativeTransform
textOverrideLost []              no undisclosed override left unhandled
fonts            1 substitution (Rostelecom Basis Medium -> Inter Regular)
```

Strongest remaining 24x24 block difference across the whole page fell from 154 px to 36 px, and
every one of those is text antialiasing — Figma's baseline sits about half a pixel lower than
Pixso's and the two rasterisers hint Cyrillic differently.

## Fix round 6 — the second section, and what only scale could show

The pilot was 1855 nodes. `Диво Мера` is 18 837 — ten times larger, nine screens plus a style
sheet, 3128 vector subtrees and 3854 text nodes. Almost everything that broke here was invisible at
pilot scale, and none of it was geometry.

### The exporter could not reach it at all

A single `ser()` over the section never returns: Pixso times the script out. Phase 1 now serializes
against a node budget, and when the budget runs out `ser()` leaves `{id, __defer:1}` stubs at the
frontier which the driver fetches in follow-up calls and splices back in place, halving the id batch
and then the budget whenever a call fails. Twelve follow-up calls covered the section.

Proof it is faithful and not merely finished: re-exporting the **pilot** with the budget forced down
to 300, so the stitching path runs many times over a tree whose correct answer is already known,
reproduces the old IR with zero differences in order, id, type, name or property sets.

`vectorNetwork` is no longer serialized. Nothing has read it since geometry started travelling as
SVG, and it was the heaviest thing in the tree.

### Three layout differences, none of them geometry

The first build came back with **101 visible nodes more than 0.5 px out, worst 70.5**. Every size
was correct, so the causes were all in how the two engines resolve auto-layout.

**Pixso keeps hidden children in the flow. Figma drops them.** `Frame 277131193` is a 233 px
SPACE_BETWEEN row holding a visible `Title` and a hidden `IconButton`. Pixso lays the hidden button
out anyway, so the title sits at x=33; Figma has one participant left and puts it at x=0. This is
the opposite of what was written here after the pilot, where no visible node ever shared a
SPACE_BETWEEN parent with a hidden one.

**An SVG wrapper sized to the ink adds a pixel per item.** The dividers in `Frame 22` are
zero-height LINEs with a 1 px stroke: geometry box 260x0, render box 260x1 starting half a pixel
higher. Sizing the wrapper to the render box gives every item one pixel of layout height that the
source did not have, and a vertical stack accumulates it — stored tops -0.5/23.5/47.5/71.5/95.5
against built 0/25/50/75/100. Wrappers now take the **geometry** box, with the ink offset inside
them, and the imported children pinned to MIN/MIN before the resize so it cannot scale them.

**`layoutAlign: STRETCH` against an axis that cannot stretch.** In a 36 px row hugging its content,
a 32 px child that says STRETCH is centred by Pixso (y=2) and pinned to `counterAxisAlignItems` by
Figma (y=0), even though Pixso itself reports that property as MIN.

The remedy is a flow pass that tries counter-axis alignment first and only takes a child out of the
flow when nothing else reproduces the source position, freezing the parent's size around the change
so losing a flow child cannot resize it. On this section: 23 nodes taken out of flow, 0 aligned.

**The measure is the whole trick.** Written against local `x`/`y`, that pass fired on 92 pilot nodes
that were not misplaced at all — including hidden subtrees, whose Pixso coordinates are stale by
design — and blew 33 sizes up to twice their width. Rewritten to measure exactly what the acceptance
test measures — composed absolute min-corner against `absoluteBoundingBox`, effective visibility
propagated from ancestors — it fires on zero. A repair pass must share the acceptance test's
definition of wrong, or it becomes a defect generator.

### A substituted font is not a lost override

The override detector compares what Pixso inked with what Figma draws. A missing font draws
narrower in its fallback, which looks exactly like a string Pixso would not disclose. Five of six
flags on this section were `PP Neue Machina Ultrabold`; the sixth was `Inter Regular`, a font that is
present, and it was real — the canvas reads "11. Выборка для опроса КВС" and the API discloses
"Выборка для опроса КВС". Substituted fonts are now tracked and reported separately.

### Images: hashes are SHA-1, and some bytes are not local

The image hash is literally the SHA-1 of the image bytes — checked on every extracted file — so the
same bytes uploaded to Figma land on the same hash and the `imageHash` already in the payload
resolves untouched. Two things get in the way at scale: a large image comes back empty in one MCP
response and has to be fetched in byte ranges, and `getImageByHash` returns **null** for images that
belong to a remote library, because Pixso never held those bytes locally. Every avatar in this
section is one of those. For them the renderer is the only source: the smallest node carrying the
fill is exported as PNG, uploaded, and remapped onto the original hash by the packer.

Neither the extraction nor the upload existed as a tool before this run — the pilot's images were
moved by hand, and the documented pipeline had no step for them at all, which is exactly why the
first build of this section came back with empty circles where the avatars should be.

## Fix round 7 — two silent losses, both found by looking at pixels

The verifier was green on this section and both defects were still there. Neither is geometry, so
nothing the verifier measures could have caught them; both were found by comparing renders at 1:1.

### Per-side stroke weights

A frame with only a bottom border came out with a border on all four sides. Pixso reports
`strokeWeight` as **1** on that frame while `strokeLeftWeight` is 0 — and, unlike Figma, it does
**not** report the property as `mixed`, so a single number arrives that says something the node does
not mean. Carrying `strokeWeight` alone and letting Figma default the rest draws strokes the source
never had.

Measured on `Диво Мера`: 1019 nodes carry per-side weights, **330 disagree with `strokeWeight`, 218
of them visible and actually stroked** — a live Pixso sweep and the exported IR agree on 218. The
shape is a design-system idiom, not an accident: `Header` is `[0,0,1,0]`, `SideMenu` is `[0,1,0,0]`.

The four weights are now serialized, carried only where they disagree, and applied **after**
`strokeWeight` — assigning it resets them.

### Text with two colours, and a Pixso API that is simply dead

A hex field renders its `#` grey and the value near-black. It arrived entirely black.

`fills` on that node is `mixed`, so the packer skipped it and Figma defaulted to black — the worst
possible fallback for a colour. The recovery should have been the styled segments, except:

```
getStyledTextSegments(["fills"])     -> []
getStyledTextSegments(["fontName"])  -> []
getStyledTextSegments(["fills","fontSize"]) -> []
```

**It returns an empty array for every node and every field set.** That is also why an earlier
measurement here reported "no mixed-style text in this section at all": the measurement was reading
a dead API, and the correct figure is 90 nodes with mixed fills, 72 of them visible.

`getRangeFills(i, i+1)` does work:

```
#=68,83,113   =68,83,113   F=14,17,23  1=14,17,23  F=14,17,23  ...
```

So `px-textruns.mjs` rebuilds the runs character by character in the sandbox, coalesces them there
so only the runs cross the wire, and the builder applies them with `setRangeFills` after the node
fills are set. All 90 recovered, every one of them two runs, zero failures on rebuild.

### What the two fixes did to the picture

On the `Interface style` block, strong 24 px blocks fell **60 -> 25**. What is left is a colour
picker's gradient, where the two renderers interpolate slightly differently — 24 px on a large
smooth field, and no data behind it.

### The lesson worth keeping

Both losses were silent: Pixso answered every question asked of it, and answered wrong. A single
number where four were meant, and an empty array where two segments were meant. The acceptance test
measures geometry, and geometry was perfect through both. **Only a pixel comparison at 1:1 finds
this class**, which is why it belongs in the pipeline and not in someone's judgement.

## Fix round 7 — the whole page, and three failures that looked like something else

Migrating the whole page (87 368 nodes, six sections plus a divider) turned up defects the pilot
could not: some in the transfer, and three in the machinery around it that cost far more time than
the transfer bugs did.

### A coverage audit, because "nothing is lost" has to be measured

`tools/audit.mjs` reads the packer and the builder and compares them against what the exported tree
actually holds. It found `SECTION` being rebuilt as a plain frame, `arcData` dropped so an arc came
back a full ellipse, and `layoutGrids`, `exportSettings`, `overflowDirection`, `strokeCap` and
`strokeMiterLimit` carried by nothing at all. What is still not carried is now a short list where
every entry is deliberate: rotation travels inside the matrix, vector geometry travels as SVG, and
style ids and component keys do not resolve between the two tools.

### Figma subtracts an INSIDE stroke from the content box; Pixso does not

A 256 px side menu with a 1 px right border gives its stretched child 255 px in Figma and 256 in
Pixso. That was the systematic 1–2 px narrowing across every section — 256/255, 64/62, 1270/1268,
84/82 — with the neighbouring element pushed the other way to compensate.

The repair already knew what to do, and undid itself: it clears the stretch so the resize sticks,
and the placement pass that runs next restored `layoutAlign` from the payload, handing the child
straight back to the engine. The repair now marks what it pinned and the placement pass leaves
those alone.

### The measurement that got slower the more you migrated

The two largest sections never finished — not in twenty minutes, not in twenty-seven. Adding a
phase clock to the builder ended the guessing in one run: **94 of 113 seconds are node creation,
and the entire repair-and-place machinery is 19.**

Before that clock, the undisclosed-override detector cloned each text node and appended the clone
to the *page* to measure it. The page holds every section migrated before this one, so each
measurement cost a page-wide relayout across fifty thousand nodes, and there are ~500 of them per
section. The cost therefore grew with every section already migrated, which is why the same code
finished a 17 482-node section and never finished an 18 719-node one. One reused scratch text node
replaced the clones, and Диво Мера went from "never" to 113 seconds.

### Three ways the harness lied about itself

Each of these cost more than any transfer bug, and each looked like a different problem:

1. **A server inside a process that blocks its own event loop.** Every Pixso step runs through
   `execFileSync`. The job server was started before them, so for the whole export it held the port
   and answered nothing: the plugin showed "connecting…", another build failed with EADDRINUSE, and
   a curl against the port timed out.
2. **A liveness check the observer could satisfy.** The runner counted any GET /job as a sign of
   life — and what was polling was my own curl waiting for the run to finish. It reported "plugin
   is polling" through a twenty-minute wait that ended in a timeout. The plugin now identifies
   itself and heartbeats while it builds.
3. **A poll loop that could stop.** The plugin awaited a fetch and scheduled the next poll after
   it. When the runner exited mid-request the fetch never settled — neither resolved nor rejected —
   so the next poll was never scheduled. The window stayed open, the last status stayed painted,
   and the plugin looked healthy while it had stopped listening for good. Every request now has a
   deadline and the loop reschedules itself from a catch that wraps everything.

The verifier had the same shape of fault in miniature: it kept the *first* thirty offenders rather
than the worst, so its list filled with half-pixel SVG wrappers near the top of the tree while a
223 px error further down never appeared in it.

## Fix round 8 — a second file, and three defects a geometry check cannot see

The first file was migrated until the verifier said zero nodes out of place. A second file
("Кейс Айдентика Лукоморье": 3 pages, 290 top-level objects, 25 351 nodes, heavy on photographs
and boolean geometry) said the same thing on its cover — and the cover looked wrong. Every one of
these moved no box at all, which is why the geometry check reported a clean run through all three.

1. **Rotation is dropped on an auto-layout flow child.** Figma refuses it and says nothing. A
   sideways toolbar is normally built by rotating the panel and counter-rotating its rows so they
   stand upright; the counter-rotation is exactly what disappears, so every icon arrived on its
   side — a "T" lying down, a paint bucket mirrored. Proved by reading the built file rather than
   the render: `menu_tab` had `rot 0` where the source has −90 against a parent rotated 90, while a
   sibling `Union` inside a plain frame kept its −90.

   The packer already flattened such matrices, baking the quarter turn into the size. That is
   right for a leaf — a 24x1 divider rotated 90 degrees is a 1x24 divider — and wrong for a node
   with children, which carries its whole subtree round with it. Leaves keep the bake; nodes with
   children keep the rotation and leave the flow.

2. **Figma has no Hue among its image filters.** Its `ImageFilters` are exposure, contrast,
   saturation, temperature, tint, highlights, shadows. Pixso's have Hue as well, and a cover
   tinted pink by `hue: 0.65` arrived in the photograph's original blue. The packer's whitelist
   was correct to drop the key — Figma rejects it — but dropping it silently lost the design.

   A filter that cannot travel as data travels as pixels: Pixso renders the node with its own
   engine and the render becomes the image, the same move already used for text whose override
   Pixso will not disclose. Two things this needs. The render arrives in *screen* orientation, so
   on a node rotated a quarter turn and mirrored, using it as a fill turns it a second time — the
   first attempt produced a picture of a different part of the photograph. Pixels are put back
   into the node's own frame first, which for a quarter turn is an exact permutation. And a render
   carries everything else the node draws, so it is only substituted where the image paint is all
   there is; anything else is reported, not silently flattened.

3. **The first line of text sits in different places.** Where a line height differs from the
   font's natural one the engines disagree: measured in Figma, its glyphs move by exactly half of
   any line-height change, while Pixso puts the top of the capital almost exactly at the top of
   the box. On a 140 px heading with line height set to 140 that is 23 px — plainly visible, and
   invisible to a geometry check because the text box is exactly where it belongs.

   Half the difference is applied and **stored on the node**; the verifier reads it and corrects
   its expectation by the same amount, then reports how many nodes needed it. A correction that
   hides inside a clean number is worse than the defect.

Measured against the Pixso render of the same cover, 1920x1152:

| | before | after |
|---|---|---|
| identical pixels | 76.6 % | 89.9 % |
| mean delta | 8.51 | 1.92 |
| differing by more than 191 | 3.32 % | 0.41 % |

The last row is the one that matters: a delta above 191 means ink on one side and none on the
other. Residual: the heading now sits 3 px high — "half the difference" is close but not the
exact rule. The exact fix needs no model at all: render the affected text nodes from Pixso, read
their ink box, and align to it. Only nodes whose line height is far from natural need it.

### The report was the one direction that never chunked

The payload travels to the plugin in slices. The report back did not, and a report carrying a
rendered image — 1.26 million characters — never arrived at all. The UI frame stayed latched on
`busy` and went on heartbeating, so the runner saw a healthy plugin that would never take another
job as long as it was open. Reports now travel in slices too, and a job that produces no report
releases the frame after thirty minutes.

### Rounding is not one decision

Every number in the payload was rounded to two decimals. That is right for geometry in pixels and
wrong for anything normalised to 0..1: a colour channel lands up to 1.3 levels of 255 from the
source, and the crop transform of a 4096 px image moved the crop by sixteen pixels. Colours,
transforms, gradient stops, filters and opacities keep six decimals; the payload grew by 3 %.

### What the geometry verifier cannot see, and what covers it

Three of the four defects above passed the verifier. It compares the built tree against the
payload, so it proves the build faithful to the payload and says nothing about either the payload
being faithful to the source, or the two engines drawing the same payload the same way.

- `coverage.mjs` covers the first: source tree against payload, splitting the difference into
  vector subtrees collapsed on purpose and unexplained loss. On 160 objects of this file: 13 904
  source nodes, 382 collapsed inside 3 522 vector subtrees, **unexplained loss zero**. Those 382
  are the operands of boolean shapes — geometry exact, operand structure not preserved.
- `visual.mjs` + `pxdiff.mjs` cover the second: the same object rendered by both engines, compared
  by magnitude distribution rather than block count.

### Extraction cost, measured twice

Neither guess about where the time went survived measurement.

- **Encoding, not transport.** Chunk requests re-fetched the entire image inside Pixso and encoded
  one 600 KB slice of it, so a large image cost a process start plus a full fetch per slice. And
  the base64 encoder was hand-rolled because the sandbox has no `btoa` — but Pixso clones Figma's
  API, which has `base64Encode`: 135 ms/MB against 513, byte-identical output. A 16-million
  character response was measured arriving intact, which contradicts the earlier note that one big
  response comes back empty, so an image up to 11 MB now travels whole. Seven images: 46 s to 7.9 s.
- **The same photograph, over and over.** Extraction is per top-level object and each object
  fetched its images from scratch. Of the first 520 MB pulled from this file, 236 MB were repeats
  — 160 of 337 fetches. The hash is the content, so a cache keyed by it makes a repeat a file copy.
  Mean cost per object: 47 s to 24.5 s.

What is left is Pixso's own floor: it exports one vector at a time, and a section of 933 vector
nodes costs twenty minutes no matter what the driver does.

### A node id is not a handle you can carry between two jobs

The build reports the id of the root it made; the check that follows is a separate job and looks
that id up. On a run of 45 objects, two of them reported an id that resolved to something else
entirely — and the check dutifully measured the stranger. One object of 5 722 nodes was reported as
"3 of 5722 nodes", which reads exactly like a build that collapsed, while the build report for the
same object said 5 722 nodes built and a root 10 032 x 5 807 px. Both were true.

What that "3" was: the verifier walks the built tree in payload order and stops descending wherever
the payload says a subtree was collapsed into one SVG. Handed a frame with two children, it counts
the frame, both children, and stops — three. So the number was not a measurement of the object at
all. It was a measurement of whatever now answered to that number.

Figma allocates ids sequentially, which makes this checkable without reproducing it. Laid out in
build order, every object's root id sits after the previous object's block — except those two,
whose ids point *backwards* into a block allocated to an object built much earlier. Neither the
builder nor the transport can be blamed: `built[0]` is assigned once at creation and never
reassigned, the plugin passes `rootNodeId` through untouched, and the reported root size was the
right one. The id itself stopped meaning what it meant.

The mechanism is still unknown. The fix does not depend on knowing it: the build now stamps the root
with the id of the Pixso node it came from — `setPluginData("pxSrc", ...)` — and the check, having
looked the id up, makes the node prove it is the right one. When it cannot, the check finds the node
that carries the stamp, uses that, and **says so in the report**. A check that silently corrects
itself hides the one thing worth knowing.

The same distrust had to be applied to the `--clean` step, where it mattered more: that step
*removes* nodes by remembered id. A stale id there does not spoil a measurement, it deletes
something out of the designer's file. It now removes a node found by id only if that node is
unstamped, or stamped with the source about to be rebuilt, and reports how many ids it declined to
act on.

### Half a pixel and a pixel are not the same finding

Every file measured carries a handful of nodes out of position by exactly 0.5 px, always vertically.
They were being added to the same total as real defects, so the verdict said "not clean" about 15 of
34 objects in one file and 16 of 45 in another — while the one object that was genuinely wrong, 115
nodes at 1.41 px, sat in that same total and did not stand out. A measure that fires on almost
everything reports nothing.

Counted apart now: over a pixel is a defect someone could point at, and the band below it is printed
as "within a pixel" on its own line. Nothing is rounded away or hidden; the two numbers are simply
not summed.

What it actually is, as far as measurement goes: **not the node it is reported on.** Every reported
one is a FRAME imported from an SVG, which is what made it look like an SVG problem — but such a
frame's `relativeTransform` matches the payload exactly, so it is sitting where it was told to. Its
parent is out by 0.5 as well, and `> 0.5` is false at exactly 0.5, so the parent is not counted; the
SVG child inherits the same 0.5 and adds a few thousandths of horizontal offset of its own, which
pushes it over the line. So the reported node is a threshold accident and the real subject is a whole
subtree sitting half a pixel low. In one object of 774 nodes, 21 visible nodes and 410 hidden ones
are in that band.

Which ancestor introduces it: walking the chain and printing both sides at every step put it on one
node, and the arithmetic then explains itself. The frame is a horizontal auto-layout row, 56 px tall,
with `counterAxisAlignItems: CENTER` and an **inside border on the top edge only** — top weight 1,
bottom 0. Figma takes an inside border out of the content box, so the row's content area runs from
y = 1 to y = 56, which is 55 px, and centring a 56 px child in it gives `1 + (55 - 56) / 2 = 0.5`. Its
sibling, 16 px tall, sits at `1 + (55 - 16) / 2 = 20.5`. Both measured, to the digit. Pixso does not
deduct the border, so it centres at 0.

So this is an engine difference and not a defect in the transfer, and it has no clean fix: making the
border stop consuming layout space means changing its alignment, which moves the drawn line by the
same half pixel. It is 0.5 px, it is inherited by everything below the row, and the node it gets
reported on is simply the first descendant to cross a threshold. Counted on its own line, explained,
and left alone.

Two things this ruled out along the way, both worth not re-testing: the payload is right about the
source (Pixso's own absolute positions agree with the payload's composed transform chain to three
decimals, so nothing is lost in extraction), and it is not the SCALE constraints that every reported
node happened to carry — applying constraints after the last resize instead of during the place passes
leaves the offsets identical.
