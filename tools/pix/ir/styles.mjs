// The styles a node draws: fill, stroke and effect styles (docs/IR.md §7, §10; docs/M1.md §15.9).
//
// A node that references a style draws the style's current value, not its own copy of it: Pixso keeps
// the node's own paints as a cache that goes stale when the style changes (P, a render pair,
// 2026-10-05: a section whose own fill is grey and whose fill style is blue draws blue). So where the
// reference resolves to a style definition in the file that carries its value, that value is the
// node's (and the style is bound, IR `styles`); the node's own value is kept only when the style is not
// in the file, or carries no value there:
//   STYLE_VALUE_DIFFERS       the style's value is written over a node value it differs from (more than
//                             1/255 per channel or unit), the stale copy
//   STYLE_MISSING_IN_SOURCE   the reference resolves to no style definition of its kind, or to one with
//                             no value; the node's own value is kept
// A reference resolves by guid, or else through a style definition's overrideKey (a library style's
// local copy, REWRITE.md §3); "0:0" and the all-ones guid are no reference. A stroke style is a paint
// (FILL) style: its value is its fillPaints. Layout grids are not carried in M1 (counted), so a grid
// style changes nothing here; text styles are text.mjs's (review R2).
//
//   drawnStyles(cx, n) -> { n, fillStyle?, strokeStyle?, effectStyle? }
//     n: the node itself, or a shallow copy whose fillPaints, strokePaints and effects are the ones it
//     draws; the *Style values are indices into cx.styles (the IR's `styles`).
import { CODE, valueSignature } from "../../ir/schema.mjs";
import { effectsOf, paintsOf } from "./paints.mjs";
import { guidSet, guidStr } from "./util.mjs";

const KINDS = [
  { kind: "fill", ref: "inheritFillStyleID", own: "fillPaints", from: "fillPaints", prop: "fillStyle", styleType: "FILL", type: "PAINT", conv: paintsOf },
  { kind: "stroke", ref: "inheritStrokeStyleID", own: "strokePaints", from: "fillPaints", prop: "strokeStyle", styleType: "FILL", type: "PAINT", conv: paintsOf },
  { kind: "effect", ref: "inheritEffectStyleID", own: "effects", from: "effects", prop: "effectStyle", styleType: "EFFECT", type: "EFFECT", conv: effectsOf },
];
const TOL = 1 / 255 + 1e-6;

// Two IR values alike within TOL in every number, the same in everything else.
function alike(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= TOL;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => alike(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && alike(a[k], b[k]));
  }
  return a === b;
}

// The reader's context with its counting turned off, for converting a value only to compare it.
function quiet(cx) {
  const q = Object.create(cx);
  q.feature = () => {};
  q.featureCount = () => {};
  q.imageRef = () => {};
  q.note = () => {};
  return q;
}

function styleNode(cx, ref) {
  const g = guidStr(ref);
  const byGuid = cx.byGuid.get(g);
  if (byGuid && byGuid.styleType !== undefined) return byGuid;
  if (!cx.styleByOverrideKey) {
    cx.styleByOverrideKey = new Map();
    for (const x of cx.pix.nodes) if (x.styleType !== undefined && guidSet(x.overrideKey) && !cx.styleByOverrideKey.has(guidStr(x.overrideKey))) cx.styleByOverrideKey.set(guidStr(x.overrideKey), x);
  }
  return cx.styleByOverrideKey.get(g) || null;
}

// The IR style entry for a definition and the value it draws, one per identity (styleKey plus
// signature, docs/IR.md §10), and one per guid.
function styleEntry(cx, st, type, value) {
  const guid = guidStr(st.guid), sig = valueSignature(value);
  // The style's key: its own `key` field (P, K, M, D), or its shared-style master data's.
  const sm = st.sharedStyleMasterData && typeof st.sharedStyleMasterData.styleKey === "string" ? st.sharedStyleMasterData.styleKey : "";
  const key = typeof st.key === "string" && st.key.length ? st.key : sm.length ? sm : null;
  const id = key !== null ? "key:" + key + "|" + sig : "guid:" + guid + "|" + sig;
  if (cx.styleIds.has(id)) return cx.styleIds.get(id);
  if (cx.styleGuids.has(guid)) return cx.styleGuids.get(guid);
  const e = { guid, type, name: typeof st.name === "string" ? st.name : "", styleKey: key, value: cx.value(value), signature: sig };
  if (st.isSoftDeletedStyle === true) e.deleted = true;
  const i = cx.styles.length;
  cx.styles.push(e);
  cx.styleIds.set(id, i);
  cx.styleGuids.set(guid, i);
  return i;
}

export function drawnStyles(cx, n) {
  const out = { n };
  let copy = null;
  for (const K of KINDS) {
    if (!guidSet(n[K.ref])) continue;
    const st = styleNode(cx, n[K.ref]);
    const styleType = st ? cx.en("PixsoNode", "styleType")(st.styleType) : null;
    if (!st || styleType !== K.styleType) {
      cx.stats.styles[K.kind].missing++;
      cx.note(CODE.STYLE_MISSING_IN_SOURCE, K.kind + " style not in the file; the node's own value kept");
      continue;
    }
    if (!Array.isArray(st[K.from])) {
      cx.stats.styles[K.kind].noValue++;
      cx.note(CODE.STYLE_MISSING_IN_SOURCE, K.kind + " style with no value in the file; the node's own value kept");
      continue;
    }
    const q = quiet(cx);
    const value = K.conv(q, st[K.from]);
    if (!alike(value, K.conv(q, n[K.own] || []))) {
      cx.stats.styles[K.kind].styleWins++;
      cx.note(CODE.STYLE_VALUE_DIFFERS, K.kind + ": the style's value is drawn; the node's own copy differs and is replaced");
    } else cx.stats.styles[K.kind].same++;
    if (!copy) copy = Object.assign({}, n);
    copy[K.own] = st[K.from];
    out[K.prop] = styleEntry(cx, st, K.type, value);
  }
  if (copy) out.n = copy;
  return out;
}
