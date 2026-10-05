// Part A's tests: the .pix -> IR reader, on the synthetic fixture only (docs/M1.md §6 A).
//
//   node tools/test-irread.mjs
//
// STUB written by part P0. Part A replaces everything below this comment block with its tests;
// tools/selftest.mjs (section 9) already runs this file, and fails the run when it exits non-zero.
// Print "ok   …" / "FAIL …" lines as the other test files do, and exit 1 on any failure.
//
// What it must cover (docs/M1.md §6 A, "Tests"): validate() ok (tools/ir/validate.mjs); two runs
// byte-identical; population counts; strokeWeights per side-rule case and SIDE_RULE_UNPROVEN on a
// planted disagreement; cornerRadii; UTF-16 range offsets; lines; network decode region by region,
// every byte consumed; truncated network, glyph blob and text indices each give PIX_CORRUPT;
// VECTOR_FROM_GEOMETRY; each VECTOR_ORACLE_DIFFERS class (schema.ORACLE_CLASSES); BOOLEAN_FLATTENED
// under auto and flatten and none under native; GEOMETRY_INVALID; IMAGE_HASH_MISMATCH; DIRECTORY
// pages kept; style definitions not carried; pix-to-ir refusing an --out inside the repository
// (tools/ir/outside-repo.mjs).
//
// The interfaces it tests (docs/M1.md §6 A): pixToIR(buffer, { settings }) -> { ir, stats } and
// decodeVectorNetwork(bytes) -> { vertices, segments, regions }.
console.log("pending: part A (docs/M1.md §6 A) — the .pix -> IR reader's tests replace this stub");
process.exit(0);
