// An instance's data: its master, its assignments, its overrides and its derived boxes (docs/M2A.md
// D6-D11, D17, §6 C). Part C owns this file; part P0 froze OVERRIDE_SOURCE_FIELDS (§5.1), whose
// translators part C filled in.
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
// HOW PART C TRANSLATES (docs/M2A.md D8, D9). M1's translators write whole records, so an override is
// translated by composition instead of field by field: the target layer as it is drawn without this
// entry (its baseline, a stored Pixso node) and the same node with the entry's fields laid over it go
// through the same translators (lookOf, the Figma look M1's nodes.mjs propsOf writes, in a quiet copy of
// the reader's context that interns nothing and notes nothing), and the override's Figma fields are the
// `to` fields of its Pixso fields, read from the composed node. A Figma field equal to the baseline's
// (canonical JSON, IR rounding, DEFAULTS for an absent prop) is an echo (D9). The baseline is:
//   - a layer: the stored layer, with the entries of the masters' own nested instances along the path
//     laid over it, innermost first (an outer one wins), except those of an instance a swap reset (rule
//     B); a nested INSTANCE target: its effective master's root (after swaps), with the instance's own
//     box, name, visibility and lock, and its own root entries unless a swap reset them; its type is
//     COMPONENT (docs/M2A.md §5.1);
//   - for `characters` or `visible` of a layer bound to a declared TEXT or BOOLEAN root
//     (componentPropRef read through propindex): the property's effective value at that layer: an
//     outer entry's assignment to the instance the layer sits in, else that instance's own, else the
//     root's default; an override that differs from it is counted overrides.boundConflicts;
//   - the instance itself (path []): the master root's look; its box, child-layout, name, visibility
//     and lock fields compare with the INSTANCE record instead (echo, or dropped "root-box").
// The Figma fields are closed to the target type's KNOWN_PROPS plus name (an INSTANCE target takes a
// COMPONENT's; the instance itself ROOT_OVERRIDE_FIELDS): a Pixso field none of whose `to` fields the
// target takes is dropped "not-on-type". Two fields where M1's translators write other fields than the
// table names: inheritTextStyleID also yields the font, size, letter spacing and line height text.mjs
// draws from the style (M1 writes no textStyle), and inheritGridStyleID yields nothing (M1 carries no
// layout grids), so it is dropped "no-equivalent" (part C's request to E: give it that fate in the
// table). Of the child-sizing fields' four, M1 writes layoutGrow from the primary one and layoutAlign
// from the counter one, so each yields only that. width and height are one setter: when either differs, neither is an echo (so min and max).
// A style a written field binds is registered through styles.mjs with the note's path (STYLE_VALUE_DIFFERS,
// STYLE_MISSING_IN_SOURCE); fonts and images the written values use join the IR's through cx. A Pixso
// feature Figma lacks that only the override brings is counted in stats.unsupported and noted
// SOURCE_FEATURE_UNSUPPORTED once per instance and feature, with the path of its first entry.
//
// Duplicate paths (D17, --override-merge): entries of one path merge field by field, `last` the latest
// stored winning, `first` the earliest, `outer` the lowest overrideLevel (absent: 0), then the latest;
// assignments merge by raw definition id the same way, a losing one counted assignments.merged. Conflicts
// count the fields (overrideLevel apart) whose values differ among the duplicates. A stale entry's
// assignments are counted assignments.droppedWithEntry (part B's assignments() counts every other one;
// total includes both). The Pixso-field balance is kept over the merged entries (the root one and each
// live path's), plus any unknown field of a stale entry, so a field outside the table fails G6 wherever
// it sits.
//
// Settings (cx.settings, docs/M2A.md §3): overrideMerge last | first | outer, echo drop | keep,
// instanceOwn overrides | own, derivedGeometry changed | all | none; and the resolver's three.
import { CODE, canonicalJSON, INTERNED_PROPS } from "../../ir/schema.mjs";
import { KNOWN_PROPS, DEFAULTS, NEVER_OMIT, OVERRIDE_FIELDS, OVERRIDE_FIELD_CLASS, ROOT_OVERRIDE_FIELDS } from "../../ir/props.mjs";
import * as EN from "./enums.mjs";
import { r2, r4, r6, isFin, matrixOf, matrixFinite, guidStr, guidSet } from "./util.mjs";
import { effectsOf, exportSettingsOf, paintsOf } from "./paints.mjs";
import { strokeProps, cornerProps } from "./strokes.mjs";
import { frameLayoutProps, childLayoutProps, isAutoLayout } from "./layout.mjs";
import { textProps } from "./text.mjs";
import { drawnStyles } from "./styles.mjs";
import { masterRef } from "./components.mjs";
import { assignments } from "./properties.mjs";
import { derivedEntries } from "./derived.mjs";

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

const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const NEVER = new Set(NEVER_OMIT);
const RECT_LIKE = new Set(["FRAME", "COMPONENT", "RECTANGLE"]);
// Pixso fields that address, merge or swap: never laid over a layer.
const NOT_LOOK = new Set(["guidPath", "overrideLevel", "overriddenSymbolID", "componentPropAssignment"]);
// The fields an INSTANCE record carries itself (D8): its box, child layout, name, visibility and lock.
const BOX = ["size", "transform", "horizontalConstraint", "verticalConstraint", "minSize", "maxSize", "stackChildPrimarySizing",
  "stackChildCounterSizing", "autoLayoutAbsolutePos", "name", "visible", "locked"];
