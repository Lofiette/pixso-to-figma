// The IR builder's state and its write-only creation (docs/M1.md §6 B steps 4 and 7, D4, D6). Part B.
// Bundled as (function (IR) { … })(PXF_IR) after common.js; the build op itself is in build.js.
//
// IR.B, shared by the build-*.js files (each is its own function scope, so they meet here):
//   newBuild(ctx, task) -> st     the state of one build: the task's records by position k (task
//                                 order, parent-first), parentK, the built node per k, its built type,
//                                 and `want`, the box each pass aims at: { rt: [a, b, tx, c, d, ty],
//                                 w, h }, the IR's, changed only where the builder knows better (an S2
//                                 root's grid place, decision 9's widening and its x shift, a vector
//                                 whose origin Figma moved)
//   createPhase(st)               one node per record, parent-first, write-only: DEFAULTS and NEVER_OMIT
//                                 written explicitly through ctx.prop, empty paint lists written,
//                                 strokeWeight before the side weights, text through IR.writeTextProps,
//                                 an INSTANCE as an unstamped placeholder frame (D6), a GROUP as a frame
//                                 with no paints and no clipping (D4), a BOOLEAN_OPERATION as a holder
//                                 frame its operands are built into (build-shapes.js turns it into the
//                                 boolean). Auto layout here under layoutOrder "creation".
//   layoutPhase(st)               auto layout deepest first under layoutOrder "deepestFirst", then the
//                                 child sizes (min and max sizes, layoutSizing*) in both orders
//   writeProps, writeAutoLayout, writeMask, resize, pinText, stampRoot, tick, modeOf, parentMode,
//   isAL, set                     the helpers the other build files use
//   WRITES                        every prop the builder writes, by where; tools/test-irbuild.mjs
//                                 checks that it covers every Figma prop KNOWN_PROPS gives any type
var B = IR.B || (IR.B = {});
var CODE = IR.CODE, U = IR.util;

function own(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }
function msgOf(e) { return String((e && e.message) || e).slice(0, 300); }

var PAINTS = ["fills", "strokes", "effects"];
var PLAIN = ["strokeWeight", "strokeAlign", "strokeJoin", "strokeCap", "strokeMiterLimit", "dashPattern", "cornerRadius",
  "cornerSmoothing", "clipsContent", "opacity", "blendMode", "visible", "locked", "maskType", "layoutGrids",
  "exportSettings", "overflowDirection", "arcData", "pointCount", "innerRadius"];
var SIDE_KEYS = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];
var CORNER_KEYS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
var AUTO_LAYOUT = ["layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems",
  "counterAxisAlignItems", "counterAxisAlignContent", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
  "itemSpacing", "counterAxisSpacing", "itemReverseZIndex", "strokesIncludedInLayout"];
var CHILD_SIZE = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
var SIZING = ["layoutSizingHorizontal", "layoutSizingVertical"];
var CONTAINERS = ["FRAME", "COMPONENT", "SECTION", "BOOLEAN_OPERATION"];

B.WRITES = {
  box: ["relativeTransform", "width", "height"],
  paints: PAINTS, plain: PLAIN.concat(["isMask"]), sides: ["strokeWeights"], corners: ["cornerRadii"],
  autoLayout: ["layoutMode"].concat(AUTO_LAYOUT), childSize: CHILD_SIZE.concat(SIZING),
  childFlow: ["layoutPositioning", "layoutAlign", "layoutGrow", "constraints"],
  geometry: ["vectorNetwork", "fillGeometry", "strokeGeometry"], boolean: ["booleanOperation"],
  // Not written in M1, each for its reason: styles land in M2b (raw values are written), the
  // property references with variants in M2a, inkBounds and lines are measurements, and the oracle
  // never reaches the plugin.
  notWritten: ["fillStyle", "strokeStyle", "textStyle", "effectStyle", "gridStyle", "componentPropertyReferences",
    "inkBounds", "lines", "oracleFillGeometry", "oracleSides"],
};

B.COUNTER_KEYS = ["sizeRepaired", "sizeRejected", "layoutDroppedForSize", "rotPinned", "flowAligned", "flowAbsolute",
  "flowStillOff", "flowRejected", "flowReverted", "flowGroups", "textTrimmed", "textTrimReverted", "constraintsSet",
  "sideStrokes", "vectorsNetwork", "vectorsGeometry", "booleansNative", "imagesPlaced"];

