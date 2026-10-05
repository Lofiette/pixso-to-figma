// The double's layout engine (docs/M1.md §6 E): auto layout, text auto-size, boolean boxes, and the
// constraints a resize applies. Part E owns it (§9). It works on the double's node states (index.mjs):
//   st = { type, parent, children: [st] | null, rt: [[a, b, tx], [c, d, ty]], w, h, props }
// and is handed the hooks it cannot know: H.text(st, wrapWidth|null) -> { width, height } (the text
// model), H.boolean(st) (re-derives a boolean's box from its operands), H.setSize(st, w, h) (a size
// change made by the engine: vectors scale, constraints apply to the children a resize moves).
//
// What it models, from Figma's documented behaviour and builder4's measured comments (C where
// builder4 measured it, I otherwise):
//   - layoutMode HORIZONTAL / VERTICAL; padding; itemSpacing (negative too); primaryAxisAlignItems MIN,
//     CENTER, MAX, SPACE_BETWEEN (one child: at the start, I); counterAxisAlignItems MIN, CENTER, MAX
//     (BASELINE as MIN, I); a child's layoutAlign MIN / CENTER / MAX ignored, the parent's alignment
//     placing it (deprecated values; docs/FINDINGS.md: 23 children taken out of flow, 0 aligned by
//     them, C; part F, review figma F4);
//   - primaryAxisSizingMode / counterAxisSizingMode AUTO hug their flow children, FIXED keep the size;
//   - layoutGrow > 0 shares the free primary space (only in a FIXED primary axis), layoutAlign STRETCH
//     takes the inner counter size (only in a FIXED counter axis; in a hugging one the child keeps its
//     size and follows the counter alignment, builder4:389-390, C);
//   - hidden children and layoutPositioning ABSOLUTE are out of the flow (builder4:387-388, C);
//   - the padding floor: an auto-layout frame is never smaller than its padding on the flow axis
//     (builder4:302-306, C); min and max sizes clamp frames and their flow children;
//   - an INSIDE stroke is outside the content box unless strokesIncludedInLayout (I);
//   - layoutWrap WRAP (horizontal): rows broken at the inner width, counterAxisSpacing between rows,
//     counterAxisAlignContent AUTO or SPACE_BETWEEN (I);
//   - text: WIDTH_AND_HEIGHT sizes both, HEIGHT wraps at the width, NONE keeps the box; a text the
//     flow stretches wraps at the width it is given;
//   - a flow child is placed by its box; its rotation is dropped when written (index.mjs, C).
const HV = (st) => st.props.layoutMode === "HORIZONTAL" || st.props.layoutMode === "VERTICAL";
export const isAutoLayout = (st) => (st.type === "FRAME" || st.type === "COMPONENT") && HV(st);
export const inFlow = (st) => !!(st.parent && isAutoLayout(st.parent) && st.props.visible !== false && st.props.layoutPositioning !== "ABSOLUTE");
const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);

// Does the flow decide this child's width (or height)?
export function flowFills(st, axis) {
  if (!inFlow(st)) return false;
  const p = st.parent, horiz = p.props.layoutMode === "HORIZONTAL";
  const primary = (axis === "w") === horiz;
  if (primary) return num(st.props.layoutGrow, 0) > 0 && p.props.primaryAxisSizingMode === "FIXED";
  return st.props.layoutAlign === "STRETCH" && p.props.counterAxisSizingMode === "FIXED";
}

function clampW(st, w) {
  const lo = num(st.props.minWidth, null), hi = num(st.props.maxWidth, null);
  if (hi !== null && w > hi) w = hi;
  if (lo !== null && w < lo) w = lo;
  return w;
}
function clampH(st, h) {
  const lo = num(st.props.minHeight, null), hi = num(st.props.maxHeight, null);
  if (hi !== null && h > hi) h = hi;
  if (lo !== null && h < lo) h = lo;
  return h;
}
function pads(st) {
  const P = st.props;
  const p = { l: num(P.paddingLeft, 0), r: num(P.paddingRight, 0), t: num(P.paddingTop, 0), b: num(P.paddingBottom, 0) };
  if (P.strokesIncludedInLayout === true && P.strokeAlign === "INSIDE" && Array.isArray(P.strokes) && P.strokes.some((s) => s && s.visible !== false)) {
    p.l += num(P.strokeLeftWeight, 0); p.r += num(P.strokeRightWeight, 0); p.t += num(P.strokeTopWeight, 0); p.b += num(P.strokeBottomWeight, 0);
  }
  return p;
}
// A child's box in its parent's space: its size under its own linear part.
function box(st) {
  const m = st.rt;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cx, cy] of [[0, 0], [st.w, 0], [0, st.h], [st.w, st.h]]) {
    const px = m[0][0] * cx + m[0][1] * cy, py = m[1][0] * cx + m[1][1] * cy;
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  return { ox: x0, oy: y0, w: x1 - x0, h: y1 - y0 };
}
function place(st, x, y, changed) {
  const b = box(st), tx = x - b.ox, ty = y - b.oy;
  if (Math.abs(st.rt[0][2] - tx) > 1e-9 || Math.abs(st.rt[1][2] - ty) > 1e-9) { st.rt[0][2] = tx; st.rt[1][2] = ty; changed.n++; }
}
function resize(H, st, w, h, changed) {
  if (Math.abs(st.w - w) > 1e-9 || Math.abs(st.h - h) > 1e-9) { H.setSize(st, w, h); changed.n++; }
}

