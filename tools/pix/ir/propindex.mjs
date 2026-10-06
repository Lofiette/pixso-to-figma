// The definition index: every component property definition of the file, its definition scope, its
// alias chain and its root; and the two predicates for INSTANCE_SWAP values (docs/M2A.md D3, D5, §5.3).
//
//   import { propIndex } from "./propindex.mjs";
//   const P = propIndex(cx);            // once per read, after resolveInstances (cx.componentGuids is set)
//
// Part P0 implemented this module (docs/M2A.md §5.3) because parts B and C both need alias roots and
// the swap predicates before either merges; part B owns it from then on (§9). It works on definition
// scopes and stored symbols, never on IR families, so it does not depend on which sets part A accepts.
//
// THE FROZEN CONTRACT (docs/M2A.md §5.3). Guids are "session:local" strings, as everywhere in the reader.
//   P.scopeOf(guid)          -> scope guid | null. A definition scope is a state group with its member
//                               SYMBOLs, or a SYMBOL outside any state group. A member SYMBOL's scope is
//                               its state group; a state group's and a standalone SYMBOL's is itself.
//                               Any other stored node that owns definitions is its own scope (measured:
//                               5 INSTANCE owners in the Сова UI kit, none in D, K, M or P). A guid that
//                               names no stored node gives null.
//   P.defsOf(ownerGuid)      -> [def]: the definitions stored on that node, in stored order ([] if none).
//   P.rootOf(scope, defId, from?) -> def | null: the root that defId reaches inside the scope by
//                               following parentPropDefId (0:0 is "no parent") any number of hops; null
//                               when it reaches none (see why). `from` (optional, added by P0, see below)
//                               is the symbol the id is read from: the SYMBOL enclosing a bound layer,
//                               or the master of an instance whose assignment it is.
//   P.why(scope, defId, from?) -> "root"       defId's definition in the scope is itself a root
//                               "alias"        it reaches a root in one hop or more
//                               "no-definition" defId is defined nowhere in the file
//                               "other-family" defId is defined, but only outside this scope
//                               "no-root"      its chain leaves the scope, ends in no definition, or loops
//   P.symbolKnown(guid)      -> bool: a SYMBOL is stored in the file under this guid (what rule A and the
//                               resolver follow, D5, D7)
//   P.refOf(guid)            -> master reference | null: what the IR can write for that symbol: { guid }
//                               when it is a COMPONENT record of this IR, else { library } when it is a
//                               library copy, else null (M1's masterRef, tools/pix/ir/components.mjs)
// Additions P0 made beyond the frozen five, for part B's counts:
//   P.chain(scope, defId, from?) -> { def, why, hops }: rootOf and why in one call, with the number of hops
//   P.owners                 -> [owner guid]: every stored node that owns definitions, in stored order
//
// A def is { id, owner, scope, name, type, parent, sortPosition, initialValue, preferredValues, raw }:
// id and parent (null for 0:0) as guid strings; type the enum NAME through the file's own schema
// (BOOL, TEXT, COLOR, INSTANCE_SWAP; never a number, docs/M1.md §6 A); name and sortPosition as stored
// (strings, "" and null when absent); initialValue and preferredValues as stored (Pixso's objects:
// initialValue carries all three slots, so a value is read by the root's type); raw the stored object.
//
// Which definition an id names inside a scope. Raw ids repeat across owners (REWRITE.md §3), and in
// one scope an id may sit on the scope's owner and on several members: the fixture's model, and older
// Pixso, gives every member a "same-id alias" (the set's id, unnamed, BOOL, no parent), and in M and P
// one alias id sits on members with different parents, or as a root on one member and an alias on
// another (counts in docs/M2A.md §13, P0's findings). So the definition is taken, in this order: the
// one on `from` (the symbol the id is read from); the scope owner's; one with no parent; the first in
// stored order. A parent is looked up the same way, from the owner of the definition that names it.
// So a same-id alias names the set's root ("root"), a member-owned root, whose id collides with
// nothing (docs/M2A.md §1.2), is found on its member, and a repeated alias id follows its own member's
// parent. Without `from`, a repeated alias id takes the first member's.
import { guidStr, guidSet } from "./util.mjs";
import { libraryOf } from "./components.mjs";