const BOX_SET = new Set(BOX);
const ROOT_SET = new Set(ROOT_OVERRIDE_FIELDS);
// Where M1's translators write other Figma fields than the table's `to` (the header says why).
const EXTRA_TO = { inheritTextStyleID: ["fontName", "fontSize", "letterSpacing", "lineHeight"] };
// Of the table's child-sizing fields, the one M1's layout.mjs writes from each (the others never are).
const NARROW_TO = { stackChildPrimarySizing: ["layoutGrow"], stackChildCounterSizing: ["layoutAlign"] };
const NO_EFFECT = new Set(["inheritGridStyleID"]);
const SETTERS = [["width", "height"], ["minWidth", "minHeight"], ["maxWidth", "maxHeight"]];
const FIELD_DEFAULTS = Object.assign({}, DEFAULTS, { textRanges: [] });
// The instance's own stored look (D11): the Pixso fields, and the Figma fields they make.
const OWN_SOURCE = ["fillPaints", "strokePaints", "effects", "opacity", "blendMode", "inheritFillStyleID", "inheritStrokeStyleID", "inheritEffectStyleID"];
const OWN_FIGMA = ["fills", "fillStyle", "strokes", "strokeStyle", "effects", "effectStyle", "opacity", "blendMode"];
const OWN_SET = new Set(OWN_FIGMA);
const STYLE_FIELDS = ["fillStyle", "strokeStyle", "effectStyle"];
const STYLE_SOURCE = { fillStyle: ["inheritFillStyleID", "fillPaints"], strokeStyle: ["inheritStrokeStyleID", "strokePaints"], effectStyle: ["inheritEffectStyleID", "effects"] };

// A stable key for a raw Pixso value (typed arrays, bigints and NaN included), for the merge's conflicts.
function rawKey(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "bigint") return v.toString() + "n";
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : String(v);
  if (typeof v !== "object") return JSON.stringify(v);
  if (ArrayBuffer.isView(v)) return "<" + Array.from(v).join(",") + ">";
  if (Array.isArray(v)) return "[" + v.map(rawKey).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + rawKey(v[k])).join(",") + "}";
}
const canon = (v) => canonicalJSON(v);
const pv = (F, f) => (own(F, f) ? F[f] : FIELD_DEFAULTS[f]);

// ---------- the reader's context, quiet: translate to compare, intern and note nothing ----------
function overlay(base) {
  const mine = new Map();
  return { has: (k) => mine.has(k) || base.has(k), get: (k) => (mine.has(k) ? mine.get(k) : base.get(k)), set(k, v) { mine.set(k, v); return this; } };
}
function quietOf(cx) {
  const q = Object.create(cx);
  const sink = { features: null };
  q.note = () => {}; q.noteGuid = () => {}; q.noteFile = () => {}; q.noteAt = () => {};
  q.feature = (name) => { if (sink.features) sink.features.push(name); };
  q.featureCount = () => {};
  q.imageRef = () => {}; q.font = () => {};
  q.value = (v) => v;
  q.rangeValue = (k, v) => v;
  // The translators' counters (strokeAlignDecided, text, styles, ...) land in a copy, never in stats.
  q.stats = structuredClone(cx.stats);
  q.at = undefined; q.featured = new Set(); q.glyphChecked = new Set();
  // A style the quiet run meets for the first time gets an index past the real ones, in an overlay.
  const extra = [];
  q.styles = { get length() { return cx.styles.length + extra.length; }, push(e) { extra.push(e); } };
  q.styleIds = overlay(cx.styleIds);
  q.styleGuids = overlay(cx.styleGuids);
  return { q, sink };
}

// The Figma look of a stored (or composed) Pixso node as an IR record of `type` would carry it, raw
// (not interned): what tools/pix/ir/nodes.mjs propsOf writes, for the props an override can carry.
// need (optional): a Set of the Figma fields wanted; the translators whose fields none of them is are
// skipped (the box is always written). The result holds at least every wanted field the full look holds.
const SECTIONS = {
  child: ["constraints", "layoutPositioning", "layoutAlign", "layoutGrow", "layoutSizingHorizontal", "layoutSizingVertical", "minWidth", "maxWidth", "minHeight", "maxHeight"],
  text: ["characters", "fontName", "fontSize", "letterSpacing", "lineHeight", "paragraphIndent", "paragraphSpacing", "textAlignHorizontal", "textAlignVertical",
    "textAutoResize", "textCase", "textDecoration", "textTruncation", "maxLines", "leadingTrim", "hangingPunctuation", "hangingList", "textStyle", "textRanges"],
  blend: ["opacity", "blendMode", "effects", "exportSettings"],
  strokes: ["fills", "strokes", "strokeWeight", "strokeAlign", "strokeJoin", "strokeCap", "strokeMiterLimit", "dashPattern", "strokeWeights"],
  corners: ["cornerRadius", "cornerRadii", "cornerSmoothing"],
  frame: ["clipsContent", "layoutMode", "layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems",
    "counterAxisAlignContent", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "counterAxisSpacing", "itemReverseZIndex",
    "strokesIncludedInLayout", "overflowDirection", "layoutGrids", "gridStyle"],
};
SECTIONS.drawn = STYLE_FIELDS.concat(SECTIONS.strokes, ["effects"], SECTIONS.text);
export function lookOf(q, n, type, parentNode, need) {
  const want = (s) => !need || SECTIONS[s].some((f) => need.has(f));
  const known = KNOWN_PROPS[type] || {};
  const props = {};
  const put = (k, v) => {
    if (v === undefined || !own(known, k)) return;
    if (!NEVER.has(k) && own(DEFAULTS, k) && canon(v) === canon(DEFAULTS[k])) return;
    props[k] = v;
  };
  if (matrixFinite(n.transform)) put("relativeTransform", matrixOf(n.transform).map(r4));
  if (n.size && isFin(n.size.x) && isFin(n.size.y)) {
    put("width", Math.max(0, r2(n.size.x)));
    put("height", type === "LINE" ? 0 : Math.max(0, r2(n.size.y)));
  }
  if (n.visible === false) put("visible", false);
  if (n.locked) put("locked", true);
  if (want("child")) childLayoutProps(q, n, put, parentNode, type !== "INSTANCE" && isAutoLayout(q, n));
  if (type === "INSTANCE") return props;
  const drawn = want("drawn") ? drawnStyles(q, n) : { n };
  for (const k of STYLE_FIELDS) if (drawn[k] !== undefined) put(k, drawn[k]);
  const d = drawn.n;
  if (type === "SECTION") { put("fills", paintsOf(q, d.fillPaints)); return props; }
  if (type === "SLICE") { put("exportSettings", exportSettingsOf(q, d.exportSettings)); return props; }
  if (want("blend")) {
    if (isFin(d.opacity)) put("opacity", r6(Math.max(0, Math.min(1, d.opacity))));
    put("blendMode", q.en("PixsoNode", "blendMode")(d.blendMode) || "PASS_THROUGH");
    put("effects", effectsOf(q, d.effects));
    if ((d.exportSettings || []).length) put("exportSettings", exportSettingsOf(q, d.exportSettings));
  }
  if (type === "GROUP") return props;
  const sides = RECT_LIKE.has(type);
  if (want("strokes")) strokeProps(q, d, type, put, { sides });
  if (want("corners")) cornerProps(q, d, type, put, { sides });
  if (type === "FRAME" || type === "COMPONENT") { if (want("frame")) frameLayoutProps(q, d, put, q.childrenOf(d)); }
  else if (type === "ELLIPSE" && d.arcData) {
    const a0 = isFin(d.arcData.startingAngle) ? d.arcData.startingAngle : 0, a1 = isFin(d.arcData.endingAngle) ? d.arcData.endingAngle : a0 + 2 * Math.PI;
    const hole = isFin(d.arcData.innerRadius) ? d.arcData.innerRadius : 0;
    if (!(Math.abs(a1 - a0 - 2 * Math.PI) < 1e-5 && !(hole > 0))) put("arcData", { startingAngle: r6(a0), endingAngle: r6(a1), innerRadius: r6(hole) });
  } else if (type === "TEXT" && want("text")) textProps(q, d, put);
  return props;
}

