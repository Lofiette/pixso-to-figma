// The contract part P0 froze for M2a's parts A-E (docs/M2A.md §5), checked offline on the synthetic
// fixture. It holds with P0's stubs and must keep holding as each part replaces its stub: what it
// checks is the seam, never what a part decides. Owned by P0 alone (docs/M2A.md §9); a part that finds
// it wrong says so in its pull request, and part E changes it after the merge.
//
//   node tools/test-m2a-contract.mjs
//
// It checks:
//   - the thirteen settings: the reader takes each value, refuses any other, and writes it into the
//     header; the IR validates under every value (docs/M2A.md §3);
//   - the hooks: each module exports its frozen names (§5.3); the IR is byte-identical on two reads,
//     and the renumbered fixture gives the same IR;
//   - D13: the tasks made from the fixture's IR equal, record for record, those made from its
//     --variant-sets frames IR, with the M1 balance adding up, and the identity sample is the same;
//   - stats.m2a has the shape index.mjs froze (newM2aStats), and stats.ms.m2a times its four phases;
//   - OVERRIDE_SOURCE_FIELDS lists exactly the override census of docs/M2A.md §1.3 (D, K, M, P, and
//     the four more of the Сова UI kit), each field with one fate, every translated field landing in
//     props.mjs OVERRIDE_FIELDS;
//   - propindex.mjs (D3, D5) answers the fixture's binding and assignment cases as their comments say;
//   - D12: under a pages scope the closure pulls in swap targets and the symbols assignments and
//     definition defaults name, and the scoped IR validates.
// Everything here is synthetic.
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (label, fn) => {
  try { const r = fn(); if (r === false) fail(label); else ok(label + (typeof r === "string" ? " (" + r + ")" : "")); }
  catch (e) { fail(label + ": " + (e && e.message ? e.message.split("\n")[0] : e)); }
};
const same = (a, b, what) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error((what || "") + " got " + x.slice(0, 300) + ", want " + y.slice(0, 300)); };
if (typeof zlib.zstdCompressSync !== "function") { console.log("FAIL the M2a contract checks need Node 22.15 or newer (built-in zstd)"); process.exit(1); }
const imp = (p) => import(pathToFileURL(join(HERE, p)).href);

const schema = await imp("ir/schema.mjs");
const props = await imp("ir/props.mjs");
const { validate } = await imp("ir/validate.mjs");
const { planM1 } = await imp("ir/plan.mjs");
const { sampleGuids } = await imp("ir/identity.mjs");
const { makeFixture, M2A } = await imp("pix/fixture.mjs");
const reader = await imp("pix/ir/index.mjs");
const { readPix, childrenByParent } = await imp("pix/read.mjs");
const { enumReader } = await imp("pix/ir/enums.mjs");
const families = await imp("pix/ir/families.mjs");
const propindex = await imp("pix/ir/propindex.mjs");
const properties = await imp("pix/ir/properties.mjs");
const resolve = await imp("pix/ir/resolve.mjs");
const overrides = await imp("pix/ir/overrides.mjs");
const derived = await imp("pix/ir/derived.mjs");
const components = await imp("pix/ir/components.mjs");

const FX = makeFixture();
const read = (settings) => reader.pixToIR(FX.pix, { settings });
const BASE = read();

// ---------- 1. the settings (docs/M2A.md §3) ----------
check("the reader takes the thirteen M2a settings, each defaulting to SETTING_DEFAULTS", () => {
  same(schema.M2A_SETTINGS.filter((k) => reader.READER_SETTINGS.indexOf(k) < 0), [], "settings the reader does not take:");
  const s = reader.readerSettings({});
  for (const k of schema.M2A_SETTINGS) if (s[k] !== schema.SETTING_DEFAULTS[k]) throw new Error(k + " defaults to " + s[k]);
  for (const k of schema.SETTING_KEYS) if (BASE.ir.header.settings[k] === undefined) throw new Error("the header lacks " + k);
  same(Object.keys(BASE.ir.header.settings), schema.SETTING_KEYS, "header settings order:");
});
let variants = 0;
for (const k of schema.M2A_SETTINGS) for (const v of schema.SETTINGS[k]) {
  if (v === schema.SETTING_DEFAULTS[k]) continue;
  variants++;
  check("--" + k + " " + v + ": the IR validates and its header records the value", () => {
    const r = read({ [k]: v });
    const val = validate(r.ir);
    if (!val.ok) throw new Error(JSON.stringify(val.errors.slice(0, 3)));
    return r.ir.header.settings[k] === v;
  });
}
check("a value outside a setting's values is refused, naming the choices", () => {
  for (const k of schema.M2A_SETTINGS) {
    let msg = "";
    try { read({ [k]: "sometimes" }); } catch (e) { msg = e.message; }
    if (!/^pixToIR: setting /.test(msg) || msg.indexOf(schema.SETTINGS[k][0]) < 0) throw new Error(k + ": " + (msg || "accepted"));
  }
});

