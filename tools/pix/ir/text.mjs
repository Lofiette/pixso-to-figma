// Text records (docs/M1.md D8, §6 A "Text" and "PIX_CORRUPT on bad text data"; §15.14).
//
// - characters from textData; per-code-point characterStyleIDs become ranges in UTF-16 units of
//   characters (Figma's indexing) that hold only the fields that differ from the node;
// - paragraphStyle list entries become listOptions and indentation range fields, hyperlinks a
//   hyperlink field; Pixso puts paragraphSpacing between list items too, where Figma puts
//   listSpacing, so a text with list paragraphs carries listSpacing = paragraphSpacing
//   (stats.text.listSpacingFromParagraph); a list that starts past 1 (listStartOffset) has no Figma
//   plugin value: SOURCE_FEATURE_UNSUPPORTED "list start number" (§15.14, C09);
// - PERCENT is stored by Pixso as a fraction: 1.2 means 120 %. A line height of PERCENT 0, or any RAW,
//   is drawn at the font's natural line height (the stored baselines say so: K, M), Figma's AUTO; every
//   other PERCENT is the fraction × 100, PERCENT 1 included: 100 %, counted (stats.text.percentOne).
//   Review R3 read PERCENT 1 as AUTO from the stored baselines[].lineHeight, which holds the natural
//   height in one file; the box and the first baseline of every PERCENT 1 text in the five measured
//   files are the 100 % layout (§15.14, C08);
// - a text bound to a text style is drawn with the style's fontSize (absent: 14), lineHeight,
//   letterSpacing, textCase, textDecoration, paragraphIndent and paragraphSpacing where the style has
//   them, whatever the node stores (P's glyphs and baselines agree with the style on every text where
//   the two differ; U's six status labels inherit UPPER from their style and Pixso drew capitals,
//   §15.14, C05); its font is the node's unless only the style's is in textData.fontMetaData (the fonts
//   Pixso laid the text out in). Each node whose own value is overridden is counted
//   (stats.text.styleValueOverridden; part F, review R2). With no style a missing fontName is counted;
// - a size neither the node nor its style gives is 14 (the table of absent defaults), unless every
//   stored glyph of the base style agrees on another (Pixso draws the stored glyphs); a letter spacing
//   neither gives is 0, unless at least three pairs of consecutive glyphs on one baseline agree on
//   another gap (the gap is the stored letter spacing, or 0, in all but 2 of 31 930 such texts in the
//   five measured files: textProps below). Each is counted
//   (stats.text.fontSizeFromGlyphs, letterSpacingFromGlyphs) and noted TEXT_VALUE_FROM_GLYPHS (§15.14, C07);
// - number forms (fontVariantNumeric*), the sub/superscript position and OpenType features
//   (toggledOnOTFeatures) have no Figma plugin value (TextNode.openTypeFeatures is read-only): each
//   counted once per record, on the node, its text style or a style entry, as SOURCE_FEATURE_UNSUPPORTED
//   "fontVariantNumeric", "fontVariantPosition", "OpenType features" (review R8; the style since §15.14, C04);
// - lines = the stored baselines Pixso draws: all of them, or for a text Pixso cut (ENDING, a
//   truncationStartIndex) the ones that start before the cut, at least one (stats.text.truncatedLines);
//   a buildable text with none gets TEXT_LINES_UNKNOWN;
// - firstLineShift: how far (px, positive down) Pixso drew the first baseline from where half-leading
//   puts it in this box, written only where that is more than half a pixel (firstLineShift below;
//   stats.text.firstLine). The builder's textTrim reads it.
//
// Text data is checked before any of it is used: a glyph blob index out of range, a glyph path that
// ends inside an op, a style id that is not in styleOverrideTable, a baseline whose first or end
// character is outside the text, or more characterStyleIDs than code points, each throw PIX_CORRUPT -
// except trailing ids of the base style (0) past the last code point, which Pixso writes now and then
// (1 of 14 427 texts in the Сова-based UI kit) and which style nothing: they are dropped and counted
// (stats.text.trailingBaseStyleIds). A text whose glyph outlines are not glyphs is noted
// TEXT_GLYPHS_INVALID (glyphClass below).
import { CODE } from "../../ir/schema.mjs";
import { corrupt, decodePath } from "../../kiwi.mjs";
import * as E from "./enums.mjs";
import { paintsOf } from "./paints.mjs";
import { r2, r6, isFin, codePointOffsets, guidStr, guidSet } from "./util.mjs";

