// The IR builder's build and clean ops (docs/M1.md §6 B). Part B. Bundled as
// (function (IR) { … })(PXF_IR) after common.js and the build-*.js files it calls through IR.B:
// build-create.js (state, creation, layout), build-fonts.js (the fonts op and phase),
// build-images.js (images), build-shapes.js (vectors, booleans), build-passes.js (measure and the
// ported passes). Text is written by text.js (IR.writeTextProps).
//
//   IR.ops.build(ctx, task) -> Promise<buildReport>
//     buildReport = { op: "build", taskNo, runId, plugin, roots: [{ i, id }], built, placeholders,
//       ms: { fonts, images, pages, create, vectors, booleans, layout, settle, measure, repair1, place1,
//             repair2, place2, flowGroup, flow1, flow2, repair3, place3, textLine, constraints, stamp },
//       msTotal, storedNodes, codes: { CODE: n }, coded: [{ code, i, detail }], failures: [{ i, prop, msg }],
//       fontSubs: [{ family, style, nodes }], textWidened: [i], textPinned: [i],
//       counters: { sizeRepaired, sizeRejected, layoutDroppedForSize, rotPinned, flowAligned, flowAbsolute,
//                   flowStillOff, flowRejected, flowReverted, flowGroups, textTrimmed, textTrimReverted,
//                   constraintsSet, sideStrokes, vectorsNetwork, vectorsGeometry, booleansNative, imagesPlaced },
//       settings, detail }
//     built: the records built as themselves (every one but the INSTANCE placeholders); placeholders:
//     the INSTANCE records, each a placeholder frame with an INSTANCE_DEFERRED code; storedNodes:
//     the task's records (an INSTANCE counts 1). ms has an entry for every phase of IR.BUILD_PHASES,
//     in order, every one of them run (an empty phase books 0). detail holds what builder4 reported
//     beside its counters (flowSiblingGuard, flowSiblingWorst, flowGroupNodes, flowGroupsRejected,
//     textTrimSkipped) and imagesRemapped (render images whose Figma hash differs), typeFallbacks
//     (records Figma would not take as their type where they sit, built as frames, each a failure
//     entry) and vectorOriginShifted.
//     Phases: fonts, images, pages (the task's page found by its pxPage and pxSnap stamps, or made
//     and stamped with both, so two .pix migrated into one Figma file never share a page or the
//     service page, though page guids such as "0:1" repeat across files;
//     a split root's built parent found and stamped as a task-boundary parent), create, vectors,
//     booleans and layout write and never read layout (layout under deepestFirst too; under
//     creation the auto layout is written at creation, as builder4 does), settle once, measure,
//     the ported passes, constraints, stamp (roots pxState "built", components pxDef).
//     MEASURE (part F): when a text will be measured (textFit widen and a one-line TEXT), part C's
//     IR.prepareMeasure loads the service page and makes the scratch node first, and IR.dropScratch
//     removes it when the phase ends, thrown or not, so a build leaves no scratch behind.
//     Records ctx.S.nodes[i] for every record and ctx.S.pages[index] (the service page under
//     "m1-service").
//     A task error refuses (e.refused): not a build task, no page, no root, a type M1 does not
//     build, a VECTOR without exactly one build source or built from geometry without its note
//     (docs/M1.md §5.2), a split root whose parent cannot be found, a fallback font that will not
//     load. A Figma throw on one node is a counted fallback or a failure entry.
//
//   IR.ops.clean(ctx, task) -> Promise<{ op: "clean", taskNo, runId, removed, kept, ms, codes, coded, failures }>
//     Removes every top-level node of a page (never a page, the document or a nested node: the
//     guard rule of figma-plugin/src/code.js cmdClean) stamped pxSrc with a task root's guid,
//     pxSnap = task.snapshot and pxRun other than task.runId; kept counts the ones this run built.
//     With task.page the search is that page (found by pxPage and pxSnap; none means nothing to
//     clean), with page null every page, each loaded first.
var B = IR.B || (IR.B = {});
var CODE = IR.CODE, U = IR.util;