// ---------- 2. the hooks (docs/M2A.md §5.3) ----------
check("each M2a module exports its frozen names", () => {
  const want = [[families, ["familyIndex"]], [propindex, ["propIndex"]], [properties, ["propertiesOf", "bindingsOf", "assignments"]],
    [resolve, ["makeResolver"]], [overrides, ["instanceData", "OVERRIDE_SOURCE_FIELDS"]], [derived, ["derivedEntries"]],
    [components, ["componentEntry", "setEntry", "masterRef", "libraryOf"]], [reader, ["pixToIR", "readerSettings", "newM2aStats", "READER_SETTINGS"]]];
  const missing = [];
  for (const [m, names] of want) for (const n of names) if (m[n] === undefined) missing.push(n);
  same(missing, [], "missing:");
});
check("the IR validates and two reads give the same bytes", () => {
  const v = validate(BASE.ir);
  if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 3)));
  return JSON.stringify(read().ir) === JSON.stringify(BASE.ir) && BASE.ir.nodes.length + " records";
});
check("the renumbered fixture (every enum numbered differently) gives the same IR", () => {
  const r = reader.pixToIR(makeFixture("renumbered").pix).ir;
  const strip = (x) => { const c = JSON.parse(JSON.stringify(x)); delete c.header.source.sha256; return JSON.stringify(c); };
  return strip(r) === strip(BASE.ir);
});

// ---------- 3. D13: a set is planned as its frame ----------
const FRAMES = read({ variantSets: "frames" });
check("D13: the tasks of the IR equal, record for record, those of the --variant-sets frames IR; the M1 balance adds up", () => {
  for (const m1Scope of ["default", "all-masters", "all"]) {
    const a = planM1(BASE.ir, BASE.stats, { m1Scope, runId: "0123456789abcdef" });
    const b = planM1(FRAMES.ir, FRAMES.stats, { m1Scope, runId: "0123456789abcdef" });
    if (!a.balance.ok || !b.balance.ok) throw new Error(m1Scope + ": the balance does not add up");
    same(a.tasks.map((t) => [t.op, t.nodes, t.roots]), b.tasks.map((t) => [t.op, t.nodes, t.roots]), m1Scope + ":");
    same(a.balance.populations, b.balance.populations, m1Scope + " populations:");
  }
  return "default, all-masters and all";
});
check("D13: no task carries a COMPONENT_SET, and a set's record keeps its frame's props", () => {
  const plan = planM1(BASE.ir, BASE.stats, { m1Scope: "all", runId: "0123456789abcdef" });
  if (plan.tasks.some((t) => t.nodes.some((n) => n.type === "COMPONENT_SET"))) return false;
  BASE.ir.nodes.forEach((n, i) => { if (n.type === "COMPONENT_SET") same(n.props, FRAMES.ir.nodes[i].props, "set " + n.guid + ":"); });
});
check("the identity sample does not depend on --variant-sets", () => same(sampleGuids(BASE.ir), sampleGuids(FRAMES.ir)));

// ---------- 4. stats.m2a (index.mjs newM2aStats) ----------
// A template's empty object is a count map by field (or by class, then field): its keys are the
// part's, its values numbers. Every other key is fixed.
function shapeErrors(t, a, at) {
  const out = [];
  if (typeof t === "number") { if (typeof a !== "number" || !isFinite(a)) out.push(at + " is not a number"); return out; }
  if (a === null || typeof a !== "object" || Array.isArray(a)) { out.push(at + " is not an object"); return out; }
  const tk = Object.keys(t);
  if (!tk.length) { for (const k of Object.keys(a)) if (typeof a[k] !== "number") out.push(at + "." + k + " is not a count"); return out; }
  for (const k of tk) if (!(k in a)) out.push(at + "." + k + " is missing"); else out.push(...shapeErrors(t[k], a[k], at + "." + k));
  for (const k of Object.keys(a)) if (!(k in t)) out.push(at + "." + k + " is not in the frozen shape");
  return out;
}
check("stats.m2a has the frozen shape (docs/M2A.md §6 A-C), its class maps every class of their code", () => {
  same(shapeErrors(reader.newM2aStats(), BASE.stats.m2a, "stats.m2a"), []);
  const t = reader.newM2aStats();
  same(Object.keys(t.families.rejected), schema.NOTE_CLASSES.VARIANT_SET_REJECTED);
  same(Object.keys(t.properties.assignments.stale), schema.NOTE_CLASSES.STALE_ASSIGNMENT);
  same(Object.keys(t.properties.bindings.dropped), schema.NOTE_CLASSES.PROPERTY_REF_DROPPED);
  same(Object.keys(t.overrides.stale), schema.NOTE_CLASSES.OVERRIDE_STALE);
  same(Object.keys(t.overrides.pixsoFields.dropped), schema.NOTE_CLASSES.OVERRIDE_FIELD_DROPPED);
  same(Object.keys(t.overrides.fields.byClass), props.OVERRIDE_CLASSES);
});
check("stats.ms.m2a times the four M2a phases", () => {
  same(Object.keys(BASE.stats.ms.m2a), ["families", "props", "resolve", "instances"]);
  return Object.values(BASE.stats.ms.m2a).every((x) => typeof x === "number" && x >= 0);
});

