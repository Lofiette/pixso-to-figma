// Part C's tests: the resolver, overrides and derived entries (docs/M2A.md D7-D11, D17, §6 C), on the
// synthetic fixture (tools/pix/fixture.mjs, M2A ids) only.
//
//   node tools/test-m2a-instances.mjs
//
// It checks:
//   - the resolver (resolve.mjs, D7) on every derived path of every fixture instance: every one
//     resolves under the defaults, each through the symbols the fixture's comments name (an outer
//     swap winning over a master's inner one, a swap by property through an alias, rule A skipping a
//     value that names no symbol, a symbol stored but not carried followed, rule B's no-op swap
//     resetting the nested Row's own swap, rule C's ignored assignment and the declared symbol on
//     every path through that hop); each rule switched off fails exactly its case (--swap-dangling
//     strict: Chip assigned's icon path resolves only through rule C, and not at all with
//     --swap-fallback off; --swap-reset off: Rule B's [5:421, 5:403, 5:310]; --swap-fallback off:
//     Rule C's [5:421, 5:402, 5:310]); the hop that matches only by overrideKey stays stale under every
//     setting;
//   - the IR (overrides.mjs, derived.mjs, D8-D11, D17): `at` indices on every override and derived
//     entry; a path of length 3 under the outer swap; the echo through a master's nested-instance
//     override (Echo nested) and the red Bg never echoed against the pre-swap master (Rule B); a
//     bound text's baseline is the property's effective value (planted: the override equal to the
//     assigned value is an echo, equal to the layer's own text it is not; boundConflicts); a no-op swap
//     kept; root box fields never in the path [] override (root-box under last, an echo under first);
//     a nested INSTANCE target's fill and style carried; not-on-type, layer-not-carried and
//     no-equivalent drops; the planted unknown field dropped "unknown" (gate G6 fails) with every
//     balance still holding; rule C's entry left empty and SWAP_ASSIGNMENT_IGNORED; each merge rule
//     on Entries' Bg fill; refused fields kept and classed; each --derived-geometry value;
//     --instance-own own; sparse and empty derived entries, lines, oracleSides, no derived data,
//     scale, exposed; the IR byte-identical twice and the same from the renumbered fixture;
//   - the census and OVERRIDE_SOURCE_FIELDS list the same fields (as tools/test-m2a-contract.mjs);
//   - stats.m2a.instances, .overrides and .derived: G6's three balances, G1's and G2's, under every
//     setting value.
// The checks that need part B's assignments() (nested and ignored assignments, G7's assignment
// balance) print "pending: B" while tools/pix/ir/properties.mjs is part P0's stub, and run once B is in.
// DONE WHEN (docs/M2A.md §6 C) this test passes and, on D, K, M and P: derived 35 808 / 35 808,
// 160 982 / 160 982, 86 941 / 86 941, 342 679 / 342 679 with 36 via rule C; live / stale 6 353 / 726,
// 42 456 / 950, 52 982 / 949, 107 190 / 6 563 with resolvedNotDerived and inDerivedUnresolved 0; no
// unknown field; root size all echo or root-box; the balances of §8 add up.
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const pending = (m) => console.log("pending: B (" + m + ")");
const check = (label, fn) => {
  try { const r = fn(); if (r === false) fail(label); else ok(label + (typeof r === "string" ? " (" + r + ")" : "")); }
  catch (e) { fail(label + ": " + (e && e.message ? e.message.split("\n")[0] : e)); }
};
const same = (a, b, what) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error((what ? what + " " : "") + "got " + x.slice(0, 400) + ", want " + y.slice(0, 400)); };
const truth = (c, what) => { if (!c) throw new Error(what); };
if (typeof zlib.zstdCompressSync !== "function") { console.log("FAIL part C's checks need Node 22.15 or newer (built-in zstd)"); process.exit(1); }
const imp = (p) => import(pathToFileURL(join(HERE, p)).href);

const schema = await imp("ir/schema.mjs");
const props = await imp("ir/props.mjs");
const { validate } = await imp("ir/validate.mjs");
const { makeFixture, M2A, M2A_PLANTS } = await imp("pix/fixture.mjs");
const reader = await imp("pix/ir/index.mjs");
const { readPix, childrenByParent } = await imp("pix/read.mjs");
const { enumReader } = await imp("pix/ir/enums.mjs");
const { propIndex } = await imp("pix/ir/propindex.mjs");
const { makeResolver } = await imp("pix/ir/resolve.mjs");
const overrides = await imp("pix/ir/overrides.mjs");
const properties = await imp("pix/ir/properties.mjs");
const B_IN = properties.STUB === undefined;

