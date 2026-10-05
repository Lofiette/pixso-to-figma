// The run's state (states.json v2) and the loop that drives the plugin through the plan's tasks
// (docs/M1.md §6 D, docs/REWRITE.md §6: every object ends in a recorded state).
//
//   import { newStates, resumeStates, runTasks, saveStates, loadStates, count } from "./ir/runstate.mjs";
//
// states.json v2:
//   { version: 2, snapshot, irVersion, runId, settings, probes: { P4, P5, P6, P8, P18, P19B: "run <date>" | "pending" },
//     pixso: { used, identity, q5 }, fonts: { missing: [{ family, style }] }, balance: {…},
//     tasks: [{ taskNo, op, roots: [IR index], nodes, ceilingMs, state, codes, ms, error, failures }] }
//   state: pending | built | built-with-fallbacks | failed | skipped. `failures` (the build report's
//   failures[] count, gate G5) is the one key this file adds to docs/M1.md §6 D's task record.
//
// Transitions (TRANSITIONS): pending -> built | built-with-fallbacks | failed | skipped; on resume
// failed and skipped -> pending. A built task is never re-run by a resume of the same snapshot and
// settings; a resume of anything else starts a fresh state. A PLUGIN_STALLED task is failed, stops
// the run (the rest are skipped) and is resumable.
//
// count(codes, code, n) is the runner's one way to record a code (docs/M1.md §5.1): it throws on a
// code that is not in the vocabulary.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CODE, REASON_CODES } from "./schema.mjs";
import { assertOutsideRepo } from "./outside-repo.mjs";

export const STATES_VERSION = 2;
export const TASK_STATES = ["pending", "built", "built-with-fallbacks", "failed", "skipped"];
export const TRANSITIONS = { pending: ["built", "built-with-fallbacks", "failed", "skipped"], failed: ["pending"], skipped: ["pending"],
  built: [], "built-with-fallbacks": [] };
export const PROBES = ["P4", "P5", "P6", "P8", "P18", "P19B"];
// Build codes that mean a counted fallback rather than the thing itself.
export const FALLBACK_CODES = [CODE.BOOLEAN_FALLBACK, CODE.VECTOR_NETWORK_REFUSED, CODE.MASK_UNSUPPORTED, CODE.FONT_SUBSTITUTED,
  CODE.IMAGE_PLACEHOLDER, CODE.FILTER_UNRENDERED, CODE.STYLE_TARGET_NOT_BUILT, CODE.OVERRIDE_APPLY_FAILED];

export function count(codes, code, n) {
  if (!Object.prototype.hasOwnProperty.call(REASON_CODES, code)) throw new Error("count: " + JSON.stringify(code) + " is not a reason code (tools/ir/schema.mjs)");
  const k = n === undefined ? 1 : n;
  if (!Number.isFinite(k) || k < 0) throw new RangeError("count: n is a number >= 0");
  codes[code] = (codes[code] || 0) + k;
  return codes;
}

