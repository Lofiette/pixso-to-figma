// The render audit's rules (docs/M1.md §16): which roots an IR run built, how each is rendered in Figma
// and in Pixso, how the two pictures are made comparable, and when a root is ok. The I/O (the plugin,
// Pixso's MCP channel, the run folder) is tools/ir-audit.mjs's; everything here is a function of data,
// so tools/test-iraudit.mjs runs it on the headless double and the fake Pixso.
//
//   import { AUDIT_SETTINGS, auditRoots, auditRun } from "./ir/render-audit.mjs";
//   const audit = await auditRun({ states, ir, reports, settings, figmaExport, pixsoRender, identity, previous, onRoot });
//
// The audit file is { format: "pix2fig.audit", version: 2, snapshot, runId, roots: [{ i, guid, ok, … }] }
// (tools/ir/verdict.mjs reads i, guid and ok; the rest is the evidence). `ok` is true only for a root
// that was compared and is within every threshold; false for one that differs or whose render is
// missing (a missing render is a failure, never a pass); null for one with nothing left to compare once
// its placeholders are masked (not compared: it covers nothing and fails nothing). A root that is an
// INSTANCE record is a placeholder frame in M1: it is not rendered, and is listed in placeholderRoots
// (G11 holds it).
//
// The rules, each from the live session of 2026-10-05 (§15.11) or the old tool's lessons
// (tools/visual-all.mjs):
// - both engines render at one scale, chosen from the IR box: min(maxScale, maxSide / its longest side);
// - Pixso's export leaves out the exported node's own opacity and Figma's applies it: --opacity undo
//   (default) divides Figma's alpha by it; below --undo-opacity-min, and under --opacity apply, Pixso's
//   alpha is multiplied by it instead;
// - Figma renders a SECTION with a wider margin than its box: --section crop (default) cuts each picture
//   to the node's box, children compares the section's children one by one (its own fill is then not
//   compared), none compares the pictures as they come;
// - an instance placeholder is an empty frame in M1 and Pixso draws the instance: --placeholders mask
//   (default) leaves each visible placeholder's box, padded by --mask-pad, out of both pictures;
// - an image the run could not carry is a grey IMAGE_PLACEHOLDER paint in Figma (counted in the verdict)
//   and Pixso draws the image: --image-placeholders compare (default) keeps the difference, so the root
//   fails and says it holds image placeholders; mask leaves those nodes' boxes out like an instance's;
// - both pictures are laid over white before any pixel is compared (a transparent pixel is 0,0,0 in
//   Pixso and 255,255,255 in Figma), and aligned at their top left (each picture covers what its node
//   draws);
// - a picture whose size differs from the other's by more than --size-tol node units is a difference
//   in itself (a wrapped line shows that way, whatever the colours);
// - "ink on one side" is a channel differing by more than --ink (191 of 255); its share is held to
//   --gross-max, the mean difference to --mean-max (a low-contrast defect moves the mean, not the
//   share), and the worst tile's mean to --tile-mean-max when that is above 0.
import { decodePNG } from "../pngutil.mjs";
import { CODE, canonicalJSON, fnv1a64 } from "./schema.mjs";

export const AUDIT_FORMAT = "pix2fig.audit";
export const AUDIT_VERSION = 2;

const num = (lo, hi) => (v, f) => { const n = Number(v); if (!(Number.isFinite(n) && n >= lo && n <= hi)) throw new RangeError(f + " is a number from " + lo + " to " + hi); return n; };
const int = (lo, hi) => (v, f) => { const n = num(lo, hi)(v, f); if (Math.floor(n) !== n) throw new RangeError(f + " is a whole number"); return n; };

