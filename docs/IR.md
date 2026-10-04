# The intermediate representation (IR), version 1

Status: **M0, format of record.** Specified from `docs/REWRITE.md` §4–§8, the plan of record (on branch
`claude/rewrite-plan` until it is merged). The validator is `tools/ir/schema.mjs`, its tests are
`tools/test-ir.mjs`, and the complete example at the end of this file is one of those tests. Every value in
this document is synthetic.

## 1. What it is

The IR sits between a source reader and the builder:

```
.pix reader ─┐
             ├─▶ IR (this document) ─▶ planner ─▶ tasks ─▶ builder in Figma
MCP reader ──┘
```

- **Data only.** No code travels in it. It is validated when it is loaded, and an unknown format or version is
  refused, not read as the nearest version this code knows.
- **One IR for both sources.** The source never reaches the plugin.
- **It speaks Figma.** Property names, units and enums are Figma's plugin-API ones. The readers translate Pixso's:
  - colours 0–255 become 0–1, percent spacing stored as a fraction becomes a percent, a miter stored as an angle
    becomes Figma's miter limit;
  - SPACE_EVENLY becomes SPACE_BETWEEN, XOR becomes EXCLUDE, image STRETCH becomes CROP, FOREGROUND_BLUR becomes
    LAYER_BLUR;
  - a missing per-corner radius is 0.
- **It says what it knows.** The header's capabilities declare what the source provides. The builder, the kit-map
  resolver and the verifier use only what is declared, and the validator refuses content that the header does not
  declare.
- **It is private.** An IR made from a real file names real components and keys, so it lives in the per-user data
  folder with the other private artefacts (REWRITE.md §8) and never in this repository.

It keeps the ideas proven by today's payload (`tools/pack4.mjs`, `docs/METHOD.md` §2): flat parent-first records, so
that index *i* means the same node in the source, the IR, the task and the built tree; a dictionary of repeated values;
matrix placement; per-side strokes and corners; the rounding rules. It drops the single-character keys, because the
IR is a documented format and not the channel. Tasks (at most 4 MB each) are cut from it by the planner.

## 2. Conventions

- **JSON, UTF-8.** The writer emits keys in the order this document lists them and tables in source order, so two
  runs on the same input give a byte-identical IR (REWRITE.md §7). A `.pix` IR holds no wall-clock time. The only time
  in any IR is `readAt` of an MCP snapshot, which is part of the snapshot's identity.
- **guid**: Pixso's node id, `"sessionID:localID"`, for example `"12:345"`. Pages, nodes and styles share one guid
  space, so a guid is unique across all three. A **guidPath** is an array of guids, outermost first, as Pixso
  addresses instance sublayers.
- **index**: a 0-based integer into one of this IR's tables.
- **Rounding** on write, as today's payload does (`r2`, `r4`, `r6` and `PRECISE` in `tools/pack4.mjs`):
  - four decimals for all six entries of a transform, the linear part and the translation alike (a node's
    `relativeTransform`, a derived box's `transform`), and for the `x` and `y` of `inkBounds`, which today's payload
    keeps as an ink offset at four decimals too;
  - six decimals inside values for normalised quantities: colour channels, opacities, image and gradient
    transforms, gradient stops and image filters;
  - two decimals for everything else, all of it pixels: sizes (derived sizes and the `inkBounds` width and height
    included), radii, stroke weights, spacing and font sizes.
- **Evidence labels** are REWRITE.md's: (C) confirmed by measurement, (I) inferred, (A) assumed until a probe or a
  real file checks it.
- **Defaults.** A property may be left out only when its value equals the builder's default for it (today the
  `DROP` table in `tools/pack4.mjs`). Paint lists always travel, empty ones included, because Figma's default paints
  differ by node type.
- **Closed records.** Every record has a fixed set of keys, and an unknown key is an error, so a misspelt key cannot
  be silently ignored. `props` and override `fields` are open sets of Figma property names in version 1.

## 3. Top level