const FX = makeFixture();
const read = (settings, mutate) => reader.pixToIR(mutate ? makeFixture("valid", { mutate }).pix : FX.pix, { settings });
const BASE = read();
// The D17 default is part E's to set from part C's measurement; what depends on it reads "last" explicitly.
const LAST = schema.SETTING_DEFAULTS.overrideMerge === "last" ? BASE : read({ overrideMerge: "last" });
const recOf = (ir, g) => ir.nodes.findIndex((n) => n.guid === g);
const instOf = (ir, g) => ir.nodes[recOf(ir, g)].instance;
const P = (...gs) => gs;
const key = (path) => path.join("/");
const ovAt = (ir, g, path) => (instOf(ir, g).overrides || []).find((o) => key(o.path) === key(path));
const derAt = (ir, g, path) => (instOf(ir, g).derived || []).find((d) => key(d.path) === key(path));
const notesOf = (ir, g, code) => ir.notes.filter((x) => x.node === recOf(ir, g) && x.code === code);
const fill = (ir, idx) => ir.values[idx];
const RED = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
const sum = (o) => Object.values(o).reduce((a, b) => a + (typeof b === "number" ? b : sum(b)), 0);
const nameOf = Object.fromEntries(Object.entries(M2A).map(([k, v]) => [v, k]));
const show = (path) => path.map((g) => nameOf[g] || g).join("/");

// ---------- 1. the resolver alone (D7) ----------
const PIX = readPix(FX.pix);
const gs = (g) => (g ? g.sessionID + ":" + g.localID : null);
const byGuid = new Map(PIX.nodes.map((n) => [gs(n.guid), n]));
const en = enumReader(PIX.schema);
const typeOf = en("PixsoNode", "type");
const kids = childrenByParent(PIX.nodes);
const resolverWith = (settings) => {
  const cx = { pix: PIX, en, byGuid, typeName: (n) => typeOf(n.type), childrenOf: (n) => kids.get(gs(n.guid)) || [], componentGuids: new Set(),
    settings: Object.assign({}, schema.SETTING_DEFAULTS, settings || {}), indexOf: null };
  cx.props = propIndex(cx);
  return makeResolver(cx);
};
const INSTANCES = PIX.nodes.filter((n) => typeOf(n.type) === "INSTANCE");
// Every derived path of every stored instance that does not resolve, as "instance: path".
const failing = (R) => {
  const out = [];
  for (const n of INSTANCES) for (const d of n.derivedSymbolData || []) {
    const g = R.pathGuids(d);
    if (!R.resolve(n, g).ok) out.push((nameOf[gs(n.guid)] || gs(n.guid)) + ": " + show(g));
  }
  return out.sort();
};
const viaFallback = (R) => {
  const out = [];
  for (const n of INSTANCES) for (const d of n.derivedSymbolData || []) {
    const g = R.pathGuids(d), r = R.resolve(n, g);
    if (r.ok && r.fallback) out.push((nameOf[gs(n.guid)] || gs(n.guid)) + ": " + show(g));
  }
  return out.sort();
};
const R0 = resolverWith({});
const at = (inst, path) => R0.resolve(byGuid.get(inst), path);
const lastOf = (r) => r.elements[r.elements.length - 1];