const FALLBACK_FONT = { family: "Inter", style: "Regular" };

export function numberOf(cx, msg, num, kind) {
  if (!num) return undefined;
  const unit = cx.en("Number", "units")(num.units);
  const v = isFin(num.value) ? num.value : 0;
  if (kind === "lineHeight") {
    if (unit === "PIXELS") return { unit: "PIXELS", value: r2(v) };
    if (unit === "PERCENT") {
      if (v === 0) return { unit: "AUTO" };
      if (Math.abs(v - 1) < 1e-6) cx.stats.text.percentOne++;
      return { unit: "PERCENT", value: r2(v * 100) };
    }
    if (unit === "RAW") { cx.stats.text.rawLineHeight++; return { unit: "AUTO" }; }
    return { unit: "AUTO" };
  }
  if (unit === "PIXELS") return { unit: "PIXELS", value: r2(v) };
  if (unit === "PERCENT" || unit === "RAW") return { unit: "PERCENT", value: r2(v * 100) };
  return { unit: "PIXELS", value: 0 };
}

const fontOf = (f) => (f && typeof f.family === "string" && typeof f.style === "string" ? { family: f.family, style: f.style } : null);
function hyperlinkOf(h) {
  if (!h) return undefined;
  if (h.url) return { type: "URL", value: h.url };
  if (guidSet(h.guid)) return { type: "NODE", value: guidStr(h.guid) };
  return undefined;
}

// A glyph blob that is not a glyph outline (§15.14, C06). Glyphs are stored in em (the cap of a Latin
// capital at about -0.7), and every real one in the five measured files spans at most 1.2 em. In U,
// 478 texts point their glyph slots at blobs that are not glyphs, through a stale table: one reaching
// past 1e6 em, after which Pixso draws no part of the text (and an export of a root no ancestor clips
// comes back empty); one wider or taller than 3 em, a slab Pixso draws where the glyph should be; one
// with no extent for a visible character, which draws nothing. Figma builds the characters.
const GLYPH_FAR = 1e6, GLYPH_WIDE = 3, GLYPH_NONE = 1e-20;
const INVISIBLE = /^[\s\p{Cc}\p{Cf}]$/u;
function glyphClass(cmds) {
  let n = 0, far = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cmds) for (const p of c.pts) {
    n++;
    far = Math.max(far, Math.abs(p[0]), Math.abs(p[1]));
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  if (!(far <= GLYPH_FAR)) return "drops-text";
  if (!n || far < GLYPH_NONE) return "empty";
  if (x1 - x0 > GLYPH_WIDE || y1 - y0 > GLYPH_WIDE) return "slab";
  return null;
}
const GLYPH_CLASSES = ["drops-text", "slab", "empty"];

