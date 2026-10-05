// A headless double of the Figma plugin API, for testing the M1 plugin code on this machine
// (docs/M1.md §5.4). Part P0 wrote this core; part E owns this file afterwards and adds the layout
// engine, the text model, boolean geometry, the probes' conformance and the image verdicts.
//
//   import { makeDouble } from "../double/index.mjs";
//   const D = makeDouble({ fonts, verdicts, allow, faults });
//   D.figma            the `figma` global to hand the plugin code (tools/ir/plugin-vm.mjs)
//   D.writes           [{ phase, id, type, prop, value }]: every assignment, and every mutating call
//                      as prop "name()" with its arguments as value, in order
//   D.reads            { total, byPhase: { phase: n }, log: [{ phase, id, type, prop }] }: layout-forcing
//                      reads only (surface.mjs LAYOUT_GETTERS); a read with no phase set is booked
//                      under "(none)"
//   D.setPhase(name)   the phase writes and reads are booked under (ctx.phase tells it, through
//                      host.phase)
//   D.tree()           the document as plain data: { id, type, name, relativeTransform, width, height,
//                      props, pluginData, sharedPluginData, children }
//   D.node(id)         the node with that id (a Proxy), or null
//   D.ui               { posted: [message] }: what the plugin code sent through figma.ui.postMessage
//
// Options:
//   fonts     [{ family, style }] Figma has; loadFontAsync rejects any other (DEFAULT_FONTS when absent)
//   verdicts  tools/double/verdicts.json's shape (that file when absent); the core reads only
//             probes.P19B.verdicts.frameMask: "throw" (isMask on a frame throws), "drop" (it is
//             ignored) or anything else (it is kept)
//   allow     surface additions for one test, { figma: [name], nodes: { TYPE or "*": { read, write,
//             methods } } }; list them in the pull request, F folds them into surface.mjs
//   faults    { figmaCallName: message }: that figma call throws (or rejects) with the message, for
//             fallback tests (a boolean operation Figma refuses)
//   ui        (message) => void: called after each figma.ui.postMessage, so a test can play the
//             plugin window (part E's probes move bytes through it)
//
// What the core models (docs/M1.md §5.4): a tree of pages and nodes; relative and absolute
// transforms, sizes and bounding boxes; private and shared plugin data; the write log; layout reads
// counted per phase; strokeWeight resetting the four side weights (and reading back figma.mixed when
// the sides differ), cornerRadius likewise for the corners; a vector network's regions producing
// fillGeometry (lines and cubics), an open region-less network producing none, vectorPaths producing
// it directly; RIGHT_ANGLE handle mirroring making setVectorNetworkAsync reject; a text write before
// loadFontAsync of its font throwing; createImage hashing with SHA-1, its Image giving the bytes back
// and, for a PNG, its size from the header; figma.ui.postMessage recorded; booleans as a node over their
// operands with the operands' union box (no boolean geometry). It has NO layout engine and NO text
// wrap model: auto layout props are stored and do nothing, and a text keeps the size it is given.
// Tests that need those print "pending: E".
//
// Nodes are Proxies. Reading, writing or calling anything outside surface.mjs throws, naming the
// type and the property, so a gap in the surface is found here and not in Figma.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACE, LAYOUT_GETTERS } from "./surface.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FONTS = Object.freeze([{ family: "Inter", style: "Regular" }, { family: "Inter", style: "Medium" },
  { family: "Inter", style: "Bold" }, { family: "Roboto", style: "Regular" }]);
export function loadVerdicts() { return JSON.parse(readFileSync(join(HERE, "verdicts.json"), "utf8")); }

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const fkey = (f) => (f && typeof f === "object" ? f.family + "|" + f.style : String(f));
const r4 = (n) => String(Math.round(n * 10000) / 10000);
const SOLID = (r, g, b) => ({ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r, g, b } });

