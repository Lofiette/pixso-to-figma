// Properties: each family's root definitions, the layers bound to them, and the assignments instances
// make (docs/M2A.md D3-D6, §6 B). Part B owns this file (and propindex.mjs after P0).
//
//   import { propertiesOf, bindingsOf, assignments } from "./properties.mjs";
//
// THE FROZEN CONTRACT (docs/M2A.md §5.3). Guids are "session:local" strings. The definition index is
// cx.props (propindex.mjs), the family index cx.families (families.mjs). An id is resolved with the
// symbol it is read from (cx.props.chain(scope, id, from): the layer's enclosing SYMBOL, or the
// instance's master), because one alias id may sit on several members with different parents.
//   propertiesOf(cx, familyGuid) -> [definition]
//       The family's declared roots as IR property definitions ({ id, name, type, default,
//       preferredValues? }, docs/IR.md §8), in sortPosition order, then by id. familyGuid is a set's
//       group guid or a standalone component's symbol guid (cx.families.familyOf). The seam writes the
//       result on the set (components.mjs setEntry) or, when it is not empty, on the standalone
//       component (componentEntry); a member of an accepted set declares none.
//   bindingsOf(cx, n, i) -> componentPropertyReferences | null
//       The stored node n (IR record i): its componentPropRef entries as { characters | visible |
//       mainComponent: root id } of the enclosing definition's family, or null when none is carried. The
//       seam writes the result as the record's props.componentPropertyReferences. Dropped bindings are
//       noted PROPERTY_REF_DROPPED (one note per record and class, cx.note while cx.at is the record).
//   assignments(cx, symbolGuid, raw[], { nested, ignored: Set(defId) })
//       -> { kept: [{ family, id, value }], dropped: [{ code, class, defId }] }
//       Sorts Pixso's componentPropAssignment entries `raw` made to an instance whose (effective) master
//       is symbolGuid: every raw assignment ends in exactly one of kept and dropped (D6's classes, in
//       D6's order). nested: the entry is a live override entry, judged against the effective family of
//       the nested instance it targets (STALE_ASSIGNMENT "nested: <class>"). ignored: the defIds rule C
//       ignored (STALE_ASSIGNMENT "ignored"). Part C calls it for every instance and every live entry
//       and writes the notes with the instance's node and the entry's path.
// Part B fills cx.m2a.properties:
//   { roots, liftedMemberRoots, copiedRoots, aliases, viaAlias, unnamedRoots, declaredNotRoot,
//     bindings: { total, kept, dropped: { class: n } }, swapDefaultFromLayer,
//     swapDefaultLayersDisagree: { roots, layers }, boundLayerDiffers: { text, visible },
//     swapDangling: { assignment, default, swap }, preferred: { inFile, byKeyOnly, stringValuesDropped },
//     assignments: { total, kept, droppedWithEntry, merged, dangling, defaultDropped, richTextFlattened,
//                    stale: { class: n } } }
//
// Settings (cx.settings, docs/M2A.md §3): swapDefault layer | definition, rejectedProps copy | none,
// defaultAssignments keep | drop.
//
// WHAT PART B DECIDED within the contract (docs/M2A.md D3-D6):
//   - A family's declared roots (D3). An accepted set (cx.families.accepted): the roots on the state
//     group, then each member's member-owned roots (a definition with no parent whose id the group does
//     not define; the first member's when two members define one id), lifted. A SYMBOL of a state
//     group that is not an accepted set (a rejected one, or any under --variant-sets frames, whose
//     members are standalone too): the group's roots copied onto it with their ids (--rejected-props
//     copy), then its own member-owned roots. A SYMBOL outside any state group: its own roots. Any other guid: none. Type,
//     name, default and preferred values come from the root alone. A COLOR root (or one of a type with
//     no Figma equivalent) is not declared: SOURCE_FEATURE_UNSUPPORTED "COLOR property" on the family's
//     record. An INSTANCE_SWAP root with no default the IR can reference is not declared:
//     SWAP_VALUE_DANGLING "default" (or "default: not carried") on the family's record, counted in
//     swapDangling.default. `roots` counts the definitions written, copies and lifted ones included;
//     liftedMemberRoots and copiedRoots the roots lifted or copied, declared or not (so lifted is
//     docs/M2A.md §1.2's 120 / 120 / 6 / 24 member-owned roots); declaredNotRoot the written
//     definitions that are not the root of their scope read from their owner (gate G5); unnamedRoots
//     those whose name is empty.
//   - INSTANCE_SWAP defaults (D5). A root's bound layers in a family are the stored INSTANCE layers
//     whose OVERRIDDEN_SYMBOL_ID binding, read from their enclosing SYMBOL, reaches that root, inside
//     the family's own symbols (a set's members; a standalone or rejected member itself; for a root
//     copied onto a member that binds it nowhere, the whole group's). Under
//     --swap-default layer the candidates are their declared symbol where they all agree, then the
//     initialValue; under definition the other way round. The first candidate that names a stored
//     SYMBOL is the default; when the IR cannot reference it (refOf null) the root is not declared
//     ("default: not carried"). swapDefaultFromLayer counts declared defaults taken from the layers that
//     differ from the initialValue's symbol; swapDefaultLayersDisagree the declared roots whose bound
//     layers disagree, with the bound layers whose symbol is not the default.
//   - Preferred values (D5). Each instanceSwapValues key becomes { type, componentKey, guid? }: Pixso's
//     STATE_GROUP is COMPONENT_SET, anything else COMPONENT; guid is the first stored SYMBOL with that
//     componentKey that is a COMPONENT record of this IR, or (COMPONENT_SET) the first accepted, carried
//     state group with it (preferred.inFile); otherwise the key alone (byKeyOnly). A key that is not
//     40 lowercase hex cannot be written: SOURCE_FEATURE_UNSUPPORTED "preferred value with no component
//     key" (0 in the five files). A TEXT root's stringValues are dropped and counted per definition
//     written.
//   - Bindings (D4). The enclosing definition is the nearest SYMBOL at or above the layer, its family
//     cx.families.familyOf(that symbol); the first class that applies, in D4's order. A field the
//     layer's own type cannot take (TEXT_DATA on a non-TEXT layer, OVERRIDDEN_SYMBOL_ID on a
//     non-INSTANCE), and a second binding of one field on a layer, are type-mismatch too, the note's
//     detail saying so (0 of each in the five files). A root is declared when the family declares that
//     very definition (by identity, not by id alone). viaAlias counts the bindings whose id reaches a
//     root through an alias (docs/M2A.md §1.2's "refs resolved through an alias id"), kept or not;
//     aliases counts the definitions with a parent in the file. boundLayerDiffers counts the kept TEXT
//     and BOOLEAN bindings whose layer's own characters or visibility differs from the root's default.
//   - Assignments (D6), the first class that applies: STALE_ASSIGNMENT (no-definition: the id is
//     defined nowhere in the file; other-family: it is defined, but neither on the master symbol nor on
//     that symbol's state group, which is docs/M2A.md §0.2's "reached from the instance's family" and
//     gives REWRITE's 130 / 2 034; no-root: its chain, read from the master, reaches no root in the
//     scope; undeclared: a root the family does not declare; under `nested` the class is "nested", the inner class after ": ");
//     STALE_ASSIGNMENT "ignored" (a defId in opts.ignored); SWAP_VALUE_DANGLING "assignment" (an
//     INSTANCE_SWAP value naming no stored SYMBOL; ": not carried" when the IR cannot reference it);
//     merged away (two assignments of one list reaching one root: the later wins); equal to the
//     default under --default-assignments drop (defaultDropped); kept, by root id, the value read from
//     the slot of the root's type. A TEXT value whose style table is not empty keeps its characters
//     (richTextFlattened).
//   - The two classes part C decides go through the same call, so every assignment is counted exactly
//     once in assignments.total: opts.drop "entry" for the assignments of a stale entry
//     (droppedWithEntry), "merged" for those a duplicate path's merge (D17) or a root entry's value
//     lost (merged). They come back in `dropped`.
//   A dropped item is { code, class, defId, detail }: code STALE_ASSIGNMENT, SWAP_VALUE_DANGLING, or
//   null for a class with no note of its own (class "with-entry", "merged", "default"); class the note
//   class (schema NOTE_CLASSES); detail the note's whole detail as part C writes it ("nested:
//   other-family", "assignment: not carried").
import { CODE, canonicalJSON } from "../../ir/schema.mjs";
import { guidStr, guidSet } from "./util.mjs";

