// pix-to-fig runner — the Figma half of the migration. This is a SOURCE file.
//
// Figma runs figma-plugin/dist/code.js, which tools/build-plugin.mjs writes from this file and from
// tools/builder4.js every time the runner starts. The builder and the verifier become two ordinary
// functions in front of this file, PXF_BUILD and PXF_VERIFY; this file is wrapped in its own
// function scope after them, so neither can see a variable declared here and nothing here can see
// theirs. The algorithm still lives in exactly one place, tools/builder4.js, and is edited there.
//
// Nothing that arrives over the network is ever run as code. The builder and the verifier used to
// arrive inside every job as text and be compiled here with the async-function constructor, and a
// "render" job was any script at all — so whatever could reach the runner's port could run anything
// in the designer's file. A job now names one of six fixed commands and carries data for it:
//
//   build    the payload is the tree to build (tools/pack4.mjs writes it)
//   verify   the same payload, and the id of the root to measure
//   clean    which roots a rebuild replaces (the rule tools/test-clean.mjs proves)
//   render   one named operation from RENDER_OPS below, with its parameters
//   probe    the measurements docs/REWRITE.md §9 needs from the real plugin (P1, P2, P3, and the
//            IR layer's own, PXF_IR.probes)
//   ir       one task cut from the IR (tools/ir/task.mjs): validated, then run by the IR layer's op
//            for it (PXF_IR.ops, figma-plugin/src/ir/*.js; docs/M1.md §5.3)
//
// Any other kind is refused with an error report. No string is ever compiled.
figma.showUI(__html__, { width: 380, height: 300 });

// Every message crossing the plugin boundary is sliced, in both directions. A multi-megabyte string
// does not survive one message: a report carrying a rendered image silently never arrived, the UI
// frame stayed latched on "busy" and went on heartbeating, and the runner saw a live plugin that
// would never take another job.
var SLICE = 400000;
var buf = [], ibuf = [], ibinary = false, job = null, images = {}, imageErrors = {};

function log(m) { figma.ui.postMessage({ t: "log", m: String(m) }); }
function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isStr(v, max) { return typeof v === "string" && v.length <= (max || 4096); }
// A root's source stamp: the private one the payload builder writes, else the shared one the IR
// builder writes (namespace pix2fig, docs/M1.md §5.3), so RENDER, CLEAN and the sweep find both.
function stampOf(n) {
  var s = "";
  try { s = n.getPluginData("pxSrc"); } catch (e) {}
  if (!s) { try { s = n.getSharedPluginData(PXF_IR.NS, "pxSrc"); } catch (e2) {} }
  return s || "";
}
// A built root is always a top-level child of a page: the builder appends it to the current page.
function topLevel(n) { try { return !!(n && n.parent && n.parent.type === "PAGE"); } catch (e) { return false; } }
function refuse(m) { var e = new Error(m); e.refused = true; throw e; }

// ---------------------------------------------------------------------------------------------
// build and verify

// A file is not one page. The builder always appends to figma.currentPage, so the page is chosen
// here: an existing one by name, or a new one created and named to match the source.
async function choosePage(j) {
  if (!j.page) return;
  var target = figma.root.children.filter(function (p) { return p.name === j.page; })[0];
  if (!target) { target = figma.createPage(); target.name = j.page; log("created page " + JSON.stringify(j.page)); }
  // Under documentAccess "dynamic-page" (manifest.json) a page is loaded when it becomes current, so
  // it is made current before anything on it is written.
  if (figma.currentPage !== target) await figma.setCurrentPageAsync(target);
  if (j.pageBg) { try { target.backgrounds = j.pageBg; } catch (eb) { log("page background: " + (eb.message || eb)); } }
}

function checkPayload(PAY, what) {
  if (!PAY || typeof PAY !== "object" || !Array.isArray(PAY.F) || !Array.isArray(PAY.D) || !Array.isArray(PAY.S)) {
    refuse(what + ": the payload is not a node list (expected D, S and F)");
  }
  // A payload packed before the builder moved into the plugin still carries it as text. It is
  // harmless — it is never read — but it is said once, so nobody believes it is what ran.
  if (own(PAY, "B") || own(PAY, "V")) {
    log(what + ": this payload still carries builder code from an older packer; it is ignored, the bundled one runs");
    delete PAY.B; delete PAY.V;
  }
}

