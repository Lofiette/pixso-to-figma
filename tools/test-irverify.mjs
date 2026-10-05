// Part C's tests: VERIFY, countLines, the judge and pathgeom (docs/M1.md §6 C).
//
//   node tools/test-irverify.mjs
//
// STUB written by part P0. Part C replaces everything below this comment block with its tests;
// tools/selftest.mjs (section 9) already runs this file, and fails the run when it exits non-zero.
// Print "ok   …" / "FAIL …" lines as the other test files do, and exit 1 on any failure. A check that
// needs part E's text model prints "pending: E" until E merges; part F re-runs them.
//
// What it must cover (docs/M1.md §6 C, "Tests"): pathgeom on curves with known extrema and on Figma
// path strings (M, L, Q, C, Z); the judge on synthetic rows (a side mismatch against the IR and
// against the oracle, a regrouped vector, each excused class, an unexcused vector, a 1.2 px offset, a
// 1.2 px size error, a hidden offset left out, a text difference, a font-held text, an approximate
// text, a placeholder with a child, a missing root), every J checked with checkJShape; verify on a
// scene built in the double by direct figma.* calls (independent of part B); the scratch node
// removed; countLines against E's text model after E merges.
//
//   import { judgeTask, judgeRun, checkJShape, ROW } from "./ir/judge.mjs";
//   import { pathBounds } from "./ir/pathgeom.mjs";
//   import { makeDouble } from "./double/index.mjs";
//   import { loadPluginIR } from "./ir/plugin-vm.mjs";
console.log("pending: part C (docs/M1.md §6 C) — the verify, countLines, judge and pathgeom tests replace this stub");
process.exit(0);
