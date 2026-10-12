// The render audit judged again offline (docs/M1.md §16.4): a run folder whose audit was made with
// --pictures all keeps both engines' pictures of every root it rendered and, in audit.json, what each
// engine reported with them (the node's size, its box, its render bounds, Pixso's byte count, the
// opacity). Every root can then be judged again under other audit settings with neither Figma nor
// Pixso open. The rules are tools/ir/render-audit.mjs's own: its auditRun runs as the live pass did,
// with figmaExport and pixsoRender answering from the folder (recordedEngines) instead of the engines.
//
//   node tools/ir-rejudge.mjs <runDir> [audit settings, as tools/ir-audit.mjs takes them]
//     [--fine saved|refuse] [--out <file>] [--list 20] [--check]
//
//   import { rejudge, recordedEngines, compareAudits } from "./ir-rejudge.mjs";
//   const { audit, recorded, apart, diff } = await rejudge(runDir, { settings, fine: "saved" });
//
// A setting not given is the recorded pass's own (audit.json's settings), so with no setting at all
// the re-judge is the recorded pass again, and every root must come out as it did (--check: exit 3
// when a root that is not apart does not). A setting the recorded pass did not have takes its default.
//
// What the folder answers, and what it does not (each request the stubs refuse is named in the
// root's why, and the root is "apart": its result is not what a live pass under those settings would
// give):
// - a root's (or a section child's) export at the scale the recorded pass rendered it: its saved
//   pictures (<i>.figma.png, <i>.pixso.png; <i>-c<k> for a section's child), checked against the
//   picture sizes the audit recorded, with the reports as recorded. Those are rounded to 0.001 node
//   units (render-audit's r3), so a placement from them can be off by up to 0.0005 × the scale px;
// - a recorded render that was missing: the recorded reason again (the same why);
// - the exports at k times the scale of a root whose registration was searched on finer pictures
//   (--register-supersample): the folder keeps those pictures (<i>@<k>x) and their sizes, not the
//   reports that came with them. --fine saved (default) answers with the saved pictures and the box
//   and render bounds reported at the export's scale: both engines report the node's absolute
//   bounds (figma-plugin/src/code.js renderExport, SCRIPTS.auditRender in tools/ir/mcp-readonly.mjs),
//   which do not depend on the export's scale, but the folder does not prove it. --fine refuse
//   refuses them, so the search runs on the pictures as exported. Either way such a root is apart;
// - anything else (another scale, after --max-side or --max-scale; a root the recorded pass did not
//   render, such as one hidden in the source; a finer export the recorded pass did not make; a
//   picture the folder does not keep) is refused: "figma render missing: not kept in the run folder:
//   ..." for the export as such, or the search's own fallback for a finer one.
//
// --out writes the re-judged audit (outside the repository, like everything else from a run folder);
// --list prints that many of the roots that changed against the recorded pass.
//
// Exit code: 0 done; 3 --check and a root that is not apart came out otherwise; 1 the folder or a
// flag could not be read.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOutsideRepo } from "./ir/outside-repo.mjs";
import { AUDIT_SETTINGS, auditRun, defaultAuditSettings, guidIndex, parseAuditArgs } from "./ir/render-audit.mjs";
import { canonicalJSON } from "./ir/schema.mjs";
import { readRun } from "./ir-audit.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const NOT_KEPT = "not kept in the run folder: ";

