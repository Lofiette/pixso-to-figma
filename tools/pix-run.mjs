// M1's runner: a .pix through the reader, the planner and the image chain into Figma, with every
// object ending in a recorded state (docs/M1.md §4, §6 D).
//
//   node tools/pix-run.mjs --source pix <file.pix> [--scope file|pages:<guids>] [--m1-scope default|all-masters|all]
//     [--booleans auto|native|flatten] [--space-evenly-single between|center] [--text-fit widen|source-box]
//     [--layout-order creation|deepestFirst] [--text-read measure|inLoop] [--images archive,mcp,render]
//     [--no-pixso] [--missing-fonts ask|substitute] [--fallback-font Family/Style] [--max-task-mb n]
//     [--liveness-warn-s n] [--liveness-fail-s n] [--ceiling-ms-per-node n] [--only <taskNo>] [--dry] [--yes]
//     [--data <dir>] [--from-ir <ir.json> [--stats <stats.json>]]
//
// Every policy is a setting with the default of docs/M1.md §3 (SETTINGS below). --dry reads, plans,
// runs the image chain's offline link and prints the preflight and the balance, without Figma.
// --from-ir starts from an IR written by tools/pix-to-ir.mjs instead of reading the .pix (the .pix,
// when also given, still supplies the archive's image bytes).
//
// Everything it writes goes to the run folder <data>/runs/<sha256 prefix>-<settings hash>, outside
// the repository (assertOutsideRepo): ir.json, stats.json, plan.json, images.json, states.json,
// reports/<taskNo>-<op>.json, judge/<taskNo>.json, and the MCP scratch and image cache. A second run
// with the same file and settings resumes: built tasks stay built, failed and skipped ones run again.
// tools/m1-accept.mjs reads the run folder and prints the verdict.
//
// Exit codes: 0 every task built (or --dry), 1 refused or broken, 2 the run stopped (missing fonts,
// a stalled plugin) or a task failed; run again to resume.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CODE, SETTINGS as IR_SETTINGS, canonicalJSON, fnv1a64 } from "./ir/schema.mjs";
import { TASK_SETTINGS, maxTaskChars } from "./ir/task.mjs";
import { validate } from "./ir/validate.mjs";
import { assertOutsideRepo } from "./ir/outside-repo.mjs";
import { M1_SCOPES, PLAN_DEFAULTS, cleanTaskFor, parseScope, planM1 } from "./ir/plan.mjs";
import { LINKS, parseLinks, resolveImages, tableFromIR } from "./ir/images.mjs";
import { checkIdentity } from "./ir/identity.mjs";
import { makeMcpClient } from "./ir/mcp-readonly.mjs";
import { defaultDataDir, dropUnjudged, loadStates, newStates, probeStatus, resumeStates, runTasks, saveStates } from "./ir/runstate.mjs";
import * as judge from "./ir/judge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// docs/M1.md §3: flag -> [key, values | parser, default].
export const SETTINGS = {
  "--source": ["source", ["pix", "mcp"], "pix"],
  "--scope": ["scope", (v) => (parseScope(v), v), "file"],
  "--m1-scope": ["m1Scope", M1_SCOPES, "default"],
  "--booleans": ["booleans", IR_SETTINGS.booleans, "auto"],
  "--space-evenly-single": ["spaceEvenlySingle", IR_SETTINGS.spaceEvenlySingle, "between"],
  "--text-fit": ["textFit", IR_SETTINGS.textFit, "widen"],
  "--layout-order": ["layoutOrder", TASK_SETTINGS.layoutOrder, "creation"],
  "--text-read": ["textRead", TASK_SETTINGS.textRead, "measure"],
  "--images": ["images", (v) => parseLinks(v).join(","), LINKS.join(",")],
  "--missing-fonts": ["missingFonts", ["ask", "substitute"], "ask"],
  "--fallback-font": ["fallbackFont", (v) => { const m = /^([^/]+)\/(.+)$/.exec(v); if (!m) throw new RangeError("--fallback-font is Family/Style"); return m[1] + "/" + m[2]; }, "Inter/Regular"],
  "--max-task-mb": ["maxTaskMb", (v) => { maxTaskChars(Number(v)); return Number(v); }, 4],
  "--liveness-warn-s": ["livenessWarnS", (v) => posNum(v, "--liveness-warn-s"), 60],
  "--liveness-fail-s": ["livenessFailS", (v) => posNum(v, "--liveness-fail-s"), 300],
  "--ceiling-ms-per-node": ["ceilingMsPerNode", (v) => posNum(v, "--ceiling-ms-per-node"), 20],
  "--only": ["only", (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new RangeError("--only takes a task number"); return n; }, null],
  "--data": ["data", (v) => v, null],
  "--from-ir": ["fromIr", (v) => v, null],
  "--stats": ["statsFile", (v) => v, null],
};
const SWITCHES = { "--no-pixso": "noPixso", "--dry": "dry", "--yes": "yes" };
function posNum(v, f) { const n = Number(v); if (!(n > 0)) throw new RangeError(f + " is a positive number"); return n; }

