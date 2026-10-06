// Part B's tests: property roots, bindings, defaults, preferred values and assignments (docs/M2A.md
// D3-D6, §6 B), on the synthetic fixture only (tools/pix/fixture.mjs, the M2A ids). Owned by part B.
//
//   node tools/test-m2a-props.mjs
//
// Two levels:
//   1. properties.mjs on its own, with a context built here and a family index that accepts the sets
//      the fixture's comments name (Chip, Lib Tag, Toggle, Vocab, M1's Button) and rejects the four
//      others, so every set-level case (lifted member roots, the set's preferred COMPONENT_SET guid)
//      is checked whatever part A's families.mjs decides today; and once more with no set accepted
//      (--variant-sets frames, or part A's stub), where every member is standalone and declares copies;
//   2. the reader end to end (pixToIR) under both --swap-default and both --rejected-props values: the
//      IR validates, every family declares exactly the roots the fixture's comments give it (set or
//      copies, by what families.mjs accepted: the expectation is computed from the IR's own sets),
//      every binding names its root id or is dropped in its D4 class with one note per record and
//      class, and the renumbered fixture gives the same properties and bindings.
// Assignments (D6) are checked at level 1 on the fixture's raw componentPropAssignment lists, because
// part C's instanceData is what calls assignments() in the reader.
//
// What each check proves, beyond its label: a definition's type, name and default come from its root
// (a member alias is an unnamed BOOL, so taking them from the alias fails); an INSTANCE_SWAP default
// follows the bound layers or the definition as --swap-default says; a binding or an assignment is
// never matched by name (a planted same-name definition stays unmatched); an assignment reaches only
// the ids on its master symbol and that symbol's state group (docs/M2A.md §0.2: "other-family");
// every assignment and every binding ends in exactly one class, and the counters add up (G7).
// The renumbered fixture (every enum numbered differently) gives the same properties and bindings.
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
const ok = (m) => { passed++; console.log("ok   " + m); };
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (label, fn) => {
  try { const r = fn(); if (r === false) fail(label); else ok(label + (typeof r === "string" ? " (" + r + ")" : "")); }
  catch (e) { fail(label + ": " + (e && e.message ? e.message.split("\n")[0] : e)); }
};
if (typeof zlib.zstdCompressSync !== "function") { console.log("FAIL the M2a property checks need Node 22.15 or newer (built-in zstd)"); process.exit(1); }
const imp = (p) => import(pathToFileURL(join(HERE, p)).href);

const { canonicalJSON, CODE, NOTE_CLASSES } = await imp("ir/schema.mjs");
const { validate } = await imp("ir/validate.mjs");
const { makeFixture, M2A, fixtureKey } = await imp("pix/fixture.mjs");
const { readPix, childrenByParent } = await imp("pix/read.mjs");
const { enumReader } = await imp("pix/ir/enums.mjs");
const { pixToIR, readerSettings, newM2aStats } = await imp("pix/ir/index.mjs");
const { propIndex } = await imp("pix/ir/propindex.mjs");
const B = await imp("pix/ir/properties.mjs");

const same = (a, b, what) => { const x = canonicalJSON(a), y = canonicalJSON(b); if (x !== y) throw new Error((what ? what + " " : "") + "got " + x.slice(0, 400) + ", want " + y.slice(0, 400)); };
const gs = (g) => (g ? g.sessionID + ":" + g.localID : null);

