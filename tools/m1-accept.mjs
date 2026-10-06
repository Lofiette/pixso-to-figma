// M1's acceptance: the gates of docs/M1.md §8.1, the balance of §8.2, every number of §8.3, the
// populations, and build time per phase and per 1 000 records, read from one run folder.
//
//   node tools/m1-accept.mjs <runDir> [--legacy-out <old out dir>] [--audit <report.json>]
//
// <runDir> is the folder tools/pix-run.mjs printed (states.json, plan.json, judge/*.json, ir.json,
// stats.json). The printed report holds counts only. Names (the texts that differ, the vectors and
// sides that differ, the legacy lost borders) go to <runDir>/names.private.txt, a private file in
// the run folder, outside the repository like everything else there.
//
// --legacy-out: the old tool's out/ folder. Its per-object reads (ir.json / tree.json, a `tree` of
// MCP nodes) name the borders the old tool lost outside instances: a visible stroke, a stroke weight
// above 0 and all four side weights 0, on a node that is not an instance and not inside one. Each is
// looked up in this run's IR by guid and reported as built, and with its sides matching (not in the
// judge's side mismatches). Without it the .pix lost-border population is reported (docs/M1.md §0.5).
// --audit: a render audit, <runDir>/audit/audit.json as tools/ir-audit.mjs writes it (docs/M1.md §16),
// or one made by hand ({ format: "pix2fig.audit", version: 2, snapshot, runId, roots: [{ i, guid, ok }] };
// version 1 has no run identity); PASS needs one covering every built root of this run that is not an
// INSTANCE placeholder (an audit naming another snapshot or runId, or other guids, does not count; a
// root whose ok is null was not compared and covers nothing).
//
// Exit code: 0 when the verdict is not FAIL, 3 when it is, 1 when the run folder cannot be read.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOutsideRepo } from "./ir/outside-repo.mjs";
import { m1Gates, m1Verdict, numberLines, timeLines, totalsOf } from "./ir/verdict.mjs";
import { balanceLines } from "./pix-run.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const optJson = (p) => (existsSync(p) ? readJson(p) : null);

// The lost borders of the old tool's reads: [{ guid }] (docs/M1.md §0.5).
export function legacyLostBorders(dir) {
  const out = new Map();
  const visible = (paints) => Array.isArray(paints) && paints.some((p) => p && p.visible !== false && (p.opacity === undefined || p.opacity > 0));
  const walk = (n, inInstance) => {
    if (!n || typeof n !== "object") return;
    const inst = inInstance || n.type === "INSTANCE";
    const sides = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];
    if (!inst && typeof n.id === "string" && visible(n.strokes) && n.strokeWeight > 0 && sides.every((k) => n[k] === 0)) out.set(n.id, { guid: n.id, name: n.name });
    for (const c of n.children || []) walk(c, inst);
  };
  (function scan(d, depth) {
    if (depth > 6) return;
    let names = [];
    try { names = readdirSync(d); } catch (e) { return; }
    for (const f of names) {
      const p = join(d, f);
      let st; try { st = statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) scan(p, depth + 1);
      else if (f === "ir.json" || f === "tree.json") {
        try { const j = readJson(p); walk(j.tree || j, false); } catch (e) { /* not a read of the old tool */ }
      }
    }
  })(dir, 0);
  return [...out.values()];
}

