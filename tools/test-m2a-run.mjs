// Part D's tests: the run, the stats and the acceptance gates (docs/M2A.md §6 D, §8).
//
//   node tools/test-m2a-run.mjs
//
// Offline and synthetic: the reader's fixture (tools/pix/fixture.mjs) through pix-to-ir and pix-run,
// and docs/IR.md's complete example (a valid IR version 3 with a set, bindings, an assignment, a root
// and a non-root override and a derived entry) with stats.m2a counters made consistent with it, into
// which each test plants one fault. It checks:
//   - pix-to-ir and pix-run take the thirteen flags of docs/M2A.md §3, default to SETTING_DEFAULTS,
//     refuse other values, and the values round-trip into the IR header (and --from-ir adopts them);
//   - the run folder's settings hash includes the M2a settings (a version 3 run never shares a folder
//     with a version 2 one); pix-run refuses a folder whose states.json irVersion is not 3, naming the
//     M1 commit that can resume it, and writes nothing into it;
//   - the M1 balance and the task count on the fixture are those of its --variant-sets frames IR (M1's
//     D7), tasks carry no instance data, and pix-run --dry prints the M1 balance and the M2a block;
//   - m2a-accept prints every gate G1-G10 with its source; on the consistent example every gate passes;
//     each planted fault fails its gate and no other (an IR fault may also fail G10, validity); a missing
//     counter fails the gate that reads it, never read as 0; --expect gates G4 (and any number it
//     names), refuses a file inside the repository and an unknown metric; --twice catches an IR that
//     differs from a second read; exit 0 / 3 / 1; nothing printed names a layer or a guid.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import { M2A_SETTINGS, SETTINGS, SETTING_DEFAULTS, SETTING_FLAGS, NOTE_CLASSES, VERSION } from "./ir/schema.mjs";
import { planM1 } from "./ir/plan.mjs";
import { REPO_ROOT } from "./ir/outside-repo.mjs";
import { makeFixture } from "./pix/fixture.mjs";
import { pixToIR, newM2aStats } from "./pix/ir/index.mjs";
import { adoptIrSettings, parseArgs as runArgs, refuseOtherVersion, runDirName, runSettings, SETTINGS as RUN_SETTINGS } from "./pix-run.mjs";
import { parseArgs as irArgs, FLAGS as IR_FLAGS } from "./pix-to-ir.mjs";
import { GATE_IDS, METRICS, M1_COMMIT, loadExpect, m2aGates, irCounts } from "./m2a-accept.mjs";
import * as overrides from "./pix/ir/overrides.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
const check = (cond, m, why) => {
  if (cond) { passed++; console.log("ok   " + m); }
  else { failed++; console.log("FAIL " + m + (why !== undefined ? " — " + String(why).slice(0, 500) : "")); }
};
const threw = (fn) => { try { fn(); return ""; } catch (e) { return e.message || String(e); } };
const clone = (x) => JSON.parse(JSON.stringify(x));
const node = (args) => {
  try { return { code: 0, out: execFileSync(process.execPath, args, { encoding: "utf8", stdio: "pipe" }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
};
if (typeof zlib.zstdCompressSync !== "function") { console.log("FAIL the M2a run checks need Node 22.15 or newer (built-in zstd)"); process.exit(1); }
const TMP = mkdtempSync(join(tmpdir(), "pxf-m2arun-"));
const FX = makeFixture();
const PIX = join(TMP, "fixture.pix");
writeFileSync(PIX, FX.pix);
// The first value of each M2a setting that is not its default.
const NONDEFAULT = Object.fromEntries(M2A_SETTINGS.map((k) => [k, SETTINGS[k].find((v) => v !== SETTING_DEFAULTS[k])]));
const flagsOf = (o) => M2A_SETTINGS.flatMap((k) => [SETTING_FLAGS[k], o[k]]);
// While part C's instance pass is P0's stub, stats.m2a counts no instance, and G6 rightly fails on any
// file with instances (its counters cover none of the IR's INSTANCE records): the fixture's checks
// below then expect exactly that failure ("pending: C"), and every gate passing once C has landed.
const C_PENDING = overrides.STUB !== undefined;
const FIXTURE_VERDICT = C_PENDING ? "FAIL (G6)" : "PASS";
if (C_PENDING) console.log("pending: C (the fixture's run folder fails G6 until part C counts the instances it carries)");
const runFolder = (out) => { const m = /run folder: (.+)/.exec(out || ""); return m ? m[1].trim() : null; };

// ---------- 1. the thirteen flags ----------
function flagGroup() {
  const d = runArgs(["x.pix"]);
  const bad = M2A_SETTINGS.filter((k) => d[k] !== SETTING_DEFAULTS[k]);
  check(!bad.length, "pix-run defaults every M2a setting to SETTING_DEFAULTS", bad.join(", "));
  const takes = M2A_SETTINGS.every((k) => SETTINGS[k].every((v) => runArgs(["x.pix", SETTING_FLAGS[k], v])[k] === v));
  check(takes && Object.keys(RUN_SETTINGS).length === 19 + 13, "pix-run takes every value of every M2a flag (32 settings in all)");
  const refused = M2A_SETTINGS.filter((k) => !/one of/.test(threw(() => runArgs(["x.pix", SETTING_FLAGS[k], "maybe"]))));
  check(!refused.length, "pix-run refuses a value outside each M2a setting's list, naming the choices", refused.join(", "));
  const irTakes = M2A_SETTINGS.every((k) => IR_FLAGS[SETTING_FLAGS[k]] === k && SETTINGS[k].every((v) => irArgs(["x.pix", "--stats-only", SETTING_FLAGS[k], v]).settings[k] === v));
  const irRefused = M2A_SETTINGS.filter((k) => !/one of/.test(threw(() => irArgs(["x.pix", "--stats-only", SETTING_FLAGS[k], "maybe"]))));
  check(irTakes && !irRefused.length, "pix-to-ir takes every value of every M2a flag and refuses any other", irRefused.join(", "));

  // Round trip through the CLIs: every setting at a non-default value lands in the IR header.
  const out = join(TMP, "flags", "ir.json");
  const r = node([join(HERE, "pix-to-ir.mjs"), PIX, "--out", out].concat(flagsOf(NONDEFAULT)));
  const h = r.code === 0 && existsSync(out) ? JSON.parse(readFileSync(out, "utf8")).header.settings : {};
  const lost = M2A_SETTINGS.filter((k) => h[k] !== NONDEFAULT[k]);
  check(r.code === 0 && !lost.length, "pix-to-ir writes each M2a flag's value into the IR header", r.code !== 0 ? r.out.slice(0, 400) : lost.join(", "));
  check(r.code === 0 && /"m2a":/.test(r.out) && /"families":/.test(r.out), "pix-to-ir prints the stats.m2a counters with its summary");
  const bad2 = node([join(HERE, "pix-to-ir.mjs"), PIX, "--stats-only", "--echo", "sometimes"]);
  check(bad2.code === 2 && /--echo is one of drop, keep/.test(bad2.out), "pix-to-ir exits 2 on a value outside a setting's list", bad2.out.slice(0, 300));
  const data = join(TMP, "data-flags");
  const p = node([join(HERE, "pix-run.mjs"), PIX, "--dry", "--no-pixso", "--data", data].concat(flagsOf(NONDEFAULT)));
  const runDir = runFolder(p.out);
  const ph = runDir && existsSync(join(runDir, "ir.json")) ? JSON.parse(readFileSync(join(runDir, "ir.json"), "utf8")).header.settings : {};
  const lost2 = M2A_SETTINGS.filter((k) => ph[k] !== NONDEFAULT[k]);
  check(p.code === 0 && !lost2.length, "pix-run passes each M2a flag to the reader: the run folder's IR header records it", p.code !== 0 ? p.out.slice(-400) : lost2.join(", "));
  const printed = M2A_SETTINGS.filter((k) => p.out.indexOf('"' + k + '":"' + NONDEFAULT[k] + '"') < 0);
  check(!printed.length, "pix-run's preflight prints the M2a settings it ran with", printed.join(", "));

  // --from-ir keeps the M2a settings the IR was read with, and refuses a flag that contradicts one.
  const header = { settings: Object.assign({ textFit: "widen", booleans: "auto", spaceEvenlySingle: "center" }, NONDEFAULT), scope: { kind: "file" } };
  const a = runArgs(["--from-ir", "x.json"]);
  const why = adoptIrSettings(a, header);
  const k0 = M2A_SETTINGS[4];
  const b = runArgs(["--from-ir", "x.json", SETTING_FLAGS[k0], SETTING_DEFAULTS[k0]]);
  const c = runArgs(["--from-ir", "x.json", SETTING_FLAGS[k0], NONDEFAULT[k0]]);
  check(why === null && M2A_SETTINGS.every((k) => a[k] === NONDEFAULT[k]) &&
    new RegExp(SETTING_FLAGS[k0] + " " + SETTING_DEFAULTS[k0] + " contradicts the IR, which was read with " + NONDEFAULT[k0]).test(adoptIrSettings(b, header) || "") &&
    adoptIrSettings(c, header) === null,
    "--from-ir adopts the M2a settings of the IR header and refuses a flag that contradicts one");
}

// ---------- 2. the run folder ----------
function folderGroup() {
  const o = runArgs(["x.pix"]);
  const s = runSettings(o);
  const missing = M2A_SETTINGS.filter((k) => s[k] !== SETTING_DEFAULTS[k]);
  check(!missing.length, "runSettings records every M2a setting", missing.join(", "));
  const v2 = Object.assign({}, s); for (const k of M2A_SETTINGS) delete v2[k];
  const sha = "ab".repeat(32);
  check(runDirName(sha, s) !== runDirName(sha, v2), "a version 3 run's folder name differs from the one M1 gave the same file and settings (its hash omitted the M2a settings)");
  const changed = M2A_SETTINGS.filter((k) => runDirName(sha, Object.assign({}, s, { [k]: NONDEFAULT[k] })) === runDirName(sha, s));
  check(!changed.length, "every M2a setting changes the run folder's name", changed.join(", "));
  const msg = refuseOtherVersion({ irVersion: 2 }) || "";
  check(msg.indexOf(M1_COMMIT) >= 0 && /version 2/.test(msg) && refuseOtherVersion({ irVersion: VERSION }) === null && refuseOtherVersion(null) === null,
    "refuseOtherVersion refuses another IR version and names the M1 commit that can resume it", msg);

  // A folder pix-run would use, holding a version 2 run: refused, and left as it was.
  const data = join(TMP, "data-v2");
  const fileSha = createHash("sha256").update(FX.pix).digest("hex");
  const dir = join(data, "runs", runDirName(fileSha, runSettings(runArgs([PIX, "--dry", "--no-pixso"]))));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "states.json"), JSON.stringify({ version: 2, irVersion: 2, tasks: [] }));
  const r = node([join(HERE, "pix-run.mjs"), PIX, "--dry", "--no-pixso", "--data", data]);
  check(r.code === 1 && r.out.indexOf(M1_COMMIT) >= 0 && /IR version 2/.test(r.out) && !existsSync(join(dir, "ir.json")),
    "pix-run refuses a run folder of IR version 2, names " + M1_COMMIT + ", and writes nothing into it", r.out.slice(-400));
  writeFileSync(join(dir, "states.json"), JSON.stringify({ version: 2, irVersion: VERSION, tasks: [] }));
  const r3 = node([join(HERE, "pix-run.mjs"), PIX, "--dry", "--no-pixso", "--data", data]);
  check(r3.code === 0 && existsSync(join(dir, "ir.json")) && existsSync(join(dir, "run.json")), "the same folder holding a version 3 run is used", r3.out.slice(-300));
  const rj = existsSync(join(dir, "run.json")) ? JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) : {};
  check(rj.irVersion === VERSION && rj.sha256 === fileSha && rj.pix === PIX, "run.json records the .pix the run read and its IR version (for m2a-accept --twice)", JSON.stringify(rj));
}

