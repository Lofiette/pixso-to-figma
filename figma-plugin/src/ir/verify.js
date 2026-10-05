// STUB (part P0). Part C replaces this file (and may add verify-*.js). docs/M1.md §6 C. Bundled as
// (function (IR) { … })(PXF_IR) after common.js.
//
// CONTRACT:
//
//   IR.ops.verify(ctx, task) -> Promise<{ op: "verify", taskNo, runId, plugin, roots: [{ i, id, found }],
//                                          count, rows, ms, codes, coded, failures }>
//     Loads task.fonts first, settles once, finds each root with ctx.findRoot(i) (a root not found is
//     { i, id: null, found: false }, and the judge counts ROOT_NOT_FOUND), then walks from each root in
//     IR order (task.nodes[k] is the built DFS[k]). count is the number of built nodes walked. A row is
//     [i, builtType, childCount, effVisible, absX, absY, w, h, sides|null, vec|null, lines|null]
//     (tools/ir/judge.mjs ROW): sides are the four Figma side weights when strokes are not empty;
//     vec is [[winding, x0, y0, x1, y1], …] per Figma fill path in root-relative absolute coordinates
//     (bounds by PXF_PATHGEOM.pathBounds); lines is ctx.measure(node, rec) for a TEXT. No path string
//     travels back.
//
// Until part C lands it refuses: "the verify op is not in this build: part C implements it".
IR.util.stubOp("verify", "C");