// flag -> [key, values | parser, default, part of the result]. A setting marked false does not change
// any root's result (a root kept from an earlier pass is reused only under the same result settings).
export const AUDIT_SETTINGS = {
  "--max-side": ["maxSide", int(16, 16384), 800, true],
  "--max-scale": ["maxScale", num(0.01, 16), 1, true],
  "--ink": ["ink", num(1, 255), 191, true],
  "--gross-max": ["grossMax", num(0, 1), 0.01, true],
  "--mean-max": ["meanMax", num(0, 255), 5, true],
  "--tile": ["tile", int(4, 1024), 32, true],
  "--tile-mean-max": ["tileMeanMax", num(0, 255), 0, true],
  "--size-tol": ["sizeTol", num(0, 100000), 1, true],
  "--section": ["section", ["crop", "children", "none"], "crop", true],
  "--placeholders": ["placeholders", ["mask", "compare"], "mask", true],
  "--mask-pad": ["maskPad", num(0, 10000), 2, true],
  "--image-placeholders": ["imagePlaceholders", ["compare", "mask"], "compare", true],
  "--opacity": ["opacity", ["undo", "apply"], "undo", true],
  "--undo-opacity-min": ["undoOpacityMin", num(0.001, 1), 0.05, true],
  "--pictures": ["pictures", ["failed", "all", "none"], "failed", false],
  "--render-timeout-s": ["renderTimeoutS", num(1, 3600), 120, false],
};

export function defaultAuditSettings() {
  const o = {};
  for (const f of Object.keys(AUDIT_SETTINGS)) o[AUDIT_SETTINGS[f][0]] = AUDIT_SETTINGS[f][2];
  return o;
}

// The settings a root's result depends on, hashed: a root kept from an earlier pass is reused only when
// this, the snapshot and the runId are the same.
export function resultKey(states, settings) {
  const s = {};
  for (const f of Object.keys(AUDIT_SETTINGS)) if (AUDIT_SETTINGS[f][3]) s[AUDIT_SETTINGS[f][0]] = settings[AUDIT_SETTINGS[f][0]];
  return fnv1a64(canonicalJSON({ snapshot: states.snapshot, runId: states.runId, s }));
}

// argv -> { runDir, settings, fresh, acceptIdentity, mcpUrl, given }; throws RangeError on a bad flag.
export function parseAuditArgs(argv) {
  const o = { runDir: null, settings: defaultAuditSettings(), fresh: false, acceptIdentity: null, mcpUrl: null, given: [] };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--fresh") { o.fresh = true; continue; }
    if (a === "--accept-identity-mismatch" || a === "--mcp-url") {
      const v = argv[++k];
      if (v === undefined || !String(v).trim() || String(v).startsWith("--")) throw new RangeError(a + " needs a value" + (a === "--mcp-url" ? "" : ": the known, benign difference (for example \"renamed nodes\"), recorded in the audit"));
      if (a === "--mcp-url") o.mcpUrl = v; else o.acceptIdentity = String(v).trim().slice(0, 200);
      continue;
    }
    if (AUDIT_SETTINGS[a]) {
      const [key, rule] = AUDIT_SETTINGS[a];
      const v = argv[++k];
      if (v === undefined) throw new RangeError(a + " needs a value");
      if (Array.isArray(rule)) { if (rule.indexOf(v) < 0) throw new RangeError(a + " is one of " + rule.join(", ") + "; got " + JSON.stringify(v)); o.settings[key] = v; }
      else o.settings[key] = rule(v, a);
      o.given.push(key);
      continue;
    }
    if (a.startsWith("--")) throw new RangeError("unknown option " + a);
    if (o.runDir) throw new RangeError("one run folder at a time; got " + o.runDir + " and " + a);
    o.runDir = a;
  }
  if (!o.runDir) throw new RangeError("the run folder is required (the one tools/pix-run.mjs printed)");
  return o;
}

// ---------- which roots ----------
// Every root of every build task (tools/ir/verdict.mjs's set), each with the Figma id its verify found.
// Only a verify the states record as done counts: a report left in the folder by a verify that has not
// run again since its build was re-run names the earlier build's nodes. reports: Map(taskNo -> verify
// report) or a plain object. Returns { roots, placeholderRoots }:
// roots [{ i, guid, type, figmaId, verifyTask }], placeholderRoots [{ i, guid }] (INSTANCE records).
export function auditRoots(states, ir, reports) {
  const rep = (no) => (reports instanceof Map ? reports.get(no) : reports && reports[no]) || null;
  const idOf = new Map();
  for (const t of states.tasks || []) {
    if (t.op !== "verify" || (t.state !== "built" && t.state !== "built-with-fallbacks")) continue;
    const r = rep(t.taskNo);
    if (r && r.taskNo !== undefined && r.taskNo !== t.taskNo) continue;
    for (const x of (r && Array.isArray(r.roots) ? r.roots : [])) if (x && x.found && typeof x.id === "string") idOf.set(x.i, { id: x.id, task: t.taskNo });
  }
  const roots = [], placeholderRoots = [], seen = new Set();
  for (const t of states.tasks || []) {
    if (t.op !== "build") continue;
    for (const i of t.roots || []) {
      if (seen.has(i)) continue;
      seen.add(i);
      const r = ir.nodes[i];
      if (!r) { roots.push({ i, guid: null, type: null, figmaId: null, verifyTask: null }); continue; }
      if (r.type === "INSTANCE") { placeholderRoots.push({ i, guid: r.guid }); continue; }
      const f = idOf.get(i);
      roots.push({ i, guid: r.guid, type: r.type, figmaId: f ? f.id : null, verifyTask: f ? f.task : null });
    }
  }
  return { roots, placeholderRoots };
}