// The guids of the records built in this run, by IR index: a later task's split root may attach to
// a record built by an earlier one, which is then stamped as a task-boundary parent with its guid.
var GUIDS = { run: null, map: {} };
B.guidOf = function (runId, i) { return GUIDS.run === runId && own(GUIDS.map, String(i)) ? GUIDS.map[String(i)] : null; };

B.isAL = function (m) { return m === "HORIZONTAL" || m === "VERTICAL"; };
B.isRotated = function (rt) {
  return Math.abs(rt[0] - 1) > 1e-6 || Math.abs(rt[1]) > 1e-6 || Math.abs(rt[3]) > 1e-6 || Math.abs(rt[4] - 1) > 1e-6;
};
// A record's own auto-layout mode, from the IR (a group, a placeholder and a holder have none).
B.modeOf = function (st, k) {
  var rec = st.recs[k];
  if (rec.type !== "FRAME" && rec.type !== "COMPONENT") return "NONE";
  var m = st.ctx.prop(rec, "layoutMode");
  return m || "NONE";
};
// The mode of the frame a record sits in: its IR parent's, or for a split root the built parent's.
B.parentMode = function (st, k) {
  var pk = st.parentK[k];
  return pk >= 0 ? B.modeOf(st, pk) : st.attachMode[k] || "NONE";
};

// Every loop advances the liveness counter and breathes (never through a timer, P2).
B.tick = function (st, k) { st.ctx.progress(); return st.ctx.breathe(k); };

B.set = function (st, node, i, prop, v) {
  try { node[prop] = v; return true; } catch (e) { st.ctx.failure(i, prop, msgOf(e)); return false; }
};

B.resize = function (node, builtType, w, h) {
  var W = Math.max(0.01, w), H = builtType === "LINE" ? 0 : Math.max(0.01, h);
  if (builtType === "SECTION") node.resizeWithoutConstraints(W, H); else node.resize(W, H);
};

B.newBuild = function (ctx, task) {
  var recs = task.nodes, n = recs.length;
  var st = { ctx: ctx, task: task, recs: recs, n: n, settings: task.settings, pos: {}, parentK: [], kids: [], depth: [],
    node: [], builtType: [], want: [], native: [], fixed: [], isRoot: [], attachTo: [], attach: [], attachMode: [],
    rootKs: [], pinned: {}, rotPinned: {}, flowAbs: {}, textPinned: [], textWidened: [], fontSubs: {}, fontSubOrder: [],
    placeholders: 0, builtCount: 0, counters: {}, images: null,
    detail: { imagesRemapped: 0, typeFallbacks: 0, vectorOriginShifted: 0, flowSiblingGuard: 0, flowSiblingWorst: 0,
      flowGroupNodes: 0, flowGroupsRejected: 0, textTrimSkipped: 0 } };
  for (var c = 0; c < B.COUNTER_KEYS.length; c++) st.counters[B.COUNTER_KEYS[c]] = 0;
  for (var k = 0; k < n; k++) st.pos[recs[k].i] = k;
  for (var k2 = 0; k2 < n; k2++) {
    var r = recs[k2], pk = own(st.pos, r.parent) && r.parent >= 0 ? st.pos[r.parent] : -1;
    st.parentK[k2] = pk;
    st.kids[k2] = [];
    st.depth[k2] = pk >= 0 ? st.depth[pk] + 1 : 0;
    if (pk >= 0) st.kids[pk].push(k2);
    var rt = r.props.relativeTransform;
    st.want[k2] = { rt: [rt[0], rt[1], rt[2], rt[3], rt[4], rt[5]], w: r.props.width, h: r.props.height };
    st.native[k2] = false; st.fixed[k2] = false; st.isRoot[k2] = false; st.attachTo[k2] = null;
  }
  var roots = Array.isArray(task.roots) ? task.roots : [];
  for (var j = 0; j < roots.length; j++) {
    var rk = st.pos[roots[j].i];
    st.isRoot[rk] = true;
    st.attachTo[rk] = roots[j].attachTo;
    st.rootKs.push(rk);
    // An S2 master sits at its grid place on the service page; the judge never compares it (§5.2).
    if (Array.isArray(roots[j].place)) { st.want[rk].rt[2] = roots[j].place[0]; st.want[rk].rt[5] = roots[j].place[1]; }
  }
  st.rootKs.sort(function (a, b) { return a - b; });
  if (GUIDS.run !== task.runId) GUIDS = { run: task.runId, map: {} };
  return st;
};

