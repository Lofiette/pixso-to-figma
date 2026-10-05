// Vectors: build sources and oracles (docs/M1.md D3, D13, §8.3).
//
// The reader decides each VECTOR record's one build source:
// - a network with a region, or with no stored fill geometry: its vectorNetwork, scaled from
//   normalizedSize to the node's size; the stored fill geometry, if any, becomes the IR-own
//   oracleFillGeometry, which tasks never carry;
// - a network with no region but with stored fill geometry (an auto-closed loop): no network, its
//   fillGeometry and strokeGeometry, VECTOR_FROM_GEOMETRY. The stroke is drawn on the fill path, so
//   the closing segment of an open loop is stroked too; the note's detail counts the open ends.
// RIGHT_ANGLE handle mirroring has no Figma value: stripped, SOURCE_FEATURE_UNSUPPORTED.
// Per-region fills (the node's vectorPaints, [{ regionId, paints }], regionId the region's index in
// the stored network) become the regions' `fills`; without them every region would draw the node's
// fill (a white check mark on a green icon drawn green; part F, review R4).
//
// Where the network and the stored geometry disagree in a known way, the record carries
// VECTOR_ORACLE_DIFFERS with its class (schema ORACLE_CLASSES):
// - region-no-fill: regions, but no stored fill geometry;
// - winding: as many regions as fill paths, and a region's winding is not its path's;
// - network-bounds: the exact bounds of the region segments (pathgeom.pathBounds) and of the stored
//   fill paths differ by more than 1 px on some edge.
import { CODE } from "../../ir/schema.mjs";
import { pathBounds, unionBounds } from "../../ir/pathgeom.mjs";
import * as E from "./enums.mjs";
import { decodeVectorNetwork } from "../network.mjs";
import { r2, isFin, blobToFigmaPath, unionBox } from "./util.mjs";
import { visiblePaint, weightOf } from "./strokes.mjs";
import { paintsOf } from "./paints.mjs";

// [{windingRule, data}] from Pixso Paths, or null when none has a drawable blob. A path with a
// non-finite coordinate is dropped and noted GEOMETRY_INVALID.
export function geometryOf(cx, paths, opts) {
  const out = [];
  for (const p of paths || []) {
    const blob = cx.blob(p.blobIndex);
    if (!blob || !blob.length) continue;
    const data = blobToFigmaPath(blob);
    if (data === null) continue;
    if (/NaN|Infinity/.test(data)) { if (!(opts && opts.quiet)) cx.note(CODE.GEOMETRY_INVALID, "a stored path with a non-finite coordinate, dropped"); continue; }
    const w = cx.en("Path", "windingRule")(p.windingRule);
    if (w && w.indexOf("INVERSE_") === 0) cx.feature("inverse winding");
    out.push({ windingRule: E.WINDING[w] || "NONZERO", data });
  }
  return out.length ? out : null;
}

export function geometryBox(geom) {
  if (!geom) return null;
  let box = null;
  for (const g of geom) box = unionBox(box, unionBounds(pathBounds(g.data)));
  return box;
}