// ---------- the fixture's expectations (from its comments, tools/pix/fixture.mjs m2aNodes) ----------
const BUTTON = "1:10", BUTTON_S = "1:11", BUTTON_L = "1:14";
const DEF = {
  show: { id: M2A.dShowIcon, name: "Show icon", type: "BOOLEAN", default: true },
  label: { id: M2A.dLabel, name: "Label", type: "TEXT", default: "Chip" },
  icon: (setCarried) => ({ id: M2A.dIcon, name: "Icon", type: "INSTANCE_SWAP", default: { guid: M2A.circle }, preferredValues: [
    { type: "COMPONENT", componentKey: fixtureKey("lib tag light"), guid: M2A.libTagLight },
    { type: "COMPONENT", componentKey: fixtureKey("absent component") },
    Object.assign({ type: "COMPONENT_SET", componentKey: fixtureKey("lib tag set") }, setCarried ? { guid: M2A.libTag } : {})] }),
  caption: { id: M2A.dCaption, name: "Caption", type: "TEXT", default: "Note" },
  badge: { id: M2A.dBadge, name: "Badge", type: "BOOLEAN", default: false },
  tagText: { id: M2A.dTagText, name: "Text", type: "TEXT", default: "Tag" },
  tagDot: { id: M2A.dTagDot, name: "Dot", type: "BOOLEAN", default: true },
  title: { id: M2A.dRejTitle, name: "Title", type: "TEXT", default: "T" },
  flag: { id: M2A.dRejFlag, name: "Flag", type: "BOOLEAN", default: true },
  rowTitle: { id: M2A.dRowTitle, name: "Title", type: "TEXT", default: "Row" },
  // Lead icon: its bound layer 5:402 declares 5:300, its initialValue names 5:301 (D5).
  rowLead: (swapDefault) => ({ id: M2A.dRowLead, name: "Lead icon", type: "INSTANCE_SWAP", default: { guid: swapDefault === "definition" ? M2A.square : M2A.circle } }),
  // Badge icon: its bound layers disagree (5:300, 5:301): the initialValue, 5:300, under both settings.
  cardBadge: { id: M2A.dCardBadge, name: "Badge icon", type: "INSTANCE_SWAP", default: { guid: M2A.circle } },
  bLabel: { id: "1:900", name: "Label", type: "TEXT", default: "Button" },
  bShow: { id: "1:901", name: "Show icon", type: "BOOLEAN", default: true },
};
// State groups: the roots on the group (in sortPosition order), the members, the member-owned roots.
const GROUPS = {
  [M2A.chip]: { roots: (c) => [DEF.show, DEF.label, DEF.icon(c.libTagSet), DEF.caption], members: [M2A.chipS, M2A.chipHoverS, M2A.chipM, M2A.chipL], owned: { [M2A.chipL]: [DEF.badge] } },
  [M2A.libTag]: { roots: () => [DEF.tagText, DEF.tagDot], members: [M2A.libTagLight, M2A.libTagDark], owned: {} },
  [M2A.rejAxisCount]: { roots: () => [DEF.title], members: [M2A.rejAxisCountA, M2A.rejAxisCountB], owned: { [M2A.rejAxisCountA]: [DEF.flag] } },
  [BUTTON]: { roots: () => [DEF.bLabel, DEF.bShow], members: [BUTTON_S, BUTTON_L], owned: {} },
  [M2A.toggle]: { roots: () => [], members: [M2A.toggleOff, M2A.toggleOn], owned: {} },
  [M2A.vocab]: { roots: () => [], members: [M2A.vocabA, M2A.vocabB], owned: {} },
  [M2A.rejNoEquals]: { roots: () => [], members: [M2A.rejNoEqualsA, M2A.rejNoEqualsB], owned: {} },
  [M2A.rejDupAxis]: { roots: () => [], members: [M2A.rejDupAxisA, M2A.rejDupAxisB], owned: {} },
  [M2A.rejDupCoord]: { roots: () => [], members: [M2A.rejDupCoordA, M2A.rejDupCoordB], owned: {} },
};
const STANDALONE = { [M2A.row]: (s) => [DEF.rowTitle, DEF.rowLead(s.swapDefault)], [M2A.card]: () => [DEF.cardBadge] };
const ACCEPTED = [BUTTON, M2A.libTag, M2A.chip, M2A.toggle, M2A.vocab];
const REJECTED = { [M2A.rejNoEquals]: "no-equals", [M2A.rejDupAxis]: "duplicate-axis", [M2A.rejAxisCount]: "axis-count", [M2A.rejDupCoord]: "duplicate-coordinate" };
const groupOf = (sym) => Object.keys(GROUPS).find((g) => GROUPS[g].members.indexOf(sym) >= 0) || null;
const bySort = (list) => list;   // the lists above are written in sortPosition order, then by id

// What a family declares, given the accepted groups (a Set) and the settings (D3).
function expectedProps(family, accepted, s) {
  const c = { libTagSet: accepted.has(M2A.libTag) };
  if (GROUPS[family]) {
    if (!accepted.has(family)) return null;   // a group that is no set has no family
    const g = GROUPS[family];
    return bySort(g.roots(c).concat(...g.members.map((m) => g.owned[m] || [])));
  }
  if (STANDALONE[family]) return STANDALONE[family](s);
  const g = groupOf(family);
  if (!g) return [];
  if (accepted.has(g)) return null;   // a member of a set declares nothing
  return (s.rejectedProps === "copy" ? GROUPS[g].roots(c) : []).concat(GROUPS[g].owned[family] || []);
}

