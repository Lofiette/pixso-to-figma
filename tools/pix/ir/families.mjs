// Families: which state groups are variant sets, and the IR family of every symbol (docs/M2A.md D2,
// D13, §6 A). Part A owns this file; part P0 wrote it as a stub with the frozen contract (§5.3).
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
//                               axes and values in D2's order (--axis-order)
//   F.rejected               Map(groupGuid -> class): one of schema NOTE_CLASSES.VARIANT_SET_REJECTED,
//                               the first that applies in D2's order
//   F.recordType(n, planned) -> "COMPONENT_SET" | planned: the IR type of the stored node n, whose M1 plan
//                               type is `planned`; COMPONENT_SET exactly for an accepted group's FRAME
// The seam (tools/pix/ir/nodes.mjs emit) computes a COMPONENT_SET record's props as the planned FRAME's
// and sets its meta.stateGroup as for that FRAME; it writes `sets` (components.mjs setEntry) and each
// member's `set` and `variant` from this index. Part A writes the VARIANT_SET_REJECTED note (on the
// group's FRAME record, by node, the detail starting with its class) and fills cx.m2a.families:
//   { groups, accepted, rejected: { class: n }, rejectedMembers, valuesAppended, vocabularyOrder, namesOrder }
//
// Settings (cx.settings, docs/M2A.md §3): variantSets parse | frames, variantGrammar names | vocabulary,
// axisOrder vocabulary | names. Under frames no group is accepted or rejected and no note is written
// (M1's D7).
//
// STUB (part P0): no group is accepted, none is rejected, no note is written: the IR is M1's, as under
// --variant-sets frames. tools/test-m2a-families.mjs fails until part A replaces this.
export const STUB = "pending: part A";

export function familyIndex(cx) {
  return {
    setOf() { return null; },
    familyOf(symbolGuid) { return symbolGuid; },
    accepted: new Map(),
    rejected: new Map(),
    recordType(n, planned) { return planned; },
  };
}
