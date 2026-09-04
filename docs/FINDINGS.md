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

545 hidden nodes sit at different coordinates. That is not a defect: hidden children are excluded
from auto-layout flow in both tools, and Pixso's own stored coordinates for them are stale — in
`side menu / content / tabs` the three visible children are at 0/36/72 with the parent hugging to
108, while the four hidden ones claim 72/108/144/144.

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