export function childrenIndex(ir) {
  const kids = new Map();
  ir.nodes.forEach((r, i) => { if (!kids.has(r.parent)) kids.set(r.parent, []); kids.get(r.parent).push(i); });
  return kids;
}

// ---------- geometry ----------
const mul = (a, b) => [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2],
  a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]];
const corners = (m, w, h) => [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]);
function bboxOf(m, w, h) {
  const c = corners(m, w, h);
  return [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
}

// The root's linear part: how its own frame lies in the picture (a turned or flipped root's picture is
// its turned box).
export function linearOf(rec) {
  const m = rec.props.relativeTransform;
  return [m[0], m[1], 0, m[3], m[4], 0];
}

// Every visible placeholder under record i, as a box in i's own frame: [x0, y0, x1, y1]. images: a Set of
// the records the build drew an IMAGE_PLACEHOLDER on; with it, { instances, images } (i itself included).
export function placeholderBoxes(ir, i, kids, images) {
  const K = kids || childrenIndex(ir);
  const out = [], imgs = [];
  const I0 = [1, 0, 0, 0, 1, 0];
  if (images && images.has(i)) imgs.push(bboxOf(I0, ir.nodes[i].props.width, ir.nodes[i].props.height));
  const walk = (j, m) => {
    for (const c of K.get(j) || []) {
      const r = ir.nodes[c];
      if (r.props.visible === false) continue;
      const mc = mul(m, r.props.relativeTransform);
      if (r.type === "INSTANCE") { out.push(bboxOf(mc, r.props.width, r.props.height)); continue; }
      if (images && images.has(c)) imgs.push(bboxOf(mc, r.props.width, r.props.height));
      walk(c, mc);
    }
  };
  walk(i, I0);
  return images ? { instances: out, images: imgs } : out;
}

// Where the node's box sits in its picture, in pixels: { ox, oy, bw, bh, rule } or null when the
// picture cannot hold the box. side: { W, H } of the picture, box and render ({ x, y, width, height }
// or null, as the engine reported them); size [w, h] of the node's own box in its frame and lin its
// linear part, for an engine that reports no box.
export function placeBox(side, s, size, lin) {
  const b = side.box && side.box.width >= 0 ? side.box : null;
  const ext = b ? [b.width, b.height] : (() => { const q = bboxOf(lin, size[0], size[1]); return [q[2] - q[0], q[3] - q[1]]; })();
  const bw = ext[0] * s, bh = ext[1] * s, tol = 1.5;
  const r = side.render && side.render.width >= 0 ? side.render : null;
  if (r && b && Math.abs(side.W - r.width * s) <= tol && Math.abs(side.H - r.height * s) <= tol) return { ox: (b.x - r.x) * s, oy: (b.y - r.y) * s, bw, bh, rule: "render bounds" };
  if (Math.abs(side.W - bw) <= tol && Math.abs(side.H - bh) <= tol) return { ox: 0, oy: 0, bw, bh, rule: "box" };
  if (side.W >= bw - tol && side.H >= bh - tol) return { ox: Math.max(0, (side.W - bw) / 2), oy: Math.max(0, (side.H - bh) / 2), bw, bh, rule: "centred (guessed)" };
  return null;
}

// A box in the root's frame -> pixels of a picture placed by `place`.
function toPixels(box, lin, size, s, place) {
  const q0 = bboxOf(lin, size[0], size[1]);
  const pts = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]].map(([x, y]) => [lin[0] * x + lin[1] * y, lin[3] * x + lin[4] * y]);
  const xs = pts.map((p) => (p[0] - q0[0]) * s + place.ox), ys = pts.map((p) => (p[1] - q0[1]) * s + place.oy);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// ---------- pictures ----------
