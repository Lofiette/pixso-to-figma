// M2a's acceptance: the gates of docs/M2A.md §8, read from one or more run folders.
//
//   node tools/m2a-accept.mjs <runDir>… [--expect <private json>] [--twice]
//
// <runDir> is a folder tools/pix-run.mjs wrote (ir.json, stats.json, plan.json, run.json; --dry is
// enough). For each one it prints every gate, G1-G10, with its verdict, its numbers and the source it
// read: "stats" (the reader's counters, stats.json's m2a block: the IR holds only live entries and only
// roots, so it cannot show what the reader dropped), "IR" (ir.json), or both, each cross-checked
// against the other. Beneath the gates it prints what docs/M2A.md §8 lists as never gating. Everything
// printed is a count or a Pixso or Figma field name; no layer name, text, key or guid.
//
// --expect: the owner's per-file numbers, from a file outside the repository (assertOutsideRepo),
// because a file's label cannot be derived from the file without naming it:
//   { "format": "pix2fig.m2a-expect", "version": 1,
//     "files": { "<the .pix's sha256>": { "label": "D", "numbers": { "G4.noDefinition": 124, "G4.otherFamily": 6, … } } } }
// Every number named is compared with the gate's metric of that name (METRICS below), and a difference
// fails that gate. Gate G4 is gated only through it (docs/M2A.md §8): without an expectation for the
// file it prints its numbers and reads n/a.
// --twice (G8): re-reads the .pix the run folder's run.json names, with the reader settings the IR's
// header records, and compares the SHA-256 of the new IR's bytes with ir.json's. Without it G8 reads n/a.
//
// Gate verdicts are PASS, FAIL or n/a (not asked: G4 without --expect, G8 without --twice). Exit code:
// 0 when no gate of any run folder FAILs, 3 when one does, 1 when a run folder or the --expect file
// cannot be read (or a usage error).
//
// The definitions (docs/M2A.md §0.2, D1) the counters follow, and so the balances below:
//   instances.instances = the IR's INSTANCE records (the population of §8: the carried instances)
//   overrides.entries  = root ([symbolID] paths) + emptyPath ([] paths, D only) + nonRoot   (§1.3's row)
//   overrides.nonRoot  = live + Σ stale[class]
//   overrides.live     = distinctLivePaths + mergedAway
//   distinctLivePaths  = written (non-root overrides in the IR) + emptyAfterTranslation
//   pixsoFields.total  = translated + consumed + Σ dropped[class][field]; dropped.unknown is empty
//   fields.produced    = carried + Σ echo[field] under --echo drop; = carried under --echo keep (the
//                        echo fields are carried and counted, D9)
//   assignments.total  = kept + droppedWithEntry + merged + dangling + defaultDropped + Σ stale[class]
//                        (D6: each assignment in exactly one class); dangling = swapDangling.assignment
//   bindings.total     = kept + Σ dropped[class] (D4)
//   derived.entries    = resolved + unresolved = written + empty (D10), unresolved 0 (rules A, B, C)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertOutsideRepo } from "./ir/outside-repo.mjs";
import { CODE, M2A_SETTINGS, NOTE_CLASSES, PROPERTY_REF_FIELDS, PROPERTY_TYPES, VERSION } from "./ir/schema.mjs";
import { validate } from "./ir/validate.mjs";

export const EXPECT_FORMAT = "pix2fig.m2a-expect";
export const GATE_IDS = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"];
export const GATE_NAMES = { G1: "derived", G2: "live ⇔ derived", G3: "families", G4: "stale assignments", G5: "property types",
  G6: "override balances", G7: "assignment and binding balances", G8: "determinism", G9: "M1 unchanged", G10: "validity" };