async function cmdBuild(PAY, j) {
  checkPayload(PAY, "build");
  PAY.IMG = images;
  await choosePage(j);
  var report = await PXF_BUILD(figma, PAY);
  // A second pass is needed when undisclosed text overrides had to be rendered and repacked; the
  // first, provisional build is then removed. It is removed only once it has proved what it is,
  // because a remembered id is not a handle (STATE.md): it must carry the stamp of the source this
  // pass rebuilt, sit at the top of a page, and not be the root just built.
  if (j.cleanupRootId && report && report.rootId) {
    try {
      var old = await figma.getNodeByIdAsync(String(j.cleanupRootId));
      if (old && !old.removed) {
        if (old.id !== report.rootId && PAY.R && stampOf(old) === String(PAY.R) && topLevel(old)) {
          old.remove();
          log("removed provisional build " + j.cleanupRootId);
        } else log("kept " + j.cleanupRootId + ": it is not this source's provisional build");
      }
    } catch (e2) { log("cleanup failed: " + (e2.message || e2)); }
  }
  return report;
}

async function cmdVerify(PAY, j) {
  checkPayload(PAY, "verify");
  if (!isStr(j.rootNodeId, 200) || !j.rootNodeId) refuse("verify: no root id to measure");
  await choosePage(j);
  return PXF_VERIFY(figma, PAY, j.rootNodeId);
}

// ---------------------------------------------------------------------------------------------
// clean: what a rebuild is allowed to delete, proved against nodes made for the purpose by
// tools/test-clean.mjs rather than trusted the first time it runs over a designer's file.
//
// `want` is one entry per object about to be rebuilt: { src } the Pixso id it came from, { id } the
// Figma id an earlier run recorded for it. An id alone is not safe to delete by — measured: two
// objects in a run of 45 reported ids belonging to nodes built long before them — so a node found by
// id is removed only if it is unstamped (an older build, where the id is all there is) or stamped
// with the source this run is about to rebuild; and every node carrying that stamp is removed,
// which also clears duplicates an interrupted run left behind. Only top-level objects of a page are
// ever removed: that is where every build puts its root, and an id that has come to name a page, a
// layer deep inside someone's frame, or the document must not take it with it.
//
// The report keeps two reasons for leaving a named node alone apart, because they mean different
// things to the person reading it: `spared` — the id now belongs to another object's root, all is
// well; `notTopLevel` — the node is no longer at the top of a page (a page, the document, a layer, or
// a built root the designer moved into a section), and if it is the last case the rebuild will sit
// beside it as a duplicate.
async function cmdClean(P) {
  if (!P || !Array.isArray(P.want) || P.want.length > 100000) refuse("clean: expected { want: [...] }");
  var want = [];
  for (var i = 0; i < P.want.length; i++) {
    var w = P.want[i];
    if (!w || typeof w !== "object") refuse("clean: entry " + i + " is not an object");
    var src = w.src === null || w.src === undefined ? null : w.src;
    var id = w.id === null || w.id === undefined ? null : w.id;
    if ((src !== null && !isStr(src, 200)) || (id !== null && !isStr(id, 200))) refuse("clean: entry " + i + " has a src or id that is not a short string");
    want.push({ src: src, id: id });
  }
  await figma.loadAllPagesAsync();
  var srcs = {};
  for (var a = 0; a < want.length; a++) if (want[a].src) srcs[want[a].src] = 1;
  var gone = 0, spared = 0, notTopLevel = 0;
  var doomed = [];
  // Everything stamped with a source this run rebuilds, wherever it sits on a page.
  var pages = figma.root.children;
  for (var p = 0; p < pages.length; p++) {
    var kids = pages[p].children;
    for (var k = 0; k < kids.length; k++) { var s0 = stampOf(kids[k]); if (s0 && own(srcs, s0)) doomed.push(kids[k]); }
  }
  for (var b = 0; b < want.length; b++) {
    if (!want[b].id) continue;
    var n = await figma.getNodeByIdAsync(want[b].id);
    if (!n || n.removed || doomed.indexOf(n) >= 0) continue;
    if (!topLevel(n)) { notTopLevel++; continue; }
    var s = stampOf(n);
    // Unstamped: built before stamping existed, and the id is the only handle there is. Stamped with
    // something else: the id has gone stale and now points at another object's root. Leave it alone.
    if (!s || (want[b].src && s === String(want[b].src))) doomed.push(n); else spared++;
  }
  for (var d = 0; d < doomed.length; d++) { try { if (!doomed[d].removed) { doomed[d].remove(); gone++; } } catch (e) {} }
  return { removed: gone, of: want.length, spared: spared, notTopLevel: notTopLevel };
}

