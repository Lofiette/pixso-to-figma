// An instance's data: its master, its assignments, its overrides and its derived boxes (docs/M2A.md
// D6-D11, D17, §6 C). Part C owns this file; part P0 wrote it as a stub with the frozen contract
// (§5.3) and froze OVERRIDE_SOURCE_FIELDS (§5.1), whose translators part C fills in.
//
//   import { instanceData, OVERRIDE_SOURCE_FIELDS } from "./overrides.mjs";
//
// THE FROZEN CONTRACT (docs/M2A.md §5.3).
//   instanceData(cx, n, i, master, indexOf) -> the INSTANCE record's `instance` (docs/IR.md §9):
//     { master, properties?, overrides?, overrideBasis?, derived?, exposed?, scale? }
//     n is the stored INSTANCE, i its record index, master the master reference the plan resolved (M1),
//     indexOf(guid) -> record index | undefined for any guid of the IR. The seam calls it once per
//     INSTANCE record in the instance pass, after every record is written (so `at` and the echo
//     baseline can read master records, which sit on the internal canvas, emitted after user pages).
//     Notes go through cx.noteAt(code, { node: i, path?, detail? }) with an explicit node and path:
//     the pass runs with no current record. Part C uses the resolver (cx.resolver, resolve.mjs), part B's
//     assignments() (properties.mjs) and derived.mjs, and fills cx.m2a.instances, .overrides and .derived:
//       instances { instances, notCarried, noDerived, exposed, exposedOutside, scaled, ownDiffers }
//       overrides { entries, root, emptyPath, nonRoot, live, stale: { class: n }, resolvedNotDerived,
//                   inDerivedUnresolved, distinctLivePaths, mergedAway, written, emptyAfterTranslation,
//                   merged: { paths, conflicts }, rootBox: { echo, differs }, boundConflicts,
//                   pixsoFields: { total, translated, consumed, dropped: { class: { field: n } } },
//                   fields: { produced, carried, echo: { field: n }, byClass: { applies, unprobed, refused } },
//                   swaps: { override, property, sameSet, noOp, unresolved, dropped } }
//       derived   { entries, resolved, viaFallback, unresolved, written, empty, noAt, noTransform, noSize,
//                   withLines, withOracleSides, geometry }
//     with G6's balances (docs/M2A.md §8) holding when the stats are written.
//   OVERRIDE_SOURCE_FIELDS: every Pixso field of an override entry (the census of docs/M2A.md §1.3, the
//     Сова UI kit's four more, and guidPath) with exactly one fate:
//       { fate: "translate", to: [Figma field], by: M1 translator module }   carried, as `to` (props.mjs
//                                                                            OVERRIDE_FIELDS), by `by`
//       { fate: "consume", by }   read by the reader itself and never a field (address, merge, swap,
//                                 assignments, the side and corner translators' flags)
//       { fate: "drop", why }     dropped with OVERRIDE_FIELD_DROPPED class no-equivalent
//     A field outside the table is dropped with class "unknown" and fails gate G6: a new file cannot
//     lose a field silently. The translators are M1's (paints, strokes, layout, text, styles, nodes),
//     used in partial mode (docs/M2A.md §11).
//
// Settings (cx.settings, docs/M2A.md §3): overrideMerge last | first | outer, echo drop | keep,
// instanceOwn overrides | own, derivedGeometry changed | all | none; and the resolver's three.
//
// STUB (part P0): { master } only, as M1 writes it. tools/test-m2a-instances.mjs fails until part C
// replaces this.
export const STUB = "pending: part C";

