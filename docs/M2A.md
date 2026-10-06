# M2a: the component IR, offline

Status: **built and accepted offline (2026-10-06) on branch `claude/m2a`: P0, then parts A-D merged and integrated by
part E; every gate of §8 passes on D, K, M and P with the plan's numbers, and §14 records what was built where it differs
from this plan. A review of the build (§15) fixed six findings; the gates pass with the same numbers.** The plan is the second edition (2026-10-06): the first edition with a review folded in (§13 lists
each issue and what changed). It implements the M2a row of `docs/REWRITE.md` §10: "IR for
components, offline (needs no Figma): family validation, property roots, swap-aware guidPath resolver, stale and echo
classification". It follows REWRITE §3, §4, §7, §8 and §11, and builds on M1 as merged (`docs/M1.md`, §15.8-§15.11
for the live session). Like M1, it starts with a serial contract part (P0) that bumps the IR to version 3, then runs
four parts in parallel on disjoint files, then integrates. Nothing in M2a needs Figma or Pixso: every test runs on the
synthetic fixture, and every acceptance number is a count from the reader on local files.

**Evidence.** Every number is a count from read-only scripts run on four local `.pix` files: **D**, the test design
file (9 372 stored nodes); **K**, the test kit (86 578); **M**, a Сова-based product file (40 472); **P**, the owner's
Сова-based product file (89 686). Four numbers in a row are D / K / M / P. Two independent measurements were made for
this plan (2026-10-06): one re-ran the planning-era scripts behind REWRITE's M2a numbers on all four files and
re-implemented the resolver against `tools/pix/read.mjs`; the other probed the same fields with its own scripts. The
scripts and their outputs stay outside this public repository (REWRITE §8). Labels: **C** confirmed (measured), **I**
inferred, **A** assumed (needs a probe or a render).

## 0. The ground M2a stands on

### 0.1 What REWRITE asks, and what reproduces (C)

Every M2a number of REWRITE §3 and §10 reproduces exactly on D and K, once two definitions REWRITE leaves implicit are
stated (§0.2):

| REWRITE M2a criterion | D | K | reproduced |
|---|---|---|---|
| derived entries resolve | 35 808 / 35 808 | 160 980 / 160 982 | yes (planning-era resolver); K becomes 160 982 / 160 982 with rule B (D7) |
| non-root override entries that resolve, and are exactly those in `derivedSymbolData` | 6 353 of 7 079 | 42 456 of 43 406 | yes |
| the rest: in no derived entry, resolve nowhere | 726 | 950 | yes |
| families that parse | 64 / 67 | 308 / 312 | yes |
| stale assignments | 130 = 124 + 6 | 2 034 = 315 + 1 719 | yes (definition in §0.2) |

The planning-era notes and scripts that produced these numbers live only outside the repository. **The definitions in
§0.2 and the algorithm in D7 are therefore the record**: a reader of this file must be able to reproduce every number
from them alone.

### 0.2 Definitions that decide the numbers (C)

- **Root override entry**: an entry of an instance's `symbolData.symbolOverrides` whose guidPath is exactly
  `[the instance's own symbolID]`. It addresses the master's root, that is, the instance itself (D 1 849, K 20 530,
  M 15 053, P 35 095). An **empty** guidPath occurs only in D (257 entries) and is a root entry too.
- **Non-root entry**: every other entry. D 9 185 − 1 849 − 257 = 7 079; K 63 936 − 20 530 = 43 406; M 68 984 −
  15 053 = 53 931; P 148 848 − 35 095 = 113 753.
- **Live / stale**: a non-root entry is live when its path resolves (D7) **and** is in `derivedSymbolData`; stale when
  it is in neither. With rules A and B (D7) there is no third case on any of the four files.
- **Stale assignment** (REWRITE's 130 and 2 034): a `componentPropAssignment` **on an INSTANCE node** whose definition
  cannot be reached from the instance's family (its symbol, or that symbol's state group): either the definition id is
  in no definition in the file (`no-definition`: 124 / 315 / 96 / 321), or it exists only on other owners
  (`other-family`: 6 / 1 719 / 826 / 1 530). Totals 130 / 2 034 / 922 / 1 851. Assignments **inside override
  entries** are a separate population (D6) and are not in REWRITE's 130 and 2 034. **As built (B, E):** "reached from
  the instance's family" means defined on the instance's master SYMBOL or on that symbol's state group, not on any
  other member of the group; it is exactly this rule that gives 130 / 2 034 / 922 / 1 851. `no-root` and
  `undeclared` (D3) are counted apart and are not in these totals (0 / 0 / 0 / 0 and 0 / 4 / 16 / 20).
- **Path space**: guidPath elements are **local guids** of the stored copies, never `overrideKey`s. Every hop of every
  live entry matches by local guid; looking hops up by `overrideKey` makes 7 stale K overrides resolve, wrongly.

### 0.3 Where the two measurements disagree, and why

The second measurement did not reproduce REWRITE's denominators or stale-assignment counts. Each difference is a
definition, not a fact about the files; part C (or B) reconciles each in its pull request and E records the result here
(§14.6 gives the outcome of each row: every first-measurement number reproduces, with the definitions stated there).

