// Part F's end-to-end test: the fixture .pix through every part of M1 (docs/M1.md §7).
//
//   node tools/test-m1-e2e.mjs
//
// The synthetic fixture (tools/pix/fixture.mjs, part A's) goes through the same steps as
// tools/pix-run.mjs, with the plugin played by its bundled IR layer (tools/ir/plugin-vm.mjs) on part E's
// headless double, the way figma-plugin/src/code.js runs a task:
//
//   makeFixture -> pixToIR (A) -> validate -> resolveImages, archive only, no Pixso (D) -> planM1 (D)
//   -> runTasks (D): fonts, clean, build (B), verify (C) as JSON text, validated in the plugin (cmdIr)
//   -> judgeTask with part A's lost-border population (C, via pix-run's judgeWith) -> the run folder
//   -> m1-accept (D): the gates of §8.1, the balance of §8.2, the numbers of §8.3, time per phase.
//
// It asserts, on the fixture: every gate passes, the balance adds up, each excused vector carries its
// pre-registered code, the verdict reads BUILT, NOT VISUALLY AUDITED without Pixso and without an
// audit, and the time per phase is present. Then the same run with one defect planted in Figma after
// the build must FAIL on the gate that owns it: a size off by 2 px (G7), a vector redrawn with no code
// to excuse it (G9), a missing node (G3, and G9's "missing", which no code excuses), and a task the
// plugin refuses (G1). pix-run --dry --no-pixso on the fixture file prints the preflight and a balance
// that adds up. Everything it writes goes to the system's temporary folder, outside the repository.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture } from "./pix/fixture.mjs";
import { readPix } from "./pix/read.mjs";
import { pixToIR } from "./pix/ir/index.mjs";
import { CODE, ORACLE_CLASSES, VECTOR_TYPES } from "./ir/schema.mjs";
import { BUILD_PHASES, maxTaskChars, taskChars } from "./ir/task.mjs";
import { validate, validateTask } from "./ir/validate.mjs";
import { cleanTaskFor, planM1 } from "./ir/plan.mjs";
import { resolveImages } from "./ir/images.mjs";
import { newStates, probeStatus, resumeStates, runTasks, saveStates } from "./ir/runstate.mjs";
import { BUILT_NOT_AUDITED } from "./ir/verdict.mjs";
import { judgeRun } from "./ir/judge.mjs";
import { makeDouble, loadVerdicts } from "./double/index.mjs";
import { loadPluginBundle, defaultHost } from "./ir/plugin-vm.mjs";
import { startJobServer, newSecrets } from "./jobserver.mjs";
import { judgeWith } from "./pix-run.mjs";
import { accept, main as acceptMain } from "./m1-accept.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (cond, m, why) => (cond ? ok(m) : fail(m + (why !== undefined ? " — " + String(why).slice(0, 600) : "")));
const show = (v) => JSON.stringify(v);
const RUN = "0f1e2d3c4b5a6978";
const SCRATCH = mkdtempSync(join(tmpdir(), "pxf-e2e-"));
const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

// ============================================================================================
// the source: the fixture, read the way pix-run reads it (--no-pixso: the archive is the only link)
// ============================================================================================
const FX = makeFixture("valid");
const READ = pixToIR(FX.pix, { settings: {} });
const IR = READ.ir, STATS = READ.stats;
const PIX = readPix(FX.pix);
const VERDICTS = loadVerdicts();
const noteOf = (i, code) => IR.notes.filter((n) => n.node === i && n.code === code);
const notesOn = (i) => IR.notes.filter((n) => n.node === i).map((n) => n.code);

// One Figma file: a double with the plugin's IR layer loaded on it, as one plugin window runs it.
function makeFile() {
  const D = makeDouble({ verdicts: VERDICTS });
  const host = defaultHost();
  host.phase = D.setPhase;
  const figImages = {}, figErrors = {};
  host.images = () => figImages;
  host.imageErrors = () => figErrors;
  return { D, B: loadPluginBundle({ figma: D.figma, host }), figImages, figErrors };
}