// The fixture's bindings (D4): [layer, enclosing symbol, kept key and root id | null, class when dropped
// whatever the family declares]. A kept candidate drops as "undeclared" when its family lacks the root;
// 5:204's VISIBLE binding to the TEXT root Label is type-mismatch only when Label is declared.
const BINDINGS = [
  ["1:12", BUTTON_S, ["characters", "1:900"]], ["1:13", BUTTON_S, ["visible", "1:901"]],
  ["1:15", BUTTON_L, ["characters", "1:900"]], ["1:16", BUTTON_L, ["visible", "1:901"]],
  [M2A.libTagLightText, M2A.libTagLight, ["characters", M2A.dTagText]], [M2A.libTagDarkText, M2A.libTagDark, ["characters", M2A.dTagText]],
  [M2A.chipSLabel, M2A.chipS, ["characters", M2A.dLabel]], [M2A.chipSDot, M2A.chipS, ["visible", M2A.dShowIcon]],
  [M2A.chipSIcon, M2A.chipS, ["mainComponent", M2A.dIcon]], [M2A.chipSWrongType, M2A.chipS, ["type-mismatch", M2A.dLabel]],
  [M2A.chipSFillStyle, M2A.chipS, null, "fill-style"],
  [M2A.chipHLabel, M2A.chipHoverS, ["characters", M2A.dLabel]], [M2A.chipHDot, M2A.chipHoverS, ["visible", M2A.dShowIcon]],
  [M2A.chipHIcon, M2A.chipHoverS, ["mainComponent", M2A.dIcon]], [M2A.chipHOtherFamily, M2A.chipHoverS, null, "other-family"],
  [M2A.chipMLabel, M2A.chipM, ["characters", M2A.dLabel]], [M2A.chipMDot, M2A.chipM, ["visible", M2A.dShowIcon]],
  [M2A.chipMIcon, M2A.chipM, ["mainComponent", M2A.dIcon]], [M2A.chipMNoRoot, M2A.chipM, null, "no-root"],
  [M2A.chipLLabel, M2A.chipL, ["characters", M2A.dLabel]], [M2A.chipLDot, M2A.chipL, ["visible", M2A.dShowIcon]],
  [M2A.chipLIcon, M2A.chipL, ["mainComponent", M2A.dIcon]], [M2A.chipLBadge, M2A.chipL, ["visible", M2A.dBadge]],
  [M2A.rejAxisCountFlag, M2A.rejAxisCountA, ["visible", M2A.dRejFlag]], [M2A.rejAxisCountTitle, M2A.rejAxisCountB, ["characters", M2A.dRejTitle]],
  [M2A.rowTitle, M2A.row, ["characters", M2A.dRowTitle]], [M2A.rowLead, M2A.row, ["mainComponent", M2A.dRowLead]],
  [M2A.cardBadgeA, M2A.card, ["mainComponent", M2A.dCardBadge]], [M2A.cardBadgeB, M2A.card, ["mainComponent", M2A.dCardBadge]],
];
// layer -> { refs } | { cls }, for the accepted groups and settings.
function expectedBindings(accepted, s) {
  const out = new Map();
  for (const [layer, sym, kept, cls] of BINDINGS) {
    if (!kept) { out.set(layer, { cls }); continue; }
    const g = groupOf(sym);
    const family = g && accepted.has(g) ? g : sym;
    const declared = (expectedProps(family, accepted, s) || []).some((d) => d.id === kept[1]);
    if (!declared) out.set(layer, { cls: "undeclared" });
    else if (kept[0] === "type-mismatch") out.set(layer, { cls: "type-mismatch" });
    else out.set(layer, { refs: { [kept[0]]: kept[1] } });
  }
  return out;
}

// ---------- level 1: properties.mjs with a context built here ----------
const FX = makeFixture();
// A planted same-name definition: Chip's group gains a BOOL root named "Dot", the name of Lib Tag's
// 5:951 that 5:214 binds and iAssigned assigns. Matched by name, both would resolve; they must not.
const PLANT_ID = { sessionID: 5, localID: 970 };
const PLANTED = makeFixture("valid", { mutate(value) {
  const chip = value.pixsoNodes.find((n) => n.guid.sessionID === 5 && n.guid.localID === 100);
  const show = chip.componentPropDef.find((d) => d.name === "Show icon");
  chip.componentPropDef.push(Object.assign({}, show, { id: PLANT_ID, name: "Dot", sortPosition: "g" }));
} });