function own(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }
function msgOf(e) { return String((e && e.message) || e).slice(0, 300); }
function refuse(m) { U.refuse("build: " + m); }

// What the builder relies on, checked again here (code.js has run validateTask): a malformed task
// is refused before anything is created.
function checkTask(ctx, task) {
  if (!task || task.op !== "build") U.refuse("the build op runs a build task; this one is " + JSON.stringify(task && task.op));
  if (!task.page || typeof task.page !== "object") refuse("a build task names its page");
  if (!Array.isArray(task.nodes) || !task.nodes.length) refuse("a build task carries records");
  if (!Array.isArray(task.roots) || !task.roots.length) refuse("a build task has at least one root");
  var noted = {};
  for (var j = 0; j < (task.notes || []).length; j++) {
    var nt = task.notes[j];
    if (PXF_SCHEMA.GEOMETRY_SOURCE_CODES.indexOf(nt.code) >= 0) noted[nt.i] = 1;
  }
  var seen = {};
  for (var k = 0; k < task.nodes.length; k++) {
    var r = task.nodes[k];
    if (!U.builtType(r.type)) refuse("record " + r.i + " is a " + r.type + ", which M1 does not build");
    if (!r.props || !Array.isArray(r.props.relativeTransform) || r.props.relativeTransform.length !== 6) refuse("record " + r.i + " has no relativeTransform");
    if (r.parent >= 0 && !own(seen, r.parent) && !task.roots.some(function (x) { return x.i === r.i; })) refuse("record " + r.i + " comes before its parent " + r.parent + ", or is a root the task does not list");
    seen[r.i] = 1;
    if (r.type === "VECTOR") {
      var src = (r.props.vectorNetwork !== undefined ? 1 : 0) + (r.props.fillGeometry !== undefined ? 1 : 0);
      if (src !== 1) refuse("VECTOR record " + r.i + " carries " + src + " build sources; exactly one, vectorNetwork or fillGeometry");
      if (r.props.fillGeometry !== undefined && !noted[r.i]) refuse("VECTOR record " + r.i + " is built from fillGeometry without a note saying why (" + PXF_SCHEMA.GEOMETRY_SOURCE_CODES.join(", ") + ")");
    }
  }
}

// ---------- pages ----------
// A page of this snapshot: its pxPage key and pxSnap both. A page stamped before pages carried
// pxSnap matches none, and the task makes a new one.
function pageIs(ctx, page, key) {
  return ctx.stampOf(page, "pxPage") === key && ctx.stampOf(page, "pxSnap") === String(ctx.task.snapshot);
}
async function findPage(ctx, key, regKey) {
  var F = ctx.figma;
  if (own(ctx.S.pages, regKey)) {
    var known = await F.getNodeByIdAsync(String(ctx.S.pages[regKey]));
    if (known && !known.removed && known.type === "PAGE" && pageIs(ctx, known, key)) return known;
  }
  var pages = F.root.children;
  for (var p = 0; p < pages.length; p++) if (pageIs(ctx, pages[p], key)) return pages[p];
  return null;
}

// A split root's parent, built by an earlier task of this run (the session's registry) or found by
// its stamps (ctx.findRoot), and stamped as a task-boundary parent so a later task, or a plugin
// restarted mid-run, finds it the same way.
async function boundaryParent(st, i) {
  var ctx = st.ctx, F = ctx.figma, node = null;
  if (own(ctx.S.nodes, String(i))) {
    var known = await F.getNodeByIdAsync(String(ctx.S.nodes[String(i)]));
    if (known && !known.removed) node = known;
  }
  if (!node) node = await ctx.findRoot(i);
  if (!node) refuse("the built parent " + i + " of a split root is not found: its task has not been built in this run, and nothing carries its stamps");
  var guid = B.guidOf(st.task.runId, i);
  if (guid !== null) ctx.stamp(node, "pxSrc", guid);
  ctx.stamp(node, "pxIdx", i);
  ctx.stamp(node, "pxRun", st.task.runId);
  ctx.stamp(node, "pxSnap", st.task.snapshot);
  ctx.stamp(node, "pxIr", PXF_SCHEMA.VERSION);
  if (!ctx.stampOf(node, "pxState")) ctx.stamp(node, "pxState", "built");
  ctx.S.nodes[String(i)] = node.id;
  return node;
}

