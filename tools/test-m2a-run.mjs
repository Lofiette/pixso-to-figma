// Part D's tests: the run, the stats and the acceptance gates (docs/M2A.md §6 D, §8).
//
//   node tools/test-m2a-run.mjs
//
// STUB written by part P0 (docs/M2A.md §5.5): it prints "pending: part D" and exits 2 while
// tools/m2a-accept.mjs does not exist, and FAILS (exit 1) once it does and this file has not been
// replaced. Part D replaces this file; it owns it (§9).
//
// THE CONTRACT this test must hold, offline and on synthetic data only:
//   - pix-to-ir and pix-run take the thirteen flags of docs/M2A.md §3 and they round-trip into the IR
//     header; pix-run's --dry prints an "M2a" block beside M1's balance;
//   - the run folder's settings hash includes the M2a settings, so a v3 run never resumes a v2 folder;
//     pix-run refuses a folder whose states.json irVersion is not 3 and names the M1 commit that can
//     resume it;
//   - m2a-accept <runDir>… [--expect <private json>] [--twice] prints every gate of §8 (G1-G10) with the
//     source it read (stats or IR); each gate fails on its own on a planted stats file or IR; --expect
//     refuses a path inside the repository (assertOutsideRepo); exit 0 only when every gate passes;
//   - the M1 balance and the task count on the fixture are unchanged by IR version 3 (tasks carry no
//     instance data; a COMPONENT_SET goes into tasks as its FRAME, docs/M2A.md D13);
//   - tools/test-pixrun.mjs keeps passing (D adjusts it only).
// DONE WHEN (docs/M2A.md §6 D) this test passes and `pix-run --dry --no-pixso` on D, K, M and P prints
// the M1 balance, adding up, and the M2a block.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stub } from "./test/m2a-stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
stub({ part: "D", file: "tools/test-m2a-run.mjs", landed: existsSync(join(HERE, "m2a-accept.mjs")), evidence: "tools/m2a-accept.mjs exists" });