// ---------- per read ----------
const READS = new WeakMap();
function readOf(cx) {
  let X = READS.get(cx);
  if (X) return X;
  const { q, sink } = quietOf(cx);
  const plan = new Map();
  const walk = (p) => { plan.set(guidStr(p.n.guid), p); for (const k of p.kids || []) walk(k); };
  for (const pg of cx.planned || []) for (const t of pg.tops) walk(t);
  // The context styles are registered through for real: notes at the instance and path being written
  // (X.where), the translators' counters in the quiet copy. One per read, so styles.mjs builds its
  // overrideKey index once.
  const ocx = Object.create(cx);
  ocx.note = (code, detail) => cx.noteAt(code, { node: X.where.node, path: X.where.path, detail });
  ocx.stats = q.stats;
  X = { q, sink, ocx, where: null, plan, fieldOf: cx.en("ComponentPropRef", "componentPropNodeField"), bases: new Map(), allowed: new Map() };
  READS.set(cx, X);
  countNotCarried(cx, X);
  return X;
}
// Instances the reader does not carry because their master cannot be named (M1's dropUnresolved): a
// stored INSTANCE with no record whose parent is carried, or is a page in scope.
function countNotCarried(cx, X) {
  const pages = new Set();
  for (const pg of cx.planned || []) pages.add(pg.page.guid);
  const scoped = cx.settings && cx.settings.scope && cx.settings.scope !== "file" ? new Set(cx.settings.scope.slice(6).split(",")) : null;
  for (const n of cx.pix.nodes) {
    if (cx.typeName(n) !== "INSTANCE") continue;
    const g = guidStr(n.guid);
    if (cx.indexOf(g) !== undefined || masterRef(cx, n)) continue;
    const pg = n.parentIndex ? guidStr(n.parentIndex.guid) : null;
    const parent = pg ? cx.byGuid.get(pg) : null;
    if (!parent) continue;
    if (cx.indexOf(pg) !== undefined || (cx.typeName(parent) === "CANVAS" && pages.has(pg) && (!scoped || scoped.has(g) || scoped.has(pg)))) cx.m2a.instances.notCarried++;
  }
}
function plannedType(cx, X, n) {
  const p = X.plan.get(guidStr(n.guid));
  if (p && p.type) return p.type;
  return EN.NODE_TYPE[cx.typeName(n)] || null;
}
const parentOf = (cx, n) => (n && n.parentIndex ? cx.byGuid.get(guidStr(n.parentIndex.guid)) || null : null);
const lay = (B, e) => { for (const k of Object.keys(e)) if (!NOT_LOOK.has(k)) B[k] = e[k]; return B; };

// The IR type a path's target is translated as: a nested instance's look is its master root's.
const targetType = (cx, X, T) => (cx.typeName(T) === "INSTANCE" ? "COMPONENT" : plannedType(cx, X, T));

