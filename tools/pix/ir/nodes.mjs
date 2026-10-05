// The node walk: which stored nodes become IR records, of which type, with which props (docs/M1.md
// D1, D3-D7, D13, §6 A; IR.md §7).
//
// Two phases. plan() walks the stored tree page by page and decides, for every node, whether it is a
// record and of which IR type, or why it is not carried: a style definition, a variable, an
// unsupported type, a degenerate box or boolean, an operand folded into a flattened boolean, an
// instance whose master cannot be named, or a node outside the chosen scope. emit() then writes the
// records parent-first, siblings in position order, and their props.
import { CODE } from "../../ir/schema.mjs";
import { KNOWN_PROPS, DEFAULTS, NEVER_OMIT } from "../../ir/props.mjs";
import { canonicalJSON } from "../../ir/schema.mjs";
import { decodeVectorNetwork } from "../network.mjs";
import * as E from "./enums.mjs";
import { r2, r4, r6, isFin, matrixOf, matrixFinite, mapBox, unionBox, guidStr } from "./util.mjs";
import { effectsOf, exportSettingsOf, paintsOf } from "./paints.mjs";
import { strokeProps, cornerProps, sideCensus, visiblePaint, weightOf, SIDE_FIELDS } from "./strokes.mjs";
import { frameLayoutProps, childLayoutProps, isAutoLayout } from "./layout.mjs";
import { textProps, checkTextData } from "./text.mjs";
import { vectorProps, geometryOf, geometryBox, networkToIR, networkBox } from "./vector.mjs";
import { booleanClass, classBReason, flattens } from "./booleans.mjs";
import { componentEntry, masterRef } from "./components.mjs";

const NEVER = new Set(NEVER_OMIT);
const RECT_LIKE = new Set(["FRAME", "COMPONENT", "RECTANGLE"]);

const sizeFinite = (n) => !!n.size && isFin(n.size.x) && isFin(n.size.y);
const subtreeSize = (cx, n) => { let c = 1; for (const k of cx.childrenOf(n)) c += subtreeSize(cx, k); return c; };

// A box for a node whose stored size is not finite: from its stored fill geometry, its network, or
// its children. Coordinates in the node's own frame; null when nothing gives one.
function fallbackBox(cx, n, depth) {
  if (depth > 64) return null;
  const geom = geometryOf(cx, n.fillGeometry, { quiet: true });
  if (geom) return { box: geometryBox(geom), from: "the stored geometry" };
  const vd = n.vectorData;
  if (vd && vd.vectorNetworkBlob !== undefined) {
    const blob = cx.blob(vd.vectorNetworkBlob);
    if (blob && blob.length) {
      const ir = networkToIR(cx, decodeVectorNetwork(blob), 1, 1, null);
      const b = ir.bad ? null : networkBox(ir.value);
      if (b) return { box: b, from: "the vector network" };
    }
  }
  let box = null;
  for (const k of cx.childrenOf(n)) {
    if (!matrixFinite(k.transform)) continue;
    const kb = sizeFinite(k) ? { x0: 0, y0: 0, x1: k.size.x, y1: k.size.y } : (fallbackBox(cx, k, depth + 1) || {}).box;
    if (kb) box = unionBox(box, mapBox(k.transform, kb));
  }
  return box ? { box, from: "the children" } : null;
}

