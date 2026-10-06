// Part A's tests: the .pix -> IR reader, on the synthetic fixture only (docs/M1.md §6 A).
//
//   node tools/test-irread.mjs
//
// Offline: the fixture is made in memory (tools/pix/fixture.mjs), nothing real is read, and neither
// Pixso nor Figma is needed. Each check names what a wrong reader would get wrong:
//   - the IR validates under every --booleans setting, two runs give the same bytes, and a schema
//     that numbers its enums differently gives the same IR (names come from the file's schema);
//   - the populations and the balance (stored = records + everything not carried);
//   - side strokes per rule case, the oracle, SIDE_RULE_UNPROVEN on a planted disagreement; corners;
//   - auto layout, child layout, SPACE_EVENLY with one and two visible flow children per setting;
//   - text: UTF-16 range offsets around an astral character, range fields, list paragraphs, links,
//     units, lines, TEXT_LINES_UNKNOWN, a font from the text style;
//   - the vector network decoder, region by region and byte by byte, and PIX_CORRUPT on a truncated
//     network, a glyph blob and every bad text index;
//   - D3's build sources and each VECTOR_ORACLE_DIFFERS class; D5's booleans under auto, native
//     and flatten; GEOMETRY_INVALID; images and IMAGE_HASH_MISMATCH; DIRECTORY pages; style
//     definitions not carried; the scope setting; pix-to-ir refusing an --out inside the repository.
import { deepStrictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
if (typeof zlib.zstdCompressSync !== "function") {
  console.log("FAIL the reader's checks need Node 22.15 or newer (built-in zstd); this is node " + process.version);
  process.exit(1);
}
const { makeFixture, IDS, encodeVectorNetwork, encodePath } = await import("./pix/fixture.mjs");
const { pixToIR, decodeVectorNetwork } = await import("./pix/ir/index.mjs");
const { validate } = await import("./ir/validate.mjs");
const { CODE, REASON_CODES, canonicalJSON } = await import("./ir/schema.mjs");
const { closeLoop } = await import("./pix/ir/vector.mjs");

let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (label, fn) => {
  try { const r = fn(); if (r === false) fail(label); else ok(label + (typeof r === "string" ? " (" + r + ")" : "")); }
  catch (e) { fail(label + ": " + (e && e.message ? e.message.split("\n")[0] : e)); }
};
const refuses = (label, fn, want) => {
  try { fn(); fail(label + ": accepted"); }
  catch (e) {
    if (!/^PIX_CORRUPT:/.test(e.message)) fail(label + ": threw " + (e.code || e.name) + " instead: " + e.message.split("\n")[0]);
    else if (want && !want.test(e.message)) fail(label + ": wrong reason: " + e.message);
    else ok(label + " (" + e.message.slice(0, 90) + ")");
  }
};
const eq = (a, b, what) => { try { deepStrictEqual(a, b); } catch (e) { throw new Error((what || "") + " got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); } };

const fx = makeFixture();
const read = (settings) => pixToIR(fx.pix, { settings });
const R = { auto: read(), native: read({ booleans: "native" }), flatten: read({ booleans: "flatten" }), center: read({ spaceEvenlySingle: "center" }), between: read({ spaceEvenlySingle: "between" }) };
const { ir, stats } = R.auto;
const idx = (I, guid) => I.nodes.findIndex((n) => n.guid === guid);
const rec = (guid, I = ir) => { const i = idx(I, guid); if (i < 0) throw new Error("no record for " + guid); return I.nodes[i]; };
const notesOf = (guid, I = ir) => { const i = idx(I, guid); return I.notes.filter((n) => n.node === i); };
const codesOf = (guid, I = ir) => notesOf(guid, I).map((n) => n.code);
const val = (i, I = ir) => I.values[i];

// ---------- 1. validity and determinism ----------
for (const [k, r] of Object.entries(R)) {
  check("the fixture's IR validates (" + k + ")", () => { const v = validate(r.ir); if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 3))); return r.ir.nodes.length + " records, " + r.ir.notes.length + " notes"; });
}
check("two runs on the same file give byte-identical IR", () => JSON.stringify(read().ir) === JSON.stringify(ir));
check("the IR holds no wall-clock time; the stats hold the phase times", () => {
  for (const k of ["unzip", "zstd", "kiwi", "ir"]) if (!(typeof stats.ms[k] === "number" && stats.ms[k] >= 0)) return false;
  return !/"(ms|readAt|time)"/.test(JSON.stringify(ir));
});
check("a schema that numbers every enum differently gives the same IR (names, never numbers)", () => {
  const r = pixToIR(makeFixture("renumbered").pix).ir;
  const strip = (x) => { const c = JSON.parse(JSON.stringify(x)); delete c.header.source.sha256; return JSON.stringify(c); };
  return strip(r) === strip(ir);
});
check("the header: format, version 2, pix source, file scope, the settings", () => {
  eq(ir.header.format, "pix2fig.ir"); eq(ir.header.version, 2); eq(ir.header.source.kind, "pix");
  eq(ir.header.scope, { kind: "file" });
  eq([ir.header.settings.booleans, ir.header.settings.spaceEvenlySingle, ir.header.settings.textFit], ["auto", "center", "widen"]);
  eq(R.flatten.ir.header.settings.booleans, "flatten");
  return /^[0-9a-f]{64}$/.test(ir.header.source.sha256);
});
check("an unknown setting or value is refused, naming the choices", () => {
  for (const s of [{ booleans: "frame" }, { spaceEvenlySingle: "left" }, { textFit: "x" }, { scope: "page:1" }, { colour: "red" }]) {
    let threw = false;
    try { read(s); } catch (e) { threw = /pixToIR:/.test(e.message); }
    if (!threw) throw new Error("accepted " + JSON.stringify(s));
  }
});
check("IR notes carry read-stage codes only", () => ir.notes.every((n) => REASON_CODES[n.code] && REASON_CODES[n.code].stage === "read"));

// ---------- 2. pages, populations and the balance ----------
check("pages in position order; the DIRECTORY's canvas is a page, the folder is not", () => {
  eq(ir.pages.map((p) => [p.guid, p.internal]), [["0:1", false], [IDS.casesPage, false], ["0:2", true]]);
  eq(stats.notCarried.directories, 1);
  return !ir.nodes.some((n) => n.guid === IDS.directory);
});
check("a page's background colour is a fills value", () => { eq(val(ir.pages[0].background), [{ type: "SOLID", color: { r: 0.901961, g: 0.901961, b: 0.901961 } }]); return ir.pages[1].background === undefined; });
check("style definitions are not node records and are counted", () => {
  eq(stats.notCarried.styleDefinitions, 2);
  return !ir.nodes.some((n) => n.guid === "1:50" || n.guid === IDS.textStyle);
});
check("the balance: stored = records + pages + directories + style definitions + not carried + folded", () => {
  const nc = stats.notCarried;
  eq(nc, { pages: 3, directories: 1, documents: 0, styleDefinitions: 2, variables: 0, unsupported: 1, foldedOperands: 5, degenerate: 2, outOfScope: 0 });
  const sum = Object.values(nc).reduce((a, b) => a + b, 0);
  eq([stats.stored, ir.nodes.length, stats.records + sum], [89, 75, 89]);
  return "89 = 75 + " + sum;
});
check("the populations, as root records and record counts", () => {
  const P = stats.populations, n = (k) => P[k].length;
  eq([n("userTop"), n("userMasters"), n("mastersNoInstance"), n("mastersWithInstanceInternal"), n("internalLoose"), n("stateGroupsInternal"), n("lostBorder")],
    [30, 0, 5, 1, 0, 1, 3]);
  eq(P.mastersNoInstance.map((i) => ir.nodes[i].guid), ["1:11", "1:14", "1:20", "1:22", "1:40"]);
  eq(P.mastersWithInstanceInternal.map((i) => ir.nodes[i].guid), ["1:30"]);
  eq(P.lostBorder.map((i) => ir.nodes[i].guid), [IDS.ring, IDS.dashed, IDS.noPath]);
  eq(stats.lostBorderSections, 1);
  const C = stats.populationCounts;
  eq(C.mastersNoInstance, { records: 12, nonInstance: 12, instances: 0 });
  eq(C.mastersWithInstanceInternal, { records: 4, nonInstance: 2, instances: 2 });
  eq(C.userTop.instances, 3);
  eq(C.userTop.records + C.mastersNoInstance.records + C.mastersWithInstanceInternal.records + C.stateGroupsInternal.records + C.internalLoose.records, ir.nodes.length);
  for (const k of ["userTop", "mastersNoInstance"]) for (const i of P[k]) if (k === "userTop" ? ir.nodes[i].parent !== -1 : ir.nodes[i].type !== "COMPONENT") throw new Error(k + " holds " + i);
});
check("the unsupported node type is not carried, noted by guid", () => {
  const n = ir.notes.filter((x) => x.code === CODE.NODE_TYPE_UNSUPPORTED);
  eq(n.map((x) => [x.guid, x.node]), [[IDS.unsupported, undefined]]);
  return n[0].detail;
});
check("components: standalone entries; a library copy keeps its identity, an own internal master is deleted", () => {
  const c = (g) => ir.components.find((x) => ir.nodes[x.node].guid === g);
  eq(c("1:40").library, { publishFile: "fixturelibraryfilekey00", publishID: "50:7", componentKey: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", sharedSymbolVersion: "fixture-version-3" });
  eq([c("1:30").set, c("1:30").deleted, c("1:11").set], [null, true, null]);
  eq(ir.components.length, ir.nodes.filter((n) => n.type === "COMPONENT").length);
  eq(rec("1:10").type, "FRAME");
  return !ir.notes.some((n) => n.code === CODE.VARIANT_SET_REJECTED) && ir.sets.length === 0;
});
check("instances are placeholders naming their master's record, with no child records", () => {
  eq(rec("1:60").instance, { master: { guid: "1:30" } });
  eq(rec("1:62").instance, { master: { guid: "1:40" } });
  eq(Object.keys(rec("1:61").props).sort(), ["height", "relativeTransform", "width"]);
  return !ir.nodes.some((n) => n.parent >= 0 && ir.nodes[n.parent].type === "INSTANCE");
});
check("sibling order follows positions, not file order", () => {
  const tops = ir.nodes.filter((n) => n.parent === -1 && n.page === 0).map((n) => n.name);
  eq(tops, ["Card instance", "Button instance", "Styled", "Badge instance"]);
});

// ---------- 3. side strokes and corners ----------
check("independent sides: the four fields, and the oracle draws the same sides", () => {
  const p = rec(IDS.indep).props;
  eq([p.strokeWeights, p.oracleSides, p.strokeWeight, p.strokeAlign], [[0, 2, 4, 0], [false, true, true, false], 2, "INSIDE"]);
  return codesOf(IDS.indep).length === 0;
});
check("partial sides: a missing field is 0", () => eq(rec(IDS.partial).props.strokeWeights, [0, 0, 3, 0]));
check("no field: four sides at strokeWeight, written as strokeWeight alone; the miter angle as Figma's ratio", () => {
  const p = rec(IDS.ring).props;
  eq([p.strokeWeights, p.strokeWeight, p.oracleSides, p.strokeMiterLimit], [undefined, 1, [true, true, true, true], 10]);
});
check("a planted disagreement: the IR follows the stroke-area path, SIDE_RULE_UNPROVEN", () => {
  const p = rec(IDS.planted).props;
  eq([p.strokeWeights, p.oracleSides], [[2, 0, 2, 0], [true, false, true, false]]);
  eq(notesOf(IDS.planted).map((n) => [n.code, n.detail]), [[CODE.SIDE_RULE_UNPROVEN, "rule 1111, oracle 1010"]]);
});
check("a dashed border and a border with no stroke-area path have no oracle", () => {
  eq([rec(IDS.dashed).props.oracleSides, rec(IDS.noPath).props.oracleSides], [undefined, undefined]);
  eq(val(rec(IDS.dashed).props.dashPattern), [4, 2]);
  return codesOf(IDS.dashed).includes(CODE.SOURCE_FEATURE_UNSUPPORTED);
});
check("the side census: population, checked, agree, unproven, and why there is no oracle", () => {
  eq(stats.sides, { population: 7, checked: 4, agree: 3, unproven: 1, noOracle: { noPath: 2, dashed: 1, small: 0 } });
});
check("an absent strokeAlign on a visible stroke is decided by the stroke-area path's reach", () => {
  const r = pixToIR(mutated((v, at) => { delete at(IDS.ring).strokeAlign; at(IDS.ring).strokePaddingPath[0].blobIndex = 30; }));
  // blob 30 spans 0..10 on a 40 x 20 box: no reach past it, INSIDE.
  eq([rec(IDS.ring, r.ir).props.strokeAlign, r.stats.strokeAlignDecided.INSIDE], ["INSIDE", 1]);
  // Strokes with no path to measure take the type's default, counted apart.
  eq(stats.strokeAlignDecided, { "default:CENTER": 5 });
  // Review R1: a reach of the whole weight is OUTSIDE only with a band only OUTSIDE draws. The ring's
  // 1 px stroke on its 40 x 20 box, given a band outside the box (-1..0: profile 100), and a band
  // across the edge (-1..+1: profile 110, stored INSIDE on most nodes that store an align).
  const rectCW = (x0, y0, x1, y1) => [[1, x0, y0], [2, x1, y0], [2, x1, y1], [2, x0, y1], [0]];
  const rectCCW = (x0, y0, x1, y1) => [[1, x0, y0], [2, x0, y1], [2, x1, y1], [2, x1, y0], [0]];
  const withBand = (inner) => pixToIR(mutated((v, at) => {
    v.blobs.push({ bytes: encodePath([...rectCW(-1, -1, 41, 21), ...rectCCW(inner, inner, 40 - inner, 20 - inner)]) });
    delete at(IDS.ring).strokeAlign; at(IDS.ring).strokePaddingPath[0].blobIndex = v.blobs.length - 1;
  }));
  const out = withBand(0), across = withBand(1);
  eq([rec(IDS.ring, out.ir).props.strokeAlign, out.stats.strokeAlignDecided.OUTSIDE], ["OUTSIDE", 1]);
  eq([rec(IDS.ring, across.ir).props.strokeAlign, across.stats.strokeAlignDecided["guess:INSIDE"], across.stats.strokeAlignDecided.OUTSIDE], ["INSIDE", 1, undefined]);
  // A reach of the whole weight on one side only (blob 4 on a 39 px box) is no OUTSIDE band either.
  const c = pixToIR(mutated((v, at) => { delete at(IDS.ring).strokeAlign; at(IDS.ring).strokePaddingPath[0].blobIndex = 4; at(IDS.ring).size = { x: 39, y: 20 }; }));
  eq([rec(IDS.ring, c.ir).props.strokeAlign, c.stats.strokeAlignDecided["guess:INSIDE"]], ["INSIDE", 1]);
});
check("a stroke with no visible paint has no side oracle and no SIDE_RULE_UNPROVEN note (review R5)", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.planted).strokePaints[0].visible = false; }));
  const p = rec(IDS.planted, r.ir).props;
  eq([p.oracleSides, codesOf(IDS.planted, r.ir).indexOf(CODE.SIDE_RULE_UNPROVEN)], [undefined, -1]);
  eq(codesOf(IDS.planted).indexOf(CODE.SIDE_RULE_UNPROVEN) >= 0, true);
});
check("corner fields: the four, a missing one 0; cornerRadius alone; four equal fields as cornerRadius", () => {
  const a = rec(IDS.cornersFields).props, b = rec(IDS.cornerRadiusOnly).props, c = rec(IDS.cornersEqual).props;
  eq([a.cornerRadii, a.cornerRadius, b.cornerRadius, b.cornerRadii, c.cornerRadius, c.cornerRadii], [[4, 0, 8, 0], undefined, 6, undefined, 5, undefined]);
  eq(stats.cornerRadiusOnly, { RECTANGLE: 1 });
});

