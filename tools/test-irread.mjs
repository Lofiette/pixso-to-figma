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
const { makeFixture, IDS, M2A, encodeVectorNetwork, encodePath } = await import("./pix/fixture.mjs");
const { pixToIR, decodeVectorNetwork } = await import("./pix/ir/index.mjs");
const { validate } = await import("./ir/validate.mjs");
const { CODE, REASON_CODES, canonicalJSON } = await import("./ir/schema.mjs");
const { closeLoop } = await import("./pix/ir/vector.mjs");
const { dashNoGap } = await import("./pix/ir/strokes.mjs");

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
// frames: M1's D7 (no variant sets), the reading M1's component checks below hold under since IR
// version 3 parses sets (docs/M2A.md D2, §5.4).
const R = { auto: read(), native: read({ booleans: "native" }), flatten: read({ booleans: "flatten" }), center: read({ spaceEvenlySingle: "center" }), between: read({ spaceEvenlySingle: "between" }),
  frames: read({ variantSets: "frames" }) };
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
check("the header: format, version 3, pix source, file scope, the settings", () => {
  eq(ir.header.format, "pix2fig.ir"); eq(ir.header.version, 3); eq(ir.header.source.kind, "pix");
  eq(ir.header.scope, { kind: "file" });
  eq([ir.header.settings.booleans, ir.header.settings.spaceEvenlySingle, ir.header.settings.textFit], ["auto", "center", "widen"]);
  eq(R.flatten.ir.header.settings.booleans, "flatten");
  return /^[0-9a-f]{64}$/.test(ir.header.source.sha256);
});
check("an unknown setting or value is refused, naming the choices", () => {
  for (const s of [{ booleans: "frame" }, { spaceEvenlySingle: "left" }, { textFit: "x" }, { scope: "page:1" }, { colour: "red" }, { lineDirection: "diagonal" }, { dashNoGap: "dotted" }]) {
    let threw = false;
    try { read(s); } catch (e) { threw = /pixToIR:/.test(e.message); }
    if (!threw) throw new Error("accepted " + JSON.stringify(s));
  }
});
check("IR notes carry read-stage codes only", () => ir.notes.every((n) => REASON_CODES[n.code] && REASON_CODES[n.code].stage === "read"));