check("D7: under the defaults every derived path of every fixture instance resolves, none through rule C but Rule C's", () => {
  same(failing(R0), []);
  same(viaFallback(R0), ["iRuleC: cardRow/rowLead/circleShape"]);
  return INSTANCES.reduce((a, n) => a + (n.derivedSymbolData || []).length, 0) + " derived paths";
});
check("D7: the outer swap wins over the master's inner one; a path of length 3 runs through it", () => {
  const r = at(M2A.iSwaps, P(M2A.cardRow, M2A.rowTrail, M2A.triangleShape));
  truth(r.ok, "the length-3 path does not resolve");
  same([r.elements[1].symbol, r.elements[1].via, r.elements.length], [M2A.triangle, "override", 3]);
  truth(!at(M2A.iSwaps, P(M2A.cardRow, M2A.rowTrail, M2A.squareShape)).ok, "the inner (pre-swap) Square's shape resolves under the outer swap");
  const r2 = at(M2A.iSwaps, P(M2A.cardRow, M2A.rowLead, M2A.squareShape));
  same([r2.ok, r2.elements[1].via, r2.elements[1].symbol], [true, "override", M2A.square]);
});
check("D7 rule 2: a swap by property through an alias, and an outer pool's value", () => {
  const r = at(M2A.iByProperty, P(M2A.rowLead, M2A.squareShape));
  same([r.ok, r.elements[0].via, r.elements[0].symbol], [true, "property", M2A.square]);
  const d = at(M2A.iDefaultEqual, P(M2A.chipMIcon, M2A.squareShape));
  same([d.ok, d.elements[0].via, d.elements[0].symbol], [true, "property", M2A.square]);
});
check("D7 rule A: a value naming no symbol is skipped (Chip assigned's icon keeps Circle); a stored symbol with no record is followed", () => {
  const r = at(M2A.iAssigned, P(M2A.chipSIcon, M2A.circleShape));
  same([r.ok, r.elements[0].via, r.elements[0].symbol], [true, "declared", M2A.circle]);
  const n = at(M2A.iNotCarried, P(M2A.chipLIcon));
  same([n.ok, n.elements[0].via, n.elements[0].symbol], [true, "property", M2A.broken]);
});
check("D7 rule B: the no-op swap of the nested Row resets its own swap of Trail; the reset is reported", () => {
  const r = at(M2A.iRuleB, P(M2A.cardRow, M2A.rowTrail, M2A.circleShape));
  same([r.ok, r.elements[0].via, r.elements[0].symbol, r.elements[1].via, r.resets], [true, "override", M2A.row, "declared", [M2A.cardRow]]);
  // Without the reset the master's own swap to Square holds (Echo nested has no outer swap).
  const e = at(M2A.iEchoNested, P(M2A.cardRow, M2A.rowTrail, M2A.squareShape));
  same([e.ok, e.elements[1].via, e.elements[1].symbol], [true, "override", M2A.square]);
});
check("D7 rule C: the ignored assignment is reported, and the nested Row's Lead shows its declared symbol on every derived path", () => {
  const r = at(M2A.iRuleC, P(M2A.cardRow, M2A.rowLead, M2A.circleShape));
  same([r.ok, r.fallback, r.elements[1].via, r.elements[1].symbol], [true, true, "fallback", M2A.circle]);
  same(r.ignored.map((x) => [x.instance, x.path, x.defId]), [[M2A.iRuleC, [M2A.cardRow], M2A.dRowLead]]);
  const own = at(M2A.iRuleC, P(M2A.cardRow, M2A.rowLead));
  same([own.ok, own.fallback, lastOf(own).via, lastOf(own).symbol], [true, false, "fallback", M2A.circle]);
});
check("D7: a hop that matches only by overrideKey stays stale under every setting", () => {
  for (const s of [{}, { swapDangling: "strict" }, { swapReset: "off" }, { swapFallback: "off" }]) {
    const R = resolverWith(s), n = byGuid.get(M2A.iOverrideKey);
    truth(!R.resolve(n, ["50:73"]).ok, JSON.stringify(s) + ": [50:73] resolves");
    truth(!R.inDerived(n, ["50:73"]) && R.inDerived(n, [M2A.libTagLightText]), "inDerived");
  }
});
check("each rule switched off fails exactly its case", () => {
  same(failing(resolverWith({ swapReset: "off" })), ["iRuleB: cardRow/rowTrail/circleShape"], "--swap-reset off:");
  same(failing(resolverWith({ swapFallback: "off" })), ["iRuleC: cardRow/rowLead/circleShape"], "--swap-fallback off:");
  const strict = resolverWith({ swapDangling: "strict" });
  same(failing(strict), [], "--swap-dangling strict:");
  same(viaFallback(strict), ["iAssigned: chipSIcon/circleShape", "iRuleC: cardRow/rowLead/circleShape"], "--swap-dangling strict, through rule C:");
  same(failing(resolverWith({ swapDangling: "strict", swapFallback: "off" })), ["iAssigned: chipSIcon/circleShape", "iRuleC: cardRow/rowLead/circleShape"], "strict and no fallback:");
});
check("effectiveSymbol and inDerived answer as resolve does", () => {
  const I = byGuid.get(M2A.iSwaps);
  same([R0.effectiveSymbol([I, byGuid.get(M2A.cardRow)], byGuid.get(M2A.rowTrail)), R0.effectiveSymbol([I], byGuid.get(M2A.cardRow))], [M2A.triangle, M2A.row]);
  truth(R0.inDerived(I, [M2A.cardRow, M2A.rowTrail, M2A.triangleShape]) && !R0.inDerived(I, [M2A.cardRow, M2A.rowTrail, M2A.squareShape]), "inDerived");
});