// The numbers each gate computes, by name; an --expect file names them as "<gate>.<metric>".
export const METRICS = {
  G1: ["entries", "resolved", "viaFallback", "unresolved", "written", "empty"],
  G2: ["nonRoot", "live", "stale", "resolvedNotDerived", "inDerivedUnresolved"],
  G3: ["groups", "accepted", "rejected", "rejectedMembers"],
  G4: ["noDefinition", "otherFamily", "onInstances", "noRoot", "undeclared", "nested", "ignored"],
  G5: ["declaredNotRoot", "declared", "bindingsKept", "typeMismatch"],
  G6: ["instances", "entries", "root", "emptyPath", "written", "pixsoFields", "unknown", "produced", "carried", "echo"],
  G7: ["assignments", "assignmentsKept", "bindings", "bindingsKept"],
  G8: [],
  G9: ["records"],
  G10: ["errors"],
};
// The commit that can resume a run folder of IR version 2 (the M1 close-out; docs/M2A.md §6 D).
export const M1_COMMIT = "cfa3e65";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const optJson = (p) => (existsSync(p) ? readJson(p) : null);
const sum = (o) => Object.values(o || {}).reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
const sum2 = (o) => Object.values(o || {}).reduce((s, m) => s + sum(m), 0);
// 35808 -> "35 808", as docs/M2A.md writes its numbers.
export const fmt = (n) => (Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") : String(n));
const classOf = (detail) => String(detail || "").split(":")[0].trim();
const list = (o) => Object.keys(o || {}).filter((k) => o[k]).map((k) => k + " " + fmt(o[k])).join(", ") || "none";

// What the IR itself holds that a gate cross-checks with the counters.
export function irCounts(ir) {
  const N = ir.nodes || [];
  const c = { records: N.length, componentSets: 0, sets: (ir.sets || []).length, instances: 0, assignments: 0, bindings: 0,
    overridesNonRoot: 0, overridesRoot: 0, derived: 0, rejectedNotes: {}, rejectedMembers: 0, notStandalone: 0, declared: 0,
    badDeclaredType: 0, bindingTypeMismatch: 0, bindingNoDefinition: 0 };
  const comp = new Map();
  for (const e of ir.components || []) comp.set(e.node, e);
  const familyGuidOf = (ci) => { const e = comp.get(ci); if (!e) return null; return e.set === null || e.set === undefined ? N[ci].guid : (ir.sets[e.set] && N[ir.sets[e.set].node] ? N[ir.sets[e.set].node].guid : null); };
  const defs = new Map();   // family guid -> Map(id -> definition)
  const declare = (guid, props) => {
    const m = defs.get(guid) || new Map();
    for (const d of props || []) { m.set(d.id, d); c.declared++; if (PROPERTY_TYPES.indexOf(d.type) < 0) c.badDeclaredType++; }
    defs.set(guid, m);
  };
  for (const s of ir.sets || []) if (N[s.node]) declare(N[s.node].guid, s.properties);
  for (const e of ir.components || []) if (N[e.node]) declare(N[e.node].guid, e.properties);
  // The COMPONENT record a layer sits in (itself, for a component's own binding), or -1.
  const enclosing = (i) => { let k = i; while (k >= 0 && N[k] && N[k].type !== "COMPONENT") k = N[k].parent; return k >= 0 && N[k] ? k : -1; };
  N.forEach((r, i) => {
    if (r.type === "COMPONENT_SET") c.componentSets++;
    const refs = r.props && r.props.componentPropertyReferences;
    if (refs && typeof refs === "object") for (const f of Object.keys(refs)) {
      c.bindings++;
      const ci = enclosing(i);
      const fam = ci >= 0 ? familyGuidOf(ci) : null;
      const d = fam && defs.get(fam) ? defs.get(fam).get(refs[f]) : null;
      if (!d) c.bindingNoDefinition++;
      else if (PROPERTY_REF_FIELDS[f] !== d.type) c.bindingTypeMismatch++;
    }
    if (r.type === "INSTANCE") c.instances++;
    if (r.type !== "INSTANCE" || !r.instance) return;
    c.assignments += (r.instance.properties || []).length;
    for (const o of r.instance.overrides || []) {
      if (Array.isArray(o.path) && o.path.length) { c.overridesNonRoot++; c.assignments += (o.properties || []).length; }
      else c.overridesRoot++;
    }
    c.derived += (r.instance.derived || []).length;
  });
  for (const nt of ir.notes || []) {
    if (nt.code !== CODE.VARIANT_SET_REJECTED) continue;
    const k = classOf(nt.detail);
    c.rejectedNotes[k] = (c.rejectedNotes[k] || 0) + 1;
    N.forEach((r, i) => {
      if (r.parent !== nt.node || r.type !== "COMPONENT") return;
      c.rejectedMembers++;
      const e = comp.get(i);
      if (!e || (e.set !== null && e.set !== undefined)) c.notStandalone++;
    });
  }
  return c;
}

// One gate's evaluation: { id, name, status, source, line, why[], metrics }.
function gate(id, source) {
  const g = { id, name: GATE_NAMES[id], status: "PASS", source, line: "", why: [], metrics: {} };
  g.fail = (m) => { g.status = "FAIL"; g.why.push(m); };
  g.need = (cond, m) => { if (!cond) g.fail(m); };
  return g;
}

// The gates of docs/M2A.md §8 for one IR and its stats.
//   ctx: { balance: the M1 balance (plan.json's, or planM1's), twice: { status, line, why } | null,
//          expect: { label, numbers } | null }
export function m2aGates(ir, stats, ctx) {
  const x = ctx || {};
  const M = stats && stats.m2a;
  const settings = (ir && ir.header && ir.header.settings) || {};
  const ic = irCounts(ir);
  const gates = [];
  // A counter the gate reads: a missing one fails the gate that reads it (never read as 0).
  const reader = (g) => (path) => {
    let v = M;
    for (const k of path.split(".")) v = v && typeof v === "object" ? v[k] : undefined;
    if (v === undefined || v === null) { g.fail("stats.m2a." + path + " is missing"); return NaN; }
    if (typeof v === "object") return v;
    if (!Number.isFinite(v)) { g.fail("stats.m2a." + path + " is not a number"); return NaN; }
    return v;
  };
  const noStats = (g) => { if (!M) { g.fail("stats.json has no m2a block (" + (stats ? "an IR version 2 reader's stats" : "no stats.json") + ")"); return true; } return false; };

  // G1 derived (stats; IR for the entries written)
  {
    const g = gate("G1", "stats, IR"); const s = reader(g);
    if (!noStats(g)) {
      const D = { entries: s("derived.entries"), resolved: s("derived.resolved"), viaFallback: s("derived.viaFallback"), unresolved: s("derived.unresolved"),
        written: s("derived.written"), empty: s("derived.empty") };
      g.metrics = D;
      g.need(D.unresolved === 0, fmt(D.unresolved) + " derived entries do not resolve (rule C included)");
      g.need(D.resolved + D.unresolved === D.entries, "resolved " + fmt(D.resolved) + " + unresolved " + fmt(D.unresolved) + " ≠ entries " + fmt(D.entries));
      g.need(D.resolved === D.entries, "resolved " + fmt(D.resolved) + " ≠ entries " + fmt(D.entries));
      g.need(D.entries === D.written + D.empty, "entries " + fmt(D.entries) + " ≠ written " + fmt(D.written) + " + empty " + fmt(D.empty));
      g.need(D.viaFallback <= D.resolved, "via rule C " + fmt(D.viaFallback) + " > resolved " + fmt(D.resolved));
      g.need(D.written === ic.derived, "written " + fmt(D.written) + " ≠ the IR's derived entries " + fmt(ic.derived));
      g.line = fmt(D.resolved) + " / " + fmt(D.entries) + " resolve" + (D.viaFallback ? " (" + fmt(D.viaFallback) + " via rule C)" : "") + "; written " + fmt(D.written) + " + empty " + fmt(D.empty);
    }
    gates.push(g);
  }
  // G2 live ⇔ derived (stats)
  {
    const g = gate("G2", "stats"); const s = reader(g);
    if (!noStats(g)) {
      const stale = s("overrides.stale");
      const m = { nonRoot: s("overrides.nonRoot"), live: s("overrides.live"), stale: sum(stale), resolvedNotDerived: s("overrides.resolvedNotDerived"),
        inDerivedUnresolved: s("overrides.inDerivedUnresolved") };
      g.metrics = m;
      g.need(m.resolvedNotDerived === 0, fmt(m.resolvedNotDerived) + " stale entries resolve (resolvedNotDerived)");
      g.need(m.inDerivedUnresolved === 0, fmt(m.inDerivedUnresolved) + " entries in derived do not resolve (inDerivedUnresolved)");
      g.line = "live / stale " + fmt(m.live) + " / " + fmt(m.stale) + " of " + fmt(m.nonRoot) + " non-root (stale: " + list(stale) + ")";
    }
    gates.push(g);
  }
  // G3 families (stats, IR)
  {
    const g = gate("G3", "stats, IR"); const s = reader(g);
    if (!noStats(g)) {
      const rej = s("families.rejected");
      const m = { groups: s("families.groups"), accepted: s("families.accepted"), rejected: sum(rej), rejectedMembers: s("families.rejectedMembers") };
      g.metrics = m;
      if (settings.variantSets === "frames") {
        g.need(m.accepted === 0 && m.rejected === 0, "--variant-sets frames, yet " + fmt(m.accepted) + " accepted and " + fmt(m.rejected) + " rejected");
        g.need(ic.sets === 0 && ic.componentSets === 0, "--variant-sets frames, yet the IR holds " + fmt(ic.sets) + " sets and " + fmt(ic.componentSets) + " COMPONENT_SET records");
        g.need(sum(ic.rejectedNotes) === 0, "--variant-sets frames, yet the IR holds " + fmt(sum(ic.rejectedNotes)) + " " + CODE.VARIANT_SET_REJECTED + " notes");
        g.line = "--variant-sets frames (M1's D7): " + fmt(m.groups) + " state groups, all frames";
      } else {
        g.need(m.accepted + m.rejected === m.groups, "accepted " + fmt(m.accepted) + " + rejected " + fmt(m.rejected) + " ≠ state groups " + fmt(m.groups));
        g.need(ic.sets === m.accepted && ic.componentSets === m.accepted, "accepted " + fmt(m.accepted) + ", but the IR holds " + fmt(ic.sets) + " sets and " + fmt(ic.componentSets) + " COMPONENT_SET records");
        const classes = NOTE_CLASSES.VARIANT_SET_REJECTED;
        const off = classes.filter((k) => (ic.rejectedNotes[k] || 0) !== (rej[k] || 0)).concat(Object.keys(ic.rejectedNotes).filter((k) => classes.indexOf(k) < 0));
        g.need(!off.length, "rejected by class differ between stats and the IR's notes: " + off.map((k) => k + " " + fmt(rej[k] || 0) + " vs " + fmt(ic.rejectedNotes[k] || 0)).join(", "));
        g.need(ic.notStandalone === 0, fmt(ic.notStandalone) + " members of rejected sets are not standalone components");
        g.need(ic.rejectedMembers === m.rejectedMembers, "members of rejected sets: stats " + fmt(m.rejectedMembers) + ", the IR " + fmt(ic.rejectedMembers));
        g.line = fmt(m.accepted) + " / " + fmt(m.groups) + " accepted; rejected " + fmt(m.rejected) + " (" + list(rej) + "), " + fmt(m.rejectedMembers) + " members standalone";
      }
    }
    gates.push(g);
  }
  // G4 stale assignments (stats; gated through --expect)
  {
    const g = gate("G4", "stats"); const s = reader(g);
    if (!noStats(g)) {
      const st = s("properties.assignments.stale");
      const v = (k) => (st && Number.isFinite(st[k]) ? st[k] : (g.fail("stats.m2a.properties.assignments.stale." + k + " is missing"), NaN));
      const m = { noDefinition: v("no-definition"), otherFamily: v("other-family"), noRoot: v("no-root"), undeclared: v("undeclared"), nested: v("nested"), ignored: v("ignored") };
      m.onInstances = m.noDefinition + m.otherFamily;
      g.metrics = m;
      g.line = fmt(m.onInstances) + " (" + fmt(m.noDefinition) + " + " + fmt(m.otherFamily) + "), nested " + fmt(m.nested) + "; no-root " + fmt(m.noRoot) +
        ", undeclared " + fmt(m.undeclared) + ", ignored " + fmt(m.ignored);
      if (!(x.expect && x.expect.numbers && Object.keys(x.expect.numbers).some((k) => k.indexOf("G4.") === 0)) && g.status === "PASS") { g.status = "n/a"; g.why.push("no --expect for this file: printed, not gated"); }
    }
    gates.push(g);
  }
  // G5 property types (stats; IR for the declared types and the kept bindings)
  {
    const g = gate("G5", "stats, IR"); const s = reader(g);
    if (!noStats(g)) {
      const m = { declaredNotRoot: s("properties.declaredNotRoot"), declared: ic.declared, bindingsKept: ic.bindings, typeMismatch: (s("properties.bindings.dropped") || {})["type-mismatch"] };
      g.metrics = m;
      g.need(m.declaredNotRoot === 0, fmt(m.declaredNotRoot) + " declared ids are not roots of their scope (declaredNotRoot)");
      g.need(ic.badDeclaredType === 0, fmt(ic.badDeclaredType) + " declared definitions have a type outside " + PROPERTY_TYPES.join(", "));
      g.need(ic.bindingTypeMismatch === 0, fmt(ic.bindingTypeMismatch) + " kept bindings bind a field of another type than their definition's");
      g.need(ic.bindingNoDefinition === 0, fmt(ic.bindingNoDefinition) + " kept bindings name no definition of their component's family");
      g.line = fmt(m.declared) + " roots declared, " + fmt(m.bindingsKept) + " bindings kept, each of its root's type; " + fmt(m.typeMismatch) + " dropped type-mismatch";
    }
    gates.push(g);
  }
  // G6 override balances (stats; IR for the overrides written)
  {
    const g = gate("G6", "stats, IR"); const s = reader(g);
    if (!noStats(g)) {
      const O = { entries: s("overrides.entries"), root: s("overrides.root"), emptyPath: s("overrides.emptyPath"), nonRoot: s("overrides.nonRoot"),
        live: s("overrides.live"), stale: sum(s("overrides.stale")), distinct: s("overrides.distinctLivePaths"), mergedAway: s("overrides.mergedAway"),
        written: s("overrides.written"), emptyAfter: s("overrides.emptyAfterTranslation") };
      const PF = { total: s("overrides.pixsoFields.total"), translated: s("overrides.pixsoFields.translated"), consumed: s("overrides.pixsoFields.consumed"),
        dropped: s("overrides.pixsoFields.dropped") };
      const F = { produced: s("overrides.fields.produced"), carried: s("overrides.fields.carried"), echo: sum(s("overrides.fields.echo")) };
      const unknown = (PF.dropped && PF.dropped.unknown) || {};
      const carried = s("instances.instances");
      g.metrics = { instances: carried, entries: O.entries, root: O.root, emptyPath: O.emptyPath, written: O.written, pixsoFields: PF.total, unknown: sum(unknown),
        produced: F.produced, carried: F.carried, echo: F.echo };
      // The population is the carried INSTANCE records (docs/M2A.md §8): counters for fewer would let
      // every balance below add up over instances nobody looked at.
      g.need(carried === ic.instances, "the counters cover " + fmt(carried) + " carried instances; the IR holds " + fmt(ic.instances) + " INSTANCE records");
      g.need(O.entries === O.root + O.emptyPath + O.nonRoot, "entries " + fmt(O.entries) + " ≠ root " + fmt(O.root) + " + empty path " + fmt(O.emptyPath) + " + non-root " + fmt(O.nonRoot));
      g.need(O.nonRoot === O.live + O.stale, "non-root " + fmt(O.nonRoot) + " ≠ live " + fmt(O.live) + " + stale " + fmt(O.stale));
      g.need(O.live === O.distinct + O.mergedAway, "live " + fmt(O.live) + " ≠ distinct live paths " + fmt(O.distinct) + " + merged away " + fmt(O.mergedAway));
      g.need(O.distinct === O.written + O.emptyAfter, "distinct live paths " + fmt(O.distinct) + " ≠ written " + fmt(O.written) + " + empty after translation and echo " + fmt(O.emptyAfter));
      g.need(O.written === ic.overridesNonRoot, "written " + fmt(O.written) + " ≠ the IR's non-root overrides " + fmt(ic.overridesNonRoot));
      const dropped = sum2(PF.dropped);
      g.need(PF.total === PF.translated + PF.consumed + dropped, "Pixso fields " + fmt(PF.total) + " ≠ translated " + fmt(PF.translated) + " + consumed " + fmt(PF.consumed) + " + dropped " + fmt(dropped));
      g.need(!sum(unknown), "fields outside OVERRIDE_SOURCE_FIELDS (unknown): " + list(unknown));
      const keep = settings.echo === "keep";
      g.need(keep ? F.produced === F.carried : F.produced === F.carried + F.echo,
        "Figma fields produced " + fmt(F.produced) + " ≠ carried " + fmt(F.carried) + (keep ? " (--echo keep carries the echoes)" : " + echo " + fmt(F.echo)));
      g.line = "entries " + fmt(O.entries) + " = root " + fmt(O.root) + " + empty path " + fmt(O.emptyPath) + " + live " + fmt(O.live) + " + stale " + fmt(O.stale) +
        "; live = " + fmt(O.distinct) + " paths + " + fmt(O.mergedAway) + " merged away; paths = " + fmt(O.written) + " written + " + fmt(O.emptyAfter) +
        " empty; Pixso fields " + fmt(PF.total) + " = " + fmt(PF.translated) + " + " + fmt(PF.consumed) + " + " + fmt(dropped) + "; Figma fields " + fmt(F.produced) +
        " = " + fmt(F.carried) + " carried" + (keep ? " (echo kept: " + fmt(F.echo) + ")" : " + " + fmt(F.echo) + " echo");
    }
    gates.push(g);
  }
  // G7 assignment and binding balances (stats; IR for the kept ones)
  {
    const g = gate("G7", "stats, IR"); const s = reader(g);
    if (!noStats(g)) {
      const A = { total: s("properties.assignments.total"), kept: s("properties.assignments.kept"), droppedWithEntry: s("properties.assignments.droppedWithEntry"),
        merged: s("properties.assignments.merged"), dangling: s("properties.assignments.dangling"), defaultDropped: s("properties.assignments.defaultDropped"),
        stale: sum(s("properties.assignments.stale")) };
      const swapDangling = s("properties.swapDangling.assignment");
      const B = { total: s("properties.bindings.total"), kept: s("properties.bindings.kept"), dropped: s("properties.bindings.dropped") };
      g.metrics = { assignments: A.total, assignmentsKept: A.kept, bindings: B.total, bindingsKept: B.kept };
      const cls = A.kept + A.droppedWithEntry + A.merged + A.dangling + A.defaultDropped + A.stale;
      g.need(A.total === cls, "assignments " + fmt(A.total) + " ≠ kept " + fmt(A.kept) + " + dropped with entry " + fmt(A.droppedWithEntry) + " + merged " + fmt(A.merged) +
        " + dangling " + fmt(A.dangling) + " + default " + fmt(A.defaultDropped) + " + stale " + fmt(A.stale) + " = " + fmt(cls));
      g.need(A.dangling === swapDangling, "dangling assignments " + fmt(A.dangling) + " ≠ SWAP_VALUE_DANGLING assignment " + fmt(swapDangling));
      g.need(settings.defaultAssignments !== "keep" || A.defaultDropped === 0, fmt(A.defaultDropped) + " assignments dropped as equal to the default under --default-assignments keep");
      g.need(A.kept === ic.assignments, "kept assignments " + fmt(A.kept) + " ≠ the IR's " + fmt(ic.assignments));
      g.need(B.total === B.kept + sum(B.dropped), "bindings " + fmt(B.total) + " ≠ kept " + fmt(B.kept) + " + dropped " + fmt(sum(B.dropped)));
      g.need(B.kept === ic.bindings, "kept bindings " + fmt(B.kept) + " ≠ the IR's componentPropertyReferences " + fmt(ic.bindings));
      g.line = "assignments " + fmt(A.total) + " = kept " + fmt(A.kept) + " + with entry " + fmt(A.droppedWithEntry) + " + merged " + fmt(A.merged) + " + dangling " +
        fmt(A.dangling) + " + default " + fmt(A.defaultDropped) + " + stale " + fmt(A.stale) + "; bindings " + fmt(B.total) + " = kept " + fmt(B.kept) +
        " + dropped (" + list(B.dropped) + ")";
    }
    gates.push(g);
  }
  // G8 determinism (IR; --twice)
  {
    const g = gate("G8", "IR");
    const t = x.twice;
    if (!t) { g.status = "n/a"; g.why.push("--twice not given"); g.line = "not run"; }
    else { g.status = t.status; g.line = t.line; for (const w of t.why || []) g.why.push(w); }
    gates.push(g);
  }
  // G9 M1 unchanged (stats: the M1 balance on IR v3)
  {
    const g = gate("G9", "stats");
    const B = x.balance;
    g.metrics = { records: ic.records };
    if (!B) g.fail("no M1 balance (plan.json missing and stats.json not at hand)");
    else {
      g.need(B.ok === true, "the M1 balance does not add up" + (B.stored && B.stored.why ? ": " + B.stored.why : ""));
      g.line = "M1 balance " + (B.ok ? "adds up" : "does NOT add up") + ": stored " + fmt(B.stored && B.stored.stored) + ", IR non-instance " +
        fmt(B.nonInstance && B.nonInstance.ir) + ", IR INSTANCE " + fmt(B.instances && B.instances.ir);
    }
    gates.push(g);
  }
  // G10 validity (IR)
  {
    const g = gate("G10", "IR");
    const v = validate(ir);
    g.metrics = { errors: v.errors.length };
    if (!v.ok) g.fail(v.errors.length + " validation errors: " + v.errors.slice(0, 3).map((e) => e.path + ": " + e.message).join("; "));
    g.line = v.ok ? "valid IR version " + (ir.header && ir.header.version) : "refused";
    gates.push(g);
  }
  // --expect: every number named is compared with its gate's metric.
  if (x.expect && x.expect.numbers) {
    for (const k of Object.keys(x.expect.numbers)) {
      const [id, name] = k.split(".");
      const g = gates.find((q) => q.id === id);
      if (!g) continue;
      const want = x.expect.numbers[k];
      const got = g.metrics[name];
      if (got !== want) g.fail("--expect " + k + " " + fmt(want) + ", got " + fmt(got));
    }
  }
  return gates;
}

// Refuses an --expect file inside the repository, or one of another shape. Returns its files map.
export function loadExpect(file) {
  assertOutsideRepo(resolve(file));
  const j = readJson(file);
  if (!j || j.format !== EXPECT_FORMAT || j.version !== 1 || !j.files || typeof j.files !== "object") throw new Error("--expect: not a " + EXPECT_FORMAT + " version 1 file");
  for (const sha of Object.keys(j.files)) {
    const f = j.files[sha];
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("--expect: files are keyed by the .pix's sha256 (64 lowercase hex)");
    if (!f || typeof f.label !== "string" || !f.numbers || typeof f.numbers !== "object") throw new Error("--expect: each file needs a label and numbers");
    for (const k of Object.keys(f.numbers)) {
      const [id, name] = k.split(".");
      if (!METRICS[id] || METRICS[id].indexOf(name) < 0) throw new Error("--expect: " + k + " names no gate metric (" + GATE_IDS.map((g) => METRICS[g].map((m) => g + "." + m).join(" ")).filter(Boolean).join(" ") + ")");
      if (!Number.isFinite(f.numbers[k])) throw new Error("--expect: " + k + " is not a number");
    }
  }
  return j.files;
}

// The reader settings an IR's header records, as pixToIR takes them.
export function readerSettingsOf(header) {
  const hs = header.settings || {};
  const s = { booleans: hs.booleans, spaceEvenlySingle: hs.spaceEvenlySingle, textFit: hs.textFit, mode: hs.mode,
    scope: header.scope && header.scope.kind === "pages" ? "pages:" + header.scope.ids.join(",") : "file" };
  for (const k of M2A_SETTINGS) s[k] = hs[k];
  return s;
}

// G8: re-read the .pix of run.json and compare the new IR's bytes with ir.json's, by SHA-256.
export async function twiceCheck(runDir, ir) {
  const run = optJson(join(runDir, "run.json"));
  const pixFile = run && run.pix;
  if (!pixFile) return { status: "n/a", line: "not run", why: ["run.json names no .pix (an IR given with --from-ir alone)"] };
  if (!existsSync(pixFile)) return { status: "FAIL", line: "the .pix is gone", why: ["the .pix run.json names is not there"] };
  const buffer = readFileSync(pixFile);
  const sha = createHash("sha256").update(buffer).digest("hex");
  if (sha !== ir.header.source.sha256) return { status: "FAIL", line: "the .pix changed", why: ["the .pix's sha256 is not the IR's: the file changed since the run"] };
  const { pixToIR } = await import(pathToFileURL(join(fileURLToPath(new URL(".", import.meta.url)), "pix", "ir", "index.mjs")).href);
  const again = JSON.stringify(pixToIR(buffer, { settings: readerSettingsOf(ir.header) }).ir);
  const h = (s) => createHash("sha256").update(s).digest("hex");
  const a = h(readFileSync(join(runDir, "ir.json"))), b = h(again);
  return a === b ? { status: "PASS", line: "two reads give the same IR bytes (SHA-256 equal)", why: [] }
    : { status: "FAIL", line: "two reads differ", why: ["ir.json and a second read of the .pix differ (SHA-256)"] };
}

// Printed beneath the gates, never gating (docs/M2A.md §8).
export function infoLines(ir, stats, irBytes) {
  const M = (stats && stats.m2a) || null;
  const L = [];
  if (!M) return ["(no stats.m2a: nothing more to print)"];
  const O = M.overrides || {}, P = M.properties || {}, D = M.derived || {}, I = M.instances || {}, F = M.families || {};
  const top = (o, n) => Object.keys(o || {}).sort((a, b) => o[b] - o[a] || (a < b ? -1 : 1)).slice(0, n).map((k) => k + " " + fmt(o[k])).join(", ") || "none";
  const fields = O.fields || {};
  L.push("echo fields: " + fmt(sum(fields.echo)) + (sum(fields.echo) ? " (" + top(fields.echo, 12) + ")" : ""));
  L.push("merged paths: " + fmt(O.merged && O.merged.paths) + ", conflicting fields " + fmt(O.merged && O.merged.conflicts) + " (--override-merge " + ir.header.settings.overrideMerge + ")");
  const dr = (O.pixsoFields && O.pixsoFields.dropped) || {};
  for (const k of Object.keys(dr)) if (sum(dr[k])) L.push("Pixso fields dropped, " + k + ": " + top(dr[k], 40));
  L.push("Figma fields by P13 class: " + list(fields.byClass));
  L.push("root box fields: echo " + fmt(O.rootBox && O.rootBox.echo) + ", differ (root-box) " + fmt(O.rootBox && O.rootBox.differs) + "; bound-field conflicts " + fmt(O.boundConflicts));
  L.push("swaps: " + list(O.swaps));
  L.push("swap defaults: from the layer " + fmt(P.swapDefaultFromLayer) + "; layers disagree on " + fmt(P.swapDefaultLayersDisagree && P.swapDefaultLayersDisagree.roots) + " roots (" +
    fmt(P.swapDefaultLayersDisagree && P.swapDefaultLayersDisagree.layers) + " layers); bound layers differing from the default: text " +
    fmt(P.boundLayerDiffers && P.boundLayerDiffers.text) + ", visible " + fmt(P.boundLayerDiffers && P.boundLayerDiffers.visible));
  L.push("properties: roots " + fmt(P.roots) + ", lifted member roots " + fmt(P.liftedMemberRoots) + ", copied " + fmt(P.copiedRoots) + ", aliases " + fmt(P.aliases) +
    ", via alias " + fmt(P.viaAlias) + ", unnamed roots " + fmt(P.unnamedRoots) + "; preferred: " + list(P.preferred) + "; swap dangling: " + list(P.swapDangling) +
    "; rich text flattened " + fmt(P.assignments && P.assignments.richTextFlattened));
  L.push("families: values appended " + fmt(F.valuesAppended) + ", axis order from the vocabulary " + fmt(F.vocabularyOrder) + ", from the names " + fmt(F.namesOrder));
  L.push("derived: written " + fmt(D.written) + ", empty " + fmt(D.empty) + ", without at " + fmt(D.noAt) + ", sparse (no transform " + fmt(D.noTransform) + ", no size " +
    fmt(D.noSize) + "), with lines " + fmt(D.withLines) + ", with oracle sides " + fmt(D.withOracleSides) + ", with geometry " + fmt(D.geometry));
  L.push("instances: " + list(I));
  if (Number.isFinite(irBytes)) L.push("IR size: " + fmt(irBytes) + " bytes");
  const ms = (stats && stats.ms) || {};
  const m2 = ms.m2a || {};
  L.push("reader time (ms): unzip " + fmt(ms.unzip) + ", zstd " + fmt(ms.zstd) + ", kiwi " + fmt(ms.kiwi) + ", ir " + fmt(ms.ir) + " (of which M2a: families " +
    fmt(m2.families) + ", props " + fmt(m2.props) + ", resolve " + fmt(m2.resolve) + ", instances " + fmt(m2.instances) + ")");
  return L;
}

export function gateLines(gates) {
  const out = [];
  for (const g of gates) {
    out.push((g.id + " " + g.name).padEnd(36) + (g.status === "n/a" ? "n/a " : g.status) + "  [" + g.source + "]  " + g.line);
    for (const w of g.why) out.push("      " + (g.status === "FAIL" ? "<- " : "") + w);
  }
  return out;
}

// One run folder: { lines, gates, failed: [gate ids] }.
export async function acceptRun(runDir, opts) {
  const o = opts || {};
  const irFile = join(runDir, "ir.json");
  if (!existsSync(irFile)) throw new Error("no ir.json in " + runDir);
  const ir = readJson(irFile);
  if (!ir.header || ir.header.version !== VERSION) {
    throw new Error("the run folder holds an IR of version " + (ir.header && ir.header.version) + "; m2a-accept reads version " + VERSION + " (a version 2 run is M1's: tools/m1-accept.mjs at " + M1_COMMIT + ")");
  }
  const stats = optJson(join(runDir, "stats.json"));
  const plan = optJson(join(runDir, "plan.json"));
  let balance = plan && plan.balance ? plan.balance : null;
  if (!balance && stats) { const { planM1 } = await import("./ir/plan.mjs"); balance = planM1(ir, stats, {}).balance; }
  const sha = ir.header.source.sha256;
  const expect = o.expect && o.expect[sha] ? o.expect[sha] : null;
  const twice = o.twice ? await twiceCheck(runDir, ir) : null;
  const gates = m2aGates(ir, stats, { balance, twice, expect });
  const lines = [];
  lines.push("M2a ACCEPTANCE  " + (expect ? "file " + expect.label : "unlabelled file" + (o.expect ? " (not in --expect)" : "")) +
    "  " + Object.keys(ir.header.settings).filter((k) => M2A_SETTINGS.indexOf(k) >= 0).map((k) => k + "=" + ir.header.settings[k]).join(" "));
  lines.push(...gateLines(gates));
  const failed = gates.filter((g) => g.status === "FAIL").map((g) => g.id);
  const na = gates.filter((g) => g.status === "n/a").map((g) => g.id);
  lines.push("VERDICT: " + (failed.length ? "FAIL (" + failed.join(", ") + ")" : "PASS") + (na.length ? "  (n/a: " + na.join(", ") + ")" : ""));
  lines.push("");
  let bytes = NaN;
  try { bytes = statSync(irFile).size; } catch (e) { /* printed as unknown */ }
  lines.push(...infoLines(ir, stats, bytes));
  return { lines, gates, failed, label: expect ? expect.label : null };
}

export async function main(argv) {
  const a = argv.slice();
  let expectFile = null, twice = false;
  const dirs = [];
  for (let k = 0; k < a.length; k++) {
    if (a[k] === "--expect") { expectFile = a[++k]; if (!expectFile) { console.log("m2a-accept: --expect needs a file"); return 1; } }
    else if (a[k] === "--twice") twice = true;
    else if (a[k].startsWith("--")) { console.log("m2a-accept: unknown option " + a[k]); return 1; }
    else dirs.push(a[k]);
  }
  if (!dirs.length) { console.log("usage: node tools/m2a-accept.mjs <runDir>… [--expect <private json outside the repository>] [--twice]"); return 1; }
  let expect = null;
  if (expectFile) { try { expect = loadExpect(expectFile); } catch (e) { console.log("m2a-accept: " + e.message); return 1; } }
  const summary = [];
  let anyFail = false;
  for (const d of dirs) {
    let r;
    try { assertOutsideRepo(resolve(d)); r = await acceptRun(resolve(d), { expect, twice }); }
    catch (e) { console.log("m2a-accept: " + resolve(d) + ": " + ((e && e.message) || e)); return 1; }
    for (const l of r.lines) console.log(l);
    console.log("");
    if (r.failed.length) anyFail = true;
    summary.push((r.label || "?").padEnd(4) + r.gates.map((g) => g.id + " " + (g.status === "n/a" ? "n/a" : g.status)).join("  "));
  }
  if (dirs.length > 1) { console.log("SUMMARY"); for (const l of summary) console.log("  " + l); }
  return anyFail ? 3 : 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
})();
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.log("m2a-accept: " + ((e && e.stack) || e)); process.exitCode = 1; });
