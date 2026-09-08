// IR + SVG assets + absolute transforms -> PNG data carrier.
// usage: node pack4.mjs <ir.json> <rootId> <svg.json> <bounds.json> <abs.json> <out.png>
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { BUILDER_SRC, VERIFIER_SRC } from "./builder4.js";

const [, , IR_PATH, ROOT_ID, SVG_PATH, BOUNDS_PATH, ABS_PATH, OUT = "out/payload.png", TEXTINK_PATH, TEXTSVG_PATH] = process.argv;
const ir = JSON.parse(readFileSync(IR_PATH, "utf8"));
const SVG = JSON.parse(readFileSync(SVG_PATH, "utf8"));
const BOUNDS = JSON.parse(readFileSync(BOUNDS_PATH, "utf8"));
const ABS = JSON.parse(readFileSync(ABS_PATH, "utf8"));
const TEXTINK = TEXTINK_PATH ? JSON.parse(readFileSync(TEXTINK_PATH, "utf8")) : {};
const TEXTSVG = TEXTSVG_PATH ? JSON.parse(readFileSync(TEXTSVG_PATH, "utf8")) : {};

// Image paints carrying a filter Figma has no field for (Hue) were rendered by Pixso instead, and
// the render is swapped in here so everything downstream sees an ordinary image paint. Doing it on
// the tree rather than in the encoder keeps the substitution in one place.
const PAINTSUB = process.env.PX_PAINTSUB ? JSON.parse(readFileSync(process.env.PX_PAINTSUB, "utf8")).sub || {} : {};
let paintsSubbed = 0;
if (Object.keys(PAINTSUB).length) {
  (function walk(n, path) {
    const s = PAINTSUB[path.join(".")];
    if (s && Array.isArray(n.fills) && n.fills[s.i]) {
      const old = n.fills[s.i];
      // The render is exactly the node's box, so it fills it with no transform and no filters.
      n.fills = n.fills.slice();
      n.fills[s.i] = { type: "IMAGE", scaleMode: "FILL", imageHash: s.hash,
        imageTransform: [[1, 0, 0], [0, 1, 0]], rotation: 0,
        blendMode: old.blendMode || "NORMAL", opacity: old.opacity === undefined ? 1 : old.opacity,
        visible: old.visible !== false };
      paintsSubbed++;
    }
    (n.children || []).forEach((c, i) => walk(c, path.concat(i)));
  })(ir.tree, []);
}

let target = null;
(function w(n) { if (n.id === ROOT_ID) { target = n; return; } if (n.children) n.children.forEach(w); })(ir.tree);
if (!target) { console.error("not found: " + ROOT_ID); process.exit(1); }

const VEC = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);

// matrix helpers: [a,b,tx,c,d,ty] == [[a,b,tx],[c,d,ty]]
const inv = (m) => { const a = m[0], b = m[1], tx = m[2], c = m[3], d = m[4], ty = m[5], det = a * d - b * c;
  return [d / det, -b / det, (b * ty - d * tx) / det, -c / det, a / det, (c * tx - a * ty) / det]; };
const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[3], m[0] * n[1] + m[1] * n[4], m[0] * n[2] + m[1] * n[5] + m[2],
  m[3] * n[0] + m[4] * n[3], m[3] * n[1] + m[4] * n[4], m[3] * n[2] + m[4] * n[5] + m[5]];

const A = { name: "a", type: "b", visible: "c", locked: "d", opacity: "e", blendMode: "f", isMask: "g",
  width: "j", height: "k", clipsContent: "m", cornerRadius: "n", topLeftRadius: "o",
  topRightRadius: "p", bottomLeftRadius: "q", bottomRightRadius: "r", cornerSmoothing: "s", strokeWeight: "t",
  strokeAlign: "u", strokeJoin: "v", dashPattern: "w", layoutMode: "y", layoutWrap: "z",
  primaryAxisSizingMode: "A", counterAxisSizingMode: "B", primaryAxisAlignItems: "C",
  counterAxisAlignItems: "D", paddingLeft: "E", paddingRight: "F", paddingTop: "G", paddingBottom: "H",
  itemSpacing: "I", counterAxisSpacing: "J", layoutAlign: "K", layoutGrow: "L", layoutPositioning: "M",
  fills: "N", strokes: "O", effects: "P", constraints: "Q", characters: "S", fontSize: "T",
  fontName: "U", textAlignHorizontal: "V", textAlignVertical: "W", textAutoResize: "X", textCase: "Y",
  textDecoration: "Z", letterSpacing: "0", lineHeight: "1", paragraphIndent: "2", paragraphSpacing: "3",
  // Found by the coverage audit: present in the source, carried by nothing. Two-character keys
  // because the single-character space is full; nothing requires them to be one character.
  strokeCap: "sC", strokeMiterLimit: "sM", layoutGrids: "lG", exportSettings: "eS",
  overflowDirection: "oD" };
