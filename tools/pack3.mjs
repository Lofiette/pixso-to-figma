// Pack an IR subtree into a PNG data carrier for upload_assets.
// The JSON is stored as raw greyscale scanlines; PNG's own zlib does the compressing.
// usage: node tools/pack3.mjs <ir.json> <rootId> <out.png>
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const [, , IR_PATH, ROOT_ID, OUT = "out/payload.png"] = process.argv;
const ir = JSON.parse(readFileSync(IR_PATH, "utf8"));
let target = null;
(function w(n) { if (n.id === ROOT_ID) { target = n; return; } if (n.children) n.children.forEach(w); })(ir.tree);
if (!target) { console.error("not found: " + ROOT_ID); process.exit(1); }

const A = { name:"a",type:"b",visible:"c",locked:"d",opacity:"e",blendMode:"f",isMask:"g",x:"h",y:"i",
  width:"j",height:"k",rotation:"l",clipsContent:"m",cornerRadius:"n",topLeftRadius:"o",
  topRightRadius:"p",bottomLeftRadius:"q",bottomRightRadius:"r",cornerSmoothing:"s",strokeWeight:"t",
  strokeAlign:"u",strokeJoin:"v",dashPattern:"w",layoutMode:"y",layoutWrap:"z",
  primaryAxisSizingMode:"A",counterAxisSizingMode:"B",primaryAxisAlignItems:"C",
  counterAxisAlignItems:"D",paddingLeft:"E",paddingRight:"F",paddingTop:"G",paddingBottom:"H",
  itemSpacing:"I",counterAxisSpacing:"J",layoutAlign:"K",layoutGrow:"L",layoutPositioning:"M",
  fills:"N",strokes:"O",effects:"P",constraints:"Q",vectorPaths:"R",characters:"S",fontSize:"T",
  fontName:"U",textAlignHorizontal:"V",textAlignVertical:"W",textAutoResize:"X",textCase:"Y",
  textDecoration:"Z",letterSpacing:"0",lineHeight:"1",paragraphIndent:"2",paragraphSpacing:"3",booleanOperation:"5",vectorNetwork:"6" };
const DROP = { visible:true,locked:false,opacity:1,blendMode:"PASS_THROUGH",isMask:false,rotation:0,
  cornerRadius:0,topLeftRadius:0,topRightRadius:0,bottomLeftRadius:0,bottomRightRadius:0,
  cornerSmoothing:0,strokeWeight:1,strokeAlign:"INSIDE",strokeJoin:"MITER",layoutMode:"NONE",
  layoutWrap:"NO_WRAP",layoutAlign:"INHERIT",layoutGrow:0,layoutPositioning:"AUTO",paddingLeft:0,
  paddingRight:0,paddingTop:0,paddingBottom:0,itemSpacing:0,counterAxisSpacing:0,paragraphIndent:0,
  paragraphSpacing:0,textCase:"ORIGINAL",textDecoration:"NONE",textAlignVertical:"TOP" };
const STROKED = new Set(["VECTOR","LINE","BOOLEAN_OPERATION","ELLIPSE","POLYGON","STAR","RECTANGLE"]);
const INTERN = new Set(["fills","strokes","effects","constraints","vectorPaths","vectorNetwork","fontName",
  "letterSpacing","lineHeight","dashPattern"]);

const r2 = (x) => (typeof x === "number" && isFinite(x)) ? Math.round(x * 100) / 100 : x;
function round(v) {
  if (typeof v === "number") return r2(v);
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) {
      let x = v[k];
      if (k === "data" && typeof x === "string") x = x.replace(/-?\d+\.\d+(?:e[-+]?\d+)?/gi, (m) => String(r2(parseFloat(m))));
      o[k] = round(x);
    }
    return o;
  }
  return v;
}

const FILTER_OK = ["exposure","contrast","saturation","temperature","tint","highlights","shadows"];

