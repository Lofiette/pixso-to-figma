// Strokes, side strokes and corners (docs/M1.md D15, §1.2, §6 A).
//
// Side rule: no border*Weight field means four sides at strokeWeight; any field present means a
// missing side is 0. Side oracle: where the stored stroke-area path (strokePaddingPath) can say which
// sides Pixso draws (a solid stroke, a path, both sides at least 2 px), five points per side are
// sampled in the middle of the band the side would draw, away from the corners, exactly as the
// measurement of §1.2 did; the result is the IR-own oracleSides, and where rule and oracle disagree
// the IR follows the oracle and notes SIDE_RULE_UNPROVEN.
//
// Corners: any rectangle*CornerRadius field present means the four fields, a missing one 0 (M writes
// no cornerRadius on 3 834 nodes); otherwise cornerRadius. Four equal values are written as one.
//
// An absent strokeAlign on a visible stroke (M 355) is decided from the stroke-area path. A path that
// reaches nothing past the box is INSIDE (about 100 % right on the nodes that store an align). A
// reach of the whole weight is OUTSIDE only with a band profile only OUTSIDE gives (sampled mid top
// side at -0.5w, +0.5w, +1.5w into the box: 100 or 111); the -w..+w band (110) is stored INSIDE on
// most nodes that store an align, so it, a reach of half the weight, and any other profile are
// guesses: the type's default, counted under "guess:" (part F, review R1). With no path, or no
// visible stroke, it is the type's default.
import { CODE } from "../../ir/schema.mjs";
import * as E from "./enums.mjs";
import { paintsOf } from "./paints.mjs";
import { r2, isFin, blobPolylines, insideAny, blobPointBounds, unionBox } from "./util.mjs";

export const SIDE_FIELDS = ["borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight"];
export const CORNER_FIELDS = ["rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomRightCornerRadius",
  "rectangleBottomLeftCornerRadius"];
const DEFAULT_ALIGN = { FRAME: "INSIDE", COMPONENT: "INSIDE", COMPONENT_SET: "INSIDE", SLOT: "INSIDE", RECTANGLE: "INSIDE",
  ELLIPSE: "INSIDE", POLYGON: "INSIDE", STAR: "INSIDE", LINE: "CENTER", VECTOR: "CENTER", BOOLEAN_OPERATION: "CENTER", TEXT: "OUTSIDE" };
// The Pixso types of the side measurement (§1.2): non-instance frames, masters, rectangles, sections.
const SIDE_POPULATION = ["FRAME", "SYMBOL", "RECTANGLE", "SECTION"];

export const visiblePaint = (list) => (list || []).some((p) => p.visible !== false && (p.opacity === undefined || p.opacity > 0));
export const weightOf = (n) => (n.strokeWeight === undefined ? 1 : n.strokeWeight);

// Pixso stores the miter as the angle (degrees) below which joins are cut; Figma takes the ratio of
// miter length to stroke weight: 1 / sin(angle / 2). 28.955 degrees is Figma's default 4.
export function miterRatio(deg) {
  if (!isFin(deg) || deg <= 0 || deg >= 180) return 4;
  return r2(1 / Math.sin((deg * Math.PI) / 360));
}

function paddingPolylines(cx, n) {
  const subs = [];
  for (const p of n.strokePaddingPath || []) {
    const b = cx.blob(p.blobIndex);
    if (b && b.length) subs.push(...blobPolylines(b));
  }
  return subs;
}

