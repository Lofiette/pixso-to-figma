// Part B's tests: the IR builder in the plugin, run as bundled against the headless double
// (docs/M1.md §6 B).
//
//   node tools/test-irbuild.mjs
//
// STUB written by part P0. Part B replaces everything below this comment block with its tests;
// tools/selftest.mjs (section 9) already runs this file, and fails the run when it exits non-zero.
// Print "ok   …" / "FAIL …" lines as the other test files do, and exit 1 on any failure. A check that
// needs the double's layout engine or text model (part E) prints "pending: E" until E merges; part F
// re-runs them.
//
// What it must cover (docs/M1.md §6 B, "Tests"), from hand-made IR: no layout read in fonts, images,
// pages, create, vectors and booleans (D.reads.byPhase); one node per non-instance record and one
// unstamped placeholder per INSTANCE; side weights surviving strokeWeight; DEFAULTS and empty fills
// written; IMAGE_PLACEHOLDER for an unknown or failed hash, an error for a mismatching archive or MCP
// hash; VECTOR_NETWORK_REFUSED on RIGHT_ANGLE; a geometry record built from fillGeometry; a geometry
// record without its note refused; FONT_SUBSTITUTED; decision 9 with the x shift; a class A boolean
// native with composed matrices; BOOLEAN_FALLBACK when the double throws (makeDouble({ faults }));
// MASK_UNSUPPORTED when the verdicts say a frame mask is refused; components stamped pxDef on the
// service page; no setTimeout reached; the report shape; constraints time booked to constraints.
//
//   import { makeDouble } from "./double/index.mjs";
//   import { loadPluginIR, defaultHost } from "./ir/plugin-vm.mjs";
//   import { validateTask } from "./ir/validate.mjs";
//   const D = makeDouble(), host = defaultHost(); host.phase = D.setPhase;
//   const IR = loadPluginIR({ figma: D.figma, host });
//   const report = await IR.ops.build(IR.makeCtx(D.figma, task, { id: "t1" }), task);
console.log("pending: part B (docs/M1.md §6 B) — the IR builder's tests replace this stub");
process.exit(0);