// ---------- 4. layout ----------
check("auto layout: mode, sizing, paddings, spacing, alignment, reverse draw, no clip, overflow", () => {
  const p = rec(IDS.sides).props;
  eq([p.layoutMode, p.primaryAxisSizingMode, p.counterAxisSizingMode, p.paddingLeft, p.paddingRight, p.paddingTop, p.paddingBottom,
    p.itemSpacing, p.counterAxisAlignItems, p.itemReverseZIndex, p.clipsContent, p.overflowDirection],
    ["HORIZONTAL", "FIXED", "AUTO", 4, 4, 2, 2, 8, "CENTER", true, false, "VERTICAL"]);
});
check("child layout: grow, stretch, absolute, constraints (FIXED_MAX is MAX)", () => {
  eq(rec(IDS.cornerRadiusOnly).props.layoutGrow, 1);
  eq(rec(IDS.cornersEqual).props.layoutAlign, "STRETCH");
  const a = rec(IDS.absolute).props;
  eq([a.layoutPositioning, val(a.constraints)], ["ABSOLUTE", { horizontal: "MAX", vertical: "SCALE" }]);
  eq(val(a.arcData), { startingAngle: 0, endingAngle: 3.141593, innerRadius: 0.5 });
});
check("a child filling the counter axis is STRETCH only when stored at the parent's inner size, or its own min or max (review R6)", () => {
  eq([rec(IDS.cornersEqual).props.layoutAlign, stats.counterFillKeptFixed], ["STRETCH", 0]);
  const short = pixToIR(mutated((v, at) => { at(IDS.cornersEqual).size = { x: 20, y: 30 }; }));
  const capped = pixToIR(mutated((v, at) => { at(IDS.cornersEqual).size = { x: 20, y: 30 }; at(IDS.cornersEqual).maxSize = { x: 1e31, y: 30 }; }));
  eq([rec(IDS.cornersEqual, short.ir).props.layoutAlign, short.stats.counterFillKeptFixed], [undefined, 1]);
  eq([rec(IDS.cornersEqual, capped.ir).props.layoutAlign, capped.stats.counterFillKeptFixed], ["STRETCH", 0]);
});
check("SPACE_EVENLY: two visible flow children → SPACE_BETWEEN; one → the setting (between, center)", () => {
  // The default is center since P18 (2026-10-05): Figma puts a single SPACE_BETWEEN child at the start, Pixso centres it.
  eq([rec(IDS.evenlyTwo).props.primaryAxisAlignItems, rec(IDS.evenlyOne).props.primaryAxisAlignItems], ["SPACE_BETWEEN", "CENTER"]);
  eq([rec(IDS.evenlyTwo, R.between.ir).props.primaryAxisAlignItems, rec(IDS.evenlyOne, R.between.ir).props.primaryAxisAlignItems], ["SPACE_BETWEEN", "SPACE_BETWEEN"]);
  eq([rec(IDS.evenlyTwo, R.center.ir).props.primaryAxisAlignItems, rec(IDS.evenlyOne, R.center.ir).props.primaryAxisAlignItems], ["SPACE_BETWEEN", "CENTER"]);
  eq(stats.spaceEvenly, { between: 1, single: 1 });
});
check("wrap, counter spacing and content alignment; min and max sizes with NaN and FLT_MAX unset", () => {
  const p = rec(IDS.evenlyTwo).props;
  eq([p.layoutWrap, p.counterAxisSpacing, p.counterAxisAlignContent, p.minWidth, p.minHeight, p.maxWidth, p.maxHeight],
    ["WRAP", 4, "SPACE_BETWEEN", 50, undefined, undefined, 300]);
});
check("a group carries no paints and no clip; a mask keeps isMask and OUTLINE becomes VECTOR", () => {
  const g = rec(IDS.maskGroup).props, m = rec(IDS.maskShape).props;
  eq([g.fills, g.clipsContent, g.blendMode, m.isMask, m.maskType], [undefined, undefined, "PASS_THROUGH", true, "VECTOR"]);
});