function context(fx, settings, acceptedList) {
  const pix = readPix(fx.pix);
  const byGuid = new Map(pix.nodes.map((n) => [gs(n.guid), n]));
  const en = enumReader(pix.schema);
  const typeOf = en("PixsoNode", "type");
  const typeName = (n) => typeOf(n.type);
  const kids = childrenByParent(pix.nodes);
  const childrenOf = (n) => kids.get(gs(n.guid)) || [];
  const roots = pix.nodes.filter((n) => !n.parentIndex || !byGuid.has(gs(n.parentIndex.guid)));
  const plannedOf = (n) => ({ n, type: typeName(n) === "SYMBOL" ? "COMPONENT" : typeName(n), kids: childrenOf(n).map(plannedOf) });
  const accepted = new Map(acceptedList.map((g) => [g, { axes: [], variant: new Map() }]));
  const notes = [];
  const cx = {
    pix, en, byGuid, childrenOf, typeName, settings: readerSettings(settings), m2a: newM2aStats(), stats: { unsupported: {} },
    // Every SYMBOL is a COMPONENT record but Icon/Broken (5:303), which the reader does not carry (D5).
    componentGuids: new Set(pix.nodes.filter((n) => typeName(n) === "SYMBOL" && gs(n.guid) !== M2A.broken).map((n) => gs(n.guid))),
    planned: [{ tops: roots.map(plannedOf) }], at: undefined, featured: new Set(),
    note(code, detail) { notes.push({ code, at: cx.at, detail }); },
    feature(name) { if (!cx.featured.has(name)) { cx.featured.add(name); notes.push({ code: CODE.SOURCE_FEATURE_UNSUPPORTED, at: cx.at, detail: name }); } },
  };
  const setOf = (sym) => { const n = byGuid.get(sym); const p = n && n.parentIndex ? gs(n.parentIndex.guid) : null; return p && accepted.has(p) ? p : null; };
  cx.families = { setOf, familyOf: (sym) => setOf(sym) || sym, accepted, rejected: new Map(Object.entries(REJECTED).filter(([g]) => !accepted.has(g))),
    recordType: (n, planned) => planned };
  cx.props = propIndex(cx);
  return { cx, notes, byGuid };
}
// Every family's properties, as the seam asks for them: sets and standalone components, each with cx.at
// set to the family's guid (so a note names it).
function declareAll(cx, accepted) {
  const out = new Map();
  for (const n of cx.pix.nodes) {
    const g = gs(n.guid);
    const t = cx.typeName(n);
    if (!(accepted.indexOf(g) >= 0 || (t === "SYMBOL" && cx.families.setOf(g) === null && g !== M2A.broken))) continue;
    cx.at = g; cx.featured = new Set();
    const p = B.propertiesOf(cx, g);
    if (p.length || accepted.indexOf(g) >= 0) out.set(g, p);
    cx.at = undefined;
  }
  return out;
}
function bindAll(cx, byGuid) {
  const out = new Map();
  for (const [layer] of BINDINGS) { cx.at = layer; cx.featured = new Set(); out.set(layer, B.bindingsOf(cx, byGuid.get(layer), 0)); cx.at = undefined; }
  return out;
}

const SETTING_PAIRS = [];
for (const swapDefault of ["layer", "definition"]) for (const rejectedProps of ["copy", "none"]) SETTING_PAIRS.push({ swapDefault, rejectedProps });

for (const [label, acceptedList] of [["the fixture's sets accepted", ACCEPTED], ["no set accepted (--variant-sets frames)", []]]) {
  const accepted = new Set(acceptedList);
  for (const s of SETTING_PAIRS) {
    const tag = label + ", --swap-default " + s.swapDefault + ", --rejected-props " + s.rejectedProps;
    check("D3, D5: every family declares its roots only, type, name and default from the root, in sortPosition order (" + tag + ")", () => {
      const { cx } = context(FX, s, acceptedList);
      const got = declareAll(cx, acceptedList);
      const families = new Set([...got.keys()]);
      for (const f of [...Object.keys(GROUPS), ...Object.keys(STANDALONE), ...Object.values(GROUPS).flatMap((g) => g.members)]) {
        const want = expectedProps(f, accepted, s);
        if (want === null) { if (got.has(f) && !accepted.has(f)) throw new Error(f + " declares " + canonicalJSON(got.get(f))); continue; }
        same(got.get(f) || [], want, f + ":");
        families.delete(f);
      }
      for (const f of families) same(got.get(f), [], "unexpected family " + f + ":");
    });
    check("D4: every binding names its root id or drops in its first class, one note per record and class (" + tag + ")", () => {
      const { cx, notes, byGuid } = context(FX, s, acceptedList);
      declareAll(cx, acceptedList);
      notes.length = 0;
      const got = bindAll(cx, byGuid);
      const want = expectedBindings(accepted, s);
      for (const [layer, w] of want) {
        if (w.refs) same(got.get(layer), w.refs, layer + ":");
        else {
          if (got.get(layer) !== null) throw new Error(layer + " kept " + canonicalJSON(got.get(layer)) + ", want dropped " + w.cls);
          const mine = notes.filter((n) => n.at === layer);
          same(mine.map((n) => [n.code, n.detail.split(":")[0]]), [[CODE.PROPERTY_REF_DROPPED, w.cls]], layer + " notes:");
          if (!/^[a-z-]+: 1( \(.*\))?$/.test(mine[0].detail)) throw new Error(layer + ": detail " + JSON.stringify(mine[0].detail));
        }
      }
      for (const n of notes) if (n.code === CODE.PROPERTY_REF_DROPPED && !want.has(n.at)) throw new Error("a note on " + n.at);
      const st = cx.m2a.properties.bindings;
      const dropped = Object.values(st.dropped).reduce((a, b) => a + b, 0);
      if (st.total !== BINDINGS.length || st.total !== st.kept + dropped) throw new Error("bindings " + canonicalJSON(st));
      same(Object.keys(st.dropped), NOTE_CLASSES.PROPERTY_REF_DROPPED);
      return st.kept + " kept, " + dropped + " dropped";
    });
  }
}

