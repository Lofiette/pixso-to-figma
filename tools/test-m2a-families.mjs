// Part A's tests: families, variant sets and the populations (docs/M2A.md D2, D13, §6 A).
//
//   node tools/test-m2a-families.mjs
//
// STUB written by part P0 (docs/M2A.md §5.5): it prints "pending: part A" and exits 2 while
// tools/pix/ir/families.mjs is P0's stub, and FAILS (exit 1) once part A's families.mjs is in and this
// file has not been replaced. Part A replaces this file; it owns it (§9).
//
// THE CONTRACT this test must hold, on the synthetic fixture (tools/pix/fixture.mjs, M2A ids) only:
//   - each fixture state group's outcome under each setting, as the fixture's comments state:
//     Chip, Lib Tag, Toggle and Vocab accepted under --variant-grammar names; the four rejected groups
//     (no-equals, duplicate-axis, axis-count, duplicate-coordinate) rejected with that class, the
//     first that applies in D2's order; Vocab rejected "vocabulary" under --variant-grammar vocabulary;
//     under --variant-sets frames no set, no note, every member standalone (M1's D7);
//   - an accepted group is a COMPONENT_SET record with a `sets` entry (axes, properties, the group's
//     library identity for Lib Tag), its members' `set` and `variant`; a rejected one stays a FRAME
//     with one VARIANT_SET_REJECTED note on its record (by node, the detail starting with the class),
//     its members standalone components;
//   - axis and value order: Chip's axes [State, Size] under --axis-order vocabulary and [Size, State]
//     under names; Size's values [S, M, L], L appended (families.valuesAppended);
//   - FamilyIndex: setOf, familyOf (= setOf || symbol), accepted, rejected, recordType as frozen in
//     families.mjs's header; stats.m2a.families = { groups, accepted, rejected: { class: n },
//     rejectedMembers, valuesAppended, vocabularyOrder, namesOrder };
//   - byte-identical IR on two reads;
//   - the populations with a COMPONENT_SET on the internal canvas (Chip, Lib Tag, Vocab) and on a user
//     page (Toggle): stateGroupsInternal and userMasters as under frames;
//   - Toggle (auto layout): its record's props and its tasks equal under both --variant-sets values
//     (D13), and the validator's coordinate checks pass on the result.
// DONE WHEN (docs/M2A.md §6 A) this test passes and, on D, K, M and P, accepted / rejected are 64 / 3,
// 308 / 4, 221 / 6, 348 / 11 (P 342 / 17 under vocabulary), members of rejected sets 66 / 97 / 192 /
// 436, the split by class under D2's order is in the pull request, and the M1 balance adds up.
import { stub } from "./test/m2a-stub.mjs";
import * as families from "./pix/ir/families.mjs";

stub({ part: "A", file: "tools/test-m2a-families.mjs", landed: families.STUB === undefined, evidence: "tools/pix/ir/families.mjs exports no STUB" });
