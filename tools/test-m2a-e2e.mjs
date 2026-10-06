// Part E's end-to-end test of M2a (docs/M2A.md §7): the synthetic fixture through the M2a reader, the
// M1 path and m2a-accept, under every reader setting.
//
//   node tools/test-m2a-e2e.mjs
//
// What it holds, on the synthetic fixture only (everything it writes goes to the system's temporary
// folder, outside the repository):
//   1. Every reader setting: the default settings and each non-default value of the thirteen M2a
//      settings once. Each read validates, records the value in its header, gives the same bytes twice,
//      and the renumbered fixture (every enum numbered differently) gives the same IR (G8's second half,
//      which a run folder cannot show). The M1 planner on it balances in all three M1 scopes, and its
//      tasks equal, task for task and byte for byte, those of the --variant-sets frames IR (D13): a
//      COMPONENT_SET goes in as its FRAME, tasks carry no instance data, no component property
//      bindings and none of M2a's notes about components (schema.mjs isComponentNote), and the
//      identity sample is the same.
//   2. The M1 path: the parse and the frames IR -> planM1 -> the bundled plugin on the headless double
//      (as test-m1-e2e plays it) -> judge -> m1-accept: every M1 gate passes and the verdict reads
//      BUILT, NOT VISUALLY AUDITED, as on M1.
//   3. m2a-accept on the fixture's run folder, for every setting: every gate of §8 passes, G4 gated
//      through an --expect file and G8 through --twice; and once through the CLIs, pix-run --dry
//      --no-pixso then m2a-accept, exit 0.
//   4. A planted fault per gate fails that gate and no other, G6's "unknown" from the fixture plant
//      M2A_PLANTS.unknownOverrideField read through the reader.
//   5. The validator lets a derived entry start at a layer with no record (a folded operand, kept
//      without `at`, D10) and still refuses an override that does.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (cond, m, why) => (cond ? ok(m) : fail(m + (why !== undefined ? " — " + String(why).slice(0, 600) : "")));
const show = (v) => JSON.stringify(v);
if (typeof zlib.zstdCompressSync !== "function") { console.log("FAIL the M2a e2e checks need Node 22.15 or newer (built-in zstd)"); process.exit(1); }

const { makeFixture, M2A_PLANTS } = await import("./pix/fixture.mjs");
const { readPix } = await import("./pix/read.mjs");
const { pixToIR } = await import("./pix/ir/index.mjs");
const schema = await import("./ir/schema.mjs");
const { CODE, M2A_SETTINGS, SETTINGS, SETTING_DEFAULTS, VERSION: IR_VERSION, isComponentNote } = schema;
const { validate, validateTask } = await import("./ir/validate.mjs");
const { planM1, cleanTaskFor } = await import("./ir/plan.mjs");
const { sampleGuids } = await import("./ir/identity.mjs");
const { resolveImages } = await import("./ir/images.mjs");
const { newStates, probeStatus, runTasks, saveStates } = await import("./ir/runstate.mjs");
const { BUILT_NOT_AUDITED } = await import("./ir/verdict.mjs");
const { makeDouble, loadVerdicts } = await import("./double/index.mjs");
const { loadPluginBundle, defaultHost } = await import("./ir/plugin-vm.mjs");
const { judgeWith } = await import("./pix-run.mjs");
const { accept } = await import("./m1-accept.mjs");
const { acceptRun, loadExpect, GATE_IDS } = await import("./m2a-accept.mjs");

const RUN = "0e2d3c4b5a697887";
const SCRATCH = mkdtempSync(join(tmpdir(), "pxf-m2ae2e-"));
const FX = makeFixture("valid");
const PIX_FILE = join(SCRATCH, "fixture.pix");
writeFileSync(PIX_FILE, FX.pix);
const SHA = createHash("sha256").update(FX.pix).digest("hex");
const RENUMBERED = makeFixture("renumbered").pix;
const read = (settings, pix) => pixToIR(pix || FX.pix, { settings: settings || {} });
const stripSha = (ir) => { const c = JSON.parse(JSON.stringify(ir)); delete c.header.source.sha256; return JSON.stringify(c); };
const SCOPES = ["default", "all-masters", "all"];
const plans = (r) => SCOPES.map((m1Scope) => planM1(r.ir, r.stats, { m1Scope, runId: RUN }));