check("D3, D5: the counters on the fixture's sets (lifted Badge, copied Title, defaults from layers, disagreeing layers, preferred values, stringValues)", () => {
  const got = {};
  for (const s of SETTING_PAIRS) {
    const { cx, byGuid } = context(FX, s, ACCEPTED);
    declareAll(cx, ACCEPTED);
    bindAll(cx, byGuid);
    const p = cx.m2a.properties;
    got[s.swapDefault + "/" + s.rejectedProps] = [p.liftedMemberRoots, p.copiedRoots, p.swapDefaultFromLayer, p.swapDefaultLayersDisagree, p.preferred,
      p.unnamedRoots, p.declaredNotRoot, p.aliases, p.viaAlias, p.boundLayerDiffers, p.swapDangling.default];
  }
  const want = (fromLayer, copied) => [1, copied, fromLayer, { roots: 1, layers: 1 }, { inFile: 2, byKeyOnly: 1, stringValuesDropped: 2 }, 0, 0, 14, 10,
    // text: 5:231 says "Large" (Label defaults to "Chip"), and M1's two Button labels carry no characters
    // ("Button"); visible: 5:202 is hidden (Show icon defaults to true), 5:234 is shown (Badge defaults to false).
    { text: 3, visible: 2 }, 0];
  same(got, { "layer/copy": want(2, 2), "layer/none": want(2, 0), "definition/copy": want(1, 2), "definition/none": want(1, 0) });
});
check("D3: the COLOR root is not declared, noted SOURCE_FEATURE_UNSUPPORTED \"COLOR property\" on its family's record once", () => {
  for (const [acc, where] of [[ACCEPTED, [M2A.chip]], [[], [M2A.chipS, M2A.chipHoverS, M2A.chipM, M2A.chipL]]]) {
    const { cx, notes } = context(FX, {}, acc);
    declareAll(cx, acc);
    same(notes.filter((n) => n.code === CODE.SOURCE_FEATURE_UNSUPPORTED).map((n) => [n.at, n.detail]), where.map((w) => [w, "COLOR property"]));
  }
});
check("D3: a same-id alias read from its member names the set's root, not the member's unnamed BOOL", () => {
  const { cx } = context(FX, {}, ACCEPTED);
  const d = cx.props.rootOf(M2A.chip, M2A.dLabel, M2A.chipHoverS);
  same([d.owner, d.type, d.name], [M2A.chip, "TEXT", "Label"]);
});
check("D5: an INSTANCE_SWAP root with no default the IR can reference is not declared: SWAP_VALUE_DANGLING \"default\" on the family, its bindings undeclared", () => {
  // Chip's Icon with no bound layer agreeing and an initialValue naming nothing: break the layers' agreement.
  const fx = makeFixture("valid", { mutate(value) {
    const icon = value.pixsoNodes.find((n) => n.guid.sessionID === 5 && n.guid.localID === 213);
    icon.symbolData.symbolID = { sessionID: 5, localID: 301 };
  } });
  const r = {};
  for (const swapDefault of ["layer", "definition"]) {
    const { cx, notes, byGuid } = context(fx, { swapDefault }, ACCEPTED);
    const props = declareAll(cx, ACCEPTED);
    if (props.get(M2A.chip).some((d) => d.id === M2A.dIcon)) throw new Error("Icon declared under " + swapDefault);
    same(notes.filter((n) => n.code === CODE.SWAP_VALUE_DANGLING).map((n) => [n.at, n.detail]), [[M2A.chip, "default: Icon"]]);
    const b = bindAll(cx, byGuid);
    if (b.get(M2A.chipSIcon) !== null) throw new Error("a binding to the undeclared Icon was kept");
    r[swapDefault] = [cx.m2a.properties.swapDangling.default, cx.m2a.properties.bindings.dropped.undeclared];
  }
  same(r, { layer: [1, 4], definition: [1, 4] });
});
check("D4, D6: nothing is matched by name (a planted root named like Lib Tag's Dot stays apart from 5:951)", () => {
  const { cx, byGuid } = context(PLANTED, {}, ACCEPTED);
  const props = declareAll(cx, ACCEPTED);
  if (!props.get(M2A.chip).some((d) => d.name === "Dot" && d.id === "5:970")) throw new Error("the planted root is not declared");
  const b = bindAll(cx, byGuid);
  if (b.get(M2A.chipHOtherFamily) !== null) throw new Error("5:214 resolved: " + canonicalJSON(b.get(M2A.chipHOtherFamily)));
  const a = B.assignments(cx, M2A.chipS, [{ defID: { sessionID: 5, localID: 951 }, value: { boolValue: true } }], {});
  same([a.kept, a.dropped.map((d) => [d.class, d.detail])], [[], [["other-family", "other-family"]]]);
});