const DROP = { strokeCap: "NONE", strokeMiterLimit: 4, overflowDirection: "NONE",
  visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", isMask: false,
  cornerRadius: 0, topLeftRadius: 0, topRightRadius: 0, bottomLeftRadius: 0, bottomRightRadius: 0,
  cornerSmoothing: 0, strokeWeight: 1, strokeAlign: "INSIDE", strokeJoin: "MITER", layoutMode: "NONE",
  layoutWrap: "NO_WRAP", layoutAlign: "INHERIT", layoutGrow: 0, layoutPositioning: "AUTO", paddingLeft: 0,
  paddingRight: 0, paddingTop: 0, paddingBottom: 0, itemSpacing: 0, counterAxisSpacing: 0, paragraphIndent: 0,
  paragraphSpacing: 0, textCase: "ORIGINAL", textDecoration: "NONE", textAlignVertical: "TOP" };
const STROKED = new Set(["ELLIPSE", "RECTANGLE"]);
const INTERN = new Set(["fills", "strokes", "effects", "constraints", "fontName", "letterSpacing",
  "lineHeight", "dashPattern", "layoutGrids", "exportSettings"]);

const r2 = (x) => (typeof x === "number" && isFinite(x)) ? Math.round(x * 100) / 100 : x;
const r4 = (x) => (typeof x === "number" && isFinite(x)) ? Math.round(x * 10000) / 10000 : x;
const r6 = (x) => (typeof x === "number" && isFinite(x)) ? Math.round(x * 1e6) / 1e6 : x;
// Two decimals is the right precision for geometry measured in pixels and the wrong precision for
// anything normalised to 0..1. A colour channel rounded to 1/100 lands up to 1.3 levels of 255 away
// from the source, and an image's crop transform rounded the same way moved the crop of a 4096 px
// image by sixteen pixels. Those keys keep six decimals; everything else stays at two.
const PRECISE = new Set(["color", "imageTransform", "gradientTransform", "gradientStops",
  "filters", "opacity"]);
function round(v, precise) {
  if (typeof v === "number") return precise ? r6(v) : r2(v);
  if (Array.isArray(v)) return v.map((x) => round(x, precise));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = round(v[k], precise || PRECISE.has(k));
    return o;
  }
  return v;
}
const FILTER_OK = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
const IMG_OK = new Set(["type", "scaleMode", "imageHash", "imageTransform", "scalingFactor", "rotation", "filters", "visible", "opacity", "blendMode"]);
// Effects get the same treatment as image paints: Pixso puts keys in them that Figma's validator
// rejects outright, and one rejected effect loses the whole shadow on that node.
const EFFECT_OK = new Set(["type", "color", "offset", "radius", "spread", "visible", "blendMode",
  "showShadowBehindNode", "boundVariables"]);