// ---------------------------------------------------------------------------------------------
// render: every distinct thing the old free-form render jobs did, as named operations with data.
//
//   export         photograph one node (tools/visual.mjs, tools/visual-all.mjs, tools/ir-audit.mjs); with
//                  `snap` only a node stamped with that snapshot, with `child` its k-th child; the
//                  report gives the node's size, type, opacity, box and render bounds with the PNG
//   ping           answer, and say which plugin build answered (tools/wait-plugin.mjs)
//   scratch-make   make rectangles far off-canvas for a test (tools/test-clean.mjs)
//   scratch-list   name the scratch rectangles still in the file
//   scratch-sweep  remove them
//
// The scratch operations carry their own mark, pxScratch, and touch nothing without it: the old
// test swept by a name prefix, and a name is something a designer can type.
var EXPORT_LIMITS = { SCALE: [0.01, 16], WIDTH: [1, 16384], HEIGHT: [1, 16384] };

async function renderExport(P) {
  if (!isStr(P.id, 200) || !P.id) refuse("render export: no node id");
  if (P.src !== undefined && P.src !== null && !isStr(P.src, 200)) refuse("render export: src must be a string");
  var c = P.constraint || {};
  var lim = own(EXPORT_LIMITS, c.type) ? EXPORT_LIMITS[c.type] : null;
  if (!lim || typeof c.value !== "number" || !(c.value >= lim[0] && c.value <= lim[1])) {
    refuse("render export: constraint must be SCALE, WIDTH or HEIGHT with a value in range");
  }
  if (P.snap !== undefined && P.snap !== null && !isStr(P.snap, 200)) refuse("render export: snap must be a string");
  if (P.child !== undefined && P.child !== null && !(typeof P.child === "number" && P.child >= 0 && P.child < 1000000 && Math.floor(P.child) === P.child)) {
    refuse("render export: child must be a child's index");
  }
  if (P.loadAll) await figma.loadAllPagesAsync();
  var want = P.src ? String(P.src) : "";
  // An IR root names its snapshot too (the render audit, tools/ir-audit.mjs): a copy of the same
  // source built from another .pix snapshot carries the same pxSrc and is not this run's root.
  var snap = P.snap ? String(P.snap) : "";
  var snapOf = function (x) { try { return x.getSharedPluginData(PXF_IR.NS, "pxSnap"); } catch (e) { return ""; } };
  var right = function (x) { return stampOf(x) === want && (!snap || snapOf(x) === snap); };
  var n = await figma.getNodeByIdAsync(P.id);
  var relocated = null;
  // Asked for by id, then made to prove it is the right node. A remembered id turned out to resolve
  // to something else entirely on two objects out of 45 — so photographing whatever answers to a
  // number would quietly compare the wrong pair of pictures, which is worse than failing.
  if (want && (!n || n.removed || !right(n))) {
    // The stamp is searched on every page, and under documentAccess "dynamic-page" a page that is not
    // loaded lists no children: load them all first (docs/M1.md §6 E).
    if (!P.loadAll) await figma.loadAllPagesAsync();
    var f = [];
    var pages = figma.root.children;
    for (var pi = 0; pi < pages.length; pi++) {
      var k = pages[pi].children;
      for (var ki = 0; ki < k.length; ki++) if (right(k[ki])) f.push(k[ki]);
    }
    // Newest last: a root is appended to its page, so a leftover duplicate sits ahead of it.
    if (f.length) { n = f[f.length - 1]; relocated = n.id; }
    // Nothing carries the stamp, and the id names a node stamped with another source: that is another
    // object's root, and a picture of it would be compared against the wrong source. An unstamped
    // node is still photographed — a build from before stamping has only its id (not when a snapshot
    // is asked for: an IR root is always stamped).
    else if (n && !n.removed && (stampOf(n) || snap)) {
      return { e: stampOf(n) === want ? "the id names a copy of this source built from another snapshot, and nothing carries the snapshot asked for"
        : "the id names another object's root, and nothing carries the stamp asked for" };
    }
  }
  if (!n || n.removed || typeof n.exportAsync !== "function") return { e: "not found" };
  // A section's children one by one (the render audit's --section children): the k-th child of the
  // node found and proved above.
  if (P.child !== undefined && P.child !== null) {
    var ks = n.children;
    if (!ks || P.child >= ks.length) return { e: "no child " + P.child };
    n = ks[P.child];
    if (!n || typeof n.exportAsync !== "function") return { e: "not found" };
  }
  var by = await n.exportAsync({ format: "PNG", constraint: { type: c.type, value: c.value } });
  // Where the picture sits: the node's box and, when Figma gives them, the bounds of what it draws
  // (the picture covers those). The render audit places the box in the picture with them.
  var bb = null, rb = null;
  try { var a0 = n.absoluteBoundingBox; if (a0) bb = { x: a0.x, y: a0.y, width: a0.width, height: a0.height }; } catch (e1) {}
  try { var a1 = n.absoluteRenderBounds; if (a1) rb = { x: a1.x, y: a1.y, width: a1.width, height: a1.height }; } catch (e2) {}
  var op = null;
  try { if (typeof n.opacity === "number") op = n.opacity; } catch (e3) {}
  return { w: n.width, h: n.height, type: n.type, opacity: op, box: bb, render: rb, bytes: by.length, d: figma.base64Encode(by), relocated: relocated };
}

