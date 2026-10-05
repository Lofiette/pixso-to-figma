// Text line counting (part C). docs/M1.md D8, §6 C. Bundled as (function (IR) { … })(PXF_IR) after
// common.js. Nothing here names a timer, and countLines awaits nothing: ctx.measure is synchronous.
//
// CONTRACT:
//
//   IR.countLines(ctx, node, rec) -> { lines: integer >= 0, approx: boolean }
//     Counts the lines of the BUILT text node `node` (IR record `rec`) after a settle: writes rec onto
//     one reused scratch text node through IR.writeTextProps (part B's, the one text writer) at node's
//     current width, with textAutoResize HEIGHT and truncation and leading trim off, and takes
//     round((H - paragraphSpacing * (paragraphs - 1)) / L), where L is the line height in pixels
//     (PIXELS; PERCENT / 100 x fontSize; AUTO: the one-line height measured once per font and size on
//     the same scratch node, kept for the session). paragraphs = the "\n"-separated parts of
//     characters. With ENDING truncation the count is capped at maxLines. approx is true when ranges
//     mix line heights (a range sets lineHeight or paragraphSpacing, or sets fontSize or fontName
//     while the line height is AUTO or PERCENT), or when L is not a positive number.
//     The AUTO measurement writes the font writeTextProps writes: the record's, or
//     task.settings.fallbackFont when ctx.S.fonts marks the record's font "sub". Every font must
//     already be loaded (the build's fonts phase, or VERIFY's own loading).
//     ctx.measure(node, rec) calls this, unless a test's host.measure replaces it.
//
//   IR.prepareMeasure(ctx) -> Promise
//     Optional, before an op's first countLines: finds the service page (a page stamped pxPage
//     "m1-service") or creates it, loads it (dynamic-page), and makes the scratch node there.
//     countLines does the same without loading when it was not called.
//
//   IR.dropScratch(ctx) -> undefined
//     Removes the scratch node, and the service page when this file created it and it is empty again;
//     sets ctx.S.scratchTextId to null. The op that measured calls it at its end: VERIFY does, in a
//     finally; part B's build op must, after its MEASURE phase.
//
// The scratch node is stamped pxScratch "1", shared and private (ctx.stamp), so code.js's sweep finds
// one an interrupted op left; its id is ctx.S.scratchTextId. It is never a task's node, and nothing
// else is touched.

var SCRATCH = new WeakMap();   // ctx.S (the session) -> { node, page, madePage, auto: { "family|style|size": px } }
var SERVICE = PXF_TASK.SERVICE_PAGE_GUID;

function scratchOf(ctx) {
  var s = SCRATCH.get(ctx.S);
  if (!s) { s = { node: null, page: null, madePage: false, auto: {} }; SCRATCH.set(ctx.S, s); }
  return s;
}

function servicePage(ctx, s) {
  if (s.page && !s.page.removed) return s.page;
  var pages = ctx.figma.root.children;
  for (var p = 0; p < pages.length; p++) {
    if (ctx.stampOf(pages[p], "pxPage") === SERVICE) { s.page = pages[p]; s.madePage = false; return s.page; }
  }
  var page = ctx.figma.createPage();
  page.name = "pix2fig service";
  ctx.stamp(page, "pxPage", SERVICE);
  s.page = page;
  s.madePage = true;
  return page;
}

function makeScratch(ctx, s) {
  if (s.node && !s.node.removed) return s.node;
  var page = servicePage(ctx, s);
  var t = ctx.figma.createText();
  // Figma puts a new node on the current page. Under dynamic-page a page that is not loaded may
  // refuse it; the scratch then stays where it was made, stamped, so dropScratch and the sweep find it.
  try { if (t.parent !== page) page.appendChild(t); }
  catch (e) { ctx.log("countLines: the scratch stays on the current page (" + ((e && e.message) || e) + ")"); }
  t.name = "pix2fig scratch";
  ctx.stamp(t, "pxScratch", "1");
  s.node = t;
  ctx.S.scratchTextId = t.id;
  return t;
}