function textPass(H, st, changed) {
  const mode = st.props.textAutoResize;
  const fw = flowFills(st, "w"), fh = flowFills(st, "h");
  if (fw) {
    if (mode !== "NONE" && mode !== "TRUNCATE" && !fh) resize(H, st, st.w, H.text(st, st.w).height, changed);
    return;
  }
  if (mode === "WIDTH_AND_HEIGHT") { const m = H.text(st, null); resize(H, st, m.width, fh ? st.h : m.height, changed); }
  else if (mode === "HEIGHT" && !fh) resize(H, st, st.w, H.text(st, st.w).height, changed);
}

function arrange(H, st, changed) {
  const P = st.props, horiz = P.layoutMode === "HORIZONTAL";
  const pd = pads(st);
  const pS = horiz ? pd.l : pd.t, pE = horiz ? pd.r : pd.b, cS = horiz ? pd.t : pd.l, cE = horiz ? pd.b : pd.r;
  const kids = (st.children || []).filter((c) => c.props.visible !== false && c.props.layoutPositioning !== "ABSOLUTE");
  const primSize = (c) => (horiz ? box(c).w : box(c).h), cntSize = (c) => (horiz ? box(c).h : box(c).w);
  const gap = num(P.itemSpacing, 0);
  const primFixed = P.primaryAxisSizingMode === "FIXED", cntFixed = P.counterAxisSizingMode === "FIXED";
  const wrap = horiz && P.layoutWrap === "WRAP" && primFixed;
  const growers = primFixed ? kids.filter((c) => num(c.props.layoutGrow, 0) > 0) : [];
  const stretchers = cntFixed ? kids.filter((c) => c.props.layoutAlign === "STRETCH") : [];

  // 1. The frame's own size: hug the flow on AUTO axes, then clamp.
  let prim = horiz ? st.w : st.h, cnt = horiz ? st.h : st.w;
  const rows = [];
  if (wrap) {
    const inner = prim - pS - pE;
    let row = [], used = 0;
    for (const c of kids) {
      const s = primSize(c);
      if (row.length && used + gap + s > inner + 0.01) { rows.push(row); row = []; used = 0; }
      used += (row.length ? gap : 0) + s; row.push(c);
    }
    if (row.length) rows.push(row);
  } else rows.push(kids);
  const rowCnt = (row) => row.reduce((m, c) => Math.max(m, stretchers.indexOf(c) >= 0 && !wrap ? 0 : cntSize(c)), 0);
  const cGap = num(P.counterAxisSpacing, 0);
  if (!primFixed) prim = kids.reduce((n, c) => n + primSize(c), 0) + gap * Math.max(0, kids.length - 1) + pS + pE;
  if (!cntFixed) cnt = rows.reduce((n, r) => n + rowCnt(r), 0) + cGap * Math.max(0, rows.length - 1) + cS + cE;
  prim = Math.max(prim, pS + pE);
  let w = horiz ? prim : cnt, h = horiz ? cnt : prim;
  w = clampW(st, w); h = clampH(st, h);
  if (!flowFills(st, "w") && !flowFills(st, "h")) resize(H, st, w, h, changed);
  else resize(H, st, flowFills(st, "w") ? st.w : w, flowFills(st, "h") ? st.h : h, changed);
  prim = horiz ? st.w : st.h; cnt = horiz ? st.h : st.w;

  // 2. Fill: growers share the free primary space, stretchers take the inner counter size.
  const innerP = prim - pS - pE, innerC = cnt - cS - cE;
  if (growers.length && !wrap) {
    const fixedSum = kids.filter((c) => growers.indexOf(c) < 0).reduce((n, c) => n + primSize(c), 0);
    const free = innerP - fixedSum - gap * Math.max(0, kids.length - 1);
    const total = growers.reduce((n, c) => n + num(c.props.layoutGrow, 0), 0);
    for (const c of growers) {
      const s = Math.max(0, free * num(c.props.layoutGrow, 0) / total);
      if (horiz) resize(H, c, clampW(c, s), c.h, changed); else resize(H, c, c.w, clampH(c, s), changed);
    }
  }
  for (const c of stretchers) {
    if (horiz) resize(H, c, c.w, clampH(c, Math.max(0, innerC)), changed); else resize(H, c, clampW(c, Math.max(0, innerC)), c.h, changed);
  }

  // 3. Positions.
  let cPos = cS;
  const rowHeights = rows.map(rowCnt);
  let rowGap = cGap;
  if (wrap && P.counterAxisAlignContent === "SPACE_BETWEEN" && rows.length > 1) {
    rowGap = (innerC - rowHeights.reduce((n, x) => n + x, 0)) / (rows.length - 1);
  }
  rows.forEach((row, ri) => {
    const sizes = row.map(primSize), sum = sizes.reduce((n, x) => n + x, 0);
    let g = gap, start = pS;
    const al = P.primaryAxisAlignItems || "MIN";
    const span = sum + gap * Math.max(0, row.length - 1);
    if (al === "SPACE_BETWEEN") { g = row.length > 1 ? (innerP - sum) / (row.length - 1) : 0; }
    else if (al === "CENTER") start = pS + (innerP - span) / 2;
    else if (al === "MAX") start = pS + innerP - span;
    const lineC = wrap ? rowHeights[ri] : innerC;
    let p = start;
    row.forEach((c, k) => {
      let ca = P.counterAxisAlignItems || "MIN";
      if (ca === "BASELINE") ca = "MIN";
      const cs = cntSize(c);
      let q = cPos;
      if (stretchers.indexOf(c) < 0 || wrap) {
        if (ca === "CENTER") q = cPos + (lineC - cs) / 2;
        else if (ca === "MAX") q = cPos + lineC - cs;
      }
      if (horiz) place(c, p, q, changed); else place(c, q, p, changed);
      p += sizes[k] + g;
    });
    cPos += (wrap ? rowHeights[ri] : innerC) + rowGap;
  });
}