function scratchNodes() {
  var out = [];
  var pages = figma.root.children;
  for (var p = 0; p < pages.length; p++) {
    var kids = pages[p].children;
    for (var k = 0; k < kids.length; k++) {
      var mark = "";
      try { mark = kids[k].getPluginData("pxScratch"); } catch (e) {}
      // The IR layer's scratch text node carries the mark shared as well (ctx.stamp).
      if (mark !== "1") { try { mark = kids[k].getSharedPluginData(PXF_IR.NS, "pxScratch"); } catch (e2) {} }
      if (mark === "1") out.push(kids[k]);
    }
  }
  return out;
}

async function renderScratchMake(P) {
  if (!Array.isArray(P.nodes) || !P.nodes.length || P.nodes.length > 16) refuse("render scratch-make: expected 1 to 16 nodes");
  var page = figma.currentPage, ids = [];
  for (var i = 0; i < P.nodes.length; i++) {
    var s = P.nodes[i] || {};
    if (!isStr(s.name, 64) || (s.stamp !== undefined && s.stamp !== null && !isStr(s.stamp, 200))) {
      refuse("render scratch-make: node " + i + " needs a short name and an optional short stamp");
    }
    var r = figma.createRectangle();
    r.name = s.name; r.resize(40, 40); r.x = -4000; r.y = -4000;
    page.appendChild(r);
    r.setPluginData("pxScratch", "1");
    if (s.stamp) r.setPluginData("pxSrc", String(s.stamp));
    ids.push(r.id);
  }
  return { ids: ids };
}

async function renderScratchList() {
  await figma.loadAllPagesAsync();
  var names = scratchNodes().map(function (n) { return String(n.name); });
  names.sort();
  return { left: names };
}

async function renderScratchSweep() {
  await figma.loadAllPagesAsync();
  var all = scratchNodes(), n = 0;
  for (var i = 0; i < all.length; i++) { try { all[i].remove(); n++; } catch (e) {} }
  return { swept: n };
}

var RENDER_OPS = {
  "export": renderExport,
  "ping": async function () { return { ok: 1, plugin: PXF_VERSION }; },
  "scratch-make": renderScratchMake,
  "scratch-list": renderScratchList,
  "scratch-sweep": renderScratchSweep
};

