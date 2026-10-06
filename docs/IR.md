# The intermediate representation (IR), version 3

Status: **M1 and M2a, format of record.** Specified from `docs/REWRITE.md` §4–§8, for version 2 from `docs/M1.md` §2
and §5.1, and for version 3 from `docs/M2A.md` §2 and §5.1. The validator is `tools/ir/schema.mjs` with the per-type
prop tables of `tools/ir/props.mjs`, called through `tools/ir/validate.mjs`; its tests are `tools/test-ir.mjs`, and
the complete example at the end of this file is one of those tests. Every value in this document is synthetic. §15
lists what changed in versions 2 and 3.

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
  - SPACE_EVENLY becomes SPACE_BETWEEN (a single visible flow child follows the `spaceEvenlySingle` setting), XOR
    becomes EXCLUDE, image STRETCH becomes CROP, FOREGROUND_BLUR becomes LAYER_BLUR;
  - a missing per-corner radius is 0;
  - the winding rule ODD becomes EVENODD, and mask type OUTLINE becomes VECTOR;
  - RESIZE_TO_FIT and the child sizing modes become Figma's sizing (`primaryAxisSizingMode`,
    `counterAxisSizingMode`, `layoutSizingHorizontal`, `layoutSizingVertical`);
  - `autoLayoutAbsolutePos` becomes `layoutPositioning: "ABSOLUTE"`, `itemReverseDraw` becomes `itemReverseZIndex`,
    `includeBorders` becomes `strokesIncludedInLayout`, and `frameMaskDisabled` becomes `clipsContent: false`;
  - a minimum or maximum size stored as NaN or FLT_MAX is unset, and is left out;
  - `count` becomes `pointCount` and `starInnerScale` becomes `innerRadius`;
  - a colour's `a` becomes the paint's `opacity`.
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
- **Defaults.** A property may be left out only when its value equals its entry in `DEFAULTS`
  (`tools/ir/props.mjs`); the builder writes `DEFAULTS` explicitly wherever the prop applies to the type. The
  `NEVER_OMIT` props are written on every record whose type has them, even at their default: `fills`, `strokes`,
  `strokeAlign`, `strokeWeight`, `clipsContent`, `blendMode`, `textAutoResize`, `layoutMode`,
  `primaryAxisSizingMode` and `counterAxisSizingMode`, because Figma's defaults for them differ by node type (a new
  Figma frame's axis sizing is not the source's absent FIXED), and `characters`, `fontName`, `fontSize`,
  `booleanOperation`, `pointCount` and `innerRadius`, which have no IR default at all. Empty paint lists travel too.
- **Closed records.** Every record has a fixed set of keys, and an unknown key is an error, so a misspelt key cannot
  be silently ignored. Since version 2 `props` are closed too: `KNOWN_PROPS` in `tools/ir/props.mjs` lists, per node
  type, the props it may carry and the kind of each (`num`, `int`, `bool`, `str`, `enum:A|B|…`, `value`, `style`, or
  `own` for an IR-own prop with its own rule here), and text range `fields` are closed to `RANGE_FIELDS`. Since
  version 3 override `fields` are closed too, to `OVERRIDE_FIELDS` and to their target's props (§9).

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
| `version` | `3` |
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
`inkBounds`, and an instance's `overrideBasis` needs the matching override capability. `renders` describes the IR's
own source for the planner and has no content of its own in the IR: a `.pix` IR declares `false`. Live Pixso is a
second source the planner may use beside a `.pix` (missing images, renders), and it is the planner's, not the IR's:
the planner checks that the open file is the `.pix` (root name, page guids, a sample of node guids) before it uses
it, and records the outcome in its own state (`docs/M1.md` D9, SOURCE_IDENTITY_MISMATCH).

**`settings`.** Every policy in REWRITE.md §11, plus the mode; all keys are required.

