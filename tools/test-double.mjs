// Part E's tests: the headless double, the probes and the plugin channel (docs/M1.md §6 E).
//
//   node tools/test-double.mjs
//
// STUB written by part P0. Part E replaces everything below this comment block with its tests;
// tools/selftest.mjs (section 9) already runs this file, and fails the run when it exits non-zero.
// Print "ok   …" / "FAIL …" lines as the other test files do, and exit 1 on any failure.
//
// The double's core and its surface are checked by tools/test-m1-contract.mjs (part P0's); this
// file covers what E adds (docs/M1.md §6 E, "Tests"): conformance (the probe functions of
// figma-plugin/src/ir/probes*.js run against the double reproduce tools/double/verdicts.json); auto
// layout cases with expected boxes; the reset semantics; a font-missing throw; text width and wrap;
// liveness in tools/jobserver.mjs (no advance fails the post with PLUGIN_STALLED, an advance keeps it,
// the ceiling fails it).
//
//   import { makeDouble } from "./double/index.mjs";
//   import { loadPluginIR } from "./ir/plugin-vm.mjs";
console.log("pending: part E (docs/M1.md §6 E) — the double's, the probes' and the channel's tests replace this stub");
process.exit(0);