async function cmdRender(P) {
  if (!P || typeof P !== "object" || !isStr(P.op, 40) || !own(RENDER_OPS, P.op)) {
    refuse("render: unknown operation " + JSON.stringify(P && P.op) + " — this plugin knows " + Object.keys(RENDER_OPS).join(", "));
  }
  return RENDER_OPS[P.op](P);
}

// ---------------------------------------------------------------------------------------------
// probe: measurements that only the real plugin, in the owner's Figma desktop, can make.
//
//   P1  the UI frame's real Origin, as the runner sees it: the window fetches /echo and the runner
//       answers with the request headers it received (and logs every Origin it refuses)
//   P2  what one turn costs: setTimeout(0), getNodeByIdAsync on the current page, a round trip to
//       the UI frame, and a resolved promise — min, median, p95 and max of N each
//   P3  the largest postMessage that arrives, each way: strings from 0.25 to 16 MB
//
// This is the one place in the plugin that uses setTimeout, on purpose: P2 measures it, and P1 and
// P3 need a deadline for an answer that may never come. A deadline that a background window throttles
// to one wake-up a minute is only late, never early, so nothing here can misreport because of it —
// but never copy a timer from here into the builder (STATE.md).
var probeWait = {}, probeSeq = 0;
var MB = 1048576;
var HAS_PERF = typeof performance !== "undefined" && !!performance && typeof performance.now === "function";
var CLOCK = HAS_PERF ? "performance.now" : "Date.now";
function clockNow() { return HAS_PERF ? performance.now() : Date.now(); }

// Ask the UI frame something and wait for its "probe-answer". Resolves null if the deadline passes.
function askUI(msg, deadlineMs) {
  var k = "q" + (++probeSeq);
  msg.k = k;
  return new Promise(function (resolve) {
    var settled = false, timer = null;
    probeWait[k] = function (ans) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      delete probeWait[k];
      resolve(ans);
    };
    if (deadlineMs) timer = setTimeout(function () { if (own(probeWait, k)) probeWait[k](null); }, deadlineMs);
    figma.ui.postMessage(msg);
  });
}