| key | type | |
|---|---|---|
| `header` | object | §4 |
| `pages` | array | §5 |
| `values` | array | the value dictionary, §6 |
| `nodes` | array | flat, parent-first node records, §7 |
| `sets` | array | variant sets, §8 |
| `components` | array | component definitions, §8 |
| `styles` | array | §10 |
| `images` | array | §11 |
| `fonts` | array | §12 |
| `notes` | array | everything the reader counted, each with a reason code, §13 |

Every table may be empty; `header` is required.

## 4. Header

| key | value |
|---|---|
| `format` | always `"pix2fig.ir"` |
| `version` | `1` |
| `source` | the source snapshot |
| `scope` | what was read |
| `capabilities` | what the source provides |
| `settings` | the settings this run uses |

**`source`.** The snapshot is what stamps carry (`pxSnap`): a stamped root is resumed only when its snapshot equals
the current IR's. `snapshotId()` in the schema module gives the string: `pix:<sha256>` or `mcp:<fileKey>@<readAt>`.

| kind | required | optional |
|---|---|---|
| `"pix"` | `sha256`: the SHA-256 of the `.pix` file, 64 lowercase hex | `fileKey`: the file's own Pixso key when the file states it (its styles, or copies of its own components), else `null`; `documentName` |
| `"mcp"` | `fileKey`: the Pixso file key; `readAt`: ISO 8601 UTC; `changedDuringRead`: boolean, `true` when the top-level ids and boxes read at the start and at the end of the read differ (the verdict then refuses PASS) | `documentName` |

**`scope`.** `kind` is `"file"` (no `ids`), `"pages"` (the chosen pages and top-level objects of a `.pix`),
`"page"` (the page open in Pixso) or `"selection"`; the last three list the guids they cover in `ids`.

**`capabilities`.** All eight keys are required, and each is a boolean.

| key | true when the source provides | typical `.pix` | typical MCP |
|---|---|---|---|
| `authoredOverrides` | overrides as stored by Pixso (`symbolOverrides`) | true (C) | false |
| `resolvedOverrides` | overrides found by comparing an instance with its master | false | true (§4) |
| `overrideKeys` | `overrideKey` on the layers of library copies | true (C) | false unless Q4 |
| `publishIds` | `publishID` of library copies | true (C) | false unless Q4 |
| `symbolVersions` | `sharedSymbolVersion` of library copies | true (C) | false unless Q4 |
| `derivedBoxes` | Pixso's resolved geometry of instance sublayers (`derivedSymbolData`) | true (C) | to be measured (A) |
| `inkBounds` | rendered bounds of nodes | false (no renderer) | true (A) |
| `renders` | renders of nodes, for filters Figma lacks, missing images and the visual audit | false | true |

The validator enforces the first seven against the content: `overrideKey` needs `overrideKeys`, `publishID` needs
`publishIds`, `sharedSymbolVersion` needs `symbolVersions`, `derived` needs `derivedBoxes`, `inkBounds` needs
`inkBounds`, and an instance's `overrideBasis` needs the matching override capability. `renders` describes the source
for the planner and has no content of its own in the IR.

**`settings`.** Every policy in REWRITE.md §11, plus the mode; all keys are required.

| key | values | flag | owner's default |
|---|---|---|---|
| `mode` | `design`, `kit` | `--mode` | chosen per run; a detector pre-selects it |
| `overrides` | `fidelity`, `link` | `--overrides` | `fidelity` (decision 1) |
| `drift` | `link`, `local` | `--drift` | `link` (decision 2) |
| `deleted` | `publish`, `skip` | `--deleted` | `publish` (decision 3) |
| `resync` | `pixso-unless-edited`, `report-only` | `--resync` | `pixso-unless-edited` (decision 8) |
| `textFit` | `widen`, `source-box` | `--text-fit` | `widen` (decision 9) |
| `kitmaps` | `"default"` (the per-user folder) or the directory given | `--kitmaps` | `"default"` (decision 4) |

## 5. Pages

`{ guid, name, internal }`. `internal` is `true` for Pixso's internal canvas, which holds library copies and
soft-deleted masters. Top-level node records name their page by index.

## 6. Values

Repeated values are stored once in `values` and referenced by index. The interned properties, wherever they appear
(node `props`, text range `fields`, override `fields`), are:

