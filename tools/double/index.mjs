// A headless double of the Figma plugin API, for testing the M1 plugin code on this machine
// (docs/M1.md §5.4, §6 E). Part P0 wrote its core; part E owns it (§9) and added the layout engine
// (layout.mjs), the text model (text.mjs), vector placement and boolean geometry (geom.mjs), image
// formats and refusals (images.mjs), and the probe verdicts it follows (behaviour.mjs).
//
//   import { makeDouble } from "../double/index.mjs";
//   const D = makeDouble({ fonts, verdicts, allow, faults, ui, textRatio });
//   D.figma            the `figma` global to hand the plugin code (tools/ir/plugin-vm.mjs)
//   D.writes           [{ phase, id, type, prop, value }]: every assignment, and every mutating call
//                      as prop "name()" with its arguments as value, in order
//   D.reads            { total, byPhase: { phase: n }, log: [{ phase, id, type, prop }] }: layout-forcing
//                      reads only (surface.mjs LAYOUT_GETTERS); a read with no phase set is booked
//                      under "(none)"
//   D.setPhase(name)   the phase writes and reads are booked under (ctx.phase tells it, through
//                      host.phase)
//   D.tree()           the document as plain data: { id, type, name, relativeTransform, width, height,
//                      props, pluginData, sharedPluginData, children }, laid out first
//   D.node(id)         the node with that id (a Proxy), or null
//   D.rangesOf(id)     a text node's ranges, [{ name, start, end, value }] (tests only)
//   D.ui               { posted: [message] }: what the plugin code sent through figma.ui.postMessage
//   D.images           Map(hash -> byte length) of the images created
//   D.loadedFonts()    ["family|style"] loaded so far
//   D.assumed          ["P19B.offsetNetwork", …]: the probe cases this double follows by assumption,
//                      because verdicts.json still says pending (behaviour.mjs)
//   D.layoutPasses     how many layout passes ran (a test of laziness)
//
// Options:
//   fonts     [{ family, style }] Figma has; loadFontAsync rejects any other (DEFAULT_FONTS when absent)
//   verdicts  tools/double/verdicts.json's shape (that file when absent): the double follows every
//             recorded case and assumes the pending ones (behaviour.mjs MODEL); a recorded value it
//             cannot model refuses to build the double
//   allow     surface additions for one test, { figma: [name], nodes: { TYPE or "*": { read, write,
//             methods } } }; list them in the pull request, F folds them into surface.mjs
//   faults    { figmaCallName: message }: that figma call throws (or rejects) with the message, for
//             fallback tests (a boolean operation Figma refuses)
//   ui        (message) => void: called after each figma.ui.postMessage, so a test can play the
//             plugin window (the probes move bytes through it)
//   textRatio Figma's text width over Pixso's for the same string (text.mjs; 1.0105 by default)
//
// What it models:
//   - a tree of pages and nodes; relative and absolute transforms, sizes and bounding boxes; private
//     and shared plugin data; the write log; layout reads counted per phase;
//   - layout, lazily: a write marks its top-level tree dirty, and the next geometry read of that tree
//     lays it out (layout.mjs: auto layout, hug and fill, padding floor, min and max, wrap, hidden and
//     absolute children out of the flow, constraints on resize); a flow child's rotation is dropped
//     when written (builder4.js:381-389, measured);
//   - strokeWeight resetting the four side weights (figma.mixed while they differ), cornerRadius
//     likewise for the corners;
//   - text (text.mjs): a missing-font throw on any write that lays text out, every font of the text
//     loaded first; ranges per UTF-16 index, cleared by a node-level write of the same field; a write
//     of characters keeps only the first character's (stretched over the new text, A); node-level
//     reads give figma.mixed where ranges differ; auto
//     width and height from the width model; resize resetting textAutoResize as the UI does (an
//     auto-width text resized in width becomes auto-height, any text resized in height becomes fixed;
//     A until a live check);
//   - vectors: a network's regions give fillGeometry (lines and cubics); per verdicts, the region-less
//     cases, vertex radii and region fills, an open subpath in vectorPaths, and where the node's origin
//     goes when the network's bounds do not start at (0, 0) (P19B offsetNetwork: assumed, Figma moves
//     the origin to the bounds and keeps the drawing in place, and the node's size becomes the bounds);
//     RIGHT_ANGLE mirroring rejected; resize scales the drawing;
//   - polygons, stars, ellipses, rectangles and frames have their fill geometry; strokeGeometry is
//     the stroked box only (BOX MODEL: Figma's outline is not computed);
//   - booleans: a node over its operands with the operation of their fill areas (geom.mjs, approximate,
//     operand strokes ignored unless the verdicts say otherwise), its box the result's bounds;
//   - images: createImage with SHA-1, size from the PNG, JPEG, GIF or WebP header, and P8's refusals;
//     an IMAGE paint whose hash no image has, per P8 unknownHash; frame masks per P19B;
//   - figma.ui.postMessage recorded and handed to the test.
// Nodes are Proxies. Reading, writing or calling anything outside surface.mjs throws, naming the
// type and the property, so a gap in the surface is found here and not in Figma.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACE, LAYOUT_GETTERS } from "./surface.mjs";
import { layoutTree, applyConstraints, isAutoLayout, inFlow, flowFills } from "./layout.mjs";
import { textMetrics, DEFAULT_TEXT_RATIO } from "./text.mjs";
import { sniffImage, p8Case } from "./images.mjs";
import { behaviour } from "./behaviour.mjs";
import { parsePath, formatPath, mapPath, pathsBox, networkBox, shiftNetwork, scaleNetwork, networkPathAll, rectPath, ellipsePath, arcPath,
  polygonPath, starPath, booleanResult } from "./geom.mjs";

export { textMetrics, DEFAULT_TEXT_RATIO } from "./text.mjs";
export { MODEL, behaviour } from "./behaviour.mjs";
export { sniffImage, p8Case } from "./images.mjs";

// What this double models beyond P0's core, so a test of part B or C can tell "pending: E" from a
// real check (docs/M1.md §6 B, §6 C).
export const DOUBLE_FEATURES = Object.freeze({ layout: true, text: true, booleans: true, vectorPlacement: true, images: true, verdicts: true });

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FONTS = Object.freeze([{ family: "Inter", style: "Regular" }, { family: "Inter", style: "Medium" },
  { family: "Inter", style: "Bold" }, { family: "Roboto", style: "Regular" }]);
export function loadVerdicts() { return JSON.parse(readFileSync(join(HERE, "verdicts.json"), "utf8")); }

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const fkey = (f) => (f && typeof f === "object" ? f.family + "|" + f.style : String(f));
const r4 = (n) => String(Math.round(n * 10000) / 10000);
const SOLID = (r, g, b) => ({ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r, g, b } });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Figma's own defaults for a new node: they differ by type, which is why the IR writes the
// NEVER_OMIT props explicitly. The axis sizing of a new frame (primary AUTO, counter FIXED) is A.
const COMMON_DEFAULTS = { visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", isMask: false, maskType: "ALPHA",
  effects: [], exportSettings: [], constraints: { horizontal: "MIN", vertical: "MIN" }, layoutPositioning: "AUTO",
  layoutAlign: "INHERIT", layoutGrow: 0, strokes: [], strokeWeight: 1, strokeJoin: "MITER", strokeCap: "NONE",
  strokeMiterLimit: 4, dashPattern: [], cornerRadius: 0, cornerSmoothing: 0, minWidth: null, maxWidth: null, minHeight: null, maxHeight: null };