// The oracle of §1.2, or the reason there is none: { sides: [4 booleans] } | { none: "noPath" | "dashed" | "small" }.
export function sideOracle(cx, n, rule, align) {
  if (!(n.strokePaddingPath || []).some((p) => { const b = cx.blob(p.blobIndex); return b && b.length; })) return { none: "noPath" };
  if ((n.dashPattern || []).length) return { none: "dashed" };
  const W = n.size ? n.size.x : 0, H = n.size ? n.size.y : 0;
  if (!(W >= 2 && H >= 2)) return { none: "small" };
  const subs = paddingPolylines(cx, n);
  const sw = weightOf(n);
  const wmax = Math.max(...rule, sw, 0.01);
  const rad = Math.max(n.cornerRadius || 0, ...CORNER_FIELDS.map((k) => n[k] || 0));
  const sides = [0, 1, 2, 3].map((s) => {
    const w = rule[s] > 0 ? rule[s] : sw > 0 ? sw : 1;
    const d = align === "OUTSIDE" ? -w / 2 : align === "CENTER" ? 0 : w / 2;
    const ds = align === "absent" ? [w / 2, -w / 2] : [d];
    const len = s % 2 === 0 ? W : H;
    const m = Math.min(len / 2 - 0.5, rad + wmax + 0.5);
    for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const t = Math.max(m, Math.min(len - m, f * len));
      for (const dd of ds) {
        const [x, y] = s === 0 ? [t, dd] : s === 1 ? [W - dd, t] : s === 2 ? [t, H - dd] : [dd, t];
        if (insideAny(subs, x, y)) return true;
      }
    }
    return false;
  });
  return { sides };
}

export function sideRule(n) {
  const sw = weightOf(n);
  return SIDE_FIELDS.some((k) => n[k] !== undefined) ? SIDE_FIELDS.map((k) => (isFin(n[k]) ? n[k] : 0)) : [sw, sw, sw, sw];
}

// strokeAlign: the stored one, or decided from the stroke-area path (above).
function alignOf(cx, n, type) {
  const stored = E.STROKE_ALIGN[cx.en("PixsoNode", "strokeAlign")(n.strokeAlign)];
  if (stored) return stored;
  const def = DEFAULT_ALIGN[type] || "CENTER";
  if (!visiblePaint(n.strokePaints)) return def;
  let box = null;
  for (const p of n.strokePaddingPath || []) { const b = cx.blob(p.blobIndex); if (b && b.length) box = unionBox(box, blobPointBounds(b)); }
  const W = n.size ? n.size.x : NaN, H = n.size ? n.size.y : NaN, w = weightOf(n);
  // Counted by outcome: "default:" with no path to measure, "guess:" where the path does not decide.
  let decided = def, key = "default:" + def;
  if (box && isFin(W) && isFin(H) && w > 0) {
    const reach = Math.max(-box.x0, -box.y0, box.x1 - W, box.y1 - H);
    const cand = [["INSIDE", 0], ["CENTER", w / 2], ["OUTSIDE", w]];
    cand.sort((a, b) => Math.abs(reach - a[1]) - Math.abs(reach - b[1]));
    if (cand[0][0] === "INSIDE") decided = key = "INSIDE";
    else if (cand[0][0] === "OUTSIDE" && ["100", "111"].indexOf(bandProfile(cx, n, W, w)) >= 0) decided = key = "OUTSIDE";
    else key = "guess:" + def;
  }
  cx.stats.strokeAlignDecided[key] = (cx.stats.strokeAlignDecided[key] || 0) + 1;
  return decided;
}

// Whether the stroke-area path holds the points 0.5, -0.5 and -1.5 weights outside the top edge,
// mid side ("1" inside, "0" not): -0.5w (outside the box), +0.5w and +1.5w (inside it).
export function bandProfile(cx, n, W, w) {
  const subs = paddingPolylines(cx, n);
  return [-w / 2, w / 2, 1.5 * w].map((y) => (insideAny(subs, W / 2, y) ? "1" : "0")).join("");
}

