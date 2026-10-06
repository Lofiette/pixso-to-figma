// Part A's tests: families, variant sets and the populations (docs/M2A.md D2, D13, §6 A).
//
//   node tools/test-m2a-families.mjs
//
// Everything here is synthetic: the fixture (tools/pix/fixture.mjs, M2A ids) and member names made up
// below. It checks:
//   - the grammar and the rejection classes in D2's order, on made-up groups that hold two classes at
//     once, so a wrong order fails (decideGroup, parseVariantName, vocabularyOf);
//   - the FamilyIndex contract (families.mjs header): setOf, familyOf, accepted, rejected, recordType,
//     on a plan built from the fixture, and the note recordType writes;
//   - each fixture state group's outcome under each setting: Button (M1's set), Chip, Lib Tag, Toggle
//     and Vocab accepted under --variant-grammar names; the four rejected groups with their class;
//     Vocab rejected "vocabulary" under --variant-grammar vocabulary; under --variant-sets frames no
//     set, no note, every member standalone and every counter 0 (M1's D7);
//   - the IR: an accepted group is a COMPONENT_SET record with a `sets` entry (axes, properties, Lib Tag's
//     library identity) and members with `set` and `variant`; a rejected one stays a FRAME with one
//     VARIANT_SET_REJECTED note on its own record, the detail starting with the class, its members
//     standalone; under a pages scope the note still names the group's record;
//   - axis and value order: Chip [State, Size] under --axis-order vocabulary, [Size, State] under names;
//     Size's values [S, M, L], L appended (valuesAppended 1); every variant's keys in axis order;
//   - stats.m2a.families, exactly, under each setting;
//   - byte-identical IR on two reads under every families setting;
//   - the populations: the sets on the internal canvas (Button, Chip, Lib Tag, Vocab) in
//     stateGroupsInternal, Toggle on a user page in userTop with its members in userMasters, every
//     population equal to --variant-sets frames'; populations() takes a COMPONENT_SET as a state group;
//   - D13: Toggle (auto layout) keeps its frame's props; the tasks, in every M1 scope, equal those of
//     --variant-sets frames apart from the VARIANT_SET_REJECTED notes they carry, a set written as FRAME;
//   - the validator's coordinate checks on the result: the IR validates, and a member moved to another
//     member's coordinate, or to a value its axis lacks, is refused.
// DONE WHEN (docs/M2A.md §6 A) this test passes and, on D, K, M and P, accepted / rejected are 64 / 3,
// 308 / 4, 221 / 6, 348 / 11 (P 342 / 17 under vocabulary), members of rejected sets 66 / 97 / 192 /
// 436, the split by class under D2's order is in the pull request, and the M1 balance adds up.
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };
const check = (label, fn) => {
  try { const r = fn(); if (r === false) fail(label); else ok(label + (typeof r === "string" ? " (" + r + ")" : "")); }
  catch (e) { fail(label + ": " + (e && e.message ? e.message.split("\n")[0] : e)); }
};
const same = (a, b, what) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error((what ? what + " " : "") + "got " + x.slice(0, 400) + ", want " + y.slice(0, 400)); };
if (typeof zlib.zstdCompressSync !== "function") { console.log("FAIL the M2a families checks need Node 22.15 or newer (built-in zstd)"); process.exit(1); }
const imp = (p) => import(pathToFileURL(join(HERE, p)).href);

const schema = await imp("ir/schema.mjs");
const { validate } = await imp("ir/validate.mjs");
const { planM1 } = await imp("ir/plan.mjs");
const { makeFixture, M2A } = await imp("pix/fixture.mjs");
const reader = await imp("pix/ir/index.mjs");
const { readPix, childrenByParent } = await imp("pix/read.mjs");
const { enumReader, NODE_TYPE } = await imp("pix/ir/enums.mjs");
const families = await imp("pix/ir/families.mjs");
const { populations } = await imp("pix/ir/populations.mjs");
const { familyIndex, decideGroup, parseVariantName, vocabularyOf, REJECTION_ORDER } = families;