// Figma's own defaults for a new node, roughly: they differ by type, which is why the IR writes the
// NEVER_OMIT props explicitly. Part E refines them against Figma.
const COMMON_DEFAULTS = { visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", isMask: false, maskType: "ALPHA",
  effects: [], exportSettings: [], constraints: { horizontal: "MIN", vertical: "MIN" }, layoutPositioning: "AUTO",
  layoutAlign: "INHERIT", layoutGrow: 0, strokes: [], strokeWeight: 1, strokeJoin: "MITER", strokeCap: "NONE",
  strokeMiterLimit: 4, dashPattern: [], cornerRadius: 0, cornerSmoothing: 0 };
const TYPE_DEFAULTS = {
  FRAME: { fills: [SOLID(1, 1, 1)], strokeAlign: "INSIDE", clipsContent: true, layoutMode: "NONE", size: [100, 100] },
  COMPONENT: { fills: [SOLID(1, 1, 1)], strokeAlign: "INSIDE", clipsContent: false, layoutMode: "NONE", size: [100, 100] },
  SECTION: { fills: [SOLID(1, 1, 1)], size: [100, 100] },
  RECTANGLE: { fills: [SOLID(0.85, 0.85, 0.85)], strokeAlign: "INSIDE", size: [100, 100] },
  ELLIPSE: { fills: [SOLID(0.85, 0.85, 0.85)], strokeAlign: "INSIDE", size: [100, 100] },
  POLYGON: { fills: [SOLID(0.85, 0.85, 0.85)], strokeAlign: "INSIDE", pointCount: 3, size: [100, 100] },
  STAR: { fills: [SOLID(0.85, 0.85, 0.85)], strokeAlign: "INSIDE", pointCount: 5, innerRadius: 0.382, size: [100, 100] },
  LINE: { fills: [], strokes: [SOLID(0, 0, 0)], strokeAlign: "CENTER", size: [100, 0] },
  VECTOR: { fills: [], strokeAlign: "CENTER", size: [0, 0] },
  BOOLEAN_OPERATION: { fills: [SOLID(0.85, 0.85, 0.85)], strokeAlign: "CENTER", booleanOperation: "UNION", size: [0, 0] },
  TEXT: { fills: [SOLID(0, 0, 0)], strokeAlign: "OUTSIDE", characters: "", fontName: { family: "Inter", style: "Regular" },
    fontSize: 12, textAutoResize: "WIDTH_AND_HEIGHT", textAlignHorizontal: "LEFT", textAlignVertical: "TOP",
    letterSpacing: { unit: "PERCENT", value: 0 }, lineHeight: { unit: "AUTO" }, size: [0, 14] },
};
// Text props whose write lays text out, and so needs the text's font loaded (Figma throws otherwise).
const TEXT_LAYOUT = ["characters", "fontSize", "fontName", "textCase", "textDecoration", "letterSpacing", "lineHeight",
  "paragraphIndent", "paragraphSpacing", "listSpacing", "leadingTrim", "hangingPunctuation", "hangingList"];
const SIDES = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];
const CORNERS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
const CONTAINERS = ["DOCUMENT", "PAGE", "FRAME", "COMPONENT", "SECTION", "BOOLEAN_OPERATION"];

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