// The per-user data folder (docs/REWRITE.md §8): private artefacts live there, never in the repository.
export function defaultDataDir(env, platform) {
  const e = env || process.env, p = platform || process.platform;
  if (p === "win32") return join(e.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "pix2fig");
  if (p === "darwin") return join(homedir(), "Library", "Application Support", "pix2fig");
  return join(e.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pix2fig");
}

// Each gating probe's status, from verdicts.json: "run <date>" or "pending". P5 and P6 are builder
// settings and P18 a render pair (docs/M1.md D11, §10): pending until verdicts.json records them.
export function probeStatus(verdicts) {
  const P = (verdicts && verdicts.probes) || {};
  const out = {};
  for (const k of PROBES) {
    const s = P[k] && typeof P[k].status === "string" ? P[k].status : "pending";
    out[k] = /^run \d{4}-\d{2}-\d{2}/.test(s) ? s : "pending";
  }
  return out;
}

export function newStates({ snapshot, irVersion, runId, settings, probes, pixso, balance, ledger }) {
  return {
    version: STATES_VERSION, snapshot, irVersion, runId, settings, probes,
    pixso: pixso || { used: false, identity: null, q5: false },
    fonts: { missing: [] }, balance,
    tasks: ledger.map((t) => ({ taskNo: t.taskNo, op: t.op, roots: t.roots.slice(), nodes: t.nodes, ceilingMs: t.ceilingMs,
      state: "pending", codes: {}, ms: {}, error: null, failures: 0 })),
  };
}

// A fresh state for this plan, keeping what an earlier state of the same snapshot, settings and plan
// already built: a build and its verify are kept only together; failed and skipped go back to pending.
// With the plan's tasks (part F), a root split across tasks is kept only whole: a resume runs under a
// new runId, so the session that knew a split root's built parent is gone, and the parent carries
// no stamp until a later task attaches to it (figma-plugin/src/ir/build.js boundaryParent). When any
// build of a chain (a task and the tasks whose roots attach to its records, transitively) is not
// kept, every build of the chain and its verify run again; the clean before each build removes the
// earlier top-level root with whatever was attached to it.
export function resumeStates(old, fresh, tasks) {
  const sameTask = (a, b) => a && b && a.op === b.op && a.taskNo === b.taskNo && a.nodes === b.nodes && JSON.stringify(a.roots) === JSON.stringify(b.roots);
  if (!old || old.version !== STATES_VERSION || old.snapshot !== fresh.snapshot || JSON.stringify(old.settings) !== JSON.stringify(fresh.settings) ||
    !Array.isArray(old.tasks) || old.tasks.length !== fresh.tasks.length || !old.tasks.every((t, k) => sameTask(t, fresh.tasks[k]))) {
    return { states: fresh, resumed: 0 };
  }
  const done = (t) => t.state === "built" || t.state === "built-with-fallbacks";
  const keep = fresh.tasks.map((t, k) => {
    const o = old.tasks[k];
    if (t.op === "build") return done(o) && !!old.tasks[k + 1] && old.tasks[k + 1].op === "verify" && done(old.tasks[k + 1]);
    if (t.op === "verify") return done(o) && done(old.tasks[k - 1]);
    return false;
  });
  for (const group of splitChains(tasks || [])) {
    const ks = group.map((no) => fresh.tasks.findIndex((t) => t.taskNo === no)).filter((k) => k >= 0);
    if (ks.every((k) => keep[k])) continue;
    for (const k of ks) { keep[k] = false; if (fresh.tasks[k + 1] && fresh.tasks[k + 1].op === "verify") keep[k + 1] = false; }
  }
  let resumed = 0;
  fresh.tasks.forEach((t, k) => {
    const o = old.tasks[k];
    if (keep[k]) { Object.assign(t, { state: o.state, codes: o.codes, ms: o.ms, error: null, failures: o.failures || 0 }); resumed++; }
  });
  fresh.fonts = old.fonts || fresh.fonts;
  return { states: fresh, resumed };
}

// The build tasks that hold one split root, as lists of taskNo: a task whose root attaches to a record
// ({ i }) is in the chain of the task that holds that record. Chains of one task are left out.
export function splitChains(tasks) {
  const holder = new Map(), up = new Map();
  const find = (a) => { while (up.get(a) !== a) a = up.get(a); return a; };
  for (const t of tasks) if (t.op === "build") { up.set(t.taskNo, t.taskNo); for (const n of t.nodes || []) holder.set(n.i, t.taskNo); }
  for (const t of tasks) if (t.op === "build") for (const r of t.roots || []) {
    if (!r || typeof r.attachTo !== "object" || r.attachTo === null || !holder.has(r.attachTo.i)) continue;
    const a = find(t.taskNo), b = find(holder.get(r.attachTo.i));
    if (a !== b) up.set(a, b);
  }
  const groups = new Map();
  for (const no of up.keys()) { const g = find(no); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(no); }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a - b));
}

export function transition(states, taskNo, to, rec) {
  const t = states.tasks.find((x) => x.taskNo === taskNo);
  if (!t) throw new Error("no task " + taskNo);
  if (TASK_STATES.indexOf(to) < 0) throw new RangeError("unknown state " + JSON.stringify(to));
  if (TRANSITIONS[t.state].indexOf(to) < 0) throw new Error("task " + taskNo + ": " + t.state + " cannot become " + to);
  t.state = to;
  if (rec) for (const k of ["codes", "ms", "error", "failures"]) if (rec[k] !== undefined) t[k] = rec[k];
  return t;
}

export function saveStates(file, states) {
  const real = assertOutsideRepo(file);
  mkdirSync(dirname(real), { recursive: true });
  const tmp = real + ".tmp";
  writeFileSync(tmp, JSON.stringify(states, null, 1), "utf8");
  renameSync(tmp, real);
}
export function loadStates(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { return null; }
}

// What a build report says about its task: the state, its codes and its phase times.
export function buildOutcome(report) {
  const codes = {};
  for (const k of Object.keys((report && report.codes) || {})) count(codes, k, report.codes[k]);
  const failures = Array.isArray(report && report.failures) ? report.failures.length : 0;
  const fallback = failures > 0 || FALLBACK_CODES.some((c) => codes[c] > 0);
  return { state: fallback ? "built-with-fallbacks" : "built", codes, ms: (report && report.ms) || {}, failures };
}

const errText = (e) => String((e && (e.stack || e.message)) || e);
const isStall = (e) => !!e && (e.code === CODE.PLUGIN_STALLED || e.stalled === true);