IR.prepareMeasure = async function (ctx) {
  var s = scratchOf(ctx);
  var page = servicePage(ctx, s);
  if (typeof page.loadAsync === "function") await page.loadAsync();
  makeScratch(ctx, s);
};

IR.dropScratch = function (ctx) {
  var s = SCRATCH.get(ctx.S);
  if (s && s.node) {
    try { if (!s.node.removed) s.node.remove(); }
    catch (e) { ctx.log("countLines: the scratch node could not be removed (" + ((e && e.message) || e) + ")"); }
    s.node = null;
  }
  if (s && s.madePage && s.page) {
    try { if (!s.page.removed && s.page.children.length === 0) s.page.remove(); }
    catch (e2) { ctx.log("countLines: the service page it made could not be removed (" + ((e2 && e2.message) || e2) + ")"); }
    s.page = null;
    s.madePage = false;
  }
  ctx.S.scratchTextId = null;
};

// The font writeTextProps writes for rec: its own, or the fallback when the session substituted it.
function fontOf(ctx, rec) {
  var f = ctx.prop(rec, "fontName");
  if (f && ctx.S.fonts[f.family + "|" + f.style] === "sub") f = ctx.task.settings.fallbackFont;
  return f;
}

// AUTO's one-line height for a font and size, measured once per session on the scratch node.
function autoLine(ctx, s, t, font, size) {
  var key = font.family + "|" + font.style + "|" + size;
  if (IR.util.own(s.auto, key)) return s.auto[key];
  t.fontName = { family: font.family, style: font.style };   // first: every later write lays text out in it
  t.characters = "Hg";
  t.fontSize = size;
  t.lineHeight = { unit: "AUTO" };
  t.leadingTrim = "NONE";
  t.textAutoResize = "WIDTH_AND_HEIGHT";
  var h = t.height;
  s.auto[key] = h;
  return h;
}

function mixedHeights(ranges, unit) {
  for (var k = 0; k < ranges.length; k++) {
    var f = (ranges[k] && ranges[k].fields) || {};
    if (IR.util.own(f, "lineHeight") || IR.util.own(f, "paragraphSpacing")) return true;
    if (unit !== "PIXELS" && (IR.util.own(f, "fontSize") || IR.util.own(f, "fontName"))) return true;
  }
  return false;
}

IR.countLines = function (ctx, node, rec) {
  if (!rec || rec.type !== "TEXT") throw new Error("countLines: record " + (rec ? rec.i : "?") + " is not a TEXT");
  var s = scratchOf(ctx);
  var t = makeScratch(ctx, s);
  var width = node.width;
  var size = ctx.prop(rec, "fontSize");
  var lh = ctx.prop(rec, "lineHeight") || { unit: "AUTO" };
  var unit = lh.unit === "PIXELS" || lh.unit === "PERCENT" ? lh.unit : "AUTO";
  var ranges = rec.props && Array.isArray(rec.props.textRanges) ? rec.props.textRanges : [];
  var approx = mixedHeights(ranges, unit);
  var L;
  if (unit === "PIXELS") L = lh.value;
  else if (unit === "PERCENT") L = lh.value / 100 * size;
  else L = autoLine(ctx, s, t, fontOf(ctx, rec), size);

  IR.writeTextProps(ctx, t, rec);
  t.textTruncation = "DISABLED";
  t.leadingTrim = "NONE";
  t.textAutoResize = "NONE";
  t.resize(width > 0.01 ? width : 0.01, 1);
  t.textAutoResize = "HEIGHT";
  var H = t.height;

  var paragraphs = String(ctx.prop(rec, "characters") || "").split("\n").length;
  var ps = ctx.prop(rec, "paragraphSpacing") || 0;
  var lines;
  if (!(L > 0) || !isFinite(L)) { lines = H > 0 ? 1 : 0; approx = true; }
  else lines = Math.max(0, Math.round((H - ps * (paragraphs - 1)) / L));
  var maxLines = ctx.prop(rec, "maxLines");
  if (ctx.prop(rec, "textTruncation") === "ENDING" && typeof maxLines === "number" && maxLines >= 1 && lines > maxLines) lines = maxLines;
  return { lines: lines, approx: approx };
};