const FRAME_DEFAULTS = { strokeAlign: "INSIDE", layoutMode: "NONE", layoutWrap: "NO_WRAP", primaryAxisSizingMode: "AUTO",
  counterAxisSizingMode: "FIXED", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", counterAxisAlignContent: "AUTO",
  paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, itemSpacing: 0, counterAxisSpacing: 0, itemReverseZIndex: false,
  strokesIncludedInLayout: false, layoutGrids: [], overflowDirection: "NONE" };
const TYPE_DEFAULTS = {
  FRAME: Object.assign({ fills: [SOLID(1, 1, 1)], clipsContent: true, size: [100, 100] }, FRAME_DEFAULTS),
  COMPONENT: Object.assign({ fills: [SOLID(1, 1, 1)], clipsContent: false, size: [100, 100] }, FRAME_DEFAULTS),
  SECTION: { fills: [SOLID(1, 1, 1)], size: [100, 100] },
  RECTANGLE: { fills: [SOLID(0.85, 0.85, 0.85)], strokeAlign: "INSIDE", size: [100, 100] },
  ELLIPSE: { fills: [SOLID(0.85, 0.85, 0.85)], strokeAlign: "INSIDE", arcData: { startingAngle: 0, endingAngle: 6.283185307179586, innerRadius: 0 }, size: [100, 100] },
  POLYGON: { fills: [SOLID(0.85, 0.85, 0.85)], strokeAlign: "INSIDE", pointCount: 3, size: [100, 100] },
  STAR: { fills: [SOLID(0.85, 0.85, 0.85)], strokeAlign: "INSIDE", pointCount: 5, innerRadius: 0.382, size: [100, 100] },
  LINE: { fills: [], strokes: [SOLID(0, 0, 0)], strokeAlign: "CENTER", size: [100, 0] },
  VECTOR: { fills: [], strokeAlign: "CENTER", size: [0, 0] },
  BOOLEAN_OPERATION: { fills: [SOLID(0.85, 0.85, 0.85)], strokeAlign: "CENTER", booleanOperation: "UNION", size: [0, 0] },
  TEXT: { fills: [SOLID(0, 0, 0)], strokeAlign: "OUTSIDE", characters: "", fontName: { family: "Inter", style: "Regular" },
    fontSize: 12, textAutoResize: "WIDTH_AND_HEIGHT", textAlignHorizontal: "LEFT", textAlignVertical: "TOP",
    letterSpacing: { unit: "PERCENT", value: 0 }, lineHeight: { unit: "AUTO" }, paragraphIndent: 0, paragraphSpacing: 0, listSpacing: 0,
    textCase: "ORIGINAL", textDecoration: "NONE", textTruncation: "DISABLED", maxLines: null, leadingTrim: "NONE",
    hangingPunctuation: false, hangingList: false, size: [0, 14] },
};
// Text props whose write lays text out, and so needs the text's fonts loaded (Figma throws otherwise).
const TEXT_LAYOUT = ["characters", "fontSize", "fontName", "textCase", "textDecoration", "letterSpacing", "lineHeight",
  "paragraphIndent", "paragraphSpacing", "listSpacing", "leadingTrim", "hangingPunctuation", "hangingList"];
// Node-level text fields that ranges can split, and the range setter of each.
const RANGE_FIELD = { fontName: "setRangeFontName", fontSize: "setRangeFontSize", fills: "setRangeFills", textCase: "setRangeTextCase",
  textDecoration: "setRangeTextDecoration", letterSpacing: "setRangeLetterSpacing", lineHeight: "setRangeLineHeight",
  hyperlink: "setRangeHyperlink", listOptions: "setRangeListOptions", indentation: "setRangeIndentation", listSpacing: "setRangeListSpacing",
  paragraphIndent: "setRangeParagraphIndent", paragraphSpacing: "setRangeParagraphSpacing" };
const SIDES = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];
const CORNERS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
const CONTAINERS = ["DOCUMENT", "PAGE", "FRAME", "COMPONENT", "SECTION", "BOOLEAN_OPERATION"];
// Reads that need the tree laid out first (the layout-forcing getters, and what layout moves).
const GEOMETRY_READS = new Set(LAYOUT_GETTERS.concat(["relativeTransform", "fillGeometry", "strokeGeometry", "vectorNetwork", "vectorPaths",
  "rotation"]));

// 2x3 matrices [[a, b, tx], [c, d, ty]].
const I = () => [[1, 0, 0], [0, 1, 0]];
const mul = (m, n) => [
  [m[0][0] * n[0][0] + m[0][1] * n[1][0], m[0][0] * n[0][1] + m[0][1] * n[1][1], m[0][0] * n[0][2] + m[0][1] * n[1][2] + m[0][2]],
  [m[1][0] * n[0][0] + m[1][1] * n[1][0], m[1][0] * n[0][1] + m[1][1] * n[1][1], m[1][0] * n[0][2] + m[1][1] * n[1][2] + m[1][2]]];
const inv = (m) => {
  const a = m[0][0], b = m[0][1], tx = m[0][2], c = m[1][0], d = m[1][1], ty = m[1][2], det = a * d - b * c;
  return [[d / det, -b / det, (b * ty - d * tx) / det], [-c / det, a / det, (c * tx - a * ty) / det]];
};
const ap = (m, x, y) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
const sha1 = (u8) => createHash("sha1").update(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)).digest("hex");

// A region's loops as one Figma path string: lines where a segment has no tangents, cubics where it has.
export function networkRegionPath(net, region) {
  const V = net.vertices, S = net.segments, parts = [];
  for (const loop of region.loops) {
    if (!loop.length) continue;
    const s0 = S[loop[0]], s1 = loop.length > 1 ? S[loop[1]] : null;
    let cur = s1 && (s0.start === s1.start || s0.start === s1.end) ? s0.end : s0.start;
    parts.push("M " + r4(V[cur].x) + " " + r4(V[cur].y));
    for (const si of loop) {
      const s = S[si], fwd = s.start === cur;
      const from = fwd ? s.start : s.end, to = fwd ? s.end : s.start;
      const t1 = (fwd ? s.tangentStart : s.tangentEnd) || { x: 0, y: 0 }, t2 = (fwd ? s.tangentEnd : s.tangentStart) || { x: 0, y: 0 };
      const a = V[from], b = V[to];
      if (!t1.x && !t1.y && !t2.x && !t2.y) parts.push("L " + r4(b.x) + " " + r4(b.y));
      else parts.push("C " + r4(a.x + t1.x) + " " + r4(a.y + t1.y) + " " + r4(b.x + t2.x) + " " + r4(b.y + t2.y) + " " + r4(b.x) + " " + r4(b.y));
      cur = to;
    }
    parts.push("Z");
  }
  return parts.join(" ");
}