// Drive the plugin through the tasks. Every dependency is passed in, so the tests play the plugin:
//   post(task, { ceilingMs, images }) -> Promise<report>  (rejects on a stall, err.code PLUGIN_STALLED)
//   clean(buildTask) -> task | null     the clean task to send before a build (null: none)
//   imagesFor(task) -> Map hash -> Buffer
//   judge({ task, build, verify }) -> J | null   (null while part C's judge is not in this build)
//   save(states), onReport(task, report), log(line)
//   missingFonts "ask" | "substitute", yes: continue past the font preflight
//   only: a build taskNo (with its verify; the fonts task always runs) or null
// Returns { stopped: null | "fonts" | "stalled", Js: [J] }.
export async function runTasks(o) {
  const { states, tasks } = o;
  const log = o.log || (() => {});
  const save = o.save || (() => {});
  const Js = [];
  const byNo = new Map(states.tasks.map((t) => [t.taskNo, t]));
  const builds = new Map();
  let stopped = null;
  const skipRest = (from) => {
    for (const t of tasks) if (t.taskNo > from && byNo.get(t.taskNo).state === "pending") transition(states, t.taskNo, "skipped", { error: "the run stopped at task " + from });
  };
  for (const task of tasks) {
    const rec = byNo.get(task.taskNo);
    if (o.only && task.op !== "fonts" && task.taskNo !== o.only && task.taskNo !== o.only + 1) continue;
    if (rec.state !== "pending") {
      if (task.op === "build") builds.set(task.taskNo, null);
      continue;
    }
    const opts = { ceilingMs: rec.ceilingMs, images: o.imagesFor ? o.imagesFor(task) : new Map() };
    let report;
    try {
      if (task.op === "build" && o.clean) {
        const c = o.clean(task);
        if (c) {
          const rc = await o.post(c, { ceilingMs: rec.ceilingMs, images: new Map() });
          if (rc && (rc.error || rc.refused)) log("  task " + task.taskNo + ": clean refused: " + (rc.error || "refused"));
        }
      }
      if (task.op === "verify") {
        const b = byNo.get(task.taskNo - 1);
        if (!b || (b.state !== "built" && b.state !== "built-with-fallbacks")) {
          transition(states, task.taskNo, "skipped", { error: "its build task " + (task.taskNo - 1) + " is " + (b ? b.state : "missing") });
          save(states);
          continue;
        }
      }
      report = await o.post(task, opts);
    } catch (e) {
      const codes = {};
      if (isStall(e)) {
        count(codes, CODE.PLUGIN_STALLED);
        transition(states, task.taskNo, "failed", { codes, error: errText(e) });
        log("  task " + task.taskNo + " (" + task.op + "): " + CODE.PLUGIN_STALLED + " — the run stops; run again to resume");
        skipRest(task.taskNo);
        save(states);
        stopped = "stalled";
        break;
      }
      count(codes, CODE.BUILD_FAILED);
      transition(states, task.taskNo, "failed", { codes, error: errText(e) });
      log("  task " + task.taskNo + " (" + task.op + "): " + CODE.BUILD_FAILED + ": " + String((e && e.message) || e).split("\n")[0]);
      save(states);
      continue;
    }
    if (o.onReport) o.onReport(task, report);
    if (!report || report.error || report.refused) {
      const codes = {};
      count(codes, CODE.BUILD_FAILED);
      transition(states, task.taskNo, "failed", { codes, error: String((report && report.error) || "the plugin refused the task or sent no report") });
      log("  task " + task.taskNo + " (" + task.op + "): " + CODE.BUILD_FAILED);
      save(states);
      continue;
    }
    if (task.op === "fonts") {
      const missing = Array.isArray(report.missing) ? report.missing : [];
      states.fonts = { missing };
      const codes = {};
      if (missing.length) count(states.balance.planCodes || (states.balance.planCodes = {}), CODE.FONT_MISSING, missing.length);
      if (missing.length) count(codes, CODE.FONT_MISSING, missing.length);
      transition(states, task.taskNo, "built", { codes, ms: report.ms || {} });
      save(states);
      if (missing.length && o.missingFonts !== "substitute" && !o.yes) {
        log("  " + missing.length + " font" + (missing.length === 1 ? " is" : "s are") + " missing in Figma (" + CODE.FONT_MISSING + "): install, restart Figma, run again — or pass --missing-fonts substitute");
        stopped = "fonts";
        break;
      }
      continue;
    }
    if (task.op === "build") {
      const out = buildOutcome(report);
      transition(states, task.taskNo, out.state, { codes: out.codes, ms: out.ms, failures: out.failures });
      builds.set(task.taskNo, report);
      save(states);
      continue;
    }
    if (task.op === "verify") {
      const codes = {};
      const lost = (report.roots || []).filter((r) => !r.found).length;
      if (lost) count(codes, CODE.ROOT_NOT_FOUND, lost);
      const build = builds.has(task.taskNo - 1) ? builds.get(task.taskNo - 1) : null;
      const J = o.judge ? o.judge({ task, build, verify: report }) : null;
      if (J) Js.push(Object.assign({ taskNo: task.taskNo }, { J }));
      transition(states, task.taskNo, "built", { codes, ms: report.ms || {} });
      save(states);
      continue;
    }
    transition(states, task.taskNo, "built", {});
    save(states);
  }
  return { stopped, Js };
}