function stats(xs, asked) {
  var s = xs.slice().sort(function (a, b) { return a - b; });
  var r2 = function (v) { return Math.round(v * 100) / 100; };
  var at = function (q) { return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  if (!s.length) return { n: 0, asked: asked, min: null, median: null, p95: null, max: null };
  return { n: s.length, asked: asked, min: r2(s[0]), median: r2(at(0.5)), p95: r2(at(0.95)), max: r2(s[s.length - 1]) };
}

// Each step timed on its own gives the spread (min, median, p95, max), but where performance.now is
// missing the clock is Date.now, whole milliseconds, and a step that takes microseconds reads 0 every
// time. So the whole series is timed as well (mean = total / steps), and then the step is run back to
// back until the clock has moved at least BATCH_MS (batch.mean): on a millisecond clock the error is
// then at most one tick in BATCH_MS, half a percent. Both are bounded by the series' time budget.
var BATCH_MS = 200, BATCH_MAX = 200000;
async function series(n, maxMs, step) {
  var xs = [], t0 = clockNow(), lost = 0, done = 0;
  for (var i = 0; i < n; i++) {
    var a = clockNow();
    var ok = await step();
    done++;
    if (ok === false) lost++; else xs.push(clockNow() - a);
    // A setTimeout in a background window can take a whole minute per turn; the series stops at its
    // budget and says how far it got rather than holding the plugin for an hour.
    if (clockNow() - t0 > maxMs) break;
  }
  var total = clockNow() - t0;
  var out = stats(xs, n);
  out.totalMs = Math.round(total * 100) / 100;
  out.mean = done ? Math.round(total / done * 10000) / 10000 : null;
  var b0 = clockNow(), steps = 0, blost = 0;
  while (steps < BATCH_MAX && clockNow() - b0 < Math.min(BATCH_MS, maxMs)) {
    if ((await step()) === false) blost++;
    steps++;
  }
  var bms = clockNow() - b0;
  out.batch = { steps: steps, ms: Math.round(bms * 100) / 100, mean: steps ? Math.round(bms / steps * 10000) / 10000 : null };
  if (blost) out.batch.lost = blost;
  if (lost) out.lost = lost;
  return out;
}

async function probeP1(A) {
  var ans = await askUI({ t: "probe-echo" }, A.deadlineMs);
  if (!ans) return { error: "the UI frame did not answer within " + A.deadlineMs + " ms" };
  return { status: ans.status, echo: ans.echo, error: ans.error, uiOrigin: ans.origin, uiHref: ans.href };
}

async function probeP2(A) {
  var pageId = figma.currentPage.id;
  return {
    clock: CLOCK,
    setTimeout0: await series(A.n, A.maxMsPerSeries, function () { return new Promise(function (r) { setTimeout(r, 0); }); }),
    getNodeByIdAsync: await series(A.n, A.maxMsPerSeries, function () { return figma.getNodeByIdAsync(pageId).then(function () {}); }),
    uiRoundTrip: await series(A.n, A.maxMsPerSeries, function () {
      return askUI({ t: "probe-ping" }, A.deadlineMs).then(function (a) { return a ? true : false; });
    }),
    resolvedPromise: await series(A.n, A.maxMsPerSeries, function () { return Promise.resolve(); })
  };
}

async function probeP3(A) {
  var down = [], up = [], missDown = 0, missUp = 0;
  for (var i = 0; i < A.sizesMB.length; i++) {
    var mb = A.sizesMB[i], chars = Math.round(mb * MB);
    // To the UI frame: the frame answers with the length it received, never with the string.
    if (missDown < 2) {
      var a = clockNow();
      var ans = await askUI({ t: "probe-big", s: "x".repeat(chars) }, A.deadlineMs);
      var ok = !!(ans && ans.len === chars);
      down.push({ mb: mb, chars: chars, arrived: ok, ms: Math.round(clockNow() - a) });
      missDown = ok ? 0 : missDown + 1;
    } else down.push({ mb: mb, chars: chars, arrived: null, skipped: "two smaller sizes did not arrive" });
    // From the UI frame: it makes the string itself, so only a length crosses the other way.
    if (missUp < 2) {
      var b = clockNow();
      var back = await askUI({ t: "probe-big-up", size: chars }, A.deadlineMs);
      var ok2 = !!(back && typeof back.s === "string" && back.s.length === chars);
      up.push({ mb: mb, chars: chars, arrived: ok2, ms: Math.round(clockNow() - b) });
      missUp = ok2 ? 0 : missUp + 1;
    } else up.push({ mb: mb, chars: chars, arrived: null, skipped: "two smaller sizes did not arrive" });
  }
  var largest = function (rows) { var m = 0; for (var j = 0; j < rows.length; j++) if (rows[j].arrived && rows[j].mb > m) m = rows[j].mb; return m; };
  return { pluginToUi: down, uiToPlugin: up, largestDownMB: largest(down), largestUpMB: largest(up) };
}

// P1-P3 are functions of the common arguments. The IR layer's probes (PXF_IR.probes, upper-case names:
// P4, P8, P19B, figma-plugin/src/ir/probes-*.js) are { args(raw) -> their own arguments, run(args, io) }:
// args sees the whole payload and throws on a bad argument, which refuses the job before anything
// runs; io.ask(message, deadlineMs) is this host's round trip to the window, because the IR layer owns
// no timer and figma.ui.onmessage is this host's (P4 moves image bytes through it).
var PROBES = Object.assign({ P1: probeP1, P2: probeP2, P3: probeP3 }, PXF_IR.probes);
var PROBE_IO = { ask: function (m, deadlineMs) { return askUI(Object.assign({}, m), deadlineMs); } };

function numberIn(v, dflt, lo, hi, what) {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !(v >= lo && v <= hi)) refuse("probe: " + what + " must be " + lo + ".." + hi);
  return v;
}