// The target of a resolved non-root path, as it is drawn without the instance's own entries. It
// depends only on the path, the effective symbols and the resets along it, which many instances of
// one master share, so it is memoised per read with its translated look (never mutate .node).
function baseOf(cx, X, guids, res) {
  const key = guids.join("/") + "|" + res.elements.map((e) => (e.symbol || "") + (e.reset ? "!" : "")).join(",");
  let b = X.bases.get(key);
  if (!b) { b = baseOnce(cx, X, guids, res); X.bases.set(key, b); }
  return b;
}
// The baseline's look and the features its translation met, memoised with the base.
function baseLook(X, b) {
  if (!b.look) {
    X.sink.features = [];
    const F = lookOf(X.q, b.node, b.type, b.parent);
    b.look = { F, features: X.sink.features };
    X.sink.features = null;
  }
  return b.look;
}
function baseOnce(cx, X, guids, res) {
  const R = cx.resolver;
  const el = res.elements[res.elements.length - 1], T = el.n;
  let B, type;
  if (cx.typeName(T) === "INSTANCE") {
    const M = el.symbol ? cx.byGuid.get(el.symbol) : null;
    B = Object.assign({}, M && cx.typeName(M) === "SYMBOL" ? M : T);
    for (const k of BOX) { if (T[k] !== undefined) B[k] = T[k]; else delete B[k]; }
    if (!el.reset) for (const e of R.rootEntries(T)) lay(B, e);
    type = "COMPONENT";
  } else {
    B = Object.assign({}, T);
    type = plannedType(cx, X, T);
  }
  for (let j = res.holders.length - 1; j >= 1; j--) {
    const h = res.holders[j];
    if (h.reset) continue;
    for (const e of R.entriesOf(h.n).get(R.pathKey(guids.slice(h.start))) || []) lay(B, e);
  }
  return { node: B, type, parent: parentOf(cx, T), T, el };
}

// D9: the effective value of a bound text or visibility at the target (null when nothing is bound).
const readValue = (v, f) => (f === "characters" ? (v && v.textValue && typeof v.textValue.characters === "string" ? v.textValue.characters : "") : !!(v && v.boolValue));
function boundOf(cx, X, guids, res) {
  const T = res.elements[res.elements.length - 1].n;
  if (!(T.componentPropRef || []).length || !cx.props) return null;
  const sym = res.holders[res.holders.length - 1].symbol;
  const scope = sym ? cx.props.scopeOf(sym) : null;
  if (!scope) return null;
  let out = null, pools = null;
  for (const r of T.componentPropRef) {
    if (!r || !guidSet(r.defID)) continue;
    const fname = X.fieldOf(r.componentPropNodeField);
    const f = fname === "TEXT_DATA" ? "characters" : fname === "VISIBLE" ? "visible" : null;
    if (!f) continue;
    const root = cx.props.rootOf(scope, guidStr(r.defID), sym);
    if (!root || root.type !== (f === "characters" ? "TEXT" : "BOOL")) continue;
    // Under --rejected-props none a rejected set's root is declared by no member (D3).
    if (cx.settings.rejectedProps === "none" && cx.families && cx.families.rejected && cx.families.rejected.has(root.owner) && root.owner !== sym) continue;
    pools = pools || cx.resolver.poolsFor(guids, guids.length - 1, res.holders);
    let v;
    for (const pool of pools) {
      let hit = null;
      for (const a of pool.list) if (a && guidSet(a.defID) && cx.props.rootOf(scope, guidStr(a.defID), sym) === root) hit = a;
      if (hit) { v = readValue(hit.value, f); break; }
    }
    if (v === undefined) v = readValue(root.initialValue, f);
    (out = out || {})[f] = v;
  }
  return out;
}

// D17: entries of one path, merged by --override-merge.
function mergeEntries(list, rule) {
  const lvl = (e) => (isFin(e.overrideLevel) ? e.overrideLevel : 0);
  let order = list.map((e, k) => ({ e, k }));
  if (rule === "first") order = order.reverse();
  else if (rule === "outer") order.sort((a, b) => (lvl(b.e) - lvl(a.e)) || (a.k - b.k));
  const fields = {};
  for (const { e } of order) for (const k of Object.keys(e)) fields[k] = e[k];
  const byDef = new Map();
  let total = 0;
  for (const { e } of order) for (const a of e.componentPropAssignment || []) {
    total++;
    const id = a && guidSet(a.defID) ? guidStr(a.defID) : "#" + total;
    byDef.delete(id);
    byDef.set(id, a);
  }
  const merged = [...byDef.values()];
  if (own(fields, "componentPropAssignment")) fields.componentPropAssignment = merged;
  let conflicts = 0;
  if (list.length > 1) {
    for (const k of Object.keys(fields)) {
      if (k === "guidPath" || k === "overrideLevel") continue;
      const seen = new Set();
      for (const e of list) if (own(e, k)) seen.add(k === "componentPropAssignment" ? rawKey((e[k] || []).map((a) => [a && a.defID, a && a.value])) : rawKey(e[k]));
      if (seen.size > 1) conflicts++;
    }
  }
  return { fields, assignments: merged, mergedAssignments: total - merged.length, conflicts };
}

