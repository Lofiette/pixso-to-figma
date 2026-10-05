// M1's verdict: a table of gates (docs/M1.md §8.1), the numbers of §8.3, and time per phase.
//
//   import { m1Verdict, m1Gates, totalsOf } from "./ir/verdict.mjs";
//   const totals = totalsOf(Js);                         // part C's judgeRun, or the same sum by the frozen shape
//   const lines = m1Verdict(totals, states, { audit });  // the printed table, settings, probes and verdict
//   const { gates, verdict } = m1Gates(totals, states, { audit });
//
// totals   judgeRun's result (TOTALS_SHAPE of tools/ir/judge.mjs), or null when nothing was judged
// states   states.json v2 (tools/ir/runstate.mjs)
// audit    null, or { format: "pix2fig.audit", version: 1, roots: [{ i, ok }] }: a render audit made by
//          hand with the M0 tooling (§10); PASS needs one that covers every built root, all ok
//
// Any FAIL gate makes the verdict FAIL with the gate names. Without one, the best outcome without a
// covering audit is BUILT, NOT VISUALLY AUDITED with the placeholder, IMAGE_PLACEHOLDER,
// FILTER_UNRENDERED, FONT_SUBSTITUTED, BOOLEAN_FLATTENED, MASK_UNSUPPORTED and excused-vector counts.
// The verdict never reads PASS otherwise. While a gating probe is pending it adds "creation order not
// frozen".
import { CODE } from "./schema.mjs";
import * as judge from "./judge.mjs";

export const GATES = [["G1", "tasks"], ["G2", "roots"], ["G3", "count"], ["G4", "balance"], ["G5", "build failures"],
  ["G6", "position"], ["G7", "size"], ["G8", "side strokes"], ["G9", "vectors"], ["G10", "text lines"], ["G11", "placeholders"],
  ["G12", "time"]];
export const AUDIT_FORMAT = "pix2fig.audit";
export const BUILT_NOT_AUDITED = "BUILT, NOT VISUALLY AUDITED";
const COUNTED = [CODE.IMAGE_PLACEHOLDER, CODE.FILTER_UNRENDERED, CODE.FONT_SUBSTITUTED, CODE.BOOLEAN_FLATTENED, CODE.MASK_UNSUPPORTED];

// judgeRun's contract, by the frozen shape alone (numbers summed, maps added, lists concatenated,
// geometry.worst re-sorted by its largest delta and cut to 30, count.ok only when every task's is).
// Used while part C's judge is not in this build; part C's judgeRun is used once it is.
export function sumJs(Js) {
  const T = judge.emptyTotals();
  T.count.ok = true;
  for (const J of Js) {
    const bad = judge.checkJShape(J);
    if (bad.length) throw new TypeError("sumJs: a J is not of the frozen shape: " + bad.slice(0, 3).join("; "));
  }
  const addAll = (dst, src, shape) => {
    for (const k of Object.keys(shape)) {
      const s = shape[k];
      if (s === "n") dst[k] += src[k];
      else if (s === "b") dst[k] = dst[k] && src[k];
      else if (s === "[]") dst[k] = dst[k].concat(src[k]);
      else if (s === "{n}") for (const q of Object.keys(src[k])) dst[k][q] = (dst[k][q] || 0) + src[k][q];
      else addAll(dst[k], src[k], s);
    }
  };
  for (const J of Js) { addAll(T, J, judge.J_SHAPE); T.tasks++; }
  const big = (w) => Math.max(Math.abs(w.dx), Math.abs(w.dy), Math.abs(w.dw), Math.abs(w.dh));
  T.geometry.worst = T.geometry.worst.slice().sort((a, b) => big(b) - big(a)).slice(0, 30);
  T.geometry.maxSizeVisible = Js.reduce((m, J) => Math.max(m, J.geometry.maxSizeVisible), 0);
  return T;
}

export function totalsOf(Js) {
  if (!Js || !Js.length) return null;
  return judge.JUDGE_IMPLEMENTED ? judge.judgeRun(Js) : sumJs(Js);
}

const sum = (m) => Object.values(m || {}).reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
function taskCodes(states, op) {
  const out = {};
  for (const t of states.tasks || []) if (!op || t.op === op) for (const k of Object.keys(t.codes || {})) out[k] = (out[k] || 0) + t.codes[k];
  return out;
}