async function cmdProbe(P) {
  P = P || {};
  var list = Array.isArray(P.probes) && P.probes.length ? P.probes : ["P1", "P2", "P3"];
  for (var i = 0; i < list.length; i++) if (!isStr(list[i], 8) || !own(PROBES, list[i])) refuse("probe: unknown probe " + JSON.stringify(list[i]));
  var sizes = P.sizesMB === undefined ? [0.25, 0.5, 1, 2, 4, 8, 16] : P.sizesMB;
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > 10) refuse("probe: sizesMB must list 1..10 sizes");
  for (var s = 0; s < sizes.length; s++) if (typeof sizes[s] !== "number" || !(sizes[s] > 0 && sizes[s] <= 16)) refuse("probe: every size must be over 0 and at most 16 MB");
  var A = {
    n: numberIn(P.n, 50, 1, 1000, "n"),
    maxMsPerSeries: numberIn(P.maxMsPerSeries, 60000, 1, 600000, "maxMsPerSeries"),
    deadlineMs: numberIn(P.deadlineMs, 30000, 100, 600000, "deadlineMs"),
    sizesMB: sizes
  };
  // Every probe's own arguments are checked before any probe runs.
  var own2 = {};
  for (var q = 0; q < list.length; q++) {
    var pr = PROBES[list[q]];
    if (typeof pr === "function") continue;
    if (!pr || typeof pr.args !== "function" || typeof pr.run !== "function") refuse("probe: " + list[q] + " is not a probe");
    try { own2[list[q]] = pr.args(P) || {}; }
    catch (ea) { refuse("probe: " + list[q] + ": " + String((ea && ea.message) || ea)); }
  }
  var out = { plugin: PXF_VERSION, label: isStr(P.label, 80) ? P.label : null, args: A, probes: {} };
  for (var p = 0; p < list.length; p++) {
    var t0 = clockNow();
    try {
      var probe = PROBES[list[p]];
      out.probes[list[p]] = typeof probe === "function" ? await probe(A) : await probe.run(Object.assign({}, A, own2[list[p]]), PROBE_IO);
    }
    catch (e) { out.probes[list[p]] = { error: String((e && e.message) || e) }; }
    if (!out.probes[list[p]] || typeof out.probes[list[p]] !== "object") out.probes[list[p]] = { result: out.probes[list[p]] === undefined ? null : out.probes[list[p]] };
    out.probes[list[p]].ms = Math.round(clockNow() - t0);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ir: one task of the IR path (docs/M1.md §5.2, §5.3). The task is validated here, whole, before
// anything is touched; then the op it names runs with a fresh context. The ops themselves live in
// figma-plugin/src/ir/*.js (PXF_IR.ops); an op this build does not have is refused by name.
//
// The IR layer reaches this host only through what is given here: the images created this session
// and the ones Figma refused, and the progress counter, which the window forwards to the runner as
// the liveness signal (a heartbeat alone never extends a task).
PXF_IR.setHost({
  images: function () { return images; },
  imageErrors: function () { return imageErrors; },
  progress: function (done, id) { figma.ui.postMessage({ t: "progress", id: id, done: done }); },
  log: log
});

async function cmdIr(P, j) {
  // The ceiling, not the planner's cap: the runner already cut the task to its --max-task-mb.
  var v = PXF_TASK.validateTask(P, { schema: PXF_SCHEMA, props: PXF_PROPS, maxChars: PXF_TASK.MAX_TASK_CHARS_CEILING, maxErrors: 20 });
  if (!v.ok) {
    refuse("ir: the task is refused: " + v.errors.slice(0, 5).map(function (e) { return (e.path || "(task)") + ": " + e.message; }).join("; ") +
      (v.errors.length > 5 ? " (and " + (v.errors.length - 5) + " more)" : ""));
  }
  if (!own(PXF_IR.ops, P.op) || typeof PXF_IR.ops[P.op] !== "function") refuse("ir: this plugin has no " + JSON.stringify(P.op) + " op");
  return PXF_IR.ops[P.op](PXF_IR.makeCtx(figma, P, j), P);
}

// ---------------------------------------------------------------------------------------------
// the host: a fixed table of commands, and the transport that feeds it

var COMMANDS = { build: cmdBuild, verify: cmdVerify, clean: cmdClean, render: cmdRender, probe: cmdProbe, ir: cmdIr };

function joinBytes(parts) {
  var n = 0, i;
  for (i = 0; i < parts.length; i++) n += parts[i].length;
  var out = new Uint8Array(n), o = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
  return out;
}

function sendReport(id, report) {
  var text = "";
  try { text = JSON.stringify(report); }
  catch (e4) { text = JSON.stringify({ error: "report not serialisable: " + String((e4 && e4.message) || e4) }); }
  figma.ui.postMessage({ t: "report-begin", id: id, total: text.length });
  for (var o = 0; o < text.length; o += SLICE) {
    figma.ui.postMessage({ t: "report-chunk", id: id, d: text.substr(o, SLICE) });
  }
  figma.ui.postMessage({ t: "report-end", id: id });
}

figma.ui.onmessage = async function (msg) {
  if (!msg || typeof msg !== "object") return;

  // Answers to a probe's questions. They arrive while the probe job is still running.
  if (msg.t === "probe-answer") { if (isStr(msg.k, 40) && own(probeWait, msg.k)) probeWait[msg.k](msg); return; }

  if (msg.t === "payload-begin") {
    job = { id: String(msg.id), kind: String(msg.kind), total: msg.total,
            rootNodeId: msg.rootNodeId || null, cleanupRootId: msg.cleanupRootId || null,
            page: msg.page || null, pageBg: msg.pageBg || null };
    // The hash map is NOT cleared between jobs. Migrating a file means one job per top-level
    // object, and the same photograph is used by dozens of them; sending its bytes again for
    // every job was most of the transfer. The frame skips a hash it has already sent, so this
    // side has to remember the mapping for the whole session.
    buf = [];
    return;
  }
  if (msg.t === "payload-chunk") { if (typeof msg.d === "string") buf.push(msg.d); return; }

  // Content-addressed on both sides: identical bytes give an identical hash, so this map is
  // usually the identity. It is not for images whose bytes Pixso never held locally, which the
  // runner substitutes with a render.
  //
  // The bytes arrive as base64 in slices. They used to arrive as an array of numbers, one per
  // byte, and an object carrying 102 MB of photographs never finished being handed over. A job whose
  // transport is "binary" (probe P4's verdict, docs/M1.md §6 E) sends them as Uint8Array slices of at
  // most 4 MB instead, and no decode is needed here.
  if (msg.t === "image-begin") { ibuf = []; ibinary = msg.binary === true; return; }
  if (msg.t === "image-chunk") {
    if (ibinary ? !!msg.d && typeof msg.d === "object" && typeof msg.d.length === "number" : typeof msg.d === "string") ibuf.push(msg.d);
    return;
  }
  if (msg.t === "image-end") {
    // A refusal is remembered by hash for the IR builder (ctx.S.imageErrors()), which then draws a
    // counted placeholder instead of an IMAGE paint Figma has no image for.
    try {
      var im = figma.createImage(ibinary ? joinBytes(ibuf) : figma.base64Decode(ibuf.join("")));
      images[String(msg.hash)] = im.hash;
      delete imageErrors[String(msg.hash)];
    } catch (e) {
      imageErrors[String(msg.hash)] = String((e && e.message) || e);
      log("image " + String(msg.hash).slice(0, 8) + " failed: " + (e.message || e));
    }
    ibuf = []; ibinary = false;
    return;
  }

  if (msg.t !== "payload-end" || !job) return;

  var j = job, report;
  try {
    if (!own(COMMANDS, j.kind)) {
      refuse("refused: unknown job kind " + JSON.stringify(j.kind) + " — this plugin runs only " + Object.keys(COMMANDS).join(", "));
    }
    var P;
    try { P = JSON.parse(buf.join("")); }
    catch (ej) { refuse(j.kind + ": the payload is not JSON (" + String(ej.message || ej).slice(0, 80) + ")"); }
    buf = [];
    report = await COMMANDS[j.kind](P, j);
  } catch (e3) {
    buf = [];
    report = { error: String((e3 && e3.message) || e3), stack: String((e3 && e3.stack) || "").slice(0, 900) };
    if (e3 && e3.refused) report.refused = true;
  }
  // Every report names the plugin build that made it, so a build-report.json says which builder built
  // it, and the runner can check it is the one it wrote (tools/build-lib.mjs).
  if (report && typeof report === "object" && !Array.isArray(report) && !own(report, "plugin")) report.plugin = PXF_VERSION;
  sendReport(j.id, report);
  job = null;
};

log("plugin build " + PXF_VERSION);
