// Derived entries: Pixso's resolved boxes of an instance's sublayers, as the IR carries them
// (docs/M2A.md D10, §6 C). Part C owns this file. Its only caller is overrides.mjs instanceData.
//
//   import { derivedEntries } from "./derived.mjs";
//   derivedEntries(cx, n, i, ctx) -> [{ path, at?, size?, transform?, fillGeometry?, strokeGeometry?, lines?, oracleSides? }]
//
// Every derivedSymbolData entry of the stored INSTANCE n (record i) that resolves (resolve.mjs, rules
// A-C) is carried sparse, as stored:
//   size, transform   only when the entry stores them (absent means the master layer's, I; counted
//                     derived.noSize and derived.noTransform);
//   lines             the number of the entry's stored text baselines, when it stores any (withLines);
//   oracleSides       M1 D15's side oracle on the entry's strokePaddingPath, for a rectangle-like target
//                     (FRAME, COMPONENT, RECTANGLE; a nested instance is its master root's look) whose
//                     effective strokes are visible: the layer with the overrides along the path and the
//                     instance's own entry for it (ctx.layerOf), at the entry's size (withOracleSides);
//   fillGeometry, strokeGeometry   values indexes, under --derived-geometry: changed (only where they
//                     differ from the target layer's own stored geometry), all, or none (geometry);
//   at                the record index of every path element, when the master is a record here and every
//                     element has one (else noAt, counted whether or not the entry is written).
// An entry left with nothing to write is not written (empty); one whose first element has no record (a
// folded operand) is kept without `at` (noAt), as D10 says and the validator allows for derived entries
// (part C's request, applied by part E). So resolved = written + empty, and
// entries = resolved + unresolved (gate G1 holds when unresolved is 0). A path that does not resolve
// is not written at all: its `at` would name the layers of a symbol Pixso did not draw.
//
// ctx (part C's own): { local, quiet, layerOf(res, guids) -> { node, type } | null, ignored: [] }: the
// rule C items of every resolution are appended to ctx.ignored (overrides.mjs drops those assignments).
import { canonicalJSON } from "../../ir/schema.mjs";
import { r2, r4, isFin, matrixOf, matrixFinite } from "./util.mjs";
import { geometryOf } from "./vector.mjs";
import { sideOracle, sideRule, visiblePaint } from "./strokes.mjs";

const RECT_LIKE = new Set(["FRAME", "COMPONENT", "RECTANGLE"]);

export function derivedEntries(cx, n, i, ctx) {
  const S = cx.m2a.derived, R = cx.resolver, q = ctx.quiet;
  const mode = (cx.settings && cx.settings.derivedGeometry) || "changed";
  const out = [];
  for (const d of n.derivedSymbolData || []) {
    S.entries++;
    const guids = R.pathGuids(d);
    const res = guids.length ? R.resolve(n, guids) : { ok: false };
    if (!res.ok || res.root) { S.unresolved++; continue; }
    S.resolved++;
    if (res.fallback) { S.viaFallback++; for (const x of res.ignored) ctx.ignored.push(x); }
    const e = { path: guids };
    if (ctx.local && res.elements.every((x) => x.i !== undefined)) e.at = res.elements.map((x) => x.i);
    if (d.size && isFin(d.size.x) && isFin(d.size.y)) e.size = [r2(d.size.x), r2(d.size.y)];
    else S.noSize++;
    if (matrixFinite(d.transform)) e.transform = matrixOf(d.transform).map(r4);
    else S.noTransform++;
    const bl = d.textData && d.textData.baselines;
    if (Array.isArray(bl) && bl.length) { e.lines = bl.length; S.withLines++; }
    if ((d.strokePaddingPath || []).length) {
      const L = ctx.layerOf(res, guids);
      if (L && RECT_LIKE.has(L.type)) {
        const p = Object.assign({}, L.node, { strokePaddingPath: d.strokePaddingPath });
        if (d.size && isFin(d.size.x) && isFin(d.size.y)) p.size = d.size;
        if (visiblePaint(p.strokePaints)) {
          const align = q.en("PixsoNode", "strokeAlign")(p.strokeAlign);
          const o = sideOracle(q, p, sideRule(p), align === undefined ? "absent" : align);
          if (o.sides) { e.oracleSides = o.sides; S.withOracleSides++; }
        }
      }
    }
    if (mode !== "none") {
      const T = res.elements[res.elements.length - 1].n;
      let any = false;
      for (const k of ["fillGeometry", "strokeGeometry"]) {
        if (!(d[k] || []).length) continue;
        const v = geometryOf(q, d[k], { quiet: true });
        if (!v) continue;
        if (mode === "changed") {
          const own = geometryOf(q, T[k], { quiet: true });
          if (own && canonicalJSON(own) === canonicalJSON(v)) continue;
        }
        e[k] = cx.value(v);
        any = true;
      }
      if (any) S.geometry++;
    }
    if (!e.at) S.noAt++;
    if (Object.keys(e).every((k) => k === "path" || k === "at")) { S.empty++; continue; }
    S.written++;
    out.push(e);
  }
  return out;
}