B.stampRoot = function (st, k, state) {
  var ctx = st.ctx, node = st.node[k], rec = st.recs[k];
  ctx.stamp(node, "pxSrc", rec.guid);
  ctx.stamp(node, "pxIdx", rec.i);
  ctx.stamp(node, "pxRun", st.task.runId);
  ctx.stamp(node, "pxSnap", st.task.snapshot);
  ctx.stamp(node, "pxIr", PXF_SCHEMA.VERSION);
  ctx.stamp(node, "pxState", state);
};

function makeNode(F, builtType) {
  switch (builtType) {
    case "FRAME": return F.createFrame();
    case "COMPONENT": return F.createComponent();
    case "SECTION": return F.createSection();
    case "RECTANGLE": return F.createRectangle();
    case "ELLIPSE": return F.createEllipse();
    case "POLYGON": return F.createPolygon();
    case "STAR": return F.createStar();
    case "LINE": return F.createLine();
    case "VECTOR": return F.createVector();
    case "TEXT": return F.createText();
  }
  throw new Error("no Figma node for built type " + builtType);
}

// Paints, the plain props, the side weights after strokeWeight, the corners, the mask: every prop
// KNOWN_PROPS gives the record's type, with ctx.prop's DEFAULTS where the record leaves one out.
B.writeProps = function (st, k, node) {
  var rec = st.recs[k], ctx = st.ctx, i = rec.i, kinds = PXF_PROPS.KNOWN_PROPS[rec.type] || {};
  for (var a = 0; a < PAINTS.length; a++) {
    var p = PAINTS[a];
    if (!own(kinds, p)) continue;
    var v = ctx.prop(rec, p);
    if (v === undefined) continue;
    if (p !== "effects") v = IR.mapPaints(ctx, v, i);
    B.set(st, node, i, p, v);
  }
  for (var b = 0; b < PLAIN.length; b++) {
    var q = PLAIN[b];
    if (!own(kinds, q)) continue;
    if (q === "cornerRadius" && rec.props.cornerRadii !== undefined) continue;
    var w = ctx.prop(rec, q);
    if (w === undefined) continue;
    // A full sweep is written as exactly 2π past its start: Figma stores the angle in 32 bits, and
    // 6.283185 (the IR's six decimals) lands one step below its own 2π, an arc a hair short of a
    // closed ellipse whose stroke would draw a radial seam (builder4/pack4 never wrote a full one).
    if (q === "arcData" && w && typeof w.endingAngle === "number" && typeof w.startingAngle === "number" &&
      Math.abs(w.endingAngle - w.startingAngle - 2 * Math.PI) < 1e-5) {
      w = { startingAngle: w.startingAngle, endingAngle: w.startingAngle + 2 * Math.PI, innerRadius: w.innerRadius || 0 };
    }
    B.set(st, node, i, q, w);
  }
  // Assigning strokeWeight resets the four sides, so they come after it (builder4.js:181-191).
  if (Array.isArray(rec.props.strokeWeights)) {
    for (var s = 0; s < 4; s++) B.set(st, node, i, SIDE_KEYS[s], rec.props.strokeWeights[s]);
    st.counters.sideStrokes++;
  }
  if (Array.isArray(rec.props.cornerRadii)) for (var c = 0; c < 4; c++) B.set(st, node, i, CORNER_KEYS[c], rec.props.cornerRadii[c]);
  if (own(kinds, "isMask")) B.writeMask(st, k, node, ctx.prop(rec, "isMask"));
};

// A mask on a node built as a frame (a group, D4): P19B says whether Figma takes it. A refusal or a
// mask that does not hold is MASK_UNSUPPORTED, and the node stays unmasked.
B.writeMask = function (st, k, node, v) {
  var ctx = st.ctx, i = st.recs[k].i, bt = st.builtType[k];
  if (v !== true) { B.set(st, node, i, "isMask", false); return; }
  if (bt !== "FRAME" && bt !== "COMPONENT") { B.set(st, node, i, "isMask", true); return; }
  try { node.isMask = true; } catch (e) { ctx.code(CODE.MASK_UNSUPPORTED, i, "refused: " + msgOf(e)); return; }
  var kept = false;
  try { kept = node.isMask === true; } catch (e2) { kept = false; }
  if (!kept) ctx.code(CODE.MASK_UNSUPPORTED, i, "ignored: the frame did not keep the mask");
};