const CAP_OK = new Set(["NONE","ROUND","SQUARE","ARROW_LINES","ARROW_EQUILATERAL"]);
const JOIN_OK = new Set(["MITER","BEVEL","ROUND"]);
const MIRROR_MAP = { NONE: "NONE", ANGLE: "ANGLE", ANGLE_AND_LENGTH: "ANGLE_AND_LENGTH" };
let mirrorDropped = 0;
function sanitizeNetwork(g) {
  if (!g || !g.vertices) return g;
  return {
    vertices: g.vertices.map(function (v) {
      const o = { x: v.x, y: v.y };
      if (v.cornerRadius) o.cornerRadius = v.cornerRadius;
      if (v.strokeCap && CAP_OK.has(v.strokeCap)) o.strokeCap = v.strokeCap;
      if (v.strokeJoin && JOIN_OK.has(v.strokeJoin)) o.strokeJoin = v.strokeJoin;
      if (v.handleMirroring) { if (MIRROR_MAP[v.handleMirroring]) o.handleMirroring = MIRROR_MAP[v.handleMirroring]; else mirrorDropped++; }
      return o;
    }),
    segments: g.segments.map(function (s) {
      return { start: s.start, end: s.end,
        tangentStart: { x: s.tangentStart.x, y: s.tangentStart.y },
        tangentEnd: { x: s.tangentEnd.x, y: s.tangentEnd.y } };
    }),
    regions: (g.regions || []).map(function (r) { return { windingRule: r.windingRule, loops: r.loops }; })
  };
}

const IMG_OK = new Set(["type","scaleMode","imageHash","imageTransform","scalingFactor","rotation","filters","visible","opacity","blendMode"]);
function sanitizePaints(v) {
  if (!Array.isArray(v)) return v;
  return v.map(function (p) {
    if (!p || p.type !== "IMAGE") return p;
    const o = {};
    for (const k of Object.keys(p)) if (IMG_OK.has(k)) o[k] = p[k];
    if (o.filters) { const f = {}; for (const k of FILTER_OK) if (o.filters[k] !== undefined) f[k] = o.filters[k]; o.filters = f; }
    return o;
  });
}

const dict = [], dictIdx = new Map();
const intern = (v0) => { const v = round(v0); const k = JSON.stringify(v);
  if (dictIdx.has(k)) return dictIdx.get(k);
  const i = dict.length; dict.push(v); dictIdx.set(k, i); return i; };
const fonts = new Map(), flat = [];
function encode(n, parentIdx) {
  const o = {};
  for (const key of Object.keys(n)) {
    if (key === "children") continue;
    const a = A[key]; if (!a) continue;
    const v = n[key];
    if (v === null || v === undefined || v === "unable") continue;
    if (v && typeof v === "object" && v.__mixed) continue;
    if (key in DROP && JSON.stringify(v) === JSON.stringify(DROP[key])) continue;
    if (key === "strokes" && Array.isArray(v) && v.length === 0 && !STROKED.has(n.type)) continue;

    if (key === "constraints" && v.horizontal === "MIN" && v.vertical === "MIN") continue;
    if (key === "fontName" && v.family) fonts.set(v.family + "|" + v.style, v.family + " " + v.style);
    let vv = (key === "fills" || key === "strokes") ? sanitizePaints(v) : v;
    if (key === "vectorNetwork") vv = sanitizeNetwork(v);
    o[a] = INTERN.has(key) && typeof vv === "object" ? intern(vv) : round(vv);
  }
  const idx = flat.length;
  flat.push({ p: parentIdx, d: o });
  for (const c of n.children || []) encode(c, idx);
  return idx;
}
encode(target, -1);

const json = Buffer.from(JSON.stringify({ D: dict, F: flat }), "utf8");
const body = Buffer.alloc(4 + json.length);
body.writeUInt32BE(json.length, 0);
json.copy(body, 4);

const W = 2048;
const H = Math.ceil(body.length / W);
const raw = Buffer.alloc(H * (W + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W + 1)] = 0;
  body.copy(raw, y * (W + 1) + 1, y * W, Math.min(body.length, (y + 1) * W));
}
function crc32(buf) { let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0; }
function mk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]); }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  mk("IHDR", ihdr), mk("IDAT", deflateSync(raw, { level: 9 })), mk("IEND", Buffer.alloc(0))]);
writeFileSync(OUT, png);

console.log("root:      " + target.type + ' "' + target.name + '"');
console.log("nodes:     " + flat.length + "  (dict " + dict.length + ")");
console.log("fonts:     " + [...fonts.values()].join(", "));
console.log("json:      " + json.length.toLocaleString() + " bytes");
console.log("png:       " + png.length.toLocaleString() + " bytes  (" + W + "x" + H + ")  -> " + OUT);
console.log("mirrorDropped: " + mirrorDropped);
console.log("ratio:     " + (json.length / png.length).toFixed(1) + "x");
