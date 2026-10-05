// STUB (part P0). Part B replaces this file (and may add build-*.js beside it; build-fonts.js holds
// the fonts op). docs/M1.md §6 B. Bundled as (function (IR) { … })(PXF_IR) after common.js.
//
// CONTRACT:
//
//   IR.ops.fonts(ctx, task) -> Promise<{ op: "fonts", taskNo, runId, plugin?, available: [{family, style}],
//                                        missing: [{family, style}], ms, codes, coded, failures }>
//     listAvailableFontsAsync once, then loadFontAsync for every task.fonts entry; a font that will
//     not load is `missing` (the runner prints FONT_MISSING and stops unless --missing-fonts substitute).
//     Records ctx.S.fonts["family|style"] = "ok".
//
//   IR.ops.build(ctx, task) -> Promise<buildReport>
//     buildReport = { op: "build", taskNo, runId, plugin, roots: [{ i, id }], built, placeholders,
//       ms: { fonts, images, pages, create, vectors, booleans, layout, settle, measure, repair1, place1,
//             repair2, place2, flowGroup, flow1, flow2, repair3, place3, textLine, constraints, stamp },
//       msTotal, storedNodes, codes: { CODE: n }, coded: [{ code, i, detail }], failures: [{ i, prop, msg }],
//       fontSubs: [{ family, style, nodes }], textWidened: [i], textPinned: [i],
//       counters: { sizeRepaired, sizeRejected, layoutDroppedForSize, rotPinned, flowAligned, flowAbsolute,
//                   flowStillOff, flowRejected, flowReverted, flowGroups, textTrimmed, textTrimReverted,
//                   constraintsSet, sideStrokes, vectorsNetwork, vectorsGeometry, booleansNative, imagesPlaced },
//       settings }
//     ms has one entry per phase of IR.BUILD_PHASES that ran (ctx.phase(name) with those names; the
//     phases of IR.WRITE_ONLY_PHASES read no layout).
//     Order (docs/M1.md §6 B): fonts, images, pages, create (write-only, parent-first, DEFAULTS and
//     NEVER_OMIT explicit, strokeWeight before the side weights, text through IR.writeTextProps,
//     INSTANCE as an unstamped placeholder frame), vectors, booleans, layout, one settle, MEASURE
//     (ctx.measure, decision 9), the ported repair/place/flow/textLine passes, constraints, stamps.
//     Records ctx.S.nodes[i] = figma id for every built record and ctx.S.pages[index].
//     Errors: a task error refuses (thrown with e.refused); a Figma throw on one node is a counted
//     fallback (a code) or a failure entry, never a silent skip.
//
//   IR.ops.clean(ctx, task) -> Promise<{ op: "clean", taskNo, runId, removed, kept }>
//     removes top-level nodes stamped pxSrc with a task root's guid whose pxRun differs from
//     task.runId, under the guard rule of figma-plugin/src/code.js cmdClean (only top-level nodes of a
//     page, never a page or the document).
//
// Until part B lands, each op refuses: "the build op is not in this build: part B implements it".
IR.util.stubOp("fonts", "B");
IR.util.stubOp("build", "B");
IR.util.stubOp("clean", "B");
