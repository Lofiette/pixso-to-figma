// Part F's end-to-end test: the fixture .pix through every part (docs/M1.md §7).
//
//   node tools/test-m1-e2e.mjs
//
// STUB written by part P0. Part F replaces everything below this comment block after parts A-E
// merge; tools/selftest.mjs (section 9) already runs this file, and fails the run when it exits
// non-zero.
//
// What it must cover (docs/M1.md §7): fixture .pix -> pixToIR -> planM1 -> the bundled plugin in a vm
// with the double (fonts, build, verify) -> judge -> verdict. On the fixture: every gate of §8.1
// passes, the balance adds up, each excused vector carries its pre-registered code, a planted
// unexcused vector turns the verdict to FAIL, the verdict reads BUILT, NOT VISUALLY AUDITED, and the
// time per phase is present. F also re-runs B's and C's "pending: E" checks.
console.log("pending: part F (docs/M1.md §7) — the end-to-end test replaces this stub after parts A-E merge");
process.exit(0);