// ---------- 5. text ----------
check("text ranges in UTF-16 units around an astral character, holding only what differs", () => {
  const p = rec(IDS.text).props;
  eq(p.characters, "Hi \u{1F600} there\nsecond");
  eq(p.textRanges.map((r) => [r.start, r.end, Object.keys(r.fields)]), [[3, 8, ["fills", "fontSize"]], [12, 18, ["fontName", "hyperlink", "indentation", "listOptions"]]]);
  const [a, b] = p.textRanges;
  eq([a.fields.fontSize, val(a.fields.fills), val(b.fields.fontName), val(b.fields.hyperlink), val(b.fields.listOptions), b.fields.indentation],
    [20, [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }], { family: "Inter", style: "Bold" }, { type: "URL", value: "https://example.invalid/" }, { type: "UNORDERED" }, 1]);
});
check("text props: percent stored as a fraction, lines from the baselines, alignment, auto resize", () => {
  const p = rec(IDS.text).props;
  eq([val(p.letterSpacing), val(p.lineHeight), p.lines, p.textAlignHorizontal, p.textAutoResize, val(p.fontName), p.fontSize],
    [{ unit: "PERCENT", value: 6.25 }, { unit: "PERCENT", value: 125 }, 2, "CENTER", "HEIGHT", { family: "Inter", style: "Regular" }, 14]);
});
check("a text with no baselines has no lines and TEXT_LINES_UNKNOWN; PERCENT 0 is AUTO; truncation", () => {
  const p = rec(IDS.textNoLines).props;
  eq([p.lines, p.lineHeight, p.textTruncation, p.maxLines], [undefined, undefined, "ENDING", 2]);
  return codesOf(IDS.textNoLines).includes(CODE.TEXT_LINES_UNKNOWN);
});
check("a missing font comes from the text style by guid; a RAW line height is drawn at the font's natural height (AUTO, left out)", () => {
  const p = rec(IDS.textFromStyle).props;
  eq([val(p.fontName), p.fontSize, p.lineHeight, p.lines], [{ family: "Inter", style: "Medium" }, 16, undefined, 1]);
  eq([stats.text.fontFromStyle, stats.text.rawLineHeight], [1, 1]);
});
check("PERCENT 1 is AUTO (the font's natural line height, review R3); PERCENT 1.5 stays 150 %", () => {
  const one = pixToIR(mutated((v, at) => { at(IDS.text).lineHeight = { value: 1, units: 3 }; }));
  const half = pixToIR(mutated((v, at) => { at(IDS.text).lineHeight = { value: 1.5, units: 3 }; }));
  eq([rec(IDS.text, one.ir).props.lineHeight, one.stats.text.percentOneAuto], [undefined, 1]);
  eq(val(rec(IDS.text, half.ir).props.lineHeight, half.ir), { unit: "PERCENT", value: 150 });
});
check("a text bound to a style takes the style's size (absent: 14), line height and letter spacing; its font by fontMetaData (review R2)", () => {
  const NU = (value, units) => ({ value, units });
  const read = (styleFont, listed) => pixToIR(mutated((v, at) => {
    const s = at(IDS.textStyle), t = at(IDS.textFromStyle);
    delete s.fontSize; s.lineHeight = NU(20, 2); s.letterSpacing = NU(1, 2);
    if (styleFont) s.fontName = { family: "Inter", style: styleFont, postscript: "" };
    t.fontName = { family: "Inter", style: "Regular", postscript: "" }; t.fontSize = 12; t.lineHeight = NU(16, 2);
    t.textData.fontMetaData = listed.map((st) => ({ key: { family: "Inter", style: st, postscript: "" } }));
  }));
  const a = read("Medium", ["Medium"]), b = read("Medium", ["Regular"]), c = read("Medium", ["Regular", "Medium"]);
  const pa = rec(IDS.textFromStyle, a.ir).props;
  eq([pa.fontSize, val(pa.lineHeight, a.ir), val(pa.letterSpacing, a.ir), val(pa.fontName, a.ir).style, a.stats.text.styleValueOverridden], [14, { unit: "PIXELS", value: 20 }, { unit: "PIXELS", value: 1 }, "Medium", 1]);
  eq([val(rec(IDS.textFromStyle, b.ir).props.fontName, b.ir).style, val(rec(IDS.textFromStyle, c.ir).props.fontName, c.ir).style], ["Regular", "Regular"]);
});
check("number forms and OpenType features are counted SOURCE_FEATURE_UNSUPPORTED, once per record, on the node or a style entry (review R8)", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.text).fontVariantNumericSpacing = 3; at(IDS.text).textData.styleOverrideTable[0].fontVariantNumericSpacing = 3; at(IDS.text).textData.styleOverrideTable[1].toggledOnOTFeatures = [6]; }));
  const s = pixToIR(mutated((v, at) => { at(IDS.textNoLines).fontVariantNumericSpacing = 1; }));
  eq(notesOf(IDS.text, r.ir).map((n) => n.detail).filter((d) => d === "fontVariantNumeric" || d === "OpenType features"), ["fontVariantNumeric", "OpenType features"]);
  eq([r.stats.unsupported.fontVariantNumeric, notesOf(IDS.textNoLines, s.ir).some((n) => n.detail === "fontVariantNumeric")], [1, false]);
});
check("every font used is listed once", () => {
  eq(ir.fonts.map((f) => f.style).sort(), ["Bold", "Medium", "Regular"]);
});

