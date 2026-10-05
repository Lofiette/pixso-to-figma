// Text records (docs/M1.md D8, §6 A "Text" and "PIX_CORRUPT on bad text data").
//
// - characters from textData; per-code-point characterStyleIDs become ranges in UTF-16 units of
//   characters (Figma's indexing) that hold only the fields that differ from the node;
// - paragraphStyle list entries become listOptions and indentation range fields, hyperlinks a
//   hyperlink field;
// - PERCENT is stored by Pixso as a fraction: 1.2 means 120 %. A line height of PERCENT 0 is AUTO, and
//   RAW is a multiplier (PERCENT × 100);
// - a missing fontName (31 in M) and fontSize come from the text style the node names by guid;
//   failing that, fontSize is 14 (the table of absent defaults) and a missing font is counted;
// - lines = baselines.length; a buildable text with none gets TEXT_LINES_UNKNOWN.
//
// Text data is checked before any of it is used: a glyph blob index out of range, a glyph path that
// ends inside an op, a style id that is not in styleOverrideTable, a baseline whose first or end
// character is outside the text, or more characterStyleIDs than code points, each throw PIX_CORRUPT.
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
    if (unit === "PERCENT") return v === 0 ? { unit: "AUTO" } : { unit: "PERCENT", value: r2(v * 100) };
    if (unit === "RAW") { cx.stats.text.rawLineHeight++; return v === 0 ? { unit: "AUTO" } : { unit: "PERCENT", value: r2(v * 100) }; }
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

// The checks of §6 A, on the stored text data, before anything is read from it.
export function checkTextData(cx, n) {
  const td = n.textData;
  if (!td) return;
  const s = td.characters || "";
  const offs = codePointOffsets(s);
  const cps = offs.length - 1;
  const where = "text " + guidStr(n.guid);
  const ids = td.characterStyleIDs || [];
  if (ids.length > cps) throw corrupt(where + " has " + ids.length + " characterStyleIDs for " + cps + " code points");
  const table = new Set((td.styleOverrideTable || []).map((e) => e.styleID));
  for (const id of ids) if (id !== 0 && !table.has(id)) throw corrupt(where + " uses style id " + id + ", which is not in its styleOverrideTable");
  for (const b of td.baselines || []) {
    const f = b.firstCharacter === undefined ? 0 : b.firstCharacter, e = b.endCharacter === undefined ? 0 : b.endCharacter;
    if (!(f >= 0 && e >= f && e <= s.length)) throw corrupt(where + " has a baseline over characters " + f + "-" + e + ", outside its " + s.length);
  }
  for (const g of td.glyphs || []) {
    if (g.blobIndex === undefined) continue;
    if (!(g.blobIndex >= 0 && g.blobIndex < cx.pix.blobs.length)) throw corrupt(where + " has a glyph in blob " + g.blobIndex + "; there are " + cx.pix.blobs.length);
    if (!cx.glyphChecked.has(g.blobIndex)) { decodePath(cx.pix.blobs[g.blobIndex]); cx.glyphChecked.add(g.blobIndex); }
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

// The text props of a TEXT record. `put` writes a prop the type knows; `node` holds the values the
// node itself was given, so ranges keep only what differs.
export function textProps(cx, n, put) {
  const td = n.textData || {};
  const chars = td.characters || "";
  const style = guidSet(n.inheritTextStyleID) ? cx.byGuid.get(guidStr(n.inheritTextStyleID)) : null;
  put("characters", chars);
  let font = fontOf(n.fontName) || (style && fontOf(style.fontName));
  if (!n.fontName && font) cx.stats.text.fontFromStyle++;
  if (!font) { font = FALLBACK_FONT; cx.feature("text without a font name"); }
  put("fontName", font);
  const size = isFin(n.fontSize) ? n.fontSize : style && isFin(style.fontSize) ? style.fontSize : 14;
  put("fontSize", r2(size));
  const base = { fontName: font, fontSize: r2(size) };
  const ls = numberOf(cx, "Number", n.letterSpacing || (style && style.letterSpacing), "letterSpacing");
  if (ls) { put("letterSpacing", ls); base.letterSpacing = ls; }
  const lh = numberOf(cx, "Number", n.lineHeight || (style && style.lineHeight), "lineHeight");
  if (lh) { put("lineHeight", lh); base.lineHeight = lh; }
  base.fills = paintsOf(cx, n.fillPaints);
  if (isFin(n.paragraphIndent)) { put("paragraphIndent", r2(n.paragraphIndent)); base.paragraphIndent = r2(n.paragraphIndent); }
  if (isFin(n.paragraphSpacing)) { put("paragraphSpacing", r2(n.paragraphSpacing)); base.paragraphSpacing = r2(n.paragraphSpacing); }
  const ah = E.TEXT_ALIGN_H[cx.en("PixsoNode", "textAlignHorizontal")(n.textAlignHorizontal)];
  if (ah) put("textAlignHorizontal", ah);
  const av = E.TEXT_ALIGN_V[cx.en("PixsoNode", "textAlignVertical")(n.textAlignVertical)];
  if (av) put("textAlignVertical", av);
  put("textAutoResize", E.TEXT_AUTO_RESIZE[cx.en("PixsoNode", "textAutoResize")(n.textAutoResize)] || "NONE");
  const tc = E.TEXT_CASE[cx.en("PixsoNode", "textCase")(n.textCase)];
  if (tc) { put("textCase", tc); base.textCase = tc; }
  const deco = E.TEXT_DECORATION[cx.en("PixsoNode", "textDecoration")(n.textDecoration)];
  if (deco) { put("textDecoration", deco); base.textDecoration = deco; }
  const trunc = E.TEXT_TRUNCATION[cx.en("PixsoNode", "textTruncation")(n.textTruncation)];
  if (trunc) put("textTruncation", trunc);
  if (trunc === "ENDING" && Number.isInteger(n.maxLines) && n.maxLines > 0) put("maxLines", n.maxLines);
  const lt = E.LEADING_TRIM[cx.en("PixsoNode", "leadingTrim")(n.leadingTrim)];
  if (lt) put("leadingTrim", lt);
  if (n.hangingPunctuation) put("hangingPunctuation", true);
  if (n.hangingList) put("hangingList", true);
  if ((n.fontVariations || []).length) cx.feature("fontVariations");
  const nodeLink = hyperlinkOf(n.hyperlink);

  const ranges = textRanges(cx, n, chars, base, nodeLink);
  if (ranges.length) put("textRanges", ranges);
  const bl = td.baselines || [];
  if (bl.length) put("lines", bl.length);
  else cx.note(CODE.TEXT_LINES_UNKNOWN, "no stored baselines");
  // Fonts of the ranges are listed with the node's.
  cx.font(font);
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
  const listOf = (pi) => {
    const ps = paras[pi];
    if (!ps) return null;
    const t = E.LIST_TYPE[cx.en("ParagraphStyle", "listType")(ps.listType)];
    if (!t) return null;
    const o = { listOptions: { type: t } };
    if (ps.indentationLevel) o.indentation = ps.indentationLevel;
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
