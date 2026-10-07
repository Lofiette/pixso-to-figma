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
// missing (a missing render is a failure, never a pass); null for one that was not compared, each with
// its reason and its `class`: nothing left once its masks are applied, neither engine draws anything
// ("blank": opacity 0, hidden, an empty text), or hidden under an ancestor in the source
// ("hidden-in-source"). A root not compared covers nothing and fails nothing. A root that is an
// INSTANCE record is a placeholder frame in M1: it is not rendered, and is listed in placeholderRoots
// (G11 holds it).
//
// The rules, each from the live sessions (§15.11, §16.1, §16.2) or the old tool's lessons
// (tools/visual-all.mjs):
// - both engines render at one scale, chosen from the IR box: min(maxScale, maxSide / its longest side);
// - both engines export a node with its own opacity (§16.2: max alpha 51 = 0.2 × 255 on both sides of
//   the 3 roots at 0.2): --opacity both (default) divides both pictures' alpha by it, so a translucent
//   root is judged at full contrast like an opaque one; none compares them as exported; the first
//   pass's rules stay: undo (Figma's picture only) and apply (Pixso's alpha multiplied by it). Below
//   --undo-opacity-min both and none compare them as exported;
// - a root neither engine draws (every pixel transparent, or Pixso's export of 0 bytes) is not
//   compared (--blank not-compared); a picture blank on one side only is compared, and differs;
// - a root under an ancestor hidden in the source is not compared (--hidden-in-source skip): Pixso
//   draws nothing for it, while its build is a master the planner put on a page of its own;
// - Figma renders a SECTION with a wider margin than its box: --section crop (default) cuts each picture
//   to the node's box, children compares the section's children one by one (its own fill is then not
//   compared), none compares the pictures as they come;
// - the pictures are registered in the node's box frame (--register bounds): each engine's picture
//   starts at what it draws, and where its box sits in it comes from what the engine reports (render
//   bounds, else the box), from the other picture when both draw the same extent, or, when only the
//   extents tell them apart, by a search within their difference (--register-fit-px); a fractional
//   offset is split half and half, both pictures resampled alike. top-left lays both at their top left;
// - an instance placeholder is an empty frame in M1 and Pixso draws the instance: --placeholders mask
//   (default) leaves out of both pictures what each visible placeholder draws (--placeholder-extent
//   drawn: its box grown by its master's overflow and drop shadows; box: its box), padded by --mask-pad;
// - an image the run could not carry is a grey IMAGE_PLACEHOLDER paint in Figma (counted in the verdict)
//   and Pixso draws the image: --image-placeholders compare (default) keeps the difference, so the root
//   fails and says it holds image placeholders; mask leaves those nodes' boxes out like an instance's;
// - a text whose stored glyph outlines are not glyphs (the reader's note) is drawn from those outlines
//   by Pixso and from its characters by Figma: --glyph-notes mask (default) leaves its box out, skip
//   does not compare the root, compare compares it as any other; such a root carries its own class;
// - a 1-device-pixel CENTER horizontal LINE on a pixel boundary is one crisp row above it in Figma and
//   two half rows in Pixso: --hairlines band compares that two-row band column by column, by what each
//   column holds, when the pictures show exactly that pattern;
// - both pictures are laid over white before any pixel is compared (a transparent pixel is 0,0,0 in
//   Pixso and 255,255,255 in Figma);
// - what each picture draws (outside the masks, at an alpha of --drawn-alpha or more) whose edges are
//   further apart than --size-tol node units is a difference in itself (a wrapped line shows that way,
//   whatever the colours); --size-by picture compares the pictures' sizes instead, as the first pass did;
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
  "--size-by": ["sizeBy", ["drawn", "picture"], "drawn", true],
  "--drawn-alpha": ["drawnAlpha", int(1, 255), 16, true],
  "--register": ["register", ["bounds", "top-left"], "bounds", true],
  "--register-fit-px": ["registerFitPx", num(0, 64), 4, true],
  "--section": ["section", ["crop", "children", "none"], "crop", true],
  "--placeholders": ["placeholders", ["mask", "compare"], "mask", true],
  "--placeholder-extent": ["placeholderExtent", ["drawn", "box"], "drawn", true],
  "--mask-pad": ["maskPad", num(0, 10000), 2, true],
  "--image-placeholders": ["imagePlaceholders", ["compare", "mask"], "compare", true],
  "--glyph-notes": ["glyphNotes", ["mask", "skip", "compare"], "mask", true],
  "--hairlines": ["hairlines", ["band", "pixel"], "band", true],
  "--opacity": ["opacity", ["both", "none", "undo", "apply"], "both", true],
  "--undo-opacity-min": ["undoOpacityMin", num(0.001, 1), 0.05, true],
  "--blank": ["blank", ["not-compared", "compare"], "not-compared", true],
  "--hidden-in-source": ["hiddenInSource", ["skip", "compare"], "skip", true],
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

// The text reader's note for a text whose stored glyph outlines are not glyphs (§16.2, C06): Pixso draws
// those outlines (nothing, a slab, or no picture at all), Figma draws the characters. It is found by name,
// so the audit runs the same with a vocabulary that does not have the code yet: no root is then in that
// class. auditRun's ctx.glyphNoteCodes gives others (the offline test plants its own).
export const GLYPH_NOTE_CODES = Object.keys(CODE).filter((c) => /^TEXT_GLYPHS_INVALID$/.test(c));

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

// The nearest strict ancestor of record i that is hidden in the source, or -1.
export function hiddenAncestor(ir, i) {
  for (let p = ir.nodes[i] ? ir.nodes[i].parent : -1; p >= 0 && ir.nodes[p]; p = ir.nodes[p].parent) if (ir.nodes[p].props.visible === false) return p;
  return -1;
}

// ---------- geometry ----------
const mul = (a, b) => [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2],
  a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]];