const TYPE = { BOOL: "BOOLEAN", TEXT: "TEXT", INSTANCE_SWAP: "INSTANCE_SWAP" };
const FIELD = { VISIBLE: { key: "visible", type: "BOOLEAN" }, TEXT_DATA: { key: "characters", type: "TEXT" },
  OVERRIDDEN_SYMBOL_ID: { key: "mainComponent", type: "INSTANCE_SWAP" } };
export const BINDING_CLASSES = ["fill-style", "outside-definition", "no-definition", "other-family", "no-root", "undeclared", "type-mismatch"];
const HEX40 = /^[0-9a-f]{40}$/;

// Definition ids in order: session, then local, as numbers.
const idCmp = (a, b) => {
  const [as, al] = a.split(":").map(Number), [bs, bl] = b.split(":").map(Number);
  return as - bs || al - bl;
};
// sortPosition order (as stored strings; a definition without one last), then by id.
const declCmp = (a, b) => {
  const x = a.def.sortPosition, y = b.def.sortPosition;
  if (x !== y) {
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -1 : 1;
  }
  return idCmp(a.id, b.id);
};
// The symbol a property value names, or null.
const valueGuid = (v) => (v && guidSet(v.guidValue) ? guidStr(v.guidValue) : null);

// Part B's per-read state, on cx, built on first use.
function state(cx) {
  if (cx.propState) return cx.propState;
  const P = cx.props, byGuid = cx.byGuid, typeName = cx.typeName;
  const field = cx.en("ComponentPropRef", "componentPropNodeField");
  const prefType = cx.en("InstanceSwapPreferredValue", "type");
  const parentOf = (n) => (n && n.parentIndex ? byGuid.get(guidStr(n.parentIndex.guid)) || null : null);
  const isStateGroup = (n) => !!n && typeName(n) === "FRAME" && !!n.isStateGroup;
  // The nearest SYMBOL at or above a node, memoised per node.
  const encl = new Map();
  const enclosing = (n) => {
    if (!n) return null;
    const g = guidStr(n.guid);
    if (encl.has(g)) return encl.get(g);
    const s = typeName(n) === "SYMBOL" ? n : enclosing(parentOf(n));
    encl.set(g, s);
    return s;
  };
  const declaredSymbol = (n) => (n && n.symbolData && guidSet(n.symbolData.symbolID) ? guidStr(n.symbolData.symbolID) : null);

  let aliases = 0;
  for (const owner of P.owners) for (const d of P.defsOf(owner)) if (d.parent !== null) aliases++;
  // The instance layers bound to each root: root definition -> Map(enclosing symbol -> [declared symbol]) (D5).
  const bound = new Map();
  for (const n of cx.pix.nodes) {
    if (!Array.isArray(n.componentPropRef) || typeName(n) !== "INSTANCE") continue;
    for (const r of n.componentPropRef) {
      if (!r || field(r.componentPropNodeField) !== "OVERRIDDEN_SYMBOL_ID" || !guidSet(r.defID)) continue;
      const s = enclosing(n);
      if (!s) continue;
      const sg = guidStr(s.guid);
      const root = P.rootOf(P.scopeOf(sg), guidStr(r.defID), sg);
      if (!root) continue;
      if (!bound.has(root)) bound.set(root, new Map());
      const m = bound.get(root);
      if (!m.has(sg)) m.set(sg, []);
      m.get(sg).push(declaredSymbol(n));
    }
  }

  // Preferred values name components by key: the copies that are records of this IR (D5).
  let keys = null;
  const keyIndex = () => {
    if (keys) return keys;
    keys = { COMPONENT: new Map(), COMPONENT_SET: new Map() };
    for (const n of cx.pix.nodes) {
      if (typeof n.componentKey !== "string" || !HEX40.test(n.componentKey)) continue;
      const g = guidStr(n.guid);
      if (typeName(n) === "SYMBOL" && cx.componentGuids.has(g)) { if (!keys.COMPONENT.has(n.componentKey)) keys.COMPONENT.set(n.componentKey, g); }
      else if (isStateGroup(n) && cx.families && cx.families.accepted.has(g)) {   // accepted: carried with its members
        if (!keys.COMPONENT_SET.has(n.componentKey)) keys.COMPONENT_SET.set(n.componentKey, g);
      }
    }
    return keys;
  };

  cx.propState = { P, field, prefType, parentOf, isStateGroup, enclosing, bound, keyIndex, families: new Map() };
  cx.m2a.properties.aliases = aliases;
  return cx.propState;
}