check("D3, D4: two members' roots with one id (0 in D, K, M, P): the set declares the first member's, and a binding to the other's is undeclared, never merged by id", () => {
  // Chip S (5:101) gains a member-owned root with Badge's id (5:908), and its fill-styled layer 5:205
  // binds it (VISIBLE). Members are read in order, so the set lifts Chip S's; Chip L's Badge stays apart.
  const fx = makeFixture("valid", { mutate(value) {
    const find = (l) => value.pixsoNodes.find((n) => n.guid.sessionID === 5 && n.guid.localID === l);
    const chipL = find(104), chipS = find(101), layer = find(205), badgeLayer = find(234);
    const badge = chipL.componentPropDef.find((d) => d.name === "Badge");
    chipS.componentPropDef.push(Object.assign({}, badge, { name: "Badge2" }));
    layer.componentPropRef = badgeLayer.componentPropRef.map((r) => Object.assign({}, r));
  } });
  const { cx, byGuid } = context(fx, {}, ACCEPTED);
  const props = declareAll(cx, ACCEPTED);
  same(props.get(M2A.chip).filter((d) => d.id === M2A.dBadge).map((d) => d.name), ["Badge2"]);
  const b = bindAll(cx, byGuid);
  same([b.get(M2A.chipSFillStyle), b.get(M2A.chipLBadge)], [{ visible: M2A.dBadge }, null]);
  return cx.m2a.properties.bindings.dropped.undeclared === 1;
});