// The checks of §6 A, on the stored text data, before anything is read from it.
export function checkTextData(cx, n) {
  const td = n.textData;
  if (!td) return;
  const s = td.characters || "";
  const offs = codePointOffsets(s);
  const cps = offs.length - 1;
  const where = "text " + guidStr(n.guid);
  const ids = td.characterStyleIDs || [];
  if (ids.length > cps) {
    if (ids.slice(cps).some((id) => id !== 0)) throw corrupt(where + " has " + ids.length + " characterStyleIDs for " + cps + " code points");
    cx.stats.text.trailingBaseStyleIds++;
  }
  const table = new Set((td.styleOverrideTable || []).map((e) => e.styleID));
  for (const id of ids) if (id !== 0 && !table.has(id)) throw corrupt(where + " uses style id " + id + ", which is not in its styleOverrideTable");
  for (const b of td.baselines || []) {
    const f = b.firstCharacter === undefined ? 0 : b.firstCharacter, e = b.endCharacter === undefined ? 0 : b.endCharacter;
    if (!(f >= 0 && e >= f && e <= s.length)) throw corrupt(where + " has a baseline over characters " + f + "-" + e + ", outside its " + s.length);
  }
  const classes = cx.textCache.glyphClass, found = {};
  let glyphs = 0;
  const chars = Array.from(s);
  for (const g of td.glyphs || []) {
    if (g.blobIndex === undefined) continue;
    if (!(g.blobIndex >= 0 && g.blobIndex < cx.pix.blobs.length)) throw corrupt(where + " has a glyph in blob " + g.blobIndex + "; there are " + cx.pix.blobs.length);
    if (!cx.glyphChecked.has(g.blobIndex)) {
      const cmds = decodePath(cx.pix.blobs[g.blobIndex]);
      cx.glyphChecked.add(g.blobIndex);
      if (!classes.has(g.blobIndex)) classes.set(g.blobIndex, glyphClass(cmds));
    }
    glyphs++;
    const cls = classes.get(g.blobIndex);
    // A space, a control or a format character (a soft hyphen, a direction mark) has no outline.
    if (!cls || (cls === "empty" && INVISIBLE.test(chars[g.firstCharacter || 0] || " "))) continue;
    found[cls] = (found[cls] || 0) + 1;
  }
  const kinds = GLYPH_CLASSES.filter((c) => found[c]);
  if (kinds.length) {
    cx.stats.text.glyphsInvalid[kinds[0]]++;
    const bad = kinds.reduce((t, c) => t + found[c], 0);
    cx.note(CODE.TEXT_GLYPHS_INVALID, kinds[0] + ": " + bad + " of " + glyphs + " stored glyphs are not glyph outlines (" +
      kinds.map((c) => c + " " + found[c]).join(", ") + "); Pixso draws the stored outlines, Figma the characters");
  }
}

// The fields of a style-table entry (or the node) that a range may carry, as IR values.
function rangeSource(cx, src) {
  const o = {};
  if (src.fontName) { const f = fontOf(src.fontName); if (f) o.fontName = f; }
  if (isFin(src.fontSize)) o.fontSize = r2(src.fontSize);
  if (src.fillPaints) o.fills = paintsOf(cx, src.fillPaints);
  if (src.letterSpacing) o.letterSpacing = numberOf(cx, "Number", src.letterSpacing, "letterSpacing");
  if (src.lineHeight) o.lineHeight = numberOf(cx, "Number", src.lineHeight, "lineHeight");
  const tc = E.TEXT_CASE[cx.en("TextStyleData", "textCase")(src.textCase)];
  if (tc) o.textCase = tc;
  const deco = E.TEXT_DECORATION[cx.en("TextStyleData", "textDecoration")(src.textDecoration)];
  if (deco) o.textDecoration = deco;
  const hl = hyperlinkOf(src.hyperlink);
  if (hl) o.hyperlink = hl;
  if (isFin(src.paragraphIndent)) o.paragraphIndent = r2(src.paragraphIndent);
  if (isFin(src.paragraphSpacing)) o.paragraphSpacing = r2(src.paragraphSpacing);
  return o;
}

// The stored glyphs the node's own values lay out: those whose character's style entry sets none of
// `fields`.
function baseGlyphs(td, fields) {
  const ids = td.characterStyleIDs || [];
  const table = new Map((td.styleOverrideTable || []).map((e) => [e.styleID, e]));
  return (td.glyphs || []).filter((g) => {
    const id = ids[g.firstCharacter || 0] || 0;
    const e = id ? table.get(id) : null;
    return !(e && fields.some((f) => e[f] !== undefined && e[f] !== null));
  });
}
// The one size every base glyph is at, or null.
function glyphSize(td) {
  const gs = baseGlyphs(td, ["fontSize"]).filter((g) => isFin(g.fontSize) && g.fontSize > 0);
  if (!gs.length || gs.some((g) => Math.abs(g.fontSize - gs[0].fontSize) > 0.01)) return null;
  return r2(gs[0].fontSize);
}
// The one gap between consecutive base glyphs on one baseline (the next glyph's x past this one's
// advance), from at least three pairs that agree within 0.01 px, when it is not 0; or null.
function glyphGap(td) {
  const gs = baseGlyphs(td, ["letterSpacing", "fontSize", "fontName"]);
  const gaps = [];
  for (let k = 0; k + 1 < gs.length; k++) {
    const a = gs[k], b = gs[k + 1];
    if ((b.firstCharacter || 0) !== (a.firstCharacter || 0) + 1 || !a.position || !b.position || !isFin(a.advance)) continue;
    if (Math.abs(a.position.y - b.position.y) > 0.01) continue;
    gaps.push(b.position.x - a.position.x - a.advance);
  }
  if (gaps.length < 3 || Math.max(...gaps) - Math.min(...gaps) > 0.01) return null;
  const gap = gaps.reduce((t, x) => t + x, 0) / gaps.length;
  return Math.abs(gap) < 0.01 ? null : r2(gap);
}