// Auto layout on a FRAME or COMPONENT record: layoutMode always (NEVER_OMIT), and with a flow the
// rest, each where Figma takes it (wrap on a horizontal flow only; the wrap's own props under WRAP).
B.writeAutoLayout = function (st, k, node) {
  var rec = st.recs[k], ctx = st.ctx, i = rec.i, kinds = PXF_PROPS.KNOWN_PROPS[rec.type] || {};
  if (!own(kinds, "layoutMode") || (st.builtType[k] !== "FRAME" && st.builtType[k] !== "COMPONENT")) return;
  var mode = ctx.prop(rec, "layoutMode") || "NONE";
  B.set(st, node, i, "layoutMode", mode);
  if (!B.isAL(mode)) return;
  var wrap = ctx.prop(rec, "layoutWrap");
  for (var a = 0; a < AUTO_LAYOUT.length; a++) {
    var p = AUTO_LAYOUT[a];
    if (!own(kinds, p)) continue;
    if (p === "layoutWrap" && mode !== "HORIZONTAL") continue;
    if ((p === "counterAxisAlignContent" || p === "counterAxisSpacing") && wrap !== "WRAP") continue;
    var v = ctx.prop(rec, p);
    if (v === undefined) continue;
    B.set(st, node, i, p, v);
  }
};

// Min and max sizes, and layoutSizing* where Figma takes them: HUG on a flow frame or a text, FILL
// in a flow. Elsewhere they say nothing the axis sizing modes and layoutAlign/layoutGrow do not.
B.writeChildSizes = function (st, k) {
  var rec = st.recs[k], ctx = st.ctx, i = rec.i, node = st.node[k], kinds = PXF_PROPS.KNOWN_PROPS[rec.type] || {};
  if (rec.type === "INSTANCE" || st.fixed[k]) return;
  for (var a = 0; a < CHILD_SIZE.length; a++) {
    var p = CHILD_SIZE[a];
    if (!own(kinds, p)) continue;
    var v = ctx.prop(rec, p);
    if (v !== undefined) B.set(st, node, i, p, v);
  }
  for (var b = 0; b < SIZING.length; b++) {
    var q = SIZING[b];
    if (!own(kinds, q)) continue;
    var w = ctx.prop(rec, q);
    if (w === undefined) continue;
    if (w === "HUG" && !(B.isAL(B.modeOf(st, k)) || st.builtType[k] === "TEXT")) continue;
    if (w === "FILL" && !B.isAL(B.parentMode(st, k))) continue;
    B.set(st, node, i, q, w);
  }
};

// The text box pin (builder4.js:225-230): Figma's metrics are not Pixso's, so where the built box
// differs from the source's by more than half a pixel, the box is fixed at the source's. Reads layout,
// unless the size read before is given ([width, height]: MEASURE reads every text first, then pins).
B.pinText = function (st, k, size) {
  var node = st.node[k], rec = st.recs[k], w = st.want[k].w, h = st.want[k].h;
  var nw = size ? size[0] : node.width, nh = size ? size[1] : node.height;
  if (Math.abs(nw - w) <= 0.5 && Math.abs(nh - h) <= 0.5) return false;
  B.set(st, node, rec.i, "textAutoResize", "NONE");
  try { B.resize(node, "TEXT", w, h); st.textPinned.push(rec.i); return true; }
  catch (e) { st.ctx.failure(rec.i, "resize", msgOf(e)); return false; }
};

function countFontSubs(st, k) {
  var ctx = st.ctx, rec = st.recs[k], seen = {}, subs = [];
  var fonts = [ctx.prop(rec, "fontName")];
  var ranges = Array.isArray(rec.props.textRanges) ? rec.props.textRanges : [];
  for (var r = 0; r < ranges.length; r++) if (ranges[r].fields && ranges[r].fields.fontName !== undefined) fonts.push(ctx.value(ranges[r].fields.fontName));
  for (var f = 0; f < fonts.length; f++) {
    var font = fonts[f];
    if (!font) continue;
    var key = String(font.family) + "|" + String(font.style);
    if (seen[key] || ctx.S.fonts[key] !== "sub") continue;
    seen[key] = 1;
    subs.push(font.family + " " + font.style);
    if (!own(st.fontSubs, key)) { st.fontSubs[key] = { family: String(font.family), style: String(font.style), nodes: 0 }; st.fontSubOrder.push(key); }
    st.fontSubs[key].nodes++;
  }
  if (subs.length) {
    var fb = st.settings.fallbackFont;
    ctx.code(CODE.FONT_SUBSTITUTED, rec.i, subs.join(", ") + " -> " + fb.family + " " + fb.style);
  }
}