let effectsCleaned = 0;
function sanitizeEffects(v) {
  if (!Array.isArray(v)) return v;
  return v.map((e) => {
    if (!e || typeof e !== "object") return e;
    let dropped = false;
    const o = {};
    for (const k of Object.keys(e)) { if (EFFECT_OK.has(k)) o[k] = e[k]; else dropped = true; }
    if (dropped) effectsCleaned++;
    return o;
  });
}
// Image hashes are content-addressed and normally resolve in Figma verbatim once the same bytes
// are uploaded. The exception is an image whose bytes Pixso never held locally (remote library):
// px-images.mjs renders a substitute, which uploads under a different hash, so those get remapped.
const IMAGEMAP = process.env.PX_IMAGEMAP ? JSON.parse(readFileSync(process.env.PX_IMAGEMAP, "utf8")) : {};
// Per-range text fills, recovered by px-textruns.mjs because getStyledTextSegments is dead in
// Pixso. Without them a two-tone string arrives with fills reported as mixed, which the loop
// below skips, and Figma falls back to black.
const TEXTRUNS = process.env.PX_TEXTRUNS ? JSON.parse(readFileSync(process.env.PX_TEXTRUNS, "utf8")) : {};
let textRuns = 0;
let imageRemapped = 0;
function sanitizePaints(v) {
  if (!Array.isArray(v)) return v;
  return v.map((p) => {
    if (!p || p.type !== "IMAGE") return p;
    const o = {}; for (const k of Object.keys(p)) if (IMG_OK.has(k)) o[k] = p[k];
    if (o.imageHash && IMAGEMAP[o.imageHash]) { o.imageHash = IMAGEMAP[o.imageHash]; imageRemapped++; }
    if (o.filters) { const f = {}; for (const k of FILTER_OK) if (o.filters[k] !== undefined) f[k] = o.filters[k]; o.filters = f; }
    return o;
  });
}

const svgList = [], svgIdx = new Map();
for (const h of Object.keys(SVG.assets)) { svgIdx.set(h, svgList.length); svgList.push(SVG.assets[h]); }
const textSvgIdx = new Map();
for (const k of Object.keys(TEXTSVG)) { textSvgIdx.set(k, svgList.length); svgList.push(TEXTSVG[k].s); }

const dict = [], dictIdx = new Map();
const intern = (v0) => { const v = round(v0); const k = JSON.stringify(v);
  if (dictIdx.has(k)) return dictIdx.get(k);
  const i = dict.length; dict.push(v); dictIdx.set(k, i); return i; };

const fonts = new Map(), flat = [];
let sideStrokes = 0, arcs = 0, degenerate = 0;
let svgNodes = 0, missingSvg = 0, missingAbs = 0, arbFallback = 0, alRotSwap = 0, textAsSvg = 0, inkTagged = 0, inkOffset = 0;

// Pixso returns absoluteRenderBounds = null for many nodes, and absoluteBoundingBox excludes the
// stroke, while the exported SVG is always sized to the render bounds. Recover the render box from
// the SVG's own viewBox, outset symmetrically around the geometry box.
const vbCache = new Map();
function viewBox(svg) {
  if (vbCache.has(svg)) return vbCache.get(svg);
  const m = /viewBox="([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)"/.exec(svg);
  const v = m ? { w: parseFloat(m[3]), h: parseFloat(m[4]) } : null;
  vbCache.set(svg, v); return v;
}