// The text props of a TEXT record. `put` writes a prop the type knows; `node` holds the values the
// node itself was given, so ranges keep only what differs.
export function textProps(cx, n, put) {
  const td = n.textData || {};
  const chars = td.characters || "";
  const style = guidSet(n.inheritTextStyleID) ? cx.byGuid.get(guidStr(n.inheritTextStyleID)) : null;
  put("characters", chars);
  // The style draws (review R2): its size (absent 14), line height, letter spacing, case, decoration
  // and paragraph fields over the node's; the font the node's unless only the style's is among the
  // fonts Pixso laid the text out in.
  const ownFont = fontOf(n.fontName), styleFont = style && fontOf(style.fontName);
  let font = ownFont || styleFont, overridden = false;
  if (ownFont && styleFont && (ownFont.family !== styleFont.family || ownFont.style !== styleFont.style)) {
    const listed = new Set((td.fontMetaData || []).map((m) => m && m.key ? m.key.family + "|" + m.key.style : ""));
    if (listed.has(styleFont.family + "|" + styleFont.style) && !listed.has(ownFont.family + "|" + ownFont.style)) { font = styleFont; overridden = true; }
  }
  if (!n.fontName && font) cx.stats.text.fontFromStyle++;
  if (!font) { font = FALLBACK_FONT; cx.feature("text without a font name"); }
  put("fontName", font);
  // Values the node and its style leave out, taken from the stored glyphs Pixso draws (C07: on U,
  // 2026-10-07, 2 of the 6 408 texts with no size of their own or from a style have every glyph at 10
  // and 18; the other 6 402 at 14, 4 with no glyphs).
  const fromGlyphs = [];
  const absentSize = style ? !isFin(style.fontSize) : !isFin(n.fontSize);
  let size = style ? (isFin(style.fontSize) ? style.fontSize : 14) : isFin(n.fontSize) ? n.fontSize : 14;
  if (absentSize) {
    const gs = glyphSize(td);
    if (gs !== null && gs !== 14) { size = gs; cx.stats.text.fontSizeFromGlyphs++; fromGlyphs.push("fontSize " + gs + " (absent: 14)"); }
  }
  if (style && isFin(n.fontSize) && r2(n.fontSize) !== r2(size)) overridden = true;
  put("fontSize", r2(size));
  const base = { fontName: font, fontSize: r2(size) };
  const pick = (f) => (style && style[f] ? style[f] : n[f]);
  let ls = numberOf(cx, "Number", pick("letterSpacing"), "letterSpacing");
  // The gap between consecutive glyphs on one baseline is the letter spacing in 31 930 texts of the five
  // measured files with three or more such pairs (the stored one, PIXELS or PERCENT, or 0 where none is
  // stored), and differs from it in two: U's one text with no spacing stored and its glyphs 0.4 px
  // apart, read here, and one in M with -1 % stored and none drawn, which is not (a stored value stands).
  if (!ls) {
    const gap = glyphGap(td);
    if (gap !== null) { ls = { unit: "PIXELS", value: gap }; cx.stats.text.letterSpacingFromGlyphs++; fromGlyphs.push("letterSpacing " + gap + " px (absent: 0)"); }
  }
  if (ls) { put("letterSpacing", ls); base.letterSpacing = ls; }
  if (fromGlyphs.length) cx.note(CODE.TEXT_VALUE_FROM_GLYPHS, fromGlyphs.join("; ") + "; the stored glyphs, which Pixso draws");
  const lh = numberOf(cx, "Number", pick("lineHeight"), "lineHeight");
  if (lh) { put("lineHeight", lh); base.lineHeight = lh; }
  for (const f of ["letterSpacing", "lineHeight"]) if (style && style[f] && n[f] && (n[f].value !== style[f].value || n[f].units !== style[f].units)) overridden = true;
  for (const f of ["textCase", "textDecoration", "paragraphIndent", "paragraphSpacing"]) if (style && style[f] && n[f] !== undefined && n[f] !== null && n[f] !== style[f]) overridden = true;
  if (overridden) cx.stats.text.styleValueOverridden++;
  base.fills = paintsOf(cx, n.fillPaints);
  const indent = pick("paragraphIndent"), spacing = pick("paragraphSpacing");
  if (isFin(indent)) { put("paragraphIndent", r2(indent)); base.paragraphIndent = r2(indent); }
  if (isFin(spacing)) { put("paragraphSpacing", r2(spacing)); base.paragraphSpacing = r2(spacing); }
  // Pixso spaces list items by paragraphSpacing, Figma by listSpacing (C09: on U, the one list text
  // with a paragraph spacing steps its stored baselines by line height + 16 between list items too).
  const listed = (td.paragraphStyle || []).some((ps) => ps && E.LIST_TYPE[cx.en("ParagraphStyle", "listType")(ps.listType)]);
  if (listed && base.paragraphSpacing > 0) { put("listSpacing", base.paragraphSpacing); cx.stats.text.listSpacingFromParagraph++; }
  const ah = E.TEXT_ALIGN_H[cx.en("PixsoNode", "textAlignHorizontal")(n.textAlignHorizontal)];
  if (ah) put("textAlignHorizontal", ah);
  const av = E.TEXT_ALIGN_V[cx.en("PixsoNode", "textAlignVertical")(n.textAlignVertical)];
  if (av) put("textAlignVertical", av);
  put("textAutoResize", E.TEXT_AUTO_RESIZE[cx.en("PixsoNode", "textAutoResize")(n.textAutoResize)] || "NONE");
  // Style definitions are PixsoNode records too, so one enum reader serves both.
  const tc = E.TEXT_CASE[cx.en("PixsoNode", "textCase")(pick("textCase"))];
  if (tc) { put("textCase", tc); base.textCase = tc; }
  const deco = E.TEXT_DECORATION[cx.en("PixsoNode", "textDecoration")(pick("textDecoration"))];
  if (deco) { put("textDecoration", deco); base.textDecoration = deco; }
  const trunc = E.TEXT_TRUNCATION[cx.en("PixsoNode", "textTruncation")(n.textTruncation)];
  if (trunc) put("textTruncation", trunc);
  if (trunc === "ENDING" && Number.isInteger(n.maxLines) && n.maxLines > 0) put("maxLines", n.maxLines);
  const lt = E.LEADING_TRIM[cx.en("PixsoNode", "leadingTrim")(n.leadingTrim)];
  if (lt) put("leadingTrim", lt);
  if (n.hangingPunctuation) put("hangingPunctuation", true);
  if (n.hangingList) put("hangingList", true);
  if ((n.fontVariations || []).length) cx.feature("fontVariations");
  // Number forms, the sub/superscript position and OpenType features have no Figma plugin value:
  // counted once per record, on the node, its text style or any of its style entries (review R8; C04:
  // on U, 63 texts have their tabular figures from their style alone).
  const set = (src, msg, fields) => fields.some((f) => {
    if (src[f] === undefined || src[f] === null) return false;
    const v = cx.en(msg, f)(src[f]);
    return v === undefined ? !!src[f] : v !== "NORMAL";
  });
  const anyOf = (fields) => set(n, "PixsoNode", fields) || (!!style && set(style, "PixsoNode", fields)) || (td.styleOverrideTable || []).some((e) => set(e, "TextStyleData", fields));
  if (anyOf(["fontVariantNumericFigure", "fontVariantNumericSpacing", "fontVariantNumericFraction"])) cx.feature("fontVariantNumeric");
  if (anyOf(["fontVariantPosition"])) cx.feature("fontVariantPosition");
  if ([n, style].some((x) => x && (x.toggledOnOTFeatures || []).length) || (td.styleOverrideTable || []).some((e) => (e.toggledOnOTFeatures || []).length)) cx.feature("OpenType features");
  const nodeLink = hyperlinkOf(n.hyperlink);

  const ranges = textRanges(cx, n, chars, base, nodeLink);
  if (ranges.length) put("textRanges", ranges);
  const bl = td.baselines || [];
  if (bl.length) put("lines", drawnLines(cx, td, bl, trunc));
  else cx.note(CODE.TEXT_LINES_UNKNOWN, "no stored baselines");
  if (lt === "CAP_HEIGHT") cx.stats.text.firstLine.trimmedInSource++;
  else if (bl.length) put("firstLineShift", firstLineShift(cx, n, td, { font, size: r2(size), lh: lh || { unit: "AUTO" }, av: av || "TOP", trunc }));
  // Fonts of the ranges are listed with the node's.
  cx.font(font);
}

