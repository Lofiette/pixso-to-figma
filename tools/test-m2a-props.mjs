// Part B's tests: property roots, bindings, defaults, preferred values and assignments (docs/M2A.md
// D3-D6, §6 B).
//
//   node tools/test-m2a-props.mjs
//
// STUB written by part P0 (docs/M2A.md §5.5): it prints "pending: part B" and exits 2 while
// tools/pix/ir/properties.mjs is P0's stub, and FAILS (exit 1) once part B's properties.mjs is in and
// this file has not been replaced. Part B replaces this file; it owns it (§9).
//
// THE CONTRACT this test must hold, on the synthetic fixture (tools/pix/fixture.mjs, M2A ids) only:
//   - every fixture property case under both --swap-default and both --rejected-props values, as the
//     fixture's comments state: the roots each family declares (Chip, Lib Tag, Row, Card2, the
//     axis-count group's members), in sortPosition order, type, name and default from the root only;
//     the member-owned root lifted (Chip's Badge) and kept on its member (Flag); the COLOR root not
//     declared (SOURCE_FEATURE_UNSUPPORTED "COLOR property"); INSTANCE_SWAP defaults from the bound
//     layers (Chip's Icon, Row's Lead icon) or the definition, and the disagreeing layers counted
//     (Card2's Badge icon); preferred values as key references, in the file (guid) or by key alone,
//     TEXT stringValues dropped and counted;
//   - bindings: every kept one names the root id; every dropped one in D4's first class (fill-style,
//     outside-definition, no-definition, other-family, no-root, undeclared, type-mismatch), one
//     PROPERTY_REF_DROPPED per record and class; boundLayerDiffers;
//   - assignments: each of the fixture's in exactly one of D6's classes (kept, STALE_ASSIGNMENT
//     no-definition / other-family / no-root / undeclared / nested / ignored, SWAP_VALUE_DANGLING
//     assignment, dropped with its entry, merged away); --default-assignments drop;
//   - the validator accepts every declared type as its root's; a binding is never resolved by name (a
//     planted same-name definition in another family stays dropped); the renumbered fixture gives
//     the same IR;
//   - stats.m2a.properties as frozen in tools/pix/ir/index.mjs (newM2aStats) and properties.mjs's
//     header, and propindex.mjs's contract (tools/test-m2a-contract.mjs) still holding.
// Part C's nested-assignment checks print "pending: B" until B merges (docs/M2A.md §7).
// DONE WHEN (docs/M2A.md §6 B) this test passes and on D, K, M and P: stale assignments on instances,
// no-definition + other-family, 130 (124 + 6), 2 034 (315 + 1 719), 922 (96 + 826), 1 851 (321 + 1 530),
// with no-root and undeclared reported apart; type-mismatch 0 / 0 / 0 / 94; fill-style 1 101 / 5 232 /
// 17 370 / 34 903; lifted member roots 120 / 120 / 6 / 24; every other difference from §1.2 explained in
// the pull request.
import { stub } from "./test/m2a-stub.mjs";
import * as properties from "./pix/ir/properties.mjs";

stub({ part: "B", file: "tools/test-m2a-props.mjs", landed: properties.STUB === undefined, evidence: "tools/pix/ir/properties.mjs exports no STUB" });