// ---------- 2. pages, populations and the balance ----------
check("pages in position order; the DIRECTORY's canvas is a page, the folder is not", () => {
  eq(ir.pages.map((p) => [p.guid, p.internal]), [["0:1", false], [IDS.casesPage, false], [M2A.page, false], ["0:2", true]]);
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
  // The M2a cases (docs/M2A.md §5.4) add a page, a symbol that is not carried (a non-finite
  // transform: degenerate) and a class B boolean whose two operands fold.
  eq(nc, { pages: 4, directories: 1, documents: 0, styleDefinitions: 2, variables: 0, unsupported: 1, foldedOperands: 7, degenerate: 3, outOfScope: 0 });
  const sum = Object.values(nc).reduce((a, b) => a + b, 0);
  eq([stats.stored, ir.nodes.length, stats.records + sum], [183, 165, 183]);
  return "183 = 165 + " + sum;
});
check("the populations, as root records and record counts", () => {
  const P = stats.populations, n = (k) => P[k].length;
  eq([n("userTop"), n("userMasters"), n("mastersNoInstance"), n("mastersWithInstanceInternal"), n("internalLoose"), n("stateGroupsInternal"), n("lostBorder")],
    [44, 2, 21, 7, 0, 8, 4]);
  // M1's, then the M2a cases': icons, the library set's members, the rejected and vocabulary sets' members.
  eq(P.mastersNoInstance.map((i) => ir.nodes[i].guid), ["1:11", "1:14", "1:20", "1:22", "1:40", M2A.circle, M2A.square, M2A.triangle, M2A.spacer,
    M2A.libTagLight, M2A.libTagDark, M2A.rejNoEqualsA, M2A.rejNoEqualsB, M2A.rejDupAxisA, M2A.rejDupAxisB, M2A.rejAxisCountA, M2A.rejAxisCountB,
    M2A.rejDupCoordA, M2A.rejDupCoordB, M2A.vocabA, M2A.vocabB]);
  eq(P.mastersWithInstanceInternal.map((i) => ir.nodes[i].guid), ["1:30", M2A.chipS, M2A.chipHoverS, M2A.chipM, M2A.chipL, M2A.row, M2A.card]);
  eq(P.stateGroupsInternal.map((i) => ir.nodes[i].guid), ["1:10", M2A.libTag, M2A.chip, M2A.rejNoEquals, M2A.rejDupAxis, M2A.rejAxisCount, M2A.rejDupCoord, M2A.vocab]);
  eq(P.userMasters.map((i) => ir.nodes[i].guid), [M2A.toggleOff, M2A.toggleOn]);
  eq(P.lostBorder.map((i) => ir.nodes[i].guid), [IDS.ring, IDS.dashed, IDS.noPath, M2A.rowBg]);
  eq(stats.lostBorderSections, 1);
  const C = stats.populationCounts;
  eq(C.mastersNoInstance, { records: 43, nonInstance: 43, instances: 0 });
  eq(C.mastersWithInstanceInternal, { records: 38, nonInstance: 27, instances: 11 });
  eq(C.userTop.instances, 16);
  eq(C.userTop.records + C.mastersNoInstance.records + C.mastersWithInstanceInternal.records + C.stateGroupsInternal.records + C.internalLoose.records, ir.nodes.length);
  for (const k of ["userTop", "mastersNoInstance"]) for (const i of P[k]) if (k === "userTop" ? ir.nodes[i].parent !== -1 : ir.nodes[i].type !== "COMPONENT") throw new Error(k + " holds " + i);
});
check("the unsupported node type is not carried, noted by guid", () => {
  const n = ir.notes.filter((x) => x.code === CODE.NODE_TYPE_UNSUPPORTED);
  eq(n.map((x) => [x.guid, x.node]), [[IDS.unsupported, undefined]]);
  return n[0].detail;
});
// Under --variant-sets frames: M1's D7, which docs/M2A.md D13 keeps as a setting.
check("components (--variant-sets frames): standalone entries; a library copy keeps its identity, an own internal master is deleted", () => {
  const ir = R.frames.ir, rec = (g) => ir.nodes[idx(ir, g)];
  const c = (g) => ir.components.find((x) => ir.nodes[x.node].guid === g);
  eq(c("1:40").library, { publishFile: "fixturelibraryfilekey00", publishID: "50:7", componentKey: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", sharedSymbolVersion: "fixture-version-3" });
  eq([c("1:30").set, c("1:30").deleted, c("1:11").set], [null, true, null]);
  eq(ir.components.length, ir.nodes.filter((n) => n.type === "COMPONENT").length);
  eq(rec("1:10").type, "FRAME");
  return !ir.notes.some((n) => n.code === CODE.VARIANT_SET_REJECTED) && ir.sets.length === 0;
});
check("instances are placeholders naming their master's record, with no child records", () => {
  // The master only: the rest of an instance's data is M2a's (docs/M2A.md D6-D11).
  eq(rec("1:60").instance.master, { guid: "1:30" });
  eq(rec("1:62").instance.master, { guid: "1:40" });
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
check("a dash pattern with no gap is solid: not written under dashNoGap solid, counted; written under keep (§15.15)", () => {
  const dashed = (pattern, settings) => pixToIR(mutated((v, at) => { at(IDS.dashed).dashPattern = pattern; }), { settings });
  const solid = dashed([1, 0]), kept = dashed([1, 0], { dashNoGap: "keep" }), odd = dashed([1.5, 0, 2]), under = dashed([2, 0.001]);
  const p = rec(IDS.dashed, solid.ir).props;
  eq([p.dashPattern, val(p.strokes, solid.ir).length, p.strokeWeight, solid.stats.dashNoGap, stats.dashNoGap, solid.ir.header.settings.dashNoGap], [undefined, 1, 1, 1, 0, "solid"]);
  eq([val(rec(IDS.dashed, kept.ir).props.dashPattern, kept.ir), kept.stats.dashNoGap, kept.ir.header.settings.dashNoGap], [[1, 0], 0, "keep"]);
  // An odd pattern repeats, so [1.5, 0, 2] has the gaps 0, 1.5, 0 in turn: dashed. A gap under the IR's
  // two decimals is no gap.
  eq([val(rec(IDS.dashed, odd.ir).props.dashPattern, odd.ir), rec(IDS.dashed, under.ir).props.dashPattern, under.stats.dashNoGap], [[1.5, 0, 2], undefined, 1]);
  eq([[1, 0], [0, 0], [2, 0, 3, 0], [4, 2], [1, 0, 1], [1.5, 0, 2]].map(dashNoGap), [true, true, true, false, false, false]);
});
check("the side census: population, checked, agree, unproven, and why there is no oracle", () => {
  // The M2a cases add one: Row's background, a stroked rectangle with no stroke-area path.
  eq(stats.sides, { population: 8, checked: 4, agree: 3, unproven: 1, noOracle: { noPath: 3, dashed: 1, small: 0 } });
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
check("a stroke whose every side rounds to 0 (a 0.001 px border) is weight 0 and takes no side oracle (U, docs/M1.md §15.13)", () => {
  // The ring's stroke-area path holds a ring every side of which the oracle samples as drawn; at
  // 0.001 px the IR's weight is 0, and an oracle saying "drawn" would contradict it (G8).
  const r = pixToIR(mutated((v, at) => { at(IDS.ring).strokeWeight = 0.001; }));
  const p = rec(IDS.ring, r.ir).props;
  eq([p.strokeWeight, p.strokeWeights, p.oracleSides, codesOf(IDS.ring, r.ir).indexOf(CODE.SIDE_RULE_UNPROVEN), r.stats.thinStrokes, validate(r.ir).ok], [0, undefined, undefined, -1, 1, true]);
  // At the IR's precision (0.01) the oracle is still taken.
  const q = pixToIR(mutated((v, at) => { at(IDS.ring).strokeWeight = 0.01; }));
  eq([rec(IDS.ring, q.ir).props.strokeWeight, rec(IDS.ring, q.ir).props.oracleSides, q.stats.thinStrokes], [0.01, [true, true, true, true], 0]);
  eq(stats.thinStrokes, 0);
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
check("PERCENT 1 is 100 %, counted (docs/M1.md §15.14, C08; review R3 read it as AUTO); PERCENT 1.5 stays 150 %", () => {
  const one = pixToIR(mutated((v, at) => { at(IDS.text).lineHeight = { value: 1, units: 3 }; }));
  const half = pixToIR(mutated((v, at) => { at(IDS.text).lineHeight = { value: 1.5, units: 3 }; }));
  eq([val(rec(IDS.text, one.ir).props.lineHeight, one.ir), one.stats.text.percentOne], [{ unit: "PERCENT", value: 100 }, 1]);
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

// ---------- 5b. text after the first render audit (docs/M1.md §15.14) ----------
// The fixture's enums: TextCase UPPER 2, TextDecoration UNDERLINE 2, NumberUnits PIXELS 2, TextAlignVertical
// CENTER 2, TextTruncation ENDING 1, LeadingTrim CAP_HEIGHT 1, FontVariantNumericSpacing TABULAR 3.
const PX = (value) => ({ value, units: 2 });
check("a text bound to a style takes the style's case, decoration and paragraph fields; a node's own differing one is counted (C05)", () => {
  const r = pixToIR(mutated((v, at) => {
    const s = at(IDS.textStyle), t = at(IDS.textFromStyle);
    s.textCase = 2; s.textDecoration = 2; s.paragraphSpacing = 8; s.paragraphIndent = 4;
    delete t.textCase; delete t.textDecoration;
  }));
  const p = rec(IDS.textFromStyle, r.ir).props;
  eq([p.textCase, p.textDecoration, p.paragraphSpacing, p.paragraphIndent, r.stats.text.styleValueOverridden], ["UPPER", "UNDERLINE", 8, 4, 0]);
  const o = pixToIR(mutated((v, at) => { at(IDS.textStyle).textCase = 2; at(IDS.textFromStyle).textCase = 3; }));
  eq([rec(IDS.textFromStyle, o.ir).props.textCase, o.stats.text.styleValueOverridden], ["UPPER", 1]);
});
check("number forms and OpenType features on the text style alone are counted SOURCE_FEATURE_UNSUPPORTED too (C04)", () => {
  const r = pixToIR(mutated((v, at) => { at(IDS.textStyle).fontVariantNumericSpacing = 3; at(IDS.textStyle).toggledOnOTFeatures = [6]; }));
  eq(notesOf(IDS.textFromStyle, r.ir).map((n) => n.detail).filter((d) => d === "fontVariantNumeric" || d === "OpenType features"), ["fontVariantNumeric", "OpenType features"]);
});
// "Hi 😀 there\nsecond": code points 0-2 and 7-10 are the base style's, 3-6 style 1 (fontSize 20), 11-16 style 2 (Bold).
const glyphRow = (size, gap, cps) => {
  let x = 0;
  return cps.map((c) => { const g = { blobIndex: 9, position: { x, y: 14 }, styleID: 0, fontSize: size, firstCharacter: c, advance: 6 }; x += 6 + gap; return g; });
};
check("an absent size and letter spacing come from the stored glyphs where they agree, noted TEXT_VALUE_FROM_GLYPHS (C07)", () => {
  const r = pixToIR(mutated((v, at) => {
    const t = at(IDS.text);
    delete t.fontSize; delete t.letterSpacing;
    t.textData.glyphs = glyphRow(10, 0.4, [0, 1, 2]).concat([{ blobIndex: 9, position: { x: 30, y: 14 }, styleID: 1, fontSize: 20, firstCharacter: 3, advance: 12 }],
      glyphRow(10, 0.4, [7, 8, 9]).map((g) => Object.assign(g, { position: { x: g.position.x + 60, y: 14 } })));
  }));
  const p = rec(IDS.text, r.ir).props;
  eq([p.fontSize, val(p.letterSpacing, r.ir), r.stats.text.fontSizeFromGlyphs, r.stats.text.letterSpacingFromGlyphs], [10, { unit: "PIXELS", value: 0.4 }, 1, 1]);
  eq(notesOf(IDS.text, r.ir).filter((n) => n.code === CODE.TEXT_VALUE_FROM_GLYPHS).map((n) => n.detail.split("; ").slice(0, 2)), [["fontSize 10 (absent: 14)", "letterSpacing 0.4 px (absent: 0)"]]);
  // At 14 with no gap, or a gap from two pairs only, or a spacing the node stores: nothing changes.
  const plain = pixToIR(mutated((v, at) => { const t = at(IDS.text); delete t.fontSize; delete t.letterSpacing; t.textData.glyphs = glyphRow(14, 0, [0, 1, 2, 7]); }));
  const two = pixToIR(mutated((v, at) => { const t = at(IDS.text); delete t.letterSpacing; t.textData.glyphs = glyphRow(14, 0.4, [0, 1, 2]); }));
  const stored = pixToIR(mutated((v, at) => { at(IDS.text).textData.glyphs = glyphRow(14, 0.4, [0, 1, 2]).concat(glyphRow(14, 0.4, [7, 8, 9])); }));
  eq([rec(IDS.text, plain.ir).props.fontSize, rec(IDS.text, plain.ir).props.letterSpacing, codesOf(IDS.text, plain.ir).includes(CODE.TEXT_VALUE_FROM_GLYPHS)], [14, undefined, false]);
  eq([rec(IDS.text, two.ir).props.letterSpacing, val(rec(IDS.text, stored.ir).props.letterSpacing, stored.ir)], [undefined, { unit: "PERCENT", value: 6.25 }]);
});
check("list items: listSpacing is the paragraph spacing; a list starting past 1 is SOURCE_FEATURE_UNSUPPORTED (C09)", () => {
  const r = pixToIR(mutated((v, at) => { const t = at(IDS.text); t.paragraphSpacing = 16; t.textData.paragraphStyle[1].listStartOffset = 4; }));
  const p = rec(IDS.text, r.ir).props;
  eq([p.paragraphSpacing, p.listSpacing, r.stats.text.listSpacingFromParagraph], [16, 16, 1]);
  eq(notesOf(IDS.text, r.ir).filter((n) => /^list start number/.test(n.detail || "")).map((n) => n.detail), ["list start number: a list starts at 5; Figma numbers it from 1"]);
  const none = pixToIR(mutated((v, at) => { const t = at(IDS.textNoLines); t.paragraphSpacing = 16; }));
  eq(rec(IDS.textNoLines, none.ir).props.listSpacing, undefined);
});
check("a text Pixso cut with an ellipsis has the lines before the cut; an uncut one every stored line (C03)", () => {
  const cut = pixToIR(mutated((v, at) => { const t = at(IDS.text); t.textTruncation = 1; t.maxLines = 1; t.textData.truncationStartIndex = 8; }));
  const uncut = pixToIR(mutated((v, at) => { const t = at(IDS.text); t.textTruncation = 1; t.maxLines = 1; t.textData.truncationStartIndex = -1; }));
  eq([rec(IDS.text, cut.ir).props.lines, cut.stats.text.truncatedLines, rec(IDS.text, uncut.ir).props.lines], [1, 1, 2]);
});
check("firstLineShift: written where the stored first baseline is more than 0.5 px off its half-leading place (C01, C02)", () => {
  // Inter Medium 16 (the style's), natural 1.21 x 16 = 19.36, ascent 15.5, line height 20: half-leading
  // puts the baseline at (20 - 19.36) / 2 + 15.5 = 15.82 below the line's top.
  const at16 = (y, more) => pixToIR(mutated((v, at) => {
    const t = at(IDS.textFromStyle);
    t.lineHeight = PX(20); t.size = { x: 60, y: more && more.h ? more.h : 20 };
    t.textData.baselines = [{ position: { x: 0, y }, width: 40, lineY: 0, lineHeight: 20, lineAscent: 15.5, firstCharacter: 0, endCharacter: 6 }];
    t.textData.fontMetaData = more && more.noMetrics ? [] : [{ key: { family: "Inter", style: "Medium", postscript: "" }, fontLineHeight: 1.21 }];
    if (more && more.center) t.textAlignVertical = 2;
    if (more && more.trim) t.leadingTrim = 1;
  }));
  const half = at16(16), high = at16(14), low = at16(17.5), center = at16(18, { h: 24, center: true }), trimmed = at16(14, { trim: true }), unknown = at16(14, { noMetrics: true });
  const shift = (r) => rec(IDS.textFromStyle, r.ir).props.firstLineShift;
  eq([shift(half), shift(high), shift(low), shift(center), shift(trimmed), shift(unknown)], [undefined, -1.82, 1.68, undefined, undefined, undefined]);
  // The fixture's other texts have no metrics: counted unknown in every read.
  eq([half.stats.text.firstLine.halfLeading, high.stats.text.firstLine.shifted, trimmed.stats.text.firstLine.trimmedInSource,
    unknown.stats.text.firstLine.unknown - half.stats.text.firstLine.unknown], [1, 1, 1, 1]);
  const v = validate(high.ir);
  if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2)));
  const bad = JSON.parse(JSON.stringify(high.ir));
  bad.nodes[idx(bad, IDS.textFromStyle)].props.firstLineShift = 0.3;
  return validate(bad).errors.some((e) => /firstLineShift/.test(e.path)) ? "a shift within 0.5 px is refused by the validator" : false;
});
check("a cap-height trim the text style sets is the text's: leadingTrim CAP_HEIGHT, trimmed in the source, no firstLineShift (U: 7 texts)", () => {
  // The stored baseline 2 px above half-leading, as in U's 9 px labels, where the style's trim puts it.
  const r = pixToIR(mutated((v, at) => {
    const t = at(IDS.textFromStyle);
    at(IDS.textStyle).leadingTrim = 1; delete t.leadingTrim;
    t.lineHeight = PX(20); t.size = { x: 60, y: 20 };
    t.textData.baselines = [{ position: { x: 0, y: 14 }, width: 40, lineY: 0, lineHeight: 20, lineAscent: 15.5, firstCharacter: 0, endCharacter: 6 }];
    t.textData.fontMetaData = [{ key: { family: "Inter", style: "Medium", postscript: "" }, fontLineHeight: 1.21 }];
  }));
  const p = rec(IDS.textFromStyle, r.ir).props;
  eq([p.leadingTrim, p.firstLineShift, r.stats.text.firstLine.trimmedInSource, r.stats.text.firstLine.shifted, r.stats.text.styleValueOverridden], ["CAP_HEIGHT", undefined, 1, 0, 0]);
});
check("TEXT_GLYPHS_INVALID: a text whose stored glyphs are not glyph outlines, by class; a real glyph and an empty space are not (C06)", () => {
  const read = (blobs, chars) => pixToIR(mutated((v, at) => {
    const t = at(IDS.text), first = v.blobs.length;
    for (const b of blobs) v.blobs.push({ bytes: b });
    t.textData.glyphs = blobs.map((b, k) => ({ blobIndex: first + k, position: { x: 8 * k, y: 14 }, styleID: 0, fontSize: 14, firstCharacter: chars[k], advance: 8 }))
      .concat([{ blobIndex: 9, position: { x: 80, y: 14 }, styleID: 0, fontSize: 14, firstCharacter: 7, advance: 8 }]);
  }));
  const slab = encodePath([[1, 0, 0], [2, 199, 0], [2, 199, -72], [2, 0, -72], [0]]);
  const far = encodePath([[1, -1.04e34, 0], [2, 0.5, -0.7], [0]]);
  const none = encodePath([[1, 0, 0], [2, 1e-38, 2e-38], [0]]);
  const detail = (r) => notesOf(IDS.text, r.ir).filter((n) => n.code === CODE.TEXT_GLYPHS_INVALID).map((n) => n.detail.split(";")[0]);
  const a = read([none, slab, far], [0, 1, 5]), b = read([slab], [0]), c = read([none], [0]), d = read([none], [2]);
  eq([detail(a), detail(b), detail(c), detail(d), detail(R.auto)], [["drops-text: 3 of 4 stored glyphs are not glyph outlines (drops-text 1, slab 1, empty 1)"],
    ["slab: 1 of 2 stored glyphs are not glyph outlines (slab 1)"], ["empty: 1 of 2 stored glyphs are not glyph outlines (empty 1)"], [], []]);
  eq([a.stats.text.glyphsInvalid["drops-text"], b.stats.text.glyphsInvalid.slab, c.stats.text.glyphsInvalid.empty], [1, 1, 1]);
  for (const r of [a, b, c]) { const v = validate(r.ir); if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 2))); }
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
check("a vertex style's radius of 0 under a node radius is the vertex's own 0 (U, docs/M1.md §15.13)", () => {
  // Pixso draws such a vertex sharp; without it in the IR the builder would give it the node's radius.
  const r = pixToIR(mutated((v, at) => { at(IDS.vNet).cornerRadius = 3; at(IDS.vNet).vectorData.styleOverrideTable[0].cornerRadius = 0; }));
  const net = val(rec(IDS.vNet, r.ir).props.vectorNetwork, r.ir);
  eq([rec(IDS.vNet, r.ir).props.cornerRadius, net.vertices.map((x) => x.cornerRadius), r.stats.vectors.vertexRadiusZero, validate(r.ir).ok], [3, [undefined, undefined, 0, undefined], 1, true]);
  // With no node radius an own 0 says nothing the absent radius does not: it is left out.
  const q = pixToIR(mutated((v, at) => { at(IDS.vNet).vectorData.styleOverrideTable[0].cornerRadius = 0; }));
  eq([val(rec(IDS.vNet, q.ir).props.vectorNetwork, q.ir).vertices[2].cornerRadius, q.stats.vectors.vertexRadiusZero], [undefined, 0]);
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
check("a LINE with a height and no stored stroke area runs along its size: turned onto (0,0)-(w,h), its width the length (§15.15)", () => {
  // The fixture's 20 x 6 LINE at (220, 240): 20.88 long, turned by atan2(6, 20). Its end, 220 + 0.9578 *
  // 20.88 and 240 + 0.2873 * 20.88, is (240, 246): the node's (w, h).
  const r = rec(IDS.lineHeight);
  eq([r.type, r.props.width, r.props.height, r.props.relativeTransform], ["LINE", 20.88, 0, [0.9578, -0.2873, 220, 0.2873, 0.9578, 240]]);
  eq([notesOf(IDS.lineHeight), stats.lines, ir.header.settings.lineDirection], [[], { alongSize: 1, flat: 0, noStoredArea: 1, subPrecision: 0, inFlow: 0 }, "stored"]);
});
check("a LINE follows its own stored stroke area; --line-direction size and flat override it; a height under 0.005 is none; a turned one in a flow is counted", () => {
  const line = (edit, settings) => pixToIR(mutated((v, at) => {
    const n = at(IDS.lineHeight);
    if (edit.area) { v.blobs.push({ bytes: encodePath(edit.area) }); n.strokePaddingPath = [Object.assign({}, at(IDS.ring).strokePaddingPath[0], { blobIndex: v.blobs.length - 1 })]; }
    if (edit.size) n.size = edit.size;
    if (edit.transform) n.transform = edit.transform;
    if (edit.flow) { n.parentIndex = { guid: at(IDS.sides).guid, position: "z" }; if (edit.flow === "absolute") n.autoLayoutAbsolutePos = true; }
  }), { settings });
  const lineOf = (r) => { const p = rec(IDS.lineHeight, r.ir).props; return [p.width, p.height, p.relativeTransform, notesOf(IDS.lineHeight, r.ir).map((n) => n.detail), r.stats.lines]; };
  const L = (alongSize, flat, noStoredArea, subPrecision, inFlow) => ({ alongSize, flat, noStoredArea, subPrecision, inFlow: inFlow || 0 });
  // Pixso's stroke area of the 1 px line along x (flat), and along (20, 6): its middle in y says which.
  const flatArea = [[1, 0, -0.5], [2, 20, -0.5], [2, 20, 0.5], [2, 0, 0.5], [0]];
  const segArea = [[1, 0.14, -0.48], [2, 20.14, 5.52], [2, 19.86, 6.48], [2, -0.14, 0.48], [0]];
  const turned = [20.88, 0, [0.9578, -0.2873, 220, 0.2873, 0.9578, 240]], flat = [20, 0, [1, 0, 220, 0, 1, 240]];
  eq(lineOf(line({ area: segArea })), [...turned, [], L(1, 0, 0, 0)]);
  eq(lineOf(line({ area: flatArea })), [...flat, ["LINE with height: its stored stroke area runs along x: built flat, height dropped"], L(0, 1, 0, 0)]);
  eq(lineOf(line({ area: flatArea }, { lineDirection: "size" })), [...turned, [], L(1, 0, 0, 0)]);
  eq(lineOf(line({ area: segArea }, { lineDirection: "flat" })), [...flat, ["LINE with height: --line-direction flat: built flat, height dropped"], L(0, 1, 0, 0)]);
  // A vertical LINE as U's audited one (made up here): 0.001 x 30, its area x -0.5..0.5, y 0..30. Turned
  // a quarter, 30 long, where the IR had built it 0 long.
  eq(lineOf(line({ size: { x: 0.001, y: 30 }, area: [[1, 0.5, 0], [2, 0.5, 30], [2, -0.5, 30], [2, -0.5, 0], [0]] })), [30, 0, [0, -1, 220, 1, 0, 240], [], L(1, 0, 0, 0)]);
  // The turn composes with the node's own matrix: mirrored in x, the end is (220 - 20, 240 + 6).
  eq(lineOf(line({ transform: { m00: -1, m01: 0, m02: 220, m10: 0, m11: 1, m12: 240 } })).slice(0, 3), [20.88, 0, [-0.9578, 0.2873, 220, 0.2873, 0.9578, 240]]);
  // 0.001 px of height (U 157, P 88 such LINEs) is under the IR's precision: no turn, no note.
  eq(lineOf(line({ size: { x: 20, y: 0.001 } })), [...flat, [], L(0, 0, 0, 1)]);
  // A turned LINE that is an AUTO child of a flow (here Sides, a row) is counted: the builder takes it out
  // of the flow (rotPinned). One ABSOLUTE in a flow, as U's and O's 27 are, and one kept flat are not.
  eq([line({ flow: "auto" }), line({ flow: "absolute" }), line({ flow: "auto" }, { lineDirection: "flat" })].map((r) => r.stats.lines), [L(1, 0, 1, 0, 1), L(1, 0, 1, 0, 0), L(0, 1, 0, 0, 0)]);
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
  // M1's class B boolean (5 folded nodes) and Row's in the M2a cases (2 folded operands).
  eq(stats.booleans, { native: 3, flattened: 2, foldedNodes: 7, degenerate: 1 });
  return n[0].detail;
});
check("flatten: every outermost boolean is one VECTOR; nested ones fold", () => {
  const I = R.flatten.ir;
  eq([rec(IDS.boolA, I).type, rec(IDS.boolXor, I).type, rec(IDS.boolB, I).type, idx(I, IDS.boolNested)], ["VECTOR", "VECTOR", "VECTOR", -1]);
  eq(I.notes.filter((n) => n.code === CODE.BOOLEAN_FLATTENED).length, 4);
  eq(R.flatten.stats.booleans, { native: 0, flattened: 4, foldedNodes: 14, degenerate: 1 });
});
check("native: no boolean flattened; class B keeps its operands and notes the lost operand strokes", () => {
  const I = R.native.ir;
  eq(I.notes.filter((n) => n.code === CODE.BOOLEAN_FLATTENED).length, 0);
  eq([rec(IDS.boolB, I).type, rec(IDS.boolBLine1, I).type, rec(IDS.boolBInner, I).type], ["BOOLEAN_OPERATION", "LINE", "BOOLEAN_OPERATION"]);
  eq(notesOf(IDS.boolB, I).map((n) => n.detail), ["operand strokes"]);
  eq(R.native.stats.booleans, { native: 6, flattened: 0, foldedNodes: 0, degenerate: 1 });
});
check("a boolean with no operand and no geometry is not carried (GEOMETRY_INVALID)", () => {
  eq(idx(ir, IDS.boolEmpty), -1);
  return ir.notes.some((n) => n.code === CODE.GEOMETRY_INVALID && n.guid === IDS.boolEmpty);
});
check("a union whose stored result leaves out an operand, and the booleans made from it, are VECTOR_ORACLE_DIFFERS boolean-operands (U, docs/M1.md §15.13)", () => {
  const stale = (I) => I.notes.filter((n) => n.code === CODE.VECTOR_ORACLE_DIFFERS && /^boolean-operands: /.test(n.detail || "")).map((n) => [n.node, n.detail]);
  // The fixture's booleans store results that cover their operands: none is noted, under any setting.
  eq([stale(ir), stale(R.native.ir), stale(R.flatten.ir), stats.staleBooleans], [[], [], [], 0]);
  // The union stores A1's square alone (0..10), leaving out A2 (10..20): stale by 10 px.
  const a = pixToIR(mutated((v, at) => { at(IDS.boolA).fillGeometry = at(IDS.boolARect1).fillGeometry; }));
  eq([stale(a.ir), a.stats.staleBooleans, validate(a.ir).ok], [[[idx(a.ir, IDS.boolA), "boolean-operands: the stored result leaves out operand " + idx(a.ir, IDS.boolARect2) + " by 10 px"]], 1, true]);
  // A nested union made stale (its second operand moved out of its stored square): the outer boolean,
  // made from it, is stale too, whatever its own operands say.
  const b = pixToIR(mutated((v, at) => { at(IDS.boolNested).booleanOperation = at(IDS.boolA).booleanOperation; at(IDS.boolNestedB).transform = Object.assign({}, at(IDS.boolNestedB).transform, { m02: 10 }); }));
  const nb = idx(b.ir, IDS.boolNested);
  eq([rec(IDS.boolNested, b.ir).props.booleanOperation, stale(b.ir), validate(b.ir).ok],
    ["UNION", [[idx(b.ir, IDS.boolA), "boolean-operands: made from the out-of-date stored result of operand " + nb], [nb, "boolean-operands: the stored result leaves out operand " + idx(b.ir, IDS.boolNestedB) + " by 10 px"]], true]);
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
  // Pixso's vibrance is Figma's saturation (Pixso's plugin API reports it so; §15.15); hue has no Figma
  // field and is dropped and noted.
  eq(val(rec(IDS.mismatchRect).props.fills)[0], { type: "IMAGE", scaleMode: "TILE", imageHash: fx.mismatch.name.toString("hex"), scalingFactor: 0.5, rotation: 90, filters: { exposure: 0.25, saturation: 0.5 } });
  eq([notesOf(IDS.mismatchRect), stats.unsupported.vibrance], [[], undefined]);
  const hue = pixToIR(mutated((v, at) => { at(IDS.mismatchRect).fillPaints[0].paintFilter.hue = 0.25; }));
  eq(val(rec(IDS.mismatchRect, hue.ir).props.fills, hue.ir)[0].filters, { exposure: 0.25, saturation: 0.5 });
  eq(notesOf(IDS.mismatchRect, hue.ir).map((n) => n.detail), ["hue filter"]);
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
check("--scope pages: one top-level object; the master an instance names joins it, and the symbol its override swaps to (docs/M2A.md D12)", () => {
  const one = pixToIR(fx.pix, { settings: { scope: "pages:" + IDS.sides } });
  eq(one.ir.nodes.filter((n) => n.parent === -1).map((n) => n.guid), [IDS.sides]);
  eq(one.ir.header.scope, { kind: "pages", ids: [IDS.sides] });
  const card = pixToIR(fx.pix, { settings: { scope: "pages:1:60" } });
  // Card (1:30) and its nested icons' Star (1:20) as in M1; Heart (1:22), which the instance's override swaps to, since IR version 3.
  eq(card.ir.nodes.filter((n) => n.parent === -1).map((n) => n.guid), ["1:60", "1:20", "1:22", "1:30"]);
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
  if (r3.status === 0 && JSON.parse(r3.stdout).stored === 183) ok("pix-to-ir --stats-only prints counts and writes nothing");
  else fail("pix-to-ir --stats-only: exit " + r3.status);
  const bad = join(tmp, "truncated.pix");
  writeFileSync(bad, makeFixture("truncated").pix);
  const r4 = run(bad, "--out", join(tmp, "x.json"));
  if (r4.status === 1 && /^PIX_CORRUPT:/.test(r4.stderr) && !existsSync(join(tmp, "x.json"))) ok("pix-to-ir on a damaged file: one PIX_CORRUPT line, exit 1, nothing written");
  else fail("pix-to-ir on a damaged file: exit " + r4.status + ", " + JSON.stringify(r4.stderr.slice(0, 200)));
  const r5 = run(file, "--out", join(tmp, "y.json"), "--booleans", "frame");
  if (r5.status === 2 && /booleans/.test(r5.stderr)) ok("pix-to-ir refuses a setting outside its values");
  else fail("pix-to-ir with --booleans frame: exit " + r5.status);
  const r6 = run(file, "--out", join(tmp, "z.json"), "--names", "stored"), r7 = run(file, "--out", join(tmp, "w.json"), "--names", "shown");
  if (r6.status === 0 && JSON.parse(readFileSync(join(tmp, "z.json"), "utf8")).header.settings.names === "stored" && r7.status === 2 && /names/.test(r7.stderr) && !existsSync(join(tmp, "w.json")))
    ok("pix-to-ir takes --names stored into the header and refuses a value outside display, stored");
  else fail("pix-to-ir --names: exit " + r6.status + " and " + r7.status + ", " + JSON.stringify((r7.stderr || "").slice(0, 200)));
} finally { rmSync(tmp, { recursive: true, force: true }); }

// ---------- 14. layer names (docs/M1.md §15.16) ----------
// Pixso shows an instance named "Instance <n>", or with no name, under the name its root override entry
// carries, else under its master's name, or its state group's when the master is a variant of one; an
// empty-named text under its characters (measured live on U, 2026-10-06 and 2026-10-12). Planted on the
// fixture: the Button instance (a variant of the state group "Button"), the Badge instance (the library
// copy "Badge", two root entries naming it, which --override-merge decides between), the trailing icon
// inside Card's master ("Icon/Star"), a name that only looks like the pattern with a root entry naming
// it otherwise, two instances with no stored name (one named by a root entry), two empty-named texts.
{
  const G = (s, l) => ({ sessionID: s, localID: l });
  const plant = (v, at) => {
    at("1:61").name = "Instance 7"; at("1:62").name = "Instance 12"; at("1:33").name = "Instance 3";
    at("1:62").symbolData.symbolOverrides = [{ guidPath: { guids: [] }, name: "Badge (old)", overrideLevel: 1 }, { guidPath: { guids: [G(1, 40)] }, name: "Badge (shown)" }];
    at("1:32").name = "Instance 7a"; at("1:32").symbolData.symbolOverrides = [{ guidPath: { guids: [G(1, 20)] }, name: "Lead" }];
    delete at("1:60").name; at("1:60").symbolData.symbolOverrides.push({ guidPath: { guids: [G(1, 30)] }, name: "Card (shown)" });
    delete at(M2A.iNoDerived).name;
    at(IDS.text).name = ""; at(IDS.textNoLines).name = "";
  };
  const file = mutated(plant);
  const D = pixToIR(file), S = pixToIR(file, { settings: { names: "stored" } }), F = pixToIR(file, { settings: { variantSets: "frames" } });
  const first = pixToIR(file, { settings: { overrideMerge: "first" } });
  const GUIDS = ["1:61", "1:62", "1:33", "1:32", "1:60", M2A.iNoDerived, IDS.text, IDS.textNoLines];
  const names = (r) => GUIDS.map((g) => rec(g, r.ir).name);
  check("the IR validates under --names display and stored", () => [D, S, F, first].every((r) => validate(r.ir).ok) && D.ir.header.settings.names === "display" && S.ir.header.settings.names === "stored");
  check("--names display (the default): \"Instance <n>\" or no name takes the root entry's name, else the set's or the master's; any other name and an empty text's stay", () =>
    eq(names(D), ["Button", "Badge (shown)", "Icon/Star", "Instance 7a", "Card (shown)", "Spacer", "", ""]));
  check("--names stored keeps every stored name (\"\" where none is stored)", () => eq(names(S), ["Instance 7", "Instance 12", "Instance 3", "Instance 7a", "", "", "", ""]));
  check("an instance auto-named by Pixso's Russian interface (\"Экземпляр <n>\") takes the same display name; \"Экземпляр\" alone is a name", () => {
    const R = pixToIR(mutated((v, at) => { plant(v, at); at("1:33").name = "Экземпляр 3"; at("1:61").name = "Экземпляр"; }));
    return eq([rec("1:33", R.ir).name, rec("1:61", R.ir).name], ["Icon/Star", "Экземпляр"]);
  });
  check("the set's name comes from the stored state group, whatever --variant-sets makes of it", () => eq(rec("1:61", F.ir).name, "Button"));
  check("two root entries naming the instance merge by --override-merge, as its root override does", () => eq([rec("1:62", D.ir).name, rec("1:62", first.ir).name], ["Badge (shown)", "Badge (old)"]));
  check("stats.names counts the population under either setting", () => {
    eq(D.stats.names, { auto: { n: 3, toRoot: 1, toSet: 1, toMaster: 1, rootDiffers: 1 }, unnamed: { n: 2, toRoot: 1, toSet: 0, toMaster: 1, rootDiffers: 1 }, namedRootDiffers: 1, emptyTexts: 2 });
    eq(S.stats.names, D.stats.names);
    const zero = { n: 0, toRoot: 0, toSet: 0, toMaster: 0, rootDiffers: 0 };
    eq(stats.names, { auto: zero, unnamed: zero, namedRootDiffers: 0, emptyTexts: 0 });
  });
  // D8: a root entry's name equal to the record's is an echo; a different one is dropped root-box.
  const nameNoted = (r, code, re) => GUIDS.filter((g) => notesOf(g, r.ir).some((x) => x.code === code && re.test(x.detail)));
  const rootBoxName = (r) => nameNoted(r, CODE.OVERRIDE_FIELD_DROPPED, /^root-box: (.*, )?name 1\b/);
  const echoName = (r) => nameNoted(r, CODE.OVERRIDE_ECHO, /: (.*, )?name 1\b/);
  check("a root entry's name compares with the record's: an echo under display where the record took it, dropped root-box under stored (and for a named instance)", () => {
    eq([rootBoxName(D), rootBoxName(first), rootBoxName(S)], [["1:32"], ["1:32"], ["1:62", "1:32", "1:60"]]);
    eq([echoName(D), echoName(first), echoName(S)], [["1:62", "1:60"], ["1:62", "1:60"], []]);
    const dD = D.stats.m2a.overrides.rootBox, dS = S.stats.m2a.overrides.rootBox;
    eq([dD.echo - dS.echo, dS.differs - dD.differs], [2, 2]);
  });
  check("the setting changes names, the header and those notes on the root names, nothing else: overrides, components and sets are the same", () => {
    const strip = (r) => {
      const c = JSON.parse(JSON.stringify(r.ir));
      delete c.header.settings.names;
      c.nodes.forEach((n) => { delete n.name; });
      c.notes = c.notes.filter((x) => !((x.code === CODE.OVERRIDE_FIELD_DROPPED && x.detail === "root-box: name 1") || (x.code === CODE.OVERRIDE_ECHO && x.detail === "1 field: name 1")));
      return JSON.stringify(c);
    };
    return strip(D) === strip(S);
  });
}

console.log("");
console.log(failed ? failed + " reader check" + (failed === 1 ? "" : "s") + " FAILED" : "all reader checks pass");
process.exit(failed ? 1 : 0);