| key | values | flag | owner's default |
|---|---|---|---|
| `mode` | `design`, `kit` | `--mode` | chosen per run; a detector pre-selects it |
| `overrides` | `fidelity`, `link` | `--overrides` | `fidelity` (decision 1) |
| `drift` | `link`, `local` | `--drift` | `link` (decision 2) |
| `deleted` | `publish`, `skip` | `--deleted` | `publish` (decision 3) |
| `resync` | `pixso-unless-edited`, `report-only` | `--resync` | `pixso-unless-edited` (decision 8) |
| `textFit` | `widen`, `source-box` | `--text-fit` | `widen` (decision 9) |
| `booleans` | `auto`, `native`, `flatten` | `--booleans` | `auto` (`docs/M1.md` D5) |
| `spaceEvenlySingle` | `between`, `center` | `--space-evenly-single` | `between` until P18 (`docs/M1.md` D14) |
| `kitmaps` | `"default"` (the per-user folder) or the directory given | `--kitmaps` | `"default"` (decision 4) |
| `variantSets` | `parse`, `frames` | `--variant-sets` | `parse` (`docs/M2A.md` D2, D13; `frames` is M1's D7) |
| `variantGrammar` | `names`, `vocabulary` | `--variant-grammar` | `names` (D2) |
| `axisOrder` | `vocabulary`, `names` | `--axis-order` | `vocabulary` (D2) |
| `swapDangling` | `skip`, `strict` | `--swap-dangling` | `skip` (D5, D7 rule A) |
| `swapReset` | `on`, `off` | `--swap-reset` | `on` (D7 rule B) |
| `swapFallback` | `derived`, `off` | `--swap-fallback` | `derived` (D7 rule C) |
| `swapDefault` | `layer`, `definition` | `--swap-default` | `layer` (D5) |
| `rejectedProps` | `copy`, `none` | `--rejected-props` | `copy` (D3) |
| `defaultAssignments` | `keep`, `drop` | `--default-assignments` | `keep` (D6) |
| `overrideMerge` | `last`, `first`, `outer` | `--override-merge` | `outer`, from part C's measurement (D8, D17) |
| `echo` | `drop`, `keep` | `--echo` | `drop` (D9) |
| `instanceOwn` | `overrides`, `own` | `--instance-own` | `overrides` (D11) |
| `derivedGeometry` | `changed`, `all`, `none` | `--derived-geometry` | `changed` (D10) |

`SETTING_DEFAULTS` in the schema holds the defaults of this table, and `M2A_SETTINGS` lists the thirteen keys version
3 added (the D-numbers are `docs/M2A.md`'s).

## 5. Pages

`{ guid, name, internal, background? }`. `internal` is `true` for Pixso's internal canvas, which holds library copies
and soft-deleted masters. `background` is a `values` index of a fills list: the page's own paints. Top-level node
records name their page by index. A Pixso DIRECTORY is a folder of pages, not a node: its canvases become pages and
the folder itself is not carried.

## 6. Values

Repeated values are stored once in `values` and referenced by index. The interned properties, wherever they appear
(node `props`, text range `fields`, override `fields`), are:

`fills`, `strokes`, `effects`, `layoutGrids`, `exportSettings`, `dashPattern`, `constraints`, `fontName`,
`letterSpacing`, `lineHeight`, `arcData`, `vectorNetwork`, `fillGeometry`, `strokeGeometry`, `oracleFillGeometry`,
`hyperlink`, `listOptions`.

A value appears once (compared as canonical JSON, keys sorted, `canonicalJSON` in the schema), in order of first use.
`fills`, `strokes`, `effects`, `layoutGrids`, `exportSettings`, `dashPattern`, `fillGeometry`, `strokeGeometry` and
`oracleFillGeometry` point at lists; the others point at objects. A style's value is a `values` index too.

Two value shapes are checked:
- **geometry** (`fillGeometry`, `strokeGeometry`, `oracleFillGeometry`): `[{ windingRule, data }]`, `windingRule`
  `NONZERO` or `EVENODD`, `data` a Figma path string: commands `M`, `L`, `Q`, `C` and `Z`, every letter and number
  separated by white space (`"M 0 0 L 10 0 L 10 10 Z"`);
- **vector network**: `{ vertices, segments, regions }` as Figma's `VectorNetwork`: a vertex is `{ x, y,
  strokeCap?, strokeJoin?, cornerRadius?, handleMirroring? }` (`NONE`, `ANGLE` or `ANGLE_AND_LENGTH`; Pixso's
  RIGHT_ANGLE is stripped by the reader; `cornerRadius` is the vertex's own, `0` included where its style says 0
  under a node `cornerRadius`, which a vertex with no radius of its own takes, M1.md §15.13), a segment `{ start, end, tangentStart?, tangentEnd? }` with vertex indices,
  a region `{ windingRule, loops, fills? }` whose loops are closed lists of segment indices.

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
  `NODE_TYPE_UNSUPPORTED` note;
- **style definitions are not node records** (the nodes Pixso keeps as the bodies of styles, with no transform):
  the reader counts them as not carried; the fill, stroke and effect styles records draw are the IR's `styles` (§7,
  §10), which the builder writes as raw values until M2b;
- every record has `props`, with `relativeTransform`, `width` and `height` at least;
- a prop is one `KNOWN_PROPS` lists for the record's type, of the kind it lists (§2); the `NEVER_OMIT` props the
  type has are always present;
- the Figma properties the IR expresses another way are refused: `x`, `y` and `rotation` (in `relativeTransform`),
  the four `stroke*Weight` sides (in `strokeWeights`) and the four `*Radius` corners (in `cornerRadii`).

Version 2's decisions about what a record is (`docs/M1.md` §2):
- **Vectors (D3).** The reader decides each vector's build source, exactly one per `VECTOR` record: its
  `vectorNetwork` (a network with a region, or with no stored fill geometry), or its stored `fillGeometry` with
  `strokeGeometry` (a network with no region but with fill geometry, an auto-closed loop). A network record keeps the
  stored fill geometry as `oracleFillGeometry`, which tasks never carry; a geometry record is its own oracle and
  carries a `VECTOR_FROM_GEOMETRY`, `BOOLEAN_FLATTENED` or `SOURCE_FEATURE_UNSUPPORTED` note saying why it is built
  from geometry. `strokeGeometry` is never a source on its own. `LINE`, `STAR`, `POLYGON` and `BOOLEAN_OPERATION`
  are built natively and carry no build-source geometry, only, optionally, `oracleFillGeometry`. A Pixso CONNECTLINE
  becomes a `VECTOR` from its network and a LINE with a height a `VECTOR` from its geometry, each with a
  `SOURCE_FEATURE_UNSUPPORTED` note. Where the network and the stored geometry disagree in a known way the record has
  a `VECTOR_ORACLE_DIFFERS` note whose detail starts with the class (`region-no-fill`, `network-bounds`,
  `winding`). A native `BOOLEAN_OPERATION` whose stored result is out of date against its own operands (a union
  that leaves one out by more than 1 px, and every boolean made from such a one) has a `VECTOR_ORACLE_DIFFERS` note
  of class `boolean-operands` (`tools/ir/operands.mjs`, M1.md §15.13). A network record with no region whose segments close a loop and no stored fill path keeps its
  network; Figma fills such a loop (P19B, 2026-10-05) where Pixso drew none, so under a visible fill paint the
  record is written with `fills` [] and a `SOURCE_FEATURE_UNSUPPORTED` "unfilled loop" note, and Figma draws no
  fill either. An open region loop the reader drops (no visible fill) adds no segment to the network.
- **Groups (D4)** keep the type `GROUP`; the builder makes them frames with no paints and no clipping.
- **Booleans (D5).** Under `booleans: auto` a boolean whose operands are all filled shapes stays a
  `BOOLEAN_OPERATION` over its operands; one with an operand that only strokes (or has no geometry) is written as one
  `VECTOR` record from its stored fill geometry with the boolean's own paints, its operands are not carried, and a
  `BOOLEAN_FLATTENED` note gives the operation and the folded count. `native` keeps every boolean, `flatten` none. A
  boolean with no operand and no geometry is not carried (`GEOMETRY_INVALID`).
- **State groups (D7; version 3: `docs/M2A.md` D2).** A state group whose member names parse into one set of axes
  is a `COMPONENT_SET` record with a `sets` entry, its props those of the `FRAME` it was in version 2 (auto layout
  included). One that does not parse stays a `FRAME` record holding standalone `COMPONENT` records, with a
  `VARIANT_SET_REJECTED` note on it. Under `variantSets: frames` every state group is the version 2 `FRAME` with
  standalone components and no note (M1's D7). The planner writes a `COMPONENT_SET` record into tasks as a `FRAME`
  until M2b builds sets (`taskType()` in `tools/ir/task.mjs`, `docs/M2A.md` D13).
- **Side strokes (D15).** No `border*Weight` field means four sides at `strokeWeight`; any field present means a
  missing side is 0. Where the stroke-area path shows which sides Pixso draws, the reader writes `oracleSides`, and
  where the rule and the path disagree the IR follows the path and notes `SIDE_RULE_UNPROVEN`. A stroke whose every
  side rounds to 0 (a 0.001 px border) is weight 0 and has no `oracleSides` (M1.md §15.13).
- **Section strokes (D13)** are dropped: a `SECTION` has fills only. Its corner radius, which Figma does not draw on a
  section, is noted `SOURCE_FEATURE_UNSUPPORTED` "SECTION corner radius".

The IR's own `props`:

| prop | |
|---|---|
| `relativeTransform` | `[a, b, tx, c, d, ty]`, relative to the parent record (groups included); composing the chain gives Pixso's absolute transform. Required |
| `width`, `height` | the layout box, finite and at least 0. Required |
| `strokeWeights` | `[top, right, bottom, left]`, finite and at least 0, only when the sides differ |
| `cornerRadii` | `[topLeft, topRight, bottomRight, bottomLeft]`, finite and at least 0, only when the corners differ, and then instead of `cornerRadius` |
| `oracleSides` | `[top, right, bottom, left]` booleans: whether Pixso's stroke-area path draws that side (D15); never in a task |
| `oracleFillGeometry` | the stored fill geometry of a network-built `VECTOR` or a natively built vector type, a `values` index (D3); never in a task |
| `textRanges` | `[{ start, end, fields }]`: ascending, non-overlapping ranges in UTF-16 units of `characters` (Figma's indexing; the reader converts Pixso's per-code-point style ids). No bound splits a surrogate pair; `fields` holds only what differs from the node, from `RANGE_FIELDS` |
| `lines` | the number of lines Pixso drew, from its stored baselines (decision 9); a text with none has no `lines` and a `TEXT_LINES_UNKNOWN` note |
| `inkBounds` | `[x, y, width, height]` of the rendered ink, in the node's own frame (capability `inkBounds`) |
| `fillStyle`, `strokeStyle`, `textStyle`, `effectStyle`, `gridStyle` | index into `styles`, of type PAINT, PAINT, TEXT, EFFECT and GRID |
| `componentPropertyReferences` | `{ characters \| visible \| mainComponent: property id }`, bound to TEXT, BOOLEAN and INSTANCE_SWAP properties of the enclosing definition's family, always by the **root** definition's id: a Pixso binding through a variant-local alias is written with the id its alias chain ends in (`docs/M2A.md` D3, D4), and a binding that cannot be carried is a `PROPERTY_REF_DROPPED` note |

A node that references a fill, stroke or effect style draws the **style's** current value: Pixso keeps the node's own
paints as a cache that goes stale when the style changes (a render pair of P, 2026-10-05: a section whose own fill is
grey and whose fill style is blue draws blue; `tools/pix/ir/styles.mjs`). So where the reference resolves to a style
definition of its kind in the file that carries a value, the record takes that value and the style is bound
(`fillStyle`, `strokeStyle`, `effectStyle`; §10), and where the node's own value differs from it by more than 1/255
per channel or unit a `STYLE_VALUE_DIFFERS` note says so. A reference that resolves to no style definition of its
kind (a library style the file does not carry), or to one with no value, keeps the node's own value, unbound, with a
`STYLE_MISSING_IN_SOURCE` note. A reference resolves by guid, or else through a style definition's `overrideKey`;
`0:0` and the all-ones guid are no reference. A stroke style is a paint style: its value is its fill paints. An
`INSTANCE` placeholder resolves none (it draws nothing in M1); layout grids are not carried in M1, so a grid style
changes nothing; text styles follow §15.7's R2 (`text.mjs`). Measured on the four files (records, read-only): bound
fill / stroke / effect styles D 3 291 / 744 / 13, K 27 382 / 11 717 / 752, M 11 355 / 1 429 / 47, P 20 869 / 3 216 / 420;
the style's value drawn over a differing own copy D 0, K 0, M 41, P 182; references kept unbound D 94, K, M and P 0.

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
names its record by `node`, the detail starting with the class (§13). Under `rejectedProps: copy` each member
declares the state group's roots as its own family's (same ids); under `none` it declares none (`docs/M2A.md` D3).

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
the variant-local aliases newer Pixso writes. A root that Pixso keeps on a member of an accepted set is declared on
the set (`docs/M2A.md` D3, "member-owned roots").

**Property definition**: `{ id, name, type, default, preferredValues? }`. `type` is `BOOLEAN`, `TEXT` or
`INSTANCE_SWAP`; variants are axes, not a property type. A family declares its **roots** only, in Pixso's
`sortPosition` order, then by id. `default` is a boolean, a string or a master reference (§9) respectively; an
INSTANCE_SWAP default must resolve. `preferredValues` (INSTANCE_SWAP only, version 3) is an array of key references
in Figma's own shape, `{ type, componentKey, guid? }`: `type` is `COMPONENT` or `COMPONENT_SET`, `componentKey` is 40
lowercase hex, and `guid`, when the key's copy is in this IR, is the guid of that `COMPONENT` or `COMPONENT_SET`
record. A key whose copy is not in the file is kept by key alone, for M3's kit map, and is never refused.

**Library identity**: `{ publishFile, publishID?, componentKey?, sharedSymbolVersion? }`.
- `publishFile` is the library's Pixso file key and is required.
- `publishID` is the master's guid in that library; `componentKey` is 40 lowercase hex: measured (C) on every
  library copy of the three local files M1 is planned on (`docs/M1.md`: D, K and M). At least one of them is
  required. The kit map resolves `publishFile@publishID`; an MCP source resolves through
  `componentKey`.
- `sharedSymbolVersion` is opaque and is only compared for equality.
- Identity is never the name: names drift.

## 9. Instances

An `INSTANCE` record's `instance`:

| key | |
|---|---|
| `master` | the master reference |
| `properties` | `[{ family, id, value }]`: assignments to the master's family, by root id |
| `overrides` | `[{ path, at?, fields?, swap?, properties? }]`, below |
| `overrideBasis` | `"authored"` or `"resolved"`; required when there are overrides, and needs the matching capability |
| `derived` | `[{ path, at?, size?, transform?, fillGeometry?, strokeGeometry?, lines?, oracleSides? }]`: Pixso's resolved geometry of each sublayer (capability `derivedBoxes`); the verifier's oracle, and the geometry and vector paths of any fallback frame (REWRITE.md §3). Below |
| `exposed` | `true` only, for a nested instance inside a `COMPONENT` record whose properties its instances expose (Pixso's `propsAreBubbled`, Figma's `isExposedInstance`; version 3) |
| `scale` | the uniform scale factor when it is not 1: a finite number above 0 (Pixso's `uniformScaleFactor`; version 3) |

**Master reference**: `{ guid?, library? }`. It resolves:
1. to a definition in this IR, when `guid` is the guid of a `COMPONENT` record; or else
2. to a library identity, when the master is not in the IR (`library` with `publishFile` and `publishID` or
   `componentKey`), which the kit map resolves later.

Anything else is a dangling reference and the IR is refused. The same rule applies to swap targets and to
INSTANCE_SWAP values and defaults (preferred values are key references, §8). An instance may not sit inside its own
master.

**Property values** are assigned to the master's family. An assignment whose definition cannot be reached from the
instance's current family is stale: the reader drops it and writes a `STALE_ASSIGNMENT` note, and never matches it by
name.

**Overrides** are the live ones only (version 3: `docs/M2A.md` D7-D11, D17):
- `path` is a guidPath of **local guids** with swaps resolved (outer swaps win), and its first guid is a layer inside
  the master. `path` `[]` is the instance itself: at most one such entry, with no `at`, no `swap` (the master is
  `master`) and no `properties` (those are the instance's `properties`); its `fields` are the instance's **look**
  only, `ROOT_OVERRIDE_FIELDS` in `props.mjs`: what a `COMPONENT` has and an `INSTANCE` record does not. The box,
  child layout, `visible`, `locked` and `name` are the record's own props.
- `at` is the IR record index of each path element, as many as the path has: `nodes[at[k]].guid` is `path[k]`,
  `at[0]` lies inside the master, every element but the last is an `INSTANCE` record, and every later element lies
  inside a `COMPONENT` record. It is required when the master is a record in this IR and every element has a record;
  a path through an element with no record (a folded boolean operand) has none, so neither the planner nor the plugin
  ever resolves a path. Only a derived entry may start at a layer with no record (it is then kept without `at`); an
  override's first element is always a record of the master, because a field on a layer that is not carried is
  dropped (`OVERRIDE_FIELD_DROPPED` `layer-not-carried`).
- `fields` holds Figma properties, interned like node props, closed to `OVERRIDE_FIELDS` (`props.mjs`) and, where `at`
  names the target, to the target type's props plus `name`; an `INSTANCE` target takes a `COMPONENT`'s props (its
  look is its master root's). A `textRanges` field is checked as on a record, against the override's own
  `characters` or the target's. Each field has a class in `OVERRIDE_FIELD_CLASS`: `applies` (P13), `refused` (size,
  position, rotation, constraints: kept, and counted `OVERRIDE_FIELD_UNSUPPORTED` by the planner, decision 1) or
  `unprobed` (until M2b's P13b).
- `swap` is a master reference. Besides the swaps of live entries, the reader writes a **pinned** swap, to the
  symbol Pixso drew, on a nested instance whose symbol the kept data would not give: a hop rule C forced whose
  ignored assignment sits on an instance inside a master (kept there, where Pixso applied it), and a swap Pixso
  drew from an assignment the IR drops (`docs/M2A.md` D7). A pinned swap joins the live entry of its path, or is an
  override of its own with `path` and `at` only;
- `properties` holds assignments to the nested instance the path ends in: each names a family in this IR, and that
  of the entry's `swap` when the swap is to a record here.

Before writing, the reader drops: an entry whose path is absent from `derivedSymbolData`, which is provably stale
(`OVERRIDE_STALE`, class `not-derived`; or `unresolved`, in it but not resolving); a field that only echoes the value
the target already has (`OVERRIDE_ECHO`, one note per instance); and a field it does not carry (`OVERRIDE_FIELD_DROPPED`,
one note per instance and class), including one whose only effect is to remove a prop the target has (a style
detached or naming none, `maxLines` cleared) when no written field carries the removal (`no-equivalent`). Entries of one path are merged into one (`OVERRIDE_PATHS_MERGED`); an assignment
that cannot be reached is a `STALE_ASSIGNMENT`, and a swap value naming nothing the IR can reference a
`SWAP_VALUE_DANGLING`. Size, position, rotation and constraint fields stay in the IR even though Figma cannot apply
them to instance sublayers (REWRITE.md §9, P13). One entry per path. A note about an entry names the instance by
`node` and the entry by `path`, `[]` for the instance's own override.

**Derived entries** are Pixso's resolved boxes as stored, **sparse**: `size` and `transform` only where Pixso stores
them (absent means the master layer's, I), `lines` from the sublayer's stored baselines, `oracleSides` from its
stroke-area path (the side oracle of D15, inside instances), `fillGeometry` and `strokeGeometry` (values indexes of
lists, as on nodes) under `derivedGeometry` (`changed`: only where they differ from the target layer's own). `path`
is never `[]`, `at` is as on overrides, every entry carries at least one key besides `path` and `at`, and there is
one entry per path.

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
- `present` says whether the bytes are in the source archive: an archive entry named by the hash whose SHA-1 is the
  hash. An entry whose SHA-1 differs from its name counts as missing and is noted `IMAGE_HASH_MISMATCH`, a file-level
  note with no `node` (the entry's name, which is the hash it claims, is in the detail). Often the
  bytes are not there: then the planner's chain is MCP bytes by hash (SHA-1 checked), then a Pixso render, then a
  counted placeholder (`IMAGE_PLACEHOLDER`), never an empty fill.
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
record (an unsupported node); `path` is a guidPath inside an instance (`[]` for the instance's own override, the entry
with `path` `[]`), and a note with a `path` names that `INSTANCE` record by `node`; `detail` is free text, except that a code with classes (`NOTE_CLASSES` in the schema) has a detail
that starts with one of its classes, optionally followed by `: ` and text. The classes are listed in the table below,
in the order the reader decides in. A `VECTOR_ORACLE_DIFFERS` note names a network-built `VECTOR` record (its
classes `ORACLE_CLASSES`), except that the class `boolean-operands` (`BOOLEAN_ORACLE_CLASSES`) names a
`BOOLEAN_OPERATION` record with its stored result instead; a `VARIANT_SET_REJECTED` note names the state group's
`FRAME` record. An IR's notes carry **read-stage codes only**; the other stages go to the run's own reports.

Code writes a code as `CODE.X` (the frozen map in the schema), never as a quoted string, through one helper per
side that throws on an unknown code: the reader's `note()`, the plugin's `ctx.code()` and the runner's `count()`.
`tools/test-ir.mjs` scans every M1 file for quoted codes and for a `CODE.X` that names no code.

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
| `VARIANT_SET_REJECTED` | read | the member names of a state group do not parse into one set of axes; the record stays a FRAME and the members become standalone components. Classes: `no-equals`, `duplicate-axis`, `axis-count`, `duplicate-coordinate`, `vocabulary`, `empty`, `not-symbol` | §3 |
| `STALE_ASSIGNMENT` | read | a property assignment unreachable from the instance's current family; dropped, one note per assignment. Classes: `no-definition`, `other-family`, `no-root`, `undeclared`, `nested` (in a live entry, followed by `: ` and the class against the nested instance's family), `ignored` (rule C) | §3 |
| `STYLE_MISSING_IN_SOURCE` | read | a style reference that resolves to no style definition of its kind in the file, or to one with no value there; the node's own values kept, unbound (§7) | §3 |
| `STYLE_VALUE_DIFFERS` | read | the node's own value differs from its resolved style's by more than 1/255 per channel or unit; Pixso draws the style's, so the style's value is written and the style bound (§7) | §3 |
| `VECTOR_FROM_GEOMETRY` | read | fill geometry but no region: built from the stored fill and stroke geometry | §3 |
| `OVERRIDE_STALE` | read | an override entry whose path is absent from `derivedSymbolData`; dropped, one note per path. Classes: `not-derived`, `unresolved` (in it, but not resolving) | named here (§3) |
| `OVERRIDE_ECHO` | read | override fields equal to the value the target has without them; dropped, one note per instance with the count and the field names | named here (§3, P9b) |
| `PROPERTY_REF_DROPPED` | read | a layer's binding to a component property that is not carried; never matched by name; one note per record and class, with the count. Classes: `fill-style`, `outside-definition`, `no-definition`, `other-family`, `no-root`, `undeclared`, `type-mismatch` | named here (§3) |
| `SWAP_VALUE_DANGLING` | read | an INSTANCE_SWAP value or default, or a swap target, naming no component the IR can reference; dropped. Classes: `assignment`, `default`, `swap` (a detail `: not carried` for a stored symbol with no record and no library identity) | named here (§3) |
| `SWAP_ASSIGNMENT_IGNORED` | read | a swap assignment Pixso's derived data shows was not applied (rule C); the declared symbol is used and the assignment dropped, or, when an instance inside a master holds it, the hop pinned with a swap override; one note per instance with the counts | named here (§3) |
| `OVERRIDE_PATHS_MERGED` | read | override entries of one path merged into one (`overrideMerge`); one note per instance with the conflicting field count | named here (§3) |
| `OVERRIDE_FIELD_DROPPED` | read | an override field not carried; one note per instance and class, the detail the class, then `: ` and the fields with counts. Classes: `no-equivalent`, `not-on-type`, `layer-not-carried`, `root-box`, `unknown` | named here (§3) |
| `NODE_TYPE_UNSUPPORTED` | read | a source node type the IR has no type for; it and its subtree are not carried | named here (§7, §8) |
| `TEXT_LINES_UNKNOWN` | read | a buildable text with no stored baselines; it has no `lines` | named here (§3) |
| `SOURCE_FEATURE_UNSUPPORTED` | read | a Pixso feature Figma lacks, named in the detail, which starts with the feature from an open list (CONNECTLINE, LINE with height, SECTION strokes, SECTION corner radius, RIGHT_ANGLE, vibrance, hue filter, dashCap, deformationTransform, fontVariations, GRID, counter alignment <X>, strokeCap <X>, effect <TYPE>, export format <X>, paint type <X>, image paint without an image, text without a font name, inverse winding, open region loop, operand strokes under `--booleans native`, an operand without fill geometry, boolean without stored geometry, built natively, no stored geometry (a STAR or POLYGON), layoutGrids, fontVariantNumeric, fontVariantPosition, OpenType features, COLOR property), optionally followed by `: ` and text; dropped or converted, and counted per feature in `stats.unsupported`. The judge excuses a vector's paths only for the features that change the drawing (`judge.mjs` SFU_GEOMETRY, docs/M1.md §8.3) | named here (§7) |
| `GEOMETRY_INVALID` | read | a NaN size, transform or path, or a boolean with no operand and no geometry; the box comes from the geometry or the children, or the node is not carried | named here (§7) |
| `IMAGE_HASH_MISMATCH` | read | an archive image entry whose SHA-1 is not its name; treated as missing | named here (§4) |
| `VECTOR_ORACLE_DIFFERS` | read | the stored network and the stored fill geometry disagree in a pre-registered class (`region-no-fill`, `network-bounds`, `winding`), or a boolean's stored result is out of date against its operands (`boolean-operands`) | named here (§3) |
| `SIDE_RULE_UNPROVEN` | read | the side rule and the stroke-area path disagree; the IR follows the path | named here (§3) |
| `BOOLEAN_FLATTENED` | read | a boolean carried as one `VECTOR` from its stored fill geometry; its operands are not carried | named here (§7) |
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
| `OUT_OF_SCOPE` | plan | an IR record the chosen M1 scope does not build; the detail names its population | named here (§6) |
| `FONT_MISSING` | plan | an IR font Figma does not have, listed in the preflight with "install, restart Figma, run again" | named here (§4) |
| `SOURCE_IDENTITY_MISMATCH` | plan | the file open in Pixso is not the `.pix` (root name, page guids or the guid sample differ); the MCP image links are skipped | named here (§4) |
| `OVERRIDE_APPLY_FAILED` | build | Figma threw while applying an override (decision 1) | §5 |
| `INSTANCE_DEFERRED` | build | an instance built as a counted placeholder with its box (M1) | §10 |
| `TEXT_WIDENED_TO_SOURCE_LINES` | build | a text Pixso draws on one line, widened so that Figma does too | §11, decision 9 |
| `IMAGE_PLACEHOLDER` | build | no bytes for an image from the archive, from Pixso or from a render; a placeholder is drawn | named here (§4) |
| `FILTER_UNRENDERED` | build | a filter Figma lacks that Pixso could not render; the paint is built without it | named here (§4) |
| `FONT_SUBSTITUTED` | build | a font missing in Figma; the text uses the fixed fallback font, counted per node and per style | named here (§4) |
| `STYLE_TARGET_NOT_BUILT` | build | the style is soft-deleted and was not built; raw values kept | named here (§3) |
| `VECTOR_NETWORK_REFUSED` | build | `setVectorNetworkAsync` threw; the vector keeps no paths | named here (§10, M1) |
| `BOOLEAN_FALLBACK` | build | Figma threw on the boolean operation; the operands stay in a frame | named here (§6) |
| `MASK_UNSUPPORTED` | build | Figma refused or ignored a mask on a group built as a frame; built unmasked | named here (§7) |
| `VECTOR_GEOMETRY_DIFFERS` | build | the judge found a vector whose built paths differ from the oracle outside every excuse; a defect | named here (§10, M1) |
| `TEXT_LINES_DIFFER` | build | the built text's line count differs from the stored baselines | named here (§10, M1) |
| `PLUGIN_STALLED` | run | the progress counter did not advance for the fail time, or the task passed its ceiling; failed, resumable | named here (§6) |
| `BUILD_FAILED` | run | the plugin refused the task or threw outside a counted fallback; the full error is kept | named here (§6) |
| `ROOT_NOT_FOUND` | run | VERIFY found no root for the task, by registry or by stamp | named here (§4) |

"Named here" marks a condition that REWRITE.md counts without naming. The quoted sentence is in `REASON_CODES[code].from`.

## 14. What the validator checks

`validate(ir)` (`tools/ir/validate.mjs`, which calls `validateIR(ir, { props })` with the tables of
`tools/ir/props.mjs`) returns `{ ok, errors: [{ path, message }] }`. A path looks like `nodes[3].instance.master`, and
at most 200 errors are listed. `validateIR` without the tables throws: a caller that forgot them must not be told
"ok". It checks:
- the format and the version, and nothing else when either is wrong;
- the header: the snapshot, the scope, eight boolean capabilities, the setting enums;
- parent-first order, the page of each top-level record, one guid space, node types, and that no record sits under
  an instance;
- every index: `values` (and whether it points at a list or an object), `styles` (and the style type), `sets`,
  `pages`, note `node`, a page's `background`;
- props (version 2): every record has `relativeTransform` (six finite numbers) and a finite `width` and `height` of
  at least 0; every prop is known for the type and of its kind, and the `NEVER_OMIT` ones are present; no superseded
  prop, and no `cornerRadius` next to `cornerRadii`; `strokeWeights` and `cornerRadii` are four finite numbers of at
  least 0 that are not all equal (four equal ones are `strokeWeight` or `cornerRadius`) and `oracleSides` four
  booleans;
- vectors: geometry props only on vector types (and in derived boxes); one build source per `VECTOR` record, a
  geometry-built one with its note, `strokeGeometry` only next to `fillGeometry`, `oracleFillGeometry` only next to
  a network or on a natively built type; geometry values and networks of the shapes in §6, with closed loops;
- text: ranges inside `characters`, ascending, not splitting a surrogate pair, with `RANGE_FIELDS` of their kinds;
- definitions: one entry per component and set record, axes, unique variant coordinates, members as children of
  their set, properties only on the family root, property references bound to the right type, and preferred values
  as key references whose `guid` names a record of their type;
- instances: master references, swaps and INSTANCE_SWAP values resolve; assignments match the master's family and
  type, and an override's assignments name a family in this IR (its swap's, when the swap is local); the first hop
  of each override and of each derived box is a layer of the master, and `at`, where required or given, indexes
  every element as §9 says; override fields are closed to `OVERRIDE_FIELDS` and to the target's props, the
  instance's own override to its look; one override entry and one derived entry per path, and every derived entry
  carries something; `exposed` only inside a `COMPONENT` record, `scale` above 0 and not 1; and no instance sits
  inside its own master;
- styles: signatures, and identity unique per styleKey;
- images: every IMAGE paint has a hash and the hash is listed; fonts: every `fontName` is listed;
- notes: codes from the vocabulary, read-stage only, the class of every code that has classes, the record a
  `VECTOR_ORACLE_DIFFERS` or `VARIANT_SET_REJECTED` note names, and the instance a note with a `path` names;
- capabilities: the content claims nothing the header does not declare.

It does not repeat what the reader computes and tests on its own: variant parsing, swap-aware path resolution beyond
what `at` states, and the stale and echo classification (`docs/M2A.md`, parts A-C).

## 15. Changing the format

The version changes whenever a reader of the previous version would misread or refuse the new IR. Because records
are closed, a new key changes it too. A change updates this document, `tools/ir/schema.mjs`, `tools/ir/props.mjs` and
`tools/test-ir.mjs` together. The validator knows one version only; no IR is migrated.

**Version 2** (M1, `docs/M1.md` D2), one bump for all of M1, made before any IR was written, so nothing migrates:
- props are closed per node type (`KNOWN_PROPS`), text range fields to `RANGE_FIELDS`, and the `NEVER_OMIT` props
  are required where they apply;
- every record has `props` with `relativeTransform`, `width` and `height`; `x`, `y`, `rotation`, the side weights
  and the corner radii as separate props are refused;
- the IR-own props `oracleFillGeometry` and `oracleSides`; interned `oracleFillGeometry`, `hyperlink` and
  `listOptions`;
- one build source per `VECTOR` record, the shapes of geometry values and networks;
- `pages[].background`;
- the settings `booleans` and `spaceEvenlySingle`;
- the codes `TEXT_LINES_UNKNOWN` to `ROOT_NOT_FOUND` in §13; IR notes carry read-stage codes only.

**Version 3** (M2a, `docs/M2A.md` D16), one bump for all of M2a; no version 2 IR or run folder is migrated:
- the thirteen header settings of §4 (`M2A_SETTINGS`), each required;
- accepted state groups as `COMPONENT_SET` records with `sets` entries; bindings and assignments by root id;
- overrides: `at`, the instance's own override with `path` `[]` (its look only), `fields` closed to
  `OVERRIDE_FIELDS` and to the target's props, `OVERRIDE_FIELD_CLASS`, assignments in an override naming a family in
  this IR;
- derived entries: sparse (`size` and `transform` optional), `at`, `lines`, `oracleSides`, one per path, never empty;
- instance data: `exposed` and `scale`;
- preferred values as key references `{ type, componentKey, guid? }`;
- the codes `PROPERTY_REF_DROPPED` to `OVERRIDE_FIELD_DROPPED` in §13, and frozen detail classes (`NOTE_CLASSES`) for
  them and for `VARIANT_SET_REJECTED`, `STALE_ASSIGNMENT` and `OVERRIDE_STALE`; a note with a `path` names its
  instance by `node`.

## 16. Complete example

A design file with one page and an internal canvas. The canvas holds a library variant set copied from a library
(two members, a TEXT property; an accepted state group, so a `COMPONENT_SET` with one axis) and a soft-deleted own
component with a BOOLEAN property and an INSTANCE_SWAP property whose preferred values are key references, one to a
library copy in this file (with its `guid`) and one to a set that is not (by key alone). Each member's label is bound
to the root's id, although Pixso bound the Hover member's label through a variant-local alias (`docs/M2A.md` D3).
The page, with a white background, holds an instance of one member with a property value, its own override (path
`[]`: its opacity), a fill override on the label with `at`, and a sparse derived entry for the label (its size and
line count only: its transform is the master layer's); a rectangle whose image is missing from the archive and
whose border Pixso draws on the bottom side only; a text bound to a library paint style with one coloured range; and
a vector built from its stored geometry. Five notes record what the reader dropped or decided, each class-bearing
one starting with its class. `tools/test-ir.mjs` validates this block.

<!-- ir-example: valid -->
```json
{
  "header": {
    "format": "pix2fig.ir",
    "version": 3,
    "source": { "kind": "pix", "sha256": "00000000000000000000000000000000000000000000000000000000000000a1", "fileKey": null, "documentName": "Synthetic example" },
    "scope": { "kind": "file" },
    "capabilities": { "authoredOverrides": true, "resolvedOverrides": false, "overrideKeys": true, "publishIds": true,
      "symbolVersions": true, "derivedBoxes": true, "inkBounds": false, "renders": false },
    "settings": { "mode": "design", "overrides": "fidelity", "drift": "link", "deleted": "publish",
      "resync": "pixso-unless-edited", "textFit": "widen", "booleans": "auto", "spaceEvenlySingle": "between",
      "variantSets": "parse", "variantGrammar": "names", "axisOrder": "vocabulary", "swapDangling": "skip",
      "swapReset": "on", "swapFallback": "derived", "swapDefault": "layer", "rejectedProps": "copy",
      "defaultAssignments": "keep", "overrideMerge": "last", "echo": "drop", "instanceOwn": "overrides",
      "derivedGeometry": "changed", "kitmaps": "default" }
  },
  "pages": [
    { "guid": "0:1", "name": "Page 1", "internal": false, "background": 0 },
    { "guid": "0:2", "name": "Internal canvas", "internal": true }
  ],
  "values": [
    [{ "type": "SOLID", "color": { "r": 1, "g": 1, "b": 1 } }],
    [{ "type": "SOLID", "color": { "r": 0.8, "g": 0.1, "b": 0.1 } }],
    [{ "type": "IMAGE", "scaleMode": "FILL", "imageHash": "da7a000000000000000000000000000000000001" }],
    { "family": "Inter", "style": "Regular" },
    [{ "type": "SOLID", "color": { "r": 0.1, "g": 0.1, "b": 0.1 } }],
    [],
    [{ "windingRule": "NONZERO", "data": "M 0 0 L 24 0 L 12 20 Z" }]
  ],
  "nodes": [
    { "parent": -1, "page": 0, "guid": "1:10", "type": "FRAME", "name": "Screen",
      "props": { "relativeTransform": [1, 0, 0, 0, 1, 0], "width": 360, "height": 200, "fills": 0, "strokes": 5,
        "strokeWeight": 1, "strokeAlign": "INSIDE", "blendMode": "PASS_THROUGH", "clipsContent": true, "layoutMode": "NONE",
        "primaryAxisSizingMode": "FIXED", "counterAxisSizingMode": "FIXED" } },
    { "parent": 0, "guid": "1:11", "type": "INSTANCE", "name": "Button",
      "props": { "relativeTransform": [1, 0, 16, 0, 1, 16], "width": 120, "height": 40 },
      "instance": {
        "master": { "guid": "2:23", "library": { "publishFile": "SyntheticLibKey0000002", "publishID": "5:23",
          "componentKey": "c0ffee0000000000000000000000000000000002", "sharedSymbolVersion": "4" } },
        "properties": [{ "family": "2:20", "id": "Label#0:1", "value": "Buy" }],
        "overrides": [{ "path": ["2:24"], "at": [8], "fields": { "fills": 1 } }, { "path": [], "fields": { "opacity": 0.5 } }],
        "overrideBasis": "authored",
        "derived": [{ "path": ["2:24"], "at": [8], "size": [88, 20], "lines": 1 }]
      } },
    { "parent": 0, "guid": "1:12", "type": "RECTANGLE", "name": "Photo",
      "props": { "relativeTransform": [1, 0, 16, 0, 1, 72], "width": 100, "height": 80, "fills": 2, "strokes": 4,
        "strokeWeight": 2, "strokeWeights": [0, 0, 2, 0], "oracleSides": [false, false, true, false],
        "strokeAlign": "INSIDE", "blendMode": "PASS_THROUGH" } },
    { "parent": 0, "guid": "1:13", "type": "TEXT", "name": "Title",
      "props": { "relativeTransform": [1, 0, 132, 0, 1, 72], "width": 200, "height": 20, "characters": "Hello, world",
        "fontName": 3, "fontSize": 16, "fills": 4, "fillStyle": 0, "strokes": 5, "strokeWeight": 1, "strokeAlign": "OUTSIDE",
        "blendMode": "PASS_THROUGH", "textAutoResize": "WIDTH_AND_HEIGHT", "lines": 1,
        "textRanges": [{ "start": 0, "end": 5, "fields": { "fills": 1 } }] } },
    { "parent": -1, "page": 1, "guid": "2:20", "type": "COMPONENT_SET", "name": "Button",
      "props": { "relativeTransform": [1, 0, 0, 0, 1, 0], "width": 280, "height": 40, "fills": 5, "strokes": 5,
        "strokeWeight": 1, "strokeAlign": "INSIDE", "blendMode": "PASS_THROUGH", "clipsContent": false, "layoutMode": "NONE",
        "primaryAxisSizingMode": "FIXED", "counterAxisSizingMode": "FIXED" } },
    { "parent": 4, "guid": "2:21", "type": "COMPONENT", "name": "State=Default",
      "props": { "relativeTransform": [1, 0, 0, 0, 1, 0], "width": 120, "height": 40, "fills": 0, "strokes": 5,
        "strokeWeight": 1, "strokeAlign": "INSIDE", "blendMode": "PASS_THROUGH", "clipsContent": true, "layoutMode": "NONE",
        "primaryAxisSizingMode": "FIXED", "counterAxisSizingMode": "FIXED" } },
    { "parent": 5, "guid": "2:22", "type": "TEXT", "name": "Label", "overrideKey": "5:22",
      "props": { "relativeTransform": [1, 0, 16, 0, 1, 10], "width": 88, "height": 20, "characters": "Button",
        "fontName": 3, "fontSize": 14, "fills": 4, "strokes": 5, "strokeWeight": 1, "strokeAlign": "OUTSIDE",
        "blendMode": "PASS_THROUGH", "textAutoResize": "NONE", "componentPropertyReferences": { "characters": "Label#0:1" } } },
    { "parent": 4, "guid": "2:23", "type": "COMPONENT", "name": "State=Hover",
      "props": { "relativeTransform": [1, 0, 160, 0, 1, 0], "width": 120, "height": 40, "fills": 0, "strokes": 5,
        "strokeWeight": 1, "strokeAlign": "INSIDE", "blendMode": "PASS_THROUGH", "clipsContent": true, "layoutMode": "NONE",
        "primaryAxisSizingMode": "FIXED", "counterAxisSizingMode": "FIXED" } },
    { "parent": 7, "guid": "2:24", "type": "TEXT", "name": "Label", "overrideKey": "5:24",
      "props": { "relativeTransform": [1, 0, 16, 0, 1, 10], "width": 88, "height": 20, "characters": "Button",
        "fontName": 3, "fontSize": 14, "fills": 4, "strokes": 5, "strokeWeight": 1, "strokeAlign": "OUTSIDE",
        "blendMode": "PASS_THROUGH", "textAutoResize": "NONE", "componentPropertyReferences": { "characters": "Label#0:1" } } },
    { "parent": -1, "page": 1, "guid": "2:30", "type": "COMPONENT", "name": "Badge",
      "props": { "relativeTransform": [1, 0, 0, 0, 1, 100], "width": 24, "height": 24, "fills": 5, "strokes": 5,
        "strokeWeight": 1, "strokeAlign": "INSIDE", "blendMode": "PASS_THROUGH", "clipsContent": true, "layoutMode": "NONE",
        "primaryAxisSizingMode": "FIXED", "counterAxisSizingMode": "FIXED" } },
    { "parent": 9, "guid": "2:31", "type": "ELLIPSE", "name": "Dot",
      "props": { "relativeTransform": [1, 0, 8, 0, 1, 8], "width": 8, "height": 8, "fills": 1, "strokes": 5,
        "strokeWeight": 1, "strokeAlign": "INSIDE", "blendMode": "PASS_THROUGH",
        "componentPropertyReferences": { "visible": "Dot#0:2" } } },
    { "parent": 0, "guid": "1:14", "type": "VECTOR", "name": "Arrow",
      "props": { "relativeTransform": [1, 0, 320, 0, 1, 16], "width": 24, "height": 20, "fills": 1, "strokes": 5,
        "strokeWeight": 1, "strokeAlign": "CENTER", "blendMode": "PASS_THROUGH", "fillGeometry": 6 } }
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
    { "node": 9, "set": null, "properties": [{ "id": "Dot#0:2", "name": "Dot", "type": "BOOLEAN", "default": true },
        { "id": "Icon#0:3", "name": "Icon", "type": "INSTANCE_SWAP", "default": { "guid": "2:21" },
          "preferredValues": [{ "type": "COMPONENT", "componentKey": "c0ffee0000000000000000000000000000000002", "guid": "2:23" },
            { "type": "COMPONENT_SET", "componentKey": "c0ffee0000000000000000000000000000000003" }] }],
      "deleted": true, "ancestorPath": ["Old page", "Badges"] }
  ],
  "styles": [
    { "guid": "3:1", "type": "PAINT", "name": "Text/Primary", "styleKey": "synthetic-style-key-1", "value": 4,
      "signature": "fnv1a64:762b94984c0b7be5", "library": { "publishFile": "SyntheticLibKey0000002" } }
  ],
  "images": [{ "hash": "da7a000000000000000000000000000000000001", "present": false, "format": "png" }],
  "fonts": [{ "family": "Inter", "style": "Regular" }],
  "notes": [
    { "code": "STALE_ASSIGNMENT", "node": 1, "detail": "other-family: an assignment to a property of another family" },
    { "code": "OVERRIDE_STALE", "node": 1, "path": ["2:99"], "detail": "not-derived: path absent from derivedSymbolData" },
    { "code": "VECTOR_FROM_GEOMETRY", "node": 11, "detail": "a network with no region, built from its stored geometry" },
    { "code": "OVERRIDE_ECHO", "node": 1, "detail": "1 field: fills" },
    { "code": "OVERRIDE_FIELD_DROPPED", "node": 1, "detail": "no-equivalent: pluginData 1" }
  ]
}
```