function encode(n, path, parentIdx, parentAbs, parentNode) {
  const key = path.join(".");
  const absArr = ABS[key];
  const abs = absArr ? absArr.slice() : null;
  if (!abs) missingAbs++;
  const parentAL = !!(parentNode && parentNode.layoutMode && parentNode.layoutMode !== "NONE");

  const o = {};
  if (VEC.has(n.type)) {
    const ref = SVG.refs[key];
    const b = BOUNDS[key];
    let box = b && b.arb;
    if (!box && b && b.abb) {
      const vb = viewBox(SVG.assets[ref]);
      box = vb
        ? { x: b.abb.x - (vb.w - b.abb.width) / 2, y: b.abb.y - (vb.h - b.abb.height) / 2, width: vb.w, height: vb.h }
        : b.abb;
      arbFallback++;
    }
    // A degenerate vector — zero size, inside a hidden subtree — gets no bounding box of any kind
    // from Pixso. Dropping it would silently shorten the layer tree, so it is placed from its own
    // absolute transform at whatever size it claims.
    if (!box && abs) {
      box = { x: abs[2], y: abs[5], width: n.width || 0, height: n.height || 0 };
      degenerate++;
    }
    if (ref !== undefined && box) {
      svgNodes++;
      // The wrapper frame must occupy the LAYOUT box the source node occupied, not its inked box.
      // A 1 px hairline is a zero-height LINE with a 1 px stroke: sizing the wrapper to the ink
      // adds a pixel per item inside an auto-layout, and the error accumulates down the stack.
      // So: wrapper = geometry box, and the ink is offset inside it by the difference.
      const lay = (b && b.abb) ? b.abb : box;
      o["6"] = svgIdx.get(ref);
      o["7"] = mul(inv(parentAbs), [1, 0, lay.x, 0, 1, lay.y]).map(r4);
      o.j = r2(lay.width); o.k = r2(lay.height);
      const ix = box.x - lay.x, iy = box.y - lay.y;
      if (Math.abs(ix) > 0.001 || Math.abs(iy) > 0.001 || Math.abs(box.width - lay.width) > 0.001 || Math.abs(box.height - lay.height) > 0.001) {
        o["9"] = [r4(ix), r4(iy)];
        inkOffset++;
      }
      o.a = n.name; o.b = "SVG";
      if (n.visible === false) o.c = false;
      if (n.opacity !== undefined && n.opacity !== 1) o.e = n.opacity;
      if (n.blendMode && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL") o.f = n.blendMode;
      if (n.isMask) o.g = true;
      if (n.constraints && !(n.constraints.horizontal === "MIN" && n.constraints.vertical === "MIN")) o.Q = intern(n.constraints);
      if (n.layoutAlign && n.layoutAlign !== "INHERIT") o.K = n.layoutAlign;
      if (n.layoutGrow) o.L = n.layoutGrow;
      if (n.layoutPositioning && n.layoutPositioning !== "AUTO") o.M = n.layoutPositioning;
      if (n.effects && n.effects.length) o.P = intern(sanitizeEffects(n.effects));
      const si = flat.length; flat.push({ p: parentIdx, d: o });
      return si;
    }
    missingSvg++;
  }

  // Pixso will not disclose some instance text overrides through any API (characters,
  // componentProperties, overrides, DSL, design_to_code all return the component default) while its
  // renderer draws the real string. For those nodes the render is the only faithful source.
  if (n.type === "TEXT" && textSvgIdx.has(key) && abs) {
    textAsSvg++;
    o["6"] = textSvgIdx.get(key);
    o["7"] = mul(inv(parentAbs), abs).map(r4);
    o.j = r2(n.width); o.k = r2(n.height);
    o.a = n.name; o.b = "SVG";
    if (n.visible === false) o.c = false;
    if (n.opacity !== undefined && n.opacity !== 1) o.e = n.opacity;
    if (n.constraints && !(n.constraints.horizontal === "MIN" && n.constraints.vertical === "MIN")) o.Q = intern(n.constraints);
    if (n.layoutAlign && n.layoutAlign !== "INHERIT") o.K = n.layoutAlign;
    if (n.layoutGrow) o.L = n.layoutGrow;
    if (n.layoutPositioning && n.layoutPositioning !== "AUTO") o.M = n.layoutPositioning;
    const ti = flat.length; flat.push({ p: parentIdx, d: o });
    return ti;
  }

  for (const k of Object.keys(n)) {
    if (k === "children") continue;
    const a = A[k]; if (!a) continue;
    const v = n[k];
    if (v === null || v === undefined || v === "unable") continue;
    if (v && typeof v === "object" && v.__mixed) continue;
    if (k in DROP && JSON.stringify(v) === JSON.stringify(DROP[k])) continue;
    if (k === "strokes" && Array.isArray(v) && v.length === 0 && !STROKED.has(n.type)) continue;
    if (k === "constraints" && v.horizontal === "MIN" && v.vertical === "MIN") continue;
    if (k === "fontName" && v.family) fonts.set(v.family + "|" + v.style, v.family + " " + v.style);
    const vv = (k === "fills" || k === "strokes") ? sanitizePaints(v)
      : (k === "effects" ? sanitizeEffects(v) : v);
    o[a] = INTERN.has(k) && typeof vv === "object" ? intern(vv) : round(vv);
  }
  // Pixso reports strokeWeight as a single number even when the four sides differ, so a frame
  // with only a bottom border reads as a full 1 px box and Figma draws one. Carry the sides, but
  // only where they actually disagree with strokeWeight.
  if (typeof n.strokeTopWeight === "number") {
    const sw = typeof n.strokeWeight === "number" ? n.strokeWeight : 1;
    const sides = [["strokeTopWeight", "h"], ["strokeRightWeight", "i"], ["strokeBottomWeight", "l"], ["strokeLeftWeight", "x"]];
    let differs = false;
    for (const [k2] of sides) if (n[k2] !== sw) differs = true;
    if (differs) { for (const [k2, a2] of sides) o[a2] = r2(n[k2]); sideStrokes++; }
  }

  // An ellipse with an arc or a donut hole is not a full ellipse, and Figma will draw one unless
  // arcData travels. Only worth carrying when it is not the default full circle.
  if (n.type === "ELLIPSE" && n.arcData) {
    const ad = n.arcData;
    const full = Math.abs((ad.endingAngle || 0) - (ad.startingAngle || 0) - Math.PI * 2) < 1e-6;
    if (!full || (ad.innerRadius || 0) > 0) { o.aD = intern(round(ad)); arcs++; }
  }
  if (n.type === "TEXT") {
    const runs = TEXTRUNS[key];
    if (runs && runs.length) {
      o["5"] = runs.map((rr) => [rr.s, rr.e, intern(sanitizePaints(rr.f))]);
      if (o.N === undefined) o.N = intern(sanitizePaints(runs[0].f));
      if (runs.length > 1) textRuns++;
    }
    const ti = TEXTINK[key];
    if (ti && ti.arb && typeof n.characters === "string" && n.characters.indexOf(String.fromCharCode(10)) < 0) { o["8"] = r2(ti.arb.width); inkTagged++; }
  }
  if (abs && parentAbs) {
    const rt = mul(inv(parentAbs), abs);
    // Figma ignores rotation on auto-layout flow children; Pixso does not. For the quarter-turn
    // cases that actually occur, bake the turn into the size instead of losing it.
    // Baking the quarter turn into the size is right for a LEAF — a 24x1 divider rotated 90
    // degrees is a 1x24 divider, and it looks identical. It is wrong for a node with children:
    // they are placed in its own frame of reference, so flattening its matrix turns every one of
    // them by 90 degrees. A sideways toolbar is built exactly that way — the panel is rotated and
    // its rows counter-rotated to stand upright — and it arrived with every icon on its side.
    // Those keep their rotation, and the builder takes them out of the flow so Figma honours it.
    const isLeaf = !(n.children && n.children.length);
    if (parentAL && isLeaf && o.M !== "ABSOLUTE" && Math.abs(Math.abs(rt[1]) - 1) < 1e-3 &&
        o.j !== undefined && o.k !== undefined) {
      // Bake the quarter turn into the size AND flatten the matrix, so stored size and stored
      // transform keep describing the same box.
      const w = o.j, h = o.k;
      let mx = Infinity, my = Infinity;
      for (const c of [[0, 0], [w, 0], [w, h], [0, h]]) {
        const px = rt[0] * c[0] + rt[1] * c[1] + rt[2], py = rt[3] * c[0] + rt[4] * c[1] + rt[5];
        if (px < mx) mx = px; if (py < my) my = py;
      }
      o.j = h; o.k = w; alRotSwap++;
      o["7"] = [1, 0, r4(mx), 0, 1, r4(my)];
    } else o["7"] = rt.map(r4);
  }

  const idx = flat.length;
  flat.push({ p: parentIdx, d: o });
  const nextAbs = abs || parentAbs;
  (n.children || []).forEach((c, i) => encode(c, path.concat(i), idx, nextAbs, n));
  return idx;
}

const rootAbs = ABS[""] || [1, 0, 0, 0, 1, 0];
encode(target, [], -1, rootAbs, null);

// The builder and verifier are shipped as source and only parsed inside Figma, where a syntax
// error would surface as a failed build with no useful message. Parse them here instead.
{
  const AF = Object.getPrototypeOf(async function () {}).constructor;
  for (const [nm, src] of [["builder", BUILDER_SRC], ["verifier", VERIFIER_SRC]]) {
    try { new AF("figma", "PAY", "ROOT_NODE_ID", "let RESULT=null;" + String.fromCharCode(10) + src + String.fromCharCode(10) + "return RESULT;"); }
    catch (e) { console.error(nm + " does not parse: " + e.message); process.exit(1); }
  }
}
// PX_PLACE_ABS puts the built root at the source's own page position, so a page migrated
// section by section comes out laid out the way it was.
const rootAbsXY = process.env.PX_PLACE_ABS && rootAbs ? [r2(rootAbs[2]), r2(rootAbs[5])] : null;
if (rootAbsXY) console.log("place:       root at source position " + rootAbsXY[0] + ", " + rootAbsXY[1]);
const payloadObj = { D: dict, S: svgList, F: flat, B: BUILDER_SRC, V: VERIFIER_SRC };
if (rootAbsXY) payloadObj.XY = rootAbsXY;
const json = Buffer.from(JSON.stringify(payloadObj), "utf8");
const body = Buffer.alloc(4 + json.length);
body.writeUInt32BE(json.length, 0); json.copy(body, 4);

const W = Math.max(2048, Math.ceil(Math.sqrt(body.length)));
const H = Math.ceil(body.length / W);
if (H > 4000 || W > 4000) console.error("WARN carrier " + W + "x" + H + " — Figma may resample above 4096 px");
const raw = Buffer.alloc(H * (W + 1));
for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; body.copy(raw, y * (W + 1) + 1, y * W, Math.min(body.length, (y + 1) * W)); }
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function mk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mk("IHDR", ihdr),
  mk("IDAT", deflateSync(raw, { level: 0 })), mk("IEND", Buffer.alloc(0))]);
