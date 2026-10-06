# M2a: the component IR, offline

Status: **plan, first edition (2026-10-06).** It implements the M2a row of `docs/REWRITE.md` §10: "IR for
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
  entries** are a separate population (D6) and are not in REWRITE's 130 and 2 034.
- **Path space**: guidPath elements are **local guids** of the stored copies, never `overrideKey`s. Every hop of every
  live entry matches by local guid; looking hops up by `overrideKey` makes 7 stale K overrides resolve, wrongly.

### 0.3 Where the two measurements disagree, and why

The second measurement did not reproduce REWRITE's denominators or stale-assignment counts. Each difference is a
definition, not a fact about the files; part C (or B) reconciles each in its pull request and E records the result here.

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
- The M1 planner strips `instance` from tasks; `BUILT_TYPE` has no COMPONENT_SET, so a task carrying one is refused;
  both population codes (`populations.mjs`, `plan.mjs` `derivePopulations`) recognise a state group only as a FRAME.
  M has one state group on a user page, D 5, K 83 (I: 67 − 62 and 312 − 229 from M1 §1.3).
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

Rejected sets are on the internal canvas in M and P, on both kinds of page in D and K.

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
name components by a 40-hex `componentKey` string with no `publishFile`, never by guid.

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
`size` 40, strokes 17, `layoutGrids` 8, border weights 3. Override fields seen: `inheritFillStyleID`, `fillPaints`,
`size`, `vectorPaints`, `vectorStyles`, `visible`, `proportionsConstrained`, `name`, `textData`, the `stack*` auto-layout
fields, the `rectangle*CornerRadius` fields, `componentPropAssignment`, `overriddenSymbolID`, `prototypeInteractions`;
P also `variableConsumptionMap` 5 293, `overrideLevel` 5 186, `fontVariations` 4 482, `pluginData` 3 894 and
`stackChildCounterSizing` 61 651. An instance's own stored props differ from its master root's (raw counts, I):
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
| D2 | **Families.** The coordinate lives in the member names (REWRITE §3), so the names decide acceptance (`--variant-grammar names`); the vocabulary only orders. Axis order: the vocabulary's when it lists exactly the names' axes, else the first member's name order. Value order per axis: the vocabulary's, then values it lacks in member order (counted, `stats.m2a.families.valuesAppended`). Rejection classes, in this order, the first that applies: `no-equals` (a pair with no `=`), `duplicate-axis` (one name repeats an axis), `axis-count` (members name different axis sets), `duplicate-coordinate`, `vocabulary` (only under `--variant-grammar vocabulary`), `empty` (no SYMBOL member), `not-symbol` (a member that is not a SYMBOL; 0 measured). An accepted group becomes a **COMPONENT_SET record** with a `sets` entry; a rejected one stays a FRAME whose members are standalone components, with one VARIANT_SET_REJECTED note by guid whose detail starts with the class. `--variant-sets frames` keeps M1's D7 (no sets, no notes), for comparison with M1 runs | names are what Figma reads too; P's 6 vocabulary disagreements would otherwise reject sound sets |
| D3 | **Property roots.** A definition index per owner (state group or SYMBOL) maps every definition id to its root by following `parentPropDefId` to 0:0, any number of hops, inside the family. A family declares its **roots only**: on the set for an accepted set, on the SYMBOL for a standalone component, and, for a member of a rejected set, the set's roots copied onto the member's own family (same ids, keyed by the member). Type, name and default come only from the root (BOOL → BOOLEAN, TEXT → TEXT, INSTANCE_SWAP → INSTANCE_SWAP; a COLOR root is not declared and is noted SOURCE_FEATURE_UNSUPPORTED "COLOR property", 0 measured). Definitions are written in `sortPosition` order, then by id. An alias whose chain leaves its family or ends in no definition (P: 2 member aliases, 11 + 25 set aliases) makes every reference and assignment through it unresolved (D4, D6). A root with an empty name is declared with its name as stored and counted (`stats.m2a.properties.unnamedRoots`; Figma needs a name, M2b decides) | REWRITE §3; validator: no member declares properties |
| D4 | **Bindings** (`componentPropRef` → `componentPropertyReferences`, IR.md §7). VISIBLE → `visible`, TEXT_DATA → `characters`, OVERRIDDEN_SYMBOL_ID → `mainComponent`, each to the **root id** of a definition of the enclosing definition's family. Dropped, with one PROPERTY_REF_DROPPED note per record and class (detail: class, then the count): `fill-style` (INHERIT_FILL_STYLE_ID: Figma has no such property, and every one names no definition: 1 101 / 5 232 / 17 370 / 34 903), `no-definition`, `other-family`, `no-root` (D3), `type-mismatch` (the field's type is not the root's: 0 / 0 / 0 / 94). Never matched by name | acceptance "no property … with a type other than its root definition's" fails on P without a code |
| D5 | **INSTANCE_SWAP values.** Rule A (D7) for resolution, and in the IR: an assignment whose value names no SYMBOL in the file is dropped with SWAP_VALUE_DANGLING `assignment` (36 / 4 / 137 / 264). **Defaults** (`--swap-default layer`): a root's default is the declared symbol of the INSTANCE layers bound to it, where they all agree; otherwise the definition's `initialValue` when it names a SYMBOL; otherwise the property is not declared and its bindings drop (PROPERTY_REF_DROPPED `no-root`), noted SWAP_VALUE_DANGLING `default`. A default taken from the layers that differs from `initialValue` is counted (`stats.m2a.properties.swapDefaultFromLayer`). `--swap-default definition` uses `initialValue` first. **Preferred values** become key references `{type: COMPONENT\|COMPONENT_SET, componentKey, guid?}` (Figma's own shape): `guid` is filled when the key names a library copy (or, for STATE_GROUP, a set) in the file; keys not in the file are kept by key for M3's kit map, never refused | measured: using `initialValue` when nothing is assigned breaks 4 336 D and 263 K derived entries, because the bound layer's declared symbol already holds the default; Figma requires a resolvable default |
| D6 | **Assignments.** An instance's `properties` hold assignments to its master's family by root id. Stale, never matched by name, one STALE_ASSIGNMENT note per assignment, detail class first: `no-definition`, `other-family`, `no-root`. Assignments in a live override entry are judged against the **effective** family of the nested instance the entry targets (after swaps, D7): stale ones get class `nested` (4 / 75 / 839 / 293). Assignments inside a stale entry go with their entry (counted in OVERRIDE_STALE's detail). An assignment equal to the root's default is kept (writing it is harmless, P9b) | REWRITE §3; validator refuses cross-family assignments |
| D7 | **The resolver** (below this table). Local guids only; outer swaps win; rules A, B and C | §1.3: exact on all four with A and B, and on P's derived entries with C |
| D8 | **Overrides.** Root entries (D 2 106, K 20 530, M 15 053, P 35 095) become one override with `path` [] per instance: the instance's own look. Non-root entries are kept only when live; stale ones get OVERRIDE_STALE (class `not-derived`, or `unresolved` for a path in derived that does not resolve, 0 with A and B). Duplicate paths merge into one entry (`--override-merge`, D17), noted OVERRIDE_PATHS_MERGED once per instance with the conflicting field count. Pixso fields translate to a **closed** table of Figma fields (`OVERRIDE_FIELDS`, §5.1) with the M1 translators run in partial mode (only the fields present, no defaults written): paints, strokes and side weights, corner fields, effects, opacity and blend, `visible`, `name`, `textData` → `characters` plus `textRanges`, `size` → `width`/`height`, transform → `relativeTransform`, `stack*` → the frame and child layout props, `stackChild*Sizing` → `layoutSizing*`. A style reference resolves as on nodes (IR.md §7: the style's value wins, STYLE_VALUE_DIFFERS / STYLE_MISSING_IN_SOURCE with the note's `path`). `overriddenSymbolID` → `swap`; `componentPropAssignment` → `properties`. Fields with no Figma equivalent are dropped with OVERRIDE_FIELD_DROPPED, detail the Pixso field: `vectorPaints` and `vectorStyles` (region fills cannot be overridden on a sublayer, I), `variableConsumptionMap` (M5), `fontVariations`, `pluginData`, `prototypeInteractions`, `proportionsConstrained`; `overrideLevel` is consumed by the merge, not dropped. An entry left with nothing to apply is dropped (`stats.m2a.overrides.emptyAfterTranslation`) | REWRITE §3; IR.md §9 "one entry per path"; P13 |
| D9 | **Echo** (`--echo drop`). A field of a live entry is an echo when its translated value equals, as canonical JSON with IR rounding, the value the target layer has without this entry: the layer's record value (with DEFAULTS for an absent prop), changed by the overrides of the masters' own nested instances along the path (unless a swap reset them, rule B). Echo fields are dropped, one OVERRIDE_ECHO note per instance (detail: count and field names; per field counts in stats). `--echo keep` keeps them and counts the same | P9b: an equal write creates no override, so dropping is safe, and it saves writes |
| D10 | **Derived entries** are carried as stored, sparse: `size` and `transform` only when stored (absent means "the master layer's", I, part C measures it, §6 C), `lines` from baselines where the entry stores them, `oracleSides` from `strokePaddingPath` (M1 D15's oracle, inside instances), and geometry under `--derived-geometry changed`: `fillGeometry` and `strokeGeometry` only where they differ from the target layer's own stored geometry. Each entry and each override carries `at`: the IR record index of every path element, so neither the planner nor the plugin needs a resolver. An element with no record (a folded operand, a degenerate node) gives no `at`: a derived entry is then kept without it and counted; an override field on it is dropped with OVERRIDE_FIELD_DROPPED `layer-not-carried` | M2b's verifier compares every sublayer; the 2 975 lost borders inside instances need the oracle; P's IR size (§11) |
| D11 | **Instance extras.** `exposed: true` for `propsAreBubbled` (Figma's `isExposedInstance`); `scale` for `uniformScaleFactor` ≠ 1 (P10 decides how M2b uses it). The instance's own stored look is **not** carried beside its root override (`--instance-own overrides`): the record keeps box and child layout (KNOWN_PROPS.INSTANCE unchanged), the look is master root plus the `path` [] override, and own props that differ from that are counted (`stats.m2a.instances.ownDiffers`, I). `--instance-own own` writes those differences into the `path` [] override instead | Pixso's node paints are a cache (M1 §15.9 for styles); which one Pixso draws is a render-pair question for M2b |
| D12 | **Scope.** Under `--scope pages:`, the closure that pulls in each instance's master (M1) also pulls in swap targets, INSTANCE_SWAP values and defaults, and the masters of nested instances along live paths | no dangling reference in a scoped IR |
| D13 | **The M1 path keeps working on IR v3.** `BUILT_TYPE.COMPONENT_SET = "FRAME"` (the M1 builder draws an accepted set as M1 D7 drew the state group); both population codes treat a COMPONENT_SET like the state-group frame; tasks keep stripping `instance`. M2b changes `BUILT_TYPE.COMPONENT_SET` to `"COMPONENT_SET"` | M1's gates must still pass; M2b builds components |
| D14 | **Library identity is unchanged** (IR.md §8). P's 802 user-page `overrideKey`s are carried on their records as today; their meaning is M3's | REWRITE §5 |
| D15 | **Note volume.** A note is per record, per path or per assignment as stated above, except OVERRIDE_ECHO (per instance) and PROPERTY_REF_DROPPED (per record and class), whose counts sit in the detail and in `stats.m2a` | P alone would add about 70 000 echo notes |
| D16 | **IR version 3**, one bump for all of M2a, in P0; the validator knows only 3. Existing v2 run folders are not migrated (§11) | IR.md §15 |
| D17 | **Duplicate merge** (`--override-merge last`): entries of one path merge in stored order, a later field value winning. `first` keeps the earliest; `outer` lets the lowest `overrideLevel` win, then the latest. Part C measures which rule agrees with `derivedSymbolData` on P's `size` (337) and `textData` (1 074) conflicts, the only conflicting fields derived can check, and E sets the default from that count before acceptance | 81 294 conflicting field values in P, unverified (I) |

**D7: the resolver** (`tools/pix/ir/resolve.mjs`). Input: an instance node and a guidPath. Start at the instance's
`symbolData.symbolID`. A root entry (path `[symbolID]`, or empty) addresses the instance itself and resolves. Otherwise
each element is looked up **by local guid** among the stored descendants of the current symbol (a symbol-guid prefix at
an instance boundary is tolerated; never measured). Every element but the last must be a nested INSTANCE, whose
**effective symbol** is decided in this order:

1. an `overriddenSymbolID` on an entry of **any** instance of the chain (instances inside masters count) whose path,
   relative to that instance, equals this node's path; the **outermost** wins;
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
SWAP_ASSIGNMENT_IGNORED note with the count. Applied without the derived guard it would make 1 stale override resolve
in D and 1 in K, so it is never applied to a path absent from derived.

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
| duplicate paths | `--override-merge` | `last`, `first`, `outer` | `last`, until part C's measurement (D17) | D8, D17 | |
| echo fields | `--echo` | `drop`, `keep` | `drop` | D9 | |
| the instance's own look | `--instance-own` | `overrides`, `own` | `overrides` | D11 | |
| derived geometry | `--derived-geometry` | `changed`, `all`, `none` | `changed` | D10 | |

Not settings, because a measurement rules the alternative out: guidPaths in local guids (never `overrideKey`), outer
swaps winning over inner ones, definitions keyed by (family, id) and never by name, type and default from the root.

## 4. Data flow

```
.pix ─readPix─▶ pixToIR
                 plan (M1) ── families (A): which state groups are sets; record type COMPONENT_SET
                          ── propIndex (P0): definitions per owner, alias chains, roots
                          ── properties (B): family roots, bindings, defaults, preferred keys, assignments, stale
                          ── resolve (C): effective symbols, paths, derived index (rules A, B, C)
                          ── overrides + derived (C): root override, live entries, merge, translate, echo, at[]
                 emit (M1 + hooks) ─validate (IR v3)─▶ IR + stats.m2a
pix-run --dry --no-pixso (D): M1 plan on IR v3 (COMPONENT_SET drawn as FRAME), the M1 balance, the M2a block
m2a-accept (D): the gates of §8 from the run folder(s)
```

## 5. Contracts (part P0, merged before any parallel work)

### 5.1 IR version 3 (`tools/ir/schema.mjs`, `tools/ir/props.mjs`, `tools/ir/validate.mjs`, `tools/test-ir.mjs`, `docs/IR.md`)

- `VERSION = 3`; IR.md title, §4, §15 and the example (`"version": 3`, the new header settings, a COMPONENT_SET with an
  axis, a member alias mapped to its root, an override with `at`, a root override `path` [], a sparse derived entry, a
  preferred key reference).
- **Header settings** gain the eleven keys of §3, each enum checked, `SETTING_DEFAULTS` holding the defaults.
- **Overrides** (`instance.overrides[]`): `{path, at?, fields?, swap?, properties?}`.
  - `path` [] is the instance itself, at most one per instance, and takes no `swap` (an instance's master is its
    `master`); its `fields` are checked against `KNOWN_PROPS.COMPONENT` (the master root's type).
  - `at`: the IR record index of each path element, same length as `path`; required when the instance's master is a
    record in this IR and every element has a record (D10). Checked: `nodes[at[k]].guid === path[k]`; `at[0]` inside
    the master; every `at[k]` but the last is an INSTANCE record; every `at[k+1]` lies inside a COMPONENT record.
  - `fields` are **closed** to `OVERRIDE_FIELDS` (new in `props.mjs`: field → kind, the kinds of `KNOWN_PROPS`, plus
    `name: str`), and, where `at` is given, to the target record type's `KNOWN_PROPS` plus `name`. Text fields include
    `textRanges` (own, checked as on a record against the override's own `characters` or the target's).
  - `OVERRIDE_FIELD_CLASS` (new, `props.mjs`): each field's P13 class, which the planner and M2b read:
    `applies` (fills, fillStyle, strokes, strokeStyle, strokeWeight, strokeWeights, strokeAlign, effects, effectStyle,
    opacity, blendMode, name, cornerRadius, cornerRadii, visible, characters, fontSize, textAutoResize; C, P13),
    `unprobed` (textRanges, fontName, letterSpacing, lineHeight, textStyle, the text alignments, the frame layout and
    child layout props, clipsContent, dashPattern, strokeJoin, strokeCap; A until M2b's P13b), `refused` (width,
    height, relativeTransform, constraints; C, P13: kept, counted OVERRIDE_FIELD_UNSUPPORTED by the planner).
  - "One entry per path" stays; the reader merges (D17).
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
  | STALE_ASSIGNMENT | read | (existing) | `no-definition`, `other-family`, `no-root`, `nested` |
  | OVERRIDE_STALE | read | (existing) | `not-derived`, `unresolved` |
  | OVERRIDE_ECHO | read | (existing; one per instance) | — |
  | PROPERTY_REF_DROPPED | read | a layer's binding to a component property that is not carried; never matched by name | `fill-style`, `no-definition`, `other-family`, `no-root`, `type-mismatch` |
  | SWAP_VALUE_DANGLING | read | an INSTANCE_SWAP value or default naming no component in the file; skipped (rule A) | `assignment`, `default` |
  | SWAP_ASSIGNMENT_IGNORED | read | a swap assignment Pixso's derived data shows was not applied; the declared symbol is used (rule C) | — |
  | OVERRIDE_PATHS_MERGED | read | override entries of one path merged into one (D17) | — |
  | OVERRIDE_FIELD_DROPPED | read | an override field with no Figma equivalent, or on a layer that has no record; the detail starts with the Pixso field name or `layer-not-carried` | — |

  `SOURCE_FEATURE_UNSUPPORTED`'s open list gains "COLOR property". Notes with a `path` name the instance by `node`.
- **Not changed:** the node record keys, `KNOWN_PROPS.INSTANCE`, library identity, styles, images, fonts.

### 5.2 Task contract (`tools/ir/task.mjs`, `tools/test-m1-contract.mjs`)

`TASK_IR_VERSION = 3`; `BUILT_TYPE.COMPONENT_SET = "FRAME"` (D13). Nothing else: tasks still carry no `instance`
data. The bundled plugin is regenerated; `figma-plugin/src/**` is not edited. `test-m1-contract` checks both.

### 5.3 The reader seam (`tools/pix/ir/index.mjs`, `nodes.mjs`, `components.mjs`)

P0 wires five hooks into the M1 reader, each in its own module, each a stub with its frozen contract in its header,
so the parts never edit the seam:

```
families.mjs   (A)  familyIndex(cx) -> { setOf(symbolGuid) -> stateGroupGuid|null, accepted: Map(groupGuid ->
                    {axes:[{name, values}], variant: Map(symbolGuid -> {axis: value})}), rejected: Map(groupGuid -> class),
                    recordType(n, planned) -> "COMPONENT_SET"|planned }
                    stub: every state group accepted when its members' names parse trivially (no rejection)
propindex.mjs  (P0, implemented) propIndex(cx) -> { defsOf(ownerGuid), rootOf(familyGuid, defId) -> def|null,
                    why(familyGuid, defId) -> "root"|"alias"|"no-definition"|"other-family"|"no-root" }
properties.mjs (B)  propertiesOf(cx, familyGuid) -> [definition]; bindingsOf(cx, n, i) -> componentPropertyReferences|null;
                    assignments(cx, familyGuid, raw[], {nested}) -> {kept:[{family,id,value}], stale:[{class, defId}]}
                    stub: no properties, no bindings, every assignment kept unmapped
resolve.mjs    (C)  makeResolver(cx) -> { resolve(instanceNode, guids) -> {ok, root, elements:[{n, i, symbol, via}],
                    resets, fallback} | {ok:false, at, why}; effectiveSymbol(chain, node); inDerived(instanceNode, guids) }
                    stub: first hop only
overrides.mjs  (C)  instanceData(cx, n, i, master) -> instance data (properties, overrides, overrideBasis, derived,
                    exposed, scale); stub: { master }
```

`propindex.mjs` is implemented in P0 (about 120 lines), as M1's P0 implemented `pathgeom.mjs`, because B and C both
need alias roots before either merges; B owns it afterwards. `index.mjs` calls `familyIndex`, then `propIndex`, then
the resolver, before `emit`; `emit` asks `recordType`, `bindingsOf` and `instanceData` per record and writes `sets`
from A's index and components' `set`, `variant` and `properties` (B). `index.mjs` also writes `stats.m2a` (§6 D's
shape, frozen in its header) from counters each module fills on `cx.m2a`, and extends the scope closure (D12).
`populations.mjs` treats a COMPONENT_SET like the state-group frame (D13).

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
- **entries**: a root entry `[symbolID]` and an empty-path one; duplicate paths with a conflicting field and differing
  `overrideLevel`; echo fields (direct, and through a master's nested-instance override); dropped fields
  (`vectorPaints`, `pluginData`); a text override with a style table; a size override; a style reference in an
  override; an override on a folded boolean operand;
- **derived**: sparse entries (no transform, no size), entries with `strokePaddingPath` and with baselines, an instance
  whose master has no children (no derived data); a scaled instance; an exposed nested instance.

Every key in it is computed at run time from a label (as M1's image hashes are), so `test-hygiene.mjs` needs no new
allowed value. The existing `test-pix` and `test-irread` checks keep passing; P0 adjusts `test-irread`'s D7 checks
to run under `--variant-sets frames` (§9).

### 5.5 Selftest

`tools/selftest.mjs` gets section 10: `test-m2a-families.mjs` (A), `test-m2a-props.mjs` (B), `test-m2a-instances.mjs`
(C), `test-m2a-run.mjs` (D) and `test-m2a-e2e.mjs` (E), each committed by P0 as a stub printing `pending: part X`
with the checks it must hold listed in its header.

**P0 is done when** selftest passes with the stubs, the reader on the fixture writes a valid v3 IR, M1's e2e
(`test-m1-e2e.mjs`) passes unchanged on it, and `pix-run --dry --no-pixso` on D, K, M and P gives M1's balances.

## 6. Parallel parts (separate worktrees, disjoint files, §9)

### A: families (about 450 lines, I)

- **Owns:** `tools/pix/ir/families.mjs`, `tools/pix/ir/components.mjs`, `tools/pix/ir/populations.mjs`,
  `tools/test-m2a-families.mjs`.
- **Rules:** D2 and D13. The grammar, the axis and value order, the classes in their order, `--variant-sets`,
  `--variant-grammar`, `--axis-order`. A COMPONENT_SET keeps the state group's props (FRAME's `KNOWN_PROPS`). A set's
  `library` comes from the state group's `publishFile` and `publishID` (and `componentKey`) as for components.
  `stats.m2a.families = {groups, accepted, rejected: {class: n}, rejectedMembers, valuesAppended, vocabularyOrder,
  namesOrder}`.
- **Tests:** each fixture set's outcome under each setting; members of a rejected set standalone with the note's
  class; axis and value order; byte-identical IR twice; populations with a COMPONENT_SET on the internal canvas and on
  a user page; the validator's coordinate checks on the result.
- **Done when** its test passes and, on D, K, M and P, accepted and rejected by class equal §1.1 (P 348 under `names`,
  342 under `vocabulary`), and the M1 balance still adds up.

### B: properties (about 700 lines, I)

- **Owns:** `tools/pix/ir/properties.mjs`, `tools/pix/ir/propindex.mjs` (after P0), `tools/test-m2a-props.mjs`.
- **Rules:** D3 to D6. Roots only; rejected-set members get copies; bindings with their classes; defaults by
  `--swap-default`; preferred key references; assignments with their classes, nested ones through C's effective family
  (C calls `assignments(…, {nested: true})`). `stats.m2a.properties = {roots, aliases, viaAlias, unnamedRoots,
  bindings: {kept, dropped: {class: n}}, swapDefaultFromLayer, swapDangling: {assignment, default},
  preferred: {inFile, byKeyOnly}, assignments: {kept, stale: {class: n}}}`.
- **Tests:** every fixture property case under both `--swap-default` values; the validator accepts every declared
  type as its root's; a binding is never resolved by name (a planted same-name definition in another family stays
  dropped); the renumbered fixture enums give the same IR.
- **Done when** its test passes and on D, K, M and P: stale assignments on instances 130 (124 + 6), 2 034 (315 +
  1 719), 922 (96 + 826), 1 851 (321 + 1 530); `type-mismatch` 0 / 0 / 0 / 94; `fill-style` 1 101 / 5 232 / 17 370 /
  34 903; every other difference from §1.2 explained in the pull request (§0.3's rows are B's and C's to reconcile).

### C: instances — resolver, overrides, derived (about 1 400 lines, I)

- **Owns:** `tools/pix/ir/resolve.mjs`, `tools/pix/ir/overrides.mjs`, `tools/pix/ir/derived.mjs`,
  `tools/ir/props.mjs` (after P0: `OVERRIDE_FIELDS`, `OVERRIDE_FIELD_CLASS`), `tools/test-m2a-instances.mjs`.
- **Rules:** D7 to D11 and D17; the translators of M1 (`paints`, `strokes`, `layout`, `text`, `styles`) are called in
  partial mode through new exports C requests from their owner's code only if a signature must change (listed in the
  pull request; E folds it in). `stats.m2a.instances = {instances, noDerived, exposed, scaled, ownDiffers}`;
  `stats.m2a.overrides = {entries, root, emptyPath, nonRoot, live, stale: {class: n}, inDerivedUnresolved,
  merged: {paths, conflicts}, fields: {carried, echo, dropped: {field: n}, byClass: {applies, unprobed, refused}},
  emptyAfterTranslation, swaps: {override, property, sameSet, noOp, unresolved}}`; `stats.m2a.derived = {entries,
  resolved, viaFallback, unresolved, noTransform, noSize, withLines, withOracleSides, geometry, notCarried}`.
- **Measurements C records in its pull request (counts only):** the merge rule against derived (D17); for derived
  entries **with** a transform or size, how often it equals the target layer's own (composed through nested masters):
  rare equality supports "absent means the master's" (D10, I); how many derived `textData` entries carry baselines;
  the reconciliation of §0.3's override rows; reader time per new phase on P.
- **Tests:** every fixture path, swap and entry case, each rule switched off once (`--swap-dangling strict`,
  `--swap-reset off`, `--swap-fallback off`) failing exactly its case; `at` indices; echo through a nested master's
  override; a field never echoed against the wrong (pre-swap) master; merge rules; dropped and refused fields;
  `--derived-geometry` each value; `--instance-own own`; byte-identical twice.
- **Done when** its test passes and on D, K, M and P: derived 35 808 / 35 808, 160 982 / 160 982, 86 941 / 86 941,
  342 679 / 342 679 with 36 via rule C; live / stale 6 353 / 726, 42 456 / 950, 52 982 / 949, 107 190 / 6 563 with
  no entry live outside derived or stale inside it; the override and field balances of §8 add up.

### D: run, stats and acceptance (about 600 lines, I)

- **Owns:** `tools/ir/plan.mjs` (`derivePopulations` with COMPONENT_SET; the instance strip covers the new keys),
  `tools/pix-run.mjs` and `tools/pix-to-ir.mjs` (the eleven flags of §3; an "M2a" block in the `--dry` print),
  `tools/m2a-accept.mjs` (new), `tools/test-m2a-run.mjs`, `tools/test-pixrun.mjs` (adjustments only).
- **`m2a-accept <runDir>… [--expect <private json>] [--twice]`** prints the gates of §8 from each run folder's
  `stats.json` and `ir.json`; `--twice` re-reads the `.pix` and compares the IR's SHA-256; `--expect` takes the
  owner's per-file numbers from a file outside the repository (`assertOutsideRepo`), because a file label cannot be
  derived from the file without naming it. Exit 0 only when every gate passes.
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
  on the double (M1's path, COMPONENT_SET drawn as a FRAME) → judge → M1's verdict reads as before; `m2a-accept` on
  the fixture's run folder passes every gate; a planted fault per gate fails it.
- **Merge order:** P0; then A, B, C and D in any order; then E. C's nested-assignment and echo checks print `pending: B`
  until B merges, and B's rejected-set copies `pending: A` until A merges; E re-runs them.

## 8. Acceptance (`m2a-accept`)

Every gate is structural, so it holds on any file; the per-file numbers below are what the gates print on D, K, M and P
(C for D and K from REWRITE, C for M and P from §1, both under the default settings).

| gate | FAIL when | D | K | M | P |
|---|---|---|---|---|---|
| G1 derived | a derived entry neither resolves nor is in a named class (SWAP_ASSIGNMENT_IGNORED) | 35 808 / 35 808 | 160 982 / 160 982 | 86 941 / 86 941 | 342 679 / 342 679 (36 via rule C) |
| G2 live ⇔ derived | a non-root entry resolves and is absent from derived, or is in derived and does not resolve | 6 353 / 726 | 42 456 / 950 | 52 982 / 949 | 107 190 / 6 563 |
| G3 families | accepted + rejected by class ≠ state groups, or a rejected set's member is not standalone | 64 / 67 | 308 / 312 | 221 / 227 | 348 / 359 |
| G4 stale assignments | an assignment is neither kept nor in a class; the four classes printed | 130 (124 + 6), nested 4 | 2 034 (315 + 1 719), nested 75 (I) | 922 (96 + 826), nested 839 | 1 851 (321 + 1 530), nested 293 |
| G5 property types | a declared property is not a root, or its type is not the root's; a kept binding whose field is not its root's type | 0 | 0 | 0 | 0 (94 dropped `type-mismatch`) |
| G6 override balance | entries ≠ root + live + stale; live fields ≠ carried + echo + dropped | adds up | adds up | adds up | adds up |
| G7 assignment and binding balances | assignments ≠ kept + stale by class + dangling + inside stale entries; refs ≠ kept + dropped by class | adds up | adds up | adds up | adds up |
| G8 determinism | two runs differ in one byte; the renumbered fixture gives another IR | — | — | — | — |
| G9 M1 unchanged | the M1 balance does not add up on IR v3, or M1's e2e fails | — | — | — | — |
| G10 validity | `validate(ir)` reports an error | — | — | — | — |

Printed beneath, never gating: echo fields per file (the M2a measurement of §1.3's lower bound), merged paths and
conflicts, dropped fields by name, fields by P13 class, sparse derived entries, IR size and reader time per phase
against M1's (D, K, M, P read in 0.7, 4.6, 3.1 and about 11 s before M2a).

## 9. File ownership matrix (no file has two owners at the same time)

✎ = edits. P0 runs first and alone; A-D run in parallel; E runs after all of them merge.

| file or glob | P0 | A | B | C | D | E |
|---|---|---|---|---|---|---|
| tools/ir/schema.mjs, tools/ir/validate.mjs, tools/test-ir.mjs, docs/IR.md | ✎ | | | | | ✎ after merge |
| tools/ir/props.mjs | ✎ first version | | | ✎ | | |
| tools/ir/task.mjs, tools/test-m1-contract.mjs, tools/selftest.mjs | ✎ | | | | | |
| tools/ir/not-codes.json | ✎ | | | | | ✎ |
| tools/pix/ir/index.mjs, tools/pix/ir/nodes.mjs, tools/test-irread.mjs | ✎ seam | | | | | ✎ after merge |
| tools/pix/fixture.mjs | ✎ cases | | | | | ✎ after merge |
| tools/pix/ir/families.mjs, components.mjs, populations.mjs; tools/test-m2a-families.mjs | stub | ✎ | | | | |
| tools/pix/ir/propindex.mjs | ✎ implemented | | ✎ | | | |
| tools/pix/ir/properties.mjs; tools/test-m2a-props.mjs | stub | | ✎ | | | |
| tools/pix/ir/resolve.mjs, overrides.mjs, derived.mjs; tools/test-m2a-instances.mjs | stub | | | ✎ | | |
| tools/ir/plan.mjs, tools/pix-run.mjs, tools/pix-to-ir.mjs, tools/m2a-accept.mjs, tools/test-m2a-run.mjs, tools/test-pixrun.mjs | stub test | | | | ✎ | |
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
| the instance's own look | — | the root override, applied to the instance itself | `overrides[]` with `path` [] (D8, D11) |
| scaled instances | P10 (pending) | the scale factor | `instance.scale` |
| verification of every sublayer within 1 px or in a class (REWRITE §7) | — | the derived box per sublayer with its record; the master layer's box where derived is sparse; side oracle; Pixso's line count | `derived[]` with `at`, `size?`, `transform?`, `oracleSides`, `lines` (D10) |
| fallback frames for an instance that cannot be built | decision 1 | each sublayer's geometry | `derived[].fillGeometry`/`strokeGeometry` (D10) where changed, the master layer's otherwise |

New probes M2b must run, which this plan's inferences rest on:
- **P13b**: the `unprobed` fields on instance sublayers (text ranges, font, line height, letter spacing, auto-layout and
  child layout props, clipping, dashes and caps).
- **P21**: after `swapComponent` on a nested instance whose master-level overrides exist, which overrides Figma keeps
  (rule B says Pixso keeps none; if Figma keeps some, M2b resets them).
- **P22**: the axis order Figma gives a set built by `combineAsVariants` from members named in the IR's axis order.
- **A render pair** of one instance whose own stored paints differ from master root + root override (D11), and of one
  P instance under rule C.

## 11. Risks

- **Rules A, B and C are inferred** from derived data alone; B rests on 2 K entries and 1 P override, C on 36 P entries
  that nothing structural separates from 64 accepted ones. Each is a setting, each rule's switch-off is tested, and
  G1/G2 print what each changes. M2b's renders confirm or overturn them.
- **The duplicate merge is unverified** (D17): P's 81 294 conflicting values include fills, styles and visibility,
  which derived cannot check. A wrong rule shows up in M2b's render audit, not in M2a's gates.
- **Echo baseline errors** would drop live fields. The baseline goes through the masters' own nested overrides and
  rule B; a field is never compared with a pre-swap master (tested), and `--echo keep` exists to compare.
- **"Absent derived field means the master's" is I.** C measures the supporting evidence; M2b's verifier is the real
  test.
- **IR size and reader time on P.** P adds about 342 000 derived entries and 107 000 live overrides. `--derived-geometry
  changed` keeps geometry out where it repeats the master's; IR size and time are printed (§8). If P's IR passes the
  size Node can stringify in one piece, D writes it streamed, record by record, in the same byte order.
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

- To M2b: P13b, P21, P22, P10 and the render pairs of §10; the D17 default if derived cannot decide it; property names
  that are empty or repeat within a family (Figma suffixes property names; M2b maps root ids to Figma's keys).
- To M3: preferred values by key and P's user-page `overrideKey`s (§1.4).
- To M5: `variableConsumptionMap` in overrides (dropped and counted here).
- Q5 and P9 against guidPaths after a swap in **Pixso's** API ids remain unmeasured offline; M4 needs them, M2a does
  not.