`fills`, `strokes`, `effects`, `layoutGrids`, `exportSettings`, `dashPattern`, `constraints`, `fontName`,
`letterSpacing`, `lineHeight`, `arcData`, `vectorNetwork`, `fillGeometry`, `strokeGeometry`.

A value appears once (compared as canonical JSON, keys sorted), in order of first use. `fills`, `strokes`,
`effects`, `layoutGrids`, `exportSettings`, `dashPattern`, `fillGeometry` and `strokeGeometry` point at lists; the
others point at objects. A style's value is a `values` index too.

## 7. Nodes

One record per stored node, parent first, siblings in source order (for a `.pix`, `parentIndex.position` compared
as plain strings).

| key | |
|---|---|
| `parent` | index of the parent record, which precedes this one; `-1` for a page's top-level node |
| `page` | top-level records only: index into `pages` |
| `guid` | the source guid, unique in the IR |
| `type` | one of `FRAME GROUP SECTION COMPONENT COMPONENT_SET INSTANCE RECTANGLE ELLIPSE POLYGON STAR LINE VECTOR BOOLEAN_OPERATION TEXT SLICE SLOT` |
| `name` | the layer name |
| `props` | Figma properties, plus the IR's own below |
| `overrideKey` | the layer's guid in its library's own file (library copies only; capability `overrideKeys`) |
| `instance` | `INSTANCE` records only, §9 |

`SLOT` never comes from Pixso; it is listed because the Figma Сова kit uses it and the matcher and verifier read
Figma trees with the same list.

Rules:
- an `INSTANCE` record has **no child records**: its content is its master's, changed by its overrides;
- a `COMPONENT_SET` record holds only `COMPONENT` records;
- every `COMPONENT` record has an entry in `components`, and every `COMPONENT_SET` record one in `sets`;
- a source node of a type not listed is not carried, and neither is its subtree; the loss is a
  `NODE_TYPE_UNSUPPORTED` note.

The IR's own `props`:

| prop | |
|---|---|
| `relativeTransform` | `[a, b, tx, c, d, ty]`, relative to the parent record (groups included); composing the chain gives Pixso's absolute transform |
| `width`, `height` | the layout box |
| `strokeWeights` | `[top, right, bottom, left]`, only when the sides differ |
| `cornerRadii` | `[topLeft, topRight, bottomRight, bottomLeft]`, only when the corners differ, and then instead of `cornerRadius` |
| `textRanges` | `[{ start, end, fields }]`: ascending, non-overlapping ranges in UTF-16 units of `characters` (Figma's indexing; the reader converts Pixso's per-code-point style ids) |
| `lines` | the number of lines Pixso drew, from its stored baselines (decision 9) |
| `inkBounds` | `[x, y, width, height]` of the rendered ink, in the node's own frame (capability `inkBounds`) |
| `fillStyle`, `strokeStyle`, `textStyle`, `effectStyle`, `gridStyle` | index into `styles`, of type PAINT, PAINT, TEXT, EFFECT and GRID |
| `componentPropertyReferences` | `{ characters \| visible \| mainComponent: property id }`, bound to TEXT, BOOLEAN and INSTANCE_SWAP properties of the enclosing definition's family |

A style is referenced only when it binds: on ordinary nodes the node's own value is what Pixso draws, so the style is
bound when its value equals the node's within 1/255 per channel. Otherwise the raw value stays, there is no
reference, and a `STYLE_VALUE_DIFFERS` note says so. A reference that resolves nowhere is a
`STYLE_MISSING_IN_SOURCE` note. A vector built from its stored geometry instead of its network carries `fillGeometry`
and `strokeGeometry` and a `VECTOR_FROM_GEOMETRY` note.

## 8. Component definitions

A **family** is a variant set, or a standalone component. Its guid is the guid of the set's record or of the
component's record. Property definitions belong to the family and are keyed by **(family, id)**, because raw
definition ids repeat across owners (REWRITE.md §3).

**`sets`**: accepted variant sets only.