const FX = makeFixture();
const read = (settings) => reader.pixToIR(FX.pix, { settings });
// The four reads every later check uses; a read the validator refuses fails here, loudly.
let BASE, FRAMES, GRAMMAR, NAMES;
try { BASE = read(); FRAMES = read({ variantSets: "frames" }); GRAMMAR = read({ variantGrammar: "vocabulary" }); NAMES = read({ axisOrder: "names" }); }
catch (e) { console.log("FAIL the fixture does not read into a valid IR: " + String(e && e.message ? e.message : e).split("\n")[0]); process.exit(1); }
const BUTTON = "1:10";     // M1's fixture set (fixture.mjs SET): Size x State, both orders in its names

const recOf = (ir, g) => ir.nodes.findIndex((n) => n.guid === g);
const setOfRec = (ir, i) => ir.sets.find((s) => s.node === i);
const compOfRec = (ir, i) => ir.components.find((c) => c.node === i);
const membersOf = (ir, g) => { const i = recOf(ir, g); return ir.nodes.map((n, k) => (n.parent === i && n.type === "COMPONENT" ? k : -1)).filter((k) => k >= 0); };
const rejNotes = (ir) => ir.notes.filter((n) => n.code === schema.CODE.VARIANT_SET_REJECTED);

const ACCEPTED = [BUTTON, M2A.chip, M2A.libTag, M2A.toggle, M2A.vocab];
const REJECTED = [[M2A.rejNoEquals, "no-equals"], [M2A.rejDupAxis, "duplicate-axis"], [M2A.rejAxisCount, "axis-count"], [M2A.rejDupCoord, "duplicate-coordinate"]];

if (families.STUB !== undefined) { console.log("FAIL tools/pix/ir/families.mjs is still P0's stub"); process.exit(1); }