// The roots a family declares before they are checked, and the symbols whose layers make it up (D3).
function familyRoots(cx, S, familyGuid) {
  const { P, isStateGroup, parentOf } = S;
  const node = cx.byGuid.get(familyGuid);
  const roots = [], symbols = [];   // roots: { def, copied, lifted }
  if (!node) return { roots, symbols };
  const idsOn = (owner) => new Set(P.defsOf(owner).map((d) => d.id));
  const rootsOn = (owner, except) => P.defsOf(owner).filter((d) => d.parent === null && !(except && except.has(d.id)));
  if (isStateGroup(node) && cx.families && cx.families.accepted.has(familyGuid)) {
    const groupIds = idsOn(familyGuid);
    const seen = new Set();
    for (const d of rootsOn(familyGuid)) if (!seen.has(d.id)) { seen.add(d.id); roots.push({ def: d, copied: false, lifted: false }); }
    for (const k of cx.childrenOf(node)) {
      if (cx.typeName(k) !== "SYMBOL") continue;
      const kg = guidStr(k.guid);
      symbols.push(kg);
      for (const d of rootsOn(kg, groupIds)) if (!seen.has(d.id)) { seen.add(d.id); roots.push({ def: d, copied: false, lifted: true }); }
    }
    return { roots, symbols };
  }
  if (cx.typeName(node) !== "SYMBOL") return { roots, symbols };
  symbols.push(familyGuid);
  const group = parentOf(node);
  const seen = new Set();
  let except = null;
  if (isStateGroup(group)) {
    const gg = guidStr(group.guid);
    except = idsOn(gg);
    if (cx.settings.rejectedProps === "copy") for (const d of rootsOn(gg)) if (!seen.has(d.id)) { seen.add(d.id); roots.push({ def: d, copied: true, lifted: false }); }
  }
  for (const d of rootsOn(familyGuid, except)) if (!seen.has(d.id)) { seen.add(d.id); roots.push({ def: d, copied: false, lifted: false }); }
  return { roots, symbols };
}