| key | |
|---|---|
| `node` | index of the `COMPONENT_SET` record (Pixso's state-group frame) |
| `axes` | `[{ name, values: [string] }]`, axis order normalised |
| `properties` | the family's property definitions |
| `library` | optional library identity, when the source gives one for the set |

A state group whose member names do not parse (a duplicate coordinate, a duplicate axis, a different axis count) is
not a set: its record stays a `FRAME`, its members are standalone components, and a `VARIANT_SET_REJECTED` note
names it.

**`components`**: one entry per `COMPONENT` record.

| key | |
|---|---|
| `node` | index of the `COMPONENT` record |
| `set` | index into `sets`, or `null` for a standalone component |
| `variant` | members only: `{ axis: value }` for every axis of the set, unique within it |
| `properties` | standalone components only: the family's property definitions |
| `library` | library copies only: the library identity below |
| `deleted` | `true` for a master soft-deleted in Pixso (on the internal canvas) |
| `ancestorPath` | deleted masters only: the names of the old path, from `ancestorPathBeforeDeletion` |

A member declares no properties: type, name and default always come from the root definition on the set, never from
the variant-local aliases newer Pixso writes.

**Property definition**: `{ id, name, type, default, preferredValues? }`. `type` is `BOOLEAN`, `TEXT` or
`INSTANCE_SWAP`; variants are axes, not a property type. `default` is a boolean, a string or a master reference
(§9) respectively; `preferredValues` (INSTANCE_SWAP only) is an array of master references.

**Library identity**: `{ publishFile, publishID?, componentKey?, sharedSymbolVersion? }`.
- `publishFile` is the library's Pixso file key and is required.
- `publishID` is the master's guid in that library; `componentKey` is 40 lowercase hex (A: REWRITE.md shows only
  that keys match by their 12-hex prefix, and its probe Q4 compares full keys; M1 and M2a confirm the length and
  case on a real file, and if they differ, every real IR fails validation until this rule is corrected). At least
  one of them is required. The kit map resolves `publishFile@publishID`; an MCP source resolves through
  `componentKey`.
- `sharedSymbolVersion` is opaque and is only compared for equality.
- Identity is never the name: names drift.

## 9. Instances

An `INSTANCE` record's `instance`:

| key | |
|---|---|
| `master` | the master reference |
| `properties` | `[{ family, id, value }]`: assignments to the master's family |
| `overrides` | `[{ path, fields?, swap?, properties? }]` |
| `overrideBasis` | `"authored"` or `"resolved"`; required when there are overrides, and needs the matching capability |
| `derived` | `[{ path, size: [w, h], transform: [a, b, tx, c, d, ty], fillGeometry?, strokeGeometry? }]`: Pixso's resolved geometry of each sublayer (capability `derivedBoxes`); the verifier's oracle, and the geometry and vector paths of any fallback frame (REWRITE.md §3). `fillGeometry` and `strokeGeometry` are `values` indexes of lists, as on nodes, and are written when the source stores paths for that sublayer |

**Master reference**: `{ guid?, library? }`. It resolves:
1. to a definition in this IR, when `guid` is the guid of a `COMPONENT` record; or else
2. to a library identity, when the master is not in the IR (`library` with `publishFile` and `publishID` or
   `componentKey`), which the kit map resolves later.

Anything else is a dangling reference and the IR is refused. The same rule applies to swap targets and to
INSTANCE_SWAP values and defaults. An instance may not sit inside its own master.

**Property values** are assigned to the master's family. An assignment whose definition cannot be reached from the
instance's current family is stale: the reader drops it and writes a `STALE_ASSIGNMENT` note, and never matches it by
name.

**Overrides** are the live ones only:
- `path` is a guidPath with swaps resolved, and its first guid is a layer inside the master;
- `fields` holds Figma properties, interned like node props;
- `swap` is a master reference;
- `properties` holds assignments to a nested instance.

Before writing, the reader drops two kinds of entry. An entry whose path is absent from `derivedSymbolData` is
provably stale (`OVERRIDE_STALE`). A field that only echoes the master's value is dropped too (`OVERRIDE_ECHO`). Size,
position, rotation and constraint fields stay in the IR even though Figma cannot apply them to instance sublayers
(REWRITE.md §9, P13): the planner counts them as `OVERRIDE_FIELD_UNSUPPORTED` and applies decision 1. One entry per
path.

