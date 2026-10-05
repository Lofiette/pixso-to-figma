// STUB (part P0). Part E replaces this file (and may add probes-*.js). docs/M1.md §6 E. Bundled as
// (function (IR) { … })(PXF_IR) after common.js.
//
// CONTRACT:
//
//   IR.probes[NAME] = { args(raw) -> args, run(args) -> Promise<result> }
//     NAME is upper case (P4, P8, P19B): tools/plugin-probe.mjs upper-cases what it is given and the
//     host looks names up exactly. The host's probe command (figma-plugin/src/code.js cmdProbe)
//     validates the common arguments (n, maxMsPerSeries, deadlineMs, sizesMB) itself, calls
//     args(raw) with the whole probe payload before running anything (a throw refuses the job), and
//     runs run(Object.assign({}, common, args)). A result is a JSON object; behavioural verdicts are
//     kept apart from timings, and a verdict is one of "ok", "throw", "drop", "empty" per case, as
//     tools/double/verdicts.json records them.
//     P4: base64 against Uint8Array for the same bytes, moved by the probe itself in window round
//         trips (/image/<hash> raw and ?b64=1), never through the job image pipeline.
//     P8: synthetic PNGs at 4 096 and 4 097 px, a long strip, a JPEG and a WebP under .png, an IMAGE
//         paint with an unknown hash.
//     P19B: vector networks, booleans and frame masks (docs/M1.md §6 E).
//
// Until part E lands each refuses when run: "probe P4 is not in this build: part E implements it".
IR.util.stubProbe("P4", "E");
IR.util.stubProbe("P8", "E");
IR.util.stubProbe("P19B", "E");
