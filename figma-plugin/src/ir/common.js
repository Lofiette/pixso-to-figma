// The plugin's IR layer: the registry every other figma-plugin/src/ir/*.js file fills, and the one
// context (ctx) an op is given. docs/M1.md §5.3. Owned by part P0 alone (§9): nothing else edits it,
// so what it promises below is the contract parts B, C and E build on.
//
// tools/build-plugin.mjs bundles, in this order, before the host (figma-plugin/src/code.js):
//   PXF_PROPS, PXF_SCHEMA, PXF_TASK, PXF_PATHGEOM   tools/ir/{props,schema,task,pathgeom}.mjs, each
//                                                    an IIFE returning its exports
//   PXF_IR                                           this file, as it stands (top-level var)
//   every other figma-plugin/src/ir/*.js, sorted by name, each wrapped as (function (IR) { … })(PXF_IR);
// tools/ir/plugin-vm.mjs runs exactly that text in a vm for the tests (loadPluginIR).
//
// PXF_IR = { ops, probes, makeCtx, setHost, util, CODE, NS, STAMP_KEYS }
//   ops[op](ctx, task) -> Promise<report>   one per task op (fonts, build, verify, clean); the host's
//                                           `ir` command validates the task, then calls the op
//   probes[NAME] = { args(raw) -> args, run(args) -> Promise<result> }   upper-case names (P19B);
//                                           args validates the probe's own arguments from the probe
//                                           job's payload and throws on a bad one; run gets them merged
//                                           with the common ones (n, deadlineMs, maxMsPerSeries)
//   setHost(host)                           the host's side, given once before any op runs:
//     host.images()         -> { sourceHash: figmaHash }   images created this session
//     host.imageErrors()    -> { sourceHash: message }      images Figma refused this session
//     host.progress(done, jobId)                            posts { t: "progress", id, done } to the window
//     host.log(message)                                     a line in the window's log (optional)
//     host.phase(name)                                      told every phase change (optional; the double)
//     host.measure(ctx, node, rec) -> { lines, approx }     replaces IR.countLines (optional; tests)
//   makeCtx(figma, task, job) -> ctx         a frozen context for one task (below)
//   util                                    small helpers, below; util.notInThisBuild(what, part) makes
//                                           a stub that throws (e.refused, e.code "NOT_IMPLEMENTED") and
//                                           carries .notInThisBuild = part
//   CODE                                    PXF_SCHEMA.CODE: write codes as IR.CODE.X, never quoted
//
// ctx, frozen (its S and report are the mutable parts):
//   ctx.figma, ctx.task
//   ctx.S        the session, kept across the tasks of one run (reset when task.runId changes):
//                { runId, nodes: { i: figmaId }, pages: { index: figmaId }, fonts: { "family|style": "ok"|"sub" },
//                  images() -> { hash: figmaHash }, imageErrors() -> { hash: message }, scratchTextId }
//   ctx.value(idx)              task.values[idx]; throws when the task does not carry it
//   ctx.prop(rec, name)         rec.props[name], an interned prop resolved through ctx.value; an absent
//                               prop that applies to rec.type (PXF_PROPS.KNOWN_PROPS) and has a default
//                               gives a copy of PXF_PROPS.DEFAULTS[name]; otherwise undefined
//   ctx.phase(name)             ends the running phase, adding its Date.now() time to report.ms[phase],
//                               and starts `name` (null: start none); tells host.phase; advances progress
//   ctx.breathe(k)              -> Promise. On every 400th item, once 1 500 ms have passed since the last
//                               breath, awaits figma.getNodeByIdAsync(figma.root.id); otherwise resolves
//                               at once. Never a timer (P2: a minimised Figma wakes a timer once a second)
//   ctx.progress()              advances the liveness counter; the window hears of it at most once a second
//   ctx.settle(root)            -> Promise. Reads root.absoluteBoundingBox (forcing the pending layout),
//                               then awaits getNodeByIdAsync. The only layout-forcing helper: call it at
//                               phase boundaries, never inside a creation loop
//   ctx.measure(node, rec)      -> { lines, approx }: host.measure if given, else IR.countLines (part C)
//   ctx.code(code, i, detail)   the only way to record a code: report.codes[code] += 1 and
//                               report.coded.push({ code, i, detail }); throws on an unknown code
//   ctx.failure(i, prop, msg)   report.failures.push({ i, prop, msg })
//   ctx.stamp(node, key, val)   shared plugin data in namespace "pix2fig"; key one of STAMP_KEYS, or it
//                               throws. pxScratch is written as private plugin data too
//   ctx.stampOf(node, key)      the shared stamp, or "" (also when the node cannot be read)
//   ctx.findRoot(i)             -> Promise<node|null>: S.nodes[i] if that node still carries pxIdx = i,
//                               pxSnap = task.snapshot and pxIr = the IR version; else the newest node on
//                               any page carrying those three (pages are loaded first); else null
//   ctx.log(message)
//   ctx.report                  { op, taskNo, runId, ms: {}, codes: {}, coded: [], failures: [] }; an op
//                               adds its own fields and returns it
//
// Stamps (docs/M1.md §5.3): roots and task-boundary parents carry pxSrc (guid), pxIdx (IR index),
// pxRun, pxSnap, pxIr = "2" and pxState ("built" or "partial"); components pxDef; pages pxPage (page
// guid, or "m1-service"); the scratch text node pxScratch, shared and private. Nothing else is stamped.
var PXF_IR = (function () {
  var NS = "pix2fig";
  var STAMP_KEYS = ["pxSrc", "pxIdx", "pxRun", "pxSnap", "pxIr", "pxState", "pxDef", "pxPage", "pxScratch"];
  var BREATHE_EVERY = 400, BREATHE_MS = 1500, PROGRESS_MS = 1000;
  var host = null, session = null;

  function own(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function refuse(m) { var e = new Error(m); e.refused = true; throw e; }

  // A stub's op or function: says which part fills it in, and refuses rather than doing nothing. It
  // carries notInThisBuild = the part, so a test can tell a stub from the real thing.
  function notInThisBuild(what, part) {
    var f = function () {
      var e = new Error(what + " is not in this build: part " + part + " implements it (docs/M1.md §6 " + part + ")");
      e.refused = true;
      e.code = "NOT_IMPLEMENTED";
      throw e;
    };
    f.notInThisBuild = part;
    return f;
  }

  // 2x3 matrices, as Figma writes them: [[a, b, tx], [c, d, ty]]; the IR writes [a, b, tx, c, d, ty].
  function matrix(rt) { return [[rt[0], rt[1], rt[2]], [rt[3], rt[4], rt[5]]]; }
  function flat(m) { return [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2]]; }
  function mul(m, n) {
    return [[m[0][0] * n[0][0] + m[0][1] * n[1][0], m[0][0] * n[0][1] + m[0][1] * n[1][1], m[0][0] * n[0][2] + m[0][1] * n[1][2] + m[0][2]],
      [m[1][0] * n[0][0] + m[1][1] * n[1][0], m[1][0] * n[0][1] + m[1][1] * n[1][1], m[1][0] * n[0][2] + m[1][1] * n[1][2] + m[1][2]]];
  }
  function inv(m) {
    var a = m[0][0], b = m[0][1], tx = m[0][2], c = m[1][0], d = m[1][1], ty = m[1][2], det = a * d - b * c;
    if (!det) throw new Error("a matrix with no inverse");
    return [[d / det, -b / det, (b * ty - d * tx) / det], [-c / det, a / det, (c * tx - a * ty) / det]];
  }
  function apply(m, x, y) { return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]]; }

  var util = {
    own: own, isObj: isObj, clone: clone, refuse: refuse, notInThisBuild: notInThisBuild,
    // Registers a stub only where nothing is registered yet, so a real file sorted before the stub's
    // file (build-fonts.js before build.js) is never overwritten by it.
    stubOp: function (name, part) { if (!own(IR.ops, name)) IR.ops[name] = notInThisBuild("the " + name + " op", part); },
    stubProbe: function (name, part) {
      if (!own(IR.probes, name)) IR.probes[name] = { args: function () { return {}; }, run: notInThisBuild("probe " + name, part) };
    },
    matrix: matrix, flat: flat, mul: mul, inv: inv, apply: apply,
    builtType: function (irType) { return own(PXF_TASK.BUILT_TYPE, irType) ? PXF_TASK.BUILT_TYPE[irType] : null; },
  };

  function setHost(h) {
    if (!isObj(h) || typeof h.images !== "function" || typeof h.imageErrors !== "function" || typeof h.progress !== "function") {
      throw new TypeError("PXF_IR.setHost needs { images(), imageErrors(), progress(done, jobId) }");
    }
    host = h;
  }

  function newSession(runId) {
    return { runId: runId, nodes: {}, pages: {}, fonts: {},
      images: function () { return host.images(); }, imageErrors: function () { return host.imageErrors(); },
      scratchTextId: null };
  }

  function makeCtx(figma, task, job) {
    if (!host) throw new Error("PXF_IR.makeCtx: the host has not called PXF_IR.setHost");
    if (!isObj(task)) throw new TypeError("PXF_IR.makeCtx: no task");
    if (!session || session.runId !== task.runId) session = newSession(task.runId);
    var jobId = job && job.id !== undefined ? job.id : null;
    var report = { op: task.op, taskNo: task.taskNo, runId: task.runId, ms: {}, codes: {}, coded: [], failures: [] };
    var phaseName = null, phaseAt = 0, done = 0, lastPost = 0, lastBreath = Date.now();
    var values = isObj(task.values) ? task.values : {};

    function progress() {
      done++;
      var now = Date.now();
      if (lastPost === 0 || now - lastPost >= PROGRESS_MS) { lastPost = now; host.progress(done, jobId); }
    }
    function value(idx) {
      var k = String(idx);
      if (!own(values, k)) throw new Error("ctx.value: values[" + k + "] is not in task " + task.taskNo);
      return values[k];
    }
    function stampOf(node, key) {
      try { var s = node.getSharedPluginData(NS, key); return typeof s === "string" ? s : ""; } catch (e) { return ""; }
    }

    var ctx = {
      figma: figma,
      task: task,
      S: session,
      report: report,
      value: value,
      prop: function (rec, name) {
        var pr = rec && isObj(rec.props) ? rec.props : {};
        var v = pr[name];
        if (v === undefined) {
          var kinds = rec && own(PXF_PROPS.KNOWN_PROPS, rec.type) ? PXF_PROPS.KNOWN_PROPS[rec.type] : null;
          return kinds && own(kinds, name) && own(PXF_PROPS.DEFAULTS, name) ? clone(PXF_PROPS.DEFAULTS[name]) : undefined;
        }
        return PXF_SCHEMA.INTERNED_PROPS.indexOf(name) >= 0 ? value(v) : v;
      },
      phase: function (name) {
        var now = Date.now();
        if (phaseName !== null) report.ms[phaseName] = (report.ms[phaseName] || 0) + (now - phaseAt);
        phaseName = name === undefined || name === null ? null : String(name);
        phaseAt = now;
        if (typeof host.phase === "function") host.phase(phaseName);
        progress();
      },
      breathe: function (k) {
        if (!(k > 0) || k % BREATHE_EVERY !== 0) return Promise.resolve();
        var now = Date.now();
        if (now - lastBreath < BREATHE_MS) return Promise.resolve();
        lastBreath = now;
        progress();
        return figma.getNodeByIdAsync(figma.root.id).then(function () {});
      },
      progress: progress,
      settle: function (root) {
        try { if (root) void root.absoluteBoundingBox; } catch (e) {}
        progress();
        return figma.getNodeByIdAsync(root && root.id ? root.id : figma.root.id).then(function () {});
      },
      measure: function (node, rec) {
        if (typeof host.measure === "function") return host.measure(ctx, node, rec);
        if (typeof IR.countLines !== "function") throw new Error("ctx.measure: IR.countLines is not registered");
        return IR.countLines(ctx, node, rec);
      },
      code: function (code, i, detail) {
        if (typeof code !== "string" || !own(PXF_SCHEMA.REASON_CODES, code)) throw new Error("ctx.code: unknown reason code " + JSON.stringify(code) + " (take codes from IR.CODE)");
        report.codes[code] = (report.codes[code] || 0) + 1;
        report.coded.push({ code: code, i: i === undefined ? null : i, detail: detail === undefined || detail === null ? null : String(detail) });
      },
      failure: function (i, prop, msg) {
        report.failures.push({ i: i === undefined ? null : i, prop: prop === undefined ? null : prop, msg: String(msg) });
      },
      stamp: function (node, key, val) {
        if (STAMP_KEYS.indexOf(key) < 0) throw new Error("ctx.stamp: " + JSON.stringify(key) + " is not a stamp (" + STAMP_KEYS.join(", ") + ")");
        node.setSharedPluginData(NS, key, String(val));
        if (key === "pxScratch") node.setPluginData("pxScratch", String(val));
      },
      stampOf: stampOf,
      findRoot: async function (i) {
        var want = String(i), snap = String(task.snapshot), irv = String(PXF_SCHEMA.VERSION);
        var is = function (n) {
          return !!n && !n.removed && stampOf(n, "pxIdx") === want && stampOf(n, "pxSnap") === snap && stampOf(n, "pxIr") === irv;
        };
        if (own(session.nodes, want)) {
          var known = await figma.getNodeByIdAsync(String(session.nodes[want]));
          if (is(known)) return known;
        }
        var found = null, pages = figma.root.children;
        for (var p = 0; p < pages.length; p++) {
          var page = pages[p];
          if (typeof page.loadAsync === "function") await page.loadAsync();
          var cands = typeof page.findAllWithCriteria === "function"
            ? page.findAllWithCriteria({ sharedPluginData: { namespace: NS, keys: ["pxIdx"] } })
            : page.children;
          for (var c = 0; c < cands.length; c++) if (is(cands[c])) found = cands[c];
        }
        if (found) session.nodes[want] = found.id;
        return found;
      },
      log: function (m) { if (typeof host.log === "function") host.log(String(m)); },
    };
    return Object.freeze(ctx);
  }

  var IR = { ops: {}, probes: {}, makeCtx: makeCtx, setHost: setHost, util: util, CODE: PXF_SCHEMA.CODE, NS: NS,
    STAMP_KEYS: STAMP_KEYS };
  return IR;
})();