// ---------- 2. the IR under the defaults (D8-D11) ----------
check("the IR validates and two reads give the same bytes; the renumbered fixture gives the same IR", () => {
  truth(validate(BASE.ir).ok, "invalid");
  truth(JSON.stringify(read().ir) === JSON.stringify(BASE.ir), "two reads differ");
  const strip = (x) => { const c = JSON.parse(JSON.stringify(x)); delete c.header.source.sha256; return JSON.stringify(c); };
  truth(strip(reader.pixToIR(makeFixture("renumbered").pix).ir) === strip(BASE.ir), "the renumbered fixture differs");
});
check("`at` names each path element's record, on every override and derived entry with a carried path; none through a folded operand", () => {
  let n = 0;
  BASE.ir.nodes.forEach((r) => {
    if (r.type !== "INSTANCE") return;
    for (const e of (r.instance.overrides || []).concat(r.instance.derived || [])) {
      if (!e.path.length) continue;
      const all = e.path.every((g) => recOf(BASE.ir, g) >= 0);
      truth(all === Array.isArray(e.at), r.guid + " " + show(e.path) + ": at " + JSON.stringify(e.at));
      if (e.at) { e.at.forEach((x, k) => truth(BASE.ir.nodes[x].guid === e.path[k], "at[" + k + "]")); n++; }
    }
  });
  same(derAt(BASE.ir, M2A.iSwaps, P(M2A.cardRow, M2A.rowFlatL1)).at, undefined, "a derived entry through a folded operand:");
  const folded = derAt(BASE.ir, M2A.iEntries, P(M2A.rowFlatL1));
  truth(folded && folded.at === undefined, "a derived entry whose first element is a folded operand is kept without at (D10)");
  same(ovAt(BASE.ir, M2A.iSwaps, P(M2A.cardRow, M2A.rowTrail, M2A.triangleShape)).at, [M2A.cardRow, M2A.rowTrail, M2A.triangleShape].map((g) => recOf(BASE.ir, g)), "a path of length 3:");
  return n + " entries with at";
});
check("Swaps: both outer swaps and the fills under them are written, in the swapped masters' layers", () => {
  const I = BASE.ir;
  same(ovAt(I, M2A.iSwaps, P(M2A.cardRow, M2A.rowTrail)).swap, { guid: M2A.triangle });
  same(ovAt(I, M2A.iSwaps, P(M2A.cardRow, M2A.rowLead)).swap, { guid: M2A.square });
  for (const p of [P(M2A.cardRow, M2A.rowTrail, M2A.triangleShape), P(M2A.cardRow, M2A.rowLead, M2A.squareShape)]) same(fill(I, ovAt(I, M2A.iSwaps, p).fields.fills), RED, show(p) + ":");
  truth(derAt(I, M2A.iSwaps, P(M2A.cardRow, M2A.rowTrail, M2A.triangleShape)) && derAt(I, M2A.iByProperty, P(M2A.rowLead, M2A.squareShape)), "derived entries under the swaps");
  same(fill(I, ovAt(I, M2A.iByProperty, P(M2A.rowLead, M2A.squareShape)).fields.fills), RED, "by property:");
});
check("echo (D9): Echo nested's red equals Card2's own override of its Row's Bg, so nothing is written; Rule B's red is not an echo after the reset", () => {
  same(instOf(BASE.ir, M2A.iEchoNested).overrides, undefined, "Echo nested:");
  same(notesOf(BASE.ir, M2A.iEchoNested, schema.CODE.OVERRIDE_ECHO).map((x) => x.detail), ["1 field: fills 1"]);
  same(fill(BASE.ir, ovAt(BASE.ir, M2A.iRuleB, P(M2A.cardRow, M2A.rowBg)).fields.fills), RED, "Rule B:");
  same(notesOf(BASE.ir, M2A.iRuleB, schema.CODE.OVERRIDE_ECHO), []);
});
check("a no-op swap is kept, never an echo (swaps.noOp)", () => {
  same(ovAt(BASE.ir, M2A.iRuleB, P(M2A.cardRow)).swap, { guid: M2A.row });
  same(ovAt(BASE.ir, M2A.iEntries, P(M2A.rowTrail)).swap, { guid: M2A.circle });
  same(BASE.stats.m2a.overrides.swaps.noOp, 2);
});
check("the root entries merge into one path [] override with the look only; the size is the record's (root-box)", () => {
  const o = ovAt(BASE.ir, M2A.iEntries, []);
  same(Object.keys(o).sort(), ["fields", "path"]);
  same(Object.keys(o.fields).sort(), ["fills", "opacity"]);
  same([fill(BASE.ir, o.fields.fills), o.fields.opacity], [[{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }], 0.5]);
  same(LAST.stats.m2a.overrides.rootBox, { echo: 0, differs: 1 });
  same(notesOf(LAST.ir, M2A.iEntries, schema.CODE.OVERRIDE_FIELD_DROPPED).map((x) => x.detail),
    ["no-equivalent: pluginData 1, vectorPaints 1", "not-on-type: fillPaints 1", "layer-not-carried: fillPaints 1", "root-box: size 1"]);
  same(notesOf(BASE.ir, M2A.iEntries, schema.CODE.OVERRIDE_PATHS_MERGED).map((x) => x.detail), ["2 paths, 2 conflicting fields (--override-merge " + schema.SETTING_DEFAULTS.overrideMerge + ")"]);
});
check("Entries: the merged Bg fill (last: yellow), the echoed opacity, the nested INSTANCE target's fill and style, the stale path", () => {
  const I = BASE.ir;
  same(fill(LAST.ir, ovAt(LAST.ir, M2A.iEntries, P(M2A.rowBg)).fields.fills), [{ type: "SOLID", color: { r: 1, g: 1, b: 0 } }]);
  truth(!ovAt(I, M2A.iEntries, P(M2A.rowGroupRect)), "the echoed opacity is written");
  truth(!ovAt(I, M2A.iEntries, P(M2A.rowGroup)) && !ovAt(I, M2A.iEntries, P(M2A.rowFlatL1)), "a not-on-type or layer-not-carried entry is written");
  const lead = ovAt(I, M2A.iEntries, P(M2A.rowLead));
  same(Object.keys(lead.fields).sort(), ["fillStyle", "fills"]);
  same(I.styles[lead.fields.fillStyle].guid, "1:50");
  same(fill(I, lead.fields.fills), I.values[I.styles[lead.fields.fillStyle].value], "the style's value wins:");
  same(notesOf(I, M2A.iEntries, schema.CODE.STYLE_VALUE_DIFFERS).map((x) => x.path), [[M2A.rowLead]]);
  same(notesOf(I, M2A.iEntries, schema.CODE.OVERRIDE_STALE).map((x) => [x.path, x.detail]), [[["5:499"], "not-derived: 1 assignment dropped with it"]]);
  same(notesOf(I, M2A.iOverrideKey, schema.CODE.OVERRIDE_STALE).map((x) => [x.path, x.detail]), [[["50:73"], "not-derived"]]);
  same(notesOf(I, M2A.iEntries, schema.CODE.OVERRIDE_ECHO).map((x) => x.detail), ["1 field: opacity 1"]);
});
check("a bound text's override is kept against the property's effective value (boundConflicts: Entries' and Text styles' titles)", () => {
  same(ovAt(BASE.ir, M2A.iEntries, P(M2A.rowTitle)).fields, { characters: "Override title" });
  same(BASE.stats.m2a.overrides.boundConflicts, 2);
});
// Plants on Entries' [Title] override: its characters set to the assigned value, then to the layer's own.
const plantTitle = (chars) => (value) => {
  const inst = value.pixsoNodes.find((n) => n.guid.sessionID === 5 && n.guid.localID === 520);
  inst.symbolData.symbolOverrides.find((o) => o.guidPath.guids.length === 1 && o.guidPath.guids[0].localID === 401).textData.characters = chars;
};
check("D9 planted: an override equal to the assigned property value is an echo; one equal to the layer's own text is not", () => {
  const a = read({}, plantTitle("Assigned title"));
  truth(!ovAt(a.ir, M2A.iEntries, P(M2A.rowTitle)), "the override equal to the property's value is written");
  same([a.stats.m2a.overrides.boundConflicts, a.stats.m2a.overrides.fields.echo.characters], [1, 1]);
  const b = read({}, plantTitle("Row"));
  same(ovAt(b.ir, M2A.iEntries, P(M2A.rowTitle)).fields, { characters: "Row" });
  same([b.stats.m2a.overrides.boundConflicts, b.stats.m2a.overrides.fields.echo.characters], [2, undefined]);
});
check("Text styles: characters with a style range, a refused size kept and classed, a style reference; its own fill counted (ownDiffers)", () => {
  const I = BASE.ir;
  same(ovAt(I, M2A.iTextStyles, P(M2A.rowTitle)).fields, { characters: "Styled", textRanges: [{ start: 2, end: 6, fields: { fontSize: 20 } }] });
  const bg = ovAt(I, M2A.iTextStyles, P(M2A.rowBg)).fields;
  same([bg.width, bg.height, I.styles[bg.fillStyle].guid], [180, 40, "1:50"]);
  same([props.OVERRIDE_FIELD_CLASS.width, props.OVERRIDE_FIELD_CLASS.height], ["refused", "refused"]);
  same(BASE.stats.m2a.overrides.fields.byClass.refused, 2);
  truth(!ovAt(I, M2A.iTextStyles, []), "the instance's own look is written under --instance-own overrides");
  same(BASE.stats.m2a.instances.ownDiffers, 1);
});
check("Rule C: the entry left with nothing is not written; one SWAP_ASSIGNMENT_IGNORED", () => {
  same(instOf(BASE.ir, M2A.iRuleC).overrides, undefined);
  same(notesOf(BASE.ir, M2A.iRuleC, schema.CODE.SWAP_ASSIGNMENT_IGNORED).map((x) => x.detail), ["1 swap assignment Pixso did not apply; the declared symbol is used"]);
});
check("derived (D10): sparse as stored, lines, oracleSides, an empty entry not written; no derived data, scale, exposed", () => {
  const I = BASE.ir;
  same(derAt(I, M2A.iEntries, P(M2A.rowTitle)), { path: [M2A.rowTitle], at: [recOf(I, M2A.rowTitle)], lines: 1 });
  same(derAt(I, M2A.iEntries, P(M2A.rowGroup)), { path: [M2A.rowGroup], at: [recOf(I, M2A.rowGroup)], size: [20, 20] });
  const bg = derAt(I, M2A.iEntries, P(M2A.rowBg));
  same([bg.size, bg.transform, Array.isArray(bg.oracleSides) && bg.oracleSides.length], [undefined, [1, 0, 0, 0, 1, 0], 4]);
  truth(!derAt(I, M2A.iEntries, P(M2A.rowLead, M2A.circleShape)), "the entry whose geometry equals the layer's is written");
  same(instOf(I, M2A.iNoDerived), { master: { guid: M2A.spacer } });
  same(instOf(I, M2A.iScaled).scale, 2);
  same(instOf(I, M2A.rowTrail).exposed, true);
  same([derAt(I, M2A.iAssigned, P(M2A.chipSIcon, M2A.circleShape)) !== undefined, derAt(I, M2A.iDefaultEqual, P(M2A.chipMIcon, M2A.squareShape)) !== undefined,
    (instOf(I, M2A.iNotCarried).derived || []).map((d) => show(d.path))], [true, true, ["chipLLabel", "chipLDot", "chipLIcon", "chipLBadge"]]);
  const S = BASE.stats.m2a;
  same([S.instances.noDerived, S.instances.scaled, S.instances.exposed, S.derived.withLines, S.derived.withOracleSides, S.derived.geometry], [1, 1, 1, 1, 1, 0]);
});