// A family with no roots at all (most standalone components): one shared, empty answer.
const NO_ROOTS = { list: [], byId: new Map(), undeclared: [], written: true, lifted: 0, copied: 0 };

// A family's declarations, once per read: { list: [decl], byId: Map(id -> decl), undeclared: [{ def, why, detail }] }.
// A decl is { id, def, copied, lifted, ir: { id, name, type, default }, swapValues, fromLayer, disagree }.
function declarations(cx, familyGuid) {
  const S = state(cx);
  if (S.families.has(familyGuid)) return S.families.get(familyGuid);
  const P = S.P;
  const { roots, symbols } = familyRoots(cx, S, familyGuid);
  if (!roots.length) { S.families.set(familyGuid, NO_ROOTS); return NO_ROOTS; }
  const own = new Set(symbols);
  const list = [], undeclared = [];
  for (const r of roots) {
    const d = r.def;
    const type = TYPE[d.type];
    if (!type) { undeclared.push({ def: d, why: "type", detail: d.type === "COLOR" ? "COLOR property" : "property type " + (d.type || "unknown") }); continue; }
    const ir = { id: d.id, name: d.name, type };
    const iv = d.initialValue || {};
    let fromLayer = false, disagree = null, swapValues = null;
    if (type === "BOOLEAN") ir.default = !!iv.boolValue;
    else if (type === "TEXT") ir.default = iv.textValue && typeof iv.textValue.characters === "string" ? iv.textValue.characters : "";
    else {
      const layers = [];
      const m = S.bound.get(d);
      if (m) for (const [sg, syms] of m) if (own.has(sg)) layers.push(...syms);
      // A root copied onto a member none of whose layers it binds: the layers of the whole group.
      if (m && !layers.length && r.copied) for (const syms of m.values()) layers.push(...syms);
      const agree = layers.length > 0 && layers.every((x) => x === layers[0]);
      const agreed = agree ? layers[0] : null;
      const initial = valueGuid(iv);
      const order = cx.settings.swapDefault === "definition" ? [[initial, false], [agreed, true]] : [[agreed, true], [initial, false]];
      const pick = order.find(([g]) => g && P.symbolKnown(g));
      if (!pick) { undeclared.push({ def: d, why: "default", detail: "default" }); continue; }
      const ref = P.refOf(pick[0]);
      if (!ref) { undeclared.push({ def: d, why: "default", detail: "default: not carried" }); continue; }
      ir.default = ref;
      fromLayer = pick[1] && pick[0] !== initial;
      if (layers.length && !agree) disagree = { layers: layers.filter((x) => x !== pick[0]).length };
      const pv = d.preferredValues && Array.isArray(d.preferredValues.instanceSwapValues) ? d.preferredValues.instanceSwapValues : [];
      if (pv.length) swapValues = pv;
    }
    list.push({ id: d.id, def: d, copied: r.copied, lifted: r.lifted, ir, swapValues, fromLayer, disagree });
  }
  list.sort(declCmp);
  const out = { list, byId: new Map(list.map((x) => [x.id, x])), undeclared, written: false,
    lifted: roots.filter((r) => r.lifted).length, copied: roots.filter((r) => r.copied).length };
  S.families.set(familyGuid, out);
  return out;
}

