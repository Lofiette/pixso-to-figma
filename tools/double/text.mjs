// The double's text model (docs/M1.md §6 E): a deterministic width model, word wrap, line heights,
// paragraph spacing, leading trim and maxLines. Part E owns it (§9).
//
// It is a MODEL, not Figma's shaper. What it fixes is the relation the M1 tests need:
//
//   Figma width = Pixso width x ratio        (ratio 1.0105 by default, makeDouble({ textRatio }))
//
// so a text that fits its stored box on one line in Pixso (ratio 1) can wrap in Figma, which is what
// decision 9 (TEXT_WIDENED_TO_SOURCE_LINES) and countLines (D8) are about. A fixture that wants a
// stored Pixso width computes it with textMetrics(…, { ratio: 1 }).
//
// Advances, in em (times fontSize): space 0.28; i l j f t r I . , : ; ' ! | ( ) [ ] { } ` 0.3;
// m w M W @ 0.85; other upper case 0.66; digits 0.56; other ASCII 0.52; CJK and astral 1.0; other
// non-ASCII (Cyrillic, Greek, …) 0.58. A family scales them by 0.95 to 1.05 (from the name's
// characters, so two families differ deterministically); a style naming Bold, Black, Heavy, Semi or
// Extra by 1.06, Medium by 1.03, Light or Thin by 0.97. Letter spacing adds after every character
// (PIXELS as given, PERCENT of fontSize) and is not scaled by the ratio: the ratio stands for glyph
// advances.
//
// Lines: paragraphs split at "\n" (and U+2028); greedy wrap at spaces, a word wider than the box broken
// between characters; trailing spaces take no width. A line's height is the largest line height of its
// characters: AUTO 1.2 x fontSize, PIXELS as given, PERCENT of fontSize. Height = sum of line heights +
// paragraphSpacing x (paragraphs - 1). With textTruncation ENDING and maxLines, only the first maxLines
// lines count. leadingTrim CAP_HEIGHT removes, from the first line, half its leading plus 0.1 em (the
// space above the cap height) and, from the last, half its leading plus 0.2 em (the descender).
// paragraphIndent narrows the first line of every paragraph. textCase UPPER, LOWER and TITLE change
// the characters measured; SMALL_CAPS measures as UPPER at 0.8.

export const DEFAULT_TEXT_RATIO = 1.0105;
const NARROW = new Set(Array.from("iljftrI.,:;'!|()[]{}`"));
const WIDE = new Set(Array.from("mwMW@"));

function famFactor(family) {
  let s = 0;
  for (const ch of String(family || "")) s += ch.codePointAt(0);
  return 1 + ((s % 11) - 5) / 100;
}
function styleFactor(style) {
  const s = String(style || "");
  if (/Bold|Black|Heavy|Semi|Extra/i.test(s)) return 1.06;
  if (/Medium/i.test(s)) return 1.03;
  if (/Light|Thin/i.test(s)) return 0.97;
  return 1;
}
function em(cp) {
  const ch = String.fromCodePoint(cp);
  if (ch === " " || ch === " ") return 0.28;
  if (ch === "\t") return 1.12;
  if (NARROW.has(ch)) return 0.3;
  if (WIDE.has(ch)) return 0.85;
  if (cp >= 0x41 && cp <= 0x5a) return 0.66;
  if (cp >= 0x30 && cp <= 0x39) return 0.56;
  if (cp < 0x80) return 0.52;
  if (cp >= 0x2e80 || cp > 0xffff) return 1.0;
  return 0.58;
}
export function lineHeightPx(lh, fontSize) {
  if (!lh || lh.unit === "AUTO") return 1.2 * fontSize;
  if (lh.unit === "PIXELS") return Number(lh.value) || 0;
  if (lh.unit === "PERCENT") return (Number(lh.value) || 0) / 100 * fontSize;
  return 1.2 * fontSize;
}
function spacingPx(ls, fontSize) {
  if (!ls) return 0;
  if (ls.unit === "PERCENT") return (Number(ls.value) || 0) / 100 * fontSize;
  return Number(ls.value) || 0;
}
function cased(chars, caseAt) {
  // Per code point, keeping the UTF-16 index of each for the style lookup.
  const out = [];
  let i = 0, wordStart = true;
  for (const ch of String(chars)) {
    const tc = caseAt(i);
    let c = ch, small = false;
    if (tc === "UPPER") c = ch.toUpperCase();
    else if (tc === "LOWER") c = ch.toLowerCase();
    else if (tc === "TITLE") c = wordStart ? ch.toUpperCase() : ch;
    else if (tc === "SMALL_CAPS" || tc === "SMALL_CAPS_FORCED") { small = ch !== ch.toUpperCase(); c = ch.toUpperCase(); }
    wordStart = /\s/.test(ch);
    out.push({ ch, cp: c.codePointAt(0), i, small });
    i += ch.length;
  }
  return out;
}

