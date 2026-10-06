// Part E's end-to-end test of M2a (docs/M2A.md §7).
//
//   node tools/test-m2a-e2e.mjs
//
// STUB written by part P0 (docs/M2A.md §5.5): it prints "pending: part E" and exits 2 while any of
// parts A-D is still pending, and FAILS (exit 1) once all four have landed and this file has not been
// replaced. Part E replaces this file; it owns it (§9).
//
// THE CONTRACT this test must hold, on the synthetic fixture only:
//   - fixture -> pixToIR (default settings, and each non-default value once) -> validate -> planM1 ->
//     the bundled plugin on the headless double (M1's path, a COMPONENT_SET written into tasks as a
//     FRAME) -> judge -> M1's verdict reads as before;
//   - the tasks equal, record for record, those of the --variant-sets frames IR;
//   - m2a-accept on the fixture's run folder passes every gate of §8, and a planted fault per gate fails
//     it (M2A_PLANTS.unknownOverrideField for G6's "unknown");
//   - the renumbered fixture gives the same IR (G8's second half, which a run folder cannot show);
//   - parts B's and C's checks that printed "pending: A" or "pending: B" run in full.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stub } from "./test/m2a-stub.mjs";
import * as families from "./pix/ir/families.mjs";
import * as properties from "./pix/ir/properties.mjs";
import * as resolve from "./pix/ir/resolve.mjs";
import * as overrides from "./pix/ir/overrides.mjs";
import * as derived from "./pix/ir/derived.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const pending = [families.STUB, properties.STUB, resolve.STUB, overrides.STUB, derived.STUB].some((s) => s !== undefined) || !existsSync(join(HERE, "m2a-accept.mjs"));
stub({ part: "E", file: "tools/test-m2a-e2e.mjs", landed: !pending, evidence: "parts A, B, C and D have all landed" });
