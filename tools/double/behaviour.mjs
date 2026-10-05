// Which probe verdict the double follows, case by case (docs/M1.md §5.4, §6 E; REWRITE.md §8: "it
// must reproduce every probe verdict"). Part E owns it (§9).
//
// tools/double/verdicts.json holds what the live probes recorded. A recorded verdict is followed. A
// case still "pending" is followed with the double's stated ASSUMPTION below (label A: an assumption
// until the live session, docs/M1.md §10 step 1), and every report of the double says which cases it
// assumed (behaviour().assumed). A recorded verdict the double cannot model refuses to build the
// double, naming the case, so a live result that contradicts the model is never silently ignored: F
// changes the double before recording it (REWRITE.md §8, "the probe is re-run first and the double
// changed after").
//
// Values: "ok", "throw", "drop", "empty" (docs/M1.md §5.4), and, for the P19B geometry cases whose
// question is "does Figma do what we expect", "differs" (Figma did something else; the probe's
// measurements say what). P4 has two keys with their own values: transport "base64" | "binary" (the
// faster transport that kept the hash) and sameHash "ok" | "differs" (Figma re-encoded the bytes).
//
// What each value means to the double, per case:
//   P8   png4096 png4097 longStrip jpegAsPng webpAsPng     createImage of such bytes: ok; throw (it
//        throws); drop (it succeeds, and a fill naming the image is dropped when assigned); empty (it
//        succeeds, and the image reads back with no bytes and size 0 x 0)
//        unknownHash   an IMAGE paint whose hash no image has: ok (kept); throw (the fills write
//                      throws); drop (the paint is dropped from the fills)
//   P19  perVertexCornerRadius, perRegionFills   ok (kept); drop (stripped when the network is set);
//                      throw (setVectorNetworkAsync rejects)
//        openRegionlessNetworkFilled             empty (an open network without regions draws no
//                      fill); ok (it is filled, closed by its chain)
//   P19B autoClosedLoop   vectorPaths with an open subpath (no Z): ok (filled, as if closed); empty
//                      (that subpath draws no fill); throw (the write throws)
//        offsetNetwork    a network or paths whose bounds do not start at (0, 0): ok (Figma moves the
//                      node's origin to the bounds and keeps the drawing in place); drop (the offset
//                      is dropped: the drawing moves to the origin); throw (rejects)
//        regionlessFill   a closed loop with no region: empty (no fill, as P19's open network); ok
//                      (the loop is filled)
//        fillGeometryAgainstNetwork   ok (fillGeometry is the regions' paths); empty (none)
//        booleanUnion booleanSubtract booleanIntersect booleanExclude   ok (the operation of the
//                      operands' fill areas); throw (figma.<op> throws); empty (the result has no paths)
//        nestedBoolean    ok; throw (a boolean operand refused)
//        singleOperandUnion   ok; throw (one operand refused)
//        lineOperand      ok (a LINE adds no area); differs (it adds its stroke's box); throw
//        strokedOperand   ok (operand strokes ignored); differs (an operand's stroke widens its
//                      area by its weight); throw
//        frameMask        ok (kept); drop (ignored: isMask reads false); throw
//        maskInGroupAsFrame   isMask on a shape inside a FRAME: ok; drop; throw
//        flattenedWithStroke  a vector built from vectorPaths with a stroke: ok (its strokeGeometry is
//                      drawn); empty (none)
//   P4   transport and sameHash: sameHash "differs" makes createImage's hash differ from the bytes'
//        SHA-1 (a re-encoding Figma); transport is the runner's choice, not a double behaviour
//   P2   recorded: the IR layer has no performance.now and no timer (tools/ir/plugin-vm.mjs gives it
//        none), and getNodeByIdAsync resolves without one (the double's resolves at once)
//   P13  instance sublayer overrides: not modelled in M1 (the double has no instances; M2b)
//
// The assumptions, and why. P8: images over 4 096 px are accepted (the double's core already took a
// 4 096 x 4 097 PNG header and read its size back, and tools/test-m1-contract.mjs, P0's, holds it to
// that), JPEG accepted, WebP refused (Figma's documentation names PNG, JPEG and GIF), an unknown hash
// kept. P19B: Figma fills an open subpath, moves a vector's origin to its drawing's bounds and keeps
// the drawing in place (docs/M1.md §11 "Vector origin"), does not fill a closed loop without a region
// (as P19 measured for an open one), and computes booleans on fill areas with operand strokes
// ignored (docs/M1.md D5); frame masks are kept. All are A until docs/M1.md §10 step 1.
export const MODEL = {
  P4: { transport: { assumed: "base64", values: ["base64", "binary"] }, sameHash: { assumed: "ok", values: ["ok", "differs"] } },
  P8: {
    png4096: { assumed: "ok", values: ["ok", "throw", "drop", "empty"] },
    png4097: { assumed: "ok", values: ["ok", "throw", "drop", "empty"] },
    longStrip: { assumed: "ok", values: ["ok", "throw", "drop", "empty"] },
    jpegAsPng: { assumed: "ok", values: ["ok", "throw", "drop", "empty"] },
    webpAsPng: { assumed: "throw", values: ["ok", "throw", "drop", "empty"] },
    unknownHash: { assumed: "ok", values: ["ok", "throw", "drop"] },
  },
  P19: {
    perVertexCornerRadius: { assumed: "ok", values: ["ok", "drop", "throw"] },
    perRegionFills: { assumed: "ok", values: ["ok", "drop", "throw"] },
    openRegionlessNetworkFilled: { assumed: "empty", values: ["empty", "ok"] },
  },
  P19B: {
    autoClosedLoop: { assumed: "ok", values: ["ok", "empty", "throw"] },
    offsetNetwork: { assumed: "ok", values: ["ok", "drop", "throw"] },
    regionlessFill: { assumed: "empty", values: ["empty", "ok"] },
    fillGeometryAgainstNetwork: { assumed: "ok", values: ["ok", "empty"] },
    booleanUnion: { assumed: "ok", values: ["ok", "throw", "empty"] },
    booleanSubtract: { assumed: "ok", values: ["ok", "throw", "empty"] },
    booleanIntersect: { assumed: "ok", values: ["ok", "throw", "empty"] },
    booleanExclude: { assumed: "ok", values: ["ok", "throw", "empty"] },
    nestedBoolean: { assumed: "ok", values: ["ok", "throw"] },
    singleOperandUnion: { assumed: "ok", values: ["ok", "throw"] },
    lineOperand: { assumed: "ok", values: ["ok", "differs", "throw"] },
    strokedOperand: { assumed: "ok", values: ["ok", "differs", "throw"] },
    frameMask: { assumed: "ok", values: ["ok", "drop", "throw"] },
    maskInGroupAsFrame: { assumed: "ok", values: ["ok", "drop", "throw"] },
    flattenedWithStroke: { assumed: "ok", values: ["ok", "empty"] },
  },
};

// -> { of(probe, case) -> value, assumed: ["P19B.offsetNetwork", …], recorded: [...] }
export function behaviour(verdicts) {
  const probes = (verdicts && verdicts.probes) || {};
  const chosen = {}, assumed = [], recorded = [];
  for (const p of Object.keys(MODEL)) {
    chosen[p] = {};
    const got = (probes[p] && probes[p].verdicts) || {};
    for (const c of Object.keys(MODEL[p])) {
      const v = got[c];
      if (v === undefined || v === "pending") { chosen[p][c] = MODEL[p][c].assumed; assumed.push(p + "." + c); continue; }
      if (MODEL[p][c].values.indexOf(v) < 0) {
        throw new Error("double: the verdict " + JSON.stringify(v) + " for " + p + "." + c + " is not modelled (" + MODEL[p][c].values.join(", ") +
          "); change tools/double before recording it (REWRITE.md §8)");
      }
      chosen[p][c] = v; recorded.push(p + "." + c);
    }
  }
  return { of: (p, c) => chosen[p][c], assumed, recorded };
}