// Alpha scaled by f (f > 1 undoes an opacity, capped at 255).
export function scaleAlpha(img, f) {
  const rgba = Buffer.from(img.rgba);
  for (let k = 3; k < rgba.length; k += 4) rgba[k] = Math.max(0, Math.min(255, Math.round(rgba[k] * f)));
  return { W: img.W, H: img.H, rgba };
}

// Compare two pictures. Each side: { img: { W, H, rgba }, crop: [x, y, w, h] | null, masks: [[x0, y0, x1,
// y1] in its own pixels] }. Both are laid over white, cropped, aligned at their top left, and compared
// over the canvas that holds both (a pixel outside one picture is that picture's white); a pixel inside
// a mask on either side is left out.
export function comparePictures(F, P, S) {
  const cut = (side) => {
    const c = side.crop ? side.crop.map((v) => Math.max(0, Math.round(v))) : [0, 0, side.img.W, side.img.H];
    const x0 = Math.min(c[0], side.img.W), y0 = Math.min(c[1], side.img.H);
    const W = Math.max(0, Math.min(side.img.W - x0, c[2])), H = Math.max(0, Math.min(side.img.H - y0, c[3]));
    // The masks as a bitmap over the cut (a pixel is masked when its centre is inside a mask).
    const bits = new Uint8Array(W * H);
    for (const m of side.masks || []) {
      const p0 = Math.max(0, Math.ceil(m[0] - x0 - 0.5)), p1 = Math.min(W, Math.ceil(m[2] - x0 - 0.5));
      const q0 = Math.max(0, Math.ceil(m[1] - y0 - 0.5)), q1 = Math.min(H, Math.ceil(m[3] - y0 - 0.5));
      for (let y = q0; y < q1; y++) bits.fill(1, y * W + p0, Math.max(y * W + p0, y * W + p1));
    }
    return { x0, y0, W, H, bits };
  };
  const cf = cut(F), cp = cut(P);
  const W = Math.max(cf.W, cp.W), H = Math.max(cf.H, cp.H);
  const masked = (side, c, x, y) => x < c.W && y < c.H && c.bits[y * c.W + x] === 1;
  const over = (side, c, x, y, out) => {
    if (x >= c.W || y >= c.H) { out[0] = out[1] = out[2] = 255; return; }
    const k = ((y + c.y0) * side.img.W + (x + c.x0)) * 4, a = side.img.rgba[k + 3] / 255;
    for (let q = 0; q < 3; q++) out[q] = side.img.rgba[k + q] * a + 255 * (1 - a);
  };
  const T = S.tile;
  const tiles = new Map();
  const fa = [0, 0, 0], pa = [0, 0, 0];
  let compared = 0, maskedN = 0, same = 0, gross = 0, sum = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (masked(F, cf, x, y) || masked(P, cp, x, y)) { maskedN++; continue; }
      over(F, cf, x, y, fa); over(P, cp, x, y, pa);
      let d = 0;
      for (let q = 0; q < 3; q++) { const dc = Math.abs(fa[q] - pa[q]); if (dc > d) d = dc; }
      compared++; sum += d;
      if (d < 0.5) same++; else if (d > S.ink) gross++;
      const tk = Math.floor(y / T) * 100000 + Math.floor(x / T);
      const t = tiles.get(tk) || [0, 0];
      t[0] += d; t[1]++;
      tiles.set(tk, t);
    }
  }
  let worstTile = 0;
  for (const t of tiles.values()) if (t[1] >= (T * T) / 4) worstTile = Math.max(worstTile, t[0] / t[1]);
  const r6 = (v) => Math.round(v * 1e6) / 1e6, r2 = (v) => Math.round(v * 100) / 100;
  return { canvas: [W, H], figma: [cf.W, cf.H], pixso: [cp.W, cp.H], compared, masked: maskedN, maskedShare: W * H ? r6(maskedN / (W * H)) : 0,
    same: compared ? r6(same / compared) : 0, gross: compared ? r6(gross / compared) : 0, mean: compared ? r2(sum / compared) : 0, worstTile: r2(worstTile) };
}