const corners = (m, w, h) => [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]);
function bboxOf(m, w, h) {
  const c = corners(m, w, h);
  return [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
}
// The box [x0, y0, x1, y1] of the local rectangle [l, t, r, b] under m.
function rectOf(m, q) {
  const c = [[q[0], q[1]], [q[2], q[1]], [q[0], q[3]], [q[2], q[3]]].map(([x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]);
  return [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
}
const union = (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
const meet = (a, b) => { if (!a) return b; if (!b) return a; const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]; return r[2] > r[0] && r[3] > r[1] ? r : null; };

// The root's linear part: how its own frame lies in the picture (a turned or flipped root's picture is
// its turned box).
export function linearOf(rec) {
  const m = rec.props.relativeTransform;
  return [m[0], m[1], 0, m[3], m[4], 0];
}

// What an instance of master k draws beyond its box, from the IR: [left, top, right, bottom] node units,
// each at least 0, in the master's own frame. That is its visible children (a nested instance through
// its own master), cut to its box when it clips, and its drop shadows (offset ± radius + spread),
// recursively. Measured on the U audit (§16.2, C25): a field's master that does not clip holds an
// ABSOLUTE drop-down 300 px below its box, whose own master casts two 32 px shadows, so Pixso draws the
// drop-down 364 px below each field and 32 px either side; masking only the box left 95-99 % of the
// difference of the 3 roots that hold them. Taken as margins, not as the master's own boxes, so a
// resized instance is not given its master's extra size. memo: a Map kept for the run.
export function overflowOf(ir, k, kids, byGuid, memo) {
  if (memo.has(k)) return memo.get(k);
  memo.set(k, [0, 0, 0, 0]);   // a cycle draws nothing more
  const r = ir.nodes[k], W = r.props.width, H = r.props.height, own = [0, 0, W, H];
  let drawn = null;
  for (const c of kids.get(k) || []) {
    const rc = ir.nodes[c];
    if (rc.props.visible === false) continue;
    const mk = masterOf(rc, byGuid);
    const m = overflowOf(ir, mk !== null ? mk : c, kids, byGuid, memo);
    drawn = union(drawn, rectOf(rc.props.relativeTransform, [-m[0], -m[1], rc.props.width + m[2], rc.props.height + m[3]]));
  }
  let b = own;
  if (drawn) b = union(b, r.props.clipsContent ? meet(drawn, own) : drawn);
  const fx = ir.values && Number.isInteger(r.props.effects) ? ir.values[r.props.effects] : null;
  let out = b;
  for (const e of Array.isArray(fx) ? fx : []) {
    if (!e || e.visible === false || e.type !== "DROP_SHADOW") continue;
    const g = (e.radius || 0) + (e.spread || 0), ox = (e.offset && e.offset.x) || 0, oy = (e.offset && e.offset.y) || 0;
    out = union(out, [b[0] + ox - g, b[1] + oy - g, b[2] + ox + g, b[3] + oy + g]);
  }
  const res = [Math.max(0, -out[0]), Math.max(0, -out[1]), Math.max(0, out[2] - W), Math.max(0, out[3] - H)];
  memo.set(k, res);
  return res;
}
function masterOf(r, byGuid) {
  if (r.type !== "INSTANCE" || !byGuid || !r.instance || !r.instance.master) return null;
  const k = byGuid.get(r.instance.master.guid);
  return k === undefined ? null : k;
}
export function guidIndex(ir) {
  const m = new Map();
  ir.nodes.forEach((r, i) => { if (typeof r.guid === "string") m.set(r.guid, i); });
  return m;
}

// Every visible placeholder under record i, as a box in i's own frame: [x0, y0, x1, y1]. images: a Set of
// the records the build drew an IMAGE_PLACEHOLDER on; with it, { instances, images, … } (i itself
// included). opts (optional): { drawn: true, byGuid, memo } grows each instance's box by what its master
// draws (overflowOf), cut to the instance's clipping ancestors under i, and counts the ones that grew
// (overflow); { glyphs: a Set of records } adds the visible ones under i as glyphTexts.
export function placeholderBoxes(ir, i, kids, images, opts) {
  const K = kids || childrenIndex(ir);
  const o = opts || {};
  const out = [], imgs = [], glyphTexts = [];
  let overflow = 0;
  const I0 = [1, 0, 0, 0, 1, 0];
  const r0 = ir.nodes[i];
  if (images && images.has(i)) imgs.push(bboxOf(I0, r0.props.width, r0.props.height));
  if (o.glyphs && o.glyphs.has(i)) glyphTexts.push(bboxOf(I0, r0.props.width, r0.props.height));
  const walk = (j, m, clip) => {
    for (const c of K.get(j) || []) {
      const r = ir.nodes[c];
      if (r.props.visible === false) continue;
      const mc = mul(m, r.props.relativeTransform);
      const box = bboxOf(mc, r.props.width, r.props.height);
      if (r.type === "INSTANCE") {
        const mk = o.drawn ? masterOf(r, o.byGuid) : null;
        const g = mk !== null ? overflowOf(ir, mk, K, o.byGuid, o.memo || new Map()) : [0, 0, 0, 0];
        if (g.some((v) => v > 0)) {
          const grown = meet(rectOf(mc, [-g[0], -g[1], r.props.width + g[2], r.props.height + g[3]]), clip);
          out.push(grown ? union(grown, box) : box);
          overflow++;
        } else out.push(box);
        continue;
      }
      if (images && images.has(c)) imgs.push(box);
      if (o.glyphs && o.glyphs.has(c)) glyphTexts.push(box);
      walk(c, mc, r.props.clipsContent ? meet(clip, box) : clip);
    }
  };
  walk(i, I0, r0.props.clipsContent ? [0, 0, r0.props.width, r0.props.height] : null);
  return images || opts ? { instances: out, images: imgs, overflow, glyphTexts } : out;
}

// The 1-device-pixel CENTER horizontal LINEs under record i that sit on a pixel boundary, as bands in
// the box frame (pixels): [{ i, y, x0, x1 }]. Measured on the U audit (§16.2, C16): a 1 px CENTER line
// at y = 20 at the bottom of a 50x20 link is one opaque row (19) in Figma's 50x20 picture and two rows
// at alpha 128 (19 and 20) in Pixso's 50x21; the line rows carry 82-89 % of the 7 roots' differences.
export function hairlineBands(ir, i, kids, s) {
  const K = kids || childrenIndex(ir);
  const rec = ir.nodes[i], lin = linearOf(rec), q0 = bboxOf(lin, rec.props.width, rec.props.height);
  const out = [];
  const visibleStroke = (p) => { const v = ir.values && Number.isInteger(p.strokes) ? ir.values[p.strokes] : null; return Array.isArray(v) && v.some((x) => x && x.visible !== false); };
  const walk = (j, m) => {
    for (const c of K.get(j) || []) {
      const r = ir.nodes[c], p = r.props;
      if (p.visible === false || r.type === "INSTANCE") continue;
      const mc = mul(m, p.relativeTransform);
      walk(c, mc);
      if (r.type !== "LINE" || p.strokeAlign !== "CENTER" || !(Math.abs((p.strokeWeight || 0) * s - 1) <= 0.05) || !visibleStroke(p)) continue;
      // Its two ends in the box frame, in pixels.
      const ends = [[0, 0], [p.width, 0]].map(([x, y]) => { const a = [mc[0] * x + mc[1] * y + mc[2], mc[3] * x + mc[4] * y + mc[5]]; return [(lin[0] * a[0] + lin[1] * a[1] - q0[0]) * s, (lin[3] * a[0] + lin[4] * a[1] - q0[1]) * s]; });
      if (Math.abs(ends[0][1] - ends[1][1]) > 1e-6) continue;
      const y = ends[0][1];
      if (Math.abs(y - Math.round(y)) > 0.02) continue;
      out.push({ i: c, y: Math.round(y), x0: Math.min(ends[0][0], ends[1][0]), x1: Math.max(ends[0][0], ends[1][0]) });
    }
  };
  walk(i, [1, 0, 0, 0, 1, 0]);
  return out;
}

// Where the node's box sits in its picture, in pixels: { ox, oy, bw, bh, rule, exact: [x, y] } or null
// when the picture cannot hold the box. side: { W, H } of the picture, box and render ({ x, y, width,
// height } or null, as the engine reported them); size [w, h] of the node's own box in its frame and lin
// its linear part, for an engine that reports no box. exact says, per axis, that the engine's report
// places it: render bounds, or a picture the size of the box (the picture starts at what it draws).
export function placeBox(side, s, size, lin) {
  const b = side.box && side.box.width >= 0 ? side.box : null;
  const ext = b ? [b.width, b.height] : (() => { const q = bboxOf(lin, size[0], size[1]); return [q[2] - q[0], q[3] - q[1]]; })();
  const bw = ext[0] * s, bh = ext[1] * s, tol = 1.5;
  const r = side.render && side.render.width >= 0 ? side.render : null;
  if (r && b && Math.abs(side.W - r.width * s) <= tol && Math.abs(side.H - r.height * s) <= tol) return { ox: (b.x - r.x) * s, oy: (b.y - r.y) * s, bw, bh, rule: "render bounds", exact: [true, true] };
  if (Math.abs(side.W - bw) <= tol && Math.abs(side.H - bh) <= tol) return { ox: 0, oy: 0, bw, bh, rule: "box", exact: [Math.abs(side.W - bw) < 1, Math.abs(side.H - bh) < 1] };
  if (side.W >= bw - tol && side.H >= bh - tol) return { ox: Math.max(0, (side.W - bw) / 2), oy: Math.max(0, (side.H - bh) / 2), bw, bh, rule: "centred (guessed)", exact: [false, false] };
  return null;
}

// How Pixso's picture lies against Figma's on each axis: { d, rule, window } with d the offset of Pixso's
// picture from Figma's in pixels (box-frame position of Figma's picture minus Pixso's), or null with the
// window to search. pF, pP: placeBox of each side or null; wF, wP: the pictures' [W, H].
// - both placed by render bounds: their reports;
// - the same extent: none (both engines draw the same extent, the first pass's rule);
// - both placed exactly: their reports;
// - else a search over [min(0, wF - wP) - 0.5, max(0, wF - wP) + 0.5] when that difference is at most
//   --register-fit-px: the extra extent lies before, after or on both sides of what the other draws.
//   Measured on the U audit (§16.2, C20): Figma's ARROW_LINES cap reaches 7.4 px from the shaft and
//   Pixso's stored arrow 6.66, so the connectors' pictures are 15 and 14 px across the line and the shaft
//   lies 0.72-0.75 px apart in them; Pixso reported no render bounds for 31 of the 32;
// - else each side's own placement (centred when guessed).
export function registration(pF, pP, wF, wP, S) {
  return [0, 1].map((k) => {
    if (S.register === "top-left") return { d: 0, rule: "top left" };
    const o = (p) => (k ? p.oy : p.ox);
    if (pF && pP && pF.rule === "render bounds" && pP.rule === "render bounds") return { d: o(pF) - o(pP), rule: "render bounds" };
    if (wF[k] === wP[k]) return { d: 0, rule: "same extent" };
    if (pF && pP && pF.exact[k] && pP.exact[k]) return { d: o(pF) - o(pP), rule: "reported" };
    const span = wF[k] - wP[k];
    if (S.registerFitPx > 0 && Math.abs(span) <= S.registerFitPx) return { d: null, rule: "fitted", window: [Math.min(0, span) - 0.5, Math.max(0, span) + 0.5] };
    if (pF && pP) return { d: o(pF) - o(pP), rule: "placed (" + pF.rule + ", " + pP.rule + ")" };
    return { d: 0, rule: "top left (the box is not placed)" };
  });
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
const maxAlpha = (img) => { let m = 0; for (let k = 3; k < img.rgba.length; k += 4) if (img.rgba[k] > m) m = img.rgba[k]; return m; };
// A picture that draws nothing: no pixel, or every pixel transparent.
export const isBlank = (img) => !img || !img.W || !img.H || maxAlpha(img) === 0;
const EMPTY = { W: 0, H: 0, rgba: Buffer.alloc(0) };

// One side of a comparison: its cut of the picture (a crop, or all of it), the cut laid over white, and
// where the cut sits on the canvas (at: [x, y], the node's box frame when registered).
function sideOf(side) {
  const img = side.img;
  const c = side.crop ? side.crop.map((v) => Math.max(0, Math.round(v))) : [0, 0, img.W, img.H];
  const x0 = Math.min(c[0], img.W), y0 = Math.min(c[1], img.H);
  const W = Math.max(0, Math.min(img.W - x0, c[2])), H = Math.max(0, Math.min(img.H - y0, c[3]));
  const rgb = new Float64Array(W * H * 3), al = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = ((y + y0) * img.W + (x + x0)) * 4, a = img.rgba[k + 3] / 255, o = y * W + x;
      for (let q = 0; q < 3; q++) rgb[o * 3 + q] = img.rgba[k + q] * a + 255 * (1 - a);
      al[o] = a;
    }
  }
  const sd = { x0, y0, W, H, rgb, al, at: side.at || [0, 0] };
  sd.bits = maskBits(sd, side.masks);
  return sd;
}
// The masks ([x0, y0, x1, y1] in the side's own pixels) as a bitmap over its cut: a pixel is masked when
// its centre is inside a mask.
function maskBits(sd, masks) {
  const { x0, y0, W, H } = sd;
  const bits = new Uint8Array(W * H);
  for (const m of masks || []) {
    const p0 = Math.max(0, Math.ceil(m[0] - x0 - 0.5)), p1 = Math.min(W, Math.ceil(m[2] - x0 - 0.5));
    const q0 = Math.max(0, Math.ceil(m[1] - y0 - 0.5)), q1 = Math.min(H, Math.ceil(m[3] - y0 - 0.5));
    for (let y = q0; y < q1; y++) bits.fill(1, y * W + p0, Math.max(y * W + p0, y * W + p1));
  }
  return bits;
}

const EPS = 1e-6;
// Compare two sides on one canvas. Their offset (P.at - F.at) keeps its whole part exactly; its fraction
// is split half and half, each side resampled (bilinear) by its half, so both are blurred alike: a
// one-sided shift left the U audit's connectors at mean 6.7-12.5, a symmetric one at 0.56-4.59 (§16.2).
// The canvas holds both (a pixel outside a side is that side's white); a pixel any contributing pixel of
// which is masked on either side is left out. bands: hairlineBands, compared column by column where the
// pictures show the hairline pattern (one crisp row above the boundary in Figma, two half rows in Pixso).
function compareSides(cf, cp, S, bands) {
  const has = (sd) => sd.W > 0 && sd.H > 0;
  const D = [cp.at[0] - cf.at[0], cp.at[1] - cf.at[1]];
  const fr = D.map((v) => v - Math.round(v));
  const g = [0, 0], N = [0, 0];
  for (let k = 0; k < 2; k++) {
    const len = (sd) => (k ? sd.H : sd.W);
    const lo = Math.min(has(cf) ? cf.at[k] : Infinity, has(cp) ? cp.at[k] : Infinity);
    const hi = Math.max(has(cf) ? cf.at[k] + len(cf) : -Infinity, has(cp) ? cp.at[k] + len(cp) : -Infinity);
    const phase = cf.at[k] + fr[k] / 2;
    g[k] = lo === Infinity ? phase : phase + Math.floor(lo - phase + EPS);
    N[k] = lo === Infinity ? 0 : Math.max(0, Math.ceil(hi - g[k] - EPS));
  }
  const [W, H] = N;
  // Per side, per canvas column and row: the own pixel it starts at and the weight of the next one.
  const axes = (sd) => [0, 1].map((k) => {
    const n = N[k], idx = new Int32Array(n), wt = new Float64Array(n);
    for (let x = 0; x < n; x++) {
      const u = g[k] + x - sd.at[k], i0 = Math.floor(u + EPS), a = u - i0;
      idx[x] = i0; wt[x] = a < EPS ? 0 : a;
    }
    return { idx, wt };
  });
  const AF = axes(cf), AP = axes(cp);
  // The colour over white, the alpha, and whether it is masked, of side sd at canvas (x, y).
  const sample = (sd, A, x, y, out) => {
    const i0 = A[0].idx[x], a = A[0].wt[x], j0 = A[1].idx[y], b = A[1].wt[y];
    out[0] = out[1] = out[2] = out[3] = 0; out[4] = 0;
    for (let dj = 0; dj < 2; dj++) {
      const wy = dj ? b : 1 - b;
      if (wy <= 0) continue;
      for (let di = 0; di < 2; di++) {
        const w = (di ? a : 1 - a) * wy;
        if (w <= 0) continue;
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= sd.W || j >= sd.H) { out[0] += 255 * w; out[1] += 255 * w; out[2] += 255 * w; continue; }
        const o = j * sd.W + i;
        out[0] += sd.rgb[o * 3] * w; out[1] += sd.rgb[o * 3 + 1] * w; out[2] += sd.rgb[o * 3 + 2] * w; out[3] += sd.al[o] * w;
        if (sd.bits[o]) out[4] = 1;
      }
    }
  };
  // The hairline bands: a column's difference is what its two rows hold together, counted once, in the
  // first row; the second row counts 0. Only where Figma's line is one crisp row above the boundary and
  // Pixso's two half rows; anything else (a dash, a colour, a thickness, a line a whole row away)
  // still differs.
  const over = bands && bands.length ? new Float64Array(W * H).fill(-1) : null;
  const fa = [0, 0, 0, 0, 0], pa = [0, 0, 0, 0, 0], fb = [0, 0, 0, 0, 0], pb = [0, 0, 0, 0, 0];
  let bandsUsed = 0;
  for (const bd of bands || []) {
    const r = bd.y - g[1];
    if (Math.abs(r - Math.round(r)) > 0.02) continue;
    const r1 = Math.round(r);
    if (r1 < 1 || r1 >= H) continue;
    const cols = [];
    let inked = 0, crisp = 0, split = 0;
    for (let x = 0; x < W; x++) {
      const cx = g[0] + x + 0.5;
      if (cx < bd.x0 || cx >= bd.x1) continue;
      sample(cf, AF, x, r1 - 1, fa); sample(cf, AF, x, r1, fb); sample(cp, AP, x, r1 - 1, pa); sample(cp, AP, x, r1, pb);
      if (fa[4] || fb[4] || pa[4] || pb[4]) continue;
      const ink = (v) => Math.max(255 - v[0], 255 - v[1], 255 - v[2]);
      const f0 = ink(fa), f1 = ink(fb), p0 = ink(pa), p1 = ink(pb);
      if (f0 + f1 >= 32 && p0 + p1 >= 32) {
        inked++;
        if (f0 >= 0.85 * (f0 + f1)) crisp++;
        const share = p0 / (p0 + p1);
        if (share >= 0.25 && share <= 0.75) split++;
      }
      let d = 0;
      for (let q = 0; q < 3; q++) d = Math.max(d, Math.abs((510 - fa[q] - fb[q]) - (510 - pa[q] - pb[q])));
      cols.push([x, d]);
    }
    if (!inked || crisp < 0.8 * inked || split < 0.8 * inked) continue;
    for (const [x, d] of cols) { over[(r1 - 1) * W + x] = d; over[r1 * W + x] = 0; }
    bandsUsed++;
  }
  const T = S.tile;
  const tiles = new Map();
  let compared = 0, maskedN = 0, same = 0, gross = 0, sum = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      sample(cf, AF, x, y, fa); sample(cp, AP, x, y, pa);
      if (fa[4] || pa[4]) { maskedN++; continue; }
      let d = over ? over[y * W + x] : -1;
      if (d < 0) { d = 0; for (let q = 0; q < 3; q++) { const dc = Math.abs(fa[q] - pa[q]); if (dc > d) d = dc; } }
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
    same: compared ? r6(same / compared) : 0, gross: compared ? r6(gross / compared) : 0, mean: compared ? r2(sum / compared) : 0, worstTile: r2(worstTile),
    drawn: { figma: drawnOf(cf, S.drawnAlpha), pixso: drawnOf(cp, S.drawnAlpha) }, offset: [r2(D[0]), r2(D[1])], bands: bandsUsed };
}