// Reads the run folder and returns { lines, privateLines, gates }.
export function accept(runDir, opts) {
  const o = opts || {};
  const states = readJson(join(runDir, "states.json"));
  const plan = optJson(join(runDir, "plan.json"));
  const stats = optJson(join(runDir, "stats.json"));
  const ir = optJson(join(runDir, "ir.json"));
  const Js = [];
  const jd = join(runDir, "judge");
  if (existsSync(jd)) for (const f of readdirSync(jd).filter((x) => /^\d+\.json$/.test(x)).sort((a, b) => parseInt(a) - parseInt(b))) Js.push(readJson(join(jd, f)));
  const totals = totalsOf(Js);
  const lines = [], priv = [];
  const nameOf = (i) => (ir && ir.nodes[i] ? ir.nodes[i].guid + "  " + JSON.stringify(ir.nodes[i].name) : "record " + i);
  lines.push("M1 ACCEPTANCE  " + states.snapshot.slice(0, 16) + "…  run " + states.runId);
  lines.push(...m1Verdict(totals, states, { audit: o.audit || null, ir }));
  lines.push("");
  lines.push(...balanceLines(states.balance));
  lines.push("plan codes: " + (Object.keys(states.balance.planCodes || {}).map((k) => k + " " + states.balance.planCodes[k]).join(", ") || "none"));
  lines.push("read codes in scope: " + (Object.keys(states.balance.notes || {}).map((k) => k + " " + states.balance.notes[k]).join(", ") || "none"));
  lines.push("populations: " + Object.keys(states.balance.populations || {}).map((k) => k + " " + states.balance.populations[k]).join(", "));
  if (plan && plan.preflight) {
    const L = plan.preflight.lostBorder;
    lines.push("lost-border population (.pix): " + L.population + " in the file, " + L.userPages + " on user pages, " + L.inScope + " in scope");
  }
  lines.push("pixso: " + (states.pixso.used ? "used, " + states.pixso.identity : "not used") + "; missing fonts " + ((states.fonts && states.fonts.missing) || []).length);
  lines.push("");
  lines.push(...numberLines(totals));
  lines.push("");
  const inScope = states.tasks.filter((t) => t.op === "build").reduce((s, t) => s + t.nodes, 0);
  lines.push(...timeLines(states, stats, inScope));
  if (o.legacyOut) {
    const L = legacyLostBorders(o.legacyOut);
    const byGuid = new Map(ir ? ir.nodes.map((r, i) => [r.guid, i]) : []);
    const doneTasks = new Set(states.tasks.filter((t) => t.op === "build" && (t.state === "built" || t.state === "built-with-fallbacks")).map((t) => t.taskNo));
    const builtAll = new Set();
    const recs = (plan && plan.records) || {};
    for (const k of Object.keys(recs)) if (doneTasks.has(Number(k))) for (const i of recs[k]) builtAll.add(i);
    const bad = new Set(totals ? totals.sides.mismatchIR.concat(totals.sides.mismatchOracle).map((x) => x.i) : []);
    let found = 0, b = 0, ok = 0;
    for (const x of L) {
      const i = byGuid.get(x.guid);
      if (i === undefined) { priv.push("legacy lost border not in the IR: " + x.guid + "  " + JSON.stringify(x.name)); continue; }
      found++;
      if (!builtAll.has(i)) { priv.push("legacy lost border not built: " + nameOf(i)); continue; }
      b++;
      if (bad.has(i)) priv.push("legacy lost border with differing sides: " + nameOf(i)); else ok++;
    }
    lines.push("legacy lost borders (--legacy-out): " + L.length + " named, " + found + " in the IR, " + b + " built, " + ok + " with sides as the IR says" + (totals ? "" : " (nothing judged)"));
  }
  if (totals) {
    for (const d of totals.text.differ) priv.push("text lines differ: " + nameOf(d.i) + "  ir " + d.irLines + " figma " + d.figmaLines + (d.widened ? " widened" : "") + (d.fontHeld ? " font-held" : "") + (d.approx ? " approximate" : ""));
    for (const d of totals.vectors.differs) priv.push("vector differs (" + d.kind + "): " + nameOf(d.i));
    for (const d of totals.sides.mismatchIR) priv.push("sides differ from the IR: " + nameOf(d.i) + "  ir " + JSON.stringify(d.ir) + " figma " + JSON.stringify(d.figma));
    for (const d of totals.sides.mismatchOracle) priv.push("sides differ from the oracle: " + nameOf(d.i) + "  oracle " + JSON.stringify(d.oracle) + " figma " + JSON.stringify(d.figma));
    for (const i of totals.placeholders.misaligned) priv.push("placeholder misaligned: " + nameOf(i));
  }
  return { lines, privateLines: priv, gates: m1Gates(totals, states, { audit: o.audit || null, ir }) };
}
export function main(argv) {
  const a = argv.slice();
  const flag = (n) => { const k = a.indexOf(n); if (k < 0) return null; const v = a[k + 1]; a.splice(k, 2); return v; };
  const legacyOut = flag("--legacy-out"), auditFile = flag("--audit");
  const runDir = a[0];
  if (!runDir || a.length !== 1) { console.log("usage: node tools/m1-accept.mjs <runDir> [--legacy-out <old out dir>] [--audit <report.json>]"); return 1; }
  let r;
  try {
    assertOutsideRepo(resolve(runDir));
    r = accept(resolve(runDir), { legacyOut, audit: auditFile ? readJson(auditFile) : null });
  } catch (e) { console.log("m1-accept: " + ((e && e.message) || e)); return 1; }
  for (const l of r.lines) console.log(l);
  const names = join(resolve(runDir), "names.private.txt");
  try { assertOutsideRepo(names); writeFileSync(names, r.privateLines.join("\n") + "\n", "utf8"); console.log("names (private): " + names + " (" + r.privateLines.length + " lines)"); }
  catch (e) { console.log("m1-accept: names not written: " + e.message); }
  return r.gates.failed.length ? 3 : 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