// A chain longer than this is a loop or a fault; measured chains are one or two hops (§1.2).
export const MAX_HOPS = 64;
export const WHY = ["root", "alias", "no-definition", "other-family", "no-root"];

export function propIndex(cx) {
  const byGuid = cx.byGuid;
  const typeName = cx.typeName;
  const defType = cx.en("ComponentPropDef", "type");
  const parentOf = (n) => (n && n.parentIndex ? byGuid.get(guidStr(n.parentIndex.guid)) || null : null);
  const isStateGroup = (n) => !!n && typeName(n) === "FRAME" && !!n.isStateGroup;

  const scopeOfNode = (n) => {
    if (!n) return null;
    if (typeName(n) === "SYMBOL") { const p = parentOf(n); return isStateGroup(p) ? guidStr(p.guid) : guidStr(n.guid); }
    return guidStr(n.guid);
  };

  const owners = [];
  const defsByOwner = new Map();   // owner guid -> [def]
  const byScope = new Map();       // scope guid -> Map(id -> [def])
  const scopesOfId = new Map();    // id -> Set(scope guid)
  for (const n of cx.pix.nodes) {
    const list = n.componentPropDef;
    if (!Array.isArray(list) || !list.length) continue;
    const owner = guidStr(n.guid);
    const scope = scopeOfNode(n);
    const defs = [];
    for (const raw of list) {
      if (!raw || !guidSet(raw.id)) continue;
      const d = {
        id: guidStr(raw.id), owner, scope,
        name: typeof raw.name === "string" ? raw.name : "",
        type: defType(raw.type) || null,
        parent: guidSet(raw.parentPropDefId) ? guidStr(raw.parentPropDefId) : null,
        sortPosition: typeof raw.sortPosition === "string" ? raw.sortPosition : null,
        initialValue: raw.initialValue || null,
        preferredValues: raw.preferredValues || null,
        raw,
      };
      defs.push(d);
      if (!byScope.has(scope)) byScope.set(scope, new Map());
      const m = byScope.get(scope);
      if (!m.has(d.id)) m.set(d.id, []);
      m.get(d.id).push(d);
      if (!scopesOfId.has(d.id)) scopesOfId.set(d.id, new Set());
      scopesOfId.get(d.id).add(scope);
    }
    owners.push(owner);
    defsByOwner.set(owner, defs);
  }

  // The definition an id names inside a scope, read from `from` (the comment at the top says which, and why).
  const pick = (scope, id, from) => {
    const m = byScope.get(scope);
    const list = m ? m.get(id) : null;
    if (!list || !list.length) return null;
    return (from && list.find((d) => d.owner === from)) || list.find((d) => d.owner === scope) || list.find((d) => d.parent === null) || list[0];
  };

  const memo = new Map();
  const chain = (scope, id, from) => {
    const key = scope + "|" + id + "|" + (from || "");
    if (memo.has(key)) return memo.get(key);
    let out;
    let d = scope ? pick(scope, id, from) : null;
    if (!d) out = { def: null, why: scopesOfId.has(id) ? "other-family" : "no-definition", hops: 0 };
    else {
      const seen = new Set([d.id]);
      let hops = 0;
      while (d && d.parent !== null) {
        const p = pick(scope, d.parent, d.owner);
        if (!p || seen.has(p.id) || hops >= MAX_HOPS) { d = null; break; }
        seen.add(p.id);
        d = p;
        hops++;
      }
      out = d ? { def: d, why: hops ? "alias" : "root", hops } : { def: null, why: "no-root", hops };
    }
    memo.set(key, out);
    return out;
  };

  const symbolKnown = (guid) => {
    const n = typeof guid === "string" ? byGuid.get(guid) : null;
    return !!n && typeName(n) === "SYMBOL";
  };

  return {
    owners,
    scopeOf(guid) { return scopeOfNode(byGuid.get(guid)); },
    defsOf(owner) { return defsByOwner.get(owner) || []; },
    rootOf(scope, id, from) { return chain(scope, id, from).def; },
    why(scope, id, from) { return chain(scope, id, from).why; },
    chain,
    symbolKnown,
    refOf(guid) {
      if (!symbolKnown(guid)) return null;
      if (cx.componentGuids && cx.componentGuids.has(guid)) return { guid };
      const lib = libraryOf(byGuid.get(guid));
      return lib ? { library: lib } : null;
    },
  };
}
