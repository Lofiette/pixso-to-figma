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
//   compared (--blank not-compared); a picture blank on one side only is compared, and differs (also
//   where the placeholders cannot be placed in the other);
// - a root under an ancestor hidden in the source is not compared (--hidden-in-source skip): Pixso
//   draws nothing for it, while its build is a master the planner put on a page of its own;
// - Figma renders a SECTION with a wider margin than its box: --section crop (default) cuts each picture
//   to the node's box, children compares the section's children one by one (its own fill is then not
//   compared), none compares the pictures as they come;
// - the pictures are registered in the node's box frame (--register bounds): each engine's picture
//   starts at what it draws, and where its box sits in it comes from what the engine reports (render
//   bounds, else the box), from the other picture when both draw the same extent, or, when only the
//   extents tell them apart, by a search within their difference (--register-fit-px). The search runs on
//   both engines' pictures at k times the scale, box-averaged back at each phase of 1/k px
//   (--register-supersample, up to --supersample-max-side), else on the pictures as exported, a fractional
//   offset split half and half, both pictures resampled alike. top-left lays both at their top left;
// - an instance placeholder is an empty frame in M1 and Pixso draws the instance: --placeholders mask
//   (default) leaves out of both pictures what each visible placeholder draws (--placeholder-extent
//   drawn: its box grown by its master's overflow and drop shadows; box: its box), padded by --mask-pad;
// - an image the run could not carry is a grey IMAGE_PLACEHOLDER paint in Figma (counted in the verdict)
//   and Pixso draws the image: --image-placeholders compare (default) keeps the difference, so the root
//   fails and says it holds image placeholders; mask leaves those nodes' boxes out like an instance's;
// - a text whose stored glyph outlines are not glyphs (the reader's note) is drawn from those outlines
//   by Pixso and from its characters by Figma: --glyph-notes mask (default) leaves its box out, skip
//   does not compare the root, compare compares it as any other. A failing root is in their class when
//   more than --glyph-share-min of its difference lies within --glyph-near node units of their boxes
//   (--glyph-class near; any: whenever it holds one);
// - a 1-device-pixel CENTER horizontal LINE on a pixel boundary is one crisp row above it in Figma and
//   two half rows in Pixso: --hairlines band compares that two-row band column by column, by what each
//   column holds, when the pictures show exactly that pattern;
// - both pictures are laid over white before any pixel is compared (a transparent pixel is 0,0,0 in
//   Pixso and 255,255,255 in Figma);
// - what each picture draws (outside the masks, at an alpha of --drawn-alpha or more) whose edges are
//   further apart than --size-tol node units is a difference in itself (a wrapped line shows that way,
//   whatever the colours); --size-by picture compares the pictures' sizes instead, as the first pass did.
//   --drawn-by alpha (default) counts every such pixel; visible leaves out a pixel that is white (every
//   channel within --drawn-white-tol of 255, over white) where the other picture, registered, is white
//   too, so white on white and a faint edge are drawn by neither while a visible difference counts on
//   both sides; ink leaves out every white pixel (§16.5);
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
  "--drawn-by": ["drawnBy", ["alpha", "visible", "ink"], "alpha", true],
  "--drawn-white-tol": ["drawnWhiteTol", int(0, 254), 16, true],
  "--register": ["register", ["bounds", "top-left"], "bounds", true],
  "--register-fit-px": ["registerFitPx", num(0, 64), 4, true],
  "--register-supersample": ["registerSupersample", int(1, 8), 4, true],
  "--supersample-max-side": ["supersampleMaxSide", int(16, 16384), 1600, true],
  "--section": ["section", ["crop", "children", "none"], "crop", true],
  "--placeholders": ["placeholders", ["mask", "compare"], "mask", true],
  "--placeholder-extent": ["placeholderExtent", ["drawn", "box"], "drawn", true],
  "--mask-pad": ["maskPad", num(0, 10000), 2, true],
  "--image-placeholders": ["imagePlaceholders", ["compare", "mask"], "compare", true],
  "--glyph-notes": ["glyphNotes", ["mask", "skip", "compare"], "mask", true],
  "--glyph-class": ["glyphClass", ["near", "any"], "near", true],
  "--glyph-near": ["glyphNear", num(0, 100000), 256, true],
  "--glyph-share-min": ["glyphShareMin", num(0, 1), 0.5, true],
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
// A clip with nothing left in it (a clipping frame wholly outside its clipping ancestor): everything
// under it is clipped away. meet() reads null as "no clip", so an empty clip is this value instead.
const CLIPPED = Object.freeze([0, 0, 0, 0]);
const clipTo = (clip, box) => (clip === CLIPPED ? CLIPPED : meet(clip, box) || CLIPPED);

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
// resized instance is not given its master's extra size; a scaled instance (IR v3's instance.scale, the
// uniform scale factor) draws its master's margins at its scale (marginsOf). memo: a Map kept for the run.
export function overflowOf(ir, k, kids, byGuid, memo) {
  if (memo.has(k)) return memo.get(k);
  memo.set(k, [0, 0, 0, 0]);   // a cycle draws nothing more
  const r = ir.nodes[k], W = r.props.width, H = r.props.height, own = [0, 0, W, H];
  let drawn = null;
  for (const c of kids.get(k) || []) {
    const rc = ir.nodes[c];
    if (rc.props.visible === false) continue;
    const m = marginsOf(ir, c, kids, byGuid, memo);
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
// What record c draws beyond its own box, in its own units: an instance its master's overflow at the
// instance's scale (on the U file's IR v3: 29 visible scaled instances, at 0.74-3.56, have a master
// that overflows), anything else its own.
function marginsOf(ir, c, kids, byGuid, memo) {
  const rc = ir.nodes[c], mk = masterOf(rc, byGuid);
  if (mk === null) return overflowOf(ir, c, kids, byGuid, memo);
  const m = overflowOf(ir, mk, kids, byGuid, memo), f = rc.instance && typeof rc.instance.scale === "number" && rc.instance.scale > 0 ? rc.instance.scale : 1;
  return f === 1 ? m : m.map((v) => v * f);
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
// (overflow) and the ones those ancestors clip away whole (clipped: no mask); { glyphs: a Set of
// records } adds the visible ones under i as glyphTexts.
export function placeholderBoxes(ir, i, kids, images, opts) {
  const K = kids || childrenIndex(ir);
  const o = opts || {};
  const out = [], imgs = [], glyphTexts = [];
  let overflow = 0, clipped = 0;
  const I0 = [1, 0, 0, 0, 1, 0];
  const r0 = ir.nodes[i];
  if (images && images.has(i)) imgs.push(bboxOf(I0, r0.props.width, r0.props.height));
  if (o.glyphs && o.glyphs.has(i)) glyphTexts.push(bboxOf(I0, r0.props.width, r0.props.height));
  const walk = (j, m, clip) => {
    for (const c of K.get(j) || []) {
      const r = ir.nodes[c];
      if (r.props.visible === false) continue;
      // Under an empty clip nothing draws: no mask (drawn only; box keeps the first pass's masks).
      if (o.drawn && clip === CLIPPED) { if (r.type === "INSTANCE") clipped++; else walk(c, null, CLIPPED); continue; }
      const mc = mul(m, r.props.relativeTransform);
      const box = bboxOf(mc, r.props.width, r.props.height);
      if (r.type === "INSTANCE") {
        if (!o.drawn) { out.push(box); continue; }
        const g = masterOf(r, o.byGuid) !== null ? marginsOf(ir, c, K, o.byGuid, o.memo || new Map()) : [0, 0, 0, 0];
        const grown = g.some((v) => v > 0);
        // What it can draw, cut to its clipping ancestors; an instance they clip away whole draws
        // nothing, and a mask there would hide what others draw.
        const seen = meet(grown ? rectOf(mc, [-g[0], -g[1], r.props.width + g[2], r.props.height + g[3]]) : box, clip);
        if (!seen) { clipped++; continue; }
        out.push(grown ? union(seen, box) : box);
        if (grown) overflow++;
        continue;
      }
      if (images && images.has(c)) imgs.push(box);
      if (o.glyphs && o.glyphs.has(c)) glyphTexts.push(box);
      walk(c, mc, r.props.clipsContent ? clipTo(clip, box) : clip);
    }
  };
  walk(i, I0, r0.props.clipsContent ? [0, 0, r0.props.width, r0.props.height] : null);
  return images || opts ? { instances: out, images: imgs, overflow, clipped, glyphTexts } : out;
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
  // Exact: the picture less than a whole pixel over the box, the box's rounding noise allowed for (a box
  // of 800.0000000000001, from the IR's transforms, is 800), so a picture of 801 for it holds a pixel the
  // box does not place. On the U audit two roots of one geometry, boxes of 800 and 800.0000000000001 and
  // pictures of 801, were placed by two rules before this.
  const fits = (W, b) => Math.abs(W - b) < 1 - 1e-6;
  if (Math.abs(side.W - bw) <= tol && Math.abs(side.H - bh) <= tol) return { ox: 0, oy: 0, bw, bh, rule: "box", exact: [fits(side.W, bw), fits(side.H, bh)] };
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
// slack: how far past the extents' difference the window reaches (0.5 px; on pictures k times finer, k/2
// of their pixels, the same half pixel).
export function registration(pF, pP, wF, wP, S, slack) {
  const sl = slack === undefined ? 0.5 : slack;
  return [0, 1].map((k) => {
    if (S.register === "top-left") return { d: 0, rule: "top left" };
    const o = (p) => (k ? p.oy : p.ox);
    if (pF && pP && pF.rule === "render bounds" && pP.rule === "render bounds") return { d: o(pF) - o(pP), rule: "render bounds" };
    if (wF[k] === wP[k]) return { d: 0, rule: "same extent" };
    if (pF && pP && pF.exact[k] && pP.exact[k]) return { d: o(pF) - o(pP), rule: "reported" };
    const span = wF[k] - wP[k];
    if (S.registerFitPx > 0 && Math.abs(span) <= S.registerFitPx) return { d: null, rule: "fitted", window: [Math.min(0, span) - sl, Math.max(0, span) + sl] };
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
// is split half and half, each side resampled (bilinear) by its half, so both are blurred alike: on the
// U audit's saved connectors a one-sided shift left means of 6.7-12.5, the split 2.1-7.31 (§16.2). A
// split cannot both keep whole offsets exact and move continuously through a half pixel: at exactly
// half, split says which side takes the +0.5 (per axis, 1 or -1; compareBest tries both). What the
// split leaves on two box-filtered pictures of one drawing at different phases is §16.2's residual
// (--register-supersample removes it where the engines can export finer).
// The canvas holds both (a pixel outside a side is that side's white); a pixel any contributing pixel of
// which is masked on either side is left out. bands: hairlineBands, compared column by column where the
// pictures show the hairline pattern (one crisp row above the boundary in Figma, two half rows in Pixso).
// regions: boxes in the frame `at` is given in; the share of the summed difference whose pixel centre
// lies in one of them is inRegions.
function compareSides(cf, cp, S, bands, split, regions) {
  const has = (sd) => sd.W > 0 && sd.H > 0;
  const D = [cp.at[0] - cf.at[0], cp.at[1] - cf.at[1]];
  const fr = D.map((v, k) => { const f = v - Math.round(v); return split && split[k] && Math.abs(Math.abs(f) - 0.5) < EPS ? 0.5 * split[k] : f; });
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
  // The regions as a bitmap over the canvas (a pixel is in when its centre is).
  let inR = null, sumIn = 0;
  if (regions && regions.length) {
    inR = new Uint8Array(W * H);
    for (const q of regions) {
      const p0 = Math.max(0, Math.ceil(q[0] - g[0] - 0.5)), p1 = Math.min(W, Math.ceil(q[2] - g[0] - 0.5));
      const q0 = Math.max(0, Math.ceil(q[1] - g[1] - 0.5)), q1 = Math.min(H, Math.ceil(q[3] - g[1] - 0.5));
      for (let y = q0; y < q1; y++) if (p1 > p0) inR.fill(1, y * W + p0, y * W + p1);
    }
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
      if (inR && inR[y * W + x]) sumIn += d;
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
    drawn: { figma: drawnOf(cf, cp, S), pixso: drawnOf(cp, cf, S) }, offset: [r2(D[0]), r2(D[1])], bands: bandsUsed,
    inRegions: inR ? (sum > 0 ? r6(sumIn / sum) : 0) : null };
}

// compareSides, where an axis's offset is exactly half a pixel: both ways of splitting it, the lower
// mean kept. Which side takes the +0.5 was an arbitrary choice before (Math.round's): the two ways give
// 5.75 and 8.75 on one of the U audit's connectors, and a pair and its mirror image differed (8.62
// against 12.04 on a 2 px band 0.75 px apart); now a pair and its mirror image score alike.
function compareBest(cf, cp, S, bands, regions) {
  const tie = [0, 1].map((k) => { const v = cp.at[k] - cf.at[k]; return Math.abs(Math.abs(v - Math.round(v)) - 0.5) < EPS; });
  if (!tie[0] && !tie[1]) return compareSides(cf, cp, S, bands, null, regions);
  let best = null;
  for (const sx of tie[0] ? [1, -1] : [0]) for (const sy of tie[1] ? [1, -1] : [0]) {
    const m = compareSides(cf, cp, S, bands, [sx, sy], regions);
    if (!best || (m.compared && (!best.compared || m.mean < best.mean))) best = m;
  }
  return best;
}

// A picture taken k times finer, box-averaged back onto whole pixels whose first begins p = [px, py]
// fine pixels before the picture's own first: pixel (m, l) is the mean of the fine pixels [k m - px,
// k m - px + k) × [k l - py, k l - py + k), a fine pixel outside the picture transparent. The colour is
// averaged premultiplied (so it lays over white as the fine pixels do) and kept unrounded.
export function downsample(img, k, p) {
  const px = p ? p[0] : 0, py = p ? p[1] : 0;
  const W = Math.ceil((img.W + px) / k), H = Math.ceil((img.H + py) / k);
  const rgba = new Float64Array(W * H * 4);
  for (let y = 0; y < img.H; y++) {
    const l = Math.floor((y + py) / k);
    for (let x = 0; x < img.W; x++) {
      const s = (y * img.W + x) * 4, a = img.rgba[s + 3];
      if (!a) continue;
      const o = (l * W + Math.floor((x + px) / k)) * 4;
      rgba[o] += img.rgba[s] * a; rgba[o + 1] += img.rgba[s + 1] * a; rgba[o + 2] += img.rgba[s + 2] * a; rgba[o + 3] += a;
    }
  }
  for (let o = 0; o < rgba.length; o += 4) {
    const a = rgba[o + 3];
    if (a > 0) { rgba[o] /= a; rgba[o + 1] /= a; rgba[o + 2] /= a; }
    rgba[o + 3] = a / (k * k);
  }
  return { W, H, rgba };
}

// What a side draws outside its masks: the box of its pixels with an alpha of at least --drawn-alpha (of
// 255), in the frame its `at` is given in, from its own pixels (not the resampled ones, which a
// fractional offset spreads by a pixel), or null when it draws nothing there. The faintest fringe is
// left out: of the 28 595 pixels at alpha 1-15 in Figma's half of the 435 same-size pairs the U audit
// kept, 2 419 are transparent in Pixso's (its indexed PNGs), and an edge should not move on that.
// Which of those pixels count (--drawn-by, §16.5):
// - alpha: all of them;
// - visible: not one that is white (each channel over white within --drawn-white-tol of 255) where the
//   other side `other`, registered, is white too: every pixel of it the place overlaps (one, or two or
//   four at a fractional offset) white over white, a pixel outside it or under its masks white. Every
//   pixel it overlaps rather than a blend of them, so the test is the same seen from either side: where
//   one side is visibly not white, the other's pixels over it count, and both edges reach it within a
//   pixel. Under its masks white, because what the masks leave out is not compared: at a fractional
//   offset a mask's edge falls a pixel apart on the two sides, and on the U pass an instance Pixso
//   draws under its mask made Figma's empty frame beside it count (3 roots failed on that). The
//   comparison is over white, so what is white on both sides is drawn by neither as far as it can
//   tell (the second pass's 4 roots, §16.3: a shadow's edge at alpha 16-19 on one side and 12-15 on
//   the other, at most 16 levels off white), while a pixel where the two differ visibly counts on
//   both sides, white or not (an image placeholder against an image with white margins inside a white
//   frame stays a difference of content, not of size);
// - ink: not one that is white, whatever the other holds (tried and dropped on the second pass: that
//   case becomes a size difference).
function drawnOf(sd, other, S) {
  const lo = (S.drawnAlpha || 1) / 255, by = S.drawnBy || "alpha", wl = 255 - (S.drawnWhiteTol || 0) - EPS;
  const white = (rgb, k) => rgb[k] >= wl && rgb[k + 1] >= wl && rgb[k + 2] >= wl;
  // visible: per own column and row, the first pixel of the other side it overlaps and whether it
  // overlaps the next one too.
  let otherWhite = null;
  if (by === "visible") {
    const ax = (n, d) => { const idx = new Int32Array(n), two = new Uint8Array(n); for (let x = 0; x < n; x++) { const u = x + d, i0 = Math.floor(u + EPS); idx[x] = i0; two[x] = u - i0 >= EPS ? 1 : 0; } return { idx, two }; };
    const X = ax(sd.W, sd.at[0] - other.at[0]), Y = ax(sd.H, sd.at[1] - other.at[1]);
    otherWhite = (x, y) => {
      const i0 = X.idx[x], j0 = Y.idx[y];
      for (let j = j0; j <= j0 + Y.two[y]; j++) {
        if (j < 0 || j >= other.H) continue;
        for (let i = i0; i <= i0 + X.two[x]; i++) if (i >= 0 && i < other.W && !other.bits[j * other.W + i] && !white(other.rgb, (j * other.W + i) * 3)) return false;
      }
      return true;
    };
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < sd.H; y++) {
    for (let x = 0; x < sd.W; x++) {
      const o = y * sd.W + x;
      if (sd.al[o] < lo || sd.bits[o]) continue;
      if (by !== "alpha" && white(sd.rgb, o * 3) && (by === "ink" || otherWhite(x, y))) continue;
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
// opts: { bands (hairlineBands), regions } (in the frame `at` is given in).
export function comparePictures(F, P, S, opts) {
  return compareBest(sideOf(F), sideOf(P), S, opts && opts.bands, opts && opts.regions);
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
  // Pixso exports 0 bytes (n 0) for a hidden node and an empty text, where Figma's export is a transparent
  // 1x1 (the U audit, §16.2: its 2 hidden and 2 empty texts, and one text whose stored outline is
  // unbounded; a node at opacity 0 and a component with no paint export a transparent box): an answer,
  // not a missing render.
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
  // af, ap: what each picture's alpha is multiplied by (the pictures at k × the scale take the same).
  let af = 1, ap = 1, rule = "none";
  if (op < 1) {
    const big = op >= S.undoOpacityMin;
    if (S.opacity === "both" && big) { af = ap = 1 / op; rule = "undone in both pictures"; }
    else if (S.opacity === "undo" && big) { af = 1 / op; rule = "undone in Figma's picture"; }
    else if (S.opacity === "apply" || S.opacity === "undo") { ap = op; rule = "applied to Pixso's picture"; }
    else rule = "compared as exported";
  }
  const fImg = af === 1 ? fi : scaleAlpha(fi, af), pImg = ap === 1 ? pi : scaleAlpha(pi, ap);
  e.opacity = { value: op, rule };
  // What each export holds against the opacity: reported, not used to pick the rule (a translucent paint
  // lowers the most opaque pixel without any opacity).
  if (op < 1) e.opacity.maxAlpha = { figma: maxAlpha(fi), pixso: maxAlpha(pi), atOpacity: Math.round(255 * op) };
  // Where the pictures lie against each other (registration) and where the box is in each.
  const wF = [fi.W, fi.H], wP = [pi.W, pi.H];
  const blankF = isBlank(fi), blankP = isBlank(pi);
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
  // Placeholders, masked on both sides: the instances' (--placeholders mask), the images' the build
  // could not carry (--image-placeholders mask) and the texts drawn from outlines that are not glyphs
  // (--glyph-notes mask).
  const glyphMasked = S.glyphNotes === "mask" ? found.glyphTexts : [];
  const boxes = (S.placeholders === "mask" ? found.instances : []).concat(S.imagePlaceholders === "mask" ? found.images : []).concat(glyphMasked);
  e.masks = { placeholders: found.instances.length, overflow: found.overflow, imagePlaceholders: found.images.length, masked: boxes.length, pad: boxes.length ? S.maskPad : null };
  if (found.clipped) e.masks.clipped = found.clipped;
  if (found.glyphTexts.length) e.masks.glyphTexts = found.glyphTexts.length;
  // Placeholders that cannot be placed leave the root not compared, unless one picture draws nothing:
  // what the other draws is then not known to be masked, and a blank side never passes (on the U audit,
  // the root whose Pixso export is 0 bytes came out not compared under --register top-left before this).
  const unplaced = (where) => {
    if (blankF !== blankP) {
      e.why = (blankP ? "Pixso" : "Figma") + " draws nothing" + (emptyP ? " (its export is 0 bytes)" : "") + " and " + (blankP ? "Figma" : "Pixso") + " draws " +
        (blankP ? fi.W + "x" + fi.H : pi.W + "x" + pi.H) + " px; the placeholders cannot be placed in " + where + ", so what it draws is not known to be masked";
      return Object.assign({ e }, pngs);
    }
    e.ok = null; e.class = "unplaced"; e.why = "not compared: the placeholders cannot be placed in " + where;
    return Object.assign({ e }, pngs);
  };
  if (boxes.length && !placeF && !placeP) return unplaced("either picture");
  const pad = (b) => [b[0] - S.maskPad, b[1] - S.maskPad, b[2] + S.maskPad, b[3] + S.maskPad];
  const frameMasks = boxes.map((b) => toPixels(pad(b), lin, size, s, { ox: 0, oy: 0 }));
  const shift = (ms, o) => ms.map((m) => [m[0] + o[0], m[1] + o[1], m[2] + o[0], m[3] + o[1]]);
  const bands = S.hairlines === "band" && (placeF || placeP) ? hairlineBands(ir, j, kids, s) : [];
  // Where the flagged texts' outlines can reach (--glyph-class near): their boxes grown by --glyph-near.
  const glyphNear = found.glyphTexts.length && S.glyphClass === "near"
    ? found.glyphTexts.map((b) => toPixels([b[0] - S.glyphNear, b[1] - S.glyphNear, b[2] + S.glyphNear, b[3] + S.glyphNear], lin, size, s, { ox: 0, oy: 0 })) : null;
  // The two sides: pictures fI and pI, aF where the node's box sits in Figma's picture (null: not
  // placed), dPic where Pixso's picture starts against Figma's; each cut sits at the box frame's
  // position of its first pixel. Under --register top-left each cut sits at 0, as in the first pass, and
  // its masks by its own placement (a blank picture needs none). regions: the flagged texts' reach in
  // the canvas's frame, or null when the canvas is not the box frame.
  const layout = (fI, pI, aF, dPic) => {
    const sf = { img: fI, crop: cropF, masks: [] }, sp = { img: pI, crop: cropP, masks: [] };
    if (S.register === "top-left") {
      if (boxes.length) {
        if ((!placeF && !blankF) || (!placeP && !blankP)) return null;
        if (placeF) sf.masks = shift(frameMasks, [placeF.ox, placeF.oy]);
        if (placeP) sp.masks = shift(frameMasks, [placeP.ox, placeP.oy]);
      }
      return { sf, sp, framed: false, regions: glyphNear && placeF ? shift(glyphNear, [placeF.ox, placeF.oy]) : null };
    }
    const o = aF ? { F: aF, P: [aF[0] - dPic[0], aF[1] - dPic[1]] } : { F: [0, 0], P: [-dPic[0], -dPic[1]] };
    const cut = (c) => (c ? [Math.max(0, Math.round(c[0])), Math.max(0, Math.round(c[1]))] : [0, 0]);
    const cF = cut(cropF), cP = cut(cropP);
    sf.at = [cF[0] - o.F[0], cF[1] - o.F[1]]; sp.at = [cP[0] - o.P[0], cP[1] - o.P[1]];
    if (boxes.length) { sf.masks = shift(frameMasks, o.F); sp.masks = shift(frameMasks, o.P); }
    return { sf, sp, framed: !!aF, regions: aF ? glyphNear : null };
  };
  // At the export's scale: Pixso's picture at offset d; the box from the side that places it.
  const sides = (d) => layout(fImg, pImg, placeF ? [placeF.ox, placeF.oy] : placeP ? [placeP.ox + d[0], placeP.oy + d[1]] : null, d);
  const d0 = reg.map((r) => (r.d === null ? 0 : r.d));
  if (!sides(d0)) return unplaced((!placeF && !blankF) ? "Figma's picture" : "Pixso's picture");
  const search = reg.some((r) => r.d === null);
  // The search on pictures k times finer (--register-supersample): both engines export the node again
  // at k × the scale, and each is box-averaged back onto whole pixels, Pixso's at each phase of 1/k px.
  // The offset is then tried in steps of 1/k px with no resampling, and two box-filtered pictures of one
  // drawing at different sub-pixel phases become one picture again. At the export's scale the split
  // leaves a residual on identical drawings (§16.2: 2.25 on the connectors' shaft alone, 6.62 on a
  // 2 px line in 15 rows at phases 0 and 0.5). Only where the search runs, and only up to
  // --supersample-max-side; otherwise, or when an export at k × is missing or not k times the first,
  // the search runs on the pictures as exported, and the root records why.
  const fineFit = async () => {
    // Both engines' exports take a scale up to 16 (the plugin's EXPORT_LIMITS, SCRIPTS.auditRender).
    const big = Math.max(fi.W, fi.H, pi.W, pi.H), top = Math.floor(16 / s + EPS), k = Math.min(S.registerSupersample, Math.floor(S.supersampleMaxSide / big), top);
    if (k < 2) return { k: S.registerSupersample, why: top < 2 ? "the scale is " + e.scale + " and an export takes up to 16" : "the pictures are too large (" + big + " px; --supersample-max-side " + S.supersampleMaxSide + ")" };
    const sk = s * k;
    let Fk = null, Pk = null;
    try { Fk = await figmaExport(Object.assign({}, job, { constraint: { type: "SCALE", value: sk } })); } catch (err) { Fk = { e: String((err && err.message) || err) }; }
    if (!Fk || Fk.e || typeof Fk.d !== "string" || !Fk.d) return { k, why: "Figma's picture at " + k + "x is missing: " + String((Fk && (Fk.e || Fk.error)) || "no picture").slice(0, 80) };
    try { Pk = await pixsoRender(rec.guid, sk); } catch (err) { Pk = { ok: false, error: String((err && err.message) || err) }; }
    const pk = Pk && Pk.ok ? Pk.value : null;
    if (!pk || pk.e || typeof pk.d !== "string" || !pk.d) return { k, why: "Pixso's picture at " + k + "x is missing: " + String((pk && pk.e) || (Pk && Pk.error) || "no picture").slice(0, 80) };
    let fk, qk;
    try { fk = decodePNG(Buffer.from(Fk.d, "base64")); qk = decodePNG(Buffer.from(pk.d, "base64")); }
    catch (err) { return { k, why: "a picture at " + k + "x does not decode: " + String(err.message).slice(0, 80) }; }
    // Each must be its first picture k times finer, give or take a pixel of the first.
    const finer = (a, b) => Math.abs(a.W - k * b.W) <= k && Math.abs(a.H - k * b.H) <= k;
    if (!finer(fk, fi) || !finer(qk, pi)) return { k, why: "the pictures at " + k + "x are not " + k + " times the first (Figma " + fk.W + "x" + fk.H + ", Pixso " + qk.W + "x" + qk.H + ")" };
    if (af !== 1) fk = scaleAlpha(fk, af);
    if (ap !== 1) qk = scaleAlpha(qk, ap);
    const pF = placeBox({ W: fk.W, H: fk.H, box: Fk.box, render: Fk.render }, sk, size, lin);
    const pP = placeBox({ W: qk.W, H: qk.H, box: pk.box, render: pk.render }, sk, size, lin);
    if (boxes.length && !pF && !pP) return { k, why: "the placeholders cannot be placed in either picture at " + k + "x" };
    const rg = registration(pF, pP, [fk.W, fk.H], [qk.W, qk.H], { register: "bounds", registerFitPx: k * S.registerFitPx }, k / 2);
    // Offsets in fine pixels: a known one rounded, a searched one every fine pixel of its window.
    const cands = rg.map((r) => { if (r.d !== null) return [Math.round(r.d)]; const out = []; for (let n = Math.ceil(r.window[0] - EPS); n <= Math.floor(r.window[1] + EPS); n++) out.push(n); return out; });
    const fD = downsample(fk, k), phases = new Map();
    // Pixso's fine picture n fine pixels after Figma's: its phase n mod k, laid at floor(n / k).
    const at = (n) => {
      const p = n.map((v) => ((v % k) + k) % k), q = n.map((v, a) => (v - p[a]) / k), key = p.join();
      if (!phases.has(key)) phases.set(key, downsample(qk, k, p));
      const aF = pF ? [pF.ox / k, pF.oy / k] : pP ? [(pP.ox + n[0]) / k, (pP.oy + n[1]) / k] : null;
      return Object.assign(layout(fD, phases.get(key), aF, q), { key });
    };
    // As at the export's scale, each side is laid over white once (Pixso's once per phase); an offset
    // moves it and its masks.
    let best = null, tried = 0, cf = null;
    const laid = new Map();
    for (const nx of cands[0]) for (const ny of cands[1]) {
      const x = at([nx, ny]);
      if (!cf) cf = sideOf(x.sf);
      if (!laid.has(x.key)) laid.set(x.key, sideOf(x.sp));
      const cp = laid.get(x.key);
      cf.at = x.sf.at; cf.bits = maskBits(cf, x.sf.masks); cp.at = x.sp.at; cp.bits = maskBits(cp, x.sp.masks);
      const mm = compareSides(cf, cp, S, x.framed ? bands : []);
      tried++;
      const v = mm.compared ? mm.mean : Infinity;
      if (!best || v < best.v - 1e-9) best = { n: [nx, ny], v, lay: x };
    }
    const m = compareSides(sideOf(best.lay.sf), sideOf(best.lay.sp), S, best.lay.framed ? bands : [], null, best.lay.regions);
    return { k, m, d: best.n.map((v) => v / k), reg: rg, tried, figma: [fk.W, fk.H], pixso: [qk.W, qk.H], pngs: { k, figma: Fk.d, pixso: pk.d } };
  };
  const fine = search && S.registerSupersample > 1 && !crop && S.register === "bounds" && !blankF && !blankP ? await fineFit() : null;
  let d = d0, m;
  const r2 = (v) => Math.round(v * 100) / 100;
  if (fine && fine.m) {
    m = fine.m; d = fine.d;
    pngs.fine = fine.pngs;   // kept beside the pictures as exported, so a later pass can re-judge them
    e.register = { rule: fine.reg.map((r) => r.rule), offset: d.map(r2), window: fine.reg.map((r) => (r.window ? r.window.map((v) => r2(v / fine.k)) : null)), tried: fine.tried,
      supersample: { k: fine.k, figma: fine.figma, pixso: fine.pixso } };
  } else {
    let fitted = null;
    if (search) {
      // The search: Figma's side is laid out once; Pixso's moves (its masks with it).
      const base = sides(d0), cf = sideOf(base.sf), cp = sideOf(base.sp);
      fitted = fitOffset(reg, (dd) => {
        const x = sides(dd);
        cf.at = x.sf.at; cf.bits = maskBits(cf, x.sf.masks); cp.at = x.sp.at; cp.bits = maskBits(cp, x.sp.masks);
        const mm = compareBest(cf, cp, S, x.framed ? bands : []);
        return mm.compared ? mm.mean : Infinity;
      });
      d = fitted.d;
    }
    const lay = sides(d);
    m = compareBest(sideOf(lay.sf), sideOf(lay.sp), S, lay.framed ? bands : [], lay.regions);
    e.register = { rule: reg.map((r) => r.rule), offset: d.map(r2) };
    if (fitted) { e.register.window = reg.map((r) => r.window || null); e.register.tried = fitted.tried; }
    if (fine) e.register.supersample = { k: fine.k, used: false, why: fine.why };
  }
  e.masks.maskedShare = m.maskedShare;
  if (bands.length) e.hairlines = { found: bands.length, compared: m.bands };
  e.metrics = { compared: m.compared, same: m.same, gross: m.gross, mean: m.mean, worstTile: m.worstTile, canvas: m.canvas, drawn: m.drawn };
  if (!m.compared) {
    // Nothing left once masked: in the flagged texts' class when their masks are among those applied.
    const what = [];
    if (S.placeholders === "mask" && found.instances.length) what.push(found.instances.length + " instance placeholder" + (found.instances.length === 1 ? "" : "s"));
    if (S.imagePlaceholders === "mask" && found.images.length) what.push(found.images.length + " image placeholder" + (found.images.length === 1 ? "" : "s"));
    if (glyphMasked.length) what.push(glyphMasked.length + " text" + (glyphMasked.length === 1 ? "" : "s") + " whose stored glyph outlines are not glyphs");
    e.ok = null; e.class = glyphMasked.length ? "source-glyphs" : "masked";
    e.why = "not compared: nothing is left once the masks are applied (" + what.join(", ") + ")";
    return Object.assign({ e }, pngs);
  }
  e.compared = true;
  const tolPx = S.sizeTol * s + 1;
  const why = [];
  if (emptyP) why.push("Pixso draws nothing (its export is 0 bytes) and Figma draws " + fi.W + "x" + fi.H + " px");
  if (S.sizeBy === "picture") {
    // The pictures as exported (a search at k × the scale compares them box-averaged back).
    const pf = fine && fine.m ? wF : m.figma, pp = fine && fine.m ? wP : m.pixso;
    if (Math.abs(pf[0] - pp[0]) > tolPx || Math.abs(pf[1] - pp[1]) > tolPx) why.push("the pictures differ in size: Figma " + pf.join("x") + ", Pixso " + pp.join("x") + " px at scale " + e.scale);
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
  if (why.length && found.glyphTexts.length) {
    // The class only where the difference lies where the flagged texts' outlines can reach (--glyph-class
    // near: more than --glyph-share-min of it within --glyph-near of their boxes); elsewhere the root is an
    // ordinary failure that holds them. Measured on the U audit (§16.2): the root that draws slabs holds
    // 69 % of its difference within 256 units of its 44 flagged texts, 17 % of its area (20 % within 64,
    // 99 % within 512); the 2 drop-down roots, their placeholders masked by their boxes, hold 3.5-4.6 %
    // within 256 units of their one flagged text, about that region's share of their area.
    if (glyphNear) e.glyphShare = m.inRegions;
    const near = S.glyphClass === "any" || (m.inRegions !== null && m.inRegions > S.glyphShareMin);
    why.push(glyphWhy() + (near ? "" : m.inRegions === null ? ", but where the difference lies against them is not known (the box is not placed)" : ", but most of the difference lies away from them"));
    if (near) e.class = "source-glyphs";
  }
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
          if (p.fine) pics.push({ name: r.i + "-c" + k + "@" + p.fine.k + "x", figma: p.fine.figma, pixso: p.fine.pixso, ok: p.e.ok });
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
        // The pictures a search at k × the scale compared (--register-supersample), as <i>@<k>x.
        if (p.fine) pics.push({ name: r.i + "@" + p.fine.k + "x", figma: p.fine.figma, pixso: p.fine.pixso, ok: p.e.ok });
      }
    }
    if (entry.ok !== true && entry.ok !== null) entry.ok = false;
    out.push(entry);
    log("  [" + n + "/" + roots.length + "] root " + r.i + " " + (entry.ok === true ? "ok" : entry.ok === null ? "not compared" : "NOT OK") + (entry.why ? ": " + entry.why : ""));
    if (ctx.onRoot) await ctx.onRoot(entry, pics);
  }
  const cls = (c, ok) => out.filter((e) => e.class === c && (ok === undefined || e.ok === ok)).length;
  // The flagged texts' class is counted apart for the roots that fail in it and the ones not compared
  // (--glyph-notes skip, or a root its masks cover whole).
  const counts = { roots: out.length, ok: out.filter((e) => e.ok === true).length, failed: out.filter((e) => e.ok === false).length,
    notCompared: out.filter((e) => e.ok === null).length, blank: cls("blank"), hiddenInSource: cls("hidden-in-source"),
    sourceGlyphs: cls("source-glyphs", false), sourceGlyphsNotCompared: cls("source-glyphs", null), placeholderRoots: placeholderRoots.length,
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