// A PNG's width and height, from its IHDR (the first chunk), or null.
function pngSize(buf) {
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// The two engines as the folder answers for them. recorded: the audit (audit.json); picDir: its
// pictures folder; ir: the run's IR. opts: { fine: "saved" | "refuse" }.
// Returns { figmaExport(job), pixsoRender(guid, scale), notes: Map(root i -> { served, fine, refused }) }:
// served the requests answered from the folder, fine the k of the finer pictures answered with the
// reports at the export's scale (--fine saved), refused what was asked that the folder does not keep.
export function recordedEngines(recorded, picDir, ir, opts) {
  const fineRule = (opts && opts.fine) || "saved";
  if (fineRule !== "saved" && fineRule !== "refuse") throw new RangeError("fine is saved or refuse");
  const byGuid = guidIndex(ir);
  const roots = new Map((recorded.roots || []).map((e) => [e.i, e]));
  const notes = new Map();
  const note = (i) => { if (!notes.has(i)) notes.set(i, { served: 0, fine: null, refused: [] }); return notes.get(i); };
  // The recorded side of record j: a root's entry, or a section child's (by its index under the root).
  const sideOf = (root, child) => {
    const e = roots.get(root);
    if (!e) return null;
    if (child === undefined || child === null) return { root, name: String(root), e };
    const c = Array.isArray(e.children) ? e.children[child] : null;
    return c ? { root, name: root + "-c" + child, e: c, of: e.children.length } : null;
  };
  const sideByGuid = (guid) => {
    const j = byGuid.get(guid);
    if (j === undefined) return null;
    if (roots.has(j)) return sideOf(j);
    const p = ir.nodes[j].parent, e = roots.get(p);
    const k = e && Array.isArray(e.children) ? e.children.findIndex((c) => c.i === j) : -1;
    return k >= 0 ? sideOf(p, k) : null;
  };
  // A saved picture, checked against the size the audit recorded for it: { d } or { why }.
  const picture = (name, engine, want) => {
    const f = join(picDir, name + "." + engine + ".png");
    if (!existsSync(f)) return { why: "no " + engine + " picture " + name };
    const buf = readFileSync(f), size = pngSize(buf);
    if (want && (!size || size[0] !== want[0] || size[1] !== want[1])) return { why: "the saved " + engine + " picture " + name + " is " + (size ? size.join("x") : "not a PNG") + ", the recorded one " + want.join("x") };
    return { d: buf.toString("base64"), n: buf.length };
  };
  // Which of the recorded exports a request at scale v is: 1 (as exported), the recorded search's k,
  // or null (none). e.scale is rounded to 1e-6.
  const factorOf = (e, v) => {
    if (typeof e.scale !== "number") return null;
    const near = (k) => Math.abs(v - e.scale * k) <= 1e-6 * k;
    if (near(1)) return 1;
    const sup = e.register && e.register.supersample;
    if (sup && Number.isInteger(sup.k) && sup.k > 1 && near(sup.k)) return sup.k;
    return null;
  };
  // A request for a node the IR does not have is noted under -1.
  const refuse = (root, what) => { note(root === undefined ? -1 : root).refused.push(what); return what; };
  // The search's record for a finer export of this engine: { k, used, why, sizes }.
  const fineOf = (e) => (e.register && e.register.supersample) || null;
  const missingAt = (sup, engine, k) => {
    if (!sup || sup.used !== false || typeof sup.why !== "string") return null;
    const m = new RegExp("^" + engine + "'s picture at " + k + "x is missing: ([\\s\\S]*)$").exec(sup.why);
    return m ? m[1] : null;
  };

  const figmaExport = async (job) => {
    const root = byGuid.get(job.src);
    const sd = root === undefined ? null : sideOf(root, job.child);
    if (!sd) return { e: refuse(root, NOT_KEPT + "the recorded pass has no entry for " + (job.child === undefined ? "this root" : "this child")) };
    const e = sd.e, v = job.constraint && job.constraint.value, k = factorOf(e, v);
    if (k === null) return { e: refuse(root, NOT_KEPT + "no export of " + sd.name + " at scale " + v + " (the recorded pass rendered it at " + e.scale + ")") };
    if (k > 1) {
      const sup = fineOf(e), miss = missingAt(sup, "Figma", k);
      if (miss !== null) { note(root).served++; return { e: miss }; }
      if (!sup || sup.used === false || !Array.isArray(sup.figma)) return { e: refuse(root, NOT_KEPT + "no export of " + sd.name + " at " + k + "x") };
      if (fineRule === "refuse") return { e: refuse(root, NOT_KEPT + "the reports of " + sd.name + " at " + k + "x (--fine refuse)") };
      const pic = picture(sd.name + "@" + k + "x", "figma", sup.figma);
      if (!pic.d) return { e: refuse(root, NOT_KEPT + pic.why) };
      note(root).fine = k;
      const f = e.figma;
      return { w: f.w, h: f.h, type: e.type, opacity: e.opacity ? e.opacity.value : null, box: f.box, render: f.render, bytes: pic.n, d: pic.d, relocated: f.relocated || null, of: sd.of === undefined ? null : sd.of };
    }
    if (!e.figma) {
      // The recorded pass's own answer where it had no report: a render missing, or a section whose
      // children Figma counts otherwise (its picture is kept).
      const m = /^figma render missing: ([\s\S]*)$/.exec(e.why || "");
      const of = m ? /^the section has (\d+) children in Figma/.exec(m[1]) : null;
      if (of) {
        const pic = picture(sd.name, "figma", null);
        note(root).served++;
        return { w: null, h: null, type: e.type, opacity: null, box: null, render: null, d: pic.d || "", of: Number(of[1]) };
      }
      if (m && !/^no verify report/.test(m[1])) { note(root).served++; return { e: m[1] }; }
      return { e: refuse(root, NOT_KEPT + "no Figma report of " + sd.name + (e.why ? " (recorded: " + String(e.why).slice(0, 80) + ")" : "")) };
    }
    const pic = picture(sd.name, "figma", e.figma.picture);
    if (!pic.d) return { e: refuse(root, NOT_KEPT + pic.why) };
    note(root).served++;
    const f = e.figma;
    return { w: f.w, h: f.h, type: e.type, opacity: e.opacity ? e.opacity.value : null, box: f.box, render: f.render, bytes: pic.n, d: pic.d, relocated: f.relocated || null, of: sd.of === undefined ? null : sd.of };
  };

  const pixsoRender = async (guid, v) => {
    const sd = sideByGuid(guid);
    const root = sd ? sd.root : byGuid.get(guid);
    if (!sd) return { ok: false, error: refuse(root, NOT_KEPT + "the recorded pass has no entry for this node") };
    const e = sd.e, k = factorOf(e, v);
    if (k === null) return { ok: false, error: refuse(root, NOT_KEPT + "no Pixso export of " + sd.name + " at scale " + v + " (the recorded pass rendered it at " + e.scale + ")") };
    if (k > 1) {
      const sup = fineOf(e), miss = missingAt(sup, "Pixso", k);
      if (miss !== null) { note(root).served++; return { ok: true, value: { e: miss } }; }
      if (!sup || sup.used === false || !Array.isArray(sup.pixso) || !e.pixso) return { ok: false, error: refuse(root, NOT_KEPT + "no Pixso export of " + sd.name + " at " + k + "x") };
      if (fineRule === "refuse") return { ok: false, error: refuse(root, NOT_KEPT + "the Pixso report of " + sd.name + " at " + k + "x (--fine refuse)") };
      const pic = picture(sd.name + "@" + k + "x", "pixso", sup.pixso);
      if (!pic.d) return { ok: false, error: refuse(root, NOT_KEPT + pic.why) };
      note(root).fine = k;
      const p = e.pixso;
      return { ok: true, value: { w: p.w, h: p.h, type: e.type, opacity: null, box: p.box, render: p.render, n: pic.n, d: pic.d } };
    }
    if (!e.pixso) {
      const m = /^pixso render missing: ([\s\S]*)$/.exec(e.why || "");
      if (m) { note(root).served++; return { ok: true, value: { e: m[1] } }; }
      return { ok: false, error: refuse(root, NOT_KEPT + "no Pixso report of " + sd.name + (e.why ? " (recorded: " + String(e.why).slice(0, 80) + ")" : "")) };
    }
    const p = e.pixso;
    // Pixso's export of 0 bytes (a hidden node, an empty text): no picture, as it answered.
    if (p.bytes === 0) { note(root).served++; return { ok: true, value: { w: p.w, h: p.h, type: e.type, opacity: null, box: p.box, render: p.render, n: 0, d: "" } }; }
    const pic = picture(sd.name, "pixso", p.picture);
    if (!pic.d) return { ok: false, error: refuse(root, NOT_KEPT + pic.why) };
    note(root).served++;
    return { ok: true, value: { w: p.w, h: p.h, type: e.type, opacity: null, box: p.box, render: p.render, n: typeof p.bytes === "number" ? p.bytes : pic.n, d: pic.d } };
  };
  return { figmaExport, pixsoRender, notes };
}

// The roots of a re-judge that are apart, from the stubs' notes: [{ i, fine, refused }], by root.
export function apartOf(notes) {
  const out = [];
  for (const [i, n] of notes) if (n.fine || n.refused.length) out.push({ i, fine: n.fine, refused: n.refused.slice() });
  return out.sort((a, b) => a.i - b.i);
}

// Root by root, what differs between two audits of one run: [{ i, fields, ok: [a, b], why: [a, b] }].
// fields names the entry's keys whose values differ (ok, why, class, metrics, register, ...); a root
// in one audit only is "missing" from the other. opts.ignore: keys not compared, by default the
// entry's key (the hash of the settings its result depends on, which any other setting changes for
// every root).
export function compareAudits(a, b, opts) {
  const ignore = (opts && opts.ignore) || ["key"];
  const A = new Map((a.roots || []).map((e) => [e.i, e])), B = new Map((b.roots || []).map((e) => [e.i, e]));
  const out = [];
  for (const i of [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y)) {
    const x = A.get(i), y = B.get(i);
    if (!x || !y) { out.push({ i, fields: [x ? "missing from the second" : "missing from the first"], ok: [x ? x.ok : undefined, y ? y.ok : undefined], why: [x ? x.why : undefined, y ? y.why : undefined] }); continue; }
    const fields = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => ignore.indexOf(k) < 0 &&
      canonicalJSON(x[k] === undefined ? null : x[k]) !== canonicalJSON(y[k] === undefined ? null : y[k]));
    if (fields.length) out.push({ i, fields, ok: [x.ok, y.ok], why: [x.why, y.why] });
  }
  return out;
}