// ---------- 1. the grammar and the classes, on made-up names ----------
const S0 = { variantGrammar: "names", axisOrder: "vocabulary" };
const grp = (...names) => names.map((name, k) => ({ guid: "9:" + (k + 1), name }));
check("parseVariantName: split on \",\", each pair on its first \"=\", axis and value trimmed", () => {
  same(parseVariantName(" Size = S ,State=On"), { pairs: [["Size", "S"], ["State", "On"]] });
  same(parseVariantName("Size=S=M"), { pairs: [["Size", "S=M"]] });
  same(parseVariantName("Size=S, Big"), { bad: "no-equals" });
  same(parseVariantName(""), { bad: "no-equals" });
  same(parseVariantName(" =S"), { bad: "no-equals" });
  same(parseVariantName("Size=S, Size =M"), { bad: "duplicate-axis" });
  same(parseVariantName("Size="), { pairs: [["Size", ""]] });
});
check("vocabularyOf: axes and values trimmed, a repeated axis or value kept once, the alias fields ignored", () => {
  same(vocabularyOf([{ property: " Size ", values: ["S", " M", "S"], aliasProperty: "x" }, { property: "Size", values: ["L"] }, { property: "", values: ["x"] }, { values: [] }]),
    [{ name: "Size", values: ["S", "M"] }]);
  same(vocabularyOf(undefined), []);
});
check("the classes in D2's order: each made-up group holds its class and every later one, and gets its own", () => {
  same(REJECTION_ORDER, schema.NOTE_CLASSES.VARIANT_SET_REJECTED, "REJECTION_ORDER vs schema:");
  const voc = vocabularyOf([{ property: "Tone", values: ["A"] }]);
  const cases = [
    // no-equals before duplicate-axis, axis-count, duplicate-coordinate, vocabulary and not-symbol
    ["no-equals", grp("Size=S, Size=M", "Big", "Size=S, State=On", "Size=S, State=On"), ["9:9"], { variantGrammar: "vocabulary" }],
    ["duplicate-axis", grp("Size=S", "Size=S, Size=M", "Size=S, State=On", "Size=S"), ["9:9"], { variantGrammar: "vocabulary" }],
    ["axis-count", grp("Size=S", "Size=S", "Size=M, State=On"), ["9:9"], { variantGrammar: "vocabulary" }],
    ["duplicate-coordinate", grp("Size=S, State=On", "State=On, Size=S"), ["9:9"], { variantGrammar: "vocabulary" }],
    ["vocabulary", grp("Size=S", "Size=M"), ["9:9"], { variantGrammar: "vocabulary" }],
    ["empty", [], ["9:9"], { variantGrammar: "vocabulary" }],
    ["not-symbol", grp("Size=S", "Size=M"), ["9:9"], {}],
  ];
  for (const [cls, members, others, s] of cases) {
    const d = decideGroup(members, others, voc, Object.assign({}, S0, s));
    if (d.ok || d.cls !== cls) throw new Error(cls + ": got " + (d.ok ? "accepted" : d.cls));
    if (schema.noteClass(schema.CODE.VARIANT_SET_REJECTED, d.detail) !== cls) throw new Error(cls + ": the detail " + JSON.stringify(d.detail) + " does not start with its class");
  }
  // A value the vocabulary lacks is appended under either grammar, never a rejection.
  for (const g of ["names", "vocabulary"]) {
    const d = decideGroup(grp("Size=S", "Size=XL"), [], vocabularyOf([{ property: "Size", values: ["M", "S"] }]), Object.assign({}, S0, { variantGrammar: g }));
    if (!d.ok) throw new Error(g + ": a value the vocabulary lacks rejected the group as " + d.cls);
    same([d.axes, d.appended], [[{ name: "Size", values: ["S", "XL"] }], 1], g + ":");
  }
  return cases.length + " classes";
});
check("axis order: the vocabulary's when it lists exactly the names' axes, else the first member's; values: the vocabulary's used ones, then the rest in member order", () => {
  const names = grp("B=1, A=x", "A=y, B=2", "B=3, A=x");
  const vAB = vocabularyOf([{ property: "A", values: ["y", "z", "x"] }, { property: "B", values: ["2"] }]);
  const a = decideGroup(names, [], vAB, S0);
  same([a.order, a.axes, a.appended], ["vocabulary", [{ name: "A", values: ["y", "x"] }, { name: "B", values: ["2", "1", "3"] }], 2], "vocabulary order:");
  same([...a.variant.values()].map((v) => Object.keys(v)), [["A", "B"], ["A", "B"], ["A", "B"]], "variant keys in axis order:");
  const b = decideGroup(names, [], vAB, Object.assign({}, S0, { axisOrder: "names" }));
  same([b.order, b.axes.map((x) => x.name), b.axes[0].values], ["names", ["B", "A"], ["2", "1", "3"]], "--axis-order names:");
  same(Object.keys(b.variant.get("9:2")), ["B", "A"], "variant keys:");
  // The vocabulary lists another axis: names order, and an axis it does not list appends nothing.
  const c = decideGroup(names, [], vocabularyOf([{ property: "A", values: ["x"] }]), S0);
  same([c.order, c.axes, c.appended], ["names", [{ name: "B", values: ["1", "2", "3"] }, { name: "A", values: ["x", "y"] }], 1], "another axis set:");
});

