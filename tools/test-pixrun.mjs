// Part D's tests: the planner, the image chain, the run state, the verdict and m1-accept
// (docs/M1.md §6 D).
//
//   node tools/test-pixrun.mjs
//
// STUB written by part P0. Part D replaces everything below this comment block with its tests;
// tools/selftest.mjs (section 9) already runs this file, and fails the run when it exits non-zero.
// Print "ok   …" / "FAIL …" lines as the other test files do, and exit 1 on any failure.
//
// What it must cover (docs/M1.md §6 D, "Tests"): the planner on the A fixture's IR (or a synthetic
// IR before A merges): every task valid (tools/ir/validate.mjs validateTask) and under the cap, a
// split root with attachTo { i }, the S2 grid with attachTo "page" and place, notes carried, oracle
// props stripped, the balance adding up under each --m1-scope, deterministic task text; the image
// chain with fakePixso (archive SHA-1, MCP bytes with a bad SHA-1 moving on, links 2 and 3 skipped
// when identity fails, the breaker tripping mid-fetch, a P8 drop verdict moving on, the
// placeholder); assertReadOnlyScript refusing setPluginData, remove, resize, appendChild, setRange and
// assignments; run-state transitions including PLUGIN_STALLED as failed and resumable; every gate
// of §8.1 turning the verdict to FAIL on its own; no PASS without an audit; the probe status line;
// refusal to write inside the repository (tools/ir/outside-repo.mjs), through a junction and with
// another drive-letter case.
console.log("pending: part D (docs/M1.md §6 D) — the planner's, image chain's and acceptance tests replace this stub");
process.exit(0);
