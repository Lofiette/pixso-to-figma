// STUB (part P0). Part B replaces this file. docs/M1.md D8, §6 B. Bundled as
// (function (IR) { … })(PXF_IR) after common.js.
//
// CONTRACT:
//
//   IR.writeTextProps(ctx, node, rec) -> undefined
//     The one text writer, used by the builder and by part C's countLines (on its scratch node), so
//     what is measured is what was built. Writes, in this order: fontName (the record's, or
//     task.settings.fallbackFont when ctx.S.fonts says it was substituted), characters, every other
//     text prop through ctx.prop (DEFAULTS included), then each textRanges entry with the matching
//     setRange* call (fields resolved through ctx.value), and textAutoResize last. It reads no layout.
//     Every font it writes must already be loaded; it throws when one is not.
//
// Until part B lands it throws: "IR.writeTextProps is not in this build: part B implements it".
if (typeof IR.writeTextProps !== "function") IR.writeTextProps = IR.util.notInThisBuild("IR.writeTextProps", "B");