// The settings of a re-judge: the recorded pass's, with the given ones over them (a key the recorded
// pass did not have takes its default). given: { key: value } (parseAuditArgs's settings, its given).
export function rejudgeSettings(recorded, given) {
  const S = defaultAuditSettings(), from = recorded && recorded.settings ? recorded.settings : {};
  const missing = [];
  for (const f of Object.keys(AUDIT_SETTINGS)) {
    const key = AUDIT_SETTINGS[f][0];
    if (from[key] !== undefined) S[key] = from[key]; else missing.push(key);
  }
  for (const key of Object.keys(given || {})) S[key] = given[key];
  return { settings: S, missing };
}

// The re-judge of a run folder. opts: { settings (all of them; default the recorded pass's), fine,
// audit (the recorded audit; default <runDir>/audit/audit.json), log }. Returns { audit (the
// re-judged one), recorded, apart, diff (compareAudits(recorded, audit)) }.
export async function rejudge(runDir, opts) {
  const o = opts || {};
  const { states, ir, reports, builds } = readRun(runDir);
  const recorded = o.audit || readJson(join(runDir, "audit", "audit.json"));
  if (recorded.snapshot !== states.snapshot || recorded.runId !== states.runId) {
    throw new Error("the audit is of another run (snapshot " + String(recorded.snapshot).slice(0, 16) + ", run " + recorded.runId + ") than the folder's (" +
      String(states.snapshot).slice(0, 16) + ", " + states.runId + ")");
  }
  const settings = o.settings || rejudgeSettings(recorded, {}).settings;
  const eng = recordedEngines(recorded, join(runDir, "audit", "pictures"), ir, { fine: o.fine });
  const audit = await auditRun({ states, ir, reports, builds, settings, identity: recorded.identity || null, log: o.log,
    figmaExport: eng.figmaExport, pixsoRender: eng.pixsoRender });
  const apart = apartOf(eng.notes);
  audit.tool = "tools/ir-rejudge.mjs";
  audit.rejudged = { from: recorded.made || null, recordedSettings: recorded.settings || null, fine: o.fine || "saved", apart };
  return { audit, recorded, apart, diff: compareAudits(recorded, audit) };
}