// One run, as tools/pix-run.mjs runs it, with the plugin played in the double. opts.plant(taskNo, env)
// runs after a build task and may change Figma; opts.refuse(task) makes the plugin throw on a task.
// A run attempt of its own (§15.12): opts.file is the Figma file of an earlier attempt (makeFile, or
// that run's .file), opts.runId the attempt's runId (RUN by default), opts.prev the states.json the
// earlier attempt left (resumed as pix-run resumes it); opts.elsewhere(task) sends a task to a second
// file (a second plugin window); opts.stall(task) makes the plugin stall on a task (PLUGIN_STALLED).
async function runOnce(label, opts) {
  const o = opts || {};
  const IR = o.ir || READ.ir;
  const { bytes, table } = await resolveImages(IR, PIX, { links: ["archive"], verdicts: VERDICTS });
  const plan = planM1(IR, STATS, Object.assign({ m1Scope: "default", images: table, runId: o.runId || RUN }, o.maxChars ? { maxChars: o.maxChars } : {}));
  const file = o.file || makeFile(), other = o.elsewhere ? makeFile() : null;
  const { D, B } = file;
  const env = { D, B, ctxs: new Map(), plan, file, other, sent: [] };
  // figma-plugin/src/code.js: images first (createImage per hash, a refusal remembered), then cmdIr:
  // the task text parsed, validated whole against the plugin's own tables, then the op.
  const post = async (task, p) => {
    const P = JSON.parse(JSON.stringify(task));
    env.sent.push(P);
    if (o.stall && o.stall(P)) { const e = new Error(CODE.PLUGIN_STALLED + ": synthetic"); e.code = CODE.PLUGIN_STALLED; e.resumable = true; throw e; }
    const F = other && o.elsewhere(P) ? other : file;
    for (const [hash, buf] of p.images) {
      try { F.figImages[hash] = F.D.figma.createImage(new Uint8Array(buf)).hash; delete F.figErrors[hash]; }
      catch (e) { F.figErrors[hash] = String((e && e.message) || e); }
    }
    if (o.refuse && o.refuse(P)) throw new Error("synthetic: the plugin refused task " + P.taskNo);
    const v = F.B.PXF_TASK.validateTask(P, { schema: F.B.PXF_SCHEMA, props: F.B.PXF_PROPS, maxChars: F.B.PXF_TASK.MAX_TASK_CHARS_CEILING, maxErrors: 20 });
    if (!v.ok) throw new Error("ir: the task is refused: " + v.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join("; "));
    const ctx = F.B.PXF_IR.makeCtx(F.D.figma, P, { id: label + "-" + P.taskNo });
    if (F === file) env.ctxs.set(P.taskNo, ctx);
    const rep = await F.B.PXF_IR.ops[P.op](ctx, P);
    if (P.op === "build" && o.plant) await o.plant(P.taskNo, env, P);
    return JSON.parse(JSON.stringify(rep));
  };
  const imagesFor = imagesOf(bytes);
  let states = statesFor(IR, plan, o.runId);
  if (o.prev) states = resumeStates(JSON.parse(JSON.stringify(o.prev)), states, plan.tasks).states;
  const reports = [], said = [];
  const r = await runTasks({ states, tasks: plan.tasks, post, imagesFor, clean: (t) => cleanTaskFor(t, IR), judge: judgeWith(IR, STATS),
    onReport: (t, rep) => reports.push({ taskNo: t.taskNo, op: t.op, rep }), log: (l) => said.push(l), missingFonts: "ask" });
  return Object.assign(env, { table, states, reports, r, said }, folderOf(label, IR, table, plan, states, r));
}
const imagesOf = (bytes) => (task) => { const m = new Map(); for (const im of task.images) if (im.source !== "none" && bytes.has(im.hash)) m.set(im.hash, bytes.get(im.hash)); return m; };
function statesFor(IR, plan, runId) {
  const settings = { source: "pix", scope: "file", m1Scope: "default", booleans: "auto", spaceEvenlySingle: "between", textFit: "widen", layoutOrder: "creation",
    textRead: "measure", images: "archive", noPixso: true, missingFonts: "ask", fallbackFont: { family: "Inter", style: "Regular" }, maxTaskMb: 4,
    livenessWarnS: 60, livenessFailS: 300, ceilingMsPerNode: 20 };
  return newStates({ snapshot: plan.tasks[0].snapshot, irVersion: IR.header.version, runId: runId || RUN, settings, probes: probeStatus(VERDICTS),
    pixso: { used: false, identity: null, q5: false }, balance: plan.balance, ledger: plan.ledger });
}
// The run folder, as pix-run writes it, and m1-accept over it.
function folderOf(label, IR, table, plan, states, r) {
  const runDir = join(SCRATCH, label);
  mkdirSync(join(runDir, "judge"), { recursive: true });
  const out = (f, v) => writeFileSync(join(runDir, f), JSON.stringify(v), "utf8");
  out("ir.json", IR);
  out("stats.json", STATS);
  out("images.json", table);
  out("plan.json", { balance: plan.balance, preflight: plan.preflight, ledger: plan.ledger,
    outOfScope: Object.keys(plan.scope.outOfScope).reduce((m, k) => { m[k] = plan.scope.outOfScope[k].length; return m; }, {}),
    records: plan.tasks.filter((t) => t.op === "build").reduce((m, t) => { m[t.taskNo] = t.nodes.map((n) => n.i); return m; }, {}) });
  saveStates(join(runDir, "states.json"), states);
  for (const j of r.Js) out(join("judge", j.taskNo + ".json"), j.J);
  const totals = r.Js.length ? judgeRun(r.Js.map((j) => j.J)) : null;
  const A = accept(runDir, {});
  return { totals, runDir, accepted: A, gates: A.gates };
}
const failedGates = (run) => run.gates.failed.slice().sort();
const rowsOf = (run) => run.reports.filter((x) => x.op === "verify").flatMap((x) => x.rep.rows);
const buildTaskOf = (run, i) => run.plan.tasks.find((t) => t.op === "build" && t.nodes.some((n) => n.i === i));
const nodeOf = (run, i) => run.D.node(run.ctxs.get(buildTaskOf(run, i).taskNo).S.nodes[String(i)]);

// ============================================================================================
// 1. the IR and the plan
// ============================================================================================
{
  const v = validate(IR);
  check(v.ok && IR.header.version === 2, "the fixture's IR is valid IR version 2", show(v.errors.slice(0, 3)));
  const plan = planM1(IR, STATS, { m1Scope: "default", runId: RUN });
  const cap = maxTaskChars(4);
  const bad = plan.tasks.filter((t) => !validateTask(t).ok || taskChars(t) > cap);
  check(!bad.length && plan.tasks[0].op === "fonts" && plan.tasks.slice(1).every((t, k) => t.op === (k % 2 ? "verify" : "build")),
    "every task is valid and under the 4 MB cap; a fonts task first, then build and verify pairs (" + plan.tasks.length + " tasks)", show(bad.map((t) => t.taskNo)));
  const oracle = plan.tasks.flatMap((t) => t.nodes).filter((n) => n.props.oracleFillGeometry !== undefined || n.props.oracleSides !== undefined);
  check(!oracle.length, "no task carries an oracle prop");
  const cleans = plan.tasks.filter((t) => t.op === "build").map((t) => cleanTaskFor(t, IR));
  check(cleans.every((c) => validateTask(c).ok) && cleans.some((c) => c.notes.length > 0),
    "the clean task sent before each build is valid, its roots' notes with it", show(cleans.map((c) => validateTask(c).errors.slice(0, 2))));
  const B = plan.balance;
  check(B.ok && B.stored.ok && B.nonInstance.ok && B.instances.ok && B.stored.stored === STATS.stored,
    "the balance adds up: stored " + B.stored.stored + " = " + B.stored.sum + "; non-instance " + B.nonInstance.ir + " = " + B.nonInstance.sum + "; INSTANCE " + B.instances.ir + " = " + B.instances.sum, show(B));
}