// What a side draws outside its masks: the box of its pixels with an alpha of at least minAlpha (of 255),
// in the frame its `at` is given in, from its own pixels (not the resampled ones, which a fractional
// offset spreads by a pixel), or null when it draws nothing there. The faintest fringe is left out: of
// the 28 595 pixels at alpha 1-15 in Figma's half of the 435 same-size pairs the U audit kept, 2 419 are
// transparent in Pixso's (its indexed PNGs), and an edge should not move on that.
function drawnOf(sd, minAlpha) {
  const lo = (minAlpha || 1) / 255;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < sd.H; y++) {
    for (let x = 0; x < sd.W; x++) {
      const o = y * sd.W + x;
      if (sd.al[o] < lo || sd.bits[o]) continue;
      if (x < x0) x0 = x; if (x + 1 > x1) x1 = x + 1; if (y < y0) y0 = y; if (y + 1 > y1) y1 = y + 1;
    }
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  return x0 === Infinity ? null : [r2(sd.at[0] + x0), r2(sd.at[1] + y0), r2(sd.at[0] + x1), r2(sd.at[1] + y1)];
}

// Compare two pictures. Each side: { img: { W, H, rgba }, crop: [x, y, w, h] | null, masks: [[x0, y0, x1,
// y1] in its own pixels], at: [x, y] where its cut sits on the canvas (both [0, 0], the default: aligned
// at their top left) }. Both are laid over white and compared over the canvas that holds both (a pixel
// outside one picture is that picture's white); a pixel inside a mask on either side is left out.
// opts: { bands } (hairlineBands, in the frame `at` is given in).
export function comparePictures(F, P, S, opts) {
  return compareSides(sideOf(F), sideOf(P), S, opts && opts.bands);
}