export function parseArgs(argv) {
  const o = { file: null, noPixso: false, dry: false, yes: false, given: [] };
  for (const f of Object.keys(SETTINGS)) o[SETTINGS[f][0]] = SETTINGS[f][2];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (SWITCHES[a]) { o[SWITCHES[a]] = true; continue; }
    if (SETTINGS[a]) {
      const [key, rule] = SETTINGS[a];
      const v = argv[++k];
      if (v === undefined) throw new RangeError(a + " needs a value");
      if (Array.isArray(rule)) { if (rule.indexOf(v) < 0) throw new RangeError(a + " is one of " + rule.join(", ") + "; got " + JSON.stringify(v)); o[key] = v; }
      else o[key] = rule(v);
      if (o.given.indexOf(key) < 0) o.given.push(key);
      continue;
    }
    if (a.startsWith("--")) throw new RangeError("unknown option " + a);
    if (o.file) throw new RangeError("one .pix at a time; got " + o.file + " and " + a);
    o.file = a;
  }
  if (o.source !== "pix") throw new RangeError("--source mcp is M4's; M1 reads a .pix");
  if (!o.file && !o.fromIr) throw new RangeError("a .pix file is required (or --from-ir <ir.json>)");
  if (o.livenessWarnS >= o.livenessFailS) throw new RangeError("--liveness-warn-s must be below --liveness-fail-s");
  // --no-pixso is the same as --images archive (docs/M1.md §3).
  if (o.noPixso) o.images = "archive";
  return o;
}

// The reader's settings an IR was read with (its header), which --from-ir must keep: the planner
// and the run folder describe the IR, not the command line's defaults. A flag given that
// contradicts one is refused; one not given takes the header's value. Returns the refusal, or null.
export const READER_FLAGS = { booleans: "--booleans", spaceEvenlySingle: "--space-evenly-single", textFit: "--text-fit", scope: "--scope" };
export function adoptIrSettings(o, header) {
  const hs = (header && header.settings) || {};
  const sc = header && header.scope;
  const fromHeader = { booleans: hs.booleans, spaceEvenlySingle: hs.spaceEvenlySingle, textFit: hs.textFit,
    scope: sc && sc.kind === "pages" && Array.isArray(sc.ids) ? "pages:" + sc.ids.join(",") : sc && sc.kind === "file" ? "file" : undefined };
  for (const k of Object.keys(READER_FLAGS)) {
    const v = fromHeader[k];
    if (v === undefined) continue;
    if ((o.given || []).indexOf(k) >= 0 && o[k] !== v) return READER_FLAGS[k] + " " + o[k] + " contradicts the IR, which was read with " + v;
    o[k] = v;
  }
  return null;
}