// ============================================================================================
// 2. the whole run, without Pixso and without an audit: BUILT, NOT VISUALLY AUDITED
// ============================================================================================
const GOOD = await runOnce("built");
{
  const S = GOOD.states;
  check(S.tasks.every((t) => t.state === "built" || t.state === "built-with-fallbacks") && GOOD.r.stopped === null,
    "every task of the run is built (" + S.tasks.length + " tasks)", show(S.tasks.map((t) => t.taskNo + ":" + t.state + (t.error ? " " + t.error.split("\n")[0] : ""))));
  const G = GOOD.gates;
  check(G.gates.length === 12 && G.gates.every((g) => !g.fail), "every gate of §8.1 passes on the fixture", show(G.gates.filter((g) => g.fail)));
  // Every gating probe is recorded since the live session of 2026-10-05, so the order is frozen.
  check(G.verdict.indexOf(BUILT_NOT_AUDITED) === 0 && G.pending.length === 0 && GOOD.accepted.lines.some((l) => /^VERDICT: BUILT, NOT VISUALLY AUDITED: /.test(l)) &&
    !GOOD.accepted.lines.some((l) => /creation order not frozen/.test(l)),
    "without Pixso and without an audit the verdict reads BUILT, NOT VISUALLY AUDITED; with every gating probe recorded the creation order is frozen", G.verdict);
  check(S.pixso.used === false && GOOD.table.every((t) => t.source === "archive" || t.source === "none") && GOOD.table.some((t) => t.source === "none") &&
    G.counts[CODE.IMAGE_PLACEHOLDER] === GOOD.table.filter((t) => t.source === "none").length,
    "no Pixso: the archive is the only image link, and each unresolved image is a counted placeholder (" + G.counts[CODE.IMAGE_PLACEHOLDER] + ")", show(GOOD.table));

  // Time per phase: every build reports every phase of BUILD_PHASES, and m1-accept prints them.
  const builds = GOOD.reports.filter((x) => x.op === "build");
  check(builds.length > 0 && builds.every((x) => BUILD_PHASES.every((p) => Number.isFinite(x.rep.ms[p]))) &&
    S.tasks.filter((t) => t.op === "build").every((t) => BUILD_PHASES.every((p) => Number.isFinite(t.ms[p]))) &&
    GOOD.accepted.lines.some((l) => /^build time: .* per 1 000/.test(l)) && GOOD.accepted.lines.some((l) => /^reader: unzip \d+ ms, zstd \d+ ms, kiwi \d+ ms, ir \d+ ms/.test(l)),
    "time per phase is present: every build books all " + BUILD_PHASES.length + " phases, and m1-accept prints them per 1 000 records with the reader's times");

  // The auto layout the builds gave up to hold positions is printed beside the gates (review figma F3).
  check(S.tasks.filter((t) => t.op === "build").every((t) => t.flow && Number.isFinite(t.flow.groupNodes) && Number.isFinite(t.flow.quarterTurnsBaked)) &&
    GOOD.accepted.lines.some((l) => /^flow: [0-9]+ children taken out of auto layout to hold their place .*[0-9]+ turned leaves kept in it/.test(l)),
    "each build records the auto layout it gave up, and m1-accept prints it", show(S.tasks.filter((t) => t.op === "build").map((t) => t.flow)));

  // The balance, in the acceptance report.
  check(S.balance.ok && GOOD.accepted.lines.some((l) => l === "BALANCE (adds up)"), "m1-accept prints the balance, and it adds up");

  // Count and placeholders against the plan.
  const T = GOOD.totals;
  const inScope = GOOD.plan.tasks.filter((t) => t.op === "build").flatMap((t) => t.nodes);
  const instances = inScope.filter((n) => n.type === "INSTANCE").length;
  check(T.count.ok && T.count.built === inScope.length && T.placeholders.aligned === instances && instances === S.balance.instances.placeholders && instances > 0,
    "every record in scope is built (" + inScope.length + "), and every INSTANCE is an aligned placeholder (" + instances + ")", show([T.count, T.placeholders]));

  // Vectors: every excused vector carries its pre-registered code; nothing built from the oracle differs.
  const vecs = inScope.filter((n) => VECTOR_TYPES.indexOf(n.type) >= 0);
  const classed = vecs.filter((n) => noteOf(n.i, CODE.VECTOR_ORACLE_DIFFERS).length);
  // Review S3: a STAR and a POLYGON with no stored geometry carry their note, and it excuses them.
  const natives = vecs.filter((n) => (n.type === "STAR" || n.type === "POLYGON") && IR.nodes[n.i].props.oracleFillGeometry === undefined);
  check(natives.length === 2 && natives.every((n) => noteOf(n.i, CODE.SOURCE_FEATURE_UNSUPPORTED).some((x) => /^no stored geometry/.test(x.detail))) &&
    T.vectors.excused[CODE.SOURCE_FEATURE_UNSUPPORTED] === natives.length,
    "a STAR and a POLYGON with no stored geometry are noted SOURCE_FEATURE_UNSUPPORTED and excused under it, not VECTOR_GEOMETRY_DIFFERS", show(T.vectors));
  check(T.vectors.checked === vecs.length && T.vectors.differs.length === 0 && Object.keys(T.vectors.excused).every((c) => c === CODE.VECTOR_ORACLE_DIFFERS || c === CODE.SOURCE_FEATURE_UNSUPPORTED) &&
    T.vectors.excused[CODE.VECTOR_ORACLE_DIFFERS] === classed.length && classed.length === ORACLE_CLASSES.length &&
    ORACLE_CLASSES.every((c) => classed.some((n) => noteOf(n.i, CODE.VECTOR_ORACLE_DIFFERS)[0].detail.split(":")[0] === c)),
    "each excused vector carries its pre-registered code: " + classed.length + " VECTOR_ORACLE_DIFFERS, one per class (" + ORACLE_CLASSES.join(", ") + "); no vector differs", show(T.vectors));
  const fromOracle = vecs.filter((n) => notesOn(n.i).some((c) => c === CODE.VECTOR_FROM_GEOMETRY || c === CODE.BOOLEAN_FLATTENED));
  check(fromOracle.length >= 2 && Object.keys(T.vectors.excusedBuiltFromOracle).length === 0,
    "the " + fromOracle.length + " vectors built from their stored geometry (VECTOR_FROM_GEOMETRY, BOOLEAN_FLATTENED) match it: excusedBuiltFromOracle is empty, nothing to review");
  check(T.geometry.visibleOver05 === 0 && T.geometry.sizeVisibleOver05 === 0 && T.geometry.classified.vectorBox > 0,
    "geometry: no visible offset or size over 0.5 px; " + T.geometry.classified.vectorBox + " vectors whose box Figma takes from their drawing are classified vectorBox", show(T.geometry));

  // Sides and the lost-border population (part A's, passed to the judge by pix-run's judgeWith).
  const lostInScope = STATS.populations.lostBorder.filter((i) => inScope.some((n) => n.i === i)).length;
  check(T.sides.checked > 0 && T.sides.checkedAgainstOracle > 0 && T.sides.unproven > 0 && lostInScope > 0 &&
    T.sides.lostBorder.population === lostInScope && T.sides.lostBorder.ok === lostInScope,
    "sides match the IR and the oracle; the lost-border population in scope (" + lostInScope + ") is judged, and Figma draws every one", show(T.sides));

  // Text: every text with stored lines is measured on the built node.
  const texts = inScope.filter((n) => n.type === "TEXT");
  check(T.text.checked + T.text.unknown === texts.length && T.text.checked > 0 && T.text.unmeasured === 0 && T.text.differ.length === 0,
    "every text with lines is measured and agrees (" + T.text.checked + " checked, " + T.text.unknown + " TEXT_LINES_UNKNOWN)", show(T.text));

  // Visibility: Figma shows exactly what the IR shows (the judge gates on the IR's; this holds it here).
  const shown = (i) => IR.nodes[i].props.visible !== false && (IR.nodes[i].parent < 0 || shown(IR.nodes[i].parent));
  const vis = rowsOf(GOOD).filter((w) => w[3] !== shown(w[0]));
  check(rowsOf(GOOD).length === inScope.length && !vis.length, "Figma's effective visibility equals the IR's on every built record", show(vis.slice(0, 3)));

  // Nothing of the run's own is left in Figma: no scratch text.
  check(JSON.stringify(GOOD.D.tree()).indexOf("pxScratch") < 0, "no measuring scratch node is left after the run");

  // The audit is what turns it into PASS, and only an audit that covers every built root.
  const roots = GOOD.plan.tasks.filter((t) => t.op === "build").flatMap((t) => t.roots.map((r) => ({ i: r.i, ok: true })));
  const pass = accept(GOOD.runDir, { audit: { format: "pix2fig.audit", version: 1, roots } }).gates;
  const part = accept(GOOD.runDir, { audit: { format: "pix2fig.audit", version: 1, roots: roots.slice(1) } }).gates;
  // The fixture plants one side the stored path decides against the side fields (SIDE_RULE_UNPROVEN):
  // a PASS with it is qualified until a live render settles it (review R5).
  check(/^PASS, with attention: [0-9]+ SIDE_RULE_UNPROVEN/.test(pass.verdict) && part.verdict.indexOf(BUILT_NOT_AUDITED) === 0 && /SIDE_RULE_UNPROVEN [1-9]/.test(G.verdict),
    "with a render audit covering every built root the verdict is PASS, qualified by the unproven sides; one root short, it stays BUILT, NOT VISUALLY AUDITED", pass.verdict);
  // Review F4: an audit tied to another run, or naming other records by guid, covers nothing.
  const v2 = (o) => accept(GOOD.runDir, { audit: Object.assign({ format: "pix2fig.audit", version: 2, snapshot: S.snapshot, runId: S.runId, roots: roots.map((r) => ({ i: r.i, guid: IR.nodes[r.i].guid, ok: true })) }, o) }).gates;
  const stale = v2({ runId: "ffffffffffffffff" }), other = v2({ roots: roots.map((r) => ({ i: r.i, guid: "9:" + r.i, ok: true })) }), bare = v2({ snapshot: undefined });
  check(/^PASS/.test(v2({}).verdict) && stale.verdict.indexOf(BUILT_NOT_AUDITED) === 0 && /made for another run/.test(stale.auditLine) &&
    other.verdict.indexOf(BUILT_NOT_AUDITED) === 0 && bare.verdict.indexOf(BUILT_NOT_AUDITED) === 0,
    "an audit of version 2 names its run: this run's passes; another runId, other guids, or no snapshot is not an audit of this run", [stale.auditLine, other.auditLine, bare.auditLine].join(" | "));
  check(quiet(() => acceptMain([GOOD.runDir])) === 0, "m1-accept exits 0 on the run");
}