writeFileSync(OUT, png);
// The PNG carrier exists for the agent channel, where the payload has to travel as an image.
// The plugin runner takes the JSON directly, so write that too.
const JSON_OUT = (OUT.toLowerCase().endsWith(".png") ? OUT.slice(0, -4) : OUT) + ".json";
writeFileSync(JSON_OUT, json);
console.log("json:        " + JSON_OUT);
// A short companion file so a later step can learn what this payload is without reading a
// 155 MB intermediate just to find the root id.
writeFileSync((JSON_OUT.toLowerCase().endsWith(".json") ? JSON_OUT.slice(0, -5) : JSON_OUT) + "-meta.json", JSON.stringify({
  rootId: ROOT_ID, rootName: target.name, rootType: target.type,
  nodes: flat.length, svg: svgNodes, xy: rootAbsXY,
}, null, 2), "utf8");

console.log("root:        " + target.type + " " + JSON.stringify(target.name));
console.log("nodes:       " + flat.length + "  (svg " + svgNodes + ", dict " + dict.length + ", svg assets " + svgList.length + ")");
console.log("missing:     svg " + missingSvg + ", abs " + missingAbs + (degenerate ? "   (" + degenerate + " degenerate vectors placed from their transform)" : ""));
console.log("text runs:   " + textRuns + " nodes with per-range fills recovered");
if (paintsSubbed) console.log("paints:      " + paintsSubbed + " image paints replaced by a render, because Figma has no field for their filter");
if (effectsCleaned) console.log("effects:     " + effectsCleaned + " had keys Figma rejects, stripped");
console.log("strokes:     " + sideStrokes + " nodes with per-side stroke weights, " + arcs + " ellipse arcs/donuts");
console.log("images:      " + Object.keys(IMAGEMAP).length + " hashes remapped in " + imageRemapped + " paints");
console.log("recovered:   " + arbFallback + " render boxes from viewBox, " + alRotSwap + " auto-layout quarter turns baked into size, " + inkOffset + " svg wrappers with ink outside the layout box");
console.log("text:        " + textAsSvg + " rendered as svg (undisclosed override), " + inkTagged + " tagged with inked width");
console.log("fonts:       " + [...fonts.values()].join(", "));
console.log("json:        " + json.length.toLocaleString() + " bytes");
console.log("png:         " + png.length.toLocaleString() + " bytes (" + W + "x" + H + ") -> " + OUT);