// text = { characters, styleAt(i) -> { fontName, fontSize, letterSpacing, lineHeight, textCase },
//          paragraphSpacing, paragraphIndent, textTruncation, maxLines, leadingTrim }
// opts = { width: the box width to wrap at, or null for no wrap; ratio }
// -> { lines: [{ width, height, paragraph }], width, height, paragraphs }
export function textMetrics(text, opts = {}) {
  const ratio = typeof opts.ratio === "number" ? opts.ratio : DEFAULT_TEXT_RATIO;
  const wrapAt = typeof opts.width === "number" ? opts.width : null;
  const styleAt = text.styleAt;
  const glyphs = cased(text.characters || "", (i) => styleAt(i).textCase);
  const adv = (g) => {
    const s = styleAt(g.i), fs = s.fontSize;
    const fn = s.fontName || {};
    return em(g.cp) * (g.small ? 0.8 : 1) * fs * famFactor(fn.family) * styleFactor(fn.style) * ratio + spacingPx(s.letterSpacing, fs);
  };
  const lh = (g) => { const s = styleAt(g.i); return lineHeightPx(s.lineHeight, s.fontSize); };
  const indent = Number(text.paragraphIndent) || 0;
  const paras = [[]];
  for (const g of glyphs) { if (g.ch === "\n" || g.ch === " ") { g.br = true; paras[paras.length - 1].push(g); paras.push([]); } else paras[paras.length - 1].push(g); }
  const lines = [];
  paras.forEach((para, pi) => {
    const body = para.filter((g) => !g.br);
    const brk = para.find((g) => g.br);
    if (!body.length) {
      const ref = brk || glyphs[glyphs.length - 1] || { i: 0 };
      lines.push({ width: 0, height: lh(ref), paragraph: pi });
      return;
    }
    let line = [], lineW = 0, first = true;
    const flush = () => {
      let k = line.length;
      while (k > 0 && /\s/.test(line[k - 1].ch)) k--;
      const vis = line.slice(0, k);
      const w = vis.reduce((n, g) => n + adv(g), 0) + (first ? indent : 0);
      const h = (line.length ? line : body).reduce((m, g) => Math.max(m, lh(g)), 0);
      lines.push({ width: w, height: h, paragraph: pi });
      line = []; lineW = 0; first = false;
    };
    // words: a run of non-space glyphs plus the spaces after it
    const words = [];
    for (const g of body) {
      const last = words[words.length - 1];
      if (!last || (!/\s/.test(g.ch) && last.trail)) words.push({ gs: [g], trail: /\s/.test(g.ch) });
      else { last.gs.push(g); if (/\s/.test(g.ch)) last.trail = true; }
    }
    for (const word of words) {
      const solid = word.gs.filter((g) => !/\s/.test(g.ch));
      const solidW = solid.reduce((n, g) => n + adv(g), 0);
      const room = wrapAt === null ? Infinity : wrapAt - (first ? indent : 0);
      if (line.length && lineW + solidW > room + 0.01) flush();
      const room2 = wrapAt === null ? Infinity : wrapAt - (first ? indent : 0);
      if (!line.length && solidW > room2 + 0.01) {
        // A word wider than the box breaks between characters.
        for (const g of word.gs) {
          const a = adv(g);
          if (line.length && !/\s/.test(g.ch) && lineW + a > (wrapAt - (first ? indent : 0)) + 0.01) flush();
          line.push(g); lineW += a;
        }
        continue;
      }
      for (const g of word.gs) { line.push(g); lineW += adv(g); }
    }
    if (line.length) flush();
  });
  let shown = lines;
  if (text.textTruncation === "ENDING" && Number.isInteger(text.maxLines) && text.maxLines > 0) shown = lines.slice(0, text.maxLines);
  const width = shown.reduce((m, l) => Math.max(m, l.width), 0);
  let height = shown.reduce((n, l) => n + l.height, 0);
  const parasShown = shown.length ? shown[shown.length - 1].paragraph + 1 : 1;
  height += (Number(text.paragraphSpacing) || 0) * Math.max(0, parasShown - 1);
  if (text.leadingTrim === "CAP_HEIGHT" && shown.length) {
    const fsAt = (g) => styleAt(g ? g.i : 0).fontSize;
    const f0 = fsAt(glyphs[0]), f1 = fsAt(glyphs[glyphs.length - 1]);
    const top = (shown[0].height - f0) / 2 + 0.1 * f0, bottom = (shown[shown.length - 1].height - f1) / 2 + 0.2 * f1;
    height = Math.max(0, height - top - bottom);
  }
  return { lines: shown, allLines: lines.length, width, height, paragraphs: paras.length };
}