// ============================================================================================
// 3. runs that must FAIL: one defect planted in Figma after the build, each caught by its gate
// ============================================================================================
const inScopeOf = () => GOOD.plan.tasks.filter((t) => t.op === "build").flatMap((t) => t.nodes);
const flowParent = (n) => { const p = IR.nodes[n.parent]; return !!p && (p.props.layoutMode === "HORIZONTAL" || p.props.layoutMode === "VERTICAL"); };
{
  // A size off by 2 px: a visible RECTANGLE outside any auto layout, resized after the build.
  const target = inScopeOf().find((n) => n.type === "RECTANGLE" && n.parent >= 0 && !flowParent(n) && IR.nodes[n.parent].type !== "BOOLEAN_OPERATION" &&
    IR.nodes[n.i].props.visible !== false);
  const run = await runOnce("size", { plant: (no, env) => { if (buildTaskOf(GOOD, target.i).taskNo === no) { const n = nodeOf(env, target.i); n.resize(n.width + 2, n.height); } } });
  const w = run.totals.geometry.worst.find((x) => x.i === target.i);
  check(failedGates(run).join() === "G7 size" && w && w.dw === 2 && run.gates.verdict === "FAIL (G7 size)",
    "a size off by 2 px fails G7, and only G7", show([failedGates(run), w]));
  check(quiet(() => acceptMain([run.runDir])) === 3, "m1-accept exits 3 on a FAIL verdict");
}
{
  // A network vector with no excusing code, redrawn after the build: VECTOR_GEOMETRY_DIFFERS.
  const target = inScopeOf().find((n) => n.type === "VECTOR" && n.props.vectorNetwork !== undefined && !notesOn(n.i).length && IR.nodes[n.i].props.oracleFillGeometry !== undefined);
  const run = await runOnce("vector", { plant: (no, env) => {
    if (buildTaskOf(GOOD, target.i).taskNo === no) nodeOf(env, target.i).vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 4 0 L 4 4 L 0 4 Z" }];
  } });
  const T = run.totals;
  check(failedGates(run).indexOf("G9 vectors") >= 0 && T.vectors.differs.length === 1 && T.vectors.differs[0].i === target.i && T.vectors.differs[0].kind === "bounds" &&
    T.codes[CODE.VECTOR_GEOMETRY_DIFFERS] === 1 && /^FAIL \(.*G9 vectors/.test(run.gates.verdict),
    "a vector geometry mismatch without an excusing code fails G9 (VECTOR_GEOMETRY_DIFFERS, bounds)", show([failedGates(run), T.vectors.differs]));
}
{
  // A missing node: a vector inside a root, carrying codes that excuse any mismatch of its paths
  // (GEOMETRY_INVALID, VECTOR_FROM_GEOMETRY), removed after the build. No code excuses a missing node.
  const target = inScopeOf().find((n) => n.type === "VECTOR" && n.parent >= 0 && buildTaskOf(GOOD, n.i).nodes.some((m) => m.i === n.parent) &&
    notesOn(n.i).indexOf(CODE.GEOMETRY_INVALID) >= 0);
  const run = await runOnce("missing", { plant: (no, env) => { if (buildTaskOf(GOOD, target.i).taskNo === no) nodeOf(env, target.i).remove(); } });
  const T = run.totals;
  check(failedGates(run).join() === "G3 count,G4 balance,G9 vectors" && T.count.built === T.count.expected - 1 && T.vectors.differs.length === 1 &&
    T.vectors.differs[0].i === target.i && T.vectors.differs[0].kind === "missing" && T.vectors.excused[CODE.VECTOR_ORACLE_DIFFERS] === ORACLE_CLASSES.length,
    "a missing node fails G3 (count), G4 (the built side is one short of the plan) and G9 (missing), though its codes excuse any mismatch of its paths", show([failedGates(run), T.count, T.vectors]));
}
{
  // Review F2: a stroked leaf moved under an unrelated frame with no child records. The totals agree
  // (no node is missing or extra), so only pairing every record and its child count catches it.
  const recs = inScopeOf();
  const kids = (i) => recs.filter((n) => n.parent === i);
  const leaf = recs.find((n) => (n.type === "RECTANGLE" || n.type === "ELLIPSE") && n.parent >= 0 && !kids(n.i).length && IR.nodes[n.i].props.strokes !== undefined &&
    kids(n.parent).slice(-1)[0].i === n.i && IR.nodes[n.parent].type !== "BOOLEAN_OPERATION");
  const task = buildTaskOf(GOOD, leaf.i);
  const host = task.nodes.find((n) => n.type === "FRAME" && n.i !== leaf.parent && !kids(n.i).length);
  const run = await runOnce("reparent", { plant: (no, env) => { if (no === task.taskNo) nodeOf(env, host.i).appendChild(nodeOf(env, leaf.i)); } });
  check(failedGates(run).indexOf("G3 count") >= 0 && run.totals.count.built === run.totals.count.expected,
    "a leaf moved under an unrelated frame after the build fails G3, though the node totals agree", show([failedGates(run), run.totals.count]));
}
{
  // A missing root: VERIFY cannot find it (ROOT_NOT_FOUND).
  const target = inScopeOf().find((n) => n.parent < 0 && n.type === "FRAME");
  const run = await runOnce("root", { plant: (no, env) => { if (buildTaskOf(GOOD, target.i).taskNo === no) nodeOf(env, target.i).remove(); } });
  check(failedGates(run).join() === "G2 roots,G3 count,G4 balance" && run.totals.codes[CODE.ROOT_NOT_FOUND] === 1,
    "a root removed after the build fails G2 (ROOT_NOT_FOUND), G3 and G4 (its subtree is missing from the built side)", show(failedGates(run)));
}
{
  // A task the plugin refuses: BUILD_FAILED, its verify skipped, G1 (and G2, a verify that did not run).
  const run = await runOnce("refused", { refuse: (t) => t.op === "build" && t.taskNo === 2 });
  const S = run.states;
  check(S.tasks[1].state === "failed" && S.tasks[1].codes[CODE.BUILD_FAILED] === 1 && S.tasks[2].state === "skipped" &&
    failedGates(run).indexOf("G1 tasks") >= 0 && failedGates(run).indexOf("G2 roots") >= 0 && /^FAIL/.test(run.gates.verdict),
    "a refused task fails G1 (BUILD_FAILED, its verify skipped) and the verdict is FAIL", show(failedGates(run)));
}

{
  // Review F1: a widened text excuses only what its widening can push. The fixture's one-line badge
  // label made longer than its box, so the build widens it (decision 9); every gate still passes.
  // Moved 25 px right after the build, the label fails G6: a LEFT text never moves right of its
  // place, whatever its widening (the old rule excused any move up to the root's total widening).
  const ir = JSON.parse(JSON.stringify(IR));
  const label = ir.nodes.findIndex((n) => n.type === "TEXT" && n.props.lines === 1 && n.parent >= 0 && ir.nodes[n.parent].type === "COMPONENT");
  ir.nodes[label].props.characters = "New arrivals for the whole week";
  const run = await runOnce("widened", { ir });
  const coded = run.reports.filter((x) => x.op === "build").flatMap((x) => x.rep.coded).filter((c) => c.code === CODE.TEXT_WIDENED_TO_SOURCE_LINES && c.i === label);
  check(validate(ir).ok && coded.length === 1 && failedGates(run).length === 0 && run.totals.geometry.classified.textWidened >= 1,
    "a text the build widens (" + (coded[0] && coded[0].detail) + ") is classified textWidened, and every gate passes", show([failedGates(run), run.totals.geometry]));
  const moved = await runOnce("widened-move", { ir, plant: (no, env) => {
    const id = env.ctxs.get(no).S.nodes[String(label)];
    if (!env.plan.tasks.find((t) => t.taskNo === no).nodes.some((n) => n.i === label)) return;
    const n = env.D.node(id);
    n.relativeTransform = [[1, 0, n.relativeTransform[0][2] + 25], [0, 1, n.relativeTransform[1][2]]];
  } });
  check(failedGates(moved).join() === "G6 position", "the widened text moved 25 px after the build fails G6", show([failedGates(moved), moved.totals.geometry.worst.slice(0, 2)]));
}

// ============================================================================================
// 3b. a root split across tasks (review S1): the plan's size cap lowered so the fixture's auto-layout
// row is split, its later pieces attached by a later task to the row an earlier task built
// ============================================================================================
{
  const SPLIT = 4500;
  const plan = planM1(IR, STATS, { m1Scope: "default", runId: RUN, maxChars: SPLIT });
  const builds = plan.tasks.filter((t) => t.op === "build");
  const split = builds.flatMap((t) => t.roots.filter((r) => typeof r.attachTo === "object").map((r) => ({ taskNo: t.taskNo, i: r.i, parent: r.attachTo.i })));
  const inFlow = split.filter((s) => { const p = IR.nodes[s.parent].props; return (p.layoutMode === "HORIZONTAL" || p.layoutMode === "VERTICAL") && IR.nodes[s.i].props.layoutPositioning !== "ABSOLUTE"; });
  const ledgerOk = plan.ledger.filter((l) => l.op === "verify").every((l) => Number.isInteger(l.build) && plan.tasks[l.build - 1].op === "build" &&
    JSON.stringify(plan.tasks[l.build - 1].roots) === JSON.stringify(plan.tasks[l.taskNo - 1].roots));
  const chainTask = split.length ? split[0].taskNo : 0;
  const parentTask = split.length ? builds.find((t) => t.nodes.some((n) => n.i === split[0].parent)).taskNo : 0;
  const parentVerify = plan.ledger.find((l) => l.op === "verify" && l.build === parentTask);
  check(inFlow.length > 0 && ledgerOk && parentVerify && parentVerify.taskNo > chainTask,
    "a split plan: " + split.length + " split roots (" + inFlow.length + " in an auto-layout flow); each verify names its build, and the split parent's verify runs after the chain's last build",
    show({ split, ledger: plan.ledger }));
  const run = await runOnce("split", { maxChars: SPLIT });
  check(run.r.stopped === null && failedGates(run).length === 0 && run.states.tasks.every((t) => t.state === "built" || t.state === "built-with-fallbacks"),
    "the split run builds, and every gate passes: each split piece sits where the IR puts it in its parent", show([failedGates(run), run.totals && run.totals.geometry.worst.slice(0, 3)]));
  const target = inFlow[0];
  const moved = await runOnce("split-move", { maxChars: SPLIT, plant: (no, env) => {
    if (no !== target.taskNo) return;
    const n = env.D.node(env.ctxs.get(no).S.nodes[String(target.i)]);
    n.relativeTransform = [[1, 0, n.relativeTransform[0][2] + 50], [0, 1, n.relativeTransform[1][2]]];
  } });
  const w = moved.totals.geometry.worst.find((x) => x.i === target.i);
  check(failedGates(moved).join() === "G6 position" && w && w.dx === 50,
    "a split root moved 50 px in its parent after its build fails G6, as the same move inside one task does", show([failedGates(moved), w]));
}

// ============================================================================================
// 3c. two plugin windows open at once: one run's work stays in one Figma file
// ============================================================================================
// The second live build of the test kit K (2026-10-05) had the plugin open in two Figma files, both
// paired with the runner. The job server answered every held /job request with the pending job, so
// each window ran whatever it was idle for and the first report back won: one page's build landed in
// one file and its verify ran in the other, which never made its roots (ROOT_NOT_FOUND: G2, G3 and
// G11 failed), and other verifies measured another file's copy. Played here through the real job
// server, each window a client of its routes (as figma-plugin/src/ui.html is) with its own Figma
// (a double) and its own plugin (the bundled IR layer), in K's order: window B is still finishing a
// clean when the build after it is posted, so only window A builds; B then takes the verify and
// answers first. Whatever the windows do, every job must go to one window, so every root a build
// makes is there for its verify: S2 masters on the service page and split chains included.
async function twoWindows(label, o) {
  const opts = o || {};
  const { bytes, table } = await resolveImages(IR, PIX, { links: ["archive"], verdicts: VERDICTS });
  const plan = planM1(IR, STATS, Object.assign({ m1Scope: "default", images: table, runId: RUN }, opts.maxChars ? { maxChars: opts.maxChars } : {}));
  const sec = newSecrets(), said = [];
  const srv = startJobServer(0, Object.assign({ log: (m) => said.push(String(m)) }, sec));
  await srv.ready;
  const base = "http://127.0.0.1:" + srv.port;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  // The first of the promises, or nothing after ms; the timer is cleared either way.
  const within = (ms, ps) => { let t = null; return Promise.race(ps.concat([new Promise((res) => { t = setTimeout(res, ms); })])).finally(() => clearTimeout(t)); };
  // Signals between the runner and the windows, so the interleaving is K's every time.
  const verifyPosted = [], reported = new Map();
  const nextVerify = () => new Promise((res) => verifyPosted.push(res));
  const heard = (name, what) => {
    const k = name + ":" + what;
    if (!reported.has(k)) { let r = null; const p = new Promise((x) => { r = x; }); reported.set(k, { p, r }); }
    return reported.get(k);
  };
  function playWindow(name, hooks) {
    const D = makeDouble({ verdicts: VERDICTS }), host = defaultHost(), figImages = {}, figErrors = {};
    host.phase = D.setPhase; host.images = () => figImages; host.imageErrors = () => figErrors;
    const B = loadPluginBundle({ figma: D.figma, host });
    const H = { Origin: "null", Authorization: "Bearer " + sec.token, "X-PXF-Window": name };
    const ctl = new AbortController();
    const w = { name, D, ran: [], refused: false, polled: 0, error: null };
    let done = null;
    w.out = new Promise((res) => { done = res; });
    const get = (path) => fetch(base + path, { headers: H, signal: ctl.signal });
    (async () => {
      try {
        for (;;) {
          w.polled++;
          const jr = await get("/job?client=plugin");
          if (jr.status === 423) { w.refused = true; break; }
          const job = await jr.json();
          if (!job || job.kind === "noop") continue;
          const pr = await get("/job/" + job.id + "/payload");
          // Gone already: another window's report ended it (the window posts an error, as ui.html does).
          if (pr.status !== 200) { w.ran.push("gone " + job.kind); continue; }
          const P = JSON.parse(await pr.text());
          for (const h of job.images || []) {
            const b64 = await (await get("/image/" + h + "?b64=1")).text();
            try { figImages[h] = D.figma.createImage(new Uint8Array(Buffer.from(b64, "base64"))).hash; } catch (e) { figErrors[h] = String((e && e.message) || e); }
          }
          let rep;
          try {
            const v = B.PXF_TASK.validateTask(P, { schema: B.PXF_SCHEMA, props: B.PXF_PROPS, maxChars: B.PXF_TASK.MAX_TASK_CHARS_CEILING, maxErrors: 20 });
            if (!v.ok) throw new Error("ir: the task is refused");
            rep = JSON.parse(JSON.stringify(await B.PXF_IR.ops[P.op](B.PXF_IR.makeCtx(D.figma, P, { id: job.id }), P)));
          } catch (e) { rep = { error: String((e && e.message) || e) }; }
          w.ran.push(P.op + " " + P.taskNo);
          if (hooks.beforeReport) await hooks.beforeReport(P);
          const rr = await fetch(base + "/report", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, H), signal: ctl.signal,
            body: JSON.stringify({ id: job.id, i: 0, n: 1, d: JSON.stringify(rep) }) });
          heard(name, P.op + P.taskNo).r();
          if (rr.status === 423) { w.refused = true; break; }
        }
      } catch (e) { if (!ctl.signal.aborted) w.error = String((e && e.message) || e); }
      done();
    })();
    w.close = () => ctl.abort();
    return w;
  }
  // A does everything, but lets B answer a verify first when B has it too. B holds a clean's report
  // until the runner has posted the next verify, so the build in between goes to A alone.
  let B = null;
  const A = playWindow("e2e-window-a", { beforeReport: (P) => (P.op === "verify" ? within(3000, [heard("e2e-window-b", "verify" + P.taskNo).p, B.out]) : null) });
  for (const t0 = Date.now(); srv.lastPoll() === 0 && Date.now() - t0 < 5000;) await sleep(5);
  await sleep(50);   // A's request is held first
  B = playWindow("e2e-window-b", { beforeReport: (P) => (P.op === "clean" ? within(5000, [nextVerify()]) : null) });
  while (B.polled === 0) await sleep(5);
  await sleep(50);
  const post = (task, p) => {
    const pr = srv.post({ kind: "ir" }, JSON.stringify(task), p.images, 60000);
    if (task.op === "verify") while (verifyPosted.length) verifyPosted.shift()();
    return pr;
  };
  const states = statesFor(IR, plan);
  const reports = [];
  const r = await runTasks({ states, tasks: plan.tasks, post, imagesFor: imagesOf(bytes), clean: (t) => cleanTaskFor(t, IR), judge: judgeWith(IR, STATS),
    onReport: (t, rep) => reports.push({ taskNo: t.taskNo, op: t.op, rep }), log: () => {}, missingFonts: "ask" });
  A.close(); B.close();
  await Promise.all([A.out, B.out]);
  srv.close();
  return Object.assign({ plan, states, reports, r, A, B, srv: { window: srv.window, othersRefused: srv.othersRefused }, said }, folderOf(label, IR, table, plan, states, r));
}
// The only part of this test that waits on a network: a deadline, so a job nobody takes fails it.
const twoWindowsDeadline = setTimeout(() => { console.log("FAIL the two-window runs did not finish within 120 s"); process.exit(1); }, 120000);
twoWindowsDeadline.unref();
for (const [label, maxChars] of [["two-windows", 0], ["two-windows-split", 4500]]) {
  const run = await twoWindows(label, { maxChars });
  const verifies = run.reports.filter((x) => x.op === "verify");
  const lost = verifies.flatMap((x) => (x.rep.roots || []).filter((q) => !q.found).map((q) => x.taskNo + ":" + q.i));
  const tasks = run.plan.tasks.filter((t) => t.op === "build" || t.op === "verify").map((t) => t.op + " " + t.taskNo);
  const S2 = run.plan.tasks.filter((t) => t.op === "build" && t.page && t.page.service).length;
  const chains = run.plan.tasks.filter((t) => t.op === "build" && t.roots.some((x) => typeof x.attachTo === "object")).length;
  check(verifies.length > 0 && !lost.length && failedGates(run).length === 0,
    label + ": two plugin windows paired at once, and every verify finds every root its build made (" + verifies.length + " verifies, " + S2 + " S2 master task" + (S2 === 1 ? "" : "s") +
    (chains ? ", " + chains + " split-root task" + (chains === 1 ? "" : "s") : "") + "); every gate passes", show({ lost, gates: failedGates(run), A: run.A.ran.length, B: run.B.ran }));
  check(tasks.every((t) => run.A.ran.indexOf(t) >= 0) && run.B.ran.length === 0 && run.B.refused && !run.A.error && !run.B.error &&
    run.srv.window === "e2e-window-a" && run.srv.othersRefused > 0 && run.said.some((l) => /refused 423/.test(l)),
    label + ": the window that took the first job runs every build and verify of the run; the other is refused (423), takes none, and the runner says so",
    show({ A: run.A.ran.length + "/" + tasks.length, B: run.B.ran, refused: run.B.refused, server: run.srv, errors: [run.A.error, run.B.error] }));
}
clearTimeout(twoWindowsDeadline);