export function makeDouble(opts = {}) {
  const available = new Set((opts.fonts || DEFAULT_FONTS).map(fkey));
  const verdicts = opts.verdicts || loadVerdicts();
  const p19b = (verdicts.probes && verdicts.probes.P19B && verdicts.probes.P19B.verdicts) || {};
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
  // What figma.createImage returns: the hash, the bytes back, and a PNG's size from its header.
  function imageOf(hash, bytes) {
    const own = { hash,
      getBytesAsync: () => Promise.resolve(new Uint8Array(bytes)),
      getSizeAsync: () => {
        const png = bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
        if (!png) return Promise.reject(new Error("double: getSizeAsync reads a PNG header only (pending: E)"));
        const u32 = (o) => ((bytes[o] << 24) >>> 0) + (bytes[o + 1] << 16) + (bytes[o + 2] << 8) + bytes[o + 3];
        return Promise.resolve({ width: u32(16), height: u32(20) });
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
  const loaded = new Set();
  const writes = [];
  const reads = { total: 0, byPhase: {}, log: [] };
  const images = new Map();
  const byId = new Map();
  const mixed = Symbol("figma.mixed");
  let phase = null, seq = 0, currentPage = null;

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
      props: {}, pd: {}, spd: {}, network: null, paths: null, ranges: [], proxy: null };
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
  function detach(st) {
    if (st.parent) { const i = st.parent.children.indexOf(st); if (i >= 0) st.parent.children.splice(i, 1); }
    st.parent = null;
  }
  function attach(parent, st, index) {
    if (!parent.children) throw new Error("double: a " + parent.type + " has no children");
    for (let a = parent; a; a = a.parent) if (a === st) throw new Error("double: a node cannot be its own ancestor");
    detach(st);
    st.parent = parent;
    if (index === undefined || index === null || index >= parent.children.length) parent.children.push(st);
    else parent.children.splice(Math.max(0, index), 0, st);
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
  function fillGeometry(st) {
    if (st.type === "VECTOR") {
      if (st.paths) return st.paths.filter((p) => p.windingRule !== "NONE").map((p) => ({ windingRule: p.windingRule, data: p.data }));
      if (st.network) return st.network.regions.map((r) => ({ windingRule: r.windingRule, data: networkRegionPath(st.network, r) }));
      return [];
    }
    const w = r4(st.w), h = r4(st.h);
    if (["FRAME", "COMPONENT", "RECTANGLE"].indexOf(st.type) >= 0) return [{ windingRule: "NONZERO", data: "M 0 0 L " + w + " 0 L " + w + " " + h + " L 0 " + h + " L 0 0 Z" }];
    if (st.type === "ELLIPSE") {
      const rx = st.w / 2, ry = st.h / 2, k = 0.5522847498;
      const p = (x, y) => r4(x) + " " + r4(y);
      return [{ windingRule: "NONZERO", data: ["M " + p(st.w, ry), "C " + p(st.w, ry + k * ry) + " " + p(rx + k * rx, st.h) + " " + p(rx, st.h),
        "C " + p(rx - k * rx, st.h) + " " + p(0, ry + k * ry) + " " + p(0, ry), "C " + p(0, ry - k * ry) + " " + p(rx - k * rx, 0) + " " + p(rx, 0),
        "C " + p(rx + k * rx, 0) + " " + p(st.w, ry - k * ry) + " " + p(st.w, ry), "Z"].join(" ") }];
    }
    return [];
  }
  function needFont(st, f) {
    if (!loaded.has(fkey(f))) throw new Error("double: unloaded font \"" + fkey(f) + "\": call figma.loadFontAsync before writing text (as Figma requires)");
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
      case "strokeGeometry": return [];
      case "vectorNetwork": return clone(st.network || { vertices: [], segments: [], regions: [] });
      case "vectorPaths": return clone(st.paths || fillGeometry(st));
      case "strokeWeight": { const s = SIDES.map((k) => P[k]); return s.every((v) => v === s[0]) ? s[0] : mixed; }
      case "cornerRadius": { const c = CORNERS.map((k) => P[k]); return c.every((v) => v === c[0]) ? c[0] : mixed; }
      case "key": return createHash("sha1").update("double component " + st.id).digest("hex");
      default: return clone(P[prop]);
    }
  }
  function write(st, prop, value) {
    const P = st.props;
    if (st.type === "TEXT" && TEXT_LAYOUT.indexOf(prop) >= 0) needFont(st, prop === "fontName" ? value : P.fontName);
    switch (prop) {
      case "name": st.name = String(value); break;
      case "relativeTransform": {
        if (!Array.isArray(value) || value.length !== 2 || !value.every((r) => Array.isArray(r) && r.length === 3 && r.every((x) => typeof x === "number" && isFinite(x)))) throw new Error("double: relativeTransform is [[a, b, tx], [c, d, ty]]");
        st.rt = [value[0].slice(), value[1].slice()]; break;
      }
      case "x": st.rt[0][2] = Number(value); break;
      case "y": st.rt[1][2] = Number(value); break;
      case "strokeWeight": P.strokeWeight = value; for (const s of SIDES) P[s] = value; break;
      case "cornerRadius": P.cornerRadius = value; for (const c of CORNERS) P[c] = value; break;
      case "isMask":
        if ((st.type === "FRAME" || st.type === "COMPONENT") && value === true) {
          if (p19b.frameMask === "throw") throw new Error("double: isMask refused on a frame (verdicts P19B frameMask)");
          if (p19b.frameMask === "drop") break;
        }
        P.isMask = value; break;
      case "vectorPaths":
        if (!Array.isArray(value)) throw new Error("double: vectorPaths is a list of { windingRule, data }");
        st.paths = clone(value); st.network = null; break;
      case "backgrounds": P.backgrounds = clone(value); break;
      default: P[prop] = clone(value);
    }
    logWrite(st, prop, value);
  }
  function method(st, name) {
    const call = (fn) => function () { const args = Array.prototype.slice.call(arguments); return fn.apply(null, args); };
    switch (name) {
      case "remove": return call(() => {
        logWrite(st, "remove()", null);
        (function gone(s) { s.removed = true; byId.delete(s.id); (s.children || []).forEach(gone); })(st);
        detach(st);
      });
      case "resize": case "resizeWithoutConstraints": return call((w, h) => {
        if (!(typeof w === "number" && typeof h === "number" && isFinite(w) && isFinite(h) && w >= 0 && h >= 0)) throw new Error("double: " + name + " takes two finite sizes >= 0");
        st.w = w; st.h = h; logWrite(st, name + "()", [w, h]);
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
        st.network = clone({ vertices: net.vertices, segments: net.segments, regions: net.regions || [] });
        st.paths = null;
        return Promise.resolve();
      });
    }
    if (/^setRange/.test(name)) return call((start, end, value) => {
      if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= String(st.props.characters || "").length)) throw new Error("double: " + name + " range [" + start + ", " + end + ") is outside the characters");
      needFont(st, name === "setRangeFontName" ? value : st.props.fontName);
      st.ranges.push({ name, start, end, value: clone(value) });
      logWrite(st, name + "()", [start, end, value]);
    });
    if (/^getRange/.test(name)) return call((start, end) => {
      const prop = name.slice(8, 9).toLowerCase() + name.slice(9);
      const set = "setRange" + name.slice(8);
      let v = clone(st.props[prop]);
      for (const r of st.ranges) if (r.name === set && r.start <= start && r.end >= end) v = clone(r.value);
      return v;
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
  function booleanOp(op) {
    return (nodes, parent, index) => {
      if (!Array.isArray(nodes) || !nodes.length) throw new Error("double: a boolean operation needs operands");
      const sts = nodes.map(stOf), pst = stOf(parent);
      const pAbsInv = inv(pst.type === "PAGE" ? I() : absOf(pst));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of sts) {
        const b = bbox(s);
        for (const [cx, cy] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]) {
          const [px, py] = ap(pAbsInv, cx, cy);
          x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
        }
      }
      const bst = newState("BOOLEAN_OPERATION");
      bst.props.booleanOperation = op;
      attach(pst, bst, index);
      bst.rt = [[1, 0, x0], [0, 1, y0]]; bst.w = x1 - x0; bst.h = y1 - y0;
      const bInv = inv(absOf(bst));
      for (const s of sts) { const abs = absOf(s); attach(bst, s); s.rt = mul(bInv, abs); }
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
      const hash = createHash("sha1").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
      images.set(hash, bytes.length);
      return imageOf(hash, Uint8Array.from(bytes));
    },
    createNodeFromSvg: () => { throw new Error("double: no SVG import in the double (pending: E)"); },
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
    setPhase(name) { phase = name === undefined ? null : name; },
    tree: () => tree(),
    node: (id) => { const st = byId.get(String(id)); return st ? st.proxy : null; },
    loadedFonts: () => Array.from(loaded),
  };
}