// ---------- phase 1: the plan ----------
// Every stored node under a page gets an entry { n, type | null, why, kids, ... }.
export function plan(cx, pageNodes, inScope) {
  const NC = cx.stats.notCarried;
  const B = cx.stats.booleans;
  const decide = (n, parentPlan) => {
    const t = cx.typeName(n);
    const p = { n, pix: t, type: null, kids: [], box: null, flatten: false, bclass: null };
    const skip = (why, count) => { p.why = why; NC[why] += count === undefined ? subtreeSize(cx, n) : count; return p; };
    if (n.styleType !== undefined) return skip("styleDefinitions");
    if (E.VARIABLE_TYPES.indexOf(t) >= 0) return skip("variables");
    let type = E.NODE_TYPE[t];
    if (!type) {
      cx.noteGuid(CODE.NODE_TYPE_UNSUPPORTED, guidStr(n.guid), "a " + (t || "unknown") + " node and its subtree (" + subtreeSize(cx, n) + " stored nodes)");
      return skip("unsupported");
    }
    if (!matrixFinite(n.transform)) {
      cx.noteGuid(CODE.GEOMETRY_INVALID, guidStr(n.guid), "a non-finite transform; not carried");
      return skip("degenerate");
    }
    if (!sizeFinite(n)) {
      const fb = fallbackBox(cx, n, 0);
      if (!fb) { cx.noteGuid(CODE.GEOMETRY_INVALID, guidStr(n.guid), "a non-finite size and no geometry or children to take a box from; not carried"); return skip("degenerate"); }
      p.box = { w: r2(fb.box.x1 - Math.min(0, fb.box.x0)), h: r2(fb.box.y1 - Math.min(0, fb.box.y0)), from: fb.from };
    }
    const kids = cx.childrenOf(n);
    if (t === "BOOLEAN_OPERATION") {
      const geom = geometryOf(cx, n.fillGeometry, { quiet: true });
      const cls = booleanClass(cx, n, kids, !!geom);
      p.bclass = cls;
      if (cls === "degenerate") {
        B.degenerate++;
        cx.noteGuid(CODE.GEOMETRY_INVALID, guidStr(n.guid), "a boolean with no operand and no stored geometry; not carried");
        return skip("degenerate");
      }
      if (flattens(cx.settings.booleans, cls)) {
        if (geom) { p.flatten = true; type = "VECTOR"; }
        else p.noGeometry = true;
      }
    }
    if (t === "LINE" && n.size && isFin(n.size.y) && n.size.y !== 0) {
      p.lineHeight = true;
      if (geometryOf(cx, n.fillGeometry, { quiet: true })) type = "VECTOR";
    }
    if ((t === "VECTOR" || t === "CONNECTLINE") && !hasVectorSource(cx, n)) {
      cx.noteGuid(CODE.GEOMETRY_INVALID, guidStr(n.guid), "a vector with no network and no stored geometry; not carried");
      return skip("degenerate");
    }
    p.type = type;
    if (p.flatten) {
      let folded = 0;
      for (const k of kids) folded += subtreeSize(cx, k);
      p.folded = folded;
      NC.foldedOperands += folded;
      return p;
    }
    if (type === "INSTANCE") {
      // An instance has no child records (IR.md §7); none is stored in the measured files.
      for (const k of kids) { NC.unsupported += subtreeSize(cx, k); cx.featureCount("child of an instance"); }
      return p;
    }
    for (const k of kids) { const c = decide(k, p); if (c.type) p.kids.push(c); }
    return p;
  };
  const out = [];
  for (const pg of pageNodes) {
    const tops = [];
    for (const k of cx.childrenOf(pg.canvas)) {
      if (!inScope(pg, k)) { NC.outOfScope += subtreeSize(cx, k); continue; }
      const c = decide(k, null); if (c.type) tops.push(c);
    }
    out.push({ page: pg, tops });
  }
  return out;
}

function hasVectorSource(cx, n) {
  const vd = n.vectorData;
  if (vd && vd.vectorNetworkBlob !== undefined) { const b = cx.blob(vd.vectorNetworkBlob); if (b && b.length) return true; }
  return !!geometryOf(cx, n.fillGeometry, { quiet: true });
}

// Instances whose master cannot be named are not carried; the masters a plan carries are known
// only once the whole plan is made.
export function resolveInstances(cx, planned) {
  const NC = cx.stats.notCarried;
  cx.componentGuids = new Set();
  const walk = (p, f) => { f(p); for (const k of p.kids) walk(k, f); };
  for (const pg of planned) for (const t of pg.tops) walk(t, (p) => { if (p.type === "COMPONENT") cx.componentGuids.add(guidStr(p.n.guid)); });
  const missing = new Set();
  for (const pg of planned) for (const t of pg.tops) walk(t, (p) => {
    if (p.type !== "INSTANCE") return;
    p.master = masterRef(cx, p.n);
    if (!p.master) {
      const sid = p.n.symbolData && p.n.symbolData.symbolID ? guidStr(p.n.symbolData.symbolID) : null;
      if (sid) missing.add(sid);
    }
  });
  return missing;
}