// The paint and stroke props of a record. `put` writes a prop the type knows (props.mjs).
export function strokeProps(cx, n, type, put, opts) {
  put("fills", paintsOf(cx, n.fillPaints));
  put("strokes", paintsOf(cx, n.strokePaints));
  const sw = r2(isFin(weightOf(n)) && weightOf(n) >= 0 ? weightOf(n) : 1);
  put("strokeAlign", alignOf(cx, n, type));
  const join = E.STROKE_JOIN[cx.en("PixsoNode", "strokeJoin")(n.strokeJoin)];
  if (join) put("strokeJoin", join);
  const capName = cx.en("PixsoNode", "strokeCap")(n.strokeCap);
  if (capName !== undefined) {
    if (E.STROKE_CAP[capName]) put("strokeCap", E.STROKE_CAP[capName]);
    else cx.feature("strokeCap " + capName);
  }
  const dashCap = cx.en("PixsoNode", "dashCap")(n.dashCap);
  if (dashCap !== undefined && dashCap !== "NONE") cx.feature("dashCap");
  if (n.miterLimit !== undefined) put("strokeMiterLimit", miterRatio(n.miterLimit));
  if ((n.dashPattern || []).length) put("dashPattern", n.dashPattern.map((v) => r2(isFin(v) ? Math.max(0, v) : 0)));

  // Sides: only rectangle-like records have them, and never an instance (its border is its master's).
  let weight = sw;
  // With no visible stroke there is no side to draw, and no oracle to note (part F, review R5).
  if (opts && opts.sides && visiblePaint(n.strokePaints)) {
    const rule = sideRule(n);
    const storedAlign = cx.en("PixsoNode", "strokeAlign")(n.strokeAlign);
    const oracle = sideOracle(cx, n, rule, storedAlign === undefined ? "absent" : storedAlign);
    let sides = rule.map((v) => r2(v));
    if (oracle.sides) {
      put("oracleSides", oracle.sides);
      const want = rule.map((v) => v > 0);
      if (want.some((v, i) => v !== oracle.sides[i])) {
        sides = oracle.sides.map((d, i) => (d ? r2(rule[i] > 0 ? rule[i] : sw) : 0));
        const pat = (a) => a.map((v) => (v ? 1 : 0)).join("");
        cx.note(CODE.SIDE_RULE_UNPROVEN, "rule " + pat(want) + ", oracle " + pat(oracle.sides));
      }
    }
    if (sides.every((v) => v === sides[0])) weight = sides[0];
    else put("strokeWeights", sides);
  }
  put("strokeWeight", weight);
}

// The side census of §1.2 for the stats, on the Pixso types the measurement used.
export function sideCensus(cx, n, pixsoType) {
  if (SIDE_POPULATION.indexOf(pixsoType) < 0 || n.styleType !== undefined || !visiblePaint(n.strokePaints)) return;
  const S = cx.stats.sides;
  S.population++;
  const rule = sideRule(n);
  const storedAlign = cx.en("PixsoNode", "strokeAlign")(n.strokeAlign);
  const o = sideOracle(cx, n, rule, storedAlign === undefined ? "absent" : storedAlign);
  if (o.none) { S.noOracle[o.none]++; return; }
  S.checked++;
  if (rule.every((v, i) => (v > 0) === o.sides[i])) S.agree++; else S.unproven++;
}

// Corners. `sides` types take the four fields as cornerRadii; the others take cornerRadius only.
export function cornerProps(cx, n, type, put, opts) {
  const present = CORNER_FIELDS.some((k) => n[k] !== undefined);
  if (opts && opts.sides && present) {
    const c = CORNER_FIELDS.map((k) => r2(isFin(n[k]) && n[k] > 0 ? n[k] : 0));
    if (c.every((v) => v === c[0])) put("cornerRadius", c[0]);
    else put("cornerRadii", c);
  } else if (isFin(n.cornerRadius) && n.cornerRadius > 0) {
    put("cornerRadius", r2(n.cornerRadius));
    if (!present && (type === "FRAME" || type === "COMPONENT" || type === "RECTANGLE" || type === "STAR" || type === "POLYGON")) {
      const k = cx.stats.cornerRadiusOnly; k[type] = (k[type] || 0) + 1;
    }
  }
  if (isFin(n.cornerSmoothing) && n.cornerSmoothing > 0) put("cornerSmoothing", r2(Math.min(1, n.cornerSmoothing)));
}