// argv -> { runDir, given (settings), fine, out, list, check }; throws RangeError on a bad flag.
export function parseRejudgeArgs(argv) {
  const rest = [], o = { fine: "saved", out: null, list: 20, check: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--check") { o.check = true; continue; }
    if (a === "--fine" || a === "--out" || a === "--list") {
      const v = argv[++k];
      if (v === undefined || String(v).startsWith("--")) throw new RangeError(a + " needs a value");
      if (a === "--fine") { if (v !== "saved" && v !== "refuse") throw new RangeError("--fine is saved or refuse; got " + JSON.stringify(v)); o.fine = v; }
      else if (a === "--out") o.out = v;
      else { const n = Number(v); if (!(Number.isInteger(n) && n >= 0)) throw new RangeError("--list is a whole number"); o.list = n; }
      continue;
    }
    if (a === "--fresh" || a === "--accept-identity-mismatch" || a === "--mcp-url") throw new RangeError(a + " is the live audit's (tools/ir-audit.mjs), not the re-judge's");
    rest.push(a);
  }
  const p = parseAuditArgs(rest);
  const given = {};
  for (const key of p.given) given[key] = p.settings[key];
  return Object.assign(o, { runDir: p.runDir, given });
}

const tally = (list, f) => list.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const okWord = (v) => (v === true ? "ok" : v === null ? "not compared" : v === false ? "not ok" : "absent");