// ---------- 2. the FamilyIndex contract, on a plan built from the fixture ----------
// A plan as nodes.mjs plan() makes it, for the stored tree under the pages: { page, tops: [{ n, type, kids }] }.
const PIX = readPix(FX.pix);
const typeOf = enumReader(PIX.schema)("PixsoNode", "type");
const kidsOf = childrenByParent(PIX.nodes);
const gs = (g) => g.sessionID + ":" + g.localID;
const planOf = (n) => ({ n, type: NODE_TYPE[typeOf(n.type)], kids: (kidsOf.get(gs(n.guid)) || []).filter((k) => NODE_TYPE[typeOf(k.type)] && k.styleType === undefined && typeOf(n.type) !== "INSTANCE").map(planOf) });
const pagesOf = () => {
  const out = [];
  const visit = (n) => {
    const t = typeOf(n.type);
    if (t === "CANVAS") out.push({ page: { canvas: n, guid: gs(n.guid), internal: !!n.internalOnly }, tops: (kidsOf.get(gs(n.guid)) || []).filter((k) => NODE_TYPE[typeOf(k.type)] && k.styleType === undefined).map(planOf) });
    else for (const k of kidsOf.get(gs(n.guid)) || []) visit(k);
  };
  const stored = new Set(PIX.nodes.map((n) => gs(n.guid)));
  for (const r of PIX.nodes.filter((n) => !n.parentIndex || !stored.has(gs(n.parentIndex.guid)))) visit(r);
  return out;
};
const indexWith = (settings) => {
  const notes = [];
  const cx = { settings: reader.readerSettings(settings), planned: pagesOf(), m2a: reader.newM2aStats(), noteAt: (code, w) => notes.push(Object.assign({ code }, w)) };
  return { F: familyIndex(cx), cx, notes };
};
check("FamilyIndex: setOf, familyOf, accepted, rejected and recordType as frozen in families.mjs's header", () => {
  const { F, cx, notes } = indexWith({});
  same([...F.accepted.keys()].sort(), ACCEPTED.slice().sort(), "accepted:");
  same([...F.rejected.entries()].sort(), REJECTED.slice().sort(), "rejected:");
  same([F.setOf(M2A.chipS), F.setOf(M2A.chipL), F.setOf(M2A.toggleOn), F.setOf(M2A.rejAxisCountA), F.setOf(M2A.circle), F.setOf(M2A.chip), F.setOf(M2A.nothing)],
    [M2A.chip, M2A.chip, M2A.toggle, null, null, null, null], "setOf:");
  same([F.familyOf(M2A.chipHoverS), F.familyOf(M2A.libTagDark), F.familyOf(M2A.rejDupCoordB), F.familyOf(M2A.row)], [M2A.chip, M2A.libTag, M2A.rejDupCoordB, M2A.row], "familyOf:");
  const chip = F.accepted.get(M2A.chip);
  same(chip.axes, [{ name: "State", values: ["Default", "Hover"] }, { name: "Size", values: ["S", "M", "L"] }], "Chip axes:");
  same([...chip.variant.entries()], [[M2A.chipS, { State: "Default", Size: "S" }], [M2A.chipHoverS, { State: "Hover", Size: "S" }],
    [M2A.chipM, { State: "Default", Size: "M" }], [M2A.chipL, { State: "Hover", Size: "L" }]], "Chip variants:");
  const n = (g) => PIX.nodes.find((x) => gs(x.guid) === g);
  same([F.recordType(n(M2A.chip), "FRAME"), F.recordType(n(M2A.rejDupCoord), "FRAME"), F.recordType(n(M2A.chipS), "COMPONENT"), F.recordType(n(M2A.row), "COMPONENT")],
    ["COMPONENT_SET", "FRAME", "COMPONENT", "COMPONENT"], "recordType:");
  // recordType writes the rejected group's note once, by node, the detail starting with the class.
  F.recordType(n(M2A.rejDupCoord), "FRAME");
  same(notes.map((x) => [x.code, x.detail.split(":")[0]]), [["VARIANT_SET_REJECTED", "duplicate-coordinate"]], "notes:");
  if (!Number.isInteger(notes[0].node)) throw new Error("the note names no record");
  same(cx.m2a.families, { groups: 9, accepted: 5, rejected: { "no-equals": 1, "duplicate-axis": 1, "axis-count": 1, "duplicate-coordinate": 1, vocabulary: 0, empty: 0, "not-symbol": 0 },
    rejectedMembers: 8, valuesAppended: 1, vocabularyOrder: 4, namesOrder: 1 }, "counters:");
});
check("FamilyIndex under --variant-sets frames: nothing accepted or rejected, no note, every counter 0 (M1's D7)", () => {
  const { F, cx, notes } = indexWith({ variantSets: "frames" });
  const n = PIX.nodes.find((x) => gs(x.guid) === M2A.rejDupCoord);
  same([F.accepted.size, F.rejected.size, F.setOf(M2A.chipS), F.familyOf(M2A.chipS), F.recordType(PIX.nodes.find((x) => gs(x.guid) === M2A.chip), "FRAME"), F.recordType(n, "FRAME"), notes.length],
    [0, 0, null, M2A.chipS, "FRAME", "FRAME", 0]);
  same(cx.m2a.families, reader.newM2aStats().families);
});