// Every setting variant: the defaults, then each non-default value once.
const VARIANTS = [{ label: "defaults", settings: {} }];
for (const k of M2A_SETTINGS) for (const v of SETTINGS[k]) if (v !== SETTING_DEFAULTS[k]) VARIANTS.push({ label: "--" + k + " " + v, settings: { [k]: v }, key: k, value: v });

// ============================================================================================
// 1. every reader setting: valid, deterministic, renumbering-proof; the M1 tasks are frames'
// ============================================================================================
const BASE = read();
const FRAMES = read({ variantSets: "frames" });
const FRAME_PLANS = plans(FRAMES);
const FRAME_SAMPLE = sampleGuids(FRAMES.ir);
check(FRAME_PLANS.every((p) => p.balance.ok), "the --variant-sets frames IR (M1's D7) plans and balances in all three M1 scopes");
const READS = new Map();
for (const V of VARIANTS) {
  const r = read(V.settings);
  READS.set(V.label, r);
  const v = validate(r.ir);
  const recorded = V.key ? r.ir.header.settings[V.key] === V.value : M2A_SETTINGS.every((k) => r.ir.header.settings[k] === SETTING_DEFAULTS[k]);
  const twice = JSON.stringify(read(V.settings).ir) === JSON.stringify(r.ir);
  const renumbered = stripSha(read(V.settings, RENUMBERED).ir) === stripSha(r.ir);
  check(v.ok && r.ir.header.version === IR_VERSION && recorded && twice && renumbered,
    V.label + ": a valid IR version " + IR_VERSION + " recording the setting, the same bytes twice, the same IR from the renumbered fixture",
    show({ valid: v.ok, errors: v.errors.slice(0, 2), recorded, twice, renumbered }));
  const P = plans(r);
  const bad = [];
  P.forEach((p, k) => {
    if (!p.balance.ok) bad.push(SCOPES[k] + ": the balance does not add up");
    if (JSON.stringify(p.tasks) !== JSON.stringify(FRAME_PLANS[k].tasks)) bad.push(SCOPES[k] + ": the tasks differ from frames'");
    for (const t of p.tasks) {
      if (!validateTask(t).ok) bad.push(SCOPES[k] + ": task " + t.taskNo + " is refused");
      for (const n of t.nodes) {
        if (n.type === "COMPONENT_SET") bad.push("a task carries a COMPONENT_SET");
        if (n.instance !== undefined) bad.push("a task carries instance data");
        if (n.props.componentPropertyReferences !== undefined) bad.push("a task carries a property binding");
      }
      for (const nt of t.notes) if (isComponentNote(nt)) bad.push("a task carries a " + nt.code + " note");
    }
  });
  if (JSON.stringify(sampleGuids(r.ir)) !== JSON.stringify(FRAME_SAMPLE)) bad.push("the identity sample differs from frames'");
  check(!bad.length, V.label + ": the M1 plan balances in every scope and its tasks equal the frames IR's, byte for byte; the identity sample is the same", [...new Set(bad)].join("; "));
}
check(VARIANTS.length === 16, "the matrix reads the defaults and each of the 15 non-default values of the thirteen M2a settings", VARIANTS.length);
{
  // The parse IR does hold what M1's tasks leave out, so the equality above is not vacuous.
  const sets = BASE.ir.nodes.filter((n) => n.type === "COMPONENT_SET").length;
  const comp = BASE.ir.notes.filter((n) => isComponentNote(n)).length;
  const bound = BASE.ir.nodes.filter((n) => n.props.componentPropertyReferences !== undefined).length;
  const withOv = BASE.ir.nodes.filter((n) => n.type === "INSTANCE" && n.instance.overrides).length;
  check(sets > 0 && comp > 0 && bound > 0 && withOv > 0,
    "the default IR holds what M1's tasks leave out (" + sets + " sets, " + comp + " component notes, " + bound + " bound layers, " + withOv + " instances with overrides)");
}