export function scaleFor(rec, S) {
  const big = Math.max(1, rec.props.width, rec.props.height);
  return Math.max(0.01, Math.min(16, S.maxScale, S.maxSide / big));
}

// The offset (per axis) that compares best, where registration left it to a search: a grid of 0.25 px
// over the window, then 0.05 px around the best. evalAt([dx, dy]) -> the mean difference.
function fitOffset(reg, evalAt) {
  const steps = (lo, hi, st) => { const out = []; for (let v = lo; v <= hi + EPS; v += st) out.push(Math.round(v * 1000) / 1000); return out; };
  let best = null, tried = 0;
  const run = (xs, ys) => {
    for (const dx of xs) for (const dy of ys) {
      const m = evalAt([dx, dy]);
      tried++;
      if (!best || m < best.mean - 1e-9) best = { d: [dx, dy], mean: m };
    }
  };
  const coarse = (k) => (reg[k].d === null ? steps(reg[k].window[0], reg[k].window[1], 0.25) : [reg[k].d]);
  run(coarse(0), coarse(1));
  const fine = (k) => (reg[k].d === null ? steps(Math.max(reg[k].window[0], best.d[k] - 0.2), Math.min(reg[k].window[1], best.d[k] + 0.2), 0.05) : [best.d[k]]);
  run(fine(0), fine(1));
  return { d: best.d, mean: best.mean, tried };
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
  // Pixso's export of a node that draws nothing is 0 bytes (n 0), where Figma's is a transparent 1x1
  // (the U audit, §16.2: the 2 hidden and the 2 empty texts among its roots, and nothing else): an
  // answer, not a missing render.
  const emptyP = S.blank === "not-compared" && !!pv && !pv.e && pv.n === 0 && !pv.d;
  if (!pv || pv.e || (!emptyP && (typeof pv.d !== "string" || !pv.d))) { e.why = "pixso render missing: " + String((pv && pv.e) || (Pv && Pv.error) || "no picture").slice(0, 160); return { e, figmaPng: F.d }; }
  let fi, pi;
  try { fi = decodePNG(Buffer.from(F.d, "base64")); pi = emptyP ? EMPTY : decodePNG(Buffer.from(pv.d, "base64")); }
  catch (err) { e.why = "a picture does not decode: " + String(err.message).slice(0, 120); return { e, figmaPng: F.d, pixsoPng: pv.d }; }
  const pngs = { figmaPng: F.d, pixsoPng: emptyP ? undefined : pv.d };
  const r3 = (b) => (b && typeof b.x === "number" ? { x: Math.round(b.x * 1000) / 1000, y: Math.round(b.y * 1000) / 1000, width: Math.round(b.width * 1000) / 1000, height: Math.round(b.height * 1000) / 1000 } : null);
  const lin = linearOf(rec), size = [rec.props.width, rec.props.height];
  const placeF = placeBox({ W: fi.W, H: fi.H, box: F.box, render: F.render }, s, size, lin);
  const placeP = placeBox({ W: pi.W, H: pi.H, box: pv.box, render: pv.render }, s, size, lin);
  e.figma = { id: F.relocated || job.id, w: F.w, h: F.h, picture: [fi.W, fi.H], place: placeF ? placeF.rule : null, relocated: F.relocated || null, box: r3(F.box), render: r3(F.render) };
  e.pixso = { w: pv.w, h: pv.h, picture: [pi.W, pi.H], place: placeP ? placeP.rule : null, box: r3(pv.box), render: r3(pv.render), bytes: typeof pv.n === "number" ? pv.n : null };
  // What the root holds that is not compared (instances, images, texts whose stored glyphs are not
  // glyphs), found before anything is judged: each class is named whatever the outcome.
  const found = placeholderBoxes(ir, j, kids, ctx.imagePlaceholders || new Set(),
    { drawn: S.placeholderExtent === "drawn", byGuid: ctx.byGuid, memo: ctx.overflowMemo, glyphs: ctx.glyphTexts });
  if (found.glyphTexts.length) e.glyphTexts = found.glyphTexts.length;
  const glyphWhy = () => "it holds " + found.glyphTexts.length + " text" + (found.glyphTexts.length === 1 ? "" : "s") + " whose stored glyph outlines are not glyphs (Pixso draws those outlines, Figma the characters)";
  // Neither engine draws anything: opacity 0, hidden, an empty text (the U audit: 12, 2 and 2 roots).
  if (S.blank === "not-compared" && isBlank(fi) && isBlank(pi)) {
    const op0 = typeof F.opacity === "number" ? F.opacity : rec.props.opacity;
    const cause = rec.props.visible === false ? "it is hidden" : op0 === 0 ? "its opacity is 0" : rec.type === "TEXT" && rec.props.characters === "" ? "an empty text" : "every pixel of both pictures is transparent";
    e.ok = null; e.class = "blank";
    e.why = "not compared: neither engine draws anything (" + cause + "; Figma's picture " + fi.W + "x" + fi.H + (emptyP ? ", Pixso's export 0 bytes" : ", Pixso's " + pi.W + "x" + pi.H) + ")";
    return Object.assign({ e }, pngs);
  }
  if (found.glyphTexts.length && S.glyphNotes === "skip") { e.ok = null; e.class = "source-glyphs"; e.why = "not compared: " + glyphWhy(); return Object.assign({ e }, pngs); }
  // Opacity: both engines export the node with its own (§16.2).
  const op = typeof F.opacity === "number" ? F.opacity : typeof rec.props.opacity === "number" ? rec.props.opacity : 1;
  let fImg = fi, pImg = pi, rule = "none";
  if (op < 1) {
    const big = op >= S.undoOpacityMin;
    if (S.opacity === "both" && big) { fImg = scaleAlpha(fi, 1 / op); pImg = scaleAlpha(pi, 1 / op); rule = "undone in both pictures"; }
    else if (S.opacity === "undo" && big) { fImg = scaleAlpha(fi, 1 / op); rule = "undone in Figma's picture"; }
    else if (S.opacity === "apply" || S.opacity === "undo") { pImg = scaleAlpha(pi, op); rule = "applied to Pixso's picture"; }
    else rule = "compared as exported";
  }
  e.opacity = { value: op, rule };
  // What each export holds against the opacity: reported, not used to pick the rule (a translucent paint
  // lowers the most opaque pixel without any opacity).
  if (op < 1) e.opacity.maxAlpha = { figma: maxAlpha(fi), pixso: maxAlpha(pi), atOpacity: Math.round(255 * op) };
  // Where the pictures lie against each other (registration) and where the box is in each.
  const wF = [fi.W, fi.H], wP = [pi.W, pi.H];
  let cropF = null, cropP = null;
  if (crop) {
    if (!placeF || !placeP) { e.why = "the section's box cannot be placed in " + (!placeF ? "Figma's" : "Pixso's") + " picture"; return Object.assign({ e }, pngs); }
    cropF = [placeF.ox, placeF.oy, placeF.bw, placeF.bh];
    cropP = [placeP.ox, placeP.oy, placeP.bw, placeP.bh];
    e.crop = "the node's box";
  }
  // A cut section is registered by its two placements; anything else by registration().
  const reg = crop ? [0, 1].map((k) => ({ d: S.register === "top-left" ? 0 : (k ? placeF.oy - placeP.oy : placeF.ox - placeP.ox), rule: S.register === "top-left" ? "top left" : "the node's box" }))
    : registration(placeF, placeP, wF, wP, S);
  // The box in each picture, from the side that places it: Pixso's is Figma's moved by the offset.
  const boxAt = (d) => {
    if (placeF) return { F: [placeF.ox, placeF.oy], P: [placeF.ox - d[0], placeF.oy - d[1]] };
    if (placeP) return { F: [placeP.ox + d[0], placeP.oy + d[1]], P: [placeP.ox, placeP.oy] };
    return null;
  };
  // Placeholders, masked on both sides: the instances' (--placeholders mask), the images' the build
  // could not carry (--image-placeholders mask) and the texts drawn from outlines that are not glyphs
  // (--glyph-notes mask).
  const boxes = (S.placeholders === "mask" ? found.instances : []).concat(S.imagePlaceholders === "mask" ? found.images : [])
    .concat(S.glyphNotes === "mask" ? found.glyphTexts : []);
  e.masks = { placeholders: found.instances.length, overflow: found.overflow, imagePlaceholders: found.images.length, masked: boxes.length, pad: boxes.length ? S.maskPad : null };
  if (found.glyphTexts.length) e.masks.glyphTexts = found.glyphTexts.length;
  if (boxes.length && !placeF && !placeP) { e.ok = null; e.class = "unplaced"; e.why = "not compared: the placeholders cannot be placed in either picture"; return Object.assign({ e }, pngs); }
  const pad = (b) => [b[0] - S.maskPad, b[1] - S.maskPad, b[2] + S.maskPad, b[3] + S.maskPad];
  const frameMasks = boxes.map((b) => toPixels(pad(b), lin, size, s, { ox: 0, oy: 0 }));
  const shift = (ms, o) => ms.map((m) => [m[0] + o[0], m[1] + o[1], m[2] + o[0], m[3] + o[1]]);
  const bands = S.hairlines === "band" && (placeF || placeP) ? hairlineBands(ir, j, kids, s) : [];
  // The two sides at an offset d: each cut at the box frame's position of its first pixel. Under
  // --register top-left each cut sits at 0, as in the first pass, and its masks by its own placement.
  const sides = (d) => {
    const at = boxAt(d);
    const sf = { img: fImg, crop: cropF, masks: [] }, sp = { img: pImg, crop: cropP, masks: [] };
    if (S.register === "top-left") {
      if (boxes.length) {
        if (!placeF || !placeP) return null;
        sf.masks = shift(frameMasks, [placeF.ox, placeF.oy]); sp.masks = shift(frameMasks, [placeP.ox, placeP.oy]);
      }
      return { sf, sp, framed: false };
    }
    const o = at || { F: [0, 0], P: [-d[0], -d[1]] };
    const cut = (c) => (c ? [Math.max(0, Math.round(c[0])), Math.max(0, Math.round(c[1]))] : [0, 0]);
    const cF = cut(cropF), cP = cut(cropP);
    sf.at = [cF[0] - o.F[0], cF[1] - o.F[1]]; sp.at = [cP[0] - o.P[0], cP[1] - o.P[1]];
    if (boxes.length) { sf.masks = shift(frameMasks, o.F); sp.masks = shift(frameMasks, o.P); }
    return { sf, sp, framed: !!at };
  };
  const d0 = reg.map((r) => (r.d === null ? 0 : r.d));
  if (!sides(d0)) { e.ok = null; e.class = "unplaced"; e.why = "not compared: the placeholders cannot be placed in " + (!placeF ? "Figma's" : "Pixso's") + " picture"; return Object.assign({ e }, pngs); }
  let d = d0, fitted = null;
  if (reg.some((r) => r.d === null)) {
    // The search: Figma's side is laid out once; Pixso's moves (its masks with it).
    const base = sides(d0), cf = sideOf(base.sf), cp = sideOf(base.sp);
    fitted = fitOffset(reg, (dd) => {
      const x = sides(dd);
      cf.at = x.sf.at; cf.bits = maskBits(cf, x.sf.masks); cp.at = x.sp.at; cp.bits = maskBits(cp, x.sp.masks);
      const m = compareSides(cf, cp, S, x.framed ? bands : []);
      return m.compared ? m.mean : Infinity;
    });
    d = fitted.d;
  }
  const lay = sides(d);
  const m = compareSides(sideOf(lay.sf), sideOf(lay.sp), S, lay.framed ? bands : []);
  e.register = { rule: reg.map((r) => r.rule), offset: [Math.round(d[0] * 100) / 100, Math.round(d[1] * 100) / 100] };
  if (fitted) { e.register.window = reg.map((r) => r.window || null); e.register.tried = fitted.tried; }
  e.masks.maskedShare = m.maskedShare;
  if (bands.length) e.hairlines = { found: bands.length, compared: m.bands };
  e.metrics = { compared: m.compared, same: m.same, gross: m.gross, mean: m.mean, worstTile: m.worstTile, canvas: m.canvas, drawn: m.drawn };
  if (!m.compared) { e.ok = null; e.class = "masked"; e.why = "not compared: nothing is left once the placeholders are masked"; return Object.assign({ e }, pngs); }
  e.compared = true;
  const tolPx = S.sizeTol * s + 1;
  const why = [];
  if (emptyP) why.push("Pixso draws nothing (its export is 0 bytes) and Figma draws " + fi.W + "x" + fi.H + " px");
  if (S.sizeBy === "picture") {
    if (Math.abs(m.figma[0] - m.pixso[0]) > tolPx || Math.abs(m.figma[1] - m.pixso[1]) > tolPx) why.push("the pictures differ in size: Figma " + m.figma.join("x") + ", Pixso " + m.pixso.join("x") + " px at scale " + e.scale);
  } else {
    // What each draws outside the masks, edge by edge in the registered frame: overflow a mask covers
    // (an instance's) is not a difference, and an edge further than the tolerance is.
    const a = m.drawn.figma, b = m.drawn.pixso;
    const span = (q) => Math.round(q[2] - q[0]) + "x" + Math.round(q[3] - q[1]);
    if (a && b) {
      const apart = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(a[k] - b[k])));
      if (apart > tolPx) why.push("the pictures differ in size: what Figma draws spans " + span(a) + ", Pixso's " + span(b) + " px (edges up to " + Math.round(apart * 100) / 100 + " px apart) at scale " + e.scale);
    } else if (a || b) why.push("the pictures differ in size: " + (a ? "Figma" : "Pixso") + " draws " + span(a || b) + " px outside the masks, " + (a ? "Pixso" : "Figma") + " nothing, at scale " + e.scale);
  }
  if (m.gross > S.grossMax) why.push("ink on one side " + (m.gross * 100).toFixed(2) + "% over " + (S.grossMax * 100).toFixed(2) + "%");
  if (m.mean > S.meanMax) why.push("mean difference " + m.mean + " over " + S.meanMax);
  if (S.tileMeanMax > 0 && m.worstTile > S.tileMeanMax) why.push("worst tile's mean " + m.worstTile + " over " + S.tileMeanMax);
  if (why.length && found.images.length && S.imagePlaceholders !== "mask") why.push("it holds " + found.images.length + " " + CODE.IMAGE_PLACEHOLDER + " paint" + (found.images.length === 1 ? "" : "s") + " (an image the run could not carry; --image-placeholders mask leaves them out)");
  if (why.length && found.glyphTexts.length) { why.push(glyphWhy()); e.class = "source-glyphs"; }
  e.ok = why.length === 0;
  e.why = why.length ? why.join("; ") : null;
  return Object.assign({ e }, pngs);
}