// The lines Pixso draws: every stored baseline, or, for a text it cut with an ellipsis (ENDING and a
// truncationStartIndex, U: 28 texts), the lines that start before the cut, at least one. Pixso stores
// the baselines of every line, drawn or not (§15.14, C03), and VERIFY compares the lines Figma draws.
function drawnLines(cx, td, bl, trunc) {
  const cut = td.truncationStartIndex;
  if (trunc !== "ENDING" || !(Number.isInteger(cut) && cut >= 0)) return bl.length;
  cx.stats.text.truncatedLines++;
  return Math.max(1, bl.filter((b) => (b.firstCharacter || 0) < cut).length);
}

// The natural line height (per px of size) of a font, from the text's own fontMetaData, or from any
// text in the file that lays the font out (some entries store 0).
function naturalLineHeight(cx, td, font) {
  const own = (td.fontMetaData || []).find((m) => m && m.key && m.key.family === font.family && m.key.style === font.style && isFin(m.fontLineHeight) && m.fontLineHeight > 0);
  if (own) return own.fontLineHeight;
  const C = cx.textCache;
  if (!C.lineHeights) {
    C.lineHeights = new Map();
    for (const x of cx.pix.nodes) for (const m of (x.textData && x.textData.fontMetaData) || []) {
      if (!(m && m.key && isFin(m.fontLineHeight) && m.fontLineHeight > 0)) continue;
      const k = m.key.family + "|" + m.key.style;
      if (!C.lineHeights.has(k)) C.lineHeights.set(k, m.fontLineHeight);
    }
  }
  return C.lineHeights.get(font.family + "|" + font.style) || null;
}