// ---------- 6. the network decoder ----------
const blob = (k) => fx.value.blobs[k].bytes;
check("a network decodes region by region, every byte consumed", () => {
  const net = decodeVectorNetwork(blob(16));
  eq(net.vertices.map((v) => [v.styleID, v.x, v.y]), [[0, 0, 0], [0, 10, 0], [1, 10, 10], [0, 0, 10]]);
  eq(net.segments.map((s) => [s.start, s.end]), [[0, 1], [1, 2], [2, 3], [3, 0]]);
  eq(net.regions, [{ styleID: 0, windingRule: "NONZERO", loops: [[0, 1, 2, 3]] }]);
  const two = encodeVectorNetwork({ vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
    regions: [{ styleID: 5, windingRule: "EVENODD", loops: [[0, 1, 2]] }, { styleID: 2, windingRule: "NONZERO", loops: [[2, 1, 0], [0, 1, 2]] }] });
  eq(decodeVectorNetwork(two).regions, [{ styleID: 5, windingRule: "EVENODD", loops: [[0, 1, 2]] }, { styleID: 2, windingRule: "NONZERO", loops: [[2, 1, 0], [0, 1, 2]] }]);
  eq(encodeVectorNetwork(decodeVectorNetwork(two)), two);
  return two.length + " bytes";
});
refuses("a network with a byte left over", () => decodeVectorNetwork(Buffer.concat([blob(16), Buffer.from([0])])), /left over/);
check("every truncation of a network is refused with PIX_CORRUPT", () => {
  const b = blob(16);
  for (let n = 0; n < b.length; n++) {
    try { decodeVectorNetwork(b.subarray(0, n)); throw new Error("a prefix of " + n + " bytes was accepted"); }
    catch (e) { if (!/^PIX_CORRUPT:/.test(e.message)) throw new Error("at " + n + ": " + e.message); }
  }
  return b.length + " prefixes";
});
refuses("a network segment naming a vertex it does not have", () => {
  const b = Buffer.from(blob(16)); b.writeUInt32LE(9, 12 + 4 * 12 + 4); decodeVectorNetwork(b);
}, /joins vertices/);
refuses("a network that claims more vertices than its bytes hold", () => { const b = Buffer.from(blob(16)); b.writeUInt32LE(1e6, 0); decodeVectorNetwork(b); }, /claims/);
function mutated(fn) {
  return makeFixture("valid", { mutate: (v) => fn(v, (g) => v.pixsoNodes.find((n) => n.guid.sessionID + ":" + n.guid.localID === g)) }).pix;
}
refuses("pixToIR on a file whose network is truncated", () => pixToIR(mutated((v) => { v.blobs[16].bytes = v.blobs[16].bytes.subarray(0, 20); })), /network/);

