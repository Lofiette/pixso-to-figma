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
import { newStates, probeStatus, runTasks, saveStates } from "./ir/runstate.mjs";
import { BUILT_NOT_AUDITED } from "./ir/verdict.mjs";
import { judgeRun } from "./ir/judge.mjs";
import { makeDouble, loadVerdicts } from "./double/index.mjs";
import { loadPluginBundle, defaultHost } from "./ir/plugin-vm.mjs";
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

// One run, as tools/pix-run.mjs runs it, with the plugin played in the double. opts.plant(taskNo, env)
// runs after a build task and may change Figma; opts.refuse(task) makes the plugin throw on a task.
async function runOnce(label, opts) {
  const o = opts || {};
  const IR = o.ir || READ.ir;
  const { bytes, table } = await resolveImages(IR, PIX, { links: ["archive"], verdicts: VERDICTS });
  const plan = planM1(IR, STATS, Object.assign({ m1Scope: "default", images: table, runId: RUN }, o.maxChars ? { maxChars: o.maxChars } : {}));
  const D = makeDouble({ verdicts: VERDICTS });
  const host = defaultHost();
  host.phase = D.setPhase;
  const figImages = {}, figErrors = {};
  host.images = () => figImages;
  host.imageErrors = () => figErrors;
  const B = loadPluginBundle({ figma: D.figma, host });
  const env = { D, B, ctxs: new Map(), plan };
  // figma-plugin/src/code.js: images first (createImage per hash, a refusal remembered), then cmdIr:
  // the task text parsed, validated whole against the plugin's own tables, then the op.
  const post = async (task, p) => {
    for (const [hash, buf] of p.images) {
      try { figImages[hash] = D.figma.createImage(new Uint8Array(buf)).hash; delete figErrors[hash]; }
      catch (e) { figErrors[hash] = String((e && e.message) || e); }
    }
    const P = JSON.parse(JSON.stringify(task));
    if (o.refuse && o.refuse(P)) throw new Error("synthetic: the plugin refused task " + P.taskNo);
    const v = B.PXF_TASK.validateTask(P, { schema: B.PXF_SCHEMA, props: B.PXF_PROPS, maxChars: B.PXF_TASK.MAX_TASK_CHARS_CEILING, maxErrors: 20 });
    if (!v.ok) throw new Error("ir: the task is refused: " + v.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join("; "));
    const ctx = B.PXF_IR.makeCtx(D.figma, P, { id: label + "-" + P.taskNo });
    env.ctxs.set(P.taskNo, ctx);
    const rep = await B.PXF_IR.ops[P.op](ctx, P);
    if (P.op === "build" && o.plant) await o.plant(P.taskNo, env, P);
    return JSON.parse(JSON.stringify(rep));
  };
  const imagesFor = (task) => { const m = new Map(); for (const im of task.images) if (im.source !== "none" && bytes.has(im.hash)) m.set(im.hash, bytes.get(im.hash)); return m; };
  const settings = { source: "pix", scope: "file", m1Scope: "default", booleans: "auto", spaceEvenlySingle: "between", textFit: "widen", layoutOrder: "creation",
    textRead: "measure", images: "archive", noPixso: true, missingFonts: "ask", fallbackFont: { family: "Inter", style: "Regular" }, maxTaskMb: 4,
    livenessWarnS: 60, livenessFailS: 300, ceilingMsPerNode: 20 };
  const states = newStates({ snapshot: plan.tasks[0].snapshot, irVersion: IR.header.version, runId: RUN, settings, probes: probeStatus(VERDICTS),
    pixso: { used: false, identity: null, q5: false }, balance: plan.balance, ledger: plan.ledger });
  const reports = [];
  const r = await runTasks({ states, tasks: plan.tasks, post, imagesFor, clean: (t) => cleanTaskFor(t, IR), judge: judgeWith(IR, STATS),
    onReport: (t, rep) => reports.push({ taskNo: t.taskNo, op: t.op, rep }), log: () => {}, missingFonts: "ask" });
  // The run folder, as pix-run writes it.
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
  return Object.assign(env, { table, states, reports, r, totals, runDir, accepted: A, gates: A.gates });
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