// ---------- assignments (D6) ----------
const rawOf = (byGuid, g) => byGuid.get(g).componentPropAssignment || [];
const entryOf = (byGuid, g, pathGuids) => byGuid.get(g).symbolData.symbolOverrides.find((e) => canonicalJSON((e.guidPath.guids || []).map(gs)) === canonicalJSON(pathGuids));
const summary = (r) => ({ kept: r.kept, dropped: r.dropped.map((d) => [d.code, d.class, d.defId, d.detail]) });
for (const [label, acc] of [["sets accepted", ACCEPTED], ["no set accepted", []]]) {
  check("D6: the fixture's instance assignments, each in exactly one class (" + label + ")", () => {
    const { cx, byGuid } = context(FX, {}, acc);
    declareAll(cx, acc);
    const chip = acc.length ? M2A.chip : null;
    const fam = (member) => chip || member;
    const SA = CODE.STALE_ASSIGNMENT, SVD = CODE.SWAP_VALUE_DANGLING;
    // iAssigned (Chip S): Label kept, the alias 5:911 kept as Show icon, then one per class.
    same(summary(B.assignments(cx, M2A.chipS, rawOf(byGuid, M2A.iAssigned), {})), {
      kept: [{ family: fam(M2A.chipS), id: M2A.dLabel, value: "Hello" }, { family: fam(M2A.chipS), id: M2A.dShowIcon, value: false }],
      dropped: [[SA, "no-definition", M2A.dNoDefinition, "no-definition"], [SA, "other-family", M2A.dTagDot, "other-family"],
        [SA, "no-root", M2A.dSetAliasNowhere, "no-root"], [SA, "undeclared", M2A.dTint, "undeclared"], [SVD, "assignment", M2A.dIcon, "assignment"]] }, "iAssigned:");
    // iDefaultEqual (Chip M): Show icon true (its default) and the alias 5:916 -> Square, kept.
    same(summary(B.assignments(cx, M2A.chipM, rawOf(byGuid, M2A.iDefaultEqual), {})), {
      kept: [{ family: fam(M2A.chipM), id: M2A.dShowIcon, value: true }, { family: fam(M2A.chipM), id: M2A.dIcon, value: { guid: M2A.square } }], dropped: [] }, "iDefaultEqual:");
    // iNotCarried (Chip L): Icon -> 5:303, stored but neither a record nor a library copy.
    same(summary(B.assignments(cx, M2A.chipL, rawOf(byGuid, M2A.iNotCarried), {})), { kept: [], dropped: [[SVD, "assignment", M2A.dIcon, "assignment: not carried"]] }, "iNotCarried:");
    // iByProperty (Row): the alias 5:922 of Lead icon -> Square.
    same(summary(B.assignments(cx, M2A.row, rawOf(byGuid, M2A.iByProperty), {})), { kept: [{ family: M2A.row, id: M2A.dRowLead, value: { guid: M2A.square } }], dropped: [] }, "iByProperty:");
    // iEntries: its own Title; the [5:403] entry's Title judged against Circle (the nested instance's
    // effective symbol): nested, other-family; the stale [5:499] entry's, dropped with it.
    same(summary(B.assignments(cx, M2A.row, rawOf(byGuid, M2A.iEntries), {})), { kept: [{ family: M2A.row, id: M2A.dRowTitle, value: "Assigned title" }], dropped: [] }, "iEntries:");
    same(summary(B.assignments(cx, M2A.circle, entryOf(byGuid, M2A.iEntries, [M2A.rowTrail]).componentPropAssignment, { nested: true })),
      { kept: [], dropped: [[SA, "nested", M2A.dRowTitle, "nested: other-family"]] }, "iEntries [5:403]:");
    same(summary(B.assignments(cx, M2A.row, entryOf(byGuid, M2A.iEntries, ["5:499"]).componentPropAssignment, { drop: "entry" })),
      { kept: [], dropped: [[null, "with-entry", M2A.dRowTitle, null]] }, "iEntries [5:499]:");
    // iRuleC: the entry on the nested Row assigns Lead icon, which rule C ignored.
    same(summary(B.assignments(cx, M2A.row, entryOf(byGuid, M2A.iRuleC, [M2A.cardRow]).componentPropAssignment, { nested: true, ignored: new Set([M2A.dRowLead]) })),
      { kept: [], dropped: [[SA, "ignored", M2A.dRowLead, "ignored"]] }, "iRuleC:");
    const A = cx.m2a.properties.assignments;
    const stale = Object.values(A.stale).reduce((a, b) => a + b, 0);
    if (A.total !== A.kept + A.droppedWithEntry + A.merged + A.dangling + A.defaultDropped + stale) throw new Error("G7 does not add up: " + canonicalJSON(A));
    same([A.total, A.kept, A.droppedWithEntry, A.dangling, A.stale], [15, 6, 1, 2, { "no-definition": 1, "other-family": 1, "no-root": 1, undeclared: 1, nested: 1, ignored: 1 }]);
    same(cx.m2a.properties.swapDangling.assignment, 2);
  });
}
check("D6: --default-assignments drop drops (and counts) only an assignment equal to its root's default", () => {
  const { cx, byGuid } = context(FX, { defaultAssignments: "drop" }, ACCEPTED);
  declareAll(cx, ACCEPTED);
  same(summary(B.assignments(cx, M2A.chipM, rawOf(byGuid, M2A.iDefaultEqual), {})),
    { kept: [{ family: M2A.chip, id: M2A.dIcon, value: { guid: M2A.square } }], dropped: [[null, "default", M2A.dShowIcon, null]] });
  return cx.m2a.properties.assignments.defaultDropped === 1;
});
check("D6 and docs/M2A.md §0.2: an id only another member of the set defines is other-family; two ids reaching one root merge, the later winning", () => {
  const { cx } = context(FX, {}, ACCEPTED);
  declareAll(cx, ACCEPTED);
  const A = (id, v) => ({ defID: { sessionID: 5, localID: Number(id.split(":")[1]) }, value: v });
  // 5:910 is Chip S's alias of Label: on an instance of Chip Hover S it names nothing the master reaches.
  same(summary(B.assignments(cx, M2A.chipHoverS, [A(M2A.dChipSLabel, { textValue: { characters: "x" } })], {})),
    { kept: [], dropped: [[CODE.STALE_ASSIGNMENT, "other-family", M2A.dChipSLabel, "other-family"]] });
  // On Chip S, its alias 5:910 and the root 5:900 both reach Label: the earlier is merged away.
  same(summary(B.assignments(cx, M2A.chipS, [A(M2A.dChipSLabel, { textValue: { characters: "first" } }), A(M2A.dLabel, { textValue: { characters: "second" } })], {})),
    { kept: [{ family: M2A.chip, id: M2A.dLabel, value: "second" }], dropped: [[null, "merged", M2A.dChipSLabel, null]] });
  const st = cx.m2a.properties.assignments;
  return st.merged === 1 && st.stale["other-family"] === 1;
});
check("D6: a TEXT value with a style table keeps its characters and is counted; a value is read from the root's slot, not the alias's", () => {
  const { cx } = context(FX, {}, ACCEPTED);
  declareAll(cx, ACCEPTED);
  const v = { textValue: { characters: "Rich", characterStyleIDs: [0, 1, 1, 1], styleOverrideTable: [{ styleID: 1, fontSize: 20 }] }, boolValue: true, guidValue: { sessionID: 5, localID: 300 } };
  // 5:910 is an unnamed BOOL alias of the TEXT root Label: its value is Label's text, never the bool.
  same(summary(B.assignments(cx, M2A.chipS, [{ defID: { sessionID: 5, localID: 910 }, value: v }], {})), { kept: [{ family: M2A.chip, id: M2A.dLabel, value: "Rich" }], dropped: [] });
  return cx.m2a.properties.assignments.richTextFlattened === 1;
});
check("D6: opts.drop \"merged\" counts part C's merged-away assignments; an unknown drop is refused", () => {
  const { cx, byGuid } = context(FX, {}, ACCEPTED);
  const r = B.assignments(cx, M2A.chipS, rawOf(byGuid, M2A.iAssigned), { drop: "merged" });
  if (r.kept.length || r.dropped.length !== 7 || cx.m2a.properties.assignments.merged !== 7 || cx.m2a.properties.assignments.total !== 7) return false;
  try { B.assignments(cx, M2A.chipS, [], { drop: "sometimes" }); } catch (e) { return "refused: " + e.message.split(";")[0]; }
  return false;
});