// ---------- 3. the settings ----------
check("--override-merge: Entries' Bg fill is yellow under last, green under first and outer; the root size an echo under first", () => {
  const bgOf = (r) => fill(r.ir, ovAt(r.ir, M2A.iEntries, P(M2A.rowBg)).fields.fills)[0].color;
  const first = read({ overrideMerge: "first" }), outer = read({ overrideMerge: "outer" });
  same([bgOf(LAST), bgOf(first), bgOf(outer)], [{ r: 1, g: 1, b: 0 }, { r: 0, g: 1, b: 0 }, { r: 0, g: 1, b: 0 }]);
  same([first.stats.m2a.overrides.rootBox, outer.stats.m2a.overrides.rootBox], [{ echo: 1, differs: 0 }, { echo: 0, differs: 1 }]);
  same(Object.keys(ovAt(first.ir, M2A.iEntries, []).fields).sort(), ["fills", "opacity"], "first, path []:");
});
check("--echo keep: the echoes stay, counted the same, with no OVERRIDE_ECHO note", () => {
  const k = read({ echo: "keep" });
  same(fill(k.ir, ovAt(k.ir, M2A.iEchoNested, P(M2A.cardRow, M2A.rowBg)).fields.fills), RED);
  same(ovAt(k.ir, M2A.iEntries, P(M2A.rowGroupRect)).fields, { opacity: 1 });
  same(k.stats.m2a.overrides.fields.echo, BASE.stats.m2a.overrides.fields.echo);
  same(k.ir.notes.filter((x) => x.code === schema.CODE.OVERRIDE_ECHO), []);
});
check("--instance-own own: Text styles' own purple fill becomes its path [] override", () => {
  const o = read({ instanceOwn: "own" });
  same(fill(o.ir, ovAt(o.ir, M2A.iTextStyles, []).fields.fills), [{ type: "SOLID", color: { r: 0.501961, g: 0, b: 0.501961 } }]);
  same(o.stats.m2a.instances.ownDiffers, 1);
});
check("--derived-geometry: changed writes none on the fixture, all the stored geometry, none never", () => {
  const all = read({ derivedGeometry: "all" }), none = read({ derivedGeometry: "none" });
  truth(derAt(all.ir, M2A.iEntries, P(M2A.rowLead, M2A.circleShape)).fillGeometry !== undefined, "all: no geometry");
  same([BASE.stats.m2a.derived.geometry, none.stats.m2a.derived.geometry, all.stats.m2a.derived.geometry > 0], [0, 0, true]);
  const geomIn = (ir) => ir.nodes.some((r) => r.type === "INSTANCE" && (r.instance.derived || []).some((d) => d.fillGeometry !== undefined || d.strokeGeometry !== undefined));
  same([geomIn(BASE.ir), geomIn(none.ir), geomIn(all.ir)], [false, false, true]);
});
check("--swap-reset off: Rule B's circle path is not written, and its red Bg becomes an echo", () => {
  const r = read({ swapReset: "off" });
  truth(!derAt(r.ir, M2A.iRuleB, P(M2A.cardRow, M2A.rowTrail, M2A.circleShape)), "the reset path is written");
  truth(!ovAt(r.ir, M2A.iRuleB, P(M2A.cardRow, M2A.rowBg)), "the red Bg is written");
  same(r.stats.m2a.derived.unresolved, 1);
});
check("--swap-fallback off: Rule C's path is not written and no SWAP_ASSIGNMENT_IGNORED; --swap-dangling strict: Chip assigned's through rule C", () => {
  const off = read({ swapFallback: "off" });
  truth(!derAt(off.ir, M2A.iRuleC, P(M2A.cardRow, M2A.rowLead, M2A.circleShape)), "written");
  same([off.stats.m2a.derived.unresolved, off.ir.notes.filter((x) => x.code === schema.CODE.SWAP_ASSIGNMENT_IGNORED).length], [1, 0]);
  const strict = read({ swapDangling: "strict" });
  same([strict.stats.m2a.derived.viaFallback, notesOf(strict.ir, M2A.iAssigned, schema.CODE.SWAP_ASSIGNMENT_IGNORED).length], [2, 1]);
});
// G1, G2 and G6, under every setting value.
const balances = (st, label) => {
  const O = st.m2a.overrides, D = st.m2a.derived;
  const bad = [];
  if (O.entries !== O.root + O.emptyPath + O.live + sum(O.stale)) bad.push("entries");
  if (O.live !== O.distinctLivePaths + O.mergedAway) bad.push("live");
  if (O.distinctLivePaths !== O.written + O.emptyAfterTranslation) bad.push("distinct live paths");
  if (O.pixsoFields.total !== O.pixsoFields.translated + O.pixsoFields.consumed + sum(O.pixsoFields.dropped)) bad.push("Pixso fields");
  if (O.fields.produced !== O.fields.carried + sum(O.fields.echo)) bad.push("Figma fields");
  if (O.nonRoot !== O.live + sum(O.stale)) bad.push("non-root");
  if (D.entries !== D.resolved + D.unresolved || D.resolved !== D.written + D.empty) bad.push("derived");
  if (O.resolvedNotDerived || O.inDerivedUnresolved) bad.push("G2");
  if (bad.length) throw new Error(label + ": " + bad.join(", "));
};
check("G1, G2 and G6 add up under the defaults and under every other setting value; no unknown field", () => {
  balances(LAST.stats, "last");
  balances(BASE.stats, "defaults");
  same(BASE.stats.m2a.overrides.pixsoFields.dropped.unknown, {});
  same([BASE.stats.m2a.derived.entries, BASE.stats.m2a.derived.unresolved], [139, 0]);
  let n = 0;
  for (const k of schema.M2A_SETTINGS) for (const v of schema.SETTINGS[k]) {
    if (v === schema.SETTING_DEFAULTS[k]) continue;
    balances(read({ [k]: v }).stats, k + " " + v);
    n++;
  }
  return n + " setting values";
});
check("planted: a Pixso field outside OVERRIDE_SOURCE_FIELDS is dropped \"unknown\" (G6 fails), every balance still holding", () => {
  const p = read({}, M2A_PLANTS.unknownOverrideField);
  same(p.stats.m2a.overrides.pixsoFields.dropped.unknown, { scrollDirection: 1 });
  balances(p.stats, "planted");
  same(notesOf(p.ir, M2A.iEntries, schema.CODE.OVERRIDE_FIELD_DROPPED).map((x) => x.detail).filter((d) => d.startsWith("unknown")), ["unknown: scrollDirection 1"]);
});
check("stats.m2a.instances, .overrides and .derived on the fixture", () => {
  const S = BASE.stats.m2a;
  same(S.instances, { instances: 27, notCarried: 0, noDerived: 1, exposed: 1, exposedOutside: 0, scaled: 1, ownDiffers: 1 });
  const O = S.overrides;
  same([O.entries, O.root, O.emptyPath, O.nonRoot, O.live, O.stale, O.distinctLivePaths, O.mergedAway, O.written, O.emptyAfterTranslation, O.merged],
    [28, 1, 1, 26, 23, { "not-derived": 3, unresolved: 0 }, 22, 1, 17, 5, { paths: 2, conflicts: 2 }]);
  same(O.pixsoFields.dropped, { "no-equivalent": { vectorPaints: 1, pluginData: 1 }, "not-on-type": { fillPaints: 1 }, "layer-not-carried": { fillPaints: 1 }, "root-box": { size: 1 }, unknown: {} });
  same(O.swaps, { override: 6, property: 3, sameSet: 0, noOp: 2, unresolved: 0, dropped: 0 });
  same(O.fields.echo, { opacity: 1, fills: 1 });
});