// The loops and chains a network draws without regions: each connected run of segments whose
// vertices all have two segments (a closed loop), or two ends and the rest two (an open chain).
export function networkRuns(net) {
  const S = net.segments || [], deg = {}, at = {};
  S.forEach((s, i) => { for (const v of [s.start, s.end]) { deg[v] = (deg[v] || 0) + 1; (at[v] || (at[v] = [])).push(i); } });
  const used = new Set(), runs = [];
  const walk = (v0, first) => {
    const order = [];
    let v = v0, si = first;
    while (si !== undefined && !used.has(si)) {
      used.add(si); order.push(si);
      const s = S[si]; v = s.start === v ? s.end : s.start;
      si = (at[v] || []).find((k) => !used.has(k));
      if (deg[v] !== 2) break;
    }
    return order;
  };
  for (const v of Object.keys(deg)) if (deg[v] === 1) { const k = at[v][0]; if (!used.has(k)) runs.push({ closed: false, loop: walk(Number(v), k) }); }
  S.forEach((s, i) => {
    if (used.has(i)) return;
    const loop = walk(s.start, i);
    const closed = loop.length > 1 && loop.every((k) => deg[S[k].start] === 2 && deg[S[k].end] === 2);
    runs.push({ closed, loop });
  });
  return runs.filter((r) => r.loop.length && r.loop.every((k) => deg[S[k].start] <= 2 && deg[S[k].end] <= 2));
}