export function propertiesOf(cx, familyGuid) {
  const S = state(cx);
  const D = declarations(cx, familyGuid);
  if (D === NO_ROOTS) return [];
  const st = cx.m2a.properties;
  const first = !D.written;   // counted and noted once per family, on its record
  D.written = true;
  const out = [];
  for (const x of D.list) {
    const o = { id: x.ir.id, name: x.ir.name, type: x.ir.type, default: x.ir.default };
    if (x.swapValues) {
      const keys = S.keyIndex();
      const pv = [];
      for (const v of x.swapValues) {
        if (!v || typeof v.key !== "string" || !HEX40.test(v.key)) { if (first) cx.feature("preferred value with no component key"); continue; }
        const type = S.prefType(v.type) === "STATE_GROUP" ? "COMPONENT_SET" : "COMPONENT";
        const r = { type, componentKey: v.key };
        const g = keys[type].get(v.key);
        if (g) r.guid = g;
        if (first) { if (g) st.preferred.inFile++; else st.preferred.byKeyOnly++; }
        pv.push(r);
      }
      if (pv.length) o.preferredValues = pv;
    }
    out.push(o);
    if (!first) continue;
    st.roots++;
    if (x.def.name === "") st.unnamedRoots++;
    const c = cx.props.chain(x.def.scope, x.id, x.def.owner);
    if (c.why !== "root" || c.def !== x.def) st.declaredNotRoot++;
    if (x.fromLayer) st.swapDefaultFromLayer++;
    if (x.disagree) { st.swapDefaultLayersDisagree.roots++; st.swapDefaultLayersDisagree.layers += x.disagree.layers; }
    const sv = x.def.preferredValues && Array.isArray(x.def.preferredValues.stringValues) ? x.def.preferredValues.stringValues : [];
    if (x.ir.type === "TEXT") st.preferred.stringValuesDropped += sv.length;
  }
  if (first) { st.liftedMemberRoots += D.lifted; st.copiedRoots += D.copied; }
  if (first) for (const u of D.undeclared) {
    if (u.why === "type") cx.feature(u.detail);
    else { st.swapDangling.default++; cx.note(CODE.SWAP_VALUE_DANGLING, u.detail + ": " + (u.def.name || u.def.id)); }
  }
  return out;
}

// One binding: { cls, why? } when it is dropped, { key, id, decl } when it is kept (D4); viaAlias either way.
function bindingOf(cx, S, n, r, sym, scope, F) {
  const f = S.field(r.componentPropNodeField);
  if (f === "INHERIT_FILL_STYLE_ID") return { cls: "fill-style" };
  if (!sym) return { cls: "outside-definition" };
  const c = cx.props.chain(scope, guidSet(r.defID) ? guidStr(r.defID) : "0:0", sym);
  const viaAlias = c.why === "alias";
  if (!c.def) return { cls: c.why, viaAlias };
  const decl = declarations(cx, F).byId.get(c.def.id);
  if (!decl || decl.def !== c.def) return { cls: "undeclared", viaAlias };
  const want = FIELD[f];
  if (!want) return { cls: "type-mismatch", viaAlias, why: "field " + (f || "unknown") };
  if (decl.ir.type !== want.type) return { cls: "type-mismatch", viaAlias, why: f + " bound to a " + decl.ir.type + " property" };
  const t = cx.typeName(n);
  if ((want.key === "characters" && t !== "TEXT") || (want.key === "mainComponent" && t !== "INSTANCE")) return { cls: "type-mismatch", viaAlias, why: f + " on a " + t };
  return { key: want.key, id: c.def.id, decl, viaAlias };
}