// ---------- 4. the census (docs/M2A.md §1.3) ----------
const CENSUS = ["arcData", "autoCornerRadius", "autoLayoutAbsolutePos", "autoLayoutIncludeBorders", "autoLayoutItemReverseDraw",
  "borderBottomWeight", "borderLeftWeight", "borderRightWeight", "borderStrokeWeightsIndependent", "borderTopWeight", "componentPropAssignment",
  "cornerRadius", "cornerSmoothing", "dashCap", "dashPattern", "effects", "exportImageQuality", "exportKeepNameGroup", "exportSettings",
  "fillPaints", "fontName", "fontSize", "fontVariantNumericFigure", "fontVariantNumericFraction", "fontVariantNumericSpacing",
  "fontVariantPosition", "fontVariations", "fontVersion", "frameMaskDisabled", "hangingList", "hangingPunctuation", "horizontalConstraint",
  "hyperlink", "inheritEffectStyleID", "inheritFillStyleID", "inheritGridStyleID", "inheritStrokeStyleID", "inheritTextStyleID", "layoutGrids",
  "leadingTrim", "letterSpacing", "lineHeight", "locked", "maxLines", "maxSize", "minSize", "miterLimit", "name", "opacity",
  "overlayBackgroundAppearance", "overlayBackgroundInteraction", "overlayPositionType", "overriddenSymbolID", "overrideLevel",
  "paragraphIndent", "paragraphSpacing", "pluginData", "proportionsConstrained", "prototypeInteractions", "rectangleBottomLeftCornerRadius",
  "rectangleBottomRightCornerRadius", "rectangleCornerRadiiIndependent", "rectangleCornerToolIndependent", "rectangleTopLeftCornerRadius",
  "rectangleTopRightCornerRadius", "size", "stackChildCounterSizing", "stackChildPrimarySizing", "stackCounterAlignContent",
  "stackCounterAlignItems", "stackCounterSizing", "stackCounterSpacing", "stackPaddingBottom", "stackPaddingLeft", "stackPaddingRight",
  "stackPaddingTop", "stackPrimaryAlignItems", "stackPrimarySizing", "stackSpacing", "strokeAlign", "strokeCap", "strokeJoin", "strokePaints",
  "strokeWeight", "textAlignHorizontal", "textAutoResize", "textCase", "textData", "textDecoration", "textTruncation", "toggledOffOTFeatures",
  "toggledOnOTFeatures", "variableConsumptionMap", "variableModeBySetMap", "vectorPaints", "vectorStyles", "verticalConstraint", "visible"];