// ============================================================================================
// 2. the M1 path on IR version 3: the bundled plugin on the double, judged, m1-accept
// ============================================================================================
const VERDICTS = loadVerdicts();
function makeFile() {
  const D = makeDouble({ verdicts: VERDICTS });
  const host = defaultHost();
  host.phase = D.setPhase;
  const figImages = {}, figErrors = {};
  host.images = () => figImages;
  host.imageErrors = () => figErrors;
  return { D, B: loadPluginBundle({ figma: D.figma, host }), figImages, figErrors };
}
async function m1Run(label, R) {
  const IR = R.ir, STATS = R.stats;
  const { bytes, table } = await resolveImages(IR, readPix(FX.pix), { links: ["archive"], verdicts: VERDICTS });
  const plan = planM1(IR, STATS, { m1Scope: "default", images: table, runId: RUN });
  const F = makeFile();
  const post = async (task, p) => {
    const P = JSON.parse(JSON.stringify(task));
    for (const [hash, buf] of p.images) {
      try { F.figImages[hash] = F.D.figma.createImage(new Uint8Array(buf)).hash; delete F.figErrors[hash]; }
      catch (e) { F.figErrors[hash] = String((e && e.message) || e); }
    }
    const v = F.B.PXF_TASK.validateTask(P, { schema: F.B.PXF_SCHEMA, props: F.B.PXF_PROPS, maxChars: F.B.PXF_TASK.MAX_TASK_CHARS_CEILING, maxErrors: 20 });
    if (!v.ok) throw new Error("ir: the task is refused: " + v.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join("; "));
    const ctx = F.B.PXF_IR.makeCtx(F.D.figma, P, { id: label + "-" + P.taskNo });
    return JSON.parse(JSON.stringify(await F.B.PXF_IR.ops[P.op](ctx, P)));
  };
  const imagesFor = (task) => { const m = new Map(); for (const im of task.images) if (im.source !== "none" && bytes.has(im.hash)) m.set(im.hash, bytes.get(im.hash)); return m; };
  const settings = { source: "pix", scope: "file", m1Scope: "default", booleans: "auto", spaceEvenlySingle: "between", textFit: "widen", layoutOrder: "creation",
    textRead: "measure", images: "archive", noPixso: true, missingFonts: "ask", fallbackFont: { family: "Inter", style: "Regular" }, maxTaskMb: 4,
    livenessWarnS: 60, livenessFailS: 300, ceilingMsPerNode: 20 };
  const states = newStates({ snapshot: plan.tasks[0].snapshot, irVersion: IR.header.version, runId: RUN, settings, probes: probeStatus(VERDICTS),
    pixso: { used: false, identity: null, q5: false }, balance: plan.balance, ledger: plan.ledger });
  const r = await runTasks({ states, tasks: plan.tasks, post, imagesFor, clean: (t) => cleanTaskFor(t, IR), judge: judgeWith(IR, STATS), log: () => {}, missingFonts: "ask" });
  const runDir = join(SCRATCH, "m1-" + label);
  mkdirSync(join(runDir, "judge"), { recursive: true });
  const out = (f, v) => writeFileSync(join(runDir, f), JSON.stringify(v), "utf8");
  out("ir.json", IR); out("stats.json", STATS); out("images.json", table);
  out("plan.json", { balance: plan.balance, preflight: plan.preflight, ledger: plan.ledger,
    outOfScope: Object.keys(plan.scope.outOfScope).reduce((m, k) => { m[k] = plan.scope.outOfScope[k].length; return m; }, {}),
    records: plan.tasks.filter((t) => t.op === "build").reduce((m, t) => { m[t.taskNo] = t.nodes.map((n) => n.i); return m; }, {}) });
  saveStates(join(runDir, "states.json"), states);
  for (const j of r.Js) out(join("judge", j.taskNo + ".json"), j.J);
  return { states, r, A: accept(runDir, {}) };
}
for (const [label, R] of [["parse", BASE], ["frames", FRAMES]]) {
  const run = await m1Run(label, R);
  const S = run.states, G = run.A.gates;
  check(S.tasks.every((t) => t.state === "built" || t.state === "built-with-fallbacks") && run.r.stopped === null,
    "--variant-sets " + label + ": the bundled plugin builds every task on the double (" + S.tasks.length + " tasks)",
    show(S.tasks.map((t) => t.taskNo + ":" + t.state + (t.error ? " " + t.error.split("\n")[0] : ""))));
  check(G.gates.every((g) => !g.fail) && G.verdict.indexOf(BUILT_NOT_AUDITED) === 0 && S.balance.ok,
    "--variant-sets " + label + ": every M1 gate passes, the balance adds up, and the verdict reads BUILT, NOT VISUALLY AUDITED, as on M1",
    show({ failing: G.gates.filter((g) => g.fail), verdict: G.verdict }));
}