export function m1Gates(totals, states, opts) {
  const audit = opts && opts.audit;
  const T = states.tasks || [];
  const done = (t) => t.state === "built" || t.state === "built-with-fallbacks";
  const gates = [];
  const gate = (id, fail, detail) => gates.push({ id, name: GATES.find((g) => g[0] === id)[1], fail: !!fail, detail });
  const J = totals;
  const noJ = "nothing was judged (no verify task reached the judge)";

  const notDone = T.filter((t) => !done(t));
  gate("G1", notDone.length, notDone.length ? notDone.length + " of " + T.length + " tasks not built: " +
    ["failed", "skipped", "pending"].map((s) => T.filter((t) => t.state === s).length + " " + s).join(", ") : T.length + " of " + T.length + " tasks built");

  const verifies = T.filter((t) => t.op === "verify");
  const lostRoots = verifies.reduce((s, t) => s + ((t.codes && t.codes[CODE.ROOT_NOT_FOUND]) || 0), 0);
  const unverified = verifies.filter((t) => !done(t)).length;
  gate("G2", lostRoots || unverified || !verifies.length, lostRoots + " roots not found (" + CODE.ROOT_NOT_FOUND + "), " + unverified + " of " + verifies.length + " verify tasks did not run");

  if (!J) gate("G3", true, noJ);
  else {
    const missing = verifies.length - J.tasks;
    gate("G3", !J.count.ok || J.count.expected !== J.count.built || missing !== 0,
      "expected " + J.count.expected + ", built " + J.count.built + " (non-instance " + J.count.nonInstance + ", placeholders " + J.count.placeholders + ")" +
      (missing ? "; " + missing + " verify tasks not judged" : ""));
  }

  const B = states.balance || {};
  const bal = [B.stored && B.stored.ok ? "stored adds up" : "stored does not add up" + (B.stored && B.stored.why ? " (" + B.stored.why + ")" : ""),
    B.nonInstance && B.nonInstance.ok ? "non-instance adds up" : "non-instance does not add up",
    B.instances && B.instances.ok ? "instances add up" : "instances do not add up"];
  gate("G4", !B.ok, bal.join(", "));

  const failures = T.reduce((s, t) => s + (t.failures || 0), 0);
  gate("G5", failures > 0, failures + " build failures");

  if (!J) { for (const id of ["G6", "G7", "G8", "G9", "G10", "G11"]) gate(id, true, noJ); }
  else {
    gate("G6", J.geometry.visibleOver1 > 0, J.geometry.visibleOver1 + " visible nodes off by more than 1 px (" + J.geometry.visibleOver05 + " over 0.5 px)");
    gate("G7", J.geometry.sizeVisibleOver1 > 0, J.geometry.sizeVisibleOver1 + " visible sizes off by more than 1 px (" + J.geometry.sizeVisibleOver05 + " over 0.5 px)");
    const sides = J.sides.mismatchIR.length + J.sides.mismatchOracle.length;
    gate("G8", sides > 0, J.sides.mismatchIR.length + " against the IR, " + J.sides.mismatchOracle.length + " against the oracle, of " + J.sides.checked + " checked");
    gate("G9", J.vectors.differs.length > 0, J.vectors.differs.length + " " + CODE.VECTOR_GEOMETRY_DIFFERS + " of " + J.vectors.checked + " checked");
    const unnamed = J.text.differ.filter((d) => typeof d.guid !== "string" || !d.guid).length;
    gate("G10", J.text.unmeasured > 0 || unnamed > 0, J.text.unmeasured + " texts with lines not measured, " + J.text.differ.length + " differ (" + unnamed + " not named)");
    const want = B.instances ? B.instances.placeholders : null;
    const deferred = taskCodes(states, "build")[CODE.INSTANCE_DEFERRED] || 0;
    gate("G11", want === null || J.placeholders.expected !== want || J.placeholders.aligned !== want || J.placeholders.misaligned.length > 0 || deferred !== want,
      J.placeholders.aligned + " aligned, " + J.placeholders.misaligned.length + " misaligned, of " + want + " INSTANCE records in scope; " + CODE.INSTANCE_DEFERRED + " " + deferred);
  }

  const builds = T.filter((t) => t.op === "build" && done(t));
  const noTime = builds.filter((t) => !t.ms || !Object.keys(t.ms).length || Object.values(t.ms).some((v) => !Number.isFinite(v))).length;
  gate("G12", noTime > 0 || !builds.length, (builds.length - noTime) + " of " + builds.length + " built tasks report time per phase");

  let auditLine = null, audited = false, auditFail = false;
  if (audit) {
    const roots = new Set();
    for (const t of T) if (t.op === "build") for (const i of t.roots) roots.add(i);
    const got = new Map(((audit && audit.roots) || []).map((r) => [r.i, r.ok === true]));
    const covered = [...roots].filter((i) => got.has(i)).length;
    const bad = [...roots].filter((i) => got.has(i) && !got.get(i)).length;
    const shapeOk = audit.format === AUDIT_FORMAT && audit.version === 1;
    auditFail = shapeOk && bad > 0;
    audited = shapeOk && covered === roots.size && bad === 0 && roots.size > 0;
    auditLine = shapeOk ? "audit: " + covered + " of " + roots.size + " built roots covered, " + bad + " failed" : "audit: not a " + AUDIT_FORMAT + " version 1 report; ignored";
  }

  const failed = gates.filter((g) => g.fail).map((g) => g.id + " " + g.name);
  if (auditFail) failed.push("audit");
  const read = taskCodes(states, "build");
  const counts = { placeholders: B.instances ? B.instances.placeholders : 0 };
  for (const c of COUNTED) counts[c] = (read[c] || 0) + ((B.notes && B.notes[c]) || 0);
  counts.excusedVectors = J ? sum(J.vectors.excused) : 0;
  let verdict;
  if (failed.length) verdict = "FAIL (" + failed.join(", ") + ")";
  else if (audited) verdict = "PASS";
  else verdict = BUILT_NOT_AUDITED + ": placeholders " + counts.placeholders + ", " + COUNTED.map((c) => c + " " + counts[c]).join(", ") + ", excused vectors " + counts.excusedVectors;
  const pending = Object.keys(states.probes || {}).filter((k) => states.probes[k] === "pending");
  return { gates, verdict, failed, counts, auditLine, pending };
}