// The settings recorded in states.json, and the run folder's name.
export function runSettings(o) {
  const [family, style] = o.fallbackFont.split("/");
  return { source: o.source, scope: o.scope, m1Scope: o.m1Scope, booleans: o.booleans, spaceEvenlySingle: o.spaceEvenlySingle, textFit: o.textFit,
    layoutOrder: o.layoutOrder, textRead: o.textRead, images: o.images, noPixso: o.noPixso, missingFonts: o.missingFonts,
    fallbackFont: { family, style }, maxTaskMb: o.maxTaskMb, livenessWarnS: o.livenessWarnS, livenessFailS: o.livenessFailS,
    ceilingMsPerNode: o.ceilingMsPerNode };
}
export function runDirName(sha256, settings) {
  return String(sha256).slice(0, 12) + "-" + fnv1a64(canonicalJSON(settings)).slice(0, 8);
}

const say = (m) => console.log(m);
const jsonOut = (file, v) => { assertOutsideRepo(file); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(v), "utf8"); };

export function preflightLines(plan, table, identity, settings) {
  const P = plan.preflight, B = plan.balance;
  const lines = ["PREFLIGHT"];
  lines.push("settings: " + JSON.stringify(settings));
  lines.push("fonts the build uses (" + P.fonts.length + "): " + P.fonts.map((f) => f.family + " " + f.style).join("; "));
  lines.push("images: " + P.images.referenced + " referenced in scope; archive " + P.images.bySource.archive + ", Pixso bytes " + P.images.bySource.mcp +
    ", render " + P.images.bySource.render + ", placeholder (" + CODE.IMAGE_PLACEHOLDER + ") " + P.images.bySource.none);
  const why = {};
  for (const t of table) if (t.source === "none") for (const r of String(t.reason || "").split("; ")) why[r.replace(/\(.*\)/, "").trim()] = (why[r.replace(/\(.*\)/, "").trim()] || 0) + 1;
  for (const k of Object.keys(why)) lines.push("  placeholder because " + k + ": " + why[k]);
  lines.push("pixso: " + (identity ? (identity.same && identity.q5 ? "same file, Q5 holds" : (identity.code || "not used") + " — " + identity.detail) : "not used"));
  lines.push("populations (" + P.populationSource + "): " + Object.keys(P.populations).filter((k) => P.populations[k].records)
    .map((k) => k + " " + P.populations[k].records + (P.populations[k].built ? " built" : " out of scope")).join(", "));
  lines.push("lost-border population: " + P.lostBorder.population + " in the file, " + P.lostBorder.userPages + " on user pages, " + P.lostBorder.inScope + " in scope");
  lines.push("tasks: " + P.tasks.total + " (1 fonts, " + P.tasks.build + " build, " + P.tasks.verify + " verify), largest " + P.tasks.largest + " of " + P.tasks.cap + " characters");
  lines.push(...balanceLines(B));
  return lines;
}

export function balanceLines(B) {
  const S = B.stored, NI = B.nonInstance, I = B.instances;
  const terms = Object.keys(S.terms).map((k) => k + " " + S.terms[k]).join(" + ");
  const m = (o) => Object.keys(o).map((k) => k + " " + o[k]).join(" + ") || "0";
  return [
    "BALANCE (" + (B.ok ? "adds up" : "does NOT add up") + ")",
    "  stored " + (S.stored === null ? "unknown" : S.stored) + " = " + terms + " = " + S.sum + (S.ok ? "" : "   <- " + (S.why || "differs")) + "   (the reader's own check, repeated)",
    "  IR non-instance " + NI.ir + " = built (S1 " + NI.builtS1 + " + S2 " + NI.builtS2 + ") + " + CODE.OUT_OF_SCOPE + " (" + m(NI.outOfScope) + ") = " + NI.sum + (NI.ok ? "" : "   <- differs"),
    "  IR INSTANCE " + I.ir + " = placeholders " + I.placeholders + " + " + CODE.OUT_OF_SCOPE + " (" + m(I.outOfScope) + ") = " + I.sum + (I.ok ? "" : "   <- differs"),
  ];
}

// The judge the run calls per verify task: part C's judgeTask on the IR, with part A's lost-border
// population (stats.populations.lostBorder), which only the reader can name (docs/M1.md §8.3); null
// while the judge is not in the build.
export function judgeWith(ir, stats) {
  if (!judge.JUDGE_IMPLEMENTED) return null;
  const lost = stats && stats.populations && Array.isArray(stats.populations.lostBorder) ? stats.populations.lostBorder : null;
  return (a) => judge.judgeTask(Object.assign({ ir, lostBorder: lost }, a));
}