// ---------- 3. the fixture's IR under each setting ----------
const outcome = (ir) => {
  const o = {};
  for (const g of ACCEPTED.concat(REJECTED.map((r) => r[0]))) {
    const i = recOf(ir, g);
    const nt = rejNotes(ir).filter((x) => x.node === i);
    o[g] = ir.nodes[i].type === "COMPONENT_SET" ? (setOfRec(ir, i) && !nt.length ? "set" : "set?") : nt.length === 1 ? nt[0].detail.split(":")[0] : ir.nodes[i].type + " with " + nt.length + " notes";
  }
  return o;
};
const want = (over) => Object.assign(Object.fromEntries(ACCEPTED.map((g) => [g, "set"]).concat(REJECTED)), over || {});
check("each group's outcome: --variant-grammar names (the default) and --axis-order names", () => { same(outcome(BASE.ir), want()); same(outcome(NAMES.ir), want()); });
check("each group's outcome: --variant-grammar vocabulary rejects Vocab as \"vocabulary\"", () => same(outcome(GRAMMAR.ir), want({ [M2A.vocab]: "vocabulary" })));
check("--variant-sets frames: no set, no note, every member standalone, every counter 0, and the IR as M1's D7 wrote it", () => {
  same([FRAMES.ir.sets.length, rejNotes(FRAMES.ir).length, FRAMES.ir.components.filter((c) => c.set !== null).length, FRAMES.ir.nodes.filter((n) => n.type === "COMPONENT_SET").length], [0, 0, 0, 0]);
  same(FRAMES.stats.m2a.families, reader.newM2aStats().families);
});
check("an accepted group: a COMPONENT_SET record with a sets entry, its members naming it with a coordinate in axis order", () => {
  for (const ir of [BASE.ir, NAMES.ir]) for (const g of ACCEPTED) {
    const i = recOf(ir, g), s = setOfRec(ir, i);
    if (!s || !Array.isArray(s.properties)) throw new Error(g + ": no sets entry with properties");
    const si = ir.sets.indexOf(s);
    const mem = membersOf(ir, g);
    if (!mem.length) throw new Error(g + ": no member");
    for (const k of mem) {
      const c = compOfRec(ir, k);
      if (c.set !== si) throw new Error(ir.nodes[k].guid + ": set " + c.set + ", want " + si);
      same(Object.keys(c.variant), s.axes.map((a) => a.name), ir.nodes[k].guid + " variant keys:");
      if (c.properties !== undefined) throw new Error(ir.nodes[k].guid + ": a member declares properties");
    }
    if (ir.components.filter((c) => c.set === si).length !== mem.length) throw new Error(g + ": a component names the set without being its child");
  }
  const lib = setOfRec(BASE.ir, recOf(BASE.ir, M2A.libTag)).library;
  if (!lib || lib.publishFile !== "fixturelibraryfilekey00" || lib.publishID !== "50:70" || !/^[0-9a-f]{40}$/.test(lib.componentKey)) throw new Error("Lib Tag's library identity: " + JSON.stringify(lib));
  if (setOfRec(BASE.ir, recOf(BASE.ir, M2A.chip)).library !== undefined) return false;
  return ACCEPTED.length + " sets";
});
check("a rejected group: its FRAME record carries one VARIANT_SET_REJECTED note by node, its members are standalone components", () => {
  for (const [ir, rej] of [[BASE.ir, REJECTED], [GRAMMAR.ir, REJECTED.concat([[M2A.vocab, "vocabulary"]])]]) {
    same(rejNotes(ir).length, rej.length, "notes:");
    for (const [g, cls] of rej) {
      const i = recOf(ir, g);
      const nt = rejNotes(ir).filter((x) => x.node === i);
      if (ir.nodes[i].type !== "FRAME" || nt.length !== 1 || nt[0].guid !== undefined || nt[0].path !== undefined) throw new Error(g + ": " + ir.nodes[i].type + ", " + JSON.stringify(nt));
      if (schema.noteClass(schema.CODE.VARIANT_SET_REJECTED, nt[0].detail) !== cls) throw new Error(g + ": " + nt[0].detail);
      for (const k of membersOf(ir, g)) { const c = compOfRec(ir, k); if (c.set !== null || c.variant !== undefined) throw new Error(ir.nodes[k].guid + " is not standalone"); }
    }
  }
});
check("under a pages scope the note names the group's record (the emit order the index follows)", () => {
  for (const g of [M2A.rejDupCoord, M2A.rejAxisCount + "," + M2A.chip]) {
    const r = read({ scope: "pages:" + g });
    const v = validate(r.ir);
    if (!v.ok) throw new Error(g + ": " + JSON.stringify(v.errors.slice(0, 2)));
    const nt = rejNotes(r.ir);
    same(nt.map((x) => r.ir.nodes[x.node].guid), [g.split(",")[0]], g + ":");
  }
});
check("axis and value order: Chip [State, Size] under --axis-order vocabulary, [Size, State] under names; Size [S, M, L], L appended", () => {
  const axes = (ir) => setOfRec(ir, recOf(ir, M2A.chip)).axes;
  same(axes(BASE.ir), [{ name: "State", values: ["Default", "Hover"] }, { name: "Size", values: ["S", "M", "L"] }], "vocabulary:");
  same(axes(NAMES.ir), [{ name: "Size", values: ["S", "M", "L"] }, { name: "State", values: ["Default", "Hover"] }], "names:");
  same(compOfRec(BASE.ir, recOf(BASE.ir, M2A.chipHoverS)).variant, { State: "Hover", Size: "S" });
  same(compOfRec(NAMES.ir, recOf(NAMES.ir, M2A.chipHoverS)).variant, { Size: "S", State: "Hover" });
  // Vocab's vocabulary lists Tone only: the names' order and values, nothing appended.
  same(setOfRec(BASE.ir, recOf(BASE.ir, M2A.vocab)).axes, [{ name: "Size", values: ["S", "M"] }]);
  // Button's names list both orders; its vocabulary orders [Size, State].
  same(setOfRec(BASE.ir, recOf(BASE.ir, BUTTON)).axes.map((a) => a.name), ["Size", "State"]);
});
check("stats.m2a.families, exactly, under each setting", () => {
  const rej = (o) => Object.assign({ "no-equals": 1, "duplicate-axis": 1, "axis-count": 1, "duplicate-coordinate": 1, vocabulary: 0, empty: 0, "not-symbol": 0 }, o || {});
  same(BASE.stats.m2a.families, { groups: 9, accepted: 5, rejected: rej(), rejectedMembers: 8, valuesAppended: 1, vocabularyOrder: 4, namesOrder: 1 }, "default:");
  same(NAMES.stats.m2a.families, { groups: 9, accepted: 5, rejected: rej(), rejectedMembers: 8, valuesAppended: 1, vocabularyOrder: 0, namesOrder: 5 }, "--axis-order names:");
  same(GRAMMAR.stats.m2a.families, { groups: 9, accepted: 4, rejected: rej({ vocabulary: 1 }), rejectedMembers: 10, valuesAppended: 1, vocabularyOrder: 4, namesOrder: 0 }, "--variant-grammar vocabulary:");
  for (const r of [BASE, NAMES, GRAMMAR]) {
    const F = r.stats.m2a.families;
    if (F.accepted + Object.values(F.rejected).reduce((a, b) => a + b, 0) !== F.groups || F.vocabularyOrder + F.namesOrder !== F.accepted) throw new Error("the counters do not add up");
    if (F.accepted !== r.ir.sets.length || rejNotes(r.ir).length !== F.groups - F.accepted) throw new Error("the counters disagree with the IR");
  }
});
check("two reads give the same bytes under every families setting", () => {
  for (const s of [{}, { axisOrder: "names" }, { variantGrammar: "vocabulary" }, { variantSets: "frames" }]) if (JSON.stringify(read(s).ir) !== JSON.stringify(read(s).ir)) throw new Error(JSON.stringify(s));
});