async function pagesPhase(st) {
  var ctx = st.ctx, F = ctx.figma, pg = st.task.page;
  var key = pg.service ? PXF_TASK.SERVICE_PAGE_GUID : String(pg.guid);
  var regKey = pg.service ? PXF_TASK.SERVICE_PAGE_GUID : String(pg.index);
  ctx.progress();
  var page = await findPage(ctx, key, regKey);
  if (!page) {
    page = F.createPage();
    page.name = String(pg.name);
    ctx.stamp(page, "pxPage", key);
    ctx.stamp(page, "pxSnap", st.task.snapshot);
  }
  if (pg.background !== null && pg.background !== undefined) {
    try { page.backgrounds = IR.mapPaints(ctx, ctx.value(pg.background), null); }
    catch (e) { ctx.failure(null, "page.backgrounds", msgOf(e)); }
  }
  ctx.S.pages[regKey] = page.id;
  if (F.currentPage.id !== page.id) await F.setCurrentPageAsync(page);
  ctx.progress();
  st.page = page;
  for (var r = 0; r < st.rootKs.length; r++) {
    var k = st.rootKs[r], to = st.attachTo[k];
    if (to === "page") { st.attach[k] = page; st.attachMode[k] = "NONE"; continue; }
    var parent = await boundaryParent(st, to.i);
    st.attach[k] = parent;
    var mode = "NONE";
    if (parent.type === "FRAME" || parent.type === "COMPONENT") { try { mode = parent.layoutMode || "NONE"; } catch (e2) { mode = "NONE"; } }
    st.attachMode[k] = mode;
  }
}

// ---------- stamps ----------
async function stampPhase(st) {
  var ctx = st.ctx;
  for (var k = 0; k < st.n; k++) {
    await B.tick(st, k);
    if (st.isRoot[k]) B.stampRoot(st, k, "built");
    if (st.recs[k].type === "COMPONENT" && st.builtType[k] === "COMPONENT") ctx.stamp(st.node[k], "pxDef", st.recs[k].guid);
  }
}

function report(st, t0) {
  var ctx = st.ctx, R = ctx.report;
  R.plugin = typeof PXF_VERSION !== "undefined" ? PXF_VERSION : null;
  R.roots = st.rootKs.map(function (k) { return { i: st.recs[k].i, id: st.node[k].id }; });
  R.built = st.builtCount;
  R.placeholders = st.placeholders;
  R.msTotal = Date.now() - t0;
  R.storedNodes = st.n;
  R.fontSubs = st.fontSubOrder.map(function (k) { return st.fontSubs[k]; });
  R.textWidened = st.textWidened;
  R.textPinned = st.textPinned;
  st.counters.imagesPlaced = st.images ? st.images.placed : 0;
  st.detail.imagesRemapped = st.images ? st.images.remapped : 0;
  R.counters = st.counters;
  R.settings = JSON.parse(JSON.stringify(st.settings));
  R.detail = st.detail;
  return R;
}

// Whether MEASURE will count a text's lines (B.measurePhase's own condition).
function willMeasure(st) {
  if (st.settings.textFit !== "widen") return false;
  for (var k = 0; k < st.n; k++) if (st.recs[k].type === "TEXT" && st.builtType[k] === "TEXT" && st.recs[k].props.lines === 1) return true;
  return false;
}