## 10. Styles

`{ guid, type, name, styleKey, value, signature, library?, deleted? }`.
- `type` is `PAINT`, `TEXT`, `EFFECT` or `GRID`.
- `styleKey` is a string, or `null` when the source has none (a kit's own styles carry none).
- `value` is a `values` index.
- `signature` is `valueSignature(value)`: FNV-1a 64 over the canonical JSON, written `fnv1a64:<16 hex>`. It is an
  identity, not a security measure.
- `library` is `{ publishFile }` for a library style.

A style's identity is **styleKey plus signature**, never the name and never the guid alone. Two copies of one
styleKey with different values are two styles; two with the same key and value are one.

## 11. Images

`{ hash, present, format? }`.
- `hash` is the SHA-1 of the bytes, 40 lowercase hex. It is the same hash in Pixso and Figma.
- `present` says whether the bytes are in the source archive. Often they are not: then the planner's chain is MCP
  bytes by hash (SHA-1 checked), then a Pixso render, then a counted placeholder (`IMAGE_PLACEHOLDER`), never an empty
  fill.
- `format` is the sniffed format, because some `.png` entries are JPEG or WebP: `png`, `jpeg`, `webp`, `gif` or
  `unknown`.

Every IMAGE paint anywhere in `values` has an `imageHash`, and the hash is listed. An IMAGE paint without one
(Figma allows `imageHash: null`) is refused, because it would be exactly the empty fill a missing image must never
become. A source image paint that names no image at all has not been seen so far (A); if the reader meets one, its
handling is decided then and recorded here, with a version change if the format changes.

## 12. Fonts

`{ family, style }`, once each. Every `fontName` the IR uses (node props, text ranges, override fields, TEXT style
values) is listed, because every font is loaded before the first text write.

## 13. Notes and the reason-code vocabulary

`notes`: `[{ code, node?, guid?, path?, detail? }]`. `node` is a record index; `guid` names a source node with no
record (a rejected set, an unsupported node); `path` is a guidPath inside an instance; `detail` is free text.

The same vocabulary serves IR notes and run reports, and an unknown code is an error. The **stage** says where a
code arises: *run* codes are the run's own and go to its reports (`states.json`, the reader's errors): they stop the
run, or fail or skip one object of it; *read* codes come from the reader and may appear in an IR, *plan* codes come
from the preflight and the kit-map resolution, and *build* codes come from Figma. Every code the run writes today
(`tools/extract-lib.mjs`, `tools/kiwi.mjs`) is in the table, and `tools/test-ir.mjs` fails on one that is not.