// ---------- 4. the populations ----------
check("populations: the internal sets in stateGroupsInternal, Toggle in userTop and its members in userMasters, all as under frames", () => {
  const P = BASE.stats.populations, Q = FRAMES.stats.populations;
  for (const k of Object.keys(Q)) same(P[k], Q[k], k + ":");
  same(BASE.stats.populationCounts, FRAMES.stats.populationCounts, "populationCounts:");
  for (const g of [BUTTON, M2A.chip, M2A.libTag, M2A.vocab]) if (P.stateGroupsInternal.indexOf(recOf(BASE.ir, g)) < 0) throw new Error(g + " is not in stateGroupsInternal");
  for (const [g] of REJECTED) if (P.stateGroupsInternal.indexOf(recOf(BASE.ir, g)) < 0) throw new Error(g + " (rejected) is not in stateGroupsInternal");
  if (P.userTop.indexOf(recOf(BASE.ir, M2A.toggle)) < 0) return false;
  for (const g of [M2A.toggleOff, M2A.toggleOn]) if (P.userMasters.indexOf(recOf(BASE.ir, g)) < 0) throw new Error(g + " is not in userMasters");
  return P.stateGroupsInternal.length + " internal state groups";
});
check("populations(): a COMPONENT_SET record is a state group whatever its meta says, and never a master", () => {
  const recs = [{ parent: -1, page: 0, type: "COMPONENT_SET" }, { parent: 0, type: "COMPONENT" }, { parent: -1, page: 0, type: "FRAME" }, { parent: 2, type: "COMPONENT" }];
  const meta = recs.map(() => ({ stateGroup: false, lostBorder: false }));
  const P = populations(recs, meta, [{ internal: true }]);
  same([P.stateGroupsInternal, P.mastersNoInstance, P.internalLoose], [[0], [1, 3], [2]]);
});