// ---------- 5. OVERRIDE_SOURCE_FIELDS against the census (docs/M2A.md §1.3, D8) ----------
// Every key of every override entry in D, K, M and P (guidPath apart), then the four the Сова UI kit
// adds. Pixso's field names only: format metadata, no design content.
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
check("OVERRIDE_SOURCE_FIELDS lists exactly the census (98 fields of D, K, M and P, 4 more of the Сова UI kit) and guidPath", () => {
  const T = overrides.OVERRIDE_SOURCE_FIELDS;
  if (CENSUS.length !== 98) throw new Error("the census list has " + CENSUS.length + " fields");
  const want = CENSUS.concat(KIT_EXTRA, ["guidPath"]).sort(), got = Object.keys(T).sort();
  same(got.filter((k) => want.indexOf(k) < 0), [], "fields outside the census:");
  same(want.filter((k) => got.indexOf(k) < 0), [], "census fields without a fate:");
  return got.length + " fields";
});
check("every source field has one fate; a translated one lands in OVERRIDE_FIELDS", () => {
  const bad = [];
  for (const [k, f] of Object.entries(overrides.OVERRIDE_SOURCE_FIELDS)) {
    if (!Object.isFrozen(f)) bad.push(k + " is not frozen");
    if (f.fate === "translate") {
      if (!Array.isArray(f.to) || !f.to.length || typeof f.by !== "string") bad.push(k + ": a translation names its fields and translator");
      for (const t of f.to || []) if (!props.OVERRIDE_FIELDS[t]) bad.push(k + " -> " + t + ", which is no override field");
    } else if (f.fate === "consume") { if (typeof f.by !== "string") bad.push(k + ": consumed by whom"); }
    else if (f.fate === "drop") { if (typeof f.why !== "string" || !f.why) bad.push(k + ": dropped without a reason"); }
    else bad.push(k + " has fate " + f.fate);
  }
  if (!Object.isFrozen(overrides.OVERRIDE_SOURCE_FIELDS)) bad.push("the table is not frozen");
  same(bad, []);
  const by = (fate) => Object.values(overrides.OVERRIDE_SOURCE_FIELDS).filter((f) => f.fate === fate).length;
  return by("translate") + " translated, " + by("consume") + " consumed, " + by("drop") + " dropped";
});

// ---------- 6. propindex.mjs on the fixture (D3, D5) ----------
const PIX = readPix(FX.pix);
const gs = (g) => (g ? g.sessionID + ":" + g.localID : null);
const byGuid = new Map(PIX.nodes.map((n) => [gs(n.guid), n]));
const en = enumReader(PIX.schema);
const typeOf = en("PixsoNode", "type");
const kids = childrenByParent(PIX.nodes);
const PI = propindex.propIndex({ pix: PIX, en, byGuid, typeName: (n) => typeOf(n.type), childrenOf: (n) => kids.get(gs(n.guid)) || [],
  componentGuids: new Set(BASE.ir.components.map((c) => BASE.ir.nodes[c.node].guid)) });