// ---------- level 2: the reader end to end ----------
const RUNS = new Map();
const run = (fx, s) => pixToIR(fx.pix, { settings: s });
for (const s of SETTING_PAIRS) {
  const tag = "--swap-default " + s.swapDefault + ", --rejected-props " + s.rejectedProps;
  check("pixToIR (" + tag + "): the IR validates; every family declares what the fixture says, given the sets families.mjs accepted; declared types are their roots'", () => {
    const { ir } = run(FX, s);
    RUNS.set(tag, ir);
    const v = validate(ir);
    if (!v.ok) throw new Error(canonicalJSON(v.errors.slice(0, 3)));
    const accepted = new Set(ir.sets.map((x) => ir.nodes[x.node].guid));
    for (const x of ir.sets) same(x.properties, expectedProps(ir.nodes[x.node].guid, accepted, s) || [], "set " + ir.nodes[x.node].guid + ":");
    for (const c of ir.components) {
      if (c.set !== null) { if (c.properties !== undefined) throw new Error("a member declares " + canonicalJSON(c.properties)); continue; }
      const g = ir.nodes[c.node].guid;
      same(c.properties || [], expectedProps(g, accepted, s), "component " + g + ":");
    }
    return accepted.size + " sets accepted by families.mjs";
  });
  check("pixToIR (" + tag + "): every binding is the root id or one PROPERTY_REF_DROPPED note in its class", () => {
    const ir = RUNS.get(tag);
    const accepted = new Set(ir.sets.map((x) => ir.nodes[x.node].guid));
    const want = expectedBindings(accepted, s);
    const at = new Map(ir.nodes.map((n, i) => [n.guid, i]));
    for (const [layer, w] of want) {
      const n = ir.nodes[at.get(layer)];
      const notes = ir.notes.filter((x) => x.code === CODE.PROPERTY_REF_DROPPED && x.node === at.get(layer)).map((x) => x.detail.split(":")[0]);
      if (w.refs) { same(n.props.componentPropertyReferences, w.refs, layer + ":"); same(notes, [], layer + " notes:"); }
      else { if (n.props.componentPropertyReferences !== undefined) throw new Error(layer + " kept a binding"); same(notes, [w.cls], layer + " notes:"); }
    }
    const bound = ir.nodes.filter((n) => n.props.componentPropertyReferences).length;
    const noted = ir.notes.filter((x) => x.code === CODE.PROPERTY_REF_DROPPED).length;
    if (bound + noted !== BINDINGS.length) throw new Error(bound + " bound and " + noted + " noted records, want " + BINDINGS.length);
  });
}
check("the renumbered fixture gives the same properties and bindings", () => {
  const a = run(FX, {}).ir, b = run(makeFixture("renumbered"), {}).ir;
  const pick = (ir) => [ir.sets.map((s) => s.properties), ir.components.map((c) => c.properties || null), ir.nodes.map((n) => n.props.componentPropertyReferences || null),
    ir.notes.filter((n) => /PROPERTY_REF_DROPPED|SWAP_VALUE_DANGLING|SOURCE_FEATURE/.test(n.code))];
  same(pick(b), pick(a));
});
check("properties.mjs is part B's (no STUB), and its counters keep the frozen shape", () => {
  if (B.STUB !== undefined) return false;
  const { stats } = run(FX, {});
  same(Object.keys(stats.m2a.properties), Object.keys(newM2aStats().properties));
  same(Object.keys(stats.m2a.properties.assignments.stale), NOTE_CLASSES.STALE_ASSIGNMENT);
});

console.log("");
console.log(failed ? failed + " M2a property check" + (failed === 1 ? "" : "s") + " FAILED" : "all M2a property checks pass (" + passed + ")");
process.exit(failed ? 1 : 0);
