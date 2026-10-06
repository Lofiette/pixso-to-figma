// What an M2a part's test does while it is still part P0's stub (docs/M2A.md §5.5).
//
//   import { stub } from "./test/m2a-stub.mjs";
//   stub({ part: "A", file: "tools/test-m2a-families.mjs", landed, evidence });
//
// A stub never passes: it exits 2 and prints "pending: part X" while the part's code is still P0's
// stub, and exits 1 with a FAIL once the part's code has landed but its test has not (`landed`: the
// part's modules no longer export STUB, or its new file exists), so a part cannot merge its code
// without the test that holds it. tools/selftest.mjs reports exit 2 as pending, exit 1 as a failure.
export const PENDING_EXIT = 2;

export function stub({ part, file, landed, evidence }) {
  if (landed) {
    console.log("FAIL " + file + " is still part P0's stub, but part " + part + "'s code is in (" + evidence + "): part " + part + " replaces this file with its tests (docs/M2A.md §6)");
    process.exit(1);
  }
  console.log("pending: part " + part + " (" + file + " is P0's stub; its header lists the checks part " + part + " must make)");
  process.exit(PENDING_EXIT);
}