function visit(H, st, changed) {
  for (const c of st.children || []) visit(H, c, changed);
  if (st.type === "TEXT") textPass(H, st, changed);
  if (st.type === "BOOLEAN_OPERATION") { const before = [st.w, st.h, st.rt[0][2], st.rt[1][2]].join(","); H.boolean(st); if ([st.w, st.h, st.rt[0][2], st.rt[1][2]].join(",") !== before) changed.n++; }
  if (isAutoLayout(st)) arrange(H, st, changed);
}

// Lays out one top-level tree until it stops moving (at most eight passes: a fill child's width
// feeds its wrapped height, which feeds its hugging parent, and so on up).
export function layoutTree(H, root) {
  for (let pass = 0; pass < 8; pass++) {
    const changed = { n: 0 };
    visit(H, root, changed);
    if (!changed.n) return pass + 1;
  }
  return 8;
}

// What a resize of `st` from (ow, oh) does to its children: their constraints, unless the flow
// places them (docs: constraints govern a node when its parent is resized; builder4:676-693).
export function applyConstraints(H, st, ow, oh) {
  const dw = st.w - ow, dh = st.h - oh, sx = ow ? st.w / ow : 1, sy = oh ? st.h / oh : 1;
  if (!dw && !dh) return;
  for (const c of st.children || []) {
    if (inFlow(c)) continue;
    const k = c.props.constraints || { horizontal: "MIN", vertical: "MIN" };
    let x = c.rt[0][2], y = c.rt[1][2], w = c.w, h = c.h;
    switch (k.horizontal) {
      case "MAX": x += dw; break;
      case "CENTER": x += dw / 2; break;
      case "STRETCH": w = Math.max(0, w + dw); break;
      case "SCALE": x *= sx; w *= sx; break;
      default: break;
    }
    switch (k.vertical) {
      case "MAX": y += dh; break;
      case "CENTER": y += dh / 2; break;
      case "STRETCH": h = Math.max(0, h + dh); break;
      case "SCALE": y *= sy; h *= sy; break;
      default: break;
    }
    c.rt[0][2] = x; c.rt[1][2] = y;
    if (w !== c.w || h !== c.h) H.setSize(c, w, h);
  }
}