// ---------- 7. text data checks ----------
refuses("a glyph blob index out of range", () => pixToIR(mutated((v, at) => { at(IDS.text).textData.glyphs[0].blobIndex = 999; })), /glyph/);
refuses("a glyph path that ends inside an op", () => pixToIR(mutated((v) => { v.blobs[9].bytes = v.blobs[9].bytes.subarray(0, 6); })), /past the end/);
refuses("a style id that is not in styleOverrideTable", () => pixToIR(mutated((v, at) => { at(IDS.text).textData.characterStyleIDs[0] = 7; })), /style id 7/);
refuses("a baseline whose end character is outside the text", () => pixToIR(mutated((v, at) => { at(IDS.text).textData.baselines[1].endCharacter = 19; })), /baseline/);
refuses("a baseline whose first character is past its end", () => pixToIR(mutated((v, at) => { at(IDS.text).textData.baselines[1].firstCharacter = 13; at(IDS.text).textData.baselines[1].endCharacter = 12; })), /baseline/);
refuses("more characterStyleIDs than code points, past the end not all the base style", () => pixToIR(mutated((v, at) => { at(IDS.text).textData.characterStyleIDs.push(0, 1); })), /code points/);
check("trailing ids of the base style past the last code point are dropped and counted, not PIX_CORRUPT", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.text).textData.characterStyleIDs.push(0); }));
  eq(r.stats.text.trailingBaseStyleIds, 1);
  eq(rec(IDS.text, r.ir).props.characters, rec(IDS.text).props.characters);
});
refuses("a geometry path naming a blob that does not exist", () => pixToIR(mutated((v, at) => { at(IDS.heart).fillGeometry[0].blobIndex = 500; })), /blob 500/);
check("a full sweep with no hole is the plain ellipse (no arcData); a full donut keeps its arcData (review figma F1)", () => {
  const full = Math.fround(2 * Math.PI);
  const a = pixToIR(mutated((v, at) => { at(IDS.absolute).arcData = { startingAngle: 0, endingAngle: full, innerRadius: 0 }; })).ir;
  const b = pixToIR(mutated((v, at) => { at(IDS.absolute).arcData = { startingAngle: 0, endingAngle: full, innerRadius: 0.5 }; })).ir;
  eq(rec(IDS.absolute, a).props.arcData, undefined);
  eq(val(rec(IDS.absolute, b).props.arcData, b), { startingAngle: 0, endingAngle: 6.283185, innerRadius: 0.5 });
});
check("a text with empty characters and no style ids reads as plain", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.textNoLines).textData = { characters: "", characterStyleIDs: [] }; }));
  const p = rec(IDS.textNoLines, r.ir).props;
  return p.characters === "" && p.textRanges === undefined;
});
check("fewer style ids than code points: the rest are the node's own style", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.text).textData.characterStyleIDs = [0, 0, 0, 1]; }));
  eq(rec(IDS.text, r.ir).props.textRanges.map((x) => [x.start, x.end]), [[3, 5], [12, 18]]);
});