| code | stage | meaning | REWRITE.md |
|---|---|---|---|
| `PIX_CORRUPT` | run | the `.pix` is truncated, uses a field id its schema does not define, or does not end on its last byte; nothing is built | §6 |
| `PIX_UNSUPPORTED` | run | the `.pix` is sound but in a form the reader does not read (another compression, a second zstd frame, a Node without zstd); nothing is built | named here (§6) |
| `IDENTITY_CHANGED` | run | after a reconnect, the file open in Pixso is not the file being read | §4 |
| `KIT_FILEKEY_CONFLICT` | run | sources disagree about a kit's own Pixso file key; no kit map is written | §5 |
| `PIXSO_UNAVAILABLE` | run | the Pixso channel's circuit breaker: the object whose call did not reach Pixso fails, and if Pixso is not back within 10 minutes the run stops and the rest are skipped; a re-run resumes | named here (§6) |
| `EXTRACT_FAILED` | run | Pixso answered and the object's extraction still failed; the whole error is in its `extract-error.log` | named here (§6) |
| `NO_ID` | run | reading the file gave the object no id, so it cannot be extracted; it is skipped and counted as a loss | named here (§6) |
| `VARIANT_SET_REJECTED` | read | the member names of a state group do not parse into one set of axes; the members become standalone components | §3 |
| `STALE_ASSIGNMENT` | read | a property assignment unreachable from the instance's current family; dropped | §3 |
| `STYLE_MISSING_IN_SOURCE` | read | a style reference that resolves nowhere; raw values kept | §3 |
| `STYLE_VALUE_DIFFERS` | read | the node's value differs from its style's by more than 1/255 per channel; raw value kept, style not bound | §3 |
| `VECTOR_FROM_GEOMETRY` | read | fill geometry but no region: built from the stored fill and stroke geometry | §3 |
| `OVERRIDE_STALE` | read | an override entry whose path is absent from `derivedSymbolData`; dropped | named here (§3) |
| `OVERRIDE_ECHO` | read | an override field equal to the master's value; dropped | named here (§3, P9b) |
| `NODE_TYPE_UNSUPPORTED` | read | a source node type the IR has no type for; it and its subtree are not carried | named here (§7, §8) |
| `KIT_MAP_MISSING` | plan | no kit map is loaded for the copy's library | §5 |
| `MASTER_NOT_IN_MAP` | plan | the kit map has no `publishFile@publishID` entry | §5 |
| `MASTER_NOT_BUILT` | plan | the master is in the map but was not built in the Figma kit | §5 |
| `MASTER_HIDDEN` | plan | the kit master is hidden in the Figma kit | §5 |
| `IMPORT_FAILED` | plan | importing the Figma key failed in preflight | §5 |
| `VERSION_DRIFT` | plan | `sharedSymbolVersion` differs from the map's; linked if every touched layer still maps (decision 2) | §5 |
| `DRIFT_UNMAPPABLE` | plan | the touched layers of a drifted or MCP-read copy do not all map to the kit master | §5 |
| `STYLE_NOT_IN_MAP` | plan | a library style with no entry in its kit map; raw values kept | §5 |
| `PROP_NOT_IN_MAP` | plan | a property assignment the kit map cannot translate (decision 1) | §5 |
| `SWAP_TARGET_UNMAPPED` | plan | a swap target that is in no loaded kit map (decision 1) | §5 |
| `OVERRIDE_PATH_UNRESOLVED` | plan | an override path that does not translate hop by hop to a kit layer (decision 1) | §5 |
| `OVERRIDE_VIA_LOCAL_MIRROR` | plan | warning: translated through an unpublished local duplicate of the library set, matched exactly once | §5 |
| `OVERRIDE_FIELD_UNSUPPORTED` | plan | a field Figma refuses or ignores on instance sublayers: size, position, rotation, constraints (decision 1) | §5, P13 |
| `OVERRIDE_APPLY_FAILED` | build | Figma threw while applying an override (decision 1) | §5 |
| `INSTANCE_DEFERRED` | build | an instance built as a counted placeholder with its box (M1) | §10 |
| `TEXT_WIDENED_TO_SOURCE_LINES` | build | a text Pixso draws on one line, widened so that Figma does too | §11, decision 9 |
| `IMAGE_PLACEHOLDER` | build | no bytes for an image from the archive, from Pixso or from a render; a placeholder is drawn | named here (§4) |
| `FILTER_UNRENDERED` | build | a filter Figma lacks that Pixso could not render; the paint is built without it | named here (§4) |
| `FONT_SUBSTITUTED` | build | a font missing in Figma; the text uses the fixed fallback font, counted per node and per style | named here (§4) |
| `STYLE_TARGET_NOT_BUILT` | build | the style is soft-deleted and was not built; raw values kept | named here (§3) |

"Named here" marks a condition that REWRITE.md counts without naming. The quoted sentence is in `REASON_CODES[code].from`.

## 14. What the validator checks

`validateIR(ir)` returns `{ ok, errors: [{ path, message }] }`. A path looks like `nodes[3].instance.master`, and at
most 200 errors are listed. It checks:
- the format and the version, and nothing else when either is wrong;
- the header: the snapshot, the scope, eight boolean capabilities, the setting enums;
- parent-first order, the page of each top-level record, one guid space, node types, and that no record sits under
  an instance;
- every index: `values` (and whether it points at a list or an object), `styles` (and the style type), `sets`,
  `pages`, note `node`;