// ---------- the instance pass ----------
export function instanceData(cx, n, i, master, indexOf) {
  const X = readOf(cx);
  const R = cx.resolver, q = X.q;
  const SI = cx.m2a.instances, SO = cx.m2a.overrides, SA = cx.m2a.properties.assignments;
  const st = cx.settings;
  const g = guidStr(n.guid);
  const S0 = R.declared(n);
  const local = !!(master && master.guid);
  const out = { master };

  SI.instances++;
  if (!(n.derivedSymbolData || []).length) SI.noDerived++;

  // Local counts, added to stats at the end and checked against G6's balances first.
  const L = { entries: 0, root: 0, emptyPath: 0, nonRoot: 0, live: 0, stale: 0, distinct: 0, mergedAway: 0, written: 0, empty: 0,
    total: 0, translated: 0, consumed: 0, dropped: 0, produced: 0, carried: 0, echo: 0 };
  const dropped = new Map();          // class -> Map(field -> n), one OVERRIDE_FIELD_DROPPED note per class
  const echoes = new Map();           // field -> n, one OVERRIDE_ECHO note
  const featured = new Set();
  let mergedPaths = 0, mergedConflicts = 0;
  const drop = (cls, field) => {
    L.dropped++;
    const D = SO.pixsoFields.dropped[cls];
    D[field] = (D[field] || 0) + 1;
    if (!dropped.has(cls)) dropped.set(cls, new Map());
    dropped.get(cls).set(field, (dropped.get(cls).get(field) || 0) + 1);
  };
  const noteStale = (cls, defIdCount) => { SA.total += defIdCount; SA.droppedWithEntry += defIdCount; };
  const writeNotes = (list, path) => {
    for (const d of list) {
      const code = CODE[d.code];
      if (!code) throw new Error("instanceData: assignments() named no code: " + JSON.stringify(d.code));
      const cls = String(d.class);
      cx.noteAt(code, { node: i, path, detail: cls + (cls.indexOf(": ") >= 0 ? ", " : ": ") + "definition " + d.defId });
    }
  };

  // ---- 1. the entries: root, live or stale ----
  const roots = [], live = new Map(), stale = new Map();
  for (const e of (n.symbolData && n.symbolData.symbolOverrides) || []) {
    L.entries++;
    const guids = R.pathGuids(e);
    if (guids.length === 0 || (guids.length === 1 && guids[0] === S0)) {
      L.root++;
      if (!guids.length) L.emptyPath++;
      roots.push(e);
      continue;
    }
    L.nonRoot++;
    const res = R.resolve(n, guids), inD = R.inDerived(n, guids);
    const key = R.pathKey(guids);
    if (res.ok && inD) {
      L.live++;
      if (!live.has(key)) live.set(key, { guids, res, entries: [] });
      live.get(key).entries.push(e);
      continue;
    }
    L.stale++;
    const cls = inD ? "unresolved" : "not-derived";
    SO.stale[cls]++;
    if (res.ok) SO.resolvedNotDerived++;
    if (inD && !res.ok) SO.inDerivedUnresolved++;
    if (guidSet(e.overriddenSymbolID)) SO.swaps.unresolved++;
    const nAsg = (e.componentPropAssignment || []).length;
    noteStale(cls, nAsg);
    // A field outside the table fails G6 even on an entry that is dropped whole.
    for (const k of Object.keys(e)) if (!own(OVERRIDE_SOURCE_FIELDS, k)) { L.total++; drop("unknown", k); }
    if (!stale.has(key)) stale.set(key, { guids, cls, why: res.ok ? null : res.why, entries: 0, assignments: 0 });
    const s = stale.get(key);
    s.entries++;
    s.assignments += nAsg;
  }
  for (const s of stale.values()) {
    const parts = [];
    if (s.cls === "unresolved" && s.why) parts.push(s.why);
    if (s.entries > 1) parts.push(s.entries + " entries");
    if (s.assignments) parts.push(s.assignments + " assignment" + (s.assignments === 1 ? "" : "s") + " dropped with " + (s.entries > 1 ? "them" : "it"));
    cx.noteAt(CODE.OVERRIDE_STALE, { node: i, path: s.guids, detail: s.cls + (parts.length ? ": " + parts.join(", ") : "") });
  }

  // ---- 2. merge the duplicates (D17) ----
  const rule = st.overrideMerge || "last";
  const rootM = roots.length ? mergeEntries(roots, rule) : null;
  if (roots.length > 1) { mergedPaths++; mergedConflicts += rootM.conflicts; SA.total += rootM.mergedAssignments; SA.merged += rootM.mergedAssignments; }
  for (const lv of live.values()) {
    lv.m = mergeEntries(lv.entries, rule);
    L.distinct++;
    if (lv.entries.length > 1) {
      L.mergedAway += lv.entries.length - 1;
      mergedPaths++;
      mergedConflicts += lv.m.conflicts;
      SA.total += lv.m.mergedAssignments;
      SA.merged += lv.m.mergedAssignments;
    }
  }

  // ---- 3. derived entries (D10), resolved first: rule C's ignored assignments come from them too ----
  const ignoredItems = [];
  const layerOf = (res, guids) => {
    const els = res.elements;
    if (!RECT_LIKE.has(targetType(cx, X, els[els.length - 1].n))) return null;
    const b = baseOf(cx, X, guids, res);
    const lv = live.get(R.pathKey(guids));
    return { node: lv ? lay(Object.assign({}, b.node), lv.m.fields) : b.node, type: b.type };
  };
  const derived = derivedEntries(cx, n, i, { local, quiet: q, layerOf, ignored: ignoredItems });
  for (const lv of live.values()) for (const x of lv.res.ignored || []) ignoredItems.push(x);
  const seenIgnored = new Set();
  const ignoredOwn = new Set(), ignoredAt = new Map();
  for (const x of ignoredItems) {
    const k = x.instance + "|" + (x.path ? x.path.join("/") : "-") + "|" + x.defId;
    if (seenIgnored.has(k)) continue;
    seenIgnored.add(k);
    if (x.instance !== g) continue;
    const isOwn = !x.path || x.path.length === 0 || (x.path.length === 1 && x.path[0] === S0);
    if (isOwn) ignoredOwn.add(x.defId);
    else { const pk = x.path.join("/"); if (!ignoredAt.has(pk)) ignoredAt.set(pk, new Set()); ignoredAt.get(pk).add(x.defId); }
  }

  // ---- 4. translate a merged entry's Pixso fields into Figma fields ----
  // spec: { fields, base: { node, type, parent } (baseOf's, memoised with its look), allowed: Set, isRoot,
  // notCarried, bound, path }; returns { written: { figma field: raw value }, composed } after echo, and
  // counts Pixso and Figma fields.
  const translate = (spec) => {
    const set = new Set(), lookKeys = [];
    for (const k of Object.keys(spec.fields)) {
      L.total++;
      const f = own(OVERRIDE_SOURCE_FIELDS, k) ? OVERRIDE_SOURCE_FIELDS[k] : null;
      if (!f) { drop("unknown", k); continue; }
      if (f.fate === "consume") { L.consumed++; continue; }
      if (f.fate === "drop" || NO_EFFECT.has(k)) { drop("no-equivalent", k); continue; }
      if (spec.notCarried) { drop("layer-not-carried", k); continue; }
      if (spec.isRoot && BOX_SET.has(k)) { rootBox(k, spec.fields[k]); continue; }
      const tos = (NARROW_TO[k] || f.to).concat(EXTRA_TO[k] || []).filter((t) => spec.allowed.has(t));
      if (!tos.length) { drop("not-on-type", k); continue; }
      L.translated++;
      for (const t of tos) set.add(t);
      lookKeys.push(k);
    }
    const written = {};
    if (!set.size) return { written, composed: spec.base.node };
    const B = spec.base.node, Cn = Object.assign({}, B);
    for (const k of lookKeys) Cn[k] = spec.fields[k];
    const { F: Fb, features: fb } = baseLook(X, spec.base);
    X.sink.features = [];
    const Fc = lookOf(q, Cn, spec.base.type, spec.base.parent, set);
    const fc = X.sink.features;
    X.sink.features = null;
    newFeatures(fb, fc, spec.isRoot ? undefined : spec.path);
    const vals = new Map();
    for (const f of [...set].sort()) {
      const comp = f === "name" ? (typeof Cn.name === "string" ? Cn.name : undefined) : pv(Fc, f);
      if (comp === undefined) continue;
      // Ranges are a by-product of characters: none on either side is no field at all.
      if (f === "textRanges" && !own(Fc, f) && !own(Fb, f)) continue;
      let base = f === "name" ? B.name : pv(Fb, f);
      const bound = !!spec.bound && own(spec.bound, f);
      if (bound) base = spec.bound[f];
      vals.set(f, { comp, differs: canon(comp) !== canon(base === undefined ? null : base), bound });
    }
    for (const group of SETTERS) if (group.some((f) => vals.has(f) && vals.get(f).differs)) for (const f of group) if (vals.has(f)) vals.get(f).differs = true;
    for (const [f, v] of vals) {
      L.produced++;
      if (!v.differs) {
        L.echo++;
        SO.fields.echo[f] = (SO.fields.echo[f] || 0) + 1;
        echoes.set(f, (echoes.get(f) || 0) + 1);
        if (st.echo !== "keep") continue;
      } else {
        L.carried++;
        if (v.bound) SO.boundConflicts++;
      }
      written[f] = v.comp;
    }
    return { written, composed: Cn };
  };

  // Root box fields (D8): equal to the INSTANCE record's, an echo; different, the record wins.
  const parentI = parentOf(cx, n);
  let FI = null;
  const rootBox = (k, v) => {
    const tos = NARROW_TO[k] || OVERRIDE_SOURCE_FIELDS[k].to;
    if (!FI) FI = lookOf(q, n, "INSTANCE", parentI);
    const Fk = k === "name" ? null : lookOf(q, Object.assign({}, n, { [k]: v }), "INSTANCE", parentI);
    const equal = k === "name" ? v === n.name : tos.every((f) => canon(pv(Fk, f) === undefined ? null : pv(Fk, f)) === canon(pv(FI, f) === undefined ? null : pv(FI, f)));
    if (!equal) { SO.rootBox.differs++; drop("root-box", k); return; }
    SO.rootBox.echo++;
    L.translated++;
    for (const f of tos) {
      if (f !== "name" && pv(Fk, f) === undefined) continue;
      L.produced++; L.echo++;
      SO.fields.echo[f] = (SO.fields.echo[f] || 0) + 1;
      echoes.set(f, (echoes.get(f) || 0) + 1);
    }
  };
  // A feature Figma lacks that only the override brings (counted, one note per instance and feature).
  const newFeatures = (fb, fc, path) => {
    const left = fb.slice();
    for (const name of fc) {
      const j = left.indexOf(name);
      if (j >= 0) { left.splice(j, 1); continue; }
      cx.featureCount(name);
      if (featured.has(name)) continue;
      featured.add(name);
      cx.noteAt(CODE.SOURCE_FEATURE_UNSUPPORTED, { node: i, path, detail: name + ": in an instance override" });
    }
  };

  // Written raw Figma values -> IR fields: interned, styles registered with the note's path, fonts and
  // images listed.
  const intern = (written, composed, path) => {
    const o = {};
    let styleIdx = null;
    for (const f of Object.keys(written).sort()) {
      const v = written[f], kind = OVERRIDE_FIELDS[f];
      if (STYLE_FIELDS.indexOf(f) >= 0) {
        if (!styleIdx) {
          const need = STYLE_FIELDS.filter((s) => own(written, s));
          const mini = { guid: composed.guid };
          for (const s of need) for (const k of STYLE_SOURCE[s]) if (composed[k] !== undefined) mini[k] = composed[k];
          X.where = { node: i, path };
          styleIdx = drawnStyles(X.ocx, mini);
        }
        if (styleIdx[f] !== undefined) o[f] = styleIdx[f];
        continue;
      }
      if (f === "textRanges") {
        o[f] = v.map((r) => {
          const fields = {};
          for (const k of Object.keys(r.fields).sort()) {
            if (k === "fontName") cx.font(r.fields[k]);
            touchImages(cx, r.fields[k]);
            fields[k] = INTERNED_PROPS.indexOf(k) >= 0 ? cx.value(r.fields[k]) : r.fields[k];
          }
          return { start: r.start, end: r.end, fields };
        });
        continue;
      }
      if (kind === "value") {
        if (f === "fontName") cx.font(v);
        touchImages(cx, v);
        o[f] = cx.value(v);
      } else o[f] = v;
    }
    return o;
  };
  const classify = (fields) => { for (const f of Object.keys(fields)) SO.fields.byClass[OVERRIDE_FIELD_CLASS[f]]++; };

  const overrides = [];
  // ---- 5. the instance itself: its look (path []), its assignments (D8, D11) ----
  const M0 = S0 ? cx.byGuid.get(S0) : null;
  const rootKey = M0 && cx.typeName(M0) === "SYMBOL" ? "root|" + S0 : "root|own|" + g;
  if (!X.bases.has(rootKey)) X.bases.set(rootKey, { node: M0 && cx.typeName(M0) === "SYMBOL" ? M0 : n, type: "COMPONENT", parent: null });
  const baseRoot = X.bases.get(rootKey);
  let rootFields = {}, rootComposed = baseRoot.node;
  if (rootM) {
    const t = translate({ fields: rootM.fields, base: baseRoot, allowed: ROOT_SET, isRoot: true });
    rootFields = t.written;
    rootComposed = t.composed;
    const sw = rootM.fields.overriddenSymbolID;
    if (guidSet(sw)) {
      // A root swap names the instance's own master: a no-op, dropped (0 measured, D8).
      SO.swaps.dropped++;
      if (guidStr(sw) !== S0) cx.noteAt(CODE.SWAP_VALUE_DANGLING, { node: i, detail: "swap: root swap" });
    }
  }
  // The instance's own stored look against its master root plus the root override (D11).
  if (OWN_SOURCE.some((k) => n[k] !== undefined)) {
    const ownNode = Object.assign({}, rootComposed);
    for (const k of OWN_SOURCE) if (n[k] !== undefined) ownNode[k] = n[k];
    const Fo = lookOf(q, ownNode, "COMPONENT", null, OWN_SET);
    const Fr = rootComposed === baseRoot.node ? baseLook(X, baseRoot).F : lookOf(q, rootComposed, "COMPONENT", null);
    const diffs = OWN_FIGMA.filter((f) => canon(pv(Fo, f) === undefined ? null : pv(Fo, f)) !== canon(pv(Fr, f) === undefined ? null : pv(Fr, f)));
    if (diffs.length) {
      SI.ownDiffers++;
      if (st.instanceOwn === "own") {
        for (const f of diffs) {
          if (pv(Fo, f) === undefined) continue;
          if (!own(rootFields, f)) { L.produced++; L.carried++; }
          rootFields[f] = pv(Fo, f);
        }
        rootComposed = ownNode;
      }
    }
  }
  if (Object.keys(rootFields).length) {
    const fields = intern(rootFields, rootComposed, undefined);
    if (Object.keys(fields).length) { classify(fields); overrides.push({ path: [], fields }); }
  }
  // Assignments: the node's own, then its root entries' (an entry's value wins over the node's).
  const rawOwn = new Map();
  for (const a of n.componentPropAssignment || []) rawOwn.set(a && guidSet(a.defID) ? guidStr(a.defID) : "#" + rawOwn.size, a);
  for (const a of rootM ? rootM.assignments : []) {
    const id = a && guidSet(a.defID) ? guidStr(a.defID) : "#r" + rawOwn.size;
    if (rawOwn.has(id)) { SA.total++; SA.merged++; rawOwn.delete(id); }
    rawOwn.set(id, a);
  }
  if (rawOwn.size) {
    const r = assignments(cx, S0, [...rawOwn.values()], { nested: false, ignored: ignoredOwn });
    const kept = dedupe(r.kept, SA);
    if (kept.length) out.properties = kept;
    writeNotes(r.dropped, undefined);
  }

  // ---- 6. live entries ----
  for (const lv of live.values()) {
    const { guids, res, m } = lv;
    const els = res.elements;
    const T = els[els.length - 1];
    const recorded = els.every((x) => x.i !== undefined);
    const notCarried = local && !recorded;
    const b = baseOf(cx, X, guids, res);
    if (!X.allowed.has(b.type)) X.allowed.set(b.type, new Set(Object.keys(KNOWN_PROPS[b.type] || {}).concat(["name"]).filter((f) => own(OVERRIDE_FIELDS, f))));
    const t = translate({ fields: m.fields, base: b, allowed: X.allowed.get(b.type), isRoot: false, notCarried,
      bound: notCarried ? null : boundOf(cx, X, guids, res), path: guids });
    const o = { path: guids };
    if (local && recorded) o.at = els.map((x) => x.i);
    const fields = intern(t.written, t.composed, guids);
    if (Object.keys(fields).length) { o.fields = fields; classify(fields); }
    // The swap (D5, D8): a master reference, or dropped as dangling.
    const sw = m.fields.overriddenSymbolID;
    if (guidSet(sw)) {
      const v = guidStr(sw), declaredT = R.declared(T.n);
      const ref = cx.typeName(T.n) === "INSTANCE" && !notCarried && cx.props ? cx.props.refOf(v) : null;
      if (!ref) {
        SO.swaps.dropped++;
        if (cx.typeName(T.n) === "INSTANCE" && !notCarried) cx.noteAt(CODE.SWAP_VALUE_DANGLING, { node: i, path: guids, detail: "swap" + (cx.props && cx.props.symbolKnown(v) ? ": not carried" : "") });
      } else {
        o.swap = ref;
        SO.swaps.override++;
        if (v === declaredT) SO.swaps.noOp++;
        else if (cx.families && cx.families.setOf(v) && cx.families.setOf(v) === cx.families.setOf(declaredT)) SO.swaps.sameSet++;
      }
    }
    // Assignments to the nested instance, against its effective family (D6 "nested").
    if (m.assignments.length) {
      if (notCarried || cx.typeName(T.n) !== "INSTANCE") { SA.total += m.assignments.length; SA.droppedWithEntry += m.assignments.length; }
      else {
        const r = assignments(cx, T.symbol, m.assignments, { nested: true, ignored: ignoredAt.get(guids.join("/")) || new Set() });
        const kept = dedupe(r.kept, SA);
        if (kept.length) o.properties = kept;
        writeNotes(r.dropped, guids);
      }
    }
    if (o.fields || o.swap || o.properties) { L.written++; overrides.push(o); }
    else L.empty++;
  }
  // Hops whose symbol a swap property decided, once per nested instance path (derived and live paths).
  const byProperty = new Set();
  const hops = (res, guids) => { if (res && res.ok && !res.root) res.elements.forEach((x, k) => { if (x.via === "property") byProperty.add(guids.slice(0, k + 1).join("/")); }); };
  for (const d of n.derivedSymbolData || []) { const gg = R.pathGuids(d); if (gg.length) hops(R.resolve(n, gg), gg); }
  for (const lv of live.values()) hops(lv.res, lv.guids);
  SO.swaps.property += byProperty.size;

  // ---- 7. the notes per instance (D15) ----
  if (ignoredItems.length) cx.noteAt(CODE.SWAP_ASSIGNMENT_IGNORED, { node: i, detail: seenIgnored.size + " swap assignment" + (seenIgnored.size === 1 ? "" : "s") + " Pixso did not apply; the declared symbol is used" });
  if (mergedPaths) {
    SO.merged.paths += mergedPaths;
    SO.merged.conflicts += mergedConflicts;
    cx.noteAt(CODE.OVERRIDE_PATHS_MERGED, { node: i, detail: mergedPaths + " path" + (mergedPaths === 1 ? "" : "s") + ", " + mergedConflicts + " conflicting field" + (mergedConflicts === 1 ? "" : "s") + " (--override-merge " + rule + ")" });
  }
  if (echoes.size && st.echo !== "keep") {
    const total = [...echoes.values()].reduce((a, b2) => a + b2, 0);
    cx.noteAt(CODE.OVERRIDE_ECHO, { node: i, detail: total + " field" + (total === 1 ? "" : "s") + ": " + [...echoes].sort((a, b2) => (a[0] < b2[0] ? -1 : 1)).map(([f, c]) => f + " " + c).join(", ") });
  }
  for (const cls of NOTE_ORDER) {
    const m = dropped.get(cls);
    if (!m) continue;
    cx.noteAt(CODE.OVERRIDE_FIELD_DROPPED, { node: i, detail: cls + ": " + [...m].sort((a, b2) => (a[0] < b2[0] ? -1 : 1)).map(([f, c]) => f + " " + c).join(", ") });
  }

  // ---- 8. the instance's extras (D11) ----
  if (overrides.length) { out.overrides = overrides; out.overrideBasis = "authored"; }
  if (derived.length) out.derived = derived;
  if (n.propsAreBubbled) {
    if (insideComponent(cx, n)) { out.exposed = true; SI.exposed++; }
    else SI.exposedOutside++;
  }
  const usf = n.symbolData ? n.symbolData.uniformScaleFactor : undefined;
  if (isFin(usf) && usf > 0 && r6(usf) !== 1) { out.scale = r6(usf); SI.scaled++; }

  // ---- 9. G6's balances, per instance (a failure is a reader bug) ----
  const bad = [];
  if (L.entries !== L.root + L.live + L.stale) bad.push("entries");
  if (L.live !== L.distinct + L.mergedAway) bad.push("live");
  if (L.distinct !== L.written + L.empty) bad.push("distinct live paths");
  if (L.total !== L.translated + L.consumed + L.dropped) bad.push("Pixso fields");
  if (L.produced !== L.carried + L.echo) bad.push("Figma fields");
  if (bad.length) throw new Error("instanceData: " + g + ": the balances do not add up (" + bad.join(", ") + "): " + JSON.stringify(L));
  SO.entries += L.entries; SO.root += L.root; SO.emptyPath += L.emptyPath; SO.nonRoot += L.nonRoot; SO.live += L.live;
  SO.distinctLivePaths += L.distinct; SO.mergedAway += L.mergedAway; SO.written += L.written; SO.emptyAfterTranslation += L.empty;
  SO.pixsoFields.total += L.total; SO.pixsoFields.translated += L.translated; SO.pixsoFields.consumed += L.consumed;
  SO.fields.produced += L.produced; SO.fields.carried += L.carried;
  return out;
}

const NOTE_ORDER = ["no-equivalent", "not-on-type", "layer-not-carried", "root-box", "unknown"];

// Kept assignments, one per (family, id): a later duplicate (an alias and its root both assigned)
// wins, the earlier is counted merged.
function dedupe(kept, SA) {
  const m = new Map();
  for (const a of kept || []) {
    const k = a.family + "|" + a.id;
    if (m.has(k)) { m.delete(k); SA.kept--; SA.merged++; }
    m.set(k, a);
  }
  return [...m.values()];
}

function touchImages(cx, v) {
  if (!v || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v) touchImages(cx, x); return; }
  if (v.type === "IMAGE" && typeof v.imageHash === "string") cx.imageRef(v.imageHash);
}

function insideComponent(cx, n) {
  for (let p = parentOf(cx, n), guard = 0; p && guard < 10000; p = parentOf(cx, p), guard++) {
    if (cx.componentGuids && cx.componentGuids.has(guidStr(p.guid))) return true;
  }
  return false;
}