export function m1Verdict(totals, states, opts) {
  const g = m1Gates(totals, states, opts);
  const lines = ["gate                    result  measured"];
  for (const x of g.gates) lines.push((x.id + " " + x.name).padEnd(24) + (x.fail ? "FAIL    " : "ok      ") + x.detail);
  if (g.auditLine) lines.push(g.auditLine);
  lines.push("settings: " + JSON.stringify(states.settings || {}));
  lines.push("probes: " + Object.keys(states.probes || {}).map((k) => k + " " + states.probes[k]).join(", "));
  lines.push("VERDICT: " + g.verdict + (g.pending.length ? "; creation order not frozen (pending: " + g.pending.join(", ") + ")" : ""));
  return lines;
}

// Every number of docs/M1.md §8.3, one line per J section (names never: those go to the private file).
export function numberLines(J) {
  if (!J) return ["judge: nothing was judged"];
  const m = (o) => Object.keys(o).length ? Object.keys(o).sort().map((k) => k + " " + o[k]).join(", ") : "none";
  return [
    "count: expected " + J.count.expected + ", built " + J.count.built + ", non-instance " + J.count.nonInstance + ", placeholders " + J.count.placeholders + ", ok " + J.count.ok + " (" + J.tasks + " tasks)",
    "geometry: visible " + J.geometry.visible + ", over 0.5 px " + J.geometry.visibleOver05 + ", over 1 px " + J.geometry.visibleOver1 + ", hidden over 0.5 px " + J.geometry.hiddenOver05 +
      "; size over 0.5 px " + J.geometry.sizeVisibleOver05 + ", over 1 px " + J.geometry.sizeVisibleOver1 + ", max " + J.geometry.maxSizeVisible + ", hidden over 0.5 px " + J.geometry.sizeHiddenOver05 +
      "; classified: " + m(J.geometry.classified) + "; worst listed " + J.geometry.worst.length,
    "sides: checked " + J.sides.checked + ", against the oracle " + J.sides.checkedAgainstOracle + ", mismatch IR " + J.sides.mismatchIR.length + ", mismatch oracle " + J.sides.mismatchOracle.length +
      ", unproven " + J.sides.unproven + ", lost border population " + J.sides.lostBorder.population + ", ok " + J.sides.lostBorder.ok,
    "vectors: checked " + J.vectors.checked + ", match " + J.vectors.match + ", regrouped " + J.vectors.regrouped + ", excused: " + m(J.vectors.excused) +
      "; built from the oracle and differing: " + m(J.vectors.excusedBuiltFromOracle) + "; differs " + J.vectors.differs.length,
    "text: checked " + J.text.checked + ", differ " + J.text.differ.length + " (widened " + J.text.differ.filter((d) => d.widened).length + ", font-held " + J.text.differ.filter((d) => d.fontHeld).length +
      ", approximate " + J.text.differ.filter((d) => d.approx).length + "), unmeasured " + J.text.unmeasured + ", unknown " + J.text.unknown,
    "placeholders: expected " + J.placeholders.expected + ", aligned " + J.placeholders.aligned + ", misaligned " + J.placeholders.misaligned.length,
    "codes: " + m(J.codes),
  ];
}

// Build time per phase, summed over the build tasks, and per 1 000 records in scope (an INSTANCE
// counts 1), with the reader's own times (stats.ms: unzip, zstd, kiwi, ir) beside them.
export function timeLines(states, stats, nodesInScope) {
  const ms = {};
  for (const t of states.tasks || []) if (t.op === "build") for (const k of Object.keys(t.ms || {})) if (Number.isFinite(t.ms[k])) ms[k] = (ms[k] || 0) + t.ms[k];
  const total = sum(ms);
  const per = (v) => (nodesInScope ? ((v / nodesInScope) * 1000 / 1000).toFixed(3) + " s" : "n/a");
  const lines = ["build time: " + (total / 1000).toFixed(2) + " s for " + nodesInScope + " records in scope, " + per(total) + " per 1 000 (pre-M0 3.8 s, M0 4.0 s)"];
  for (const k of Object.keys(ms)) lines.push("  " + k.padEnd(12) + String(ms[k]).padStart(9) + " ms  " + per(ms[k]) + " per 1 000");
  const r = (stats && stats.ms) || null;
  lines.push("reader: " + (r ? ["unzip", "zstd", "kiwi", "ir"].map((k) => k + " " + (Number.isFinite(r[k]) ? r[k] + " ms" : "n/a")).join(", ") : "no reader times (stats.ms)"));
  return lines;
}