const KIT_EXTRA = ["exportNameByVariantProp", "groupIncludeInvisible", "showInSlice", "textAlignVertical"];
check("the census and OVERRIDE_SOURCE_FIELDS list the same fields; every field of every fixture entry is in the table", () => {
  same(Object.keys(overrides.OVERRIDE_SOURCE_FIELDS).sort(), CENSUS.concat(KIT_EXTRA, ["guidPath"]).sort());
  const seen = new Set();
  for (const n of PIX.nodes) for (const e of (n.symbolData && n.symbolData.symbolOverrides) || []) for (const k of Object.keys(e)) seen.add(k);
  same([...seen].filter((k) => !Object.prototype.hasOwnProperty.call(overrides.OVERRIDE_SOURCE_FIELDS, k)), []);
  return CENSUS.length + " + " + KIT_EXTRA.length + " fields";
});

// ---------- 5. what needs part B's assignments() ----------
if (!B_IN) {
  pending("Entries' [Trail] assignment to Row's Title against Circle's family: STALE_ASSIGNMENT \"nested: other-family\"");
  pending("Rule C's ignored assignment: STALE_ASSIGNMENT \"ignored\" and absent from the IR");
  pending("G7: every assignment of the fixture in exactly one of D6's classes, droppedWithEntry 1 (Entries' [5:499])");
} else {
  check("B: Entries' [Trail] assignment against Circle's family is STALE_ASSIGNMENT nested: other-family", () => {
    const d = notesOf(BASE.ir, M2A.iEntries, schema.CODE.STALE_ASSIGNMENT).filter((x) => x.path && key(x.path) === M2A.rowTrail).map((x) => x.detail);
    truth(d.length === 1 && d[0].startsWith("nested: other-family"), JSON.stringify(d));
    same(ovAt(BASE.ir, M2A.iEntries, P(M2A.rowTrail)).properties, undefined);
  });
  check("B: Rule C's ignored assignment is STALE_ASSIGNMENT ignored and absent from the IR", () => {
    const d = notesOf(BASE.ir, M2A.iRuleC, schema.CODE.STALE_ASSIGNMENT).map((x) => x.detail);
    truth(d.length === 1 && d[0].startsWith("ignored"), JSON.stringify(d));
    same(instOf(BASE.ir, M2A.iRuleC).overrides, undefined);
  });
  check("B: G7, every assignment in exactly one class; droppedWithEntry 1", () => {
    const A = BASE.stats.m2a.properties.assignments;
    same(A.total, A.kept + A.droppedWithEntry + A.merged + A.dangling + A.defaultDropped + sum(A.stale), "total:");
    same(A.droppedWithEntry, 1);
  });
}

console.log("");
console.log(failed ? failed + " part C check" + (failed === 1 ? "" : "s") + " FAILED" : "all part C checks pass" + (B_IN ? "" : " (the checks that need part B pending)"));
process.exit(failed ? 1 : 0);