| quantity | first (REWRITE's definitions) | second | cause |
|---|---|---|---|
| non-root entries not in derived | 726 / 950 / 949 / 6 563 | 2 575 / 21 480 / 16 002 / 41 658 | the second counted `[symbolID]` root entries as non-root (I: 2 575 − 726 ≈ 1 849, the root count) |
| stale assignments on instances | 130 / 2 034 / 922 / 1 851 | 131 / 2 068 / 923 / 1 797 (strict), 124 / 1 980 (loose) | the strict rule also counts an alias whose chain does not reach a root; the loose one omits `other-family` |
| stale assignments in live overrides | 4 / 75 / 839 / 293 | 4 / 4 / 839 / 293 | K differs; not explained (I) |
| refs whose field disagrees with the root's type | 0 / 0 / 0 / 94 (alias chains followed in full) | 0 / 102 / 128 / 224 | the second followed one hop (I) |
| refs naming no definition (fill-style refs apart) | 0 / 1 / 106 / 212 | dangling VISIBLE 0 / 0 / 112 / 224, other family 48 / 48 / 3 / 5 | different splits; reconcile into D4's classes |
| swaps to a variant of the same set | 28 / 309 / 714 / 2 117 (no-ops apart: 22 / 112 / 163 / 30) | 38 / 409 / 876 / 2 044 | no-op and unresolved swaps counted differently (I) |
| families accepted in P | 342 / 359 | 348 / 359 | the first also checked names against the stored vocabulary; 6 P sets list other axes there (D2) |
| member aliases in P | 54 597 | 54 727 | the second includes P's 130 state-group aliases |
| `overrideLevel` | unused in all four | in override entries of M and P (values 1-4) | the first looked at stored nodes only (I) |

### 0.4 What M1 left that M2a changes (C, from the code at 352e5ba)

- The reader writes `sets: []`, every SYMBOL as a standalone component with no properties, state groups as FRAME
  records (M1 D7), no `componentPropertyReferences`, and instance data `{master}` only (`tools/pix/ir/components.mjs`).
- The validator (`tools/ir/schema.mjs`) already checks sets, members, coordinates, property keys (family, id),
  assignments against the master's family, the first hop of each path, and one entry per path. It refuses a dangling
  master reference anywhere, INSTANCE_SWAP defaults and preferred values included. Override `fields` are open "until
  M2a". `KNOWN_PROPS.INSTANCE` is box and child layout only.
- The M1 planner writes no `instance` into tasks (`plan.mjs` `taskNode` copies type, name and props only); `BUILT_TYPE`
  has no COMPONENT_SET, so a task carrying one is refused. Both population codes recognise a state group only as a
  FRAME: `plan.mjs` `derivePopulations` by record type, and `populations.mjs` through `meta.stateGroup`, which
  `nodes.mjs` sets only when the record type is FRAME. M has one state group on a user page, D 5, K 83 (I: 67 − 62
  and 312 − 229 from M1 §1.3).
- The bundled builder branches on the **IR record type**, not on `BUILT_TYPE`: auto layout is written only for a
  record of type FRAME or COMPONENT (`figma-plugin/src/ir/build-create.js`, `modeOf` and the layout write), and the
  judge refuses a task record whose type is not the IR record's (`tools/ir/judge.mjs`). 19 / 75 / 57 / 58 state groups
  have auto layout (C, review). So a COMPONENT_SET record sent to M1's builder as such would lose its auto layout, and
  §5.2 maps the type in the task instead.
- The reader's `nodes.mjs` decides props by the record type too: frame layout only for FRAME and COMPONENT, side
  strokes and corners only for FRAME, COMPONENT and RECTANGLE. A record whose type becomes COMPONENT_SET must have its
  props computed as the FRAME it was planned as (§5.3).
- `TASK_IR_VERSION` must equal the schema's `VERSION` (`test-m1-contract.mjs`), and the stamp `pxIr` carries it.

## 1. Measurements made for this plan (C unless marked)

### 1.1 Families

A family is a variant set (a FRAME with `isStateGroup`, field 137) or a standalone component. Grammar: split the SYMBOL
name on `,`, each pair on the first `=`, trim around axis and value; a coordinate is the sorted axis=value pairs. The
stored vocabulary is `stateGroupPropertyValueOrders` (field 136: `{property, values[], aliasProperty, aliasValues}`;
the alias fields are unused in all four files).

| | D | K | M | P |
|---|---|---|---|---|
| state groups (all FRAME; no non-SYMBOL member; no SYMBOL inside a SYMBOL) | 67 | 312 | 227 | 359 |
| accepted, names grammar (D2 default) | 64 | 308 | 221 | 348 |
| rejected: duplicate coordinate / duplicate axis / axis count differs | 2 / 1 / 0 | 1 / 2 / 1 | 5 / 0 / 1 | 9 / 0 / 2 |
| members of rejected sets | 66 | 97 | 192 | 436 |
| accepted when names must also match the vocabulary | 64 | 308 | 221 | 342 |
| vocabulary axis order ≠ the first member's name order | 17 | 115 | 0 | 0 |
| vocabulary lists other axes than the names / member values missing from it | 0 / 0 (I) | 0 / 0 (I) | 0 / 0 (I) | 6 / 7 sets |
| sets with publishFile and publishID (and componentKey) | 62 | 180 | 226 | 347 |
| instances whose master is a member of an accepted set | 803 | 10 006 | 7 893 | 20 653 |
| state groups with auto layout (`stackMode` not NONE; C, review) | 19 | 75 | 57 | 58 |

Rejected sets are on the internal canvas in M and P, on both kinds of page in D and K. The per-class split above was
measured with the classes in another order and without `no-equals`; D2's order may move a set between classes but not
between accepted and rejected (I), so the gates hold the totals and A records the split under D2's order.

### 1.2 Property definitions, references and assignments

Field encodings (identical schema in all four files; ids differ from the fixture's on purpose, M1 §6 A):
`componentPropDef` = 189 `{id, name, initialValue {textValue, guidValue, boolValue}, sortPosition, parentPropDefId
(0:0 = root), type (BOOL 0, TEXT 1, COLOR 2, INSTANCE_SWAP 3), preferredValues {stringValues[], instanceSwapValues
[{type (COMPONENT 0, STATE_GROUP 1), key}]}, isDeleted, varValue, aliasName}`; `componentPropRef` = 190 `{defID,
zombieFallbackName, componentPropNodeField (VISIBLE 0, TEXT_DATA 1, OVERRIDDEN_SYMBOL_ID 2, INHERIT_FILL_STYLE_ID 3),
nodeField, isDeleted}`; `componentPropAssignment` = 191 `{defID, value, varValue}`. `initialValue` always carries all
three slots, so the value is read by type; a `guidValue` of 0:0 means none. `isDeleted`, `varValue` and `aliasName`
are unused in all four files.

| | D | K | M | P |
|---|---|---|---|---|
| member aliases (parentPropDefId ≠ 0:0) | 1 560 | 6 771 | 24 579 | 54 597 |
| … unnamed BOOL | 0 (all named, typed) | 6 771 | 16 283 | 6 509 |
| … whose type differs from the root's | 0 | 1 885 | 9 541 | 1 266 |
| same-id aliases (the fixture's model) | 266 | 309 | 712 | 1 130 |
| member-owned roots: a root definition (parent 0:0) on a SYMBOL inside a state group (C, review) | 120 | 120 | 6 | 24 |
| … whose id repeats on another member of the group, or equals a definition id on the group (C, review) | 0 | 0 | 0 | 0 |
| aliases on state groups: same set / another set / no definition | 0 (I) | 0 (I) | 0 (I) | 94 / 11 / 25 |
| root id in more than one family | 85 | 227 | 157 | 514 |
| COLOR definitions | 0 | 0 | 0 | 0 |
| refs: VISIBLE / TEXT_DATA / OVERRIDDEN_SYMBOL_ID | 394 / 238 / 250 | 2 426 / 708 / 463 | 7 994 / 1 858 / 4 524 | 17 644 / 2 057 / 8 621 |
| refs: INHERIT_FILL_STYLE_ID (every one names no definition in the file) | 1 101 | 5 232 | 17 370 | 34 903 |
| refs resolved through an alias id | 650 | 3 294 | 13 882 | 27 412 |
| refs whose field disagrees with the root's type, chains in full | 0 | 0 | 0 | 94 (BOOL root read as OVERRIDDEN_SYMBOL_ID on an INSTANCE; internal canvas) |
| INSTANCE_SWAP roots whose default names no SYMBOL in the file | 22 of 144 | 3 of 170 | 52 of 138 | 265 of 314 |
| swap assignment values naming no SYMBOL in the file | 36 | 4 | 137 | 264 |
| preferred values: keys / not in the file | 8 / 0 | 4 / 0 | 84 / 56 (6 STATE_GROUP) | 4 272 / 3 869 (5 STATE_GROUP) |
| assignments on instances / in override entries / made through an alias id | 1 175 / 101 / 537 | 10 164 / 799 / 7 959 | 2 478 / 5 049 / 5 478 | 17 522 / 8 282 / 19 597 |
| stale on instances: no-definition + other-family | 124 + 6 | 315 + 1 719 | 96 + 826 | 321 + 1 530 |
| stale in live override entries (against the target's effective family) | 4 | 75 (I, §0.3) | 839 | 293 |
| in stale override entries (dropped with their entry) | 0 | 6 | 41 | 1 128 |
| exposed nested instances (`propsAreBubbled`, 195) | 24 | 60 | 3 896 | 6 398 |

In P, 3 795 member aliases reach their root in two hops and 2 have a parent outside their family. Preferred values
name components by a 40-hex `componentKey` string with no `publishFile`, never by guid. Every `componentPropRef`
other than INHERIT_FILL_STYLE_ID sits inside a SYMBOL (882 / 3 597 / 14 376 / 28 322 of the same; none outside a
definition, C, review). An assignment value, like `initialValue`, carries all three slots, and its `textValue` is rich
text (characters plus a style table); no assignment or default in the four files has a non-empty style table (C,
review), and Figma's TEXT property takes a plain string.

### 1.3 Overrides, swaps and derived data

`symbolData` = 43 `{symbolID, symbolOverrides PixsoNode[], uniformScaleFactor}`; an override entry is a PixsoNode with
`guidPath` = 2 plus the overridden fields; `derivedSymbolData` = 75 is a PixsoNode list keyed by guidPath carrying
`transform`, `size`, `effects`, `fillGeometry`, `strokeGeometry`, `strokePaddingPath`, `vectorData`, `textData`
(glyphs) and a few corner, padding and min/max fields. Override entries never carry `symbolData` or derived data;
derived entries never carry `overriddenSymbolID`, `visible` or paints. Path lengths reach 5.

| | D | K | M | P |
|---|---|---|---|---|
| instances | 2 430 | 23 500 | 15 577 | 37 927 |
| … with no derived data (every one: a childless master) | 0 | 9 | 193 | 684 |
| override entries: root / empty path / non-root | 1 849 / 257 / 7 079 | 20 530 / 0 / 43 406 | 15 053 / 0 / 53 931 | 35 095 / 0 / 113 753 |
| non-root live / stale (rules A and B) | 6 353 / 726 | 42 456 / 950 | 52 982 / 949 | 107 190 / 6 563 |
| … with the planning-era resolver: in derived but not resolving | 0 | 0 | 4 | 1 |
| derived entries resolving, rules A and B | 35 808 / 35 808 | 160 982 / 160 982 | 86 941 / 86 941 | 342 643 / 342 679 |
| … planning-era resolver | 35 808 | 160 980 | 86 937 | 342 621 |
| … P's residual, resolved only by the derived-guided fallback (D7 rule C) | — | — | — | 36 entries in 18 instances |
| duplicate paths in one instance (with overlapping fields) | 49 (8) | 0 | 17 (6) | 3 503 (1 063) |
| conflicting field values among duplicates | 58 (fills, style) | 0 | 499 (449 `overrideLevel`) | 81 294 (`overrideLevel` 41 207, `inheritFillStyleID` 18 240, `fillPaints` 13 664, `visible` 3 050, `textData` 1 074, `size` 337) |
| swap entries (`overriddenSymbolID`, 88; only in override entries) | 327 | 2 577 | 1 334 | 2 781 |
| … to a variant of the same set / no-op to the same symbol / path unresolved | 28 / 22 / 24 | 309 / 112 / 135 | 714 / 163 / 0 | 2 117 / 30 / 5 |
| … target missing from the file | 0 | 0 | 0 | 0 |
| swaps the derived walk used: by override / by property | 2 269 / 300 | 8 269 / 831 | 13 476 / 1 018 | 27 287 / 9 501 |
| derived entries without a transform / without a size | 3 887 / 5 845 | 173 / 6 450 | 78 679 / 69 636 | 318 808 / 250 604 |
| derived entries with `textData` / with `strokePaddingPath` | 3 489 / 32 051 | 19 624 / 160 975 | 6 649 / 20 640 | 51 760 / 178 995 |
| instances with `uniformScaleFactor` ≠ 1 | 72 | 475 | 391 | 1 332 |
| instance size ≠ its master's | 912 | 12 797 | 5 839 | 13 523 |
| text overrides (all with characters) / with a style table | 308 / 1 | 5 629 / 15 | 2 236 / 5 | 7 672 / 281 |
| echo, raw-equality lower bound (I): live fields equal to the master layer's | 1 531 of 7 926 | 16 771 of 75 132 | 47 650 of 109 375 | 69 886 of 250 707 |

Root entries' fields in D: `inheritFillStyleID` 210, `fillPaints` 138, `vectorPaints` and `vectorStyles` 102 each,
strokes 17, `layoutGrids` 8, border weights 3. **Corrected (review, C):** root entries carrying `size` are D 1 425
(of 2 106), K 18 326, M 9 729, P 19 105, not 40; that is the instance's own size, which its record already carries
(D8). No root entry carries `overriddenSymbolID` or `componentPropAssignment` in any of the four files (C, review).

**Override field census (C, review: every key of every override entry, `guidPath` apart).** The first edition listed a
few; the four files hold these. Root and non-root entries together:
`arcData`, `autoCornerRadius`, `autoLayoutAbsolutePos`, `autoLayoutIncludeBorders`, `autoLayoutItemReverseDraw`, the
four `border*Weight` and `borderStrokeWeightsIndependent`, `componentPropAssignment`, `cornerRadius`, `cornerSmoothing`,
`dashCap`, `dashPattern`, `effects`, `exportImageQuality`, `exportKeepNameGroup`, `exportSettings`, `fillPaints`,
`fontName`, `fontSize`, the four `fontVariant*`, `fontVariations`, `fontVersion`, `frameMaskDisabled`, `hangingList`,
`hangingPunctuation`, `horizontalConstraint`, `verticalConstraint`, `hyperlink`, `inheritEffectStyleID`,
`inheritFillStyleID`, `inheritGridStyleID`, `inheritStrokeStyleID`, `inheritTextStyleID`, `layoutGrids`, `leadingTrim`,
`letterSpacing`, `lineHeight`, `locked`, `maxLines`, `maxSize`, `minSize`, `miterLimit`, `name`, `opacity`,
`overlayBackgroundAppearance`, `overlayBackgroundInteraction`, `overlayPositionType`, `overriddenSymbolID`,
`overrideLevel`, `paragraphIndent`, `paragraphSpacing`, `pluginData`, `proportionsConstrained`,
`prototypeInteractions`, the four `rectangle*CornerRadius`, `rectangleCornerRadiiIndependent`,
`rectangleCornerToolIndependent`, `size`, the `stack*` and `stackChild*` fields, `strokeAlign`, `strokeCap`,
`strokeJoin`, `strokePaints`, `strokeWeight`, `textAlignHorizontal`, `textAutoResize`, `textCase`, `textData`,
`textDecoration`, `textTruncation`, `toggledOffOTFeatures`, `toggledOnOTFeatures`, `variableConsumptionMap`,
`variableModeBySetMap`, `vectorPaints`, `vectorStyles`, `visible`. P also: `variableConsumptionMap` 5 293,
`overrideLevel` 5 186, `fontVariations` 4 482, `pluginData` 3 894 and `stackChildCounterSizing` 61 651. D8's
translation table (§5.1) is built from this list, and a field outside it is never silently ignored. **P0 (C):** the
list is 98 fields on D, K, M and P together (the `stack*` fields are `stackCounterAlignContent`,
`stackCounterAlignItems`, `stackCounterSizing`, `stackCounterSpacing`, the four `stackPadding*`,
`stackPrimaryAlignItems`, `stackPrimarySizing`, `stackSpacing`; the `fontVariant*` ones `fontVariantNumericFigure`,
`fontVariantNumericFraction`, `fontVariantNumericSpacing`, `fontVariantPosition`). The Сова UI kit (U, 181 344 entries)
adds four: `exportNameByVariantProp`, `groupIncludeInvisible`, `showInSlice`, `textAlignVertical`;
`OVERRIDE_SOURCE_FIELDS` gives them fates too, so U does not fail G6 with `unknown`. Derived paths are unique per
instance in all five files (0 duplicates), so the IR keeps one derived entry per path.

**Overrides on nested instances (C, review).** Non-root entries whose path is in `derivedSymbolData` and whose last
element is a nested INSTANCE: 640 / 4 074 / 20 618 / 43 761; of them, carrying a look field (paints, a fill, stroke or
effect style, effects, opacity, corner radius, stroke weight): 135 / 398 / 779 / 7 899. An INSTANCE record's
`KNOWN_PROPS` are box and child layout only (M1), so these fields are checked against the look of the nested
instance's master instead (§5.1).

An instance's own stored props differ from its master root's (raw counts, I):
`fillPaints` 17 / 765 / 183 / 553, `strokePaints` 0 / 488 / 311 / 688, `inheritFillStyleID` 937 / 3 333 / 6 082 / 7 216.

### 1.4 Library identity (unchanged from REWRITE §3, re-measured)

`publishFile` = 129, `publishID` = 130, `componentKey` = 77, `sharedSymbolVersion` = 133 (on every SYMBOL),
`overrideKey` = 89, `ancestorPathBeforeDeletion` = 134. Keyed internal-canvas SYMBOLs 1 083 / 1 083, 5 851 / 6 545
(694 keyless: the soft-deleted own masters), 6 574 / 6 575, 10 722 / 10 733; on every keyed one `overrideKey` =
`publishID`. Own SYMBOLs never carry `publishFile`, `publishID` or `componentKey`, and no INSTANCE carries a
`componentKey`. Distinct `publishFile` values 14 / 43 / 10 / 20. `overrideKey` occurs only on the internal canvas in D,
K and M; P has 802 on user-page nodes (457 free INSTANCEs, 243 FRAMEs, 1 own SYMBOL), which M3 must read. Unused in all
four: `componentOverrideHierarchy` (197), `variableSymbolID` (226), `simplifyInstancePanels` (242),
`derivedSymbolDataLayoutVersion` (76).

## 2. Decisions

| # | decision | why |
|---|---|---|
| D1 | **The definitions of §0.2 are normative.** The reader, the stats and the acceptance count with them; the IR's notes and `stats.m2a` use their names (root, live, stale, `no-definition`, `other-family`, nested). | §0.3: every disagreement was a definition |
| D2 | **Families.** The coordinate lives in the member names (REWRITE §3), so the names decide acceptance (`--variant-grammar names`); the vocabulary only orders. Axis order: the vocabulary's when it lists exactly the names' axes, else the first member's name order. Value order per axis: the vocabulary's, then values it lacks in member order (counted, `stats.m2a.families.valuesAppended`). Rejection classes, in this order, the first that applies: `no-equals` (a pair with no `=`), `duplicate-axis` (one name repeats an axis), `axis-count` (members name different axis sets), `duplicate-coordinate`, `vocabulary` (only under `--variant-grammar vocabulary`: the vocabulary lists another axis set than the names; a value the vocabulary lacks is appended, never a rejection), `empty` (no SYMBOL member carried), `not-symbol` (a member that is not a SYMBOL; 0 measured). An accepted group becomes a **COMPONENT_SET record** with a `sets` entry, its props computed exactly as for the FRAME it was planned as (§5.3); a rejected one stays a FRAME whose members are standalone components, with one VARIANT_SET_REJECTED note on its record (`node`, IR.md §13: `guid` is for nodes with no record) whose detail starts with the class. `--variant-sets frames` keeps M1's D7 (no sets, no notes), for comparison with M1 runs | names are what Figma reads too; P's 6 vocabulary disagreements would otherwise reject sound sets |
| D3 | **Property roots.** A definition index maps every definition id to its root by following `parentPropDefId` to 0:0, any number of hops, inside one **definition scope**: a state group with its member SYMBOLs, or a SYMBOL outside any state group. The scope does not depend on whether A accepts the set, so B and C resolve the same ids whatever A decides; A's `familyOf` (§5.3) then names the IR family. A family declares its **roots only**: on the set for an accepted set, on the SYMBOL for a standalone component, and, for a member of a rejected set, the set's roots copied onto the member's own family (same ids, keyed by the member; `--rejected-props copy`, or `none`: no copies, and the member's references and assignments to them drop as `undeclared`). **Member-owned roots** (a root on a member SYMBOL: 120 / 120 / 6 / 24; their ids collide with nothing, §1.2) are declared on the set for an accepted set (counted `stats.m2a.properties.liftedMemberRoots`) and stay on the member for a rejected one. Type, name and default come only from the root (BOOL → BOOLEAN, TEXT → TEXT, INSTANCE_SWAP → INSTANCE_SWAP; a COLOR root is not declared and is noted SOURCE_FEATURE_UNSUPPORTED "COLOR property", 0 measured). Definitions are written in `sortPosition` order, then by id. An alias whose chain leaves its scope or ends in no definition (P: 2 member aliases, 11 + 25 set aliases) makes every reference and assignment through it unresolved (`no-root`, D4, D6). A root that exists but is not declared (a COLOR root; an INSTANCE_SWAP root with no resolvable default, D5; a rejected-set root under `--rejected-props none`) makes references and assignments to it drop as `undeclared`. A root with an empty name is declared with its name as stored and counted (`stats.m2a.properties.unnamedRoots`; Figma needs a name, M2b decides). B also counts `declaredNotRoot` (a declared id that is not a root of its scope; must be 0, G5) | REWRITE §3; validator: no member declares properties |
| D4 | **Bindings** (`componentPropRef` → `componentPropertyReferences`, IR.md §7). VISIBLE → `visible`, TEXT_DATA → `characters`, OVERRIDDEN_SYMBOL_ID → `mainComponent`, each to the **root id** of a definition of the enclosing definition's family. Dropped, with one PROPERTY_REF_DROPPED note per record and class (detail: class, then the count): `fill-style` (INHERIT_FILL_STYLE_ID: Figma has no such property, and every one names no definition: 1 101 / 5 232 / 17 370 / 34 903), `outside-definition` (the layer is in no COMPONENT record: 0 measured, but the validator would refuse it), `no-definition`, `other-family` (the id is defined only outside the layer's definition scope), `no-root` (D3), `undeclared` (D3), `type-mismatch` (the field's type is not the root's: 0 / 0 / 0 / 94). The first class that applies, in this order. Never matched by name | acceptance "no property … with a type other than its root definition's" fails on P without a code |
| D5 | **INSTANCE_SWAP values.** Two predicates, both in `propindex.mjs` (P0) so that the resolver, B and C cannot disagree: `symbolKnown(guid)` (a SYMBOL is stored in the file: what rule A and the resolver follow) and `refOf(guid)` (the master reference the IR can write: a COMPONENT record, else a library identity, else null; M1's `masterRef`). In the IR: an assignment whose value names no SYMBOL in the file is dropped with SWAP_VALUE_DANGLING `assignment` (36 / 4 / 137 / 264); one that names a SYMBOL the IR cannot reference (stored, but no record and no library identity, e.g. out of scope or not carried) is dropped with the same code and class, detail `: not carried` (0 expected, I). The same holds for a default (`default`) and for an override's `overriddenSymbolID` (`swap`: the swap is dropped, its entry's other fields stay). **Defaults** (`--swap-default layer`): a root's default is the declared symbol of the INSTANCE layers bound to it, where they all agree; otherwise the definition's `initialValue` when it names a SYMBOL; otherwise the property is not declared and its bindings drop (PROPERTY_REF_DROPPED `undeclared`), noted SWAP_VALUE_DANGLING `default`. A default taken from the layers that differs from `initialValue` is counted (`stats.m2a.properties.swapDefaultFromLayer`), and so are roots whose bound layers disagree (`swapDefaultLayersDisagree`, with the number of bound layers whose declared symbol is not the default: Figma's default replaces them in the main component, so each is a visible change M2b's render pair must judge). `--swap-default definition` uses `initialValue` first. **Preferred values** become key references `{type: COMPONENT\|COMPONENT_SET, componentKey, guid?}` (Figma's own shape): `guid` is filled when the key names a library copy (or, for STATE_GROUP, a set) in the file; keys not in the file are kept by key for M3's kit map, never refused. `stringValues` (preferred values of a TEXT property) have no Figma equivalent: dropped and counted (`preferred.stringValuesDropped`) | measured: using `initialValue` when nothing is assigned breaks 4 336 D and 263 K derived entries, because the bound layer's declared symbol already holds the default; Figma requires a resolvable default |
| D6 | **Assignments.** An instance's `properties` hold assignments to its master's family by root id, the value read from the slot of the **root's** type (BOOLEAN `boolValue`, TEXT `textValue.characters`, INSTANCE_SWAP `guidValue`; a TEXT value with a non-empty style table, 0 measured, keeps its characters and is counted `assignments.richTextFlattened`). Every assignment of a carried INSTANCE record, or of one of its override entries, ends in exactly one class, the first that applies: **dropped with its entry** (the entry is stale: OVERRIDE_STALE's detail counts them, 0 / 6 / 41 / 1 128); STALE_ASSIGNMENT `no-definition`, `other-family`, `no-root`, `undeclared` (on an instance), or `nested` with that class after `: ` (in a live entry, judged against the **effective** family of the nested instance the entry targets, after swaps, D7: 4 / 75 (I) / 839 / 293); STALE_ASSIGNMENT `ignored` (rule C, D7); SWAP_VALUE_DANGLING `assignment` (D5); **merged away** (a duplicate path's earlier or later value lost to D17, counted in OVERRIDE_PATHS_MERGED); **kept**. Never matched by name; one STALE_ASSIGNMENT note per assignment. An assignment equal to the root's default is kept (`--default-assignments keep`; writing it is harmless, P9b) or dropped and counted (`drop`) | REWRITE §3; validator refuses cross-family assignments; G7 needs one class per assignment |
| D7 | **The resolver** (below this table). Local guids only; outer swaps win; rules A, B and C | §1.3: exact on all four with A and B, and on P's derived entries with C |
| D8 | **Overrides.** Root entries (D 2 106, K 20 530, M 15 053, P 35 095; an instance with both an empty-path and a `[symbolID]` entry merges them by D17) become at most one override with `path` [] per instance: the look of the instance itself. A root entry's **box, child-layout, `name`, `visible` and `locked` fields** (`size`, `transform`, constraints, `minSize`/`maxSize`, `stackChild*`, `autoLayoutAbsolutePos`) are the INSTANCE record's own, which it already carries from the stored node: equal to the record, they are echoes (D9); different, the record wins and OVERRIDE_FIELD_DROPPED `root-box` counts them. They never enter the `path` [] override, where `width`/`height` would be counted OVERRIDE_FIELD_UNSUPPORTED on tens of thousands of instances whose size Figma sets directly (root `size`: D 1 425, K 18 326, M 9 729, P 19 105). A root entry's `componentPropAssignment` joins `instance.properties` (the entry's value wins over the node's), and its `overriddenSymbolID`, equal to `symbolID`, is a no-op dropped and counted, else SWAP_VALUE_DANGLING `swap` with detail `: root swap` (both 0 measured). Non-root entries are kept only when live; stale ones get OVERRIDE_STALE (class `not-derived`, or `unresolved` for a path in derived that does not resolve, 0 with A and B); C also counts stale entries whose path does resolve (`resolvedNotDerived`, 0 with A and B), which G2 needs. Duplicate paths merge into one entry (`--override-merge`, D17), noted OVERRIDE_PATHS_MERGED once per instance with the conflicting field count. **Translation is closed on both sides.** `OVERRIDE_SOURCE_FIELDS` (`overrides.mjs`, frozen by P0 from §1.3's census, C completes the translators) gives every Pixso field one fate: translated by the M1 translator that reads it on a node (paints, strokes and side weights, corners, effects, opacity and blend, `visible`, `locked`, `name`, `textData` → `characters` plus `textRanges`, the text style fields, `size` → `width`/`height`, transform → `relativeTransform`, `stack*` → frame layout, `stackChild*`, constraints, `minSize`/`maxSize`, `autoLayoutAbsolutePos` → child layout, `frameMaskDisabled` → `clipsContent`, `exportSettings`, the `inherit*StyleID` fields → style references); **consumed** (`guidPath`, `overrideLevel` by the merge, `overriddenSymbolID` → `swap`, `componentPropAssignment` → `properties`, the `*Independent` flags by the side and corner translators); or **dropped** with OVERRIDE_FIELD_DROPPED class `no-equivalent` and the field (`vectorPaints` and `vectorStyles` (region fills cannot be overridden on a sublayer, I), `variableConsumptionMap` and `variableModeBySetMap` (M5), `fontVariations`, `fontVersion`, the `fontVariant*` and OT-feature fields, `layoutGrids` (M1 carries none), `pluginData`, `prototypeInteractions`, the `overlay*` fields, `export*` options, `proportionsConstrained`, `dashCap`). A Pixso field outside the table is dropped with class `unknown` and **fails G6**: a new file cannot lose a field silently. The Figma fields produced are closed to `OVERRIDE_FIELDS` and to the target (§5.1); a field the target type does not take is dropped with class `not-on-type` (a fill on a GROUP, characters on a non-TEXT). A style reference resolves as on nodes (IR.md §7: the style's value wins, STYLE_VALUE_DIFFERS / STYLE_MISSING_IN_SOURCE with the note's `path`). Fonts and images an override uses join the IR's `fonts` and `images` through the same `cx`. An entry left with nothing to apply is dropped (`stats.m2a.overrides.emptyAfterTranslation`). *Review (§15):* a translated field whose only effect is to remove a prop the target has (a style detached or naming none, `maxLines` cleared, per-side weights made uniform) has no field value to write: uniform sides and corners are written through `strokeWeight` and `cornerRadius`, a style or `maxLines` removal is carried by a written `fills`, `strokes`, `effects`, text field or `textTruncation`, and any other is dropped `no-equivalent`, never counted translated with nothing written | REWRITE §3; IR.md §9 "one entry per path"; P13; §1.3's census |
| D9 | **Echo** (`--echo drop`). A field of a live entry is an echo when its translated value equals, as canonical JSON with IR rounding, the value the target layer has without this entry: the layer's record value (with DEFAULTS for an absent prop), changed by the overrides of the masters' own nested instances along the path (unless a swap reset them, rule B; *review, §15:* their duplicate entries merged by D17, as the IR writes them). For a field **bound to a property** (`characters`, `visible` on a layer whose `componentPropertyReferences` names a declared root; `swap` never, below) the baseline is the property's effective value at that layer (an outer entry's assignment, else the owning instance's, else the root's default; *review, §15:* only an assignment the IR keeps, its id defined on the owning symbol or its state group, §0.2), not the layer's record value; a field override whose value differs from that effective value is counted (`overrides.boundConflicts`), because M2b writes properties before field deltas and the order decides what Figma shows. A **swap** is never an echo: a no-op swap to the declared symbol still resets the nested instance's own overrides (rule B), so it is kept and counted (`swaps.noOp`). For a root entry, the box fields compare with the INSTANCE record (D8). Echo fields are dropped, one OVERRIDE_ECHO note per instance (detail: count and field names; per field counts in stats). `--echo keep` keeps them and counts the same | P9b: an equal write creates no override, so dropping is safe, and it saves writes |
| D10 | **Derived entries** are carried as stored, sparse: `size` and `transform` only when stored (absent means "the master layer's", I, part C measures it, §6 C), `lines` from baselines where the entry stores them, `oracleSides` from `strokePaddingPath` (M1 D15's oracle, inside instances), and geometry under `--derived-geometry changed`: `fillGeometry` and `strokeGeometry` only where they differ from the target layer's own stored geometry. Each entry and each override carries `at`: the IR record index of every path element, so neither the planner nor the plugin needs a resolver. An element with no record (a folded operand, a degenerate node) gives no `at`: a derived entry is then kept without it and counted; an override field on it is dropped with OVERRIDE_FIELD_DROPPED `layer-not-carried`. A derived entry left with no key to write (sparse, and its geometry unchanged) is not written and is counted `derived.empty`; G1 counts resolution from the stats, so `entries = written + empty` | M2b's verifier compares every sublayer; the 2 975 lost borders inside instances need the oracle; P's IR size (§11) |
| D11 | **Instance extras.** `exposed: true` for `propsAreBubbled` (Figma's `isExposedInstance`); `scale` for `uniformScaleFactor` ≠ 1 (P10 decides how M2b uses it). The instance's own stored look is **not** carried beside its root override (`--instance-own overrides`): the record keeps box and child layout (KNOWN_PROPS.INSTANCE unchanged), the look is master root plus the `path` [] override, and own props that differ from that are counted (`stats.m2a.instances.ownDiffers`, I). `--instance-own own` writes those differences into the `path` [] override instead | Pixso's node paints are a cache (M1 §15.9 for styles); which one Pixso draws is a render-pair question for M2b |
| D12 | **Scope.** Under `--scope pages:`, the closure that pulls in each instance's master (M1) also pulls in swap targets, INSTANCE_SWAP values and defaults, and the masters of nested instances along live paths | no dangling reference in a scoped IR |
| D13 | **The M1 path keeps working on IR v3.** *As built (E): the M1 planner also leaves M2a's notes about components, properties and overrides (`schema.isComponentNote`) and the `componentPropertyReferences` bindings out of tasks, so the tasks of a `parse` IR equal those of a `frames` IR byte for byte, not only record for record; the identity sample ignores those notes too.* The planner writes a COMPONENT_SET record into tasks **as type FRAME** (`taskType()` in `task.mjs`: COMPONENT_SET → FRAME until M2b, every other type as is), and the judge compares a task record's type with `taskType()` of the IR record's. `BUILT_TYPE` is unchanged, so a task that carries a COMPONENT_SET is still refused. Mapping `BUILT_TYPE.COMPONENT_SET` to FRAME instead would not do: the bundled builder writes auto layout only for records of IR type FRAME or COMPONENT, and 19 / 75 / 57 / 58 state groups have auto layout (§0.4). Both population codes treat a COMPONENT_SET like the state-group frame; tasks carry no `instance`. Proof: the tasks made from the fixture's v3 IR equal, record for record, those made from its `--variant-sets frames` IR. M2b drops the mapping and adds `BUILT_TYPE.COMPONENT_SET` | M1's gates must still pass, with the same build; M2b builds components |
| D14 | **Library identity is unchanged** (IR.md §8). P's 802 user-page `overrideKey`s are carried on their records as today; their meaning is M3's | REWRITE §5 |
| D15 | **Note volume.** A note is per record, per path or per assignment as stated above, except OVERRIDE_ECHO (per instance), PROPERTY_REF_DROPPED (per record and class) and OVERRIDE_FIELD_DROPPED (per instance and class, the fields and counts in the detail), whose counts sit in the detail and in `stats.m2a` | P alone would add about 70 000 echo notes, and its dropped fields (`pluginData`, `variableConsumptionMap`, `fontVariations`) about 13 000 more |
| D16 | **IR version 3**, one bump for all of M2a, in P0; the validator knows only 3. Existing v2 run folders are not migrated (§11) | IR.md §15 |
| D17 | *Default set by E: `outer` (§14.4).* **Duplicate merge** (`--override-merge last` in the first plan): entries of one path merge in stored order, a later field value winning. `first` keeps the earliest; `outer` lets the lowest `overrideLevel` win, then the latest. Part C measures which rule agrees with `derivedSymbolData` on P's `size` (337) and `textData` (1 074) conflicts, the only conflicting fields derived can check, and E sets the default from that count before acceptance | 81 294 conflicting field values in P, unverified (I) |

**D7: the resolver** (`tools/pix/ir/resolve.mjs`). Input: an instance node and a guidPath. Start at the instance's
`symbolData.symbolID`. A root entry (path `[symbolID]`, or empty) addresses the instance itself and resolves. Otherwise
each element is looked up **by local guid** among the stored descendants of the current symbol (a symbol-guid prefix at
an instance boundary is tolerated; never measured). Every element but the last must be a nested INSTANCE, whose
**effective symbol** is decided in this order:

1. an `overriddenSymbolID` on an entry of **any** instance of the chain (instances inside masters count) whose path,
   relative to that instance, equals this node's path; the **outermost** wins (*review, §15:* within one instance, the
   entry the D17 merge keeps, so the walk and the swap the IR writes agree);
2. for each `componentPropRef` on the node with field OVERRIDDEN_SYMBOL_ID and a `defID` other than 0:0, an assignment
   to the same definition, matched by raw id or by alias root (D3); the pools, in order: the outer override entries
   addressed to the owning instance, innermost layer first, then the owning instance's own `componentPropAssignment`.
   **Rule A** (`--swap-dangling skip`): a value that names no SYMBOL in the file is skipped and the next pool is used;
3. the node's declared `symbolData.symbolID`.

**Rule B** (`--swap-reset on`): a nested instance that is swapped, by `overriddenSymbolID` or by a swap property, even a
no-op swap to its own declared symbol, loses its own authored `symbolOverrides` and `componentPropAssignment`. Inferred
from K's 2 derived entries (a no-op outer swap followed by an inner swap Pixso ignored) and P's 1 override; it changes
nothing in D or M (I until a Pixso render or probe).

**Rule C** (`--swap-fallback derived`): when the walk fails at an element and the whole path **is in**
`derivedSymbolData`, retry with the declared symbol at the failing hop. It resolves P's 36 entries (18 instances: 13 on
user pages, 5 internal), each a swap property assigned from an inner layer's override entry that Pixso ignored; no
structural rule separates them from 64 accepted cases of the same shape. Each such instance gets one
SWAP_ASSIGNMENT_IGNORED note with the count, and the ignored assignment itself is **dropped from the IR**
(STALE_ASSIGNMENT `ignored`): kept, it would make M2b swap a layer Pixso did not swap, under paths and `at` indices
resolved for the declared symbol. *Review (§15):* in P all 36 ignore one of two assignments that sit on entries of one
instance inside a master, where Pixso applied them, so they stay in the IR there and `ignored` is 0; each of the 18
instances whose derived data shows the declared symbol pins its hops with swap overrides to it instead
(`overrides.swaps.pinned`; the note says so). A swap rule 2 takes from an assignment the IR drops (§0.2's "reached"
reads only the master and its state group, rule 2 the whole definition scope) is pinned the same way where no kept
assignment gives that symbol. Applied without the derived guard it would make 1 stale override resolve in D and 1 in
K, so it is never applied to a path absent from derived.

**Rules a reader must not adopt** (each measured to break entries): taking an INSTANCE_SWAP definition's `initialValue`
when nothing is assigned (4 336 D and 263 K derived entries break); looking elements up by `overrideKey` (7 stale K
overrides resolve); letting inner swaps win over outer ones (entries lost in D, K and P).

The resolver returns, per path, the stored node and IR record index of each element, the effective symbol of each
intermediate instance, how it was decided (`override`, `property`, `declared`, `fallback`), and the swap resets applied.
It memoises a local-guid map per symbol, so each symbol's subtree is indexed once.

## 3. Settings

Owner decision: every policy is a setting with a stated default (REWRITE §11). The reader settings join `SETTINGS`,
`SETTING_FLAGS` and `SETTING_DEFAULTS` in the schema and the IR header (all keys required), and `pix-to-ir` and
`pix-run` take each flag. M1's settings are unchanged.

| setting | flag | values | default | decision | reproduces |
|---|---|---|---|---|---|
| variant sets | `--variant-sets` | `parse`, `frames` | `parse` | D2, D13 | `frames`: M1's D7 |
| variant grammar | `--variant-grammar` | `names`, `vocabulary` | `names` | D2 | `vocabulary`: P 342 / 359 |
| axis order | `--axis-order` | `vocabulary`, `names` | `vocabulary` | D2 | `names`: the first member's order |
| dangling swap values | `--swap-dangling` | `skip`, `strict` | `skip` | D5, D7 rule A | `strict`: the planning-era resolver (M 86 937, P 342 621) |
| swap reset | `--swap-reset` | `on`, `off` | `on` | D7 rule B | `off`: K 160 980 / 160 982 |
| derived-guided fallback | `--swap-fallback` | `derived`, `off` | `derived` | D7 rule C | `off`: P's 36 unclassified |
| INSTANCE_SWAP default | `--swap-default` | `layer`, `definition` | `layer` | D5 | |
| rejected-set properties | `--rejected-props` | `copy`, `none` | `copy` | D3 | `none`: rejected members declare nothing |
| assignments equal to the default | `--default-assignments` | `keep`, `drop` | `keep` | D6 | |
| duplicate paths | `--override-merge` | `last`, `first`, `outer` | `outer`, from part C's measurement (D17, §14.4) | D8, D17 | |
| echo fields | `--echo` | `drop`, `keep` | `drop` | D9 | |
| the instance's own look | `--instance-own` | `overrides`, `own` | `overrides` | D11 | |
| derived geometry | `--derived-geometry` | `changed`, `all`, `none` | `changed` | D10 | |

Not settings, because a measurement rules the alternative out: guidPaths in local guids (never `overrideKey`), outer
swaps winning over inner ones, definitions keyed by (family, id) and never by name, type and default from the root.

The header keys (P0, `schema.M2A_SETTINGS`, in this table's order) are the flags in camel case: `variantSets`,
`variantGrammar`, `axisOrder`, `swapDangling`, `swapReset`, `swapFallback`, `swapDefault`, `rejectedProps`,
`defaultAssignments`, `overrideMerge`, `echo`, `instanceOwn`, `derivedGeometry`. The reader takes each under the same
name (`readerSettings`); `pix-to-ir` and `pix-run` flags are part D's.

## 4. Data flow

```
.pix ─readPix─▶ pixToIR
                 plan (M1) ── families (A): which state groups are sets; familyOf(symbol); record type COMPONENT_SET
                          ── propIndex (P0): definition scopes, alias chains, roots; symbolKnown, refOf
                          ── properties (B): family roots, bindings, defaults, preferred keys, assignments, stale
                          ── resolve (C): effective symbols, paths, derived index (rules A, B, C)
                 emit (M1 + hooks): records, props (a set's as its FRAME's), bindings, sets, components
                 instance pass (C), once every record has its index:
                          ── overrides + derived: root override, live entries, merge, translate, echo, at[]
                 ─validate (IR v3)─▶ IR + stats.m2a
pix-run --dry --no-pixso (D): M1 plan on IR v3 (a COMPONENT_SET written into tasks as FRAME), the M1 balance, the M2a block
m2a-accept (D): the gates of §8 from the run folder(s)
```

The instance pass runs after `emit` because `at` needs the record index of master layers, which usually sit on the
internal canvas and are emitted after the user pages, and the echo baseline needs those records' translated props.

## 5. Contracts (part P0, merged before any parallel work)

### 5.1 IR version 3 (`tools/ir/schema.mjs`, `tools/ir/props.mjs`, `tools/ir/validate.mjs`, `tools/test-ir.mjs`, `docs/IR.md`)

- `VERSION = 3`; IR.md title, §4, §15 and the example (`"version": 3`, the new header settings, a COMPONENT_SET with an
  axis, a member alias mapped to its root, an override with `at`, a root override `path` [], a sparse derived entry, a
  preferred key reference).
- **Header settings** gain the thirteen keys of §3, each enum checked, `SETTING_DEFAULTS` holding the defaults.
- **Overrides** (`instance.overrides[]`): `{path, at?, fields?, swap?, properties?}`.
  - `path` [] is the instance itself, at most one per instance, and takes no `swap` (an instance's master is its
    `master`) and no `properties` (those are `instance.properties`); its `fields` are the **look** of the instance:
    `KNOWN_PROPS.COMPONENT` less the props `KNOWN_PROPS.INSTANCE` lists (the box, child layout, `visible`, `locked`,
    which the record itself carries; D8).
  - `at`: the IR record index of each path element, same length as `path`; required when the instance's master is a
    record in this IR and every element has a record (D10). Checked: `nodes[at[k]].guid === path[k]`; `at[0]` inside
    the master; every `at[k]` but the last is an INSTANCE record; every `at[k+1]` lies inside a COMPONENT record.
  - `fields` are **closed** to `OVERRIDE_FIELDS` (new in `props.mjs`: field → kind, the kinds of `KNOWN_PROPS`, plus
    `name: str`), and, where `at` is given, to the target's props plus `name`: the target record type's `KNOWN_PROPS`,
    except that an **INSTANCE target** takes `KNOWN_PROPS.COMPONENT` (its look is its master root's, and M1's
    `KNOWN_PROPS.INSTANCE` is a placeholder's box; 135 / 398 / 779 / 7 899 live entries on nested instances carry a
    look field, §1.3). Text fields include `textRanges` (own, checked as on a record against the override's own
    `characters` or the target's).
  - `properties` (on a non-root entry): every assignment names a family in this IR (as on an instance), and, when the
    entry has a `swap` to a local master, that master's family.
  - `OVERRIDE_FIELD_CLASS` (new, `props.mjs`): each field's P13 class, which the planner and M2b read:
    `applies` (fills, fillStyle, strokes, strokeStyle, strokeWeight, strokeWeights, strokeAlign, effects, effectStyle,
    opacity, blendMode, name, cornerRadius, cornerRadii, visible, characters, fontSize, textAutoResize; C, P13),
    `unprobed` (textRanges, fontName, letterSpacing, lineHeight, textStyle, the text alignments, the frame layout and
    child layout props, clipsContent, dashPattern, strokeJoin, strokeCap; A until M2b's P13b), `refused` (width,
    height, relativeTransform, constraints; C, P13: kept, counted OVERRIDE_FIELD_UNSUPPORTED by the planner). Every
    field of `OVERRIDE_FIELDS` has exactly one class (`test-ir` checks it), so a field C adds lands in `unprobed` until
    a probe says otherwise. `OVERRIDE_FIELDS` and `OVERRIDE_FIELD_CLASS` follow `props.mjs`'s bundling rules (data
    only, ES2015, `export const` at the start of a line), because the plugin bundles that file.
  - "One entry per path" stays; the reader merges (D17).
- **`OVERRIDE_SOURCE_FIELDS`** (`tools/pix/ir/overrides.mjs`, frozen by P0, C fills in the translators): every Pixso
  field of §1.3's census with its fate, `translate` (and the M1 translator), `consume`, or `drop` (and why); a test
  asserts that the census and the table list the same fields.
- **Derived entries**: `{path, at?, size?, transform?, fillGeometry?, strokeGeometry?, lines?, oracleSides?}`, with at
  least one key besides `path` and `at`; `path` may not be []; `at` as above.
- **Instance data** gains `exposed` (true only; the reader writes it on an INSTANCE record inside a COMPONENT and
  counts any other `propsAreBubbled` in `stats.m2a.instances`) and `scale` (a finite number > 0, ≠ 1).
- **Property definitions**: `preferredValues` becomes `[{type: "COMPONENT"|"COMPONENT_SET", componentKey, guid?}]`;
  `componentKey` is 40 lowercase hex; `guid`, when present, names a COMPONENT or COMPONENT_SET record of that type. An
  INSTANCE_SWAP default and every INSTANCE_SWAP value must still resolve (D5 guarantees it).
- **Reason codes**, each with a REASON_CODES entry, an IR.md §13 row and a `from` sentence, and **detail classes** as
  frozen lists, checked like `ORACLE_CLASSES` (a note of the code has a detail that starts with a listed class,
  optionally followed by `: ` and text):

  | code | stage | meaning | classes |
  |---|---|---|---|
  | VARIANT_SET_REJECTED | read | (existing) | `no-equals`, `duplicate-axis`, `axis-count`, `duplicate-coordinate`, `vocabulary`, `empty`, `not-symbol` |
  | STALE_ASSIGNMENT | read | (existing) | `no-definition`, `other-family`, `no-root`, `undeclared`, `nested`, `ignored` |
  | OVERRIDE_STALE | read | (existing) | `not-derived`, `unresolved` |
  | OVERRIDE_ECHO | read | (existing; one per instance) | — |
  | PROPERTY_REF_DROPPED | read | a layer's binding to a component property that is not carried; never matched by name | `fill-style`, `outside-definition`, `no-definition`, `other-family`, `no-root`, `undeclared`, `type-mismatch` |
  | SWAP_VALUE_DANGLING | read | an INSTANCE_SWAP value or default, or a swap target, naming no component the IR can reference; dropped (rule A for resolution) | `assignment`, `default`, `swap` |
  | SWAP_ASSIGNMENT_IGNORED | read | a swap assignment Pixso's derived data shows was not applied; the declared symbol is used and the assignment dropped (rule C) | — |
  | OVERRIDE_PATHS_MERGED | read | override entries of one path merged into one (D17) | — |
  | OVERRIDE_FIELD_DROPPED | read | an override field not carried, one note per instance and class; the detail is the class, then `: ` and the fields with counts | `no-equivalent`, `not-on-type`, `layer-not-carried`, `root-box`, `unknown` |

  `SOURCE_FEATURE_UNSUPPORTED`'s open list gains "COLOR property". Notes with a `path` name the instance by `node`;
  P0 extends the reader's `push()` to write `path`. IR.md's example notes start with their classes.
- **Not changed:** the node record keys, `KNOWN_PROPS.INSTANCE` (an INSTANCE **record's** props; an override on a
  nested instance is checked as above), library identity, styles, images, fonts.

### 5.2 Task contract (`tools/ir/task.mjs`, `tools/ir/plan.mjs`, `tools/ir/judge.mjs`, `tools/test-m1-contract.mjs`)

`TASK_IR_VERSION = 3`; `taskType(irType)` (COMPONENT_SET → FRAME, the rest unchanged; D13), which `plan.mjs` `taskNode`
writes and `judge.mjs` compares with; `BUILT_TYPE` unchanged. `derivePopulations` takes a top-level COMPONENT_SET as
a state group. Nothing else: tasks still carry no `instance` data. The bundled plugin is regenerated;
`figma-plugin/src/**` is not edited. `test-m1-contract` checks the version, `taskType`, and that a task carrying a
COMPONENT_SET record is still refused. P0 makes these `plan.mjs` and `judge.mjs` edits so that A can run M1's balance
with real sets before D merges; D owns `plan.mjs` afterwards, and `judge.mjs` is not otherwise touched.

### 5.3 The reader seam (`tools/pix/ir/index.mjs`, `nodes.mjs`, `components.mjs`)

P0 wires five hooks into the M1 reader, each in its own module, each a stub with its frozen contract in its header,
so the parts never edit the seam:

```
families.mjs   (A)  familyIndex(cx) -> { setOf(symbolGuid) -> stateGroupGuid|null (accepted sets only),
                    familyOf(symbolGuid) -> setOf(symbol) || symbolGuid (the IR family B and C write),
                    accepted: Map(groupGuid -> {axes:[{name, values}], variant: Map(symbolGuid -> {axis: value})}),
                    rejected: Map(groupGuid -> class), recordType(n, planned) -> "COMPONENT_SET"|planned }
                    stub: no group accepted, none rejected, no notes (M1's D7, as `--variant-sets frames`)
propindex.mjs  (P0, implemented) propIndex(cx) -> { scopeOf(symbolGuid) -> stateGroupGuid|symbolGuid,
                    defsOf(ownerGuid), rootOf(scopeGuid, defId, from?) -> def|null,
                    why(scopeGuid, defId, from?) -> "root"|"alias"|"no-definition"|"other-family"|"no-root",
                    symbolKnown(guid) -> bool, refOf(guid) -> masterRef|null,
                    chain(scopeGuid, defId, from?) -> {def, why, hops}, owners }   (D3, D5; `from`, the
                    symbol the id is read from, `chain` and `owners` added by P0, §13 P0-1)
properties.mjs (B)  propertiesOf(cx, familyGuid) -> [definition]; bindingsOf(cx, n, i) -> componentPropertyReferences|null;
                    assignments(cx, symbolGuid, raw[], {nested, ignored: Set(defId)}) ->
                      {kept:[{family,id,value}], dropped:[{code, class, defId}]}   (every raw assignment in exactly one)
                    stub: no properties, no bindings, no assignment kept, none counted
resolve.mjs    (C)  makeResolver(cx) -> { resolve(instanceNode, guids) -> {ok, root, elements:[{n, i, symbol, via}],
                    resets, fallback, ignored} | {ok:false, at, why}; effectiveSymbol(chain, node); inDerived(instanceNode, guids) }
                    stub: first hop only
overrides.mjs  (C)  instanceData(cx, n, i, master, indexOf) -> instance data (properties, overrides, overrideBasis,
                    derived, exposed, scale); OVERRIDE_SOURCE_FIELDS; stub: { master }
```

`propindex.mjs` is implemented in P0 (about 150 lines), as M1's P0 implemented `pathgeom.mjs`, because B and C both
need alias roots and the two swap predicates before either merges; B owns it afterwards. It works on definition
scopes and symbols, never on IR families, so it does not wait for A. `index.mjs` calls `familyIndex`, then
`propIndex`, then the resolver, before `emit`; `emit` asks `recordType` (and computes a COMPONENT_SET record's props
as the planned FRAME's, with `meta.stateGroup` set for it as for the FRAME) and `bindingsOf` per record, and writes
`sets` from A's index and components' `set`, `variant` and `properties` (B). Then the **instance pass** calls
`instanceData` for every INSTANCE record with `indexOf(guid) -> record index`, and writes its notes with an explicit
`node` and `path`. `index.mjs` also writes `stats.m2a`, whose shape (the union of §6 A, B and C's) P0 freezes in its
header, from counters each module fills on `cx.m2a`, plus `stats.ms.m2a` per phase (`families`, `props`, `resolve`,
`instances`); and it extends the scope closure (D12). With every stub in place the IR equals M1's apart from the
version and the header settings.

### 5.4 The fixture (`tools/pix/fixture.mjs`)

P0 adds every M2a case, with the expected outcome of each written next to it, so the parts test against one input
and never edit it (a part that needs another case lists it in its pull request; E folds it in). The schema gains, with
Pixso's names and real numbering kept different from the real files as today: `parentPropDefId`, `sortPosition`,
`preferredValues` (with `InstanceSwapPreferredValueType`), `overrideLevel`, `uniformScaleFactor`, `propsAreBubbled`,
`strokePaddingPath` and `textData` in derived entries, the COLOR type and the INHERIT_FILL_STYLE_ID field. Cases:

- **families**: one accepted set with mixed name order and a vocabulary in another order, a value the vocabulary
  lacks; one rejected set per class (`no-equals`, `duplicate-axis`, `axis-count`, `duplicate-coordinate`); a set whose
  vocabulary lists another axis (accepted under `names`, rejected under `vocabulary`); a set on a user page;
- **properties**: real-layout member aliases (own id plus `parentPropDefId`, unnamed BOOL, type differing from the
  root's), a two-hop chain through a set alias, a set alias to another set and one to no definition, a same-id alias,
  a COLOR root, an INHERIT_FILL_STYLE_ID ref, a ref of the wrong type, a ref to another family's definition;
- **INSTANCE_SWAP**: a root whose `initialValue` names no SYMBOL while its bound layer declares one; an assignment
  naming no SYMBOL (rule A); preferred keys, one in the file (a library copy's key) and one not, one STATE_GROUP;
- **assignments**: stale `no-definition` and `other-family` on instances; a stale nested one in a live entry;
  one inside a stale entry;
- **paths**: a swap by override; a swap by property through an alias; a nested instance's own swap with the outer
  one winning; a no-op outer swap followed by an inner swap (rule B); P's shape (an inner-layer swap assignment Pixso
  ignored, rule C); a hop that matches only by `overrideKey` (must stay stale); a path of length 3;
- **entries**: a root entry `[symbolID]` and an empty-path one on the same instance, with a `size` equal to the
  record's and one different, and a fill; duplicate paths with a conflicting field and differing `overrideLevel`; echo
  fields (direct, and through a master's nested-instance override); dropped fields (`vectorPaints`, `pluginData`); a
  field outside `OVERRIDE_SOURCE_FIELDS` (must fail G6; a plant, `M2A_PLANTS.unknownOverrideField`, not a case of
  the base fixture, which must pass every gate, §7, §13 P0-5); a fill override on a GROUP layer (`not-on-type`); a fill and
  a style override on a nested INSTANCE layer (carried); a `characters` override on a text bound to a TEXT property
  that is also assigned; a no-op swap (kept); a text override with a style table; a size override; a style reference
  in an override; an override on a folded boolean operand;
- **derived**: sparse entries (no transform, no size), one left with nothing to write, entries with
  `strokePaddingPath` and with baselines, an instance whose master has no children (no derived data); a scaled
  instance; an exposed nested instance;
- **definitions**: a state group with auto layout (its tasks equal under both `--variant-sets` values); a member-owned
  root in an accepted set (lifted) and in a rejected one; a swap value naming a SYMBOL that has no record and no
  library identity (`not carried`); a TEXT preferred `stringValues`.

Every key in it is computed at run time from a label (as M1's image hashes are), so `test-hygiene.mjs` needs no new
allowed value. The existing `test-pix` and `test-irread` checks keep passing; P0 adjusts `test-irread`'s D7 checks
to run under `--variant-sets frames` (§9).

### 5.5 Selftest

`tools/selftest.mjs` gets section 10: `test-m2a-families.mjs` (A), `test-m2a-props.mjs` (B), `test-m2a-instances.mjs`
(C), `test-m2a-run.mjs` (D) and `test-m2a-e2e.mjs` (E), each committed by P0 as a stub printing `pending: part X`
with the checks it must hold listed in its header. Section 10 runs `test-m2a-contract.mjs` (P0's, kept: the seam,
never a part's decisions) first. A stub never passes: it exits 2 while its part's code is still P0's stub (each stub
module exports `STUB`; D's evidence is `tools/m2a-accept.mjs`, E's that A-D have all landed), which selftest prints as
pending without failing, and it exits 1 once the part's code is in but the stub is still there, which fails selftest
(§13 P0-6).

**P0 is done when** selftest passes with the stubs, the reader on the fixture writes a valid v3 IR equal to M1's
apart from the version and the header settings, M1's e2e (`test-m1-e2e.mjs`) passes unchanged on it, the tasks from
it equal M1's apart from `irVersion`, and `pix-run --dry --no-pixso` on D, K, M and P gives M1's balances.

## 6. Parallel parts (separate worktrees, disjoint files, §9)

### A: families (about 450 lines, I)

- **Owns:** `tools/pix/ir/families.mjs`, `tools/pix/ir/components.mjs`, `tools/pix/ir/populations.mjs`,
  `tools/test-m2a-families.mjs`.
- **Rules:** D2 and D13. The grammar, the axis and value order, the classes in their order, `--variant-sets`,
  `--variant-grammar`, `--axis-order`, `familyOf`. A COMPONENT_SET keeps the state group's props (FRAME's
  `KNOWN_PROPS`, computed by the seam as for the FRAME, §5.3). A set's `library` comes from the state group's
  `publishFile` and `publishID` (and `componentKey`) as for components. `masterRef` keeps its M1 contract
  (`propindex.mjs` `refOf` wraps it). `stats.m2a.families = {groups, accepted, rejected: {class: n}, rejectedMembers,
  valuesAppended, vocabularyOrder, namesOrder}`.
- **Tests:** each fixture set's outcome under each setting; members of a rejected set standalone with the note's
  class; axis and value order; byte-identical IR twice; populations with a COMPONENT_SET on the internal canvas and on
  a user page; the auto-layout set's record props and tasks equal under both `--variant-sets` values; the validator's
  coordinate checks on the result.
- **Done when** its test passes and, on D, K, M and P, accepted / rejected equal 64 / 3, 308 / 4, 221 / 6, 348 / 11
  (P 342 / 17 under `vocabulary`), members of rejected sets 66 / 97 / 192 / 436, the split by class under D2's order is
  recorded in the pull request (§1.1 measured another order), and the M1 balance still adds up.

### B: properties (about 700 lines, I)

- **Owns:** `tools/pix/ir/properties.mjs`, `tools/pix/ir/propindex.mjs` (after P0), `tools/test-m2a-props.mjs`.
- **Rules:** D3 to D6. Roots only; member-owned roots lifted; rejected-set members get copies (`--rejected-props`);
  bindings with their classes; defaults by `--swap-default`; preferred key references; assignments with their classes
  in D6's order, nested ones through C's effective symbol (C calls `assignments(cx, effectiveSymbol, …, {nested:
  true, ignored})`, and `familyOf` names the family). `stats.m2a.properties = {roots, liftedMemberRoots, copiedRoots,
  aliases, viaAlias, unnamedRoots, declaredNotRoot, bindings: {total, kept, dropped: {class: n}}, swapDefaultFromLayer,
  swapDefaultLayersDisagree: {roots, layers}, boundLayerDiffers: {text, visible}, swapDangling: {assignment, default,
  swap}, preferred: {inFile, byKeyOnly, stringValuesDropped}, assignments: {total, kept, droppedWithEntry, merged,
  dangling, defaultDropped, richTextFlattened, stale: {class: n}}}`, where `boundLayerDiffers` counts layers bound to
  a TEXT or BOOLEAN root whose own `characters` or `visible` differs from the root's default (D5's question for the
  other two types; Figma's default replaces the layer's value in the main component).
- **Tests:** every fixture property case under both `--swap-default` and `--rejected-props` values; the validator
  accepts every declared type as its root's; a binding is never resolved by name (a planted same-name definition in
  another family stays dropped); the renumbered fixture enums give the same IR.
- **Done when** its test passes and on D, K, M and P: stale assignments on instances, `no-definition` +
  `other-family`, 130 (124 + 6), 2 034 (315 + 1 719), 922 (96 + 826), 1 851 (321 + 1 530), with `no-root` and
  `undeclared` reported apart (they are not in REWRITE's numbers); `type-mismatch` 0 / 0 / 0 / 94; `fill-style`
  1 101 / 5 232 / 17 370 / 34 903; lifted member roots 120 / 120 / 6 / 24; every other difference from §1.2 explained
  in the pull request (§0.3's rows are B's and C's to reconcile).

### C: instances — resolver, overrides, derived (about 1 400 lines, I)

- **Owns:** `tools/pix/ir/resolve.mjs`, `tools/pix/ir/overrides.mjs`, `tools/pix/ir/derived.mjs`,
  `tools/ir/props.mjs` (after P0: `OVERRIDE_FIELDS`, `OVERRIDE_FIELD_CLASS`), `tools/test-m2a-instances.mjs`.
- **Rules:** D7 to D11 and D17; the translators of M1 (`paints`, `strokes`, `layout`, `text`, `styles`) are called in
  partial mode through new exports C requests from their owner's code only if a signature must change (listed in the
  pull request; E folds it in). `stats.m2a.instances = {instances, notCarried, noDerived, exposed, exposedOutside,
  scaled, ownDiffers}`; `stats.m2a.overrides = {entries, root, emptyPath, nonRoot, live, stale: {class: n},
  resolvedNotDerived, inDerivedUnresolved, distinctLivePaths, mergedAway, written, emptyAfterTranslation,
  merged: {paths, conflicts}, rootBox: {echo, differs}, boundConflicts,
  pixsoFields: {total, translated, consumed, dropped: {class: {field: n}}},
  fields: {produced, carried, echo: {field: n}, byClass: {applies, unprobed, refused}},
  swaps: {override, property, sameSet, noOp, unresolved, dropped}}`, with the two G6 balances (§8) checked when the
  stats are written; `stats.m2a.derived = {entries, resolved, viaFallback, unresolved, written, empty, noAt,
  noTransform, noSize, withLines, withOracleSides, geometry}`.
- **Measurements C records in its pull request (counts only):** the merge rule against derived (D17); for derived
  entries **with** a transform or size, how often it equals the target layer's own (composed through nested masters):
  rare equality supports "absent means the master's" (D10, I); how many derived `textData` entries carry baselines;
  the reconciliation of §0.3's override rows; reader time per new phase on P.
- **Tests:** every fixture path, swap and entry case, each rule switched off once (`--swap-dangling strict`,
  `--swap-reset off`, `--swap-fallback off`) failing exactly its case; `at` indices; echo through a nested master's
  override; a field never echoed against the wrong (pre-swap) master; a bound field's baseline is the property's
  effective value; a no-op swap kept; root box fields never in the `path` [] override; a nested INSTANCE target's fill
  carried; `not-on-type` and `unknown` drops (the latter failing G6); the census and `OVERRIDE_SOURCE_FIELDS` list the
  same fields; rule C's ignored assignment absent from the IR; merge rules; dropped and refused fields;
  `--derived-geometry` each value; `--instance-own own`; byte-identical twice.
- **Done when** its test passes and on D, K, M and P: derived 35 808 / 35 808, 160 982 / 160 982, 86 941 / 86 941,
  342 679 / 342 679 with 36 via rule C; live / stale 6 353 / 726, 42 456 / 950, 52 982 / 949, 107 190 / 6 563 with
  no entry live outside derived or stale inside it (`resolvedNotDerived` and `inDerivedUnresolved` 0); no `unknown`
  field; root `size` all echo or counted `root-box` (D 1 425, K 18 326, M 9 729, P 19 105 root entries carry one); the
  override and field balances of §8 add up.

### D: run, stats and acceptance (about 600 lines, I)

- **Owns:** `tools/ir/plan.mjs` (after P0's `taskType` and `derivePopulations` edits; tasks still carry no
  `instance`), `tools/pix-run.mjs` and `tools/pix-to-ir.mjs` (the thirteen flags of §3; an "M2a" block in the `--dry`
  print), `tools/m2a-accept.mjs` (new), `tools/test-m2a-run.mjs`, `tools/test-pixrun.mjs` (adjustments only).
- **`m2a-accept <runDir>… [--expect <private json>] [--twice]`** prints the gates of §8 from each run folder's
  `stats.json` and `ir.json`; `--twice` re-reads the `.pix` and compares the IR's SHA-256; `--expect` takes the
  owner's per-file numbers from a file outside the repository (`assertOutsideRepo`), because a file label cannot be
  derived from the file without naming it. Exit 0 only when every gate passes. A gate whose question the IR cannot
  answer (it holds only live entries and only roots) reads the reader's counters in `stats.json`; m2a-accept says, per
  gate, which source it read.
- **The run folder.** The settings hash in its name now includes the M2a settings, so a v3 run never resumes a v2
  folder; `pix-run` refuses a folder whose `states.json` `irVersion` is not 3 and names the M1 commit that can resume it.
- **Tests:** each gate failing on its own on a planted stats file; `--expect` refusing a path inside the repository;
  the M1 balance and task count on the fixture unchanged by v3; the flags round-trip into the IR header.
- **Done when** its test passes and `pix-run --dry --no-pixso` on D, K, M and P prints the M1 balance (adding up) and
  the M2a block.

## 7. Integration (part E, after A-D merge)

- **Owns:** `tools/test-m2a-e2e.mjs`; this file (results, §0.3's reconciliation, the D17 default); `docs/REWRITE.md`
  (§3 and §10: the definitions, the corrected M2a numbers, K's 160 982, the M and P numbers); `docs/IR.md` and
  `tools/ir/schema.mjs` post-merge corrections; `tools/pix/fixture.mjs` (cases the parts asked for);
  `tools/ir/not-codes.json`; `.product-os/STATE.md`.
- **e2e:** fixture → `pixToIR` (default settings and each non-default once) → validate → `planM1` → the bundled plugin
  on the double (M1's path, a COMPONENT_SET written into tasks as a FRAME) → judge → M1's verdict reads as before;
  the tasks equal, record for record, those of the `--variant-sets frames` IR; `m2a-accept` on the fixture's run
  folder passes every gate; a planted fault per gate fails it; the renumbered fixture gives the same IR (G8's second
  half, which a run folder cannot show).
- **Merge order:** P0; then A, B, C and D in any order; then E. C's nested-assignment and echo checks print `pending: B`
  until B merges, and B's rejected-set copies `pending: A` until A merges; E re-runs them.

## 8. Acceptance (`m2a-accept`)

Every gate is structural, so it holds on any file; the per-file numbers below are what the gates print on D, K, M and P
under the default settings (C for D and K from REWRITE, except K's 160 982 which rule B gives, §0.1; C for M and P from
§1; K's nested 75 is I, §0.3, and is printed, not gated). The population is the carried INSTANCE records and their
entries; instances the reader does not carry (a master it cannot name) are counted in `stats.m2a.instances.notCarried`
with their entries. "Source" says where m2a-accept reads the answer: the IR cannot show what the reader dropped.

| gate | FAIL when | source | D | K | M | P |
|---|---|---|---|---|---|---|
| G1 derived | a derived entry does not resolve, rule C included; or entries ≠ written + empty | stats | 35 808 / 35 808 | 160 982 / 160 982 | 86 941 / 86 941 | 342 679 / 342 679 (36 via rule C) |
| G2 live ⇔ derived | `resolvedNotDerived` or `inDerivedUnresolved` is not 0 | stats | 6 353 / 726 | 42 456 / 950 | 52 982 / 949 | 107 190 / 6 563 |
| G3 families | accepted + rejected ≠ state groups, or a rejected set's member is not standalone (by class printed) | stats, IR | 64 / 67 | 308 / 312 | 221 / 227 | 348 / 359 |
| G4 stale assignments | `no-definition` + `other-family` on instances differ from `--expect`; `no-root`, `undeclared`, `nested`, `ignored` printed | stats | 130 (124 + 6), nested 4 | 2 034 (315 + 1 719), nested 75 (I) | 922 (96 + 826), nested 839 | 1 851 (321 + 1 530), nested 293 |
| G5 property types | `declaredNotRoot` ≠ 0; a declared type is not its root's; a kept binding whose field is not its root's type | stats, IR | 0 | 0 | 0 | 0 (94 dropped `type-mismatch`) |
| G6 override balances | entries: entries ≠ root + live + stale, live ≠ distinct live paths + merged away, distinct live paths ≠ written + empty after translation and echo, the IR's non-root overrides ≠ written + pinned (§15); Pixso fields: total ≠ translated + consumed + dropped by class; any `unknown` field; Figma fields: produced ≠ carried + echo | stats | adds up | adds up | adds up | adds up |
| G7 assignment and binding balances | assignments ≠ the sum of D6's classes (each assignment in exactly one); refs ≠ kept + dropped by class (D4's order) | stats | adds up | adds up | adds up | adds up |
| G8 determinism | `--twice`: two reads give IRs that differ in one byte (the renumbered fixture is E's test) | IR | — | — | — | — |
| G9 M1 unchanged | the M1 balance does not add up on IR v3 (M1's e2e and the equal-tasks check are selftest's) | stats | — | — | — | — |
| G10 validity | `validate(ir)` reports an error | IR | — | — | — | — |

Printed beneath, never gating: echo fields per file (the M2a measurement of §1.3's lower bound), merged paths and
conflicts, dropped fields by class and name, fields by P13 class, root `size` echoes and differences, bound-field
conflicts, swap-default disagreements, bound layers differing from their default, sparse and empty derived entries,
IR size, and reader time per phase (`stats.ms`, the M1 phases and the four M2a ones of the same run, so the
comparison does not depend on the machine's load: this review measured the v2 IR phase at 1.6 / 10.1 / 5.7 / 10.0 s
on a busy machine, against the 0.7 / 4.6 / 3.1 / about 11 s quoted before).

## 9. File ownership matrix (no file has two owners at the same time)

✎ = edits. P0 runs first and alone; A-D run in parallel; E runs after all of them merge.

| file or glob | P0 | A | B | C | D | E |
|---|---|---|---|---|---|---|
| tools/ir/schema.mjs, tools/ir/validate.mjs, tools/test-ir.mjs, docs/IR.md | ✎ | | | | | ✎ after merge |
| tools/ir/props.mjs | ✎ first version | | | ✎ | | |
| tools/ir/task.mjs, tools/ir/judge.mjs, tools/ir/identity.mjs, tools/test-m1-contract.mjs, tools/selftest.mjs | ✎ (`taskType`, D13; §13 P0-7) | | | | | |
| tools/test-m2a-contract.mjs, tools/test/m2a-stub.mjs | ✎ | | | | | ✎ after merge |
| M1's tests that wrote the IR version as a literal 2 (test-irbuild, test-irverify, test-m1-e2e, test-pixrun, test-plugin); test-pix (the fixture's node counts) | ✎ version and counts only | | | | | |
| tools/ir/not-codes.json | ✎ | | | | | ✎ |
| tools/pix/ir/index.mjs, tools/pix/ir/nodes.mjs, tools/test-irread.mjs | ✎ seam | | | | | ✎ after merge |
| tools/pix/fixture.mjs | ✎ cases | | | | | ✎ after merge |
| tools/pix/ir/families.mjs, components.mjs, populations.mjs; tools/test-m2a-families.mjs | stub | ✎ | | | | |
| tools/pix/ir/propindex.mjs | ✎ implemented | | ✎ | | | |
| tools/pix/ir/properties.mjs; tools/test-m2a-props.mjs | stub | | ✎ | | | |
| tools/pix/ir/resolve.mjs, overrides.mjs (with `OVERRIDE_SOURCE_FIELDS` frozen), derived.mjs; tools/test-m2a-instances.mjs | stub | | | ✎ | | |
| tools/ir/plan.mjs | ✎ `taskNode` and `derivePopulations` (§5.2) | | | | ✎ | |
| tools/pix-run.mjs, tools/pix-to-ir.mjs, tools/m2a-accept.mjs, tools/test-m2a-run.mjs, tools/test-pixrun.mjs | stub test | | | | ✎ | |
| tools/test-m2a-e2e.mjs | stub | | | | | ✎ |
| docs/M2A.md, docs/REWRITE.md, .product-os/STATE.md | ✎ plan | | | | | ✎ results |

Untouched by M2a: `tools/builder4.js`, `tools/pack4.mjs`, `tools/run.mjs`, `tools/build-lib.mjs`,
`tools/extract-lib.mjs`, `tools/kiwi.mjs`, `tools/test-hygiene.mjs`, every file under `figma-plugin/src/` and
`tools/double/` (the bundle is regenerated from `task.mjs`, not edited), and the M1 reader modules other than the seam
(`paints`, `strokes`, `layout`, `text`, `styles`, `vector`, `booleans`, `images`, `enums`, `util`): a part that needs a
change there lists it in its pull request and E applies it.

## 10. What M2b needs from this IR

M2b builds definitions, variant sets, properties, instances and overrides in Figma (REWRITE §4's creation order, step
4 and the overrides of step 5). Each need below names the IR data that meets it and the probe that rules the build.

| M2b step | probe | what it needs | where the IR has it |
|---|---|---|---|
| empty component shells, then `combineAsVariants` before any instance exists | P14 (C) | every COMPONENT with its family; for each accepted set, its members and their coordinates; member names written as `Axis=Value, …` in the set's axis order | `components[]` (`set`, `variant`), `sets[].axes` (normalised, D2) |
| `addComponentProperty` on shells, before content | P14 (C) | roots only, with type, name and a default; an INSTANCE_SWAP default that names a component built as a shell first; preferred values as Figma's `{type, key}` | `sets[].properties`, `components[].properties` (D3, D5); preferred `guid` for local targets, `componentKey` for M3's kit map |
| bind layers to properties | — | per layer, the field and the root id, which M2b maps to the property key Figma returns | `componentPropertyReferences` (D4) |
| exposed nested instances | — | which nested instances expose their properties | `instance.exposed` (D11) |
| instances: master and properties | — | master reference; assignments by root id to the master's family; INSTANCE_SWAP values that resolve | `instance.master`, `instance.properties` (D6) |
| sublayer ids | P9 (C), P11b (C) | for every override, the Figma id `I<instance>;<layer>;…`, computable without reading layout; after a swap, the new master's layer ids | `overrides[].at`: record indices whose built Figma ids M2b keeps in its node map; paths are already in post-swap layers (D7) |
| swaps | P16 (C) | which swaps switch a variant inside one set (written as `setProperties` on the nested instance) and which change family (`swapComponent`) | `overrides[].swap` with `components[].set` and `variant` |
| field overrides | P13 (C), P13b (A) | fields in Figma's names, each with its class: applied, refused (counted OVERRIDE_FIELD_UNSUPPORTED, decision 1), or unprobed | `overrides[].fields` closed to `OVERRIDE_FIELDS`, `OVERRIDE_FIELD_CLASS` |
| no echo writes | P9b (C) | echo fields already gone | D9 |
| the instance's own look | — | the root override, applied to the instance itself; its size, position and child layout are the record's, set as on any node | `overrides[]` with `path` [] (look fields only), the record's props (D8, D11) |
| overrides on nested instances | — | look fields on a nested instance, checked against its master root's type | `overrides[].fields` with an INSTANCE target (§5.1) |
| properties and field overrides on one bound layer | — | which one Figma shows when an instance assigns a property and overrides the bound field too | `overrides.boundConflicts` counts them (D9); M2b writes properties, then field deltas |
| scaled instances | P10 (pending) | the scale factor | `instance.scale` |
| verification of every sublayer within 1 px or in a class (REWRITE §7) | — | the derived box per sublayer with its record; the master layer's box where derived is sparse; side oracle; Pixso's line count | `derived[]` with `at`, `size?`, `transform?`, `oracleSides`, `lines` (D10) |
| fallback frames for an instance that cannot be built | decision 1 | each sublayer's geometry | `derived[].fillGeometry`/`strokeGeometry` (D10) where changed, the master layer's otherwise |

New probes M2b must run, which this plan's inferences rest on:
- **P13b**: the `unprobed` fields on instance sublayers (text ranges, font, line height, letter spacing, auto-layout and
  child layout props, clipping, dashes and caps).
- **P21**: after `swapComponent` on a nested instance whose master-level overrides exist, which overrides Figma keeps
  (rule B says Pixso keeps none; if Figma keeps some, M2b resets them).
- **P22**: the axis order Figma gives a set built by `combineAsVariants` from members named in the IR's axis order.
- **A render pair** of one instance whose own stored paints differ from master root + root override (D11), of one
  P instance under rule C, and of one member whose bound layer differs from its property's default (an INSTANCE_SWAP
  root whose bound layers disagree, D5; a TEXT or BOOLEAN bound layer, `boundLayerDiffers`): Figma's default replaces
  the layer's value in the main component.
- **P23**: `swapComponent` to the instance's current main component (a no-op swap): does Figma reset the nested
  instance's overrides as Pixso does under rule B? M2b writes the kept no-op swaps (D9) only if it does.

## 11. Risks

- **Rules A, B and C are inferred** from derived data alone; B rests on 2 K entries and 1 P override, C on 36 P entries
  that nothing structural separates from 64 accepted ones. Each is a setting, each rule's switch-off is tested, and
  G1/G2 print what each changes. M2b's renders confirm or overturn them.
- **The duplicate merge is unverified** (D17): P's 81 294 conflicting values include fills, styles and visibility,
  which derived cannot check. A wrong rule shows up in M2b's render audit, not in M2a's gates.
- **Echo baseline errors** would drop live fields. The baseline goes through the masters' own nested overrides, the
  effective value of property-bound fields, and rule B; a field is never compared with a pre-swap master (tested),
  and `--echo keep` exists to compare.
- **"Absent derived field means the master's" is I.** C measures the supporting evidence; M2b's verifier is the real
  test.
- **IR size and reader time on P.** P adds about 342 000 derived entries (796 417 path elements, each with an `at`
  index) and 107 000 live overrides. M1's v2 IR is 4.3 / 32.5 / 15.9 / 32.2 MB of JSON (C, review), so even a v3 IR
  several times larger stays far below the longest string V8 can hold (about 512 MB, I); no streamed writer is planned.
  `--derived-geometry changed` keeps geometry out where it repeats the master's; IR size and time are printed (§8).
- **Translation in partial mode.** The M1 translators write defaults and NEVER_OMIT props for whole records; reused on
  an override they must write only what the entry carries. C tests each translator on a one-field entry.
- **Stranded v2 runs.** K's unfinished M1 run folder holds a v2 IR, which a v3 validator refuses. Finish K's run
  before P0 merges, or resume it from a worktree at the M1 commit; D's refusal names that commit (§6 D). Roots stamped
  `pxIr` 2 are rebuilt, not resumed, by any later v3 build.
- **Two measurements, one record.** §0.3 lists every disagreement; B and C reconcile them on the files before their
  numbers become gates, and E records the outcome here. The planning-era scripts are outside the repository; §0.2 and
  D7 are what reproduces them.
- **Hygiene.** The fixture's keys are computed at run time; acceptance numbers are counts; the `--expect` file and
  every IR stay outside the repository (`assertOutsideRepo`).
- **Merge conflicts** come only from a part editing outside §9; the seam, the fixture and the schema are P0's and E's.

## 12. Open, handed on

- To M2b: P13b, P21, P22, P23, P10 and the render pairs of §10; dropping the D13 task mapping; the D17 default if derived cannot decide it; property names
  that are empty or repeat within a family (Figma suffixes property names; M2b maps root ids to Figma's keys).
- To M3: preferred values by key and P's user-page `overrideKey`s (§1.4).
- To M5: `variableConsumptionMap` in overrides (dropped and counted here).
- To M2b, from the build (§14): U's 2 derived entries that resolve nowhere and 50 stale entries that resolve (§14.7),
  for a render pair before the resolver's rules are trusted on new files; the instance pass's time (§14.1); sharing
  `nodes.mjs` `propsOf` with `overrides.mjs` `lookOf` (equal on all five files today, §14.4).
- Q5 and P9 against guidPaths after a swap in **Pixso's** API ids remain unmeasured offline; M4 needs them, M2a does
  not.

## 13. Review (2026-10-06), folded into this edition

A skeptical read of the first edition against REWRITE §3, §8 and §10, `docs/IR.md` and the code at 352e5ba, with five
read-only probes of D, K, M and P (counts only; scripts outside the repository). Each issue and where its fix sits.

| # | kind | issue | fix |
|---|---|---|---|
| R1 | contradicts the code | `BUILT_TYPE.COMPONENT_SET = "FRAME"` does not draw a set as M1 drew the state group: the bundled builder writes auto layout only for IR type FRAME or COMPONENT, 19 / 75 / 57 / 58 state groups have auto layout, and the judge refuses a task type that is not the IR record's | D13, §5.2: `taskType()` writes COMPONENT_SET into tasks as FRAME; `BUILT_TYPE` unchanged; tasks equal those of `--variant-sets frames` |
| R2 | contradicts the code | `nodes.mjs` decides frame layout, side strokes and `meta.stateGroup` by record type, so a COMPONENT_SET record would lose its layout props and its population | §0.4, §5.3: the seam computes a set's props and population as the planned FRAME's |
| R3 | drops overrides | fields closed to the target's `KNOWN_PROPS`, with `KNOWN_PROPS.INSTANCE` a placeholder's box: 135 / 398 / 779 / 7 899 live entries put a look field on a nested instance | §1.3, §5.1: an INSTANCE target takes `KNOWN_PROPS.COMPONENT` |
| R4 | contradicts a measurement | root entries carry `size` 1 425 / 18 326 / 9 729 / 19 105 times, not "40"; in the `path` [] override they would be `refused` and drive decision 1 on instances Figma can size | §1.3, D8, §5.1: root box, child-layout, name, visibility fields compare with the record (echo or `root-box`); `path` [] holds look fields only |
| R5 | drops overrides | D8's translate and drop lists miss about forty Pixso fields seen in override entries (text style and font fields, other style references, constraints, min and max size, export settings, layout grids, variable modes, …) | §1.3 census; D8 and §5.1 `OVERRIDE_SOURCE_FIELDS`; class `unknown` fails G6 |
| R6 | drops overrides | an override on a property-bound field was compared with the layer's record value, and a no-op swap could pass for an echo although rule B makes it reset overrides | D9: bound fields compare with the property's effective value (`boundConflicts`); swaps are never echoes; P23 |
| R7 | parts disagree | "names no SYMBOL in the file" (resolver, B) and "resolves to a master reference" (validator) differ for a SYMBOL with no record and no library identity, which would make the IR invalid | D5: `symbolKnown` and `refOf` in `propindex.mjs`; SWAP_VALUE_DANGLING `: not carried`, class `swap` |
| R8 | adds what Pixso ignored | rule C used the declared symbol but kept the ignored swap assignment, which M2b would apply under `at` resolved for the declared symbol | D7 rule C: the assignment is dropped (STALE_ASSIGNMENT `ignored`) |
| R9 | parts disagree | `rootOf(familyGuid)` cannot find a rejected member's roots, which live on the state group; B and C would depend on A's acceptance | D3, §5.3: `propindex.mjs` works on definition scopes; A's `familyOf` names the family |
| R10 | drops properties | 120 / 120 / 6 / 24 root definitions live on member SYMBOLs; D3 declared roots on the set only and the validator forbids member properties | §1.2, D3: lifted to the set (`liftedMemberRoots`), kept on a rejected member |
| R11 | P0 cannot finish | A's stub would accept the fixture's duplicate-coordinate set and B's stub would keep assignments unmapped: both invalid IRs | §5.3: stubs give M1's IR (no sets, no assignments); P0's done-when compares with M1 |
| R12 | parts disagree | `at` and the echo baseline need the indices and props of master records, which `emit` writes after the user pages | §4, §5.3: an instance pass after `emit`, with `indexOf` and explicit note `node` and `path` |
| R13 | number no part produces | G4 gated 130 / 2 034 while D6 adds `no-root` to the stale classes; K's nested 75 is I | B's done-when and G4: `no-definition` + `other-family` gate, other classes printed |
| R14 | lets assignments vanish | G7's classes missed merged duplicates, rule C, undeclared roots and the order between dangling and stale | D6: one class per assignment in a fixed order; G7 sums them |
| R15 | balance in mixed units | G6 compared Pixso fields with Figma fields and had no term for merged or emptied entries | G6: an entry balance, a Pixso-field balance and a Figma-field balance |
| R16 | number no part produces | m2a-accept cannot see, in a run folder, entries that resolve but are stale, declared non-roots, the renumbered fixture or M1's e2e | §6 C, B stats (`resolvedNotDerived`, `declaredNotRoot`); §8 source column; G8, G9 split with E and selftest |
| R17 | lets derived entries vanish | a sparse derived entry with unchanged geometry has nothing to write, and the validator needs a key | D10: not written, counted `empty`; G1 `entries = written + empty` |
| R18 | contradicts IR.md | VARIANT_SET_REJECTED "by guid" (IR.md §13 keeps `guid` for nodes with no record); OVERRIDE_FIELD_DROPPED without classes or a volume rule | D2: `node`; §5.1 classes; D15 per instance and class |
| R19 | missing settings | copying a rejected set's roots onto its members and keeping assignments equal to the default were policies without a switch | §3: `--rejected-props`, `--default-assignments` (13 settings) |
| R20 | silent change of content | D5's finding (Pixso draws the bound layer, not `initialValue`) was not asked for TEXT and BOOLEAN roots, nor for INSTANCE_SWAP roots whose bound layers disagree; TEXT `stringValues` vanished | D5, §6 B: `swapDefaultLayersDisagree`, `boundLayerDiffers`, `stringValuesDropped`; render pair in §10 |
| R21 | contradicts a measurement | the streamed-writer contingency and the quoted reader times | §11: v2 IR 4.3 / 32.5 / 15.9 / 32.2 MB; §8: times from the same run |
| R22 | numbers vs order | §1.1's split by class came from another class order and has no `no-equals` | §1.1, §6 A: totals gate, split recorded under D2's order |

### P0's findings (2026-10-06), folded into this edition

Implementing §5 met these. Counts are D / K / M / P, then the Сова UI kit (**U**, 181 344 override entries, an extra
check only) where it differs; scripts outside the repository, as for §1.

| # | finding | resolution |
|---|---|---|
| P0-1 | One definition id sits on several owners of one scope: with the same parent 99 / 365 / 4 438 / 8 391 (the same-id model, harmless); with **different parents** 0 / 0 / 0 / 81 (U 250); as a root on one member and an alias on another 0 / 0 / 3 / 12 (U 6). Read without knowing which member it sits on, 0 / 0 / 3 / 16 bindings (U 35) reach another root, and P's `type-mismatch` is 92 instead of §1.2's 94 | `propindex.mjs` `rootOf`, `why` and `chain` take `from`, the symbol the id is read from (a bound layer's enclosing SYMBOL, an instance's master), and prefer its own definition, then the scope owner's, then one with no parent, then the first stored. With it P gives 94. The fixture holds such an id (Chip's 5:913) and the contract test pins both readings (§5.3) |
| P0-2 | The override census of §1.3 is 98 fields on D, K, M and P; U adds four (`exportNameByVariantProp`, `groupIncludeInvisible`, `showInSlice`, `textAlignVertical`). Entries 9 185 / 63 936 / 68 984 / 148 848 confirm §1.3 | `OVERRIDE_SOURCE_FIELDS` gives all 102 and `guidPath` a fate (70 translated, 7 consumed, 26 dropped), so U does not fail G6 with `unknown`; the contract test holds the list |
| P0-3 | Definitions are owned by SYMBOLs and state-group FRAMEs in D, K, M and P; U has 5 INSTANCE owners | `scopeOf`: any other owner is its own scope. Such definitions are no family's roots; B decides and counts them |
| P0-4 | Derived paths are unique per instance in all five files (0 duplicates; derived entries 35 808 / 160 982 / 86 941 / 342 679, U 320 160) | the validator refuses a second derived entry for one path, as it does for overrides |
| P0-5 | §5.4 asked for "a field outside `OVERRIDE_SOURCE_FIELDS` (must fail G6)" as a fixture case, while §7 wants `m2a-accept` on the fixture's run folder to pass every gate | it is a plant, `M2A_PLANTS.unknownOverrideField` (`makeFixture("valid", { mutate })`), as M1's damaged variants are; E's planted-fault test uses it |
| P0-6 | §5.5's stubs "print pending", which alone would let a part merge its code with its test still a stub | each stub exits 2 (selftest prints it as pending and passes) while its part's code is P0's stub, and exits 1 (selftest fails) once that code has landed without the test (§5.5) |
| P0-7 | M1's identity sample (`identity.mjs` `sampleGuids`) picks its candidates by `BUILT_TYPE` of the IR type, so a COMPONENT_SET record would leave the sample and shift every later pick; the file is not in §5.2's list | it uses `taskType` too, and its Pixso type check takes FRAME or COMPONENT_SET for either IR type; the contract test checks that the sample does not depend on `--variant-sets` (§9 row updated) |
| P0-8 | D12 pulls in "the masters of nested instances along live paths", which only C's resolver can tell | the closure follows every override entry, live or stale, and every assignment and definition default: a superset, at worst one more top-level object. C may narrow it |
| P0-9 | §5.1 leaves a few checks implicit | the validator also requires: a note with a `path` names an INSTANCE record; `exposed` only on an instance inside a COMPONENT record; VARIANT_SET_REJECTED names a FRAME record. An override's `properties` without a `swap` must name families in the IR; the effective family of the target is C's to apply (STALE_ASSIGNMENT `nested`), not the validator's. `props.mjs` exports `ROOT_OVERRIDE_FIELDS` (COMPONENT's props less INSTANCE's: the `path` [] look) |
| P0-10 | P0's done-when, measured | on D, K, M, P and U, the P0 reader writes an IR equal to M1's apart from the header's version and settings, the tasks equal M1's apart from `irVersion`, and `pix-run --dry --no-pixso` prints M1's balances, identical; the four M2a phases take at most 92 ms (the definition index, on U) |

## 14. As built (part E, 2026-10-06)

Branch `claude/m2a`: P0 (`claude/m2a-p0`), then parts A, B, C and D merged with `--no-ff`, then part E. Counts are
D / K / M / P, then the Сова UI kit (**U**, an extra check with no plan numbers) where it is given; scripts and outputs
stay outside the repository.

### 14.1 Acceptance (default settings, `m2a-accept --expect <private file> --twice`)

`pix-run --dry --no-pixso` wrote the five run folders; `m2a-accept` read them with the owner's `--expect` file (§8's
numbers, keyed by each file's SHA-256, outside the repository). **Verdict: PASS on D, K, M and P**; U fails G1 and G2
on the anomalies of §14.7, as part C reported. The U column and the pinned swaps are as re-measured after the review
(§15); every other number is unchanged by it.

| gate | D | K | M | P | plan | U |
|---|---|---|---|---|---|---|
| G1 derived resolve (via rule C) | 35 808 / 35 808 | 160 982 / 160 982 | 86 941 / 86 941 | 342 679 / 342 679 (36) | equal | 319 838 / 319 840 (19): FAIL |
| … written + empty | 32 051 + 3 757 | 160 962 + 20 | 23 185 + 63 756 | 115 436 + 227 243 | — | 115 089 + 204 749 |
| G2 live / stale; `resolvedNotDerived`, `inDerivedUnresolved` | 6 353 / 726; 0, 0 | 42 456 / 950; 0, 0 | 52 982 / 949; 0, 0 | 107 190 / 6 563; 0, 0 | equal | 116 557 / 21 855; 50, 2: FAIL |
| G3 accepted / groups; members of rejected sets | 64 / 67; 66 | 308 / 312; 97 | 221 / 227; 192 | 348 / 359; 436 | equal | 632 / 655; 952 |
| G4 `no-definition` + `other-family` on instances | 124 + 6 | 315 + 1 719 | 96 + 826 | 321 + 1 530 | equal | 420 + 2 123 (printed) |
| … nested: `no-definition` + `other-family`; `undeclared` | 4; 0 | 75; 1 | 839; 2 | 293; 0 | 4 / 75 (I) / 839 / 293 | 813 in all |
| … `no-root` / `undeclared` / `ignored` on instances | 0 / 0 / 0 | 0 / 4 / 0 | 0 / 16 / 0 | 0 / 20 / 0 | printed | 39 / 19 / 1 |
| G5 roots declared; `declaredNotRoot`; dropped `type-mismatch` | 473; 0; 0 | 898; 0; 0 | 1 233; 0; 0 | 2 276; 0; 94 | 0 / 0 / 0 / 94 | 5 889; 0; 118 |
| G6 entries = root + empty path + live + stale | 9 185 = 1 849 + 257 + 6 353 + 726 | 63 936 = 20 530 + 0 + 42 456 + 950 | 68 984 = 15 053 + 0 + 52 982 + 949 | 148 848 = 35 095 + 0 + 107 190 + 6 563 | adds up | adds up |
| … live = paths + merged away; paths = written + empty | 6 353 + 0; 2 655 + 3 698 | 42 456 + 0; 24 731 + 17 725 | 52 966 + 16; 15 816 + 37 150 | 103 756 + 3 434; 38 919 + 64 837 (+ 37 pinned, §15) | adds up | adds up (+ 27 pinned) |
| … Pixso fields (translated + consumed + dropped); `unknown` | 21 735; 0 | 186 698; 0 | 228 101; 0 | 511 231; 0 | adds up; 0 | 650 475; 0 |
| … Figma fields = carried + echo | 10 318 = 4 625 + 5 693 | 112 399 = 40 387 + 72 012 | 121 771 = 28 420 + 93 351 | 260 416 = 72 548 + 187 868 | adds up | 355 886 = 87 493 + 268 393 |
| G7 assignments (kept) | 1 276 (1 142) | 10 963 (8 843) | 7 527 (5 570) | 25 804 (22 318) | adds up | 22 824 (15 995) |
| … bindings = kept + dropped; of them `fill-style` | 1 983 = 882 + 1 101; 1 101 | 8 829 = 3 596 + 5 233; 5 232 | 31 746 = 14 270 + 17 476; 17 370 | 63 225 = 27 684 + 35 541; 34 903 | adds up; equal | 68 817 = 30 247 + 38 570 |
| G8 two reads, one IR (SHA-256) | PASS | PASS | PASS | PASS | — | PASS |
| G9 M1 balance | adds up | adds up | adds up | adds up | — | adds up |
| G10 IR v3 validates | PASS | PASS | PASS | PASS | — | PASS |

**Nested stale assignments reconciled.** The plan's 4 / 75 / 839 / 293 are `no-definition` + `other-family` in live
entries. The reader also finds 0 / 1 / 2 / 0 nested `undeclared` (a root it does not declare, D3), which the planning
scripts did not classify, so `m2a-accept` prints nested 4 / 76 / 841 / 293. K's 75 is now C (it was I).

**M1 unchanged.** On all five files `pix-run --dry --no-pixso` on this branch prints the same preflight as the M1
close-out (cfa3e65), line for line: populations, lost-border population, task count and largest task, fonts, images
and the three balance lines. Only the settings line (which gains the thirteen M2a keys) and the new M2a block differ.
P's largest task is 3 940 544 of 4 194 304 characters, as on M1. selftest passes, `test-m1-e2e` included.

**Determinism.** G8 passed on all five (`--twice`: a second read of the `.pix` gives the same `ir.json` bytes). The e2e
test reads the fixture under the defaults and each of the fifteen non-default setting values twice and renumbered,
with the same IR each time.

**Size and time** (`stats.ms` of the same runs): the IR is 8.5 / 57.8 / 25.4 / 62.1 MB (U 76.5), against M1's 4.3 /
32.5 / 15.9 / 32.2. The IR phase takes 4.3 / 26.1 / 15.8 / 36.0 s (U 41.0). Of that, the instance pass is 3.1 / 16.6 /
11.1 / 27.2 s (U 30.1) and the other three M2a phases at most 0.3 s; the resolver runs lazily inside the instance pass.
M1's IR phase on the same files was 0.7 / 4.4 / 2.5 / 4.3 s (part D's runs). No gate reads time (§8); M2b should
profile the instance pass before it adds a build on top.

### 14.2 Commits of part E

- `0df201e` Fix the seams between the M2a parts and apply their requests (§14.3, §14.4).
- `21c6531` Write part E's end-to-end test of M2a (§7's e2e):
  - the fixture under the defaults and each of the fifteen non-default setting values: valid, deterministic,
    renumbering-proof;
  - the bundled plugin on the double builds and judges the `parse` and `frames` IRs as on M1, with tasks equal byte
    for byte;
  - `m2a-accept` passes every gate on each run folder, except that `--swap-reset off` and `--swap-fallback off` fail G1
    alone, on the one derived entry each rule resolves;
  - a planted fault per gate fails that gate alone; the validator's derived first-hop rule.
- The commit that adds this section:
  - the parts' pending checks are made unconditional (C's three checks that waited for B, and D's fixture checks that
    expected G6 to fail while C was a stub);
  - selftest section 10 fails on any exit but 0, and P0's stub helper `tools/test/m2a-stub.mjs` is removed;
  - the results go into this file, REWRITE §3 and §10, IR.md §9 and STATE.

### 14.3 Bugs found and fixed at the seams

- **Every non-default `--default-assignments` read threw** (`overrides.mjs`). C wrote a note for each drop that
  `assignments()` returned, including B's code-less drops (merged, default, with the entry), which only count. C's code
  now writes STALE_ASSIGNMENT and SWAP_VALUE_DANGLING notes with the detail `assignments()` returns and skips the
  code-less ones.
- **`overrides.root` counted empty-path entries too** (C), while §0.2, `m2a-accept`'s G6 and the `--expect` numbers
  count `[symbolID]` entries only, with `emptyPath` apart. D's G6 failed by 257.
- **Tasks were not equal under `parse` and `frames`** (A's request 1, B's 4, C's 5). The M1 planner copied every note on
  a record into tasks, so VARIANT_SET_REJECTED (on the set under `parse`), PROPERTY_REF_DROPPED and the per-instance
  notes changed tasks. `componentPropertyReferences`, which the M1 builder does not write, grew P's largest task by
  3 393 characters.
  - `schema.isComponentNote` names M2a's notes about components, properties and overrides.
  - `plan.mjs` leaves those notes and the bindings out of tasks.
  - `identity.mjs` does not read those notes as a record drawn differently.
- **A note on the instance's own override** (`path` []) was refused by the validator. It is now accepted, and IR.md §13
  says so.
- **G6's Figma-field balance under `--echo keep`** expected produced = carried, while C counts produced = carried + echo
  under either value. `m2a-accept` now checks that, and that the IR's override fields equal carried (plus the echoes
  under `keep`).

### 14.4 Requests from the parts

| part | request | outcome |
|---|---|---|
| A | D13 says "record for record", but tasks carried rejection notes | applied: tasks are now equal byte for byte (§14.3); D13 annotated |
| A | record the D2 choices the plan left open | applied, §14.5 |
| A | G3 under `--variant-sets frames` holds as 0 = 0 (every counter 0, `groups` included) | recorded: `m2a-accept` reads `frames` and passes G3 on it (e2e) |
| A | record §1.1's split by class under D2's order | applied: `no-equals` / `duplicate-axis` / `axis-count` / `duplicate-coordinate` are D 0 / 1 / 0 / 2, K 0 / 2 / 1 / 1, M 0 / 0 / 1 / 5, P 0 / 0 / 2 / 9; U `axis-count` 5, `duplicate-coordinate` 17, `not-symbol` 1 |
| B | the fixture's `boundLayerDiffers` comment says visible 1, text 1 | applied (visible 2, text 3), `21c6531` |
| B | record what "reached from the instance's family" means | applied, §0.2 |
| B | record the `viaAlias` and P `aliases` differences | applied, §14.6 |
| B | leave `componentPropertyReferences` out of M1 tasks | applied (§14.3) |
| C | let a derived entry start at a layer with no record | applied: it is kept without `at` (D10). The validator allows it for derived entries only; an override's first element still needs a record (IR.md §9) |
| C | `OVERRIDE_SOURCE_FIELDS`: `inheritGridStyleID` dropped `no-equivalent`; `inheritTextStyleID` also to the font fields; `stackChildPrimarySizing` → `layoutGrow`, `stackChildCounterSizing` → `layoutAlign` | applied in the table; C's local workaround removed |
| C | D17's default `outer` (or `first`) | applied: `outer`. On P's 6 conflicting texts, derived agrees with `outer` and `first` 6 of 6 and with `last` 0 of 6; `outer` equals `last` where no entry has an `overrideLevel`, as in D and K. Measured on P: `last` writes 3 fewer overrides and 16 more `root-box` drops than `outer`, and `first` equals `outer` |
| C | export `nodes.mjs` `propsOf`, so `lookOf` stops mirroring it | **rejected for M2a.** `propsOf` writes a whole record with side effects (notes, features, interned values, the planned box), so sharing it needs a quiet mode in M1's reader. E measured the mirror instead: `lookOf` on every carried non-instance record equals the record's props, field for field, on all five files (0 differences in 84 897 / 806 490 / 355 064 / 732 871 / 921 730 compared props). Handed to M2b (§12) |
| C | filter M2a's notes out of tasks | applied (§14.3) |
| C | the assignment-count protocol between B and C (G7) | checked: G7 adds up on all five files and under every fixture setting |
| C | record the numbers, the U anomalies and the folded-operand rule | applied: §14.6, §14.7, D10 |
| D | record the definitions `m2a-accept` uses | applied, §14.8 |
| D | `assignments.dangling` = `swapDangling.assignment`; `bindings.kept`, `derived.written` and `overrides.written` equal the IR's counts | checked: G7, G1 and G6 hold them, and they pass on all five files |
| D | G3's notes and stats agree | checked: G3 passes on all five files and under every fixture setting |
| D | e2e runs `m2a-accept` on the fixture, and with `M2A_PLANTS.unknownOverrideField` | applied in `21c6531` (the plant fails G6 alone) |
| D | document `run.json` and the `--expect` format | applied, §14.8 |

### 14.5 Families (part A)

D2's open choices, as built (`families.mjs` header):
- `empty` is decided first, because the name classes need a member.
- A pair with an empty axis counts as `no-equals`.
- `valuesAppended` counts only axes the vocabulary lists.
- Vocabulary values that no member uses are left out of `axes` (P 22, U 17).
- `vocabularyOrder + namesOrder = accepted`: 64 + 0, 308 + 0, 221 + 0, 342 + 6.

Measured:
- The vocabulary's axis order differs from the first member's name order in 17 / 115 / 0 / 0 accepted sets.
- `valuesAppended` is 0 on D, K, M and P (U 1).
- Under `--variant-grammar vocabulary`, P accepts 342 of 359 (the 6 extra rejections are `vocabulary`), and members of
  rejected sets become 587.
- Sets with a library identity: 62 / 180 / 226 / 347.
- The families phase takes at most 0.4 s.

### 14.6 §0.3 reconciled

| quantity | outcome |
|---|---|
| non-root entries not in derived | the first measurement's 726 / 950 / 949 / 6 563 reproduce; the second's numbers exceed them by exactly the `[symbolID]` root counts (1 849 / 20 530 / 15 053 / 35 095) |
| stale assignments on instances | the first's 130 / 2 034 / 922 / 1 851 reproduce with §0.2's "reached" (the master symbol or its state group), `no-root` and `undeclared` apart |
| stale assignments in live overrides | the first's 4 / 75 / 839 / 293 reproduce as `no-definition` + `other-family` (§14.1); K's 75 is C; the second's K 4 stays unexplained |
| refs whose field disagrees with the root's type | 0 / 0 / 0 / 94 (`type-mismatch`: chains in full, read from the symbol the id sits on, P0-1) |
| refs naming no definition | D4's classes: `no-definition` 0 / 1 / 106 / 212, `other-family` 0, `no-root` 0 / 0 / 0 / 8, `undeclared` 0 / 0 / 0 / 324 (INSTANCE_SWAP roots whose bound layers disagree and whose default names no symbol, so D5 declares nothing) |
| swaps to a variant of the same set | the first's split (to the same set 28 / 309 / 714 / 2 117, no-op 22 / 112 / 163 / 30, unresolved 24 / 135 / 0 / 5) reproduces exactly when every swap entry is counted (C); among the swaps of live entries, `sameSet` is 16 / 297 / 714 / 2 043 |
| families accepted in P | 348 / 359 under `names` (the default), 342 under `vocabulary` |
| member aliases in P | 54 727 includes the 130 state-group aliases (B) |
| bindings resolved through an alias | 824 / 3 492 / 14 169 / 27 931, against the plan's 650 / 3 294 / 13 882 / 27 412. B counts every binding whose id is an alias on the layer's own symbol (P: 334 of two hops); the planning-era rule could not be reproduced from the plan's definitions. Not gated |
| `overrideLevel` | only in override entries: M 34 entries (values 1-3), P 5 186 (values 1-4); D17 reads it |

Other measurements the parts recorded (counts only):
- **Stored derived box against the layer's own:**
  - size equal in 24 471 of 29 963 / 109 467 of 154 532 / 2 725 of 17 305 / 42 290 of 92 075 entries;
  - transform equal in 25 082 of 31 921 / 118 226 of 160 809 / 522 of 8 262 / 6 873 of 23 871.

  This supports "absent means the master's" (D10) for M and P only.
- **Derived text entries with baselines:** 3 482 of 3 489 / 19 616 of 19 624 / all 6 649 / all 51 760.
- **Swap defaults:** `swapDefaultLayersDisagree` is M 5 roots (48 layers) and P 6 (180). Undeclared swap defaults
  (SWAP_VALUE_DANGLING `default`) are 6 / 1 / 4 / 12.
- **`boundLayerDiffers`:** visible P 160 (U 196), text 0.
- **Root box, echo / `root-box`:** 2 164 / 22, 24 168 / 255, 19 691 / 413, 39 445 / 4 913.
- **Bound conflicts:** 3 / 276 / 2 / 429.
- **Written overrides** are above part C's own report (K 24 731 against 24 214). B's property values now give the bound
  fields' echo baseline (D9), and C's branch measured with B's stub.

### 14.7 U (extra check)

The kit adds no field outside `OVERRIDE_SOURCE_FIELDS`, and every balance adds up. G1 and G2 fail:
- 2 derived entries end on a layer of another symbol under a nested swap, so they resolve nowhere (4 before the
  review: 2 sat under a path with two swap entries, which resolve once the walk takes the swap the D17 merge keeps,
  §15);
- 50 stale entries resolve although derived has no entry for their path (mostly entries carrying only
  `stackChildCounterSizing`).

Both are left for M2b's render pairs (§12). The reader's rules stand on D, K, M and P, where both counts are 0.

### 14.8 Definitions `m2a-accept` uses, and the run folder

- `overrides.root` counts `[symbolID]` entries only, and `emptyPath` the empty-path ones. So entries = root +
  emptyPath + nonRoot (§1.3's row), and nonRoot = live + stale.
- `overrides.written` counts the live paths written; the IR's non-root overrides are written + `overrides.pinned` (the
  overrides written only to pin a hop, §15); the `path` [] override is in neither.
- `instances.instances` equals the IR's INSTANCE record count; G6 fails when the counters cover fewer.
- `fields.produced` = carried + echo under either `--echo` value. The IR's override fields = carried, plus the echoes
  under `keep`.
- `assignments.total` = kept + droppedWithEntry + merged + dangling + defaultDropped + Σ stale (D6), with dangling =
  `swapDangling.assignment`. `bindings.total` = kept + Σ dropped (D4), with kept = the IR's
  `componentPropertyReferences`.
- `derived.entries` = written + empty when every entry resolves; written = the IR's derived entries.
- **`run.json`** is new in the run folder, written by `pix-run`: `{format: "pix2fig.run", version: 1, irVersion,
  sha256, pix, fromIr}`. `pix` is the path of the `.pix` the IR was read from, so that `--twice` can re-read it with
  the reader settings from the IR header. It stays on the owner's machine with the rest of the run folder.
- **The `--expect` file** lives outside the repository (`assertOutsideRepo` refuses it inside): `{"format":
  "pix2fig.m2a-expect", "version": 1, "files": {"<the .pix's SHA-256>": {"label": "D", "numbers": {"G4.noDefinition":
  124, …}}}}`.
  - Every number names a gate metric (`m2a-accept.mjs` `METRICS`) and is compared with it; an unknown metric is
    refused.
  - A file not in it prints as "unlabelled", and its G4 reads n/a.
- A run folder of IR version 2 is refused before anything is written, naming the M1 commit that can resume it
  (cfa3e65).

### 14.9 What M2b can rely on

- **Families:**
  - every accepted set is a COMPONENT_SET record with a `sets` entry whose axes and values are in D2's order;
  - every member's `variant` names one value per axis, and no two members share a coordinate;
  - every rejected group is a FRAME with one VARIANT_SET_REJECTED note, and its members are standalone components;
  - sets carry library identity as components do.
- **Properties:**
  - roots only, keyed by (family, root id), each with its root's type, name and a default that resolves (an
    INSTANCE_SWAP root with no default the IR can reference is not declared);
  - member-owned roots are lifted to the set; preferred values are `{type, componentKey, guid?}`;
  - every kept binding names a declared root of the layer's family, with the field of that root's type;
  - every assignment on an instance or an override names its target's family by root id, with a value of the root's
    type. Nothing is matched by name.
- **Overrides:**
  - every override is live (its path resolves and is in derived), one per path, or a pinned swap (§15) that makes the
    IR show the symbol Pixso drew where the kept data would give another;
  - `at` holds record indices along the post-swap path, so M2b computes Figma ids without a resolver;
  - fields are closed to `OVERRIDE_FIELDS` and the target's type, each with its P13 class, and echoes are gone
    (`--echo drop`);
  - the instance's own look is the `path` [] override, and its box is the record's.
- **Derived entries** carry Pixso's stored box sparsely, `lines`, `oracleSides`, and geometry where it changed, each
  with `at` where every element has a record.
- **Every loss is counted**, with a note class and in `stats.m2a`. The balances G6 and G7 add up, and nothing about
  components reaches M1's tasks.
- **Not settled offline** (§10, §12): rules A, B and C; the D17 default beyond P's 6 texts; "absent derived means the
  master's"; the echo baseline of bound fields; U's 52 anomalies; the instance pass's time; `lookOf` mirroring
  `propsOf` (equal today, measured, not shared code).

## 15. Review of the build (2026-10-06)

A skeptical review of branch `claude/m2a` against this plan and REWRITE §3 and §10, hunting for overrides or
assignments dropped without a code, a resolver that resolves a path to what Pixso did not draw, a family accepted with
a broken axis, type mismatches between definitions and bindings, nondeterminism, M1 regressions and hygiene. Every
finding was reproduced on the files (counts only; the probes stay outside the repository), and every fix carries a
fixture test that fails on the code before it (plants in `tools/test-m2a-instances.mjs`, and
`M2A_PLANTS.ruleCInMaster` for P's shape of rule C). Counts are D / K / M / P, then U.

| # | severity | finding | fix |
|---|---|---|---|
| V1 | medium | **Rule C's ignored assignment stayed in the IR.** In P all 36 resolutions through rule C ignore one of two assignments that sit on entries of one instance inside a master, not on the instance itself; the fixture's case had them on the instance. Pixso applied them in the master, so they stay there, `ignored` was 0, and the 18 instances (13 on user pages) would have shown a swap Pixso did not draw, above derived `at` indices resolved for the declared symbol | each such instance pins the hop with a swap override to the declared symbol (D7 rule C's review note; the SWAP_ASSIGNMENT_IGNORED note says so): 36 in P, 18 in U. `overrides.swaps.pinned` counts pins, `overrides.pinned` the overrides written only for one, and G6 reads the IR's non-root overrides as written + pinned |
| V2 | medium | **Rule 2 and assignments() disagree on what an assignment reaches.** Rule 2 matches a swap assignment by its root anywhere in the definition scope, and the derived paths below such a hop resolve only under the swap; assignments() keeps only §0.2's "reached" ids (the master and its state group) and drops the rest `other-family`. Where no kept assignment gives the same symbol, M2b would build another one there: P 1 hop, U 8 (in M and K a kept assignment gives the same symbol) | pinned the same way; G4's counts do not change. `properties.mjs` exports `keeps()`, B's rule without its counters |
| V3 | medium | **Duplicate entries read in stored order where the IR merges them by D17.** The echo baseline through a master's instance laid its entries latest-wins (P: 55 paths inside masters where that is not what `outer` keeps), so an outer override equal to the latest value was dropped as an echo though M2b builds the merged one; rule 1 took a holder's last swap entry while the IR writes the merged one (U: 2 paths, which derived resolves only under `outer`'s choice, so U's unresolved derived entries fall from 4 to 2; 0 in D, K, M, P); rule 2 read each duplicate entry as its own pool (0 in the five files) | all three read one path's entries in merge order. U's two swaps are the first evidence for D17's default beyond P's 6 texts: derived agrees with `outer` on both |
| V4 | low | **A removal vanished without a code.** A translated field whose only effect is to remove a prop the target has (a style detached or naming none, `maxLines` cleared, per-side weights made uniform) produced no Figma field: 4 / 243 / 241 / 775 removals, most of them carried by a written companion field | uniform sides and corners are written through `strokeWeight` and `cornerRadius`; a style or `maxLines` removal counts as carried when `fills`, `strokes`, `effects`, a text field or `textTruncation` is written; any other drops its Pixso field `no-equivalent` (D8's review note): 2 / 44 / 1 / 84, U 327 (`inheritFillStyleID`, `inheritStrokeStyleID`, `inheritEffectStyleID`, `maxLines`) |
| V5 | low | **The bound-field baseline read dropped assignments.** It took any assignment whose id reaches the root in the scope, including ids assignments() drops `other-family` (read 0 / 15 / 4 / 3 times; no echo arose from them on the files) | the baseline uses assignments()'s reach (D9's review note) |
| V6 | low | **Rule C on one hop, the same assignment applied on another.** In U one instance's own swap assignment is ignored on one nested instance and applied on another bound to the same property; dropping it (`ignored`) took the swap from the second hop, whose override kept `at` indices in the swapped symbol. A path through a hop rule C draws declared could also resolve under the ignored swap (0 in the five files) | a hop decided by a dropped assignment, or through a binding the IR drops, is pinned (U 1; D, K, M, P none); a path that resolves only under a swap rule C ignored at an earlier hop does not resolve |

Checked and found sound: no instance has stored children, so a path never matches a layer inside a nested instance;
`at` agrees with what M2b will see on every override and derived entry of all five files after the fixes (an
independent walk of the IR: swap override, then swap property, then the declared master, with rule B; it found V6's
override on U); no assignment or swap of a live entry is
dropped without a note on any of the five files; accepted sets have no empty value, no repeated axis and no value with
`=`; G5 holds by construction and on the files. `pix-run --dry --no-pixso` prints the same preflight and balances as
master on D, K, M and P, two reads give the same IR bytes on all five, and selftest passes.

Left open, each a decision rather than a defect:
- **Empty variant values** (`Size=`) are accepted; 0 in the five files. Whether Figma takes an empty value is P22's.
- **Another member's lifted root.** An assignment to a member-owned root that another member of the set owns is
  stale `other-family` by §0.2 (D 3 of 6, K 30 of 1 719). It is bound only in that member, so nothing drawn changes,
  but Figma's set has the property and keeps a value across a variant switch.
- **No-op translations.** A translated field whose Figma fields are absent on both sides (a root `inheritFillStyleID`
  naming no style on a master root that has none: P 15 244) is counted translated and writes nothing; it changes
  nothing, so it is not a loss, but G6 cannot tell it from one.

Commits of the review, on top of `e1b8145`: `0192405` (V1), `0c51b9b` (V4), `34e2ea6` (V5), `382068b` (V2), `8943c3d`
and `2f0959a` (V3), `5be412a` (V6), and the commit that adds this section.

**Master's U fixes merged** (PR #8, `docs/M1.md` §15.13), in the merge commit after `747e308`. IR version 3 keeps what
they added to version 2: the `boolean-operands` class of VECTOR_ORACLE_DIFFERS (in `NOTE_CLASSES` after the vector
classes; the validator holds such a note to a BOOLEAN_OPERATION record with its stored result), the reader's
`vectors.vertexRadiusZero`, `thinStrokes` and `staleBooleans`, and the judge's `booleanOperands` class. After the merge
`m2a-accept --expect --twice` prints the same gates and numbers on all five files as before it, and
`pix-run --dry --no-pixso` prints the same preflight and balances as master (`5dfdb4c`) on all five.