// ---------- 8. vectors ----------
check("a network with a region is the build source, scaled to the node, with the stored fill as its oracle", () => {
  const p = rec(IDS.vNet).props, net = val(p.vectorNetwork);
  eq([p.fillGeometry, val(p.oracleFillGeometry)], [undefined, [{ windingRule: "NONZERO", data: "M 0 0 L 20 0 L 20 20 L 0 20 Z" }]]);
  eq(net.vertices[1], { x: 20, y: 0 });
  eq(net.vertices[2], { x: 20, y: 20, strokeJoin: "ROUND", cornerRadius: 2, handleMirroring: "ANGLE" });
  eq([p.strokeCap, p.strokeJoin], ["CIRCLE_FILLED", "ROUND"]);
  return codesOf(IDS.vNet).length === 0;
});
check("the curved star network keeps its tangents and its stored path as the oracle", () => {
  const p = rec(IDS.star).props, net = val(p.vectorNetwork);
  eq(net.segments[1], { start: 1, end: 2, tangentStart: { x: 0, y: 5.5 }, tangentEnd: { x: 5, y: 0 } });
  eq(val(p.oracleFillGeometry)[0].data, "M 0 0 L 10 0 C 10 5.5 5 10 0 10 Z");
});
check("a region-less loop with stored fill geometry is built from the geometry (VECTOR_FROM_GEOMETRY)", () => {
  const p = rec(IDS.vLoop).props;
  eq([p.vectorNetwork, val(p.fillGeometry), p.strokeGeometry !== undefined], [undefined, [{ windingRule: "NONZERO", data: "M 0 10 L 5 0 L 10 10 Z" }], true]);
  eq(notesOf(IDS.vLoop).map((n) => n.code), [CODE.VECTOR_FROM_GEOMETRY]);
  return notesOf(IDS.vLoop)[0].detail;
});
check("a vector with fill geometry and no network is built from the geometry", () => {
  eq(codesOf(IDS.heart), [CODE.VECTOR_FROM_GEOMETRY]);
  eq(val(rec(IDS.heart).props.fillGeometry)[0].windingRule, "EVENODD");
});
for (const [id, cls] of [["vNoFill", "region-no-fill"], ["vWinding", "winding"], ["vBounds", "network-bounds"]]) {
  check("VECTOR_ORACLE_DIFFERS " + cls + " on its case, and only there", () => {
    const n = notesOf(IDS[id]).filter((x) => x.code === CODE.VECTOR_ORACLE_DIFFERS);
    eq(n.map((x) => x.detail.split(": ")[0]), [cls]);
    eq(ir.notes.filter((x) => x.code === CODE.VECTOR_ORACLE_DIFFERS && x.detail.split(": ")[0] === cls).length, 1);
    return n[0].detail;
  });
}
check("the class counts in the stats", () => eq(stats.vectors.classes, { "region-no-fill": 1, "network-bounds": 1, winding: 1 }));
check("an open region loop under no visible fill is dropped: a stroke-only network with no oracle", () => {
  const p = rec(IDS.vOpen).props, net = val(p.vectorNetwork);
  eq([net.regions, p.oracleFillGeometry, p.fillGeometry], [[], undefined, undefined]);
  return codesOf(IDS.vOpen).length === 0 && stats.vectors.loopsDropped === 1;
});
check("a dropped open loop adds no closing segment: the stored chain stays open, so Figma strokes and fills only what Pixso drew", () => {
  // A closing segment left behind would be stroked, and with no region Figma fills the loop it closes
  // (P19B regionlessFill ok, 2026-10-05).
  eq(val(rec(IDS.vOpen).props.vectorNetwork).segments, [{ start: 0, end: 1 }, { start: 1, end: 2 }]);
});
// A network with no region whose segments close a loop, and no stored fill path: Figma fills the loop
// (P19B regionlessFill ok), Pixso drew no fill. The fixture's vNoFill (a square with a region, no
// fill paint, no stored fill) with its region removed.
const SQUARE_NO_REGION = encodeVectorNetwork({ vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }], regions: [] });
// visible: undefined (no fill paint), or the visibility of a fill paint (a copy of vNet's solid fill).
const regionless = (visible) => pixToIR(mutated((v, at) => {
  v.blobs[at(IDS.vNoFill).vectorData.vectorNetworkBlob].bytes = SQUARE_NO_REGION;
  if (visible !== undefined) at(IDS.vNoFill).fillPaints = [{ ...at(IDS.vNet).fillPaints[0], visible }];
}));
check("a closed loop with no region and no stored fill path under no visible fill: network-built, fills as stored, no note (neither tool draws a fill; the judge counts it unfilled)", () => {
  for (const fill of [undefined, false]) {
    const r = regionless(fill), p = rec(IDS.vNoFill, r.ir).props;
    eq([val(p.vectorNetwork, r.ir).regions, val(p.vectorNetwork, r.ir).segments.length, p.oracleFillGeometry, p.fillGeometry], [[], 4, undefined, undefined]);
    eq(val(p.fills, r.ir).length, fill === undefined ? 0 : 1);
    eq(notesOf(IDS.vNoFill, r.ir), []);
    const v = validate(r.ir); if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
  }
});
check("the same under a visible fill paint: fills [] and SOURCE_FEATURE_UNSUPPORTED unfilled loop, so Figma draws no fill where Pixso drew none; the network, so the stroke, stays", () => {
  const r = regionless(true);
  const p = rec(IDS.vNoFill, r.ir).props;
  eq([val(p.fills, r.ir), val(p.vectorNetwork, r.ir).segments.length, val(p.vectorNetwork, r.ir).regions], [[], 4, []]);
  eq(notesOf(IDS.vNoFill, r.ir).map((n) => [n.code, n.detail]),
    [[CODE.SOURCE_FEATURE_UNSUPPORTED, "unfilled loop: 1 closed loop with no region and no stored fill path; fills [] so Figma draws none, as Pixso"]]);
  eq(r.stats.unsupported["unfilled loop"], 1);
  const v = validate(r.ir); if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
});
check("an open chain with no region under a visible fill keeps its fills and gets no such note (Figma does not fill it, P19)", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.vRight).fillPaints = [{ ...at(IDS.vNet).fillPaints[0] }]; }));
  const p = rec(IDS.vRight, r.ir).props;
  eq(val(p.fills, r.ir).length, 1);
  eq(codesOf(IDS.vRight, r.ir), [CODE.SOURCE_FEATURE_UNSUPPORTED]);
  eq(r.stats.unsupported["unfilled loop"], undefined);
});
check("an open region loop under a visible fill is closed with a straight segment", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.vOpen).fillPaints[0].visible = true; }));
  const p = rec(IDS.vOpen, r.ir).props, net = val(p.vectorNetwork, r.ir);
  eq(net.regions[0].loops, [[0, 1, 2]]);
  eq(net.segments[2], { start: 2, end: 0 });
  eq(val(p.oracleFillGeometry, r.ir).length, 1);
  return codesOf(IDS.vOpen, r.ir).includes(CODE.SOURCE_FEATURE_UNSUPPORTED);
});
check("closeLoop: a closed loop is returned as it is; gaps get connectors", () => {
  const segs = [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }];
  const loop = [0, 1, 2];
  if (closeLoop(segs, loop) !== loop) return false;
  const s2 = [{ start: 0, end: 1 }, { start: 2, end: 3 }];
  eq(closeLoop(s2, [0, 1]), [0, 2, 1, 3]);
  eq(s2.slice(2), [{ start: 1, end: 2 }, { start: 3, end: 0 }]);
});
check("RIGHT_ANGLE mirroring is stripped and counted", () => {
  const net = val(rec(IDS.vRight).props.vectorNetwork);
  eq(net.vertices[1], { x: 5, y: 5 });
  eq(notesOf(IDS.vRight).map((n) => [n.code, n.detail]), [[CODE.SOURCE_FEATURE_UNSUPPORTED, "RIGHT_ANGLE: 1 vertices"]]);
});
check("a CONNECTLINE is a VECTOR from its network, SOURCE_FEATURE_UNSUPPORTED", () => {
  const r = rec(IDS.connect);
  eq([r.type, val(r.props.vectorNetwork).segments.length], ["VECTOR", 1]);
  eq(notesOf(IDS.connect).map((n) => n.detail), ["CONNECTLINE"]);
});
check("a LINE with height and no stored geometry stays a line, its height dropped and noted", () => {
  const r = rec(IDS.lineHeight);
  eq([r.type, r.props.width, r.props.height], ["LINE", 20, 0]);
  return notesOf(IDS.lineHeight)[0].detail.indexOf("LINE with height") === 0;
});
check("a LINE with height and stored fill geometry is a VECTOR from it", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.lineHeight).fillGeometry = [{ blobIndex: 14, windingRule: at(IDS.heart).fillGeometry[0].windingRule }]; }));
  const n = rec(IDS.lineHeight, r.ir);
  eq([n.type, n.props.height, val(n.props.fillGeometry, r.ir).length], ["VECTOR", 6, 1]);
  return codesOf(IDS.lineHeight, r.ir).includes(CODE.SOURCE_FEATURE_UNSUPPORTED);
});
check("a SECTION carries fills only; its stroke is dropped and noted", () => {
  const p = rec(IDS.section).props;
  eq([p.strokes, p.strokeWeight, p.clipsContent, val(p.fills).length], [undefined, undefined, undefined, 1]);
  eq(notesOf(IDS.section).map((n) => n.detail), ["SECTION strokes"]);
});
check("a SECTION's corner radius, which Figma does not draw, is noted (the first live build of P, 2026-10-05)", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.section).cornerRadius = 32; }));
  eq(notesOf(IDS.section, r.ir).map((n) => n.detail), ["SECTION strokes", "SECTION corner radius"]);
  return r.stats.unsupported["SECTION corner radius"] + " noted";
});

// ---------- 8b. styles a node draws (a render pair of P, 2026-10-05: the style's value wins) ----------
{
  const LOCAL = "1:64", DANGLING = "1:65", STYLE_GUID = "1:50";
  const enumOf = (defs, name, member) => defs.find((d) => d.name === name).fields.find((f) => f.name === member).value;
  const node = (v, id) => v.pixsoNodes.find((x) => x.guid.sessionID + ":" + x.guid.localID === id);
  check("a node bound to a style with its own value equal to the style's binds it, with no note", () => {
    const p = rec(LOCAL).props, st = ir.styles[p.fillStyle];
    eq([st && st.guid, st && st.type, st && st.styleKey, val(p.fills)[0].color], [STYLE_GUID, "PAINT", "fixture-style-key-1", { r: 0, g: 0.333333, b: 1 }]);
    eq(codesOf(LOCAL).filter((c) => /^STYLE_/.test(c)), []);
  });
  check("a reference that resolves nowhere keeps the node's own value, unbound, noted STYLE_MISSING_IN_SOURCE; 0:0 and all ones are no reference", () => {
    const p = rec(DANGLING).props;
    eq([p.fillStyle, p.strokeStyle, p.effectStyle, val(p.fills)[0].color], [undefined, undefined, undefined, { r: 0.039216, g: 0.078431, b: 0.117647 }]);
    eq(notesOf(DANGLING).filter((n) => /^STYLE_/.test(n.code)).map((n) => n.code + ": " + n.detail), [CODE.STYLE_MISSING_IN_SOURCE + ": fill style not in the file; the node's own value kept"]);
  });
  check("a resolved fill style's value is drawn over the node's stale copy: the style is bound and STYLE_VALUE_DIFFERS noted", () => {
    const r = pixToIR(makeFixture("valid", { mutate: (v, d) => {
      node(v, LOCAL).fillPaints = [{ type: enumOf(d, "PaintType", "SOLID"), color: { r: 228, g: 228, b: 228, a: 255 }, opacity: 1, visible: true }];
    } }).pix);
    const p = rec(LOCAL, r.ir).props, st = r.ir.styles[p.fillStyle];
    eq([val(p.fills, r.ir)[0].color, st && st.guid], [{ r: 0, g: 0.333333, b: 1 }, STYLE_GUID]);
    eq(codesOf(LOCAL, r.ir).filter((c) => /^STYLE_/.test(c)), [CODE.STYLE_VALUE_DIFFERS]);
    eq(r.stats.styles.fill.styleWins, 1);
  });
  check("stroke and effect styles likewise: a stroke style is a paint style (its fill paints), an effect style its effects; both bound", () => {
    const r = pixToIR(makeFixture("valid", { mutate: (v, d) => {
      const style = node(v, STYLE_GUID), n = node(v, LOCAL);
      const eff = { guid: { sessionID: 1, localID: 90 }, parentIndex: { guid: style.parentIndex.guid, position: "fz" }, type: style.type, name: "Shadow/Small",
        styleType: enumOf(d, "StyleType", "EFFECT"), styleID: 9,
        effects: [{ type: enumOf(d, "EffectType", "DROP_SHADOW"), color: { r: 0, g: 0, b: 0, a: 51 }, offset: { x: 0, y: 2 }, radius: 4, visible: true }] };
      v.pixsoNodes.push(eff);
      n.inheritStrokeStyleID = style.guid; n.strokePaints = [];
      n.inheritEffectStyleID = eff.guid; n.effects = [];
    } }).pix);
    const p = rec(LOCAL, r.ir).props;
    eq([val(p.strokes, r.ir).length, val(p.strokes, r.ir)[0].color, r.ir.styles[p.strokeStyle].guid, val(p.effects, r.ir).length, val(p.effects, r.ir)[0].type, r.ir.styles[p.effectStyle].type],
      [1, { r: 0, g: 0.333333, b: 1 }, STYLE_GUID, 1, "DROP_SHADOW", "EFFECT"]);
    eq(codesOf(LOCAL, r.ir).filter((c) => /^STYLE_/.test(c)), [CODE.STYLE_VALUE_DIFFERS, CODE.STYLE_VALUE_DIFFERS]);
    const v = validate(r.ir);
    if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
    return r.ir.styles.length + " styles";
  });
}