export function scaleFor(rec, S) {
  const big = Math.max(1, rec.props.width, rec.props.height);
  return Math.max(0.01, Math.min(16, S.maxScale, S.maxSide / big));
}

// One pair: record j rendered in Figma (job) and Pixso (guid), compared. Returns the entry's evidence and
// ok (true, false or null), with the two PNGs for the pictures folder.
async function auditPair(j, job, ctx, crop, siblings) {
  const { ir, kids, S, figmaExport, pixsoRender } = ctx;
  const rec = ir.nodes[j];
  const s = job.constraint.value;
  const e = { guid: rec.guid, type: rec.type, scale: Math.round(s * 1e6) / 1e6, ok: false, compared: false, why: null };
  let F = null, Pv = null;
  try { F = await figmaExport(job); } catch (err) { F = { e: String((err && err.message) || err) }; }
  if (!F || F.e || typeof F.d !== "string" || !F.d) { e.why = "figma render missing: " + String((F && (F.e || F.error)) || "no picture").slice(0, 160); return { e }; }
  // A section's child is asked for by its index (children carry no stamp): the pairing holds only when
  // Figma's section has as many children as the IR's.
  if (job.child !== undefined && F.of !== siblings) { e.why = "figma render missing: the section has " + F.of + " children in Figma and " + siblings + " in the IR, so its children cannot be paired by index"; return { e, figmaPng: F.d }; }
  try { Pv = await pixsoRender(rec.guid, s); } catch (err) { Pv = { ok: false, error: String((err && err.message) || err) }; }
  const pv = Pv && Pv.ok ? Pv.value : null;
  if (!pv || pv.e || typeof pv.d !== "string" || !pv.d) { e.why = "pixso render missing: " + String((pv && pv.e) || (Pv && Pv.error) || "no picture").slice(0, 160); return { e, figmaPng: F.d }; }
  let fi, pi;
  try { fi = decodePNG(Buffer.from(F.d, "base64")); pi = decodePNG(Buffer.from(pv.d, "base64")); }
  catch (err) { e.why = "a picture does not decode: " + String(err.message).slice(0, 120); return { e, figmaPng: F.d, pixsoPng: pv.d }; }
  const lin = linearOf(rec), size = [rec.props.width, rec.props.height];
  const placeF = placeBox({ W: fi.W, H: fi.H, box: F.box, render: F.render }, s, size, lin);
  const placeP = placeBox({ W: pi.W, H: pi.H, box: pv.box, render: pv.render }, s, size, lin);
  e.figma = { id: F.relocated || job.id, w: F.w, h: F.h, picture: [fi.W, fi.H], place: placeF ? placeF.rule : null, relocated: F.relocated || null };
  e.pixso = { w: pv.w, h: pv.h, picture: [pi.W, pi.H], place: placeP ? placeP.rule : null };
  // Opacity: Pixso's picture is at the node's opacity 1, Figma's at its own.
  const op = typeof F.opacity === "number" ? F.opacity : typeof rec.props.opacity === "number" ? rec.props.opacity : 1;
  let fImg = fi, pImg = pi, rule = "none";
  if (op < 1) {
    if (S.opacity === "undo" && op >= S.undoOpacityMin) { fImg = scaleAlpha(fi, 1 / op); rule = "undone in Figma's picture"; }
    else { pImg = scaleAlpha(pi, op); rule = "applied to Pixso's picture"; }
  }
  e.opacity = { value: op, rule };
  // A SECTION: cut to its box (Figma's margin is wider), or compared as it comes.
  let cropF = null, cropP = null;
  if (crop) {
    if (!placeF || !placeP) { e.why = "the section's box cannot be placed in " + (!placeF ? "Figma's" : "Pixso's") + " picture"; return { e, figmaPng: F.d, pixsoPng: pv.d }; }
    cropF = [placeF.ox, placeF.oy, placeF.bw, placeF.bh];
    cropP = [placeP.ox, placeP.oy, placeP.bw, placeP.bh];
    e.crop = "the node's box";
  }
  // Placeholders, masked on both sides: the instances' (--placeholders mask) and the images' the build
  // could not carry (--image-placeholders mask).
  let mF = [], mP = [];
  const found = placeholderBoxes(ir, j, kids, ctx.imagePlaceholders || new Set());
  const boxes = (S.placeholders === "mask" ? found.instances : []).concat(S.imagePlaceholders === "mask" ? found.images : []);
  e.masks = { placeholders: found.instances.length, imagePlaceholders: found.images.length, masked: boxes.length, pad: boxes.length ? S.maskPad : null };
  if (boxes.length) {
    if (!placeF || !placeP) { e.ok = null; e.why = "not compared: the placeholders cannot be placed in " + (!placeF ? "Figma's" : "Pixso's") + " picture"; return { e, figmaPng: F.d, pixsoPng: pv.d }; }
    const pad = (b) => [b[0] - S.maskPad, b[1] - S.maskPad, b[2] + S.maskPad, b[3] + S.maskPad];
    mF = boxes.map((b) => toPixels(pad(b), lin, size, s, placeF));
    mP = boxes.map((b) => toPixels(pad(b), lin, size, s, placeP));
  }
  const m = comparePictures({ img: fImg, crop: cropF, masks: mF }, { img: pImg, crop: cropP, masks: mP }, S);
  e.masks.maskedShare = m.maskedShare;
  e.metrics = { compared: m.compared, same: m.same, gross: m.gross, mean: m.mean, worstTile: m.worstTile, canvas: m.canvas };
  if (!m.compared) { e.ok = null; e.why = "not compared: nothing is left once the placeholders are masked"; return { e, figmaPng: F.d, pixsoPng: pv.d }; }
  e.compared = true;
  const tolPx = S.sizeTol * s + 1;
  const why = [];
  if (Math.abs(m.figma[0] - m.pixso[0]) > tolPx || Math.abs(m.figma[1] - m.pixso[1]) > tolPx) why.push("the pictures differ in size: Figma " + m.figma.join("x") + ", Pixso " + m.pixso.join("x") + " px at scale " + e.scale);
  if (m.gross > S.grossMax) why.push("ink on one side " + (m.gross * 100).toFixed(2) + "% over " + (S.grossMax * 100).toFixed(2) + "%");
  if (m.mean > S.meanMax) why.push("mean difference " + m.mean + " over " + S.meanMax);
  if (S.tileMeanMax > 0 && m.worstTile > S.tileMeanMax) why.push("worst tile's mean " + m.worstTile + " over " + S.tileMeanMax);
  if (why.length && found.images.length && S.imagePlaceholders !== "mask") why.push("it holds " + found.images.length + " " + CODE.IMAGE_PLACEHOLDER + " paint" + (found.images.length === 1 ? "" : "s") + " (an image the run could not carry; --image-placeholders mask leaves them out)");
  e.ok = why.length === 0;
  e.why = why.length ? why.join("; ") : null;
  return { e, figmaPng: F.d, pixsoPng: pv.d };
}

