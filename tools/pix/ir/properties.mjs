// Properties: each family's root definitions, the layers bound to them, and the assignments instances
// make (docs/M2A.md D3-D6, §6 B). Part B owns this file (and propindex.mjs after P0); part P0 wrote it
// as a stub with the frozen contract (§5.3).
//
//   import { propertiesOf, bindingsOf, assignments } from "./properties.mjs";
//
// THE FROZEN CONTRACT (docs/M2A.md §5.3). Guids are "session:local" strings. The definition index is
// cx.props (propindex.mjs), the family index cx.families (families.mjs).
//   propertiesOf(cx, familyGuid) -> [definition]
//       The family's declared roots as IR property definitions ({ id, name, type, default,
//       preferredValues? }, docs/IR.md §8), in sortPosition order, then by id. familyGuid is a set's
//       group guid or a standalone component's symbol guid (cx.families.familyOf). The seam writes the
//       result on the set (components.mjs setEntry) or, when it is not empty, on the standalone
//       component (componentEntry); a member of an accepted set declares none.
//   bindingsOf(cx, n, i) -> componentPropertyReferences | null
//       The stored node n (IR record i): its componentPropRef entries as { characters | visible |
//       mainComponent: root id } of the enclosing definition's family, or null when none is carried. The
//       seam writes the result as the record's props.componentPropertyReferences. Dropped bindings are
//       noted PROPERTY_REF_DROPPED (one note per record and class, cx.note while cx.at is the record).
//   assignments(cx, symbolGuid, raw[], { nested, ignored: Set(defId) })
//       -> { kept: [{ family, id, value }], dropped: [{ code, class, defId }] }
//       Sorts Pixso's componentPropAssignment entries `raw` made to an instance whose (effective) master
//       is symbolGuid: every raw assignment ends in exactly one of kept and dropped (D6's classes, in
//       D6's order). nested: the entry is a live override entry, judged against the effective family of
//       the nested instance it targets (STALE_ASSIGNMENT "nested: <class>"). ignored: the defIds rule C
//       ignored (STALE_ASSIGNMENT "ignored"). Part C calls it for every instance and every live entry
//       and writes the notes with the instance's node and the entry's path.
// Part B fills cx.m2a.properties:
//   { roots, liftedMemberRoots, copiedRoots, aliases, viaAlias, unnamedRoots, declaredNotRoot,
//     bindings: { total, kept, dropped: { class: n } }, swapDefaultFromLayer,
//     swapDefaultLayersDisagree: { roots, layers }, boundLayerDiffers: { text, visible },
//     swapDangling: { assignment, default, swap }, preferred: { inFile, byKeyOnly, stringValuesDropped },
//     assignments: { total, kept, droppedWithEntry, merged, dangling, defaultDropped, richTextFlattened,
//                    stale: { class: n } } }
//
// Settings (cx.settings, docs/M2A.md §3): swapDefault layer | definition, rejectedProps copy | none,
// defaultAssignments keep | drop.
//
// STUB (part P0): no property, no binding, no assignment kept and none counted: the IR is M1's. Note the
// stub breaks "every raw assignment in exactly one" on purpose (it sorts nothing); part B's test
// (tools/test-m2a-props.mjs) holds the real contract.
export const STUB = "pending: part B";

export function propertiesOf(cx, familyGuid) {
  return [];
}

export function bindingsOf(cx, n, i) {
  return null;
}

export function assignments(cx, symbolGuid, raw, opts) {
  return { kept: [], dropped: [] };
}