// ---------- 9. booleans ----------
check("auto: class A booleans native (a nested one too), class B flattened with its operands folded", () => {
  eq([rec(IDS.boolA).type, rec(IDS.boolA).props.booleanOperation, rec(IDS.boolNested).type, rec(IDS.boolXor).props.booleanOperation],
    ["BOOLEAN_OPERATION", "UNION", "BOOLEAN_OPERATION", "EXCLUDE"]);
  eq(val(rec(IDS.boolXor).props.oracleFillGeometry)[0].windingRule, "EVENODD");
  const b = rec(IDS.boolB);
  eq([b.type, val(b.props.fills)[0].type, idx(ir, IDS.boolBLine1), idx(ir, IDS.boolBInner)], ["VECTOR", "SOLID", -1, -1]);
  const n = notesOf(IDS.boolB);
  eq(n.map((x) => x.code), [CODE.BOOLEAN_FLATTENED]);
  eq(stats.booleans, { native: 3, flattened: 1, foldedNodes: 5, degenerate: 1 });
  return n[0].detail;
});
check("flatten: every outermost boolean is one VECTOR; nested ones fold", () => {
  const I = R.flatten.ir;
  eq([rec(IDS.boolA, I).type, rec(IDS.boolXor, I).type, rec(IDS.boolB, I).type, idx(I, IDS.boolNested)], ["VECTOR", "VECTOR", "VECTOR", -1]);
  eq(I.notes.filter((n) => n.code === CODE.BOOLEAN_FLATTENED).length, 3);
  eq(R.flatten.stats.booleans, { native: 0, flattened: 3, foldedNodes: 12, degenerate: 1 });
});
check("native: no boolean flattened; class B keeps its operands and notes the lost operand strokes", () => {
  const I = R.native.ir;
  eq(I.notes.filter((n) => n.code === CODE.BOOLEAN_FLATTENED).length, 0);
  eq([rec(IDS.boolB, I).type, rec(IDS.boolBLine1, I).type, rec(IDS.boolBInner, I).type], ["BOOLEAN_OPERATION", "LINE", "BOOLEAN_OPERATION"]);
  eq(notesOf(IDS.boolB, I).map((n) => n.detail), ["operand strokes"]);
  eq(R.native.stats.booleans, { native: 5, flattened: 0, foldedNodes: 0, degenerate: 1 });
});
check("a boolean with no operand and no geometry is not carried (GEOMETRY_INVALID)", () => {
  eq(idx(ir, IDS.boolEmpty), -1);
  return ir.notes.some((n) => n.code === CODE.GEOMETRY_INVALID && n.guid === IDS.boolEmpty);
});

// ---------- 10. GEOMETRY_INVALID ----------
check("a NaN size takes its box from the stored geometry, and a NaN group from its children", () => {
  const v = rec(IDS.nanVector).props, g = rec(IDS.nanGroup).props;
  eq([v.width, v.height, g.width, g.height], [7, 5, 9, 8]);
  eq([codesOf(IDS.nanVector).includes(CODE.GEOMETRY_INVALID), codesOf(IDS.nanGroup)], [true, [CODE.GEOMETRY_INVALID]]);
});
check("a NaN size whose geometry is NaN too is not carried", () => {
  eq(idx(ir, IDS.nanBad), -1);
  return ir.notes.some((n) => n.code === CODE.GEOMETRY_INVALID && n.guid === IDS.nanBad);
});