// Where Pixso drew the first baseline against where half-leading puts it (§15.14, C01, C02). Figma lays
// an untrimmed line out with half-leading: its baseline sits (lineHeight - natural) / 2 + ascent below
// the line's top, and a box of height H puts a block of B px at 0 (TOP), (H - B) / 2 (CENTER) or H - B
// (BOTTOM). Pixso stores the first baseline it drew, with that in-line offset rounded to a whole
// pixel. Measured on U, 2026-10-07: 13 532 of the 13 539 texts this can be checked on are within half a
// pixel of that place, under every line-height unit; the other 7 sit 1.86 px higher, labels in 9 px
// boxes where a cap-height trim puts them. M, P and two more libraries have none higher (and one 0.69 px
// lower). Returns the shift (px, positive down) where it is more than half a pixel, else undefined;
// counted in stats.text.firstLine (halfLeading, shifted, unknown: no metrics, a first character laid out
// in another size, font or line height, or a cut text; trimmedInSource).
function firstLineShift(cx, n, td, o) {
  const S = cx.stats.text.firstLine;
  const bl = td.baselines, b0 = bl[0], bN = bl[bl.length - 1];
  const ids = td.characterStyleIDs || [];
  const e0 = ids[0] ? (td.styleOverrideTable || []).find((e) => e.styleID === ids[0]) : null;
  const g0 = (td.glyphs || [])[0];
  const cut = o.trunc === "ENDING" && Number.isInteger(td.truncationStartIndex) && td.truncationStartIndex >= 0;
  const nat = naturalLineHeight(cx, td, o.font);
  if (cut || !nat || (e0 && (isFin(e0.fontSize) || e0.fontName || e0.lineHeight)) || (g0 && isFin(g0.fontSize) && Math.abs(g0.fontSize - o.size) > 0.01) ||
    !isFin(b0.lineAscent) || !(b0.position && isFin(b0.position.y) && bN.position && isFin(bN.position.y)) || !(n.size && isFin(n.size.y))) { S.unknown++; return undefined; }
  const N = nat * o.size;
  const L = o.lh.unit === "PIXELS" ? o.lh.value : o.lh.unit === "PERCENT" ? o.lh.value / 100 * o.size : N;
  const B = bN.position.y - b0.position.y + L;
  const H = n.size.y;
  const top = o.av === "CENTER" ? (H - B) / 2 : o.av === "BOTTOM" ? H - B : 0;
  const shift = r2(b0.position.y - (top + (L - N) / 2 + b0.lineAscent));
  if (Math.abs(shift) <= 0.5) { S.halfLeading++; return undefined; }
  S.shifted++;
  return shift;
}

