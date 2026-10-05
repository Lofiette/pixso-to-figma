// STUB (part P0). Part C replaces this file. docs/M1.md D8, §6 C. Bundled as
// (function (IR) { … })(PXF_IR) after common.js.
//
// CONTRACT:
//
//   IR.countLines(ctx, node, rec) -> { lines: integer >= 0, approx: boolean }
//     Counts the lines of the BUILT text node `node` (IR record `rec`) after a settle: writes rec onto
//     one reused scratch text node through IR.writeTextProps at node's current width, with
//     textAutoResize HEIGHT and truncation and leading trim off, and takes
//     round((H - paragraphSpacing * (paragraphs - 1)) / L), where L is the line height in pixels
//     (PIXELS; PERCENT x fontSize; AUTO: the one-line height measured once per font and size). With
//     ENDING truncation the count is capped at maxLines. approx is true when ranges mix line heights.
//     The scratch node lives on the service page, is stamped pxScratch (shared and private, through
//     ctx.stamp), its id is kept in ctx.S.scratchTextId, and it is removed at the end of the op that
//     made it. ctx.measure(node, rec) calls this (or a test's host.measure).
//
// Until part C lands it throws: "IR.countLines is not in this build: part C implements it".
if (typeof IR.countLines !== "function") IR.countLines = IR.util.notInThisBuild("IR.countLines", "C");
