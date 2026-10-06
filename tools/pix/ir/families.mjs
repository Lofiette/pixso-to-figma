// Families: which state groups are variant sets, and the IR family of every symbol (docs/M2A.md D2,
// D13, §6 A). Part A owns this file; part P0 froze its contract (§5.3).
//
//   import { familyIndex } from "./families.mjs";
//   const F = familyIndex(cx);      // once per read, after the plan (cx.planned, cx.componentGuids are set)
//
// THE FROZEN CONTRACT (docs/M2A.md §5.3). Guids are "session:local" strings.
//   F.setOf(symbolGuid)      -> stateGroupGuid | null: the accepted set a SYMBOL is a member of; null for a
//                               standalone symbol and for a member of a rejected group
//   F.familyOf(symbolGuid)   -> F.setOf(symbol) || symbolGuid: the IR family parts B and C write
//   F.accepted               Map(groupGuid -> { axes: [{ name, values: [string] }],
//                                               variant: Map(symbolGuid -> { axis: value }) })
//                               accepted groups only, every one carried as a record with all its members;
//                               axes and values in D2's order (--axis-order); each variant's keys in axis order
//   F.rejected               Map(groupGuid -> class): one of schema NOTE_CLASSES.VARIANT_SET_REJECTED,
//                               the first that applies in D2's order
//   F.recordType(n, planned) -> "COMPONENT_SET" | planned: the IR type of the stored node n, whose M1 plan
//                               type is `planned`; COMPONENT_SET exactly for an accepted group's FRAME
// The seam (tools/pix/ir/nodes.mjs emit) computes a COMPONENT_SET record's props as the planned FRAME's
// and sets its meta.stateGroup as for that FRAME; it writes `sets` (components.mjs setEntry) and each
// member's `set` and `variant` from this index.
//
// WHAT A FAMILY IS (D2). A state group is a carried record of planned type FRAME whose stored node has
// isStateGroup (every measured group is a FRAME). Its members are its carried child records of planned
// type COMPONENT (Pixso SYMBOLs), in the order Pixso shows them. A member's coordinate is read from its
// name: split on ",", each pair on its first "=", axis and value trimmed. The stored vocabulary
// (stateGroupPropertyValueOrders: [{ property, values }], trimmed the same way) only orders, unless
// --variant-grammar vocabulary makes it a condition too. A group is rejected with the FIRST class that
// applies, in this order:
//   no-equals             a member's name has a pair with no "=" (an empty name included), or with an
//                         empty axis (" =x"; 0 measured in D, K, M, P and the Сова UI kit, and Figma names
//                         no axis "")
//   duplicate-axis        one member's name repeats an axis
//   axis-count            the members name different sets of axes
//   duplicate-coordinate  two members name the same coordinate
//   vocabulary            only under --variant-grammar vocabulary: the vocabulary lists another set of
//                         axes than the names (a value the vocabulary lacks is appended, never rejected)
//   empty                 the group has no member (the name classes need a name: none applies to it)
//   not-symbol            a carried child record is not a COMPONENT (measured: 0 in D, K, M and P; 5
//                         children of state groups in the Сова UI kit)
// An accepted group's axes: the vocabulary's order when it lists exactly the names' axes, else the
// first member's name order (--axis-order names: always the first member's). Each axis's values: the
// vocabulary's values that a member uses, in the vocabulary's order, then the values it lacks in
// member order. A value appended to an axis the vocabulary lists is counted (valuesAppended); an axis
// the vocabulary does not list is in member order and appends nothing.
//
// NOTES. A rejected group stays a FRAME record and gets one VARIANT_SET_REJECTED note on that record (by
// node) whose detail starts with the class. The note is written when the seam asks recordType() for the
// group, so it sits among that record's own notes; its record index is the group's position in the
// plan's emit order (pages in order, each top-level record and then its subtree, parent first), which is
// how nodes.mjs emit numbers records (tools/test-m2a-families.mjs checks the noted record's guid).
//
// COUNTERS (cx.m2a.families, frozen by P0): groups (state groups carried), accepted, rejected: { class: n },
// rejectedMembers (members of rejected groups), valuesAppended, vocabularyOrder and namesOrder (accepted
// sets whose axis order is the vocabulary's, or the first member's names'; the two add up to accepted).
// Under --variant-sets frames nothing is parsed: no group is accepted or rejected, no note is written and
// every counter stays 0, which is M1's D7 (and what P0's stub gave).
//
// Settings (cx.settings, docs/M2A.md §3): variantSets parse | frames, variantGrammar names | vocabulary,
// axisOrder vocabulary | names.
import { guidStr } from "./util.mjs";
import { CODE } from "../../ir/schema.mjs";