IR.ops.build = async function (ctx, task) {
  checkTask(ctx, task);
  var t0 = Date.now();
  var st = B.newBuild(ctx, task);
  var root0 = function () { return st.node[st.rootKs[0]]; };
  ctx.phase("fonts"); await B.fontsPhase(st);
  ctx.phase("images"); B.imagesPhase(st);
  ctx.phase("pages"); await pagesPhase(st);
  ctx.phase("create"); await B.createPhase(st);
  ctx.phase("vectors"); await B.vectorsPhase(st);
  ctx.phase("booleans"); await B.booleansPhase(st);
  ctx.phase("layout"); await B.layoutPhase(st);
  ctx.phase("settle"); await ctx.settle(root0());
  ctx.phase("measure");
  if (willMeasure(st) && typeof IR.prepareMeasure === "function") await IR.prepareMeasure(ctx);
  try { await B.measurePhase(st); }
  finally { if (typeof IR.dropScratch === "function") IR.dropScratch(ctx); }
  ctx.phase("repair1"); await B.repairPass(st, false);
  ctx.phase("place1"); await B.placePass(st);
  ctx.phase("repair2"); await B.repairPass(st, true);
  ctx.phase("place2"); await B.placePass(st);
  ctx.phase("flowGroup"); await B.flowGroupPass(st);
  ctx.phase("flow1"); await B.flowFixPass(st, false);
  ctx.phase("flow2"); await B.flowFixPass(st, true);
  ctx.phase("repair3"); await B.repairPass(st, true);
  ctx.phase("place3"); await B.placePass(st);
  ctx.phase("textLine"); await B.textLinePass(st);
  ctx.phase("constraints"); await B.constraintsPass(st);
  ctx.phase("stamp"); await stampPhase(st);
  ctx.phase(null);
  return report(st, t0);
};

IR.ops.clean = async function (ctx, task) {
  if (!task || task.op !== "clean") U.refuse("the clean op runs a clean task; this one is " + JSON.stringify(task && task.op));
  var F = ctx.figma, guids = {}, nodes = Array.isArray(task.nodes) ? task.nodes : [], roots = Array.isArray(task.roots) ? task.roots : [];
  for (var r = 0; r < roots.length; r++) for (var j = 0; j < nodes.length; j++) if (nodes[j].i === roots[r].i) guids[String(nodes[j].guid)] = 1;
  ctx.phase("clean");
  var pages = [];
  if (task.page) {
    var key = task.page.service ? PXF_TASK.SERVICE_PAGE_GUID : String(task.page.guid);
    var all = F.root.children;
    for (var p = 0; p < all.length; p++) if (pageIs(ctx, all[p], key)) pages.push(all[p]);
  } else pages = F.root.children.slice();
  var removed = 0, kept = 0, doomed = [];
  for (var q = 0; q < pages.length; q++) {
    if (typeof pages[q].loadAsync === "function") await pages[q].loadAsync();
    ctx.progress();
    var kids = pages[q].children;
    for (var c = 0; c < kids.length; c++) {
      var src = ctx.stampOf(kids[c], "pxSrc");
      // Another snapshot's node is another file's (or another version's), even when its guid repeats.
      if (!src || !own(guids, src) || ctx.stampOf(kids[c], "pxSnap") !== String(task.snapshot)) continue;
      if (ctx.stampOf(kids[c], "pxRun") === String(task.runId)) kept++; else doomed.push(kids[c]);
    }
  }
  for (var d = 0; d < doomed.length; d++) {
    try { if (!doomed[d].removed) { doomed[d].remove(); removed++; } }
    catch (e) { ctx.failure(null, "remove", msgOf(e)); }
    ctx.progress();
  }
  ctx.phase(null);
  var R = ctx.report;
  R.plugin = typeof PXF_VERSION !== "undefined" ? PXF_VERSION : null;
  R.removed = removed;
  R.kept = kept;
  return R;
};