// ---------- 5. D13 and the validator ----------
check("D13: Toggle (auto layout) keeps its frame's props; tasks in every M1 scope equal frames' apart from the rejection notes", () => {
  const t = recOf(BASE.ir, M2A.toggle);
  same(BASE.ir.nodes[t].props, FRAMES.ir.nodes[t].props, "Toggle props:");
  if (BASE.ir.nodes[t].props.layoutMode === undefined) throw new Error("Toggle has no auto layout");
  const strip = (tasks) => tasks.map((x) => Object.assign({}, x, { notes: x.notes.filter((n) => n.code !== "VARIANT_SET_REJECTED") }));
  let toggleTasks = 0;
  for (const m1Scope of ["default", "all-masters", "all"]) {
    const a = planM1(BASE.ir, BASE.stats, { m1Scope, runId: "0123456789abcdef" }), b = planM1(FRAMES.ir, FRAMES.stats, { m1Scope, runId: "0123456789abcdef" });
    if (!a.balance.ok || !b.balance.ok) throw new Error(m1Scope + ": the balance does not add up");
    same(strip(a.tasks), strip(b.tasks), m1Scope + ":");
    for (const x of a.tasks) for (const n of x.nodes) {
      if (n.type === "COMPONENT_SET") throw new Error(m1Scope + ": a task carries a COMPONENT_SET");
      if (n.i === t) { toggleTasks++; if (n.type !== "FRAME") throw new Error("Toggle is written as " + n.type); }
    }
  }
  if (!toggleTasks) throw new Error("no task carries Toggle");
  return toggleTasks + " task records of Toggle";
});
check("the validator's coordinate checks hold on the result, and refuse a duplicate coordinate or a value its axis lacks", () => {
  for (const r of [BASE, NAMES, GRAMMAR]) { const v = validate(r.ir); if (!v.ok) throw new Error(JSON.stringify(v.errors.slice(0, 3))); }
  const mut = (f) => { const ir = JSON.parse(JSON.stringify(BASE.ir)); f(ir); return validate(ir); };
  const hover = compOfRec(BASE.ir, recOf(BASE.ir, M2A.chipHoverS)), dflt = compOfRec(BASE.ir, recOf(BASE.ir, M2A.chipS));
  const ci = BASE.ir.components.indexOf(hover);
  const dup = mut((ir) => { ir.components[ci].variant = Object.assign({}, dflt.variant); });
  if (dup.ok || !dup.errors.some((e) => /same coordinate/.test(e.message))) throw new Error("a duplicate coordinate passed: " + JSON.stringify(dup.errors.slice(0, 2)));
  const lacks = mut((ir) => { ir.components[ci].variant = { State: "Pressed", Size: "S" }; });
  if (lacks.ok || !lacks.errors.some((e) => /not a value of axis/.test(e.message))) throw new Error("a value the axis lacks passed");
});

console.log("");
console.log(failed ? failed + " M2a families check" + (failed === 1 ? "" : "s") + " FAILED" : "all M2a families checks pass");
process.exit(failed ? 1 : 0);