// The classes in D2's order (schema NOTE_CLASSES.VARIANT_SET_REJECTED lists the same, in the same order).
export const REJECTION_ORDER = ["no-equals", "duplicate-axis", "axis-count", "duplicate-coordinate", "vocabulary", "empty", "not-symbol"];

// One member name -> { pairs: [[axis, value]] } in the name's order, or { bad: "no-equals" | "duplicate-axis" }.
export function parseVariantName(name) {
  const pairs = [];
  const seen = new Set();
  let dup = false;
  for (const part of String(name).split(",")) {
    const e = part.indexOf("=");
    if (e < 0) return { bad: "no-equals" };
    const axis = part.slice(0, e).trim();
    if (!axis) return { bad: "no-equals" };
    if (seen.has(axis)) dup = true;
    seen.add(axis);
    pairs.push([axis, part.slice(e + 1).trim()]);
  }
  return dup ? { bad: "duplicate-axis" } : { pairs };
}

// The stored vocabulary as [{ name, values }], trimmed, the first occurrence of an axis or a value kept.
export function vocabularyOf(raw) {
  const out = [];
  const names = new Set();
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!x || typeof x.property !== "string") continue;
    const name = x.property.trim();
    if (!name || names.has(name)) continue;
    names.add(name);
    const values = [];
    for (const v of Array.isArray(x.values) ? x.values : []) if (typeof v === "string" && values.indexOf(v.trim()) < 0) values.push(v.trim());
    out.push({ name, values });
  }
  return out;
}

const count = (n, one, many) => n + " " + (n === 1 ? one : many);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.indexOf(x) >= 0);

// Decide one group (D2). members: [{ guid, name }], its carried COMPONENT children in order; others: the
// guids of its carried children that are not COMPONENTs; vocabulary: vocabularyOf(...); settings: the
// reader's (variantGrammar, axisOrder).
// -> { ok: true, axes, variant: Map(guid -> { axis: value }), appended, order: "vocabulary" | "names" }
//  | { ok: false, cls, detail }    (detail starts with cls, as the note's does)
export function decideGroup(members, others, vocabulary, settings) {
  const total = members.length;
  if (!total) return { ok: false, cls: "empty", detail: "empty: no SYMBOL member is carried" + (others.length ? " (" + others.length + " other children)" : "") };
  const parsed = members.map((m) => ({ guid: m.guid, p: parseVariantName(m.name) }));
  for (const [cls, what] of [["no-equals", "name a pair that is not axis=value"], ["duplicate-axis", "repeat an axis in one name"]]) {
    const bad = parsed.filter((x) => x.p.bad === cls);
    if (bad.length) return { ok: false, cls, detail: cls + ": " + bad.length + " of " + total + " members " + what + " (first " + bad[0].guid + ")" };
  }
  const axesOf = parsed.map((x) => x.p.pairs.map((q) => q[0]));
  const odd = axesOf.findIndex((a) => !sameSet(a, axesOf[0]));
  if (odd >= 0) {
    const distinct = new Set(axesOf.map((a) => a.slice().sort().join("\u0000"))).size;
    return { ok: false, cls: "axis-count", detail: "axis-count: the members name " + distinct + " different sets of axes (first differing " + parsed[odd].guid + ")" };
  }
  const names = axesOf[0];
  const sorted = names.slice().sort();
  const seen = new Set();
  const dups = [];
  for (const x of parsed) {
    const m = new Map(x.p.pairs);
    const k = JSON.stringify(sorted.map((a) => m.get(a)));
    if (seen.has(k)) dups.push(x.guid);
    seen.add(k);
  }
  if (dups.length) return { ok: false, cls: "duplicate-coordinate", detail: "duplicate-coordinate: " + dups.length + " of " + total + " members repeat an earlier member's coordinate (first " + dups[0] + ")" };
  const vocabNames = vocabulary.map((a) => a.name);
  const vocabMatches = sameSet(vocabNames, names);
  if (settings.variantGrammar === "vocabulary" && !vocabMatches) {
    return { ok: false, cls: "vocabulary", detail: "vocabulary: the vocabulary lists " + count(vocabNames.length, "axis", "axes") + " and the names " + names.length + ", not the same set" };
  }
  if (others.length) return { ok: false, cls: "not-symbol", detail: "not-symbol: " + others.length + " of " + (total + others.length) + " children are not SYMBOLs (first " + others[0] + ")" };

  // Accepted: the order of the axes, then each axis's values.
  const order = settings.axisOrder === "vocabulary" && vocabMatches ? "vocabulary" : "names";
  const axisNames = order === "vocabulary" ? vocabNames : names;
  let appended = 0;
  const axes = axisNames.map((name) => {
    const used = [];
    for (const x of parsed) { const v = x.p.pairs.find((q) => q[0] === name)[1]; if (used.indexOf(v) < 0) used.push(v); }
    const voc = vocabulary.find((a) => a.name === name);
    if (!voc) return { name, values: used };
    const values = voc.values.filter((v) => used.indexOf(v) >= 0);
    for (const v of used) if (values.indexOf(v) < 0) { values.push(v); appended++; }
    return { name, values };
  });
  const variant = new Map();
  for (const x of parsed) {
    const m = new Map(x.p.pairs);
    const o = {};
    for (const a of axisNames) o[a] = m.get(a);
    variant.set(x.guid, o);
  }
  return { ok: true, axes, variant, appended, order };
}