// The whole audit. ctx: { states, ir, reports (the verify reports), builds (the build reports), settings,
// figmaExport(job) -> report, pixsoRender(guid,
// scale) -> { ok, value, error }, identity, previous: Map(i -> entry of an earlier pass, same resultKey),
// onRoot(entry, pictures), log, glyphNoteCodes (default GLYPH_NOTE_CODES) }. Returns the audit object.
export async function auditRun(ctx) {
  const { states, ir, settings: S } = ctx;
  const log = ctx.log || (() => {});
  const kids = childrenIndex(ir);
  const byGuid = guidIndex(ir);
  ctx = Object.assign({}, ctx, { imagePlaceholders: ctx.imagePlaceholders || imagePlaceholdersOf(ctx.builds), byGuid, overflowMemo: new Map(),
    glyphTexts: notedRecords(ir, ctx.glyphNoteCodes || GLYPH_NOTE_CODES, byGuid) });
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
    const hidden = r.guid && S.hiddenInSource === "skip" ? hiddenAncestor(ir, r.i) : -1;
    if (!r.guid) entry.why = "the run's IR has no record " + r.i;
    else if (hidden >= 0) {
      // Pixso draws nothing under a hidden ancestor (the U audit: the 8 masters of a hidden component
      // set, all blank in Pixso), while the planner built them as masters on a page of their own.
      entry.type = ir.nodes[r.i].type; entry.ok = null; entry.class = "hidden-in-source"; entry.hiddenBy = { i: hidden, guid: ir.nodes[hidden].guid };
      entry.why = "not compared: hidden in the source (its ancestor, record " + hidden + ", is hidden), so Pixso draws nothing for it";
    } else if (!r.figmaId) entry.why = "figma render missing: no verify report found this root in Figma";
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
  const cls = (c) => out.filter((e) => e.class === c).length;
  const counts = { roots: out.length, ok: out.filter((e) => e.ok === true).length, failed: out.filter((e) => e.ok === false).length,
    notCompared: out.filter((e) => e.ok === null).length, blank: cls("blank"), hiddenInSource: cls("hidden-in-source"),
    sourceGlyphs: cls("source-glyphs"), placeholderRoots: placeholderRoots.length,
    missing: out.filter((e) => e.ok === false && /render missing/.test(e.why || "")).length };
  return { format: AUDIT_FORMAT, version: AUDIT_VERSION, snapshot: states.snapshot, runId: states.runId, tool: "tools/ir-audit.mjs",
    made: new Date().toISOString(), settings: S, identity: ctx.identity || null, counts, roots: out, placeholderRoots };
}

function ctx2(ctx, kids) {
  return { ir: ctx.ir, kids, S: ctx.settings, figmaExport: ctx.figmaExport, pixsoRender: ctx.pixsoRender, imagePlaceholders: ctx.imagePlaceholders,
    byGuid: ctx.byGuid, overflowMemo: ctx.overflowMemo, glyphTexts: ctx.glyphTexts };
}

// The records the IR's notes with one of these codes name (a note names its record by index, node, or
// by guid).
export function notedRecords(ir, codes, byGuid) {
  const out = new Set();
  if (!codes || !codes.length) return out;
  for (const n of Array.isArray(ir.notes) ? ir.notes : []) {
    if (!n || codes.indexOf(n.code) < 0) continue;
    if (Number.isInteger(n.node) && ir.nodes[n.node]) out.add(n.node);
    else if (typeof n.guid === "string" && byGuid && byGuid.has(n.guid)) out.add(byGuid.get(n.guid));
  }
  return out;
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