export function bindingsOf(cx, n, i) {
  const refs = n.componentPropRef;
  if (!Array.isArray(refs) || !refs.length) return null;
  const S = state(cx);
  const st = cx.m2a.properties;
  const symNode = S.enclosing(n);
  const sym = symNode ? guidStr(symNode.guid) : null;
  const scope = sym ? cx.props.scopeOf(sym) : null;
  const F = sym ? (cx.families ? cx.families.familyOf(sym) : sym) : null;
  const out = {};
  const dropped = new Map();   // class -> { n, why: Set }
  const drop = (cls, why) => {
    st.bindings.dropped[cls]++;
    if (!dropped.has(cls)) dropped.set(cls, { n: 0, why: new Set() });
    const d = dropped.get(cls);
    d.n++;
    if (why) d.why.add(why);
  };
  for (const r of refs) {
    if (!r) continue;
    st.bindings.total++;
    const b = bindingOf(cx, S, n, r, sym, scope, F);
    if (b.viaAlias) st.viaAlias++;
    if (b.cls) { drop(b.cls, b.why); continue; }
    if (Object.prototype.hasOwnProperty.call(out, b.key)) { drop("type-mismatch", "a second " + b.key + " binding on the layer"); continue; }
    out[b.key] = b.id;
    st.bindings.kept++;
    const def = b.decl.ir.default;
    if (b.key === "characters") {
      const own = n.textData && typeof n.textData.characters === "string" ? n.textData.characters : "";
      if (own !== def) st.boundLayerDiffers.text++;
    } else if (b.key === "visible" && (n.visible !== false) !== def) st.boundLayerDiffers.visible++;
  }
  for (const cls of BINDING_CLASSES) {
    const d = dropped.get(cls);
    if (d) cx.note(CODE.PROPERTY_REF_DROPPED, cls + ": " + d.n + (d.why.size ? " (" + [...d.why].sort().join("; ") + ")" : ""));
  }
  return Object.keys(out).length ? out : null;
}

// A raw assignment's value, read from the slot of the root's type; INSTANCE_SWAP gives the symbol it names.
function valueOf(type, v, st) {
  v = v || {};
  if (type === "BOOLEAN") return { value: !!v.boolValue };
  if (type === "TEXT") {
    const t = v.textValue || {};
    if (Array.isArray(t.styleOverrideTable) && t.styleOverrideTable.length) st.assignments.richTextFlattened++;
    return { value: typeof t.characters === "string" ? t.characters : "" };
  }
  return { symbol: valueGuid(v) };
}

// The declared root (its IR definition) that the id names, read from symbolGuid as a binding in that
// symbol is (bindingOf, by identity), or null when the family declares none: what M2b can bind.
export function declaredRoot(cx, symbolGuid, id) {
  if (!symbolGuid || !id) return null;
  state(cx);
  const P = cx.props, scope = P.scopeOf(symbolGuid);
  const c = scope ? P.chain(scope, id, symbolGuid) : null;
  if (!c || !c.def) return null;
  const decl = declarations(cx, cx.families ? cx.families.familyOf(symbolGuid) : symbolGuid).byId.get(c.def.id);
  return decl && decl.def === c.def ? decl.ir : null;
}

// Whether assignments(cx, symbolGuid, [a]) would keep the raw assignment a (ignored and merged apart):
// its id defined on the master symbol or its state group, reaching a root the family declares, and,
// for an INSTANCE_SWAP root, a value the IR can reference. No counter moves. overrides.mjs asks it
// for the swap assignment that decided a hop (D7 rule 2, which reads the whole definition scope).
export function keeps(cx, symbolGuid, a) {
  if (!a || !guidSet(a.defID) || !symbolGuid) return false;
  state(cx);
  const P = cx.props, scope = P.scopeOf(symbolGuid), id = guidStr(a.defID);
  if (!scope || !(P.defsOf(symbolGuid).some((d) => d.id === id) || P.defsOf(scope).some((d) => d.id === id))) return false;
  const c = P.chain(scope, id, symbolGuid);
  if (!c.def) return false;
  const decl = declarations(cx, cx.families ? cx.families.familyOf(symbolGuid) : symbolGuid).byId.get(c.def.id);
  if (!decl || decl.def !== c.def) return false;
  if (decl.ir.type !== "INSTANCE_SWAP") return true;
  const g = valueGuid(a.value);
  return !!g && !!P.refOf(g);
}