// ---------- 3. M1 unchanged on the fixture ----------
let FIXTURE_RUN = null;
function m1Group() {
  const v3 = pixToIR(FX.pix, {}), frames = pixToIR(FX.pix, { settings: { variantSets: "frames" } });
  const p3 = planM1(v3.ir, v3.stats, { runId: "00000000000000d2" }), pf = planM1(frames.ir, frames.stats, { runId: "00000000000000d2" });
  check(p3.balance.ok && pf.balance.ok, "the M1 balance adds up on the fixture's IR version 3, under --variant-sets parse and frames");
  check(p3.tasks.length === pf.tasks.length && JSON.stringify(p3.balance.nonInstance) === JSON.stringify(pf.balance.nonInstance) &&
    JSON.stringify(p3.balance.instances) === JSON.stringify(pf.balance.instances),
    "the task count and the balance are those of the --variant-sets frames IR (M1's D7)", p3.tasks.length + " vs " + pf.tasks.length);
  check(p3.tasks.every((t) => (t.nodes || []).every((n) => n.instance === undefined)), "tasks carry no instance data (docs/M2A.md §5.2)");
  check(p3.tasks.every((t) => (t.nodes || []).every((n) => n.type !== "COMPONENT_SET")), "no task writes a COMPONENT_SET type (it goes in as its FRAME, D13)");
  const data = join(TMP, "data-fixture");
  const r = node([join(HERE, "pix-run.mjs"), PIX, "--dry", "--no-pixso", "--data", data]);
  const lines = GATE_IDS.filter((g) => !new RegExp("\\n  " + g + " ").test(r.out));
  check(r.code === 0 && /BALANCE \(adds up\)/.test(r.out) && (C_PENDING ? /\nM2a \(FAIL: G6\)/ : /\nM2a \(no gate fails\)/).test(r.out) && !lines.length && /full acceptance: node tools\/m2a-accept\.mjs/.test(r.out),
    "pix-run --dry --no-pixso prints the M1 balance, adding up, and the M2a block with every gate", r.code !== 0 ? r.out.slice(-500) : lines.join(", "));
  const tasksLine = /tasks: (\d+) \(/.exec(r.out);
  check(tasksLine && Number(tasksLine[1]) === p3.tasks.length, "pix-run plans the same number of tasks", tasksLine && tasksLine[1]);
  FIXTURE_RUN = runFolder(r.out);
}

// ---------- 4. m2a-accept ----------
// docs/IR.md's complete example and stats.m2a counters consistent with it: 1 set of 1 state group,
// 3 declared roots, 3 bindings kept (+ 2 dropped fill-style), 1 assignment kept (+ 1 dangling + 1 stale),
// 1 root and 1 non-root override written, 1 derived entry written (+ 1 empty).
function example() {
  const md = readFileSync(join(REPO_ROOT, "docs", "IR.md"), "utf8").replace(/\r\n/g, "\n");
  const at = md.indexOf("<!-- ir-example: valid -->");
  const m = /```json\n([\s\S]*?)\n```/.exec(md.slice(at));
  return JSON.parse(m[1]);
}
function richStats() {
  const M = newM2aStats();
  Object.assign(M.families, { groups: 1, accepted: 1 });
  Object.assign(M.properties, { roots: 3, declaredNotRoot: 0 });
  Object.assign(M.properties.bindings, { total: 5, kept: 3 }); M.properties.bindings.dropped["fill-style"] = 2;
  Object.assign(M.properties.assignments, { total: 3, kept: 1, dangling: 1 }); M.properties.assignments.stale["other-family"] = 1;
  M.properties.swapDangling.assignment = 1;
  Object.assign(M.instances, { instances: 1 });
  Object.assign(M.overrides, { entries: 4, root: 1, emptyPath: 0, nonRoot: 3, live: 2, distinctLivePaths: 1, mergedAway: 1, written: 1, emptyAfterTranslation: 0 });
  M.overrides.stale["not-derived"] = 1;
  M.overrides.merged = { paths: 1, conflicts: 1 };
  Object.assign(M.overrides.pixsoFields, { total: 5, translated: 2, consumed: 2 }); M.overrides.pixsoFields.dropped["no-equivalent"] = { pluginData: 1 };
  Object.assign(M.overrides.fields, { produced: 3, carried: 2, echo: { fills: 1 } });
  Object.assign(M.derived, { entries: 2, resolved: 2, written: 1, empty: 1 });
  return { stored: 12, ms: { unzip: 1, zstd: 1, kiwi: 1, ir: 5, m2a: { families: 0, props: 0, resolve: 0, instances: 0 } }, m2a: M };
}
const BAL = { ok: true, stored: { stored: 12 }, nonInstance: { ir: 11 }, instances: { ir: 1 } };
const failing = (gates) => gates.filter((g) => g.status === "FAIL").map((g) => g.id).join(",");
const statusOf = (gates, id) => gates.find((g) => g.id === id).status;

async function acceptGroup() {
  const IR = example();
  const ic = irCounts(IR);
  check(ic.sets === 1 && ic.componentSets === 1 && ic.bindings === 3 && ic.declared === 3 && ic.assignments === 1 && ic.overridesNonRoot === 1 && ic.overridesRoot === 1 && ic.derived === 1,
    "irCounts reads the example: 1 set, 3 bindings, 3 roots, 1 assignment, 1 + 1 overrides, 1 derived entry", JSON.stringify(ic));
  const base = m2aGates(IR, richStats(), { balance: BAL });
  check(base.map((g) => g.id).join() === GATE_IDS.join() && base.every((g) => g.source && /stats|IR/.test(g.source)), "every gate G1-G10 is evaluated and names its source");
  check(failing(base) === "" && statusOf(base, "G4") === "n/a" && statusOf(base, "G8") === "n/a",
    "on the consistent example every gate passes (G4 n/a without --expect, G8 without --twice)", base.filter((g) => g.status === "FAIL").map((g) => g.id + ": " + g.why.join("; ")).join(" | "));

  // One planted fault per case: [gate, what, change(stats, ir), may also fail G10, M1 balance]
  const plants = [
    ["G1", "a derived entry that does not resolve", (s) => { s.m2a.derived.resolved = 1; s.m2a.derived.unresolved = 1; }],
    ["G1", "entries ≠ written + empty", (s) => { s.m2a.derived.empty = 0; }],
    ["G1", "written ≠ the IR's derived entries", (s) => { s.m2a.derived.written = 2; s.m2a.derived.empty = 0; }],
    ["G1", "more via rule C than resolved", (s) => { s.m2a.derived.viaFallback = 3; }],
    ["G2", "a stale entry that resolves", (s) => { s.m2a.overrides.resolvedNotDerived = 1; }],
    ["G2", "an entry in derived that does not resolve", (s) => { s.m2a.overrides.inDerivedUnresolved = 1; }],
    ["G3", "accepted + rejected ≠ state groups", (s) => { s.m2a.families.groups = 2; }],
    ["G3", "rejected by class differ from the IR's notes", (s) => { s.m2a.families.groups = 2; s.m2a.families.rejected["duplicate-axis"] = 1; }],
    ["G3", "accepted ≠ the IR's sets", (s) => { s.m2a.families.groups = 2; s.m2a.families.accepted = 2; }],
    ["G3", "members of rejected sets differ from the IR's", (s) => { s.m2a.families.rejectedMembers = 2; }],
    ["G3", "--variant-sets frames with a set in the IR", (s, ir) => { ir.header.settings.variantSets = "frames"; }],
    ["G5", "a declared id that is not a root", (s) => { s.m2a.properties.declaredNotRoot = 1; }],
    ["G5", "a kept binding of another type than its root", (s, ir) => { const r = ir.nodes.find((n) => n.name === "Dot"); r.props.componentPropertyReferences = { characters: "Dot#0:2" }; }, true],
    ["G6", "entries ≠ root + empty path + non-root", (s) => { s.m2a.overrides.entries = 5; }],
    ["G6", "non-root ≠ live + stale", (s) => { s.m2a.overrides.stale["not-derived"] = 2; }],
    ["G6", "live ≠ distinct paths + merged away", (s) => { s.m2a.overrides.mergedAway = 0; s.m2a.overrides.stale["not-derived"] = 2; }],
    ["G6", "distinct paths ≠ written + empty", (s) => { s.m2a.overrides.emptyAfterTranslation = 1; }],
    ["G6", "written ≠ the IR's non-root overrides", (s) => { s.m2a.overrides.written = 0; s.m2a.overrides.emptyAfterTranslation = 1; }],
    ["G6", "Pixso fields ≠ translated + consumed + dropped", (s) => { s.m2a.overrides.pixsoFields.total = 6; }],
    ["G6", "an unknown Pixso field (M2A_PLANTS.unknownOverrideField's class)", (s) => { s.m2a.overrides.pixsoFields.total = 6; s.m2a.overrides.pixsoFields.dropped.unknown = { scrollDirection: 1 }; }],
    ["G6", "Figma fields ≠ carried + echo", (s) => { s.m2a.overrides.fields.produced = 2; }],
    ["G6", "--echo keep with echoes outside the carried fields", (s, ir) => { ir.header.settings.echo = "keep"; }],
    ["G6", "counters for fewer instances than the IR carries", (s) => { s.m2a.instances.instances = 0; }],
    ["G7", "assignments ≠ the sum of D6's classes", (s) => { s.m2a.properties.assignments.total = 4; }],
    ["G7", "dangling ≠ SWAP_VALUE_DANGLING assignment", (s) => { s.m2a.properties.swapDangling.assignment = 2; }],
    ["G7", "an assignment dropped as the default under --default-assignments keep", (s) => { s.m2a.properties.assignments.defaultDropped = 1; s.m2a.properties.assignments.total = 4; }],
    ["G7", "kept ≠ the IR's assignments", (s) => { s.m2a.properties.assignments.kept = 2; s.m2a.properties.assignments.dangling = 0; s.m2a.properties.swapDangling.assignment = 0; }],
    ["G7", "bindings ≠ kept + dropped", (s) => { s.m2a.properties.bindings.total = 6; }],
    ["G7", "kept bindings ≠ the IR's", (s) => { s.m2a.properties.bindings.kept = 4; s.m2a.properties.bindings.dropped["fill-style"] = 1; }],
    ["G9", "the M1 balance does not add up", null, false, { ok: false, stored: { stored: 12, why: "planted" }, nonInstance: { ir: 11 }, instances: { ir: 1 } }],
    ["G10", "an IR the validator refuses", (s, ir) => { ir.images[0].format = "bmp"; }],
  ];
  for (const [id, what, change, alsoG10, balance] of plants) {
    const s = richStats(), ir = clone(IR);
    if (change) change(s, ir);
    const gates = m2aGates(ir, s, { balance: balance || BAL });
    const f = failing(gates);
    check(f === id || (alsoG10 && f === id + ",G10"), id + " fails on its own: " + what, "failing: " + (f || "none") + " | " + gates.filter((g) => g.status === "FAIL").map((g) => g.why.join("; ")).join(" | "));
  }
  {
    // A missing counter fails the gate that reads it and is never read as 0.
    const s = richStats(); delete s.m2a.overrides.mergedAway; delete s.m2a.derived.empty;
    const f = failing(m2aGates(IR, s, { balance: BAL }));
    check(f === "G1,G6", "a missing counter fails the gate that reads it (never read as 0)", f);
    const v2 = m2aGates(IR, { stored: 12 }, { balance: BAL });
    check(failing(v2) === "G1,G2,G3,G4,G5,G6,G7" && /no m2a block/.test(v2[0].why.join()), "stats without an m2a block (a version 2 reader's) fail every stats gate", failing(v2));
  }
  {
    // --expect: gates G4, and any number it names.
    const want = { label: "X", numbers: { "G4.noDefinition": 0, "G4.otherFamily": 1, "G1.entries": 2, "G3.accepted": 1 } };
    const g = m2aGates(IR, richStats(), { balance: BAL, expect: want });
    check(failing(g) === "" && statusOf(g, "G4") === "PASS", "--expect: matching numbers make G4 PASS");
    const g2 = m2aGates(IR, richStats(), { balance: BAL, expect: { label: "X", numbers: { "G4.noDefinition": 0, "G4.otherFamily": 2 } } });
    check(failing(g2) === "G4" && /G4.otherFamily 2, got 1/.test(g2[3].why.join()), "--expect: a stale count other than expected fails G4 alone", failing(g2));
    const g3 = m2aGates(IR, richStats(), { balance: BAL, expect: { label: "X", numbers: { "G1.entries": 3 } } });
    check(failing(g3) === "G1" && statusOf(g3, "G4") === "n/a", "--expect: any gate metric it names is compared (G1.entries)", failing(g3));
    check(Object.keys(METRICS).join() === GATE_IDS.join() && GATE_IDS.every((id) => METRICS[id].every((k) => k in g[GATE_IDS.indexOf(id)].metrics)),
      "every metric an --expect file may name is computed by its gate");
  }
  // The CLI on run folders: the example's, a planted one, the fixture's; exit codes; --expect; --twice.
  const mkRun = (name, ir, stats, plan) => {
    const d = join(TMP, "accept", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "ir.json"), JSON.stringify(ir));
    if (stats) writeFileSync(join(d, "stats.json"), JSON.stringify(stats));
    writeFileSync(join(d, "plan.json"), JSON.stringify({ balance: plan || BAL }));
    return d;
  };
  const good = mkRun("good", IR, richStats());
  const badStats = richStats(); badStats.m2a.overrides.pixsoFields.total = 6; badStats.m2a.overrides.pixsoFields.dropped.unknown = { scrollDirection: 1 };
  const bad = mkRun("bad", IR, badStats);
  const acc = (args) => node([join(HERE, "m2a-accept.mjs")].concat(args));
  const r0 = acc([good]);
  const missingGates = GATE_IDS.filter((id) => !new RegExp("^" + id + " .*\\[(stats|IR|stats, IR)\\]", "m").test(r0.out));
  check(r0.code === 0 && !missingGates.length && /VERDICT: PASS/.test(r0.out), "m2a-accept prints every gate with its source and exits 0 when none fails", r0.code + " " + missingGates.join(","));
  const want = ["echo fields: 1 (fills 1)", "merged paths: 1, conflicting fields 1", "Pixso fields dropped, no-equivalent: pluginData 1", "Figma fields by P13 class",
    "root box fields", "swap defaults", "derived: written 1, empty 1", "IR size:", "reader time (ms)"];
  const missing = want.filter((w) => r0.out.indexOf(w) < 0);
  check(!missing.length, "m2a-accept prints the never-gating numbers of §8 beneath the gates", missing.join(" | "));
  const r1 = acc([bad]);
  check(r1.code === 3 && /G6 override balances +FAIL/.test(r1.out) && /unknown\): scrollDirection 1/.test(r1.out), "m2a-accept exits 3 when a gate fails, naming the unknown field", r1.out.slice(0, 300));
  const r2 = acc([good, bad]);
  check(r2.code === 3 && /SUMMARY/.test(r2.out), "m2a-accept on several run folders prints a summary and exits 3 when one fails");
  const inRepoExpect = acc([good, "--expect", join(REPO_ROOT, "tools", "m2a-expect.private.json")]);
  check(inRepoExpect.code === 1 && /inside the repository/.test(inRepoExpect.out), "--expect refuses a file inside the repository", inRepoExpect.out.slice(0, 300));
  const ex = join(TMP, "expect.json");
  writeFileSync(ex, JSON.stringify({ format: "pix2fig.m2a-expect", version: 1, files: { [IR.header.source.sha256]: { label: "X", numbers: { "G4.noDefinition": 0, "G4.otherFamily": 1 } } } }));
  const r3 = acc([good, "--expect", ex]);
  check(r3.code === 0 && /M2a ACCEPTANCE  file X/.test(r3.out) && /G4 stale assignments +PASS/.test(r3.out), "--expect labels the file and gates G4", r3.out.slice(0, 300));
  writeFileSync(ex, JSON.stringify({ format: "pix2fig.m2a-expect", version: 1, files: { [IR.header.source.sha256]: { label: "X", numbers: { "G4.staleness": 1 } } } }));
  check(/names no gate metric/.test(threw(() => loadExpect(ex))) && acc([good, "--expect", ex]).code === 1, "--expect refuses a metric no gate computes");
  const v2dir = mkRun("v2", Object.assign(clone(IR), { header: Object.assign(clone(IR.header), { version: 2 }) }), richStats());
  const r4 = acc([v2dir]);
  check(r4.code === 1 && r4.out.indexOf(M1_COMMIT) >= 0, "m2a-accept refuses a version 2 run folder, naming M1's commit", r4.out.slice(0, 300));
  const r5 = acc([join(REPO_ROOT, "tools")]);
  check(r5.code === 1 && /inside the repository/.test(r5.out), "m2a-accept refuses a run folder inside the repository");
  const r6 = acc([good, "--twice"]);
  check(r6.code === 0 && /G8 determinism +n\/a.*not run/.test(r6.out) && /names no \.pix/.test(r6.out), "--twice on a run with no .pix recorded reads n/a", r6.out.slice(0, 200));

  if (!FIXTURE_RUN) { check(false, "the fixture's run folder exists (section 3)"); return; }
  const t = acc([FIXTURE_RUN, "--twice"]);
  check(t.code === (C_PENDING ? 3 : 0) && /G8 determinism +PASS/.test(t.out) && t.out.indexOf("VERDICT: " + FIXTURE_VERDICT) >= 0 && (!C_PENDING || /counters cover 0 carried instances/.test(t.out)),
    "on the fixture's run folder every gate passes, G8 with --twice (two reads, one IR)" + (C_PENDING ? "; pending: C, G6 fails as it must on counters for no instance" : ""), t.out.slice(0, 800));
  const ir = JSON.parse(readFileSync(join(FIXTURE_RUN, "ir.json"), "utf8"));
  const guids = ir.nodes.map((r) => r.guid).filter((g) => t.out.indexOf(g) >= 0);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [...new Set(ir.nodes.map((r) => r.name).filter((n) => n && n.length > 3))].filter((n) => new RegExp("(^|[^\\w])" + esc(n) + "([^\\w]|$)").test(t.out));
  check(!guids.length && !names.length && t.out.indexOf(ir.header.source.sha256.slice(0, 12)) < 0 && t.out.indexOf(ir.header.source.documentName) < 0,
    "m2a-accept prints no guid, layer name, document name or file hash", guids.concat(names).slice(0, 5).join(", "));
  const ir2 = clone(ir); ir2.pages[0].name = ir2.pages[0].name + " (changed)";
  const copy = mkRun("fixture-changed", ir2, JSON.parse(readFileSync(join(FIXTURE_RUN, "stats.json"), "utf8")), JSON.parse(readFileSync(join(FIXTURE_RUN, "plan.json"), "utf8")).balance);
  writeFileSync(join(copy, "run.json"), readFileSync(join(FIXTURE_RUN, "run.json")));
  const t2 = acc([copy, "--twice"]);
  check(t2.code === 3 && /G8 determinism +FAIL/.test(t2.out) && t2.out.indexOf("VERDICT: FAIL (" + (C_PENDING ? "G6, G8" : "G8") + ")") >= 0, "--twice fails G8 alone when ir.json differs from a second read", t2.out.slice(0, 600));
  const rj = JSON.parse(readFileSync(join(FIXTURE_RUN, "run.json"), "utf8"));
  const other = join(TMP, "other.pix"); writeFileSync(other, makeFixture("renumbered").pix);
  writeFileSync(join(copy, "run.json"), JSON.stringify(Object.assign(rj, { pix: other })));
  writeFileSync(join(copy, "ir.json"), JSON.stringify(ir));
  const t3 = acc([copy, "--twice"]);
  check(t3.code === 3 && /the \.pix changed/.test(t3.out), "--twice fails G8 when the .pix is not the one the IR was read from", t3.out.slice(0, 400));
  // Under --variant-sets frames the fixture's run folder passes too, G3 reading "frames".
  const fr = node([join(HERE, "pix-run.mjs"), PIX, "--dry", "--no-pixso", "--variant-sets", "frames", "--data", join(TMP, "data-frames")]);
  const fa = acc([runFolder(fr.out) || "none"]);
  check(fa.code === (C_PENDING ? 3 : 0) && /G3 families +PASS .*--variant-sets frames/.test(fa.out) && fa.out.indexOf("VERDICT: " + FIXTURE_VERDICT) >= 0, "under --variant-sets frames G3 holds the IR to M1's D7 and passes on the fixture", fa.out.slice(0, 400));
  // The classes the gates sum are the frozen note classes (docs/M2A.md §5.1).
  const M = newM2aStats();
  check(Object.keys(M.properties.assignments.stale).join() === NOTE_CLASSES.STALE_ASSIGNMENT.join() && Object.keys(M.overrides.pixsoFields.dropped).join() === NOTE_CLASSES.OVERRIDE_FIELD_DROPPED.join(),
    "the stale and dropped classes G4, G6 and G7 sum are the frozen note classes");
}

try {
  flagGroup();
  folderGroup();
  m1Group();
  await acceptGroup();
} catch (e) { check(false, "a test group threw", (e && e.stack) || e); }
if (failed) console.log("test-m2a-run: scratch kept in " + TMP);
else { try { rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* a scratch folder left behind is harmless */ } }
console.log("");
console.log(failed ? "test-m2a-run: " + failed + " check" + (failed === 1 ? "" : "s") + " FAILED" : "test-m2a-run: all " + passed + " checks pass");
process.exitCode = failed ? 1 : 0;