export function dropUnresolved(cx, planned) {
  const NC = cx.stats.notCarried;
  const fix = (list) => list.filter((p) => {
    if (p.type === "INSTANCE" && !p.master) {
      cx.noteGuid(CODE.NODE_TYPE_UNSUPPORTED, guidStr(p.n.guid), "an INSTANCE whose master is neither in this file nor a library copy; not carried");
      NC.unsupported++;
      return false;
    }
    p.kids = fix(p.kids);
    return true;
  });
  for (const pg of planned) pg.tops = fix(pg.tops);
}

// ---------- phase 2: records ----------
export function emit(cx, planned, out) {
  const { records, meta, components } = out;
  const B = cx.stats.booleans;
  const one = (p, parent, pageIndex, parentNode, internal) => {
    const n = p.n, i = records.length;
    const rec = { parent };
    if (parent === -1) rec.page = pageIndex;
    rec.guid = guidStr(n.guid);
    rec.type = p.type;
    rec.name = typeof n.name === "string" ? n.name : "";
    rec.props = {};
    records.push(rec);
    meta.push({ stateGroup: !!n.isStateGroup && p.type === "FRAME", lostBorder: false });
    cx.at = i;
    cx.featured = new Set();
    propsOf(cx, p, rec, parentNode, internal);
    if (p.type === "COMPONENT") components.push(componentEntry(cx, i, n, internal));
    if (p.type === "INSTANCE") rec.instance = { master: p.master };
    if (p.pix === "BOOLEAN_OPERATION") { if (p.flatten) B.flattened++; else if (p.type === "BOOLEAN_OPERATION") B.native++; }
    if (p.flatten) B.foldedNodes += p.folded;
    meta[i].lostBorder = isLostBorder(cx, n, p.pix);
    if (p.pix === "SECTION" && isLostBorderShape(cx, n)) cx.stats.lostBorderSections++;
    sideCensus(cx, n, p.pix);
    for (const k of p.kids) one(k, i, pageIndex, n, internal);
    cx.at = undefined;
  };
  for (let pi = 0; pi < planned.length; pi++) for (const t of planned[pi].tops) one(t, -1, pi, null, planned[pi].page.internal);
}

const isLostBorderShape = (cx, n) => n.styleType === undefined && visiblePaint(n.strokePaints) && weightOf(n) > 0 && !SIDE_FIELDS.some((k) => n[k] !== undefined);
function isLostBorder(cx, n, pixType) {
  return (pixType === "FRAME" || pixType === "SYMBOL" || pixType === "RECTANGLE") && isLostBorderShape(cx, n);
}