function createOne(st, k) {
  var ctx = st.ctx, F = ctx.figma, rec = st.recs[k], i = rec.i;
  var parent = st.parentK[k] >= 0 ? st.node[st.parentK[k]] : st.attach[k];
  // A boolean is made from its operands (build-shapes.js); until then they live in a holder frame.
  var bt = rec.type === "BOOLEAN_OPERATION" ? "FRAME" : U.builtType(rec.type);
  var node = makeNode(F, bt);
  try { parent.appendChild(node); }
  catch (e) {
    // Figma will not put every type everywhere (a section in a frame, a component in a component):
    // the record is built as a frame, and the loss is a failure entry.
    try { node.remove(); } catch (e2) {}
    ctx.failure(i, "type", "a " + bt + " cannot sit in its parent (" + msgOf(e) + "); built as a FRAME");
    st.detail.typeFallbacks++;
    bt = "FRAME";
    node = F.createFrame();
    parent.appendChild(node);
  }
  st.node[k] = node;
  st.builtType[k] = bt;
  ctx.S.nodes[String(i)] = node.id;
  GUIDS.map[String(i)] = rec.guid;
  node.name = String(rec.name);
  B.set(st, node, i, "relativeTransform", U.matrix(st.want[k].rt));
  // A vector's size is its paths' (Figma sizes it from them), and resizing would scale them.
  if (rec.type !== "VECTOR") {
    try { B.resize(node, bt, st.want[k].w, st.want[k].h); } catch (e3) { ctx.failure(i, "resize", msgOf(e3)); }
  }
  var creation = st.settings.layoutOrder !== "deepestFirst";
  if (rec.type === "INSTANCE") {
    // D6: a placeholder with the instance's box, visibility and child-layout props (written by the
    // place passes), nothing drawn, no flow, fixed size, and no stamp: VERIFY counts it by alignment.
    B.set(st, node, i, "fills", []); B.set(st, node, i, "strokes", []); B.set(st, node, i, "effects", []);
    B.set(st, node, i, "clipsContent", false); B.set(st, node, i, "layoutMode", "NONE");
    B.set(st, node, i, "visible", ctx.prop(rec, "visible")); B.set(st, node, i, "locked", ctx.prop(rec, "locked"));
    ctx.code(CODE.INSTANCE_DEFERRED, i, null);
    st.placeholders++;
  } else if (rec.type === "BOOLEAN_OPERATION") {
    B.set(st, node, i, "fills", []); B.set(st, node, i, "strokes", []);
    B.set(st, node, i, "clipsContent", false); B.set(st, node, i, "layoutMode", "NONE");
    B.set(st, node, i, "visible", ctx.prop(rec, "visible"));
    st.builtCount++;
  } else if (rec.type === "GROUP") {
    // D4: a frame that paints nothing and clips nothing (builder4.js:215-217).
    B.set(st, node, i, "fills", []); B.set(st, node, i, "strokes", []);
    B.set(st, node, i, "clipsContent", false); B.set(st, node, i, "layoutMode", "NONE");
    B.writeProps(st, k, node);
    st.builtCount++;
  } else if (rec.type === "TEXT") {
    // Paints first: a node fill written after the ranges would erase the range fills.
    B.writeProps(st, k, node);
    try { IR.writeTextProps(ctx, node, rec); } catch (e4) { ctx.failure(i, "fontName", msgOf(e4)); }
    countFontSubs(st, k);
    // P6 only: the in-loop read of builder4.js:227 (layout reads during creation).
    if (st.settings.textRead === "inLoop") B.pinText(st, k);
    st.builtCount++;
  } else {
    B.writeProps(st, k, node);
    if (creation) B.writeAutoLayout(st, k, node);
    st.builtCount++;
  }
  // A root is stamped at once, as partial: a task that dies leaves a root a later clean can find.
  if (st.isRoot[k]) B.stampRoot(st, k, "partial");
}

B.createPhase = async function (st) {
  for (var k = 0; k < st.n; k++) {
    await B.tick(st, k);
    createOne(st, k);
  }
};

B.layoutPhase = async function (st) {
  if (st.settings.layoutOrder === "deepestFirst") {
    var order = [];
    for (var k = 0; k < st.n; k++) order.push(k);
    order.sort(function (a, b) { return st.depth[b] - st.depth[a] || a - b; });
    for (var j = 0; j < order.length; j++) {
      await B.tick(st, j);
      var kk = order[j];
      if (st.recs[kk].type === "FRAME" || st.recs[kk].type === "COMPONENT") B.writeAutoLayout(st, kk, st.node[kk]);
    }
  }
  for (var k2 = 0; k2 < st.n; k2++) {
    await B.tick(st, k2);
    B.writeChildSizes(st, k2);
  }
};

B.CONTAINERS = CONTAINERS;