const T = (to, by) => Object.freeze({ fate: "translate", to: Object.freeze(to), by });
const C = (by) => Object.freeze({ fate: "consume", by });
const D = (why) => Object.freeze({ fate: "drop", why });
const SIDES = ["strokeWeight", "strokeWeights"], CORNERS = ["cornerRadius", "cornerRadii"];
const CHILD_SIZING = ["layoutSizingHorizontal", "layoutSizingVertical", "layoutAlign", "layoutGrow"];
const FONT_VARIANT = "a font variant Figma's text API does not set (M1: SOURCE_FEATURE_UNSUPPORTED on nodes)";
const OT = "OpenType features (M1: SOURCE_FEATURE_UNSUPPORTED on nodes)";

export const OVERRIDE_SOURCE_FIELDS = Object.freeze({
  // consumed by the reader itself
  guidPath: C("the entry's address (D7)"),
  overrideLevel: C("the duplicate merge (D17, --override-merge outer)"),
  overriddenSymbolID: C("the entry's swap (D7, D8)"),
  componentPropAssignment: C("the entry's properties, or the instance's for a root entry (D6, D8)"),
  borderStrokeWeightsIndependent: C("strokes: the side translator"),
  rectangleCornerRadiiIndependent: C("strokes: the corner translator"),
  rectangleCornerToolIndependent: C("strokes: the corner translator"),
  // translated by the M1 translator that reads the field on a node
  arcData: T(["arcData"], "nodes"),
  autoLayoutAbsolutePos: T(["layoutPositioning"], "layout"),
  autoLayoutIncludeBorders: T(["strokesIncludedInLayout"], "layout"),
  autoLayoutItemReverseDraw: T(["itemReverseZIndex"], "layout"),
  borderTopWeight: T(SIDES, "strokes"),
  borderRightWeight: T(SIDES, "strokes"),
  borderBottomWeight: T(SIDES, "strokes"),
  borderLeftWeight: T(SIDES, "strokes"),
  cornerRadius: T(CORNERS, "strokes"),
  cornerSmoothing: T(["cornerSmoothing"], "strokes"),
  rectangleTopLeftCornerRadius: T(CORNERS, "strokes"),
  rectangleTopRightCornerRadius: T(CORNERS, "strokes"),
  rectangleBottomRightCornerRadius: T(CORNERS, "strokes"),
  rectangleBottomLeftCornerRadius: T(CORNERS, "strokes"),
  dashPattern: T(["dashPattern"], "strokes"),
  miterLimit: T(["strokeMiterLimit"], "strokes"),
  strokeAlign: T(["strokeAlign"], "strokes"),
  strokeCap: T(["strokeCap"], "strokes"),
  strokeJoin: T(["strokeJoin"], "strokes"),
  strokePaints: T(["strokes"], "paints"),
  strokeWeight: T(SIDES, "strokes"),
  fillPaints: T(["fills"], "paints"),
  effects: T(["effects"], "paints"),
  exportSettings: T(["exportSettings"], "paints"),
  opacity: T(["opacity"], "nodes"),
  visible: T(["visible"], "nodes"),
  locked: T(["locked"], "nodes"),
  name: T(["name"], "nodes"),
  size: T(["width", "height"], "nodes"),
  frameMaskDisabled: T(["clipsContent"], "layout"),
  horizontalConstraint: T(["constraints"], "layout"),
  verticalConstraint: T(["constraints"], "layout"),
  maxSize: T(["maxWidth", "maxHeight"], "layout"),
  minSize: T(["minWidth", "minHeight"], "layout"),
  stackChildCounterSizing: T(CHILD_SIZING, "layout"),
  stackChildPrimarySizing: T(CHILD_SIZING, "layout"),
  stackCounterAlignContent: T(["counterAxisAlignContent"], "layout"),
  stackCounterAlignItems: T(["counterAxisAlignItems"], "layout"),
  stackCounterSizing: T(["counterAxisSizingMode"], "layout"),
  stackCounterSpacing: T(["counterAxisSpacing"], "layout"),
  stackPaddingBottom: T(["paddingBottom"], "layout"),
  stackPaddingLeft: T(["paddingLeft"], "layout"),
  stackPaddingRight: T(["paddingRight"], "layout"),
  stackPaddingTop: T(["paddingTop"], "layout"),
  stackPrimaryAlignItems: T(["primaryAxisAlignItems"], "layout"),
  stackPrimarySizing: T(["primaryAxisSizingMode"], "layout"),
  stackSpacing: T(["itemSpacing"], "layout"),
  textData: T(["characters", "textRanges"], "text"),
  hyperlink: T(["textRanges"], "text"),
  fontName: T(["fontName"], "text"),
  fontSize: T(["fontSize"], "text"),
  letterSpacing: T(["letterSpacing"], "text"),
  lineHeight: T(["lineHeight"], "text"),
  paragraphIndent: T(["paragraphIndent"], "text"),
  paragraphSpacing: T(["paragraphSpacing"], "text"),
  textAlignHorizontal: T(["textAlignHorizontal"], "text"),
  textAlignVertical: T(["textAlignVertical"], "text"),
  textAutoResize: T(["textAutoResize"], "text"),
  textCase: T(["textCase"], "text"),
  textDecoration: T(["textDecoration"], "text"),
  textTruncation: T(["textTruncation"], "text"),
  maxLines: T(["maxLines"], "text"),
  leadingTrim: T(["leadingTrim"], "text"),
  hangingList: T(["hangingList"], "text"),
  hangingPunctuation: T(["hangingPunctuation"], "text"),
  inheritFillStyleID: T(["fillStyle"], "styles"),
  inheritStrokeStyleID: T(["strokeStyle"], "styles"),
  inheritEffectStyleID: T(["effectStyle"], "styles"),
  inheritTextStyleID: T(["textStyle"], "text"),
  inheritGridStyleID: T(["gridStyle"], "styles"),
  // dropped, class no-equivalent
  autoCornerRadius: D("Pixso's automatic corner radius; no Figma equivalent"),
  dashCap: D("no Figma equivalent (M1: SOURCE_FEATURE_UNSUPPORTED dashCap on nodes)"),
  exportImageQuality: D("an export option Figma's exportSettings lack"),
  exportKeepNameGroup: D("an export option Figma's exportSettings lack"),
  exportNameByVariantProp: D("an export option Figma's exportSettings lack (seen in the Сова UI kit only)"),
  fontVariantNumericFigure: D(FONT_VARIANT),
  fontVariantNumericFraction: D(FONT_VARIANT),
  fontVariantNumericSpacing: D(FONT_VARIANT),
  fontVariantPosition: D(FONT_VARIANT),
  fontVariations: D("variable font axes (M1: SOURCE_FEATURE_UNSUPPORTED fontVariations on nodes)"),
  fontVersion: D("the font file's version; nothing Figma sets"),
  groupIncludeInvisible: D("no Figma equivalent (seen in the Сова UI kit only)"),
  layoutGrids: D("M1 carries no layout grids"),
  overlayBackgroundAppearance: D("a prototype overlay; prototypes are not migrated"),
  overlayBackgroundInteraction: D("a prototype overlay; prototypes are not migrated"),
  overlayPositionType: D("a prototype overlay; prototypes are not migrated"),
  pluginData: D("Pixso plugin data"),
  prototypeInteractions: D("prototype interactions; prototypes are not migrated"),
  proportionsConstrained: D("an editor's resize lock; nothing is drawn"),
  showInSlice: D("no Figma equivalent (seen in the Сова UI kit only)"),
  toggledOffOTFeatures: D(OT),
  toggledOnOTFeatures: D(OT),
  variableConsumptionMap: D("variable bindings: M5"),
  variableModeBySetMap: D("variable modes: M5"),
  vectorPaints: D("region fills, which cannot be overridden on a sublayer (I)"),
  vectorStyles: D("region styles, which cannot be overridden on a sublayer (I)"),
});

export function instanceData(cx, n, i, master, indexOf) {
  return { master };
}