function propsOf(cx, p, rec, parentNode, internal) {
  const n = p.n, type = p.type, props = rec.props;
  const known = KNOWN_PROPS[type];
  const put = (k, v) => {
    if (v === undefined || !Object.prototype.hasOwnProperty.call(known, k)) return;
    if (!NEVER.has(k) && Object.prototype.hasOwnProperty.call(DEFAULTS, k) && canonicalJSON(v) === canonicalJSON(DEFAULTS[k])) return;
    props[k] = known[k] === "value" ? cx.value(v) : v;
  };
  // The box. A non-finite size takes the box planned for it.
  put("relativeTransform", matrixOf(n.transform).map(r4));
  const w = p.box ? p.box.w : r2(n.size.x), h = p.box ? p.box.h : r2(n.size.y);
  put("width", Math.max(0, w));
  put("height", type === "LINE" ? 0 : Math.max(0, h));
  if (p.box) cx.note(CODE.GEOMETRY_INVALID, "a non-finite size; the box comes from " + p.box.from);
  if (n.visible === false) put("visible", false);
  if (n.locked) put("locked", true);
  childLayoutProps(cx, n, put, parentNode, type !== "INSTANCE" && isAutoLayout(cx, n));
  if (type === "INSTANCE") return;   // a placeholder: its box and child layout only (docs/M1.md D6)

  if (type === "SECTION") {
    put("fills", paintsOf(cx, n.fillPaints));
    if (visiblePaint(n.strokePaints)) cx.feature("SECTION strokes");
    return;
  }
  if (type === "SLICE") { put("exportSettings", exportSettingsOf(cx, n.exportSettings)); return; }

  // Compositing.
  if (isFin(n.opacity)) put("opacity", r6(Math.max(0, Math.min(1, n.opacity))));
  put("blendMode", cx.en("PixsoNode", "blendMode")(n.blendMode) || "PASS_THROUGH");
  if (n.mask) {
    put("isMask", true);
    put("maskType", E.MASK_TYPE[cx.en("PixsoNode", "maskType")(n.maskType)] || (n.maskIsOutline ? "VECTOR" : "ALPHA"));
  }
  put("effects", effectsOf(cx, n.effects));
  if ((n.exportSettings || []).length) put("exportSettings", exportSettingsOf(cx, n.exportSettings));
  if (n.deformationTransform) cx.feature("deformationTransform");
  if (type === "GROUP") return;     // built as a frame with no paints and no clipping (docs/M1.md D4)

  const sides = RECT_LIKE.has(type);
  strokeProps(cx, n, type, put, { sides });
  cornerProps(cx, n, type, put, { sides });

  if (type === "FRAME" || type === "COMPONENT") frameLayoutProps(cx, n, put, cx.childrenOf(n));
  else if (type === "ELLIPSE") {
    if (n.arcData) put("arcData", { startingAngle: r6(n.arcData.startingAngle || 0), endingAngle: r6(isFin(n.arcData.endingAngle) ? n.arcData.endingAngle : 6.283185), innerRadius: r6(n.arcData.innerRadius || 0) });
  } else if (type === "STAR" || type === "POLYGON") {
    put("pointCount", Number.isInteger(n.count) && n.count >= 3 ? n.count : type === "STAR" ? 5 : 3);
    if (type === "STAR") put("innerRadius", r6(isFin(n.starInnerScale) ? n.starInnerScale : 0.382));
    const fill = geometryOf(cx, n.fillGeometry);
    put("oracleFillGeometry", fill || undefined);
    // Figma always draws a native STAR or POLYGON, so with nothing stored to hold its paths to the
    // judge would count 0 paths against Figma's (review S3): a counted loss of the oracle instead.
    if (!fill) cx.feature("no stored geometry", "a " + type + " built natively, its paths unchecked");
  } else if (type === "LINE") {
    if (p.lineHeight) cx.feature("LINE with height", "no stored geometry: built as a line, height dropped");
    put("oracleFillGeometry", geometryOf(cx, n.fillGeometry) || undefined);
  } else if (type === "BOOLEAN_OPERATION") {
    put("booleanOperation", E.BOOLEAN_OP[cx.en("PixsoNode", "booleanOperation")(n.booleanOperation)] || "UNION");
    put("oracleFillGeometry", geometryOf(cx, n.fillGeometry) || undefined);
    if (p.bclass === "B") cx.feature(classBReason(cx, cx.childrenOf(n)));
    if (p.noGeometry) cx.feature("boolean without stored geometry, built natively");
  } else if (type === "TEXT") {
    checkTextData(cx, n);
    textProps(cx, n, put);
  } else if (type === "VECTOR") {
    if (p.flatten) {
      const fill = geometryOf(cx, n.fillGeometry), stroke = geometryOf(cx, n.strokeGeometry);
      put("fillGeometry", fill);
      if (stroke) put("strokeGeometry", stroke);
      const op = E.BOOLEAN_OP[cx.en("PixsoNode", "booleanOperation")(n.booleanOperation)] || "UNION";
      const why = p.bclass === "B" ? "class B: " + classBReason(cx, cx.childrenOf(n)) : p.bclass === "empty" ? "no operand" : "--booleans flatten";
      cx.note(CODE.BOOLEAN_FLATTENED, op + " of " + cx.childrenOf(n).length + " operands, " + p.folded + " stored nodes folded (" + why + ")");
    } else if (p.pix === "LINE") {
      put("fillGeometry", geometryOf(cx, n.fillGeometry));
      const stroke = geometryOf(cx, n.strokeGeometry);
      if (stroke) put("strokeGeometry", stroke);
      cx.feature("LINE with height", "built as a VECTOR from its stored geometry");
    } else {
      if (p.pix === "CONNECTLINE") cx.feature("CONNECTLINE");
      vectorProps(cx, n, put, { w, h });
    }
  }
}