export function makeDouble(opts = {}) {
  const available = new Set((opts.fonts || DEFAULT_FONTS).map(fkey));
  const verdicts = opts.verdicts || loadVerdicts();
  const beh = behaviour(verdicts);
  const V = beh.of;
  const ratio = typeof opts.textRatio === "number" && opts.textRatio > 0 ? opts.textRatio : DEFAULT_TEXT_RATIO;
  const allow = opts.allow || {};
  const faults = opts.faults || {};
  const uiPosted = [];
  const ui = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
      if (SURFACE.ui.methods.indexOf(prop) < 0) throw outside("figma.ui." + String(prop));
      return (m) => { uiPosted.push(clone(m)); if (typeof opts.ui === "function") opts.ui(clone(m)); };
    },
    set(_, prop) { throw outside("writing figma.ui." + String(prop) + " (the host, code.js, owns figma.ui.onmessage)"); },
  });
  const loaded = new Set();
  const writes = [];
  const reads = { total: 0, byPhase: {}, log: [] };
  const images = new Map();        // hash -> byte length
  const imageCase = new Map();     // hash -> the P8 verdict its bytes met ("drop" and "empty" matter later)
  const byId = new Map();
  const mixed = Symbol("figma.mixed");
  const dirty = new Set();
  let phase = null, seq = 0, currentPage = null, passes = 0;

  const allowed = (type, kind, prop) => {
    const n = allow.nodes || {};
    return [n[type], n["*"]].some((e) => e && Array.isArray(e[kind]) && e[kind].indexOf(prop) >= 0);
  };
  const surf = (type) => SURFACE.nodes[type] || { read: {}, write: [], methods: [] };
  const canRead = (type, p) => Object.prototype.hasOwnProperty.call(surf(type).read, p) || allowed(type, "read", p);
  const canWrite = (type, p) => surf(type).write.indexOf(p) >= 0 || allowed(type, "write", p);
  const canCall = (type, p) => surf(type).methods.indexOf(p) >= 0 || allowed(type, "methods", p);
  const outside = (what) => new Error("double: " + what + " is outside the surface (tools/double/surface.mjs); allow it with makeDouble({ allow }) and list it in the pull request");
  const logWrite = (st, prop, value) => writes.push({ phase, id: st.id, type: st.type, prop, value: clone(value) });
  const layoutRead = (st, prop) => {
    reads.total++;
    const k = phase === null ? "(none)" : phase;
    reads.byPhase[k] = (reads.byPhase[k] || 0) + 1;
    reads.log.push({ phase, id: st.id, type: st.type, prop });
  };

  // ---------- node state ----------
  function newState(type, id) {
    const td = TYPE_DEFAULTS[type] || {};
    const st = { id: id || "1:" + (++seq), type, name: type === "PAGE" ? "Page" : type, parent: null, removed: false,
      children: CONTAINERS.indexOf(type) >= 0 ? [] : null, rt: I(), w: td.size ? td.size[0] : 0, h: td.size ? td.size[1] : 0,
      props: {}, pd: {}, spd: {}, network: null, paths: null, ranges: [], boolPaths: null, boolKey: null, fromPaths: false, proxy: null };
    if (type !== "DOCUMENT" && type !== "PAGE") {
      Object.assign(st.props, clone(COMMON_DEFAULTS));
      for (const k of Object.keys(td)) if (k !== "size") st.props[k] = clone(td[k]);
      for (const s of SIDES) st.props[s] = st.props.strokeWeight;
      for (const c of CORNERS) st.props[c] = st.props.cornerRadius;
    }
    if (type === "PAGE") st.props.backgrounds = [SOLID(0.96, 0.96, 0.96)];
    st.proxy = proxyOf(st);
    byId.set(st.id, st);
    return st;
  }
  const stOf = (p) => { const st = p && p.__doubleState; if (!st) throw new Error("double: not a node of this double"); return st; };
  const topOf = (st) => { let s = st; while (s.parent && s.parent.type !== "PAGE" && s.parent.type !== "DOCUMENT") s = s.parent; return s; };
  const touch = (st) => { if (st && st.type !== "PAGE" && st.type !== "DOCUMENT") dirty.add(topOf(st)); };
  function settle(st) {
    if (!st || st.type === "PAGE" || st.type === "DOCUMENT") return;
    const top = topOf(st);
    if (!dirty.has(top)) return;
    dirty.delete(top);
    passes += layoutTree(H, top);
  }
  function settleAll() { for (const t of Array.from(dirty)) { dirty.delete(t); if (!t.removed) passes += layoutTree(H, t); } }
  function detach(st) {
    if (st.parent) { touch(st.parent); const i = st.parent.children.indexOf(st); if (i >= 0) st.parent.children.splice(i, 1); }
    st.parent = null;
  }
  function attach(parent, st, index) {
    if (!parent.children) throw new Error("double: a " + parent.type + " has no children");
    for (let a = parent; a; a = a.parent) if (a === st) throw new Error("double: a node cannot be its own ancestor");
    detach(st);
    st.parent = parent;
    if (index === undefined || index === null || index >= parent.children.length) parent.children.push(st);
    else parent.children.splice(Math.max(0, index), 0, st);
    touch(st);
  }
  function absOf(st) {
    let m = st.rt;
    for (let p = st.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) m = mul(p.rt, m);
    return m;
  }
  function bbox(st) {
    const t = absOf(st);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [cx, cy] of [[0, 0], [st.w, 0], [0, st.h], [st.w, st.h]]) {
      const [px, py] = ap(t, cx, cy);
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  // ---------- geometry ----------
  function vectorFill(st) {
    if (st.paths) {
      return st.paths.filter((p) => p.windingRule !== "NONE").filter((p) => {
        if (V("P19B", "autoClosedLoop") !== "empty") return true;
        return parsePath(p.data).every((s) => s.closed || !s.segs.length);
      }).map((p) => ({ windingRule: p.windingRule, data: p.data }));
    }
    if (!st.network) return [];
    const net = st.network, out = [];
    if (V("P19B", "fillGeometryAgainstNetwork") === "empty") return [];
    for (const r of net.regions || []) out.push({ windingRule: r.windingRule || "NONZERO", data: networkRegionPath(net, r) });
    if (!(net.regions || []).length) {
      for (const run of networkRuns(net)) {
        const fill = run.closed ? V("P19B", "regionlessFill") === "ok" : V("P19", "openRegionlessNetworkFilled") === "ok";
        if (fill) out.push({ windingRule: "NONZERO", data: networkRegionPath(net, { loops: [run.loop] }) });
      }
    }
    return out;
  }
  function fillGeometry(st) {
    switch (st.type) {
      case "VECTOR": return vectorFill(st);
      case "FRAME": case "COMPONENT": case "RECTANGLE": return [{ windingRule: "NONZERO", data: rectPath(st.w, st.h) }];
      case "ELLIPSE": {
        // A sweep short of Figma's 32-bit 2π is an arc (P19B arcFullSweep "arc", assumed); under "ok"
        // Figma closes any sweep within 1e-5 of a full turn.
        const a = st.props.arcData;
        const closed = V("P19B", "arcFullSweep") === "ok" && a && Math.abs(a.endingAngle - a.startingAngle - 2 * Math.PI) < 1e-5 && !(a.innerRadius > 0);
        return [{ windingRule: "NONZERO", data: (!closed && arcPath(st.w, st.h, a)) || ellipsePath(st.w, st.h) }];
      }
      case "POLYGON": return [{ windingRule: "NONZERO", data: polygonPath(st.props.pointCount, st.w, st.h) }];
      case "STAR": return [{ windingRule: "NONZERO", data: starPath(st.props.pointCount, st.props.innerRadius, st.w, st.h) }];
      case "BOOLEAN_OPERATION": return clone(st.boolPaths || []);
      default: return [];
    }
  }
  const visibleStroke = (st) => Array.isArray(st.props.strokes) && st.props.strokes.some((s) => s && s.visible !== false) && (Number(st.props.strokeWeight) > 0 || SIDES.some((k) => st.props[k] > 0));
  // The stroked box: the drawing's box grown by the part of the stroke outside it (BOX MODEL).
  function strokeBox(st) {
    if (!visibleStroke(st)) return null;
    let b;
    if (st.type === "VECTOR") b = pathsBox(st.paths || (st.network ? [{ data: networkPathAll(st.network) }] : []));
    else b = { x0: 0, y0: 0, x1: st.w, y1: st.h };
    if (!b) return null;
    const wt = typeof st.props.strokeWeight === "number" ? st.props.strokeWeight : Math.max.apply(null, SIDES.map((k) => st.props[k] || 0));
    const align = st.type === "LINE" || st.type === "VECTOR" && st.props.strokeAlign === undefined ? "CENTER" : st.props.strokeAlign;
    const g = align === "OUTSIDE" ? wt : align === "INSIDE" ? 0 : wt / 2;
    return { x0: b.x0 - g, y0: b.y0 - g, x1: b.x1 + g, y1: b.y1 + g };
  }
  function strokeGeometry(st) {
    if (st.type === "VECTOR" && st.fromPaths && V("P19B", "flattenedWithStroke") === "empty") return [];
    const b = strokeBox(st);
    if (!b) return [];
    return [{ windingRule: "NONZERO", data: "M " + r4(b.x0) + " " + r4(b.y0) + " L " + r4(b.x1) + " " + r4(b.y0) + " L " + r4(b.x1) + " " + r4(b.y1) + " L " + r4(b.x0) + " " + r4(b.y1) + " L " + r4(b.x0) + " " + r4(b.y0) + " Z" }];
  }
  // A boolean: its box is its result's bounds in its own frame; the operands keep where they are.
  function refreshBoolean(st) {
    const op = st.props.booleanOperation || "UNION";
    const kids = (st.children || []).filter((c) => c.props.visible !== false);
    const operands = kids.map((c) => {
      const paths = fillGeometry(c).map((p) => ({ windingRule: p.windingRule, data: mapPath(p.data, c.rt) }));
      const extra = [];
      if ((c.type === "LINE" && V("P19B", "lineOperand") === "differs") || (c.type !== "LINE" && V("P19B", "strokedOperand") === "differs")) {
        const b = strokeBox(c);
        if (b) extra.push({ windingRule: "NONZERO", data: mapPath("M " + r4(b.x0) + " " + r4(b.y0) + " L " + r4(b.x1) + " " + r4(b.y0) + " L " + r4(b.x1) + " " + r4(b.y1) + " L " + r4(b.x0) + " " + r4(b.y1) + " Z", c.rt) });
      }
      return { paths: paths.concat(extra) };
    });
    if (boolKeyOf(st) === st.boolKey) return;
    const emptyVerdict = { UNION: "booleanUnion", SUBTRACT: "booleanSubtract", INTERSECT: "booleanIntersect", EXCLUDE: "booleanExclude" }[op];
    const res = operands.length ? booleanResult(op, operands) : { paths: [], box: null };
    const box = res.box;
    if (box && (box.x0 || box.y0)) {
      const [dx, dy] = [st.rt[0][0] * box.x0 + st.rt[0][1] * box.y0, st.rt[1][0] * box.x0 + st.rt[1][1] * box.y0];
      st.rt[0][2] += dx; st.rt[1][2] += dy;
      for (const c of st.children) { c.rt[0][2] -= box.x0; c.rt[1][2] -= box.y0; }
    }
    if (box) { st.w = box.x1 - box.x0; st.h = box.y1 - box.y0; }
    const shift = box ? [[1, 0, -box.x0], [0, 1, -box.y0]] : I();
    st.boolPaths = V("P19B", emptyVerdict) === "empty" ? [] : res.paths.map((p) => ({ windingRule: p.windingRule, data: mapPath(p.data, shift) }));
    // The key after the shift, so an unchanged boolean is not recomputed on the next pass.
    st.boolKey = boolKeyOf(st);
  }
  function boolKeyOf(st) {
    return JSON.stringify([st.props.booleanOperation, (st.children || []).map((c) => [c.type, c.rt, c.w, c.h, c.props.visible, c.props.strokes,
      c.props.strokeWeight, c.props.strokeAlign, c.props.pointCount, c.props.innerRadius, c.paths, c.network, c.boolKey])]);
  }

  // ---------- text ----------
  function styleAt(st) {
    const P = st.props;
    return (i) => {
      const s = { fontName: P.fontName, fontSize: P.fontSize, letterSpacing: P.letterSpacing, lineHeight: P.lineHeight, textCase: P.textCase };
      for (const r of st.ranges) {
        if (i < r.start || i >= r.end) continue;
        if (r.name === "setRangeFontName") s.fontName = r.value;
        else if (r.name === "setRangeFontSize") s.fontSize = r.value;
        else if (r.name === "setRangeLetterSpacing") s.letterSpacing = r.value;
        else if (r.name === "setRangeLineHeight") s.lineHeight = r.value;
        else if (r.name === "setRangeTextCase") s.textCase = r.value;
      }
      return s;
    };
  }
  function measure(st, width) {
    const P = st.props;
    return textMetrics({ characters: P.characters || "", styleAt: styleAt(st), paragraphSpacing: P.paragraphSpacing, paragraphIndent: P.paragraphIndent,
      textTruncation: P.textTruncation, maxLines: P.maxLines, leadingTrim: P.leadingTrim }, { width, ratio });
  }
  function fontsOf(st) {
    const out = [st.props.fontName];
    for (const r of st.ranges) if (r.name === "setRangeFontName") out.push(r.value);
    return out;
  }
  function needFonts(fonts) {
    for (const f of fonts) if (!loaded.has(fkey(f))) throw new Error("double: unloaded font \"" + fkey(f) + "\": call figma.loadFontAsync before writing text (as Figma requires)");
  }
  // A node-level read of a field ranges have split reads figma.mixed.
  function textField(st, prop) {
    const name = RANGE_FIELD[prop];
    const n = String(st.props.characters || "").length;
    if (!name || !n || !st.ranges.some((r) => r.name === name)) return clone(st.props[prop]);
    const at = (i) => { const v = rangeValue(st, name, prop, i); return v === undefined ? "null" : JSON.stringify(v); };
    const first = at(0);
    for (let i = 1; i < n; i++) if (at(i) !== first) return mixed;
    return JSON.parse(first);
  }
  function rangeValue(st, name, prop, i) {
    let v = st.props[prop];
    for (const r of st.ranges) if (r.name === name && i >= r.start && i < r.end) v = r.value;
    return v;
  }

  // ---------- sizes ----------
  // A size change. Vectors scale their drawing; containers apply their children's constraints (a
  // flow child is placed by the flow instead); `withConstraints` false is resizeWithoutConstraints.
  function setSize(st, w, h, withConstraints) {
    const ow = st.w, oh = st.h;
    if (st.type === "VECTOR" && (ow > 0 || oh > 0)) {
      const sx = ow > 0 && w > 0 ? w / ow : 1, sy = oh > 0 && h > 0 ? h / oh : 1;
      if (sx !== 1 || sy !== 1) {
        if (st.network) st.network = scaleNetwork(st.network, sx, sy);
        if (st.paths) st.paths = st.paths.map((p) => ({ windingRule: p.windingRule, data: mapPath(p.data, [[sx, 0, 0], [0, sy, 0]]) }));
      }
    }
    st.w = w; st.h = h;
    if (withConstraints && st.children && ["FRAME", "COMPONENT"].indexOf(st.type) >= 0) applyConstraints(H, st, ow, oh);
    touch(st);
  }
  const H = { text: (st, width) => measure(st, width), boolean: refreshBoolean, setSize: (st, w, h) => setSize(st, w, h, true) };

  // A network or paths whose bounds do not start at (0, 0), per P19B offsetNetwork: the node's size
  // becomes the bounds, and either its origin moves there (ok) or the drawing does (drop).
  function placeDrawing(st, box) {
    if (!box) return { dx: 0, dy: 0 };
    const v = V("P19B", "offsetNetwork");
    const dx = box.x0, dy = box.y0;
    if (dx || dy) {
      if (st.network) st.network = shiftNetwork(st.network, -dx, -dy);
      if (st.paths) st.paths = st.paths.map((p) => ({ windingRule: p.windingRule, data: mapPath(p.data, [[1, 0, -dx], [0, 1, -dy]]) }));
      if (v === "ok") { st.rt[0][2] += st.rt[0][0] * dx + st.rt[0][1] * dy; st.rt[1][2] += st.rt[1][0] * dx + st.rt[1][1] * dy; }
    }
    st.w = box.x1 - box.x0; st.h = box.y1 - box.y0;
    touch(st);
    return { dx, dy };
  }
  function checkPaint(list, what) {
    if (!Array.isArray(list)) return list;
    const out = [];
    for (const p of list) {
      if (p && p.type === "IMAGE" && p.imageHash) {
        if (!images.has(p.imageHash)) {
          const v = V("P8", "unknownHash");
          if (v === "throw") throw new Error("double: " + what + ": no image has the hash of this IMAGE paint (verdicts P8 unknownHash)");
          if (v === "drop") continue;
        } else if (imageCase.get(p.imageHash) === "drop") continue;
      }
      out.push(p);
    }
    return out;
  }

  // ---------- reads, writes, methods ----------
  function read(st, prop) {
    const P = st.props;
    switch (prop) {
      case "id": return st.id;
      case "type": return st.type;
      case "name": return st.name;
      case "parent": return st.parent ? st.parent.proxy : null;
      case "removed": return st.removed;
      case "children": return st.children ? st.children.map((c) => c.proxy) : undefined;
      case "relativeTransform": return [st.rt[0].slice(), st.rt[1].slice()];
      case "x": return st.rt[0][2];
      case "y": return st.rt[1][2];
      case "width": return st.w;
      case "height": return st.h;
      case "rotation": return -Math.atan2(st.rt[1][0], st.rt[0][0]) * 180 / Math.PI;
      case "absoluteTransform": return absOf(st);
      case "absoluteBoundingBox": return bbox(st);
      case "absoluteRenderBounds": return bbox(st);
      case "fillGeometry": return fillGeometry(st);
      case "strokeGeometry": return strokeGeometry(st);
      case "vectorNetwork": return clone(st.network || { vertices: [], segments: [], regions: [] });
      case "vectorPaths": return clone(st.paths || fillGeometry(st));
      case "strokeWeight": { const s = SIDES.map((k) => P[k]); return s.every((v) => v === s[0]) ? s[0] : mixed; }
      case "cornerRadius": { const c = CORNERS.map((k) => P[k]); return c.every((v) => v === c[0]) ? c[0] : mixed; }
      case "key": return createHash("sha1").update("double component " + st.id).digest("hex");
      case "layoutSizingHorizontal": case "layoutSizingVertical": {
        const axis = prop === "layoutSizingHorizontal" ? "w" : "h";
        if (flowFills(st, axis)) return "FILL";
        if (st.type === "TEXT") return P.textAutoResize === "WIDTH_AND_HEIGHT" || (axis === "h" && P.textAutoResize === "HEIGHT") ? "HUG" : "FIXED";
        if (isAutoLayout(st)) return ((axis === "w") === (P.layoutMode === "HORIZONTAL") ? P.primaryAxisSizingMode : P.counterAxisSizingMode) === "AUTO" ? "HUG" : "FIXED";
        return "FIXED";
      }
      default:
        if (st.type === "TEXT" && Object.prototype.hasOwnProperty.call(RANGE_FIELD, prop)) return textField(st, prop);
        return clone(P[prop]);
    }
  }
  function writeSizing(st, prop, value) {
    const P = st.props, axis = prop === "layoutSizingHorizontal" ? "w" : "h";
    const parentAL = st.parent && isAutoLayout(st.parent);
    const primaryOfParent = parentAL && (axis === "w") === (st.parent.props.layoutMode === "HORIZONTAL");
    const ownPrimary = isAutoLayout(st) && (axis === "w") === (P.layoutMode === "HORIZONTAL");
    if (value === "FILL") {
      if (!parentAL) throw new Error("double: FILL can only be set on children of auto-layout frames");
      if (primaryOfParent) P.layoutGrow = 1; else P.layoutAlign = "STRETCH";
      if (st.type === "TEXT" && axis === "w" && P.textAutoResize === "WIDTH_AND_HEIGHT") P.textAutoResize = "HEIGHT";
    } else if (value === "HUG") {
      if (st.type === "TEXT") P.textAutoResize = axis === "w" ? "WIDTH_AND_HEIGHT" : (P.textAutoResize === "WIDTH_AND_HEIGHT" ? "WIDTH_AND_HEIGHT" : "HEIGHT");
      else if (isAutoLayout(st)) { if (ownPrimary) P.primaryAxisSizingMode = "AUTO"; else P.counterAxisSizingMode = "AUTO"; }
      else throw new Error("double: HUG can only be set on auto-layout frames and text nodes");
      if (parentAL) { if (primaryOfParent) P.layoutGrow = 0; else if (P.layoutAlign === "STRETCH") P.layoutAlign = "INHERIT"; }
    } else if (value === "FIXED") {
      if (isAutoLayout(st)) { if (ownPrimary) P.primaryAxisSizingMode = "FIXED"; else P.counterAxisSizingMode = "FIXED"; }
      if (st.type === "TEXT") {
        if (axis === "w" && P.textAutoResize === "WIDTH_AND_HEIGHT") P.textAutoResize = "HEIGHT";
        else if (axis === "h" && P.textAutoResize !== "NONE") P.textAutoResize = "NONE";
      }
      if (parentAL) { if (primaryOfParent) P.layoutGrow = 0; else if (P.layoutAlign === "STRETCH") P.layoutAlign = "INHERIT"; }
    } else throw new Error("double: " + prop + " is FIXED, HUG or FILL");
  }
  function write(st, prop, value) {
    const P = st.props;
    // A new font needs itself loaded (not the font it replaces); any other write that lays text out
    // needs every font the text uses.
    if (st.type === "TEXT" && TEXT_LAYOUT.indexOf(prop) >= 0) needFonts(prop === "fontName" ? [value] : fontsOf(st));
    // A node-level write of a field sets it for every character: its ranges go.
    if (st.type === "TEXT" && Object.prototype.hasOwnProperty.call(RANGE_FIELD, prop)) st.ranges = st.ranges.filter((r) => r.name !== RANGE_FIELD[prop]);
    switch (prop) {
      case "name": st.name = String(value); break;
      case "relativeTransform": {
        if (!Array.isArray(value) || value.length !== 2 || !value.every((r) => Array.isArray(r) && r.length === 3 && r.every((x) => typeof x === "number" && isFinite(x)))) throw new Error("double: relativeTransform is [[a, b, tx], [c, d, ty]]");
        // A child in an auto-layout flow keeps no rotation or mirror: Figma drops the linear part
        // without an error (builder4.js:381-389, measured).
        st.rt = inFlow(st) ? [[1, 0, value[0][2]], [0, 1, value[1][2]]] : [value[0].slice(), value[1].slice()];
        break;
      }
      case "x": st.rt[0][2] = Number(value); break;
      case "y": st.rt[1][2] = Number(value); break;
      case "strokeWeight": P.strokeWeight = value; for (const s of SIDES) P[s] = value; break;
      case "cornerRadius": P.cornerRadius = value; for (const c of CORNERS) P[c] = value; break;
      case "isMask":
        if (value === true) {
          const frame = st.type === "FRAME" || st.type === "COMPONENT";
          const inFrame = !frame && st.parent && (st.parent.type === "FRAME" || st.parent.type === "COMPONENT");
          const v = frame ? V("P19B", "frameMask") : inFrame ? V("P19B", "maskInGroupAsFrame") : "ok";
          if (v === "throw") throw new Error("double: isMask refused on " + (frame ? "a frame" : "a shape inside a frame") + " (verdicts P19B " + (frame ? "frameMask" : "maskInGroupAsFrame") + ")");
          if (v === "drop") break;
        }
        P.isMask = value; break;
      case "vectorPaths": {
        if (!Array.isArray(value)) throw new Error("double: vectorPaths is a list of { windingRule, data }");
        const open = value.some((p) => p && p.windingRule !== "NONE" && parsePath(p.data).some((s) => !s.closed && s.segs.length));
        if (open && V("P19B", "autoClosedLoop") === "throw") throw new Error("double: vectorPaths with an open subpath refused (verdicts P19B autoClosedLoop)");
        st.paths = clone(value); st.network = null; st.fromPaths = true;
        const box = pathsBox(st.paths);
        if (box && V("P19B", "offsetNetwork") === "throw" && (box.x0 || box.y0)) throw new Error("double: paths off the origin refused (verdicts P19B offsetNetwork)");
        placeDrawing(st, box);
        break;
      }
      case "backgrounds": P.backgrounds = clone(value); break;
      case "fills": P.fills = clone(checkPaint(value, st.type + ".fills")); break;
      case "layoutSizingHorizontal": case "layoutSizingVertical": writeSizing(st, prop, value); break;
      case "characters": {
        // New characters take the first character's style (the Plugin API's rule for a styled text,
        // assumed: A): a range that covered index 0 covers the whole new text, the rest go. A field
        // written at node level afterwards clears its ranges as usual (part F, review figma F5).
        P.characters = String(value);
        const n = P.characters.length;
        st.ranges = n ? st.ranges.filter((r) => r.start === 0).map((r) => Object.assign({}, r, { end: n })) : [];
        break;
      }
      default: P[prop] = clone(value);
    }
    logWrite(st, prop, value);
    touch(st);
  }
  function resizeText(st, w, h) {
    // As the UI does it: an auto-width text given another width becomes auto-height; any auto text
    // given another height becomes fixed (A until a live check, docs/M1.md §6 E "reset semantics").
    const P = st.props, wc = Math.abs(w - st.w) > 1e-6, hc = Math.abs(h - st.h) > 1e-6;
    let m = P.textAutoResize;
    if (m === "WIDTH_AND_HEIGHT" && (wc || hc)) m = hc ? "NONE" : "HEIGHT";
    else if (m === "HEIGHT" && hc) m = "NONE";
    if (m !== P.textAutoResize) { P.textAutoResize = m; logWrite(st, "textAutoResize", m); }
  }
  function method(st, name) {
    const call = (fn) => function () { const args = Array.prototype.slice.call(arguments); return fn.apply(null, args); };
    switch (name) {
      case "remove": return call(() => {
        logWrite(st, "remove()", null);
        detach(st);
        (function gone(s) { s.removed = true; byId.delete(s.id); dirty.delete(s); (s.children || []).forEach(gone); })(st);
      });
      case "resize": case "resizeWithoutConstraints": return call((w, h) => {
        if (!(typeof w === "number" && typeof h === "number" && isFinite(w) && isFinite(h) && w >= 0 && h >= 0)) throw new Error("double: " + name + " takes two finite sizes >= 0");
        // The size a resize starts from matters to a text (its auto-resize mode), a vector (its
        // drawing scales) and a container (its children's constraints): lay those out first.
        if (st.type === "TEXT" || st.type === "VECTOR" || (st.children && st.children.length)) settle(st);
        if (st.type === "TEXT") resizeText(st, w, h);
        setSize(st, w, h, name === "resize");
        logWrite(st, name + "()", [w, h]);
      });
      case "setPluginData": return call((k, v) => { st.pd[String(k)] = String(v); logWrite(st, "setPluginData()", [k, v]); });
      case "getPluginData": return call((k) => st.pd[String(k)] || "");
      case "setSharedPluginData": return call((ns, k, v) => {
        if (typeof ns !== "string" || !ns) throw new Error("double: setSharedPluginData needs a namespace");
        (st.spd[ns] || (st.spd[ns] = {}))[String(k)] = String(v); logWrite(st, "setSharedPluginData()", [ns, k, v]);
      });
      case "getSharedPluginData": return call((ns, k) => (st.spd[ns] || {})[String(k)] || "");
      case "exportAsync": return call(() => Promise.resolve(new Uint8Array(16)));
      case "appendChild": return call((c) => { attach(st, stOf(c)); logWrite(st, "appendChild()", stOf(c).id); });
      case "insertChild": return call((i, c) => { attach(st, stOf(c), i); logWrite(st, "insertChild()", [i, stOf(c).id]); });
      case "findAll": return call((cb) => {
        const out = [];
        (function walk(s) { for (const c of s.children || []) { if (!cb || cb(c.proxy)) out.push(c.proxy); walk(c); } })(st);
        return out;
      });
      case "findAllWithCriteria": return call((cr) => {
        cr = cr || {};
        const out = [];
        const ok = (c) => {
          if (Array.isArray(cr.types) && cr.types.indexOf(c.type) < 0) return false;
          if (cr.pluginData && Array.isArray(cr.pluginData.keys) && !cr.pluginData.keys.some((k) => c.pd[k])) return false;
          if (cr.sharedPluginData) {
            const ns = c.spd[cr.sharedPluginData.namespace] || {};
            if (!(cr.sharedPluginData.keys || []).some((k) => ns[k])) return false;
          }
          return true;
        };
        (function walk(s) { for (const c of s.children || []) { if (ok(c)) out.push(c.proxy); walk(c); } })(st);
        return out;
      });
      case "loadAsync": return call(() => Promise.resolve());
      case "setVectorNetworkAsync": return call((net) => {
        logWrite(st, "setVectorNetworkAsync()", net);
        if (!net || !Array.isArray(net.vertices) || !Array.isArray(net.segments)) return Promise.reject(new Error("double: a vector network is { vertices, segments, regions }"));
        if (net.vertices.some((v) => v && v.handleMirroring === "RIGHT_ANGLE")) return Promise.reject(new Error("double: setVectorNetworkAsync refuses handleMirroring RIGHT_ANGLE, as Figma does"));
        let n = clone({ vertices: net.vertices, segments: net.segments, regions: net.regions || [] });
        const radius = n.vertices.some((v) => v && v.cornerRadius > 0), regionFills = n.regions.some((r) => r && Array.isArray(r.fills));
        if (radius && V("P19", "perVertexCornerRadius") === "throw") return Promise.reject(new Error("double: per-vertex cornerRadius refused (verdicts P19 perVertexCornerRadius)"));
        if (regionFills && V("P19", "perRegionFills") === "throw") return Promise.reject(new Error("double: region fills refused (verdicts P19 perRegionFills)"));
        if (radius && V("P19", "perVertexCornerRadius") === "drop") n.vertices.forEach((v) => { delete v.cornerRadius; });
        if (regionFills && V("P19", "perRegionFills") === "drop") n.regions.forEach((r) => { delete r.fills; });
        const box = n.vertices.length ? networkBox(n) : null;
        if (box && (box.x0 || box.y0) && V("P19B", "offsetNetwork") === "throw") return Promise.reject(new Error("double: a network off the origin refused (verdicts P19B offsetNetwork)"));
        st.network = n; st.paths = null; st.fromPaths = false;
        placeDrawing(st, box);
        return Promise.resolve();
      });
    }
    if (/^setRange/.test(name)) return call((start, end, value) => {
      if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= String(st.props.characters || "").length)) throw new Error("double: " + name + " range [" + start + ", " + end + ") is outside the characters");
      needFonts(name === "setRangeFontName" ? [value] : fontsOf(st));
      st.ranges.push({ name, start, end, value: clone(name === "setRangeFills" ? checkPaint(value, "setRangeFills") : value) });
      logWrite(st, name + "()", [start, end, value]);
      touch(st);
    });
    if (/^getRange/.test(name)) return call((start, end) => {
      const prop = name.slice(8, 9).toLowerCase() + name.slice(9);
      const set = "setRange" + name.slice(8);
      const vals = new Set();
      for (let i = start; i < Math.max(start + 1, end); i++) vals.add(JSON.stringify(rangeValue(st, set, prop, i) === undefined ? null : rangeValue(st, set, prop, i)));
      return vals.size > 1 ? mixed : JSON.parse(Array.from(vals)[0]);
    });
    throw outside(st.type + "." + name + "()");
  }

  function proxyOf(st) {
    return new Proxy({}, {
      get(_, prop) {
        if (prop === "__doubleState") return st;
        if (typeof prop === "symbol" || prop === "then" || prop === "toJSON" || prop === "constructor") return undefined;
        if (canCall(st.type, prop)) return method(st, prop);
        if (canRead(st.type, prop)) {
          if (GEOMETRY_READS.has(prop)) settle(st);
          if (LAYOUT_GETTERS.indexOf(prop) >= 0) layoutRead(st, prop);
          return read(st, prop);
        }
        throw outside("reading " + st.type + "." + prop);
      },
      set(_, prop, value) {
        if (typeof prop === "symbol" || !canWrite(st.type, prop)) throw outside("writing " + st.type + "." + String(prop));
        if (st.removed) throw new Error("double: the node " + st.id + " has been removed");
        write(st, prop, value);
        return true;
      },
      has(_, prop) { return prop === "__doubleState" || canRead(st.type, prop) || canCall(st.type, prop); },
    });
  }

  // ---------- the document ----------
  const doc = newState("DOCUMENT", "0:0");
  doc.name = "Document";
  const first = newState("PAGE", "0:1");
  first.name = "Page 1";
  attach(doc, first);
  currentPage = first;

  function create(type) {
    const st = newState(type);
    attach(currentPage, st);
    logWrite(st, "create" + type + "()", null);
    return st.proxy;
  }
  const OP_CASE = { UNION: "booleanUnion", SUBTRACT: "booleanSubtract", INTERSECT: "booleanIntersect", EXCLUDE: "booleanExclude" };
  function booleanOp(op) {
    return (nodes, parent, index) => {
      if (!Array.isArray(nodes) || !nodes.length) throw new Error("double: a boolean operation needs operands");
      const sts = nodes.map(stOf), pst = stOf(parent);
      const refuse = (c) => { throw new Error("double: figma." + op.toLowerCase() + " refused (verdicts P19B " + c + ")"); };
      if (V("P19B", OP_CASE[op]) === "throw") refuse(OP_CASE[op]);
      if (sts.length === 1 && V("P19B", "singleOperandUnion") === "throw") refuse("singleOperandUnion");
      if (sts.some((s) => s.type === "BOOLEAN_OPERATION") && V("P19B", "nestedBoolean") === "throw") refuse("nestedBoolean");
      if (sts.some((s) => s.type === "LINE") && V("P19B", "lineOperand") === "throw") refuse("lineOperand");
      if (sts.some((s) => s.type !== "LINE" && visibleStroke(s)) && V("P19B", "strokedOperand") === "throw") refuse("strokedOperand");
      for (const s of sts) settle(s);
      settle(pst);
      const abs = sts.map((s) => absOf(s));
      const bst = newState("BOOLEAN_OPERATION");
      bst.props.booleanOperation = op;
      attach(pst, bst, index);
      bst.rt = I();
      const bInv = inv(pst.type === "PAGE" ? I() : absOf(bst));
      sts.forEach((s, k) => { attach(bst, s); s.rt = mul(bInv, abs[k]); });
      refreshBoolean(bst);
      logWrite(bst, op.toLowerCase() + "()", sts.map((s) => s.id));
      return bst.proxy;
    };
  }

  const calls = {
    createFrame: () => create("FRAME"), createRectangle: () => create("RECTANGLE"), createEllipse: () => create("ELLIPSE"),
    createPolygon: () => create("POLYGON"), createStar: () => create("STAR"), createLine: () => create("LINE"),
    createVector: () => create("VECTOR"), createText: () => create("TEXT"), createComponent: () => create("COMPONENT"),
    createSection: () => create("SECTION"),
    createPage: () => { const st = newState("PAGE"); attach(doc, st); logWrite(st, "createPage()", null); return st.proxy; },
    createImage: (bytes) => {
      // ArrayBuffer.isView, not instanceof: the plugin code runs in a vm context, another realm.
      if (!ArrayBuffer.isView(bytes) || !bytes.length) throw new Error("double: createImage takes non-empty bytes");
      const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const info = sniffImage(u8), kase = p8Case(info), v = kase ? V("P8", kase) : "ok";
      if (v === "throw") throw new Error("double: createImage refused " + info.format + " " + info.width + "x" + info.height + " (verdicts P8 " + kase + ")");
      // P4 sameHash "differs": Figma re-encodes, and the hash is no longer the bytes' SHA-1.
      const hash = V("P4", "sameHash") === "differs" ? createHash("sha1").update("double re-encoded").update(Buffer.from(u8)).digest("hex") : sha1(u8);
      images.set(hash, u8.length);
      if (v === "drop" || v === "empty") imageCase.set(hash, v);
      return imageOf(hash, Uint8Array.from(u8), v === "empty");
    },
    createNodeFromSvg: () => { throw new Error("double: no SVG import in the double (the M1 builder does not use it)"); },
    union: booleanOp("UNION"), subtract: booleanOp("SUBTRACT"), intersect: booleanOp("INTERSECT"), exclude: booleanOp("EXCLUDE"),
    loadFontAsync: (f) => {
      if (!available.has(fkey(f))) return Promise.reject(new Error("double: font \"" + fkey(f) + "\" is not available"));
      loaded.add(fkey(f));
      return Promise.resolve();
    },
    listAvailableFontsAsync: () => Promise.resolve(Array.from(available).map((k) => ({ fontName: { family: k.split("|")[0], style: k.split("|").slice(1).join("|") } }))),
    getNodeByIdAsync: (id) => { const st = byId.get(String(id)); return Promise.resolve(st && !st.removed ? st.proxy : null); },
    loadAllPagesAsync: () => Promise.resolve(),
    setCurrentPageAsync: (p) => { const st = stOf(p); if (st.type !== "PAGE") return Promise.reject(new Error("double: not a page")); currentPage = st; return Promise.resolve(); },
    base64Decode: (s) => new Uint8Array(Buffer.from(String(s), "base64")),
    base64Encode: (u8) => Buffer.from(u8).toString("base64"),
  };
  // What figma.createImage returns: the hash, the bytes back, and the size from the header.
  function imageOf(hash, bytes, empty) {
    const own = { hash,
      getBytesAsync: () => Promise.resolve(empty ? new Uint8Array(0) : new Uint8Array(bytes)),
      getSizeAsync: () => {
        if (empty) return Promise.resolve({ width: 0, height: 0 });
        const info = sniffImage(bytes);
        if (info.format === "unknown" || !info.width || !info.height) return Promise.reject(new Error("double: getSizeAsync: the bytes are not an image the double can read"));
        return Promise.resolve({ width: info.width, height: info.height });
      } };
    return new Proxy({}, {
      get(_, prop) {
        if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
        if (SURFACE.image.read.indexOf(prop) < 0 && SURFACE.image.methods.indexOf(prop) < 0) throw outside("Image." + String(prop));
        return own[prop];
      },
      set(_, prop) { throw outside("writing Image." + String(prop)); },
    });
  }
  const asyncCalls = ["loadFontAsync", "listAvailableFontsAsync", "getNodeByIdAsync", "loadAllPagesAsync", "setCurrentPageAsync"];
  const figma = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
      if (prop === "root") return doc.proxy;
      if (prop === "currentPage") return currentPage.proxy;
      if (prop === "mixed") return mixed;
      if (prop === "ui") return ui;
      const inSurface = SURFACE.figma.calls.indexOf(prop) >= 0 || (allow.figma || []).indexOf(prop) >= 0;
      if (!inSurface || !calls[prop]) throw outside("figma." + prop);
      if (Object.prototype.hasOwnProperty.call(faults, prop)) {
        return () => { const e = new Error(String(faults[prop])); if (asyncCalls.indexOf(prop) >= 0) return Promise.reject(e); throw e; };
      }
      return calls[prop];
    },
    set(_, prop) { throw outside("writing figma." + String(prop)); },
  });

  function tree(st = doc) {
    return { id: st.id, type: st.type, name: st.name, relativeTransform: [st.rt[0].slice(), st.rt[1].slice()], width: st.w, height: st.h,
      props: clone(st.props), pluginData: clone(st.pd), sharedPluginData: clone(st.spd),
      children: (st.children || []).map((c) => tree(c)) };
  }

  return {
    figma, writes, reads, images, ui: { posted: uiPosted },
    assumed: beh.assumed.slice(),
    get layoutPasses() { return passes; },
    setPhase(name) { phase = name === undefined ? null : name; },
    tree: () => { settleAll(); return tree(); },
    node: (id) => { const st = byId.get(String(id)); return st ? st.proxy : null; },
    // A text node's ranges as plain data ({ name, start, end, value }), for tests: the surface has no
    // getter for every range field.
    rangesOf: (id) => { const st = byId.get(String(id)); return st ? clone(st.ranges) : null; },
    loadedFonts: () => Array.from(loaded),
  };
}