// Ranges in UTF-16 units: consecutive code points with the same style id and the same list
// paragraph are one run; a run's fields are what its style entry and its paragraph change.
function textRanges(cx, n, chars, base, nodeLink) {
  const td = n.textData || {};
  const offs = codePointOffsets(chars);
  const cps = offs.length - 1;
  if (!cps) return [];
  const ids = td.characterStyleIDs || [];
  const table = new Map((td.styleOverrideTable || []).map((e) => [e.styleID, e]));
  const fieldCache = new Map();
  const canon = (v) => JSON.stringify(v);
  const fieldsOfId = (id) => {
    if (fieldCache.has(id)) return fieldCache.get(id);
    const out = {};
    const e = id ? table.get(id) : null;
    if (e) {
      const src = rangeSource(cx, e);
      for (const k of Object.keys(src)) {
        if (k === "hyperlink") { if (canon(src.hyperlink) !== canon(nodeLink)) out.hyperlink = src.hyperlink; continue; }
        if (canon(src[k]) !== canon(base[k] === undefined ? defaultOf(k) : base[k])) out[k] = src[k];
      }
    }
    fieldCache.set(id, out);
    return out;
  };
  // Paragraph of each code point, and the list fields of each paragraph.
  const paras = td.paragraphStyle || [];
  const paraOf = new Array(cps);
  let p = 0;
  for (let k = 0; k < cps; k++) { paraOf[k] = p; if (chars.charCodeAt(offs[k]) === 10) p++; }
  let startsLate = 0;
  const listOf = (pi) => {
    const ps = paras[pi];
    if (!ps) return null;
    const t = E.LIST_TYPE[cx.en("ParagraphStyle", "listType")(ps.listType)];
    if (!t) return null;
    const o = { listOptions: { type: t } };
    if (ps.indentationLevel) o.indentation = ps.indentationLevel;
    if (ps.listStartOffset > 0 && !startsLate) startsLate = ps.listStartOffset + 1;
    return o;
  };
  const runs = [];
  for (let k = 0; k < cps; k++) {
    const id = k < ids.length ? ids[k] : 0;
    const list = listOf(paraOf[k]);
    const f = Object.assign({}, fieldsOfId(id), list || {});
    // A link on the whole node is carried on every range (Figma keeps hyperlinks on ranges).
    if (nodeLink && !f.hyperlink) f.hyperlink = nodeLink;
    const key = canon(f);
    const last = runs[runs.length - 1];
    if (last && last.key === key && last.end === offs[k]) last.end = offs[k + 1];
    else runs.push({ key, start: offs[k], end: offs[k + 1], fields: f });
  }
  // Figma's list options have a type and no start number (C09: U's one such list starts at 5).
  if (startsLate) cx.feature("list start number", "a list starts at " + startsLate + "; Figma numbers it from 1");
  const out = [];
  for (const r of runs) {
    if (!Object.keys(r.fields).length) continue;
    const fields = {};
    for (const k of Object.keys(r.fields).sort()) {
      if (k === "fontName") cx.font(r.fields.fontName);
      fields[k] = cx.rangeValue(k, r.fields[k]);
    }
    out.push({ start: r.start, end: r.end, fields });
  }
  return out;
}

const RANGE_DEFAULTS = { letterSpacing: { unit: "PIXELS", value: 0 }, lineHeight: { unit: "AUTO" }, textCase: "ORIGINAL",
  textDecoration: "NONE", paragraphIndent: 0, paragraphSpacing: 0, fills: [] };
const defaultOf = (k) => RANGE_DEFAULTS[k];

export { FALLBACK_FONT };