export function assignments(cx, symbolGuid, raw, opts) {
  const o = opts || {};
  const st = cx.m2a.properties;
  const A = st.assignments;
  const list = Array.isArray(raw) ? raw.filter((a) => !!a) : [];
  const kept = [], dropped = [];
  const defIdOf = (a) => (guidSet(a.defID) ? guidStr(a.defID) : "0:0");
  if (o.drop !== undefined && o.drop !== "entry" && o.drop !== "merged") throw new Error("assignments: drop is \"entry\" or \"merged\"; got " + JSON.stringify(o.drop));
  A.total += list.length;
  if (o.drop) {
    for (const a of list) {
      if (o.drop === "entry") A.droppedWithEntry++; else A.merged++;
      dropped.push({ code: null, class: o.drop === "entry" ? "with-entry" : "merged", defId: defIdOf(a), detail: null });
    }
    return { kept, dropped };
  }
  state(cx);
  const P = cx.props;
  const scope = symbolGuid ? P.scopeOf(symbolGuid) : null;
  const F = symbolGuid ? (cx.families ? cx.families.familyOf(symbolGuid) : symbolGuid) : null;
  const D = F ? declarations(cx, F) : { byId: new Map() };
  const ignored = o.ignored instanceof Set ? o.ignored : new Set(o.ignored || []);
  const stale = (defId, cls) => {
    const c = o.nested ? "nested" : cls;
    A.stale[c]++;
    dropped.push({ code: CODE.STALE_ASSIGNMENT, class: c, defId, detail: o.nested ? "nested: " + cls : cls });
  };
  // The ids the instance's family can reach: those on its master symbol and on that symbol's state group
  // (docs/M2A.md §0.2), not those another member of the group defines.
  const reach = new Set();
  if (symbolGuid) for (const owner of new Set([symbolGuid, scope])) for (const d of P.defsOf(owner)) reach.add(d.id);
  const reached = [];   // { defId, decl, value }, in raw order
  for (const a of list) {
    const defId = defIdOf(a);
    const c = reach.has(defId) ? P.chain(scope, defId, symbolGuid) : { def: null, why: P.why(null, defId) === "no-definition" ? "no-definition" : "other-family" };
    if (!c.def) { stale(defId, c.why); continue; }
    const decl = D.byId.get(c.def.id);
    if (!decl || decl.def !== c.def) { stale(defId, "undeclared"); continue; }
    if (ignored.has(defId)) { A.stale.ignored++; dropped.push({ code: CODE.STALE_ASSIGNMENT, class: "ignored", defId, detail: "ignored" }); continue; }
    const v = valueOf(decl.ir.type, a.value, st);
    if (decl.ir.type === "INSTANCE_SWAP") {
      const ref = v.symbol ? P.refOf(v.symbol) : null;
      if (!ref) {
        A.dangling++;
        st.swapDangling.assignment++;
        dropped.push({ code: CODE.SWAP_VALUE_DANGLING, class: "assignment", defId, detail: v.symbol && P.symbolKnown(v.symbol) ? "assignment: not carried" : "assignment" });
        continue;
      }
      v.value = ref;
    }
    reached.push({ defId, decl, value: v.value });
  }
  // Two assignments reaching one root: the later wins (D6, merged away).
  const last = new Map();
  reached.forEach((x, k) => last.set(x.decl.id, k));
  reached.forEach((x, k) => {
    if (last.get(x.decl.id) !== k) { A.merged++; dropped.push({ code: null, class: "merged", defId: x.defId, detail: null }); return; }
    if (cx.settings.defaultAssignments === "drop" && canonicalJSON(x.value) === canonicalJSON(x.decl.ir.default)) {
      A.defaultDropped++;
      dropped.push({ code: null, class: "default", defId: x.defId, detail: null });
      return;
    }
    A.kept++;
    kept.push({ family: F, id: x.decl.id, value: x.value });
  });
  return { kept, dropped };
}
