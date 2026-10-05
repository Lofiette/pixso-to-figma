// The one text writer (docs/M1.md D8, §6 B), used by the builder (build-create.js) and by part C's
// IR.countLines on its scratch node, so what is measured is what was built. Part B owns this file.
// Bundled as (function (IR) { … })(PXF_IR) after common.js.
//
//   IR.writeTextProps(ctx, node, rec) -> undefined
//     Writes, in this order:
//       1. fontName: the record's, or task.settings.fallbackFont when ctx.S.fonts marks the record's
//          font "sub" (substituted by the build's fonts phase);
//       2. characters;
//       3. every other text prop KNOWN_PROPS.TEXT lists, through ctx.prop, so DEFAULTS are written
//          too: fontSize, textCase, textDecoration, letterSpacing, lineHeight, paragraphIndent,
//          paragraphSpacing, listSpacing, textAlignHorizontal, textAlignVertical, textTruncation,
//          maxLines (only under textTruncation ENDING, the one place Figma takes it), leadingTrim,
//          hangingPunctuation, hangingList;
//       4. each textRanges entry, field by field, with the matching setRange* call: interned fields
//          resolved through ctx.value, a range font substituted like the node's and written first,
//          IMAGE paints in range fills mapped by IR.mapPaints (build-images.js). fillStyle and
//          textStyle are style references, which land in M2b, and are not written;
//       5. textAutoResize, last.
//     The node's own fills are NOT written here: a node fill written after the ranges would erase
//     them, so the builder writes paints before it calls this. It reads no layout.
//     A font that is not loaded makes Figma throw on fontName, characters or a range font, and that
//     throw is not caught: every font must be loaded first (the build's fonts phase, C's verify).
//     Any other refused write is a ctx.failure(rec.i, prop, message), and the rest is still written.
//
//   IR.textFont(ctx, font) -> { family, style } | null
//     The font a text is written with: the font itself, or the fallback when ctx.S.fonts marks it
//     "sub". The builder counts FONT_SUBSTITUTED with it, per node and per font.
var TEXT_ORDER = ["fontSize", "textCase", "textDecoration", "letterSpacing", "lineHeight", "paragraphIndent",
  "paragraphSpacing", "listSpacing", "textAlignHorizontal", "textAlignVertical", "textTruncation", "maxLines",
  "leadingTrim", "hangingPunctuation", "hangingList"];
var RANGE_SETTERS = { fontName: "setRangeFontName", fontSize: "setRangeFontSize", fills: "setRangeFills",
  textCase: "setRangeTextCase", textDecoration: "setRangeTextDecoration", letterSpacing: "setRangeLetterSpacing",
  lineHeight: "setRangeLineHeight", hyperlink: "setRangeHyperlink", listOptions: "setRangeListOptions",
  indentation: "setRangeIndentation", listSpacing: "setRangeListSpacing", paragraphIndent: "setRangeParagraphIndent",
  paragraphSpacing: "setRangeParagraphSpacing" };
// Range fields that are style references: not written in M1 (styles land in M2b).
var RANGE_NOT_WRITTEN = ["fillStyle", "textStyle"];

function msgOf(e) { return String((e && e.message) || e); }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

IR.textFont = function (ctx, font) {
  if (!font || typeof font !== "object") return null;
  var key = String(font.family) + "|" + String(font.style);
  if (ctx.S.fonts[key] === "sub") {
    var st = ctx.task && ctx.task.settings;
    var fb = st && st.fallbackFont ? st.fallbackFont : PXF_TASK.TASK_SETTING_DEFAULTS.fallbackFont;
    return { family: String(fb.family), style: String(fb.style) };
  }
  return { family: String(font.family), style: String(font.style) };
};

// What the builder's coverage test reads: the text props and range fields this file writes.
IR.textWrites = { props: ["fontName", "characters"].concat(TEXT_ORDER, ["textAutoResize", "textRanges"]),
  rangeFields: Object.keys(RANGE_SETTERS), rangeNotWritten: RANGE_NOT_WRITTEN.slice() };

IR.writeTextProps = function (ctx, node, rec) {
  var kinds = PXF_PROPS.KNOWN_PROPS.TEXT;
  var i = rec && rec.i !== undefined ? rec.i : null;
  // 1, 2: not caught. An unloaded font throws here, as the contract says.
  var fn = IR.textFont(ctx, ctx.prop(rec, "fontName"));
  if (!fn) throw new Error("IR.writeTextProps: record " + i + " has no fontName");
  node.fontName = fn;
  var chars = ctx.prop(rec, "characters");
  node.characters = chars === undefined || chars === null ? "" : String(chars);

  // 3: the other text props, DEFAULTS included.
  var truncation = ctx.prop(rec, "textTruncation");
  for (var t = 0; t < TEXT_ORDER.length; t++) {
    var p = TEXT_ORDER[t];
    if (!has(kinds, p)) continue;
    var v = ctx.prop(rec, p);
    if (v === undefined) continue;
    if (p === "maxLines" && truncation !== "ENDING") continue;
    try { node[p] = v; } catch (e) { ctx.failure(i, p, msgOf(e)); }
  }

  // 4: ranges, after every node-level write that would reset them.
  var ranges = rec && rec.props && Array.isArray(rec.props.textRanges) ? rec.props.textRanges : [];
  for (var r = 0; r < ranges.length; r++) {
    var rg = ranges[r], fields = rg && rg.fields ? rg.fields : {};
    var keys = Object.keys(fields);
    // fontName first, so the range's later writes are laid out with the range's own font.
    keys.sort(function (a, b) { return (a === "fontName" ? 0 : 1) - (b === "fontName" ? 0 : 1); });
    for (var q = 0; q < keys.length; q++) {
      var k = keys[q];
      if (RANGE_NOT_WRITTEN.indexOf(k) >= 0) continue;
      if (!has(RANGE_SETTERS, k)) { ctx.failure(i, "textRanges[" + r + "]." + k, "no setRange call for this field"); continue; }
      var setter = RANGE_SETTERS[k];
      var val = PXF_SCHEMA.INTERNED_PROPS.indexOf(k) >= 0 ? ctx.value(fields[k]) : fields[k];
      if (k === "fontName") { node[setter](rg.start, rg.end, IR.textFont(ctx, val)); continue; }
      if (k === "fills" && typeof IR.mapPaints === "function") val = IR.mapPaints(ctx, val, i);
      try { node[setter](rg.start, rg.end, val); }
      catch (e2) { ctx.failure(i, "textRanges[" + r + "]." + k, msgOf(e2)); }
    }
  }

  // 5: last, so nothing written after it resizes the box again.
  var auto = ctx.prop(rec, "textAutoResize");
  if (auto !== undefined) { try { node.textAutoResize = auto; } catch (e3) { ctx.failure(i, "textAutoResize", msgOf(e3)); } }
};