- definitions: one entry per component and set record, axes, unique variant coordinates, members as children of
  their set, properties only on the family root, and property references bound to the right type;
- instances: master references, swaps and INSTANCE_SWAP values resolve; assignments match the master's family and
  type; the first hop of each override and of each derived box is a layer of the master; one override entry per
  path; and no instance sits inside its own master;
- styles: signatures, and identity unique per styleKey;
- images: every IMAGE paint has a hash and the hash is listed; fonts: every `fontName` is listed;
- notes: codes from the vocabulary;
- capabilities: the content claims nothing the header does not declare.

It does not repeat what the reader computes and tests on its own: variant parsing, swap-aware path resolution beyond
the first hop, and the stale and echo classification (M2a).

## 15. Changing the format

The version changes whenever a version 1 reader would misread or refuse the new IR. Because records are closed, a
new key changes it too. A change updates this document, `tools/ir/schema.mjs` and `tools/test-ir.mjs` together.

## 16. Complete example

A design file with one page and an internal canvas. The canvas holds a library variant set copied from a library
(two members, a TEXT property) and a soft-deleted own component with a BOOLEAN property. The page holds an instance of
one member with a property value, a fill override and its derived box, a rectangle whose image is missing from the
archive, and a text bound to a library paint style with one coloured range. Two notes record what the reader dropped.
`tools/test-ir.mjs` validates this block.