export function familyIndex(cx) {
  const F = cx.m2a.families;
  const settings = cx.settings;
  const accepted = new Map();
  const rejected = new Map();
  const memberOf = new Map();      // member symbol guid -> accepted group guid
  const pending = new Map();       // rejected group guid -> { node, detail }, noted by recordType

  if (settings.variantSets !== "frames") {
    // The state groups and their record indices, in emit order (nodes.mjs emit: parent first, siblings in order).
    let index = 0;
    const groups = [];
    const walk = (p) => {
      const i = index++;
      if (p.type === "FRAME" && p.n.isStateGroup) groups.push({ p, i });
      for (const k of p.kids) walk(k);
    };
    for (const pg of cx.planned) for (const t of pg.tops) walk(t);

    for (const { p, i } of groups) {
      const g = guidStr(p.n.guid);
      const members = [], others = [];
      for (const k of p.kids) {
        if (k.type === "COMPONENT") members.push({ guid: guidStr(k.n.guid), name: typeof k.n.name === "string" ? k.n.name : "" });
        else others.push(guidStr(k.n.guid));
      }
      F.groups++;
      const d = decideGroup(members, others, vocabularyOf(p.n.stateGroupPropertyValueOrders), settings);
      if (d.ok) {
        F.accepted++;
        F.valuesAppended += d.appended;
        if (d.order === "vocabulary") F.vocabularyOrder++; else F.namesOrder++;
        accepted.set(g, { axes: d.axes, variant: d.variant });
        for (const m of members) memberOf.set(m.guid, g);
      } else {
        F.rejected[d.cls]++;
        F.rejectedMembers += members.length;
        rejected.set(g, d.cls);
        pending.set(g, { node: i, detail: d.detail });
      }
    }
  }

  const setOf = (symbolGuid) => (memberOf.has(symbolGuid) ? memberOf.get(symbolGuid) : null);
  return {
    setOf,
    familyOf(symbolGuid) { return setOf(symbolGuid) || symbolGuid; },
    accepted,
    rejected,
    recordType(n, planned) {
      if (planned !== "FRAME") return planned;
      const g = guidStr(n.guid);
      if (accepted.has(g)) return "COMPONENT_SET";
      const nt = pending.get(g);
      if (nt) { pending.delete(g); cx.noteAt(CODE.VARIANT_SET_REJECTED, nt); }
      return planned;
    },
  };
}