// ============================================================================================
// 3d. a verify measures the build of the attempt that made it, and no other run's copy (§15.12)
// ============================================================================================
// The second live build of K (§15.10): one verify measured the build an earlier run had left in the
// file it ran in, because this attempt's build of that page had gone to another file. Played with two
// files: an earlier run (its own runId) builds everything in the first; a later run sends one page's
// clean and build to the second, and its verify to the first.
const RUN_OLD = "a0a0a0a0a0a0a0a0", RUN_NEW = "b1b1b1b1b1b1b1b1", RUN_RESUMED = "c2c2c2c2c2c2c2c2";
const rootsStamped = (D, run, idx) => D.figma.root.children.flatMap((pg) => pg.findAllWithCriteria({ sharedPluginData: { namespace: "pix2fig", keys: ["pxIdx"] } }))
  .filter((n) => n.getSharedPluginData("pix2fig", "pxRun") === run && idx.indexOf(Number(n.getSharedPluginData("pix2fig", "pxIdx"))) >= 0).length;
{
  const earlier = await runOnce("earlier-run", { runId: RUN_OLD });
  const k = earlier.plan.tasks.find((t) => t.op === "build" && t.page && !t.page.service).taskNo;
  const roots = earlier.plan.tasks.find((t) => t.taskNo === k).roots.map((x) => x.i);
  const run = await runOnce("other-file", { runId: RUN_NEW, file: earlier.file, elsewhere: (t) => (t.op === "clean" || t.op === "build") && t.taskNo === k });
  const vRec = run.states.tasks.find((t) => t.op === "verify" && t.build === k);
  const vRep = run.reports.find((x) => x.op === "verify" && x.taskNo === vRec.taskNo).rep;
  const sentV = run.sent.find((t) => t.op === "verify" && t.taskNo === vRec.taskNo);
  check(rootsStamped(run.D, RUN_OLD, roots) === roots.length && rootsStamped(run.other.D, RUN_NEW, roots) === roots.length && sentV.buildRun === RUN_NEW &&
    vRep.roots.length === roots.length && vRep.roots.every((q) => q.found === false && q.id === null && /only another run's copy/.test(q.reason) && q.reason.indexOf(RUN_OLD) >= 0),
    "a verify names the run that built its task (buildRun), and in a file holding only an earlier run's copy of its " + roots.length + " root" + (roots.length === 1 ? "" : "s") +
    " finds none, each reported found: false with the reason", show({ buildRun: sentV.buildRun, roots: vRep.roots }));
  check(vRec.codes[CODE.ROOT_NOT_FOUND] === roots.length && vRec.buildRun === RUN_NEW && failedGates(run).some((g) => /^G2 /.test(g)) &&
    run.said.some((l) => l.indexOf(CODE.ROOT_NOT_FOUND + ": only another run's copy") >= 0),
    "the judge counts them ROOT_NOT_FOUND (G2 fails), the states record the verify's buildRun, and the runner says why", show({ codes: vRec.codes, gates: failedGates(run) }));
  check(run.states.tasks.filter((t) => t.op === "build").every((t) => t.run === RUN_NEW), "every build task records the run attempt that built it (run)");
}
// A resume: the first attempt stalls on a verify and stops; the second, under a new runId in the same
// file, keeps what the first built and verified and builds the rest again. Each verify names the
// attempt that built its task and finds its roots; the earlier attempt's copy of the re-built task is
// cleaned away, and every gate passes.
{
  const F = makeFile();
  const probe = planM1(IR, STATS, { m1Scope: "default", runId: RUN });
  const lastVerify = probe.tasks.filter((t) => t.op === "verify").pop().taskNo;
  const first = await runOnce("resume", { runId: RUN_OLD, file: F, stall: (t) => t.op === "verify" && t.taskNo === lastVerify });
  const kept = first.states.tasks.filter((t) => t.op === "build" && t.state !== "pending" && t.state !== "failed" && t.state !== "skipped").map((t) => t.taskNo);
  const second = await runOnce("resume", { runId: RUN_RESUMED, file: F, prev: first.states });
  const S = second.states, bOf = (no) => S.tasks.find((t) => t.taskNo === no);
  const redo = S.tasks.find((t) => t.op === "verify" && t.taskNo === lastVerify).build;
  const redoRoots = second.plan.tasks.find((t) => t.taskNo === redo).roots.map((x) => x.i);
  const sentVerifies = second.sent.filter((t) => t.op === "verify");
  check(first.r.stopped === "stalled" && kept.length > 1 && S.tasks.every((t) => t.state === "built" || t.state === "built-with-fallbacks") && failedGates(second).length === 0,
    "a run resumed under a new runId after a stall completes, and every gate passes (" + (kept.length - 1) + " build" + (kept.length === 2 ? "" : "s") + " kept from the first attempt)",
    show({ first: first.r.stopped, kept, gates: failedGates(second), states: S.tasks.map((t) => t.taskNo + ":" + t.state) }));
  check(kept.filter((no) => no !== redo).every((no) => bOf(no).run === RUN_OLD) && bOf(redo).run === RUN_RESUMED &&
    sentVerifies.length === 1 && sentVerifies[0].buildRun === RUN_RESUMED && bOf(lastVerify).buildRun === RUN_RESUMED &&
    S.tasks.filter((t) => t.op === "verify" && t.taskNo !== lastVerify).every((t) => t.buildRun === RUN_OLD),
    "the resume keeps each kept build's run, and the verify run again names the attempt that built its task", show(S.tasks.map((t) => [t.taskNo, t.op, t.run || t.buildRun || null])));
  check(rootsStamped(F.D, RUN_OLD, redoRoots) === 0 && rootsStamped(F.D, RUN_RESUMED, redoRoots) === redoRoots.length,
    "the earlier attempt's copy of the re-built task is cleaned away; its verify measured the new one");
  // Should a verify ever run after its build's attempt (the resume keeps a build only with its verify,
  // as the judge needs the build report), it is sent with that attempt's runId and finds its roots.
  const again = JSON.parse(JSON.stringify(S));
  const vRec = again.tasks.find((t) => t.taskNo === lastVerify);
  Object.assign(vRec, { state: "pending", codes: {}, ms: {} });
  delete vRec.buildRun;
  const plan3 = planM1(IR, STATS, { m1Scope: "default", images: second.table, runId: "d3d3d3d3d3d3d3d3" });
  const sent3 = [];
  const post3 = async (task) => { const P = JSON.parse(JSON.stringify(task)); sent3.push(P); return JSON.parse(JSON.stringify(await F.B.PXF_IR.ops[P.op](F.B.PXF_IR.makeCtx(F.D.figma, P, { id: "again-" + P.taskNo }), P))); };
  const r3 = await runTasks({ states: again, tasks: plan3.tasks, post: post3, imagesFor: () => new Map(), log: () => {}, missingFonts: "ask" });
  const v3 = sent3.find((t) => t.taskNo === lastVerify);
  check(r3.stopped === null && sent3.length === 1 && v3.runId === "d3d3d3d3d3d3d3d3" && v3.buildRun === RUN_RESUMED && vRec.buildRun === RUN_RESUMED && !vRec.codes[CODE.ROOT_NOT_FOUND],
    "a verify sent in a later attempt than its build names the build's attempt and finds every root", show({ sent: sent3.map((t) => [t.taskNo, t.runId, t.buildRun]), codes: vRec.codes }));
}

// ============================================================================================
// 4. pix-run --dry --no-pixso on the fixture file
// ============================================================================================
{
  const file = join(SCRATCH, "fixture.pix");
  writeFileSync(file, FX.pix);
  let out = "", code = 0;
  try { out = execFileSync(process.execPath, [join(HERE, "pix-run.mjs"), file, "--dry", "--no-pixso", "--data", join(SCRATCH, "data")], { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { code = e.status; out = String(e.stdout || "") + String(e.stderr || ""); }
  check(code === 0 && /PREFLIGHT/.test(out) && /BALANCE \(adds up\)/.test(out) && /--dry: nothing was sent to Figma/.test(out) && /placeholder \(IMAGE_PLACEHOLDER\) [1-9]/.test(out),
    "pix-run --dry --no-pixso reads the fixture .pix, prints the preflight and a balance that adds up", out.slice(-800));
}

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) { /* the system cleans its temporary folder */ }
console.log("");
if (failed) { console.log(failed + " end-to-end check" + (failed === 1 ? "" : "s") + " FAILED"); process.exit(1); }
console.log("all end-to-end checks pass");
// The job server's per-job watch runs every 15 s until its next tick: nothing is left to wait for.
process.exit(0);