// ---------- 11. paints, effects, images ----------
check("effects: shadows with their keys, a blur with radius and visibility only, an unsupported effect dropped", () => {
  const p = rec(IDS.effects).props;
  eq(val(p.effects), [
    { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25098 }, offset: { x: 0, y: 2 }, radius: 4, spread: 1, visible: true, blendMode: "NORMAL", showShadowBehindNode: false },
    { type: "INNER_SHADOW", color: { r: 1, g: 1, b: 1, a: 1 }, offset: { x: 1, y: 1 }, radius: 2, spread: 0, visible: true, blendMode: "NORMAL" },
    { type: "LAYER_BLUR", radius: 3, visible: false },
  ]);
  eq([p.opacity, p.blendMode], [0.5, "PASS_THROUGH"]);
  eq(notesOf(IDS.effects).map((n) => n.detail).sort(), ["effect MOTION_BLUR", "export format TIFF"]);
});
check("a gradient paint: its transform, its stops with alpha, its blend mode; export settings", () => {
  eq(val(rec(IDS.effects).props.fills), [{ type: "GRADIENT_LINEAR", gradientTransform: [[0, 1, 0], [-1, 0, 1]],
    gradientStops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 0.501961 }, position: 1 }], blendMode: "MULTIPLY" }]);
  eq(val(rec(IDS.effects).props.exportSettings), [{ format: "PNG", suffix: "@2x", constraint: { type: "SCALE", value: 2 } }]);
});
check("images: present means a matching SHA-1; the JPEG under .png is sniffed; a missing one has no format", () => {
  const hex = (b) => b.toString("hex");
  const byHash = new Map(ir.images.map((m) => [m.hash, m]));
  eq(byHash.get(hex(fx.image.hash)), { hash: hex(fx.image.hash), present: true, format: "png" });
  eq(byHash.get(hex(fx.jpeg.hash)), { hash: hex(fx.jpeg.hash), present: true, format: "jpeg" });
  eq(byHash.get(hex(fx.missingHash)), { hash: hex(fx.missingHash), present: false });
  eq(byHash.get(hex(fx.mismatch.name)), { hash: hex(fx.mismatch.name), present: false });
  eq(stats.images, { referenced: 4, present: 2, missing: 2, hashMismatch: 1, formats: { png: 1, jpeg: 1 } });
});
check("an archive entry whose SHA-1 is not its name: IMAGE_HASH_MISMATCH, treated as missing", () => {
  const n = ir.notes.filter((x) => x.code === CODE.IMAGE_HASH_MISMATCH);
  return n.length === 1 && n[0].node === undefined;
});
check("image paints: STRETCH is CROP with its transform; TILE scales; rotation under 360; Figma's filters only", () => {
  eq(val(rec(IDS.jpegRect).props.fills)[0], { type: "IMAGE", scaleMode: "CROP", imageHash: fx.jpeg.hash.toString("hex"), imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]] });
  eq(val(rec(IDS.mismatchRect).props.fills)[0], { type: "IMAGE", scaleMode: "TILE", imageHash: fx.mismatch.name.toString("hex"), scalingFactor: 0.5, rotation: 90, filters: { exposure: 0.25 } });
  eq(notesOf(IDS.mismatchRect).map((n) => n.detail), ["vibrance"]);
});
check("a STAR and a POLYGON with no stored geometry: no oracle, and a SOURCE_FEATURE_UNSUPPORTED note that says so (review S3)", () => {
  for (const [g, t, pc] of [[IDS.starShape, "STAR", 5], [IDS.polygonShape, "POLYGON", 6]]) {
    const r = rec(g);
    eq([r.type, r.props.pointCount, r.props.oracleFillGeometry], [t, pc, undefined]);
    eq(notesOf(g).map((n) => [n.code, n.detail]), [[CODE.SOURCE_FEATURE_UNSUPPORTED, "no stored geometry: a " + t + " built natively, its paths unchecked"]]);
  }
  eq(rec(IDS.starShape).props.innerRadius, 0.5);
});
check("per-region fills (vectorPaints, by region index) become the regions' fills (review R4)", () => {
  const white = { type: 1, color: { r: 255, g: 255, b: 255, a: 255 }, opacity: 1, visible: true };
  const r = pixToIR(mutated((v, at) => { at(IDS.vNet).vectorPaints = [{ regionId: 0, paints: [white] }, { regionId: 7, paints: [white] }]; }));
  const net = val(rec(IDS.vNet, r.ir).props.vectorNetwork, r.ir);
  eq([net.regions.length, net.regions[0].fills.length, net.regions[0].fills[0].type, net.regions[0].fills[0].color, r.stats.vectors.regionFills], [1, 1, "SOLID", { r: 1, g: 1, b: 1 }, 1]);
  eq([validate(r.ir).ok, val(rec(IDS.vNet).props.vectorNetwork).regions[0].fills], [true, undefined]);
});
check("layout grids are counted SOURCE_FEATURE_UNSUPPORTED on the frame that has them (review R7)", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.sides).layoutGrids = [{ pattern: 1, sectionSize: 8, visible: true }, { pattern: 2, sectionSize: 4, visible: false }]; }));
  eq([notesOf(IDS.sides, r.ir).map((n) => n.detail).filter((d) => /^layoutGrids/.test(d)), r.stats.unsupported.layoutGrids], [["layoutGrids: 2 grids, not carried"], 1]);
});
check("values are interned once each, compared as canonical JSON", () => new Set(ir.values.map((v) => canonicalJSON(v))).size === ir.values.length);

// ---------- 12. scope ----------
check("--scope pages: one top-level object; the master an instance names joins it", () => {
  const one = pixToIR(fx.pix, { settings: { scope: "pages:" + IDS.sides } });
  eq(one.ir.nodes.filter((n) => n.parent === -1).map((n) => n.guid), [IDS.sides]);
  eq(one.ir.header.scope, { kind: "pages", ids: [IDS.sides] });
  const card = pixToIR(fx.pix, { settings: { scope: "pages:1:60" } });
  eq(card.ir.nodes.filter((n) => n.parent === -1).map((n) => n.guid), ["1:60", "1:20", "1:30"]);
  const nc = Object.values(card.stats.notCarried).reduce((a, b) => a + b, 0);
  eq(card.stats.records + nc, card.stats.stored);
  return card.stats.notCarried.outOfScope + " stored nodes out of scope";
});

// ---------- 13. pix-to-ir ----------
const tmp = mkdtempSync(join(tmpdir(), "pxf-irread-"));
try {
  const file = join(tmp, "fixture.pix");
  writeFileSync(file, fx.pix);
  const run = (...args) => spawnSync(process.execPath, [join(HERE, "pix-to-ir.mjs"), ...args], { encoding: "utf8" });
  const inside = join(HERE, "pxf-ir-refused-" + process.pid + ".json");
  const r1 = run(file, "--out", inside);
  if (r1.status === 2 && /inside the repository/.test(r1.stderr) && !existsSync(inside)) ok("pix-to-ir refuses an --out inside the repository and writes nothing");
  else fail("pix-to-ir --out inside the repository: exit " + r1.status + ", " + JSON.stringify(r1.stderr.slice(0, 200)));
  const out = join(tmp, "ir.json");
  const r2 = run(file, "--out", out, "--booleans", "native");
  if (r2.status === 0 && readFileSync(out, "utf8") === JSON.stringify(R.native.ir) && existsSync(out + ".stats.json") &&
      JSON.parse(r2.stdout).records === R.native.ir.nodes.length) ok("pix-to-ir writes the IR outside the repository, and the stats beside it");
  else fail("pix-to-ir outside the repository: exit " + r2.status + ", " + JSON.stringify((r2.stderr || "").slice(0, 300)));
  const r3 = run(file, "--stats-only");
  if (r3.status === 0 && JSON.parse(r3.stdout).stored === 89) ok("pix-to-ir --stats-only prints counts and writes nothing");
  else fail("pix-to-ir --stats-only: exit " + r3.status);
  const bad = join(tmp, "truncated.pix");
  writeFileSync(bad, makeFixture("truncated").pix);
  const r4 = run(bad, "--out", join(tmp, "x.json"));
  if (r4.status === 1 && /^PIX_CORRUPT:/.test(r4.stderr) && !existsSync(join(tmp, "x.json"))) ok("pix-to-ir on a damaged file: one PIX_CORRUPT line, exit 1, nothing written");
  else fail("pix-to-ir on a damaged file: exit " + r4.status + ", " + JSON.stringify(r4.stderr.slice(0, 200)));
  const r5 = run(file, "--out", join(tmp, "y.json"), "--booleans", "frame");
  if (r5.status === 2 && /booleans/.test(r5.stderr)) ok("pix-to-ir refuses a setting outside its values");
  else fail("pix-to-ir with --booleans frame: exit " + r5.status);
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log("");
console.log(failed ? failed + " reader check" + (failed === 1 ? "" : "s") + " FAILED" : "all reader checks pass");
process.exit(failed ? 1 : 0);