<!-- ir-example: valid -->
```json
{
  "header": {
    "format": "pix2fig.ir",
    "version": 1,
    "source": { "kind": "pix", "sha256": "00000000000000000000000000000000000000000000000000000000000000a1", "fileKey": null, "documentName": "Synthetic example" },
    "scope": { "kind": "file" },
    "capabilities": { "authoredOverrides": true, "resolvedOverrides": false, "overrideKeys": true, "publishIds": true,
      "symbolVersions": true, "derivedBoxes": true, "inkBounds": false, "renders": false },
    "settings": { "mode": "design", "overrides": "fidelity", "drift": "link", "deleted": "publish",
      "resync": "pixso-unless-edited", "textFit": "widen", "kitmaps": "default" }
  },
  "pages": [
    { "guid": "0:1", "name": "Page 1", "internal": false },
    { "guid": "0:2", "name": "Internal canvas", "internal": true }
  ],
  "values": [
    [{ "type": "SOLID", "color": { "r": 1, "g": 1, "b": 1 } }],
    [{ "type": "SOLID", "color": { "r": 0.8, "g": 0.1, "b": 0.1 } }],
    [{ "type": "IMAGE", "scaleMode": "FILL", "imageHash": "da7a000000000000000000000000000000000001" }],
    { "family": "Inter", "style": "Regular" },
    [{ "type": "SOLID", "color": { "r": 0.1, "g": 0.1, "b": 0.1 } }]
  ],
  "nodes": [
    { "parent": -1, "page": 0, "guid": "1:10", "type": "FRAME", "name": "Screen",
      "props": { "relativeTransform": [1, 0, 0, 0, 1, 0], "width": 360, "height": 200, "fills": 0 } },
    { "parent": 0, "guid": "1:11", "type": "INSTANCE", "name": "Button",
      "props": { "relativeTransform": [1, 0, 16, 0, 1, 16], "width": 120, "height": 40 },
      "instance": {
        "master": { "guid": "2:23", "library": { "publishFile": "SyntheticLibKey0000002", "publishID": "5:23",
          "componentKey": "c0ffee0000000000000000000000000000000002", "sharedSymbolVersion": "4" } },
        "properties": [{ "family": "2:20", "id": "Label#0:1", "value": "Buy" }],
        "overrides": [{ "path": ["2:24"], "fields": { "fills": 1 } }],
        "overrideBasis": "authored",
        "derived": [{ "path": ["2:24"], "size": [88, 20], "transform": [1, 0, 16, 0, 1, 10] }]
      } },
    { "parent": 0, "guid": "1:12", "type": "RECTANGLE", "name": "Photo",
      "props": { "relativeTransform": [1, 0, 16, 0, 1, 72], "width": 100, "height": 80, "fills": 2 } },
    { "parent": 0, "guid": "1:13", "type": "TEXT", "name": "Title",
      "props": { "relativeTransform": [1, 0, 132, 0, 1, 72], "width": 200, "height": 20, "characters": "Hello, world",
        "fontName": 3, "fontSize": 16, "fills": 4, "fillStyle": 0, "lines": 1,
        "textRanges": [{ "start": 0, "end": 5, "fields": { "fills": 1 } }] } },
    { "parent": -1, "page": 1, "guid": "2:20", "type": "COMPONENT_SET", "name": "Button",
      "props": { "relativeTransform": [1, 0, 0, 0, 1, 0], "width": 280, "height": 40 } },
    { "parent": 4, "guid": "2:21", "type": "COMPONENT", "name": "State=Default",
      "props": { "relativeTransform": [1, 0, 0, 0, 1, 0], "width": 120, "height": 40 } },
    { "parent": 5, "guid": "2:22", "type": "TEXT", "name": "Label", "overrideKey": "5:22",
      "props": { "relativeTransform": [1, 0, 16, 0, 1, 10], "width": 88, "height": 20, "characters": "Button",
        "fontName": 3, "fontSize": 14, "componentPropertyReferences": { "characters": "Label#0:1" } } },
    { "parent": 4, "guid": "2:23", "type": "COMPONENT", "name": "State=Hover",
      "props": { "relativeTransform": [1, 0, 160, 0, 1, 0], "width": 120, "height": 40 } },
    { "parent": 7, "guid": "2:24", "type": "TEXT", "name": "Label", "overrideKey": "5:24",
      "props": { "relativeTransform": [1, 0, 16, 0, 1, 10], "width": 88, "height": 20, "characters": "Button",
        "fontName": 3, "fontSize": 14, "componentPropertyReferences": { "characters": "Label#0:1" } } },
    { "parent": -1, "page": 1, "guid": "2:30", "type": "COMPONENT", "name": "Badge",
      "props": { "relativeTransform": [1, 0, 0, 0, 1, 100], "width": 24, "height": 24 } },
    { "parent": 9, "guid": "2:31", "type": "ELLIPSE", "name": "Dot",
      "props": { "relativeTransform": [1, 0, 8, 0, 1, 8], "width": 8, "height": 8, "fills": 1,
        "componentPropertyReferences": { "visible": "Dot#0:2" } } }
  ],
  "sets": [
    { "node": 4, "axes": [{ "name": "State", "values": ["Default", "Hover"] }],
      "properties": [{ "id": "Label#0:1", "name": "Label", "type": "TEXT", "default": "Button" }] }
  ],
  "components": [
    { "node": 5, "set": 0, "variant": { "State": "Default" },
      "library": { "publishFile": "SyntheticLibKey0000002", "publishID": "5:21",
        "componentKey": "c0ffee0000000000000000000000000000000001", "sharedSymbolVersion": "4" } },
    { "node": 7, "set": 0, "variant": { "State": "Hover" },
      "library": { "publishFile": "SyntheticLibKey0000002", "publishID": "5:23",
        "componentKey": "c0ffee0000000000000000000000000000000002", "sharedSymbolVersion": "4" } },
    { "node": 9, "set": null, "properties": [{ "id": "Dot#0:2", "name": "Dot", "type": "BOOLEAN", "default": true }],
      "deleted": true, "ancestorPath": ["Old page", "Badges"] }
  ],
  "styles": [
    { "guid": "3:1", "type": "PAINT", "name": "Text/Primary", "styleKey": "synthetic-style-key-1", "value": 4,
      "signature": "fnv1a64:762b94984c0b7be5", "library": { "publishFile": "SyntheticLibKey0000002" } }
  ],
  "images": [{ "hash": "da7a000000000000000000000000000000000001", "present": false, "format": "png" }],
  "fonts": [{ "family": "Inter", "style": "Regular" }],
  "notes": [
    { "code": "STALE_ASSIGNMENT", "node": 1, "detail": "an assignment to a property of another family" },
    { "code": "OVERRIDE_STALE", "node": 1, "path": ["2:99"], "detail": "path absent from derivedSymbolData" }
  ]
}
```