// The IR network: vertices and tangents scaled to the node's size, per-vertex style from the style
// override table, RIGHT_ANGLE stripped, per-region fills from opts.regionPaints (vectorPaints).
export function networkToIR(cx, net, sx, sy, table, opts) {
  const styles = new Map((table || []).map((e) => [e.styleID, e]));
  const regionFills = new Map();
  for (const vp of (opts && opts.regionPaints) || []) if (vp && Number.isInteger(vp.regionId) && !regionFills.has(vp.regionId)) regionFills.set(vp.regionId, paintsOf(cx, vp.paints));
  let rightAngle = 0, bad = false;
  const num = (v) => { if (!isFin(v)) bad = true; return r2(v); };
  const vertices = net.vertices.map((v) => {
    const o = { x: num(v.x * sx), y: num(v.y * sy) };
    const st = v.styleID ? styles.get(v.styleID) : null;
    if (st) {
      const cap = E.STROKE_CAP[cx.en("VectorStyleData", "strokeCap")(st.strokeCap)];
      if (cap) o.strokeCap = cap;
      const join = E.STROKE_JOIN[cx.en("VectorStyleData", "strokeJoin")(st.strokeJoin)];
      if (join) o.strokeJoin = join;
      if (isFin(st.cornerRadius) && st.cornerRadius > 0) o.cornerRadius = r2(st.cornerRadius);
      const m = cx.en("VectorStyleData", "handleMirroring")(st.handleMirroring);
      if (m === "RIGHT_ANGLE") rightAngle++;
      else if (E.HANDLE_MIRRORING[m]) o.handleMirroring = E.HANDLE_MIRRORING[m];
    }
    return o;
  });
  const segments = net.segments.map((s) => {
    const o = { start: s.start, end: s.end };
    const ts = { x: num(s.tangentStart.x * sx), y: num(s.tangentStart.y * sy) };
    const te = { x: num(s.tangentEnd.x * sx), y: num(s.tangentEnd.y * sy) };
    if (ts.x || ts.y) o.tangentStart = ts;
    if (te.x || te.y) o.tangentEnd = te;
    return o;
  });
  // Pixso fills a region whose loop is open as if it were closed (D 108, K 1 131, M 61 vectors);
  // Figma takes closed loops only. Under a visible fill the loop is closed with straight segments
  // (Figma then strokes them too: counted); under no visible fill the open loop draws nothing and is
  // dropped, so the stroke stays exact.
  let closedLoops = 0, droppedLoops = 0;
  const regions = [];
  let filledRegions = 0;
  for (let ri = 0; ri < net.regions.length; ri++) {
    const r = net.regions[ri];
    const loops = [];
    for (const l of r.loops) {
      if (!l.length) continue;
      const closed = closeLoop(segments, l);
      if (closed === l) { loops.push(l.slice()); continue; }
      if (opts && opts.fillVisible) { loops.push(closed); closedLoops++; }
      else droppedLoops++;
    }
    if (!loops.length) continue;
    const reg = { windingRule: r.windingRule, loops };
    // The stored index, counted before any region is dropped for its loops.
    if (regionFills.has(ri)) { reg.fills = regionFills.get(ri); filledRegions++; }
    regions.push(reg);
  }
  return { value: { vertices, segments, regions }, rightAngle, bad, closedLoops, droppedLoops, filledRegions };
}

// A loop walked segment by segment; where one segment does not meet the next (or the last the
// first), a straight segment is appended to `segments` and put between them. Returns the loop itself
// when it is closed already.
export function closeLoop(segments, loop) {
  const deg = new Map();
  for (const k of loop) { const s = segments[k]; deg.set(s.start, (deg.get(s.start) || 0) + 1); deg.set(s.end, (deg.get(s.end) || 0) + 1); }
  const meets = (a, b) => a.start === b.start || a.start === b.end || a.end === b.start || a.end === b.end;
  let closed = true;
  for (const d of deg.values()) if (d % 2) closed = false;
  for (let a = 0; a < loop.length && loop.length > 1 && closed; a++) if (!meets(segments[loop[a]], segments[loop[(a + 1) % loop.length]])) closed = false;
  if (closed) return loop;
  const out = [];
  const first = segments[loop[0]];
  // Start the walk at the end of the first segment that leads into the second.
  let startV = first.start, cur = first.end;
  if (loop.length > 1) { const s1 = segments[loop[1]]; if (!(first.end === s1.start || first.end === s1.end) && (first.start === s1.start || first.start === s1.end)) { startV = first.end; cur = first.start; } }
  out.push(loop[0]);
  const connect = (from, to) => { segments.push({ start: from, end: to }); out.push(segments.length - 1); };
  for (let a = 1; a < loop.length; a++) {
    const s = segments[loop[a]];
    if (s.start === cur) cur = s.end;
    else if (s.end === cur) cur = s.start;
    else { connect(cur, s.start); cur = s.end; }
    out.push(loop[a]);
  }
  if (cur !== startV) connect(cur, startV);
  return out;
}

// Exact bounds of the segments drawn by the regions (or all segments when there is none).
export function networkBox(v) {
  const segs = new Set();
  if (v.regions.length) for (const r of v.regions) for (const l of r.loops) for (const k of l) segs.add(k);
  else v.segments.forEach((_, k) => segs.add(k));
  let box = null;
  for (const k of [...segs].sort((a, b) => a - b)) {
    const s = v.segments[k], a = v.vertices[s.start], b = v.vertices[s.end];
    const ts = s.tangentStart || { x: 0, y: 0 }, te = s.tangentEnd || { x: 0, y: 0 };
    const d = "M " + a.x + " " + a.y + " C " + (a.x + ts.x) + " " + (a.y + ts.y) + " " + (b.x + te.x) + " " + (b.y + te.y) + " " + b.x + " " + b.y;
    box = unionBox(box, unionBounds(pathBounds(d)));
  }
  return box;
}