async function loadReader() {
  const p = join(HERE, "pix", "ir", "index.mjs");
  if (!existsSync(p)) throw new Error("part A's reader (tools/pix/ir/index.mjs, pixToIR) is not in this build; use --from-ir with an IR made elsewhere");
  return import(pathToFileURL(p).href);
}

export async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { say("pix-run: " + e.message); return 1; }
  let dataDir;
  try { dataDir = assertOutsideRepo(o.data ? resolve(o.data) : defaultDataDir()); }
  catch (e) { say("pix-run: " + e.message); return 1; }

  // ---------- read ----------
  let pix = null, ir, stats = null, buffer = null;
  try {
    if (o.file) buffer = readFileSync(o.file);
    if (buffer) { const { readPix } = await import("./pix/read.mjs"); pix = readPix(buffer); }
    if (o.fromIr) {
      ir = JSON.parse(readFileSync(o.fromIr, "utf8"));
      if (o.statsFile) stats = JSON.parse(readFileSync(o.statsFile, "utf8"));
    } else {
      const { pixToIR } = await loadReader();
      const r = pixToIR(buffer, { settings: { booleans: o.booleans, spaceEvenlySingle: o.spaceEvenlySingle, textFit: o.textFit, scope: o.scope } });
      ir = r.ir; stats = r.stats;
    }
  } catch (e) { say("pix-run: the source cannot be read: " + ((e && e.message) || e) + (e && e.code ? " (" + e.code + ")" : "")); return 1; }
  const v = validate(ir);
  if (!v.ok) { say("pix-run: the IR is refused: " + v.errors.slice(0, 5).map((x) => x.path + ": " + x.message).join("; ")); return 1; }
  if (o.fromIr) { const why = adoptIrSettings(o, ir.header); if (why) { say("pix-run: " + why); return 1; } }
  const settings = runSettings(o);
  const sha = ir.header.source.sha256 || createHash("sha256").update(JSON.stringify(ir.header.source)).digest("hex");
  const runDir = join(dataDir, "runs", runDirName(sha, settings));
  try {
    assertOutsideRepo(runDir);
    jsonOut(join(runDir, "ir.json"), ir);
    if (stats) jsonOut(join(runDir, "stats.json"), stats);
  } catch (e) { say("pix-run: " + e.message); return 1; }
  say("run folder: " + runDir);

  // ---------- Pixso, images, plan ----------
  const links = parseLinks(o.images);
  let verdicts = null;
  try { verdicts = JSON.parse(readFileSync(join(HERE, "double", "verdicts.json"), "utf8")); } catch (e) { say("note: tools/double/verdicts.json not readable; every probe pending"); }
  const planOpts = { m1Scope: o.m1Scope, settings: { textFit: o.textFit, layoutOrder: o.layoutOrder, textRead: o.textRead, fallbackFont: settings.fallbackFont,
    maxTaskMb: o.maxTaskMb, ceilingMsPerNode: o.ceilingMsPerNode, scope: o.scope } };
  let plan;
  try { plan = planM1(ir, stats, Object.assign({}, planOpts, { images: tableFromIR(ir) })); }
  catch (e) { say("pix-run: planning failed: " + e.message); return 1; }
  let identity = null, client = null;
  if (links.some((l) => l !== "archive")) {
    client = makeMcpClient({ dir: join(runDir, "mcp") });
    identity = await checkIdentity(pix, ir, client);
    say("pixso: " + (identity.transport ? "not reachable, continuing without it (" + identity.detail + ")" : identity.detail));
  }
  const needed = new Set();
  for (const t of plan.tasks) for (const im of t.images) needed.add(im.hash);
  const { bytes, table } = await resolveImages(ir, pix, { pixso: client ? { client, identity } : null, links, verdicts, cacheDir: join(dataDir, "image-cache"), only: needed });
  plan = planM1(ir, stats, Object.assign({}, planOpts, { images: table }));
  jsonOut(join(runDir, "images.json"), table);
  jsonOut(join(runDir, "plan.json"), { balance: plan.balance, preflight: plan.preflight, ledger: plan.ledger,
    outOfScope: Object.keys(plan.scope.outOfScope).reduce((m, k) => { m[k] = plan.scope.outOfScope[k].length; return m; }, {}),
    records: plan.tasks.filter((t) => t.op === "build").reduce((m, t) => { m[t.taskNo] = t.nodes.map((n) => n.i); return m; }, {}) });
  for (const l of preflightLines(plan, table, identity, settings)) say(l);
  const pixsoState = { used: !!client && !!identity && !identity.transport, identity: identity ? identity.detail : null, q5: !!(identity && identity.q5) };
  const fresh = newStates({ snapshot: plan.tasks[0].snapshot, irVersion: ir.header.version, runId: plan.tasks[0].runId, settings,
    probes: probeStatus(verdicts), pixso: pixsoState, balance: plan.balance, ledger: plan.ledger });
  if (identity && identity.code) fresh.balance.planCodes[identity.code] = (fresh.balance.planCodes[identity.code] || 0) + 1;
  if (o.dry) { say("--dry: nothing was sent to Figma"); return 0; }

  // ---------- Figma ----------
  const statesFile = join(runDir, "states.json");
  const { states, resumed } = resumeStates(loadStates(statesFile), fresh, plan.tasks);
  if (resumed) say("resuming: " + resumed + " tasks already built in this run folder");
  // A verify kept as built whose judgement is not on disk (a run that died before writing it) is
  // judged again, with its build and its split chain.
  const redo = dropUnjudged(states, plan.tasks, (no) => existsSync(join(runDir, "judge", no + ".json")));
  if (redo) say("resuming: " + redo + " tasks run again, their judgement was not on disk");
  // A judgement on disk belongs to a verify task that is kept; any other is stale and goes.
  for (const t of states.tasks) if (t.op === "verify" && t.state === "pending") rmSync(join(runDir, "judge", t.taskNo + ".json"), { force: true });
  saveStates(statesFile, states);
  const { openSession, waitForPlugin } = await import("./session.mjs");
  let srv;
  try { srv = await openSession(); await waitForPlugin(srv); }
  catch (e) { say("pix-run: no plugin: " + e.message); if (srv) srv.close(); return 1; }
  const liveness = { warnMs: o.livenessWarnS * 1000, failMs: o.livenessFailS * 1000 };
  const post = (task, p) => srv.post({ kind: "ir" }, JSON.stringify(task), p.images, p.ceilingMs + 60000,
    { liveness, ceilingMs: p.ceilingMs, onProgress: () => {} });
  const imagesFor = (task) => { const m = new Map(); for (const im of task.images) if (im.source !== "none" && bytes.has(im.hash)) m.set(im.hash, bytes.get(im.hash)); return m; };
  const r = await runTasks({ states, tasks: plan.tasks, post, imagesFor, clean: (t) => cleanTaskFor(t, ir),
    judge: judgeWith(ir, stats), onJudge: (t, J) => jsonOut(join(runDir, "judge", t.taskNo + ".json"), J),
    save: (s) => saveStates(statesFile, s), onReport: (t, rep) => jsonOut(join(runDir, "reports", t.taskNo + "-" + t.op + ".json"), rep),
    log: say, missingFonts: o.missingFonts, yes: o.yes, only: o.only });
  srv.close();
  if (!judge.JUDGE_IMPLEMENTED) say("note: part C's judge is not in this build; gates G3 and G6-G11 have nothing to read");
  if (r.stopped === "fonts") say("missing fonts:\n" + states.fonts.missing.map((f) => "  " + f.family + " " + f.style).join("\n"));
  const { accept } = await import("./m1-accept.mjs");
  for (const l of accept(runDir, {}).lines.slice(0, 20)) say(l);
  say("full acceptance: node tools/m1-accept.mjs " + JSON.stringify(runDir));
  return r.stopped || states.tasks.some((t) => t.state === "failed" || t.state === "skipped") ? 2 : 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
})();
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.log("pix-run: " + ((e && e.stack) || e)); process.exitCode = 1; });
}