// ============================================================================================
// 3. m2a-accept on the fixture's run folder, every setting; then through the CLIs
// ============================================================================================
// The --expect file G4 needs (outside the repository, keyed by the fixture's sha256): the fixture's
// two stale assignments on instances, one no-definition and one other-family (docs/M2A.md §5.4).
const EXPECT_FILE = join(SCRATCH, "expect.json");
const STALE = BASE.stats.m2a.properties.assignments.stale;
writeFileSync(EXPECT_FILE, JSON.stringify({ format: "pix2fig.m2a-expect", version: 1,
  files: { [SHA]: { label: "fixture", numbers: { "G4.noDefinition": 1, "G4.otherFamily": 1, "G6.unknown": 0, "G1.unresolved": 0 } } } }));
check(STALE["no-definition"] === 1 && STALE["other-family"] === 1, "the fixture's stale assignments on instances are 1 no-definition and 1 other-family", show(STALE));
const EXPECT = loadExpect(EXPECT_FILE);
let folderNo = 0;
function runFolder(R, mutate) {
  const dir = join(SCRATCH, "accept", String(++folderNo));
  mkdirSync(dir, { recursive: true });
  const m = { ir: JSON.parse(JSON.stringify(R.ir)), stats: JSON.parse(JSON.stringify(R.stats)), balanceStats: R.stats, pix: PIX_FILE };
  if (mutate) mutate(m);
  writeFileSync(join(dir, "ir.json"), JSON.stringify(m.ir));
  writeFileSync(join(dir, "stats.json"), JSON.stringify(m.stats));
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ balance: planM1(R.ir, m.balanceStats, { runId: RUN }).balance }));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ pix: m.pix }));
  return dir;
}
// Switching rule B or rule C off is what reproduces the planning-era resolver (docs/M2A.md §3): the
// fixture's rule B and rule C cases then leave one derived entry each unresolved, and G1 says so.
const RULE_OFF = { "--swapReset off": 1, "--swapFallback off": 1 };
for (const V of VARIANTS) {
  const A = await acceptRun(runFolder(READS.get(V.label)), { expect: EXPECT, twice: true });
  const notPass = A.gates.filter((g) => g.status !== "PASS").map((g) => g.id + " " + g.status + (g.why.length ? " (" + g.why[0] + ")" : ""));
  if (RULE_OFF[V.label]) {
    const D = READS.get(V.label).stats.m2a.derived;
    check(notPass.length === 1 && /^G1 FAIL/.test(notPass[0]) && D.unresolved === RULE_OFF[V.label],
      V.label + ": m2a-accept fails G1 alone, on the " + RULE_OFF[V.label] + " derived entry the rule resolves, and passes every other gate", notPass.join("; "));
  } else check(!notPass.length && A.gates.length === GATE_IDS.length, V.label + ": m2a-accept passes every gate on the fixture's run folder, G4 with --expect and G8 with --twice", notPass.join("; "));
}
{
  const node = (args) => {
    try { return { code: 0, out: execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
  };
  const r = node([join(HERE, "pix-run.mjs"), PIX_FILE, "--dry", "--no-pixso", "--data", join(SCRATCH, "data")]);
  const m = /run folder: (.+)/.exec(r.out);
  const dir = m ? m[1].trim() : null;
  const a = dir ? node([join(HERE, "m2a-accept.mjs"), dir, "--expect", EXPECT_FILE, "--twice"]) : { code: -1, out: "no run folder" };
  const gateLines = a.out.split("\n").filter((l) => /^G\d+ /.test(l));
  check(r.code === 0 && /BALANCE \(adds up\)/.test(r.out) && /\nM2a \(no gate fails\)/.test(r.out) && a.code === 0 && /VERDICT: PASS/.test(a.out) &&
    gateLines.length === GATE_IDS.length && gateLines.every((l) => / PASS  \[/.test(l)),
    "through the CLIs: pix-run --dry --no-pixso prints the M1 balance and the M2a block, and m2a-accept --expect --twice on its run folder exits 0 with every gate PASS",
    r.code !== 0 ? r.out.slice(-400) : a.out.slice(0, 600));
}

// ============================================================================================
// 4. a planted fault per gate fails that gate and no other
// ============================================================================================
const PLANTED = makeFixture("valid", { mutate: M2A_PLANTS.unknownOverrideField });
const PLANT_FILE = join(SCRATCH, "planted.pix");
writeFileSync(PLANT_FILE, PLANTED.pix);
const PLANT_SHA = createHash("sha256").update(PLANTED.pix).digest("hex");
const PLANTS = [
  ["G1", "a derived entry that does not resolve", (m) => { m.stats.m2a.derived.resolved--; m.stats.m2a.derived.unresolved++; }],
  ["G2", "a stale entry whose path resolves", (m) => { m.stats.m2a.overrides.resolvedNotDerived = 1; }],
  ["G3", "members of rejected sets counted other than the IR's standalone members", (m) => { m.stats.m2a.families.rejectedMembers++; }],
  ["G4", "a stale count other than the --expect file's", (m) => { m.stats.m2a.properties.assignments.stale["no-definition"]++; m.stats.m2a.properties.assignments.total++; }],
  ["G5", "a declared id that is not a root", (m) => { m.stats.m2a.properties.declaredNotRoot = 1; }],
  ["G6", "an override field outside OVERRIDE_SOURCE_FIELDS (M2A_PLANTS.unknownOverrideField, read)", null],
  ["G7", "an assignment in no class of D6", (m) => { m.stats.m2a.properties.assignments.total++; }],
  ["G8", "ir.json differs from a second read of the .pix", (m) => { m.ir.pages[0].name += " (changed)"; }],
  ["G9", "the M1 balance does not add up", (m) => { m.balanceStats = JSON.parse(JSON.stringify(m.stats)); m.balanceStats.stored++; }],
  ["G10", "an IR the validator refuses (an override `at` naming another record)", (m) => {
    const o = m.ir.nodes.flatMap((n) => (n.type === "INSTANCE" && n.instance.overrides ? n.instance.overrides : [])).find((x) => Array.isArray(x.at));
    o.at[o.at.length - 1] = 0; }],
];
for (const [gate, what, mutate] of PLANTS) {
  const dir = mutate ? runFolder(BASE, mutate) : runFolder(pixToIR(PLANTED.pix, { settings: {} }), (m) => { m.pix = PLANT_FILE; });
  // The planted fixture is another file: G4 is gated for it through the same numbers under its own sha256.
  // G10's plant edits ir.json, which a second read would also tell apart (G8), so G8 is not asked there.
  const twice = gate !== "G10";
  const A = await acceptRun(dir, { expect: mutate ? EXPECT : { [PLANT_SHA]: EXPECT[SHA] }, twice });
  const failing = A.gates.filter((g) => g.status === "FAIL").map((g) => g.id);
  const why = (A.gates.find((g) => g.id === gate) || { why: [] }).why.join("; ");
  check(failing.join() === gate && (gate !== "G6" || /unknown/.test(why)), gate + " fails on its own on the fixture's run folder: " + what, show(failing) + " " + why.slice(0, 300));
}

// ============================================================================================
// 5. the validator: a derived entry may start at a layer with no record, an override may not
// ============================================================================================
{
  const I = BASE.ir;
  let hit = null;
  I.nodes.forEach((r, i) => {
    if (hit || r.type !== "INSTANCE" || !r.instance.derived || !r.instance.master || !r.instance.master.guid) return;
    const d = r.instance.derived.find((e) => e.at === undefined && !I.nodes.some((n) => n.guid === e.path[0]));
    if (d) hit = { i, d };
  });
  check(!!hit && validate(I).ok, "a derived entry whose first element is a folded operand is carried without `at` and the IR validates (D10)", show(hit && hit.d.path));
  if (hit) {
    const bad = JSON.parse(JSON.stringify(I));
    const inst = bad.nodes[hit.i].instance;
    (inst.overrides = inst.overrides || []).push({ path: hit.d.path.slice(), fields: { opacity: 0.5 } });
    inst.overrideBasis = inst.overrideBasis || "authored";
    const v = validate(bad);
    check(!v.ok && v.errors.some((e) => /overrides\[\d+\]\.path\[0\]/.test(e.path)), "an override whose first element has no record is still refused", show(v.errors.slice(0, 2)));
  }
}

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) { /* the scratch stays */ }
console.log(failed ? "\n" + failed + " M2a e2e check" + (failed === 1 ? "" : "s") + " FAILED" : "\nall M2a e2e checks pass (" + VARIANTS.length + " setting variants)");
process.exit(failed ? 1 : 0);