// Open ends of a network: vertices met by an odd number of segments.
function openEnds(net) {
  const deg = new Map();
  for (const s of net.segments) { deg.set(s.start, (deg.get(s.start) || 0) + 1); deg.set(s.end, (deg.get(s.end) || 0) + 1); }
  let odd = 0;
  for (const d of deg.values()) if (d % 2) odd++;
  return odd;
}

// The vector props of a VECTOR record from a Pixso VECTOR or CONNECTLINE. Returns false when the node
// has no build source at all (no network and no geometry): the caller does not carry it.
export function vectorProps(cx, n, put, size) {
  const fill = geometryOf(cx, n.fillGeometry);
  const stroke = geometryOf(cx, n.strokeGeometry);
  const vd = n.vectorData;
  let net = null;
  if (vd && vd.vectorNetworkBlob !== undefined && vd.vectorNetworkBlob >= 0) {
    const blob = cx.blob(vd.vectorNetworkBlob);
    if (blob && blob.length) net = decodeVectorNetwork(blob);
  }
  const V = cx.stats.vectors;
  if (net) {
    V.networks++;
    const ns = vd.normalizedSize;
    const sx = ns && isFin(ns.x) && ns.x > 0 && isFin(size.w) ? size.w / ns.x : 1;
    const sy = ns && isFin(ns.y) && ns.y > 0 && isFin(size.h) ? size.h / ns.y : 1;
    const ir = networkToIR(cx, net, sx, sy, vd.styleOverrideTable, { fillVisible: visiblePaint(n.fillPaints), regionPaints: n.vectorPaints });
    if (ir.filledRegions) V.regionFills++;
    if (ir.rightAngle) cx.feature("RIGHT_ANGLE", ir.rightAngle + " vertices");
    if (ir.closedLoops) {
      V.loopsClosed++;
      if (visiblePaint(n.strokePaints) && weightOf(n) > 0) cx.feature("open region loop", "closed for the fill; Figma strokes the closing segment too");
    }
    if (ir.droppedLoops) V.loopsDropped++;
    const onlyOpen = ir.droppedLoops > 0 && !ir.value.regions.length;
    if (ir.bad) { cx.note(CODE.GEOMETRY_INVALID, "a network with a non-finite coordinate"); net = null; }
    else if (!ir.value.regions.length && fill && !onlyOpen) {
      V.fromGeometry++;
      put("fillGeometry", fill);
      if (stroke) put("strokeGeometry", stroke);
      const open = openEnds(net);
      cx.note(CODE.VECTOR_FROM_GEOMETRY, "a network with no region, built from its stored geometry" + (open ? "; " + open + " open ends, closed and stroked by the fill path" : ""));
      return true;
    } else {
      V.fromNetwork++;
      put("vectorNetwork", ir.value);
      // Open loops under no visible fill were dropped: the stored fill geometry draws nothing Figma
      // will draw, so it is no oracle (none means 0 paths, which the network gives).
      if (!fill || onlyOpen) {
        if (ir.value.regions.length) { V.classes["region-no-fill"]++; cx.note(CODE.VECTOR_ORACLE_DIFFERS, "region-no-fill: " + ir.value.regions.length + " regions, no stored fill path"); }
        return true;
      }
      put("oracleFillGeometry", fill);
      if (ir.value.regions.length === fill.length && ir.value.regions.some((r, i) => r.windingRule !== fill[i].windingRule)) {
        V.classes.winding++;
        cx.note(CODE.VECTOR_ORACLE_DIFFERS, "winding: a region's winding is not its stored path's");
      }
      const a = networkBox(ir.value), b = geometryBox(fill);
      if (a && b) {
        const d = Math.max(Math.abs(a.x0 - b.x0), Math.abs(a.y0 - b.y0), Math.abs(a.x1 - b.x1), Math.abs(a.y1 - b.y1));
        if (d > 1) { V.classes["network-bounds"]++; cx.note(CODE.VECTOR_ORACLE_DIFFERS, "network-bounds: " + r2(d) + " px"); }
      }
      return true;
    }
  }
  if (fill) {
    V.fromGeometry++;
    put("fillGeometry", fill);
    if (stroke) put("strokeGeometry", stroke);
    cx.note(CODE.VECTOR_FROM_GEOMETRY, "no vector network, built from its stored geometry");
    return true;
  }
  return false;
}