// The whole audit. ctx: { states, ir, reports (the verify reports), builds (the build reports), settings,
// figmaExport(job) -> report, pixsoRender(guid,
// scale) -> { ok, value, error }, identity, previous: Map(i -> entry of an earlier pass, same resultKey),
// onRoot(entry, pictures), log }. Returns the audit object.
export async function auditRun(ctx) {
  const { states, ir, settings: S } = ctx;
  const log = ctx.log || (() => {});
  const kids = childrenIndex(ir);
  ctx = Object.assign({}, ctx, { imagePlaceholders: ctx.imagePlaceholders || imagePlaceholdersOf(ctx.builds) });
  const { roots, placeholderRoots } = auditRoots(states, ir, ctx.reports);
  const key = resultKey(states, S);
  const out = [];
  let n = 0;
  for (const r of roots) {
    n++;
    const prev = ctx.previous && ctx.previous.get(r.i);
    if (prev && prev.ok === true && prev.key === key && prev.guid === r.guid) { out.push(prev); continue; }
    const entry = { i: r.i, guid: r.guid, ok: false, compared: false, why: null, key };
    const pics = [];
    if (!r.guid) entry.why = "the run's IR has no record " + r.i;
    else if (!r.figmaId) entry.why = "figma render missing: no verify report found this root in Figma";
    else {
      const rec = ir.nodes[r.i];
      const s = scaleFor(rec, S);
      const job = (child) => Object.assign({ op: "export", id: r.figmaId, src: r.guid, snap: states.snapshot, loadAll: true,
        constraint: { type: "SCALE", value: s } }, child === undefined ? {} : { child });
      const ch = kids.get(r.i) || [];
      if (rec.type === "SECTION" && S.section === "children" && ch.length) {
        entry.type = rec.type; entry.scale = Math.round(s * 1e6) / 1e6; entry.section = "children, one by one (the section's own fill is not compared)";
        entry.children = [];
        for (let k = 0; k < ch.length; k++) {
          const c = ir.nodes[ch[k]];
          // A placeholder child is G11's, as in the section's own picture (masked there); a hidden one
          // draws nothing in it. Neither is compared.
          const skip = c.type === "INSTANCE" && S.placeholders === "mask" ? "an instance placeholder (G11 holds it)" : c.props.visible === false ? "hidden: it draws nothing in the section" : null;
          if (skip) { entry.children.push({ i: ch[k], guid: c.guid, type: c.type, ok: null, compared: false, why: "not compared: " + skip }); continue; }
          const cs = scaleFor(c, S);
          const cj = Object.assign(job(k), { constraint: { type: "SCALE", value: cs } });
          const p = await auditPair(ch[k], cj, ctx2(ctx, kids), c.type === "SECTION" && S.section !== "none", ch.length);
          entry.children.push(Object.assign({ i: ch[k] }, p.e));
          if (p.figmaPng || p.pixsoPng) pics.push({ name: r.i + "-c" + k, figma: p.figmaPng, pixso: p.pixsoPng, ok: p.e.ok });
        }
        const C = entry.children;
        entry.compared = C.some((c) => c.compared);
        const bad = C.filter((c) => c.ok === false);
        entry.ok = bad.length ? false : entry.compared ? true : null;
        entry.why = bad.length ? bad.length + " of " + C.length + " children differ or are missing: " + bad.map((c) => c.why).slice(0, 3).join(" | ")
          : entry.compared ? null : "not compared: no child left to compare";
      } else {
        const p = await auditPair(r.i, job(), ctx2(ctx, kids), rec.type === "SECTION" && S.section === "crop");
        Object.assign(entry, p.e, { i: r.i, key });
        if (rec.type === "SECTION" && S.section === "none") entry.crop = "none (--section none)";
        if (p.figmaPng || p.pixsoPng) pics.push({ name: String(r.i), figma: p.figmaPng, pixso: p.pixsoPng, ok: p.e.ok });
      }
    }
    if (entry.ok !== true && entry.ok !== null) entry.ok = false;
    out.push(entry);
    log("  [" + n + "/" + roots.length + "] root " + r.i + " " + (entry.ok === true ? "ok" : entry.ok === null ? "not compared" : "NOT OK") + (entry.why ? ": " + entry.why : ""));
    if (ctx.onRoot) await ctx.onRoot(entry, pics);
  }
  const counts = { roots: out.length, ok: out.filter((e) => e.ok === true).length, failed: out.filter((e) => e.ok === false).length,
    notCompared: out.filter((e) => e.ok === null).length, placeholderRoots: placeholderRoots.length,
    missing: out.filter((e) => e.ok === false && /render missing/.test(e.why || "")).length };
  return { format: AUDIT_FORMAT, version: AUDIT_VERSION, snapshot: states.snapshot, runId: states.runId, tool: "tools/ir-audit.mjs",
    made: new Date().toISOString(), settings: S, identity: ctx.identity || null, counts, roots: out, placeholderRoots };
}

function ctx2(ctx, kids) {
  return { ir: ctx.ir, kids, S: ctx.settings, figmaExport: ctx.figmaExport, pixsoRender: ctx.pixsoRender, imagePlaceholders: ctx.imagePlaceholders };
}

// The records each build drew an IMAGE_PLACEHOLDER on (its report's coded entries). builds: the build
// reports, a Map(taskNo -> report) or a list.
export function imagePlaceholdersOf(builds) {
  const out = new Set();
  for (const r of builds instanceof Map ? builds.values() : builds || []) {
    for (const c of (r && Array.isArray(r.coded) ? r.coded : [])) if (c && c.code === CODE.IMAGE_PLACEHOLDER && Number.isInteger(c.i)) out.add(c.i);
  }
  return out;
}