export async function main(argv, log) {
  const say = log || console.log;
  let o;
  try { o = parseRejudgeArgs(argv); } catch (e) { say("ir-rejudge: " + e.message); say("usage: node tools/ir-rejudge.mjs <runDir> [settings] [--fine saved|refuse] [--out <file>] [--list 20] [--check]"); return 1; }
  const runDir = resolve(o.runDir);
  let recorded;
  try { assertOutsideRepo(runDir); recorded = readJson(join(runDir, "audit", "audit.json")); if (o.out) assertOutsideRepo(resolve(o.out)); }
  catch (e) { say("ir-rejudge: the run folder or its audit cannot be read: " + ((e && e.message) || e)); return 1; }
  const { settings, missing } = rejudgeSettings(recorded, o.given);
  let r;
  try { r = await rejudge(runDir, { settings, fine: o.fine, audit: recorded }); }
  catch (e) { say("ir-rejudge: " + ((e && e.message) || e)); return 1; }
  const { audit, apart, diff } = r;
  const apartSet = new Set(apart.map((x) => x.i));
  const C = audit.counts, R = recorded.counts || {};
  const changed = Object.keys(o.given).filter((k) => canonicalJSON(o.given[k]) !== canonicalJSON(recorded.settings ? recorded.settings[k] : undefined));
  say("RE-JUDGE  " + String(audit.snapshot).slice(0, 16) + "…  run " + audit.runId + "  (the audit of " + (recorded.made || "?") + ", pictures " + (recorded.settings ? recorded.settings.pictures : "?") + ")");
  say("settings: " + (changed.length ? changed.map((k) => k + " " + JSON.stringify(recorded.settings ? recorded.settings[k] : undefined) + " -> " + JSON.stringify(settings[k])).join(", ") : "the recorded pass's own") +
    (missing.length ? "; not in the recorded settings (defaults taken): " + missing.join(", ") : ""));
  say("roots: " + C.roots + "; ok " + C.ok + ", not ok " + C.failed + ", not compared " + C.notCompared + "   (recorded: ok " + R.ok + ", not ok " + R.failed + ", not compared " + R.notCompared + ")");
  const fineN = apart.filter((x) => x.fine && !x.refused.length).length, refusedN = apart.filter((x) => x.refused.length).length;
  say("apart: " + apart.length + " (finer pictures answered with the reports at the export's scale " + fineN + ", a request the folder does not keep " + refusedN + ")");
  const inside = diff.filter((d) => !apartSet.has(d.i)), outside = diff.filter((d) => apartSet.has(d.i));
  const moves = tally(diff, (d) => okWord(d.ok[0]) + " -> " + okWord(d.ok[1]));
  say("changed against the recorded pass: " + diff.length + " roots (" + inside.length + " not apart, " + outside.length + " apart); by outcome: " +
    (Object.keys(moves).map((k) => k + " " + moves[k]).join(", ") || "none"));
  const byField = tally(diff.flatMap((d) => d.fields), (f) => f);
  if (diff.length) say("fields that changed (roots): " + Object.keys(byField).map((k) => k + " " + byField[k]).join(", "));
  for (const d of diff.slice(0, o.list)) {
    say("  root " + d.i + (apartSet.has(d.i) ? " (apart)" : "") + ": " + okWord(d.ok[0]) + " -> " + okWord(d.ok[1]) + " [" + d.fields.join(", ") + "]");
    if (d.why[0] !== d.why[1]) { say("    was: " + String(d.why[0]).slice(0, 300)); say("    now: " + String(d.why[1]).slice(0, 300)); }
  }
  if (o.out) { writeFileSync(resolve(o.out), JSON.stringify(audit, null, 1), "utf8"); say("re-judged audit: " + resolve(o.out)); }
  return o.check && inside.length ? 3 : 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
})();
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.log("ir-rejudge: " + ((e && e.stack) || e)); process.exitCode = 1; });