check("scopeOf: a member's scope is its state group; a standalone symbol and a group are their own; an unknown guid has none", () => {
  same([PI.scopeOf(M2A.chipS), PI.scopeOf(M2A.chip), PI.scopeOf(M2A.row), PI.scopeOf(M2A.rejAxisCountA), PI.scopeOf(M2A.nothing)],
    [M2A.chip, M2A.chip, M2A.row, M2A.rejAxisCount, null]);
});
// [scope owner, defId, why, root id, hops, from?], from the fixture's comments.
const CASES = [
  [M2A.chip, M2A.dChipLLabel, "alias", M2A.dLabel, 1, M2A.chipL], [M2A.chip, M2A.dChipLLabel, "alias", M2A.dShowIcon, 1, M2A.chipS],
  [M2A.chip, M2A.dChipSLabel, "alias", M2A.dLabel, 1], [M2A.chip, M2A.dLabel, "root", M2A.dLabel, 0],
  [M2A.chip, M2A.dChipMLabel, "alias", M2A.dLabel, 2], [M2A.chip, M2A.dBadge, "root", M2A.dBadge, 0],
  [M2A.chip, M2A.dSetAliasNowhere, "no-root", null, 0], [M2A.chip, M2A.dSetAliasOtherSet, "no-root", null, 0],
  [M2A.chip, M2A.dTagDot, "other-family", null, 0], [M2A.chip, M2A.dNoDefinition, "no-definition", null, 0],
  [M2A.chip, M2A.fillStyleNowhere, "no-definition", null, 0], [M2A.chip, M2A.dTint, "root", M2A.dTint, 0],
  [M2A.row, M2A.dRowLeadAlias, "alias", M2A.dRowLead, 1], [M2A.rejAxisCount, M2A.dRejFlag, "root", M2A.dRejFlag, 0],
  [M2A.libTag, M2A.dTagText, "root", M2A.dTagText, 0],
];
check("why and rootOf: roots, one- and two-hop aliases, a same-id alias, an alias id two members give different parents (read from its member), chains that leave the scope or end nowhere, other families", () => {
  for (const [scope, id, why, rootId, hops, from] of CASES) {
    const c = PI.chain(scope, id, from);
    same([PI.why(scope, id, from), PI.rootOf(scope, id, from) ? PI.rootOf(scope, id, from).id : null, c.hops], [why, rootId, hops], scope + " " + id + " from " + from + ":");
  }
  // A member's same-id alias names the set's root, never itself (D3).
  const d = PI.rootOf(M2A.chip, M2A.dLabel);
  same([d.owner, d.type, d.name, d.sortPosition, d.parent], [M2A.chip, "TEXT", "Label", "b", null]);
  return CASES.length + " cases";
});
check("defsOf: definitions in stored order, types by name, 0:0 parents as null", () => {
  same(PI.defsOf(M2A.chipS).map((d) => [d.id, d.type, d.name, d.parent]), [[M2A.dChipSLabel, "BOOL", "", M2A.dLabel], [M2A.dChipSShow, "BOOL", "", M2A.dShowIcon], [M2A.dChipSIcon, "BOOL", "", M2A.dIcon],
    [M2A.dChipLLabel, "BOOL", "", M2A.dShowIcon]]);
  same(PI.defsOf(M2A.circle), []);
  return PI.owners.length + " owners";
});
check("symbolKnown and refOf (D5): a carried symbol, a library copy's record, a stored symbol with no record, a guid of nothing", () => {
  same([PI.symbolKnown(M2A.circle), PI.symbolKnown(M2A.broken), PI.symbolKnown(M2A.nothing), PI.symbolKnown(M2A.rowTitle)], [true, true, false, false]);
  same([PI.refOf(M2A.circle), PI.refOf(M2A.libTagLight), PI.refOf(M2A.broken), PI.refOf(M2A.nothing)], [{ guid: M2A.circle }, { guid: M2A.libTagLight }, null, null]);
  const lib = propindex.propIndex({ pix: PIX, en, byGuid, typeName: (n) => typeOf(n.type), childrenOf: (n) => kids.get(gs(n.guid)) || [], componentGuids: new Set() });
  return JSON.stringify(lib.refOf(M2A.libTagLight).library) === JSON.stringify(components.libraryOf(byGuid.get(M2A.libTagLight))) && "a copy with no record names its library";
});

// ---------- 7. D12: the pages-scope closure ----------
check("D12: a scoped IR pulls in the swap targets and the symbols assignments and defaults name, and validates", () => {
  const tops = (scope) => { const r = read({ scope: "pages:" + scope }); const v = validate(r.ir); if (!v.ok) throw new Error(scope + ": " + JSON.stringify(v.errors.slice(0, 2)));
    return r.ir.nodes.filter((n) => n.parent === -1).map((n) => n.guid); };
  const swaps = tops(M2A.iSwaps);
  for (const g of [M2A.card, M2A.row, M2A.circle, M2A.square, M2A.triangle]) if (swaps.indexOf(g) < 0) throw new Error("swaps: " + g + " not pulled in");
  const prop = tops(M2A.iByProperty);
  for (const g of [M2A.row, M2A.circle, M2A.square]) if (prop.indexOf(g) < 0) throw new Error("by property: " + g + " not pulled in");
  const notCarried = tops(M2A.iNotCarried);
  if (notCarried.indexOf(M2A.broken) >= 0) throw new Error("a symbol that is not carried became a record");
  return swaps.length + " and " + prop.length + " top-level records";
});

console.log("");
console.log(failed ? failed + " M2a contract check" + (failed === 1 ? "" : "s") + " FAILED" : "all M2a contract checks pass (" + variants + " non-default setting values read)");
process.exit(failed ? 1 : 0);
