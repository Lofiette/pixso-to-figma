// The resolver: which stored layer a guidPath of an instance's override or derived entry names, with
// swaps resolved (docs/M2A.md D7, §6 C). Part C owns this file; part P0 wrote it as a stub with the
// frozen contract (§5.3).
//
//   import { makeResolver } from "./resolve.mjs";
//   const R = makeResolver(cx);      // once per read, after propIndex (cx.props) and familyIndex (cx.families)
//
// THE FROZEN CONTRACT (docs/M2A.md §5.3, D7). Guids are "session:local" strings; path elements are
// LOCAL guids of the stored copies, never overrideKeys.
//   R.resolve(instanceNode, guids)
//     -> { ok: true, root, elements: [{ n, i, symbol, via }], resets, fallback, ignored }
//      | { ok: false, at, why }
//     instanceNode is the stored INSTANCE, guids its entry's guidPath as strings. root is true for a root
//     entry (guids [] or [the instance's symbolID]), which addresses the instance itself and has no
//     elements. elements[k] is path element k: n the stored node, i its IR record index (cx.indexOf, set
//     by the seam before the instance pass; undefined when the element has no record, or before the
//     pass), symbol the element's effective symbol guid when it is an INSTANCE (null for the last
//     element otherwise), via how that was decided: "override" | "property" | "declared" | "fallback".
//     resets: the guids of the nested instances whose own overrides and assignments a swap reset (rule
//     B). fallback: rule C made the path resolve. ignored: [{ instance, defId }], the swap assignments
//     rule C ignored (STALE_ASSIGNMENT "ignored"). On failure, at is the index of the element that did
//     not resolve and why a short reason.
//   R.effectiveSymbol(chain, node) -> symbol guid: the effective symbol of the nested INSTANCE `node` at
//     the end of `chain` (the instances walked so far, outermost first), by D7's order.
//   R.inDerived(instanceNode, guids) -> bool: whether the path is in the instance's derivedSymbolData.
// The resolver memoises a local-guid map per symbol, so each symbol's subtree is indexed once.
//
// Settings (cx.settings, docs/M2A.md §3): swapDangling skip | strict (rule A), swapReset on | off
// (rule B), swapFallback derived | off (rule C).
//
// STUB (part P0): the first hop only. A root entry resolves; a one-element path resolves when the guid
// is a stored descendant of the instance's declared symbol (via "declared"); a longer path does not
// (why "pending: part C"). No swap is followed. tools/test-m2a-instances.mjs fails until part C
// replaces this.
import { guidStr, guidSet } from "./util.mjs";

export const STUB = "pending: part C";

export function makeResolver(cx) {
  const descendants = new Map();   // symbol guid -> Map(local guid -> stored node)
  const subtree = (symbolGuid) => {
    if (descendants.has(symbolGuid)) return descendants.get(symbolGuid);
    const m = new Map();
    const root = cx.byGuid.get(symbolGuid);
    const walk = (n) => { for (const k of cx.childrenOf(n)) { m.set(guidStr(k.guid), k); walk(k); } };
    if (root) walk(root);
    descendants.set(symbolGuid, m);
    return m;
  };
  const declared = (n) => (n && n.symbolData && guidSet(n.symbolData.symbolID) ? guidStr(n.symbolData.symbolID) : null);
  const derivedKeys = new Map();   // instance guid -> Set(path key)
  return {
    resolve(instanceNode, guids) {
      const sym = declared(instanceNode);
      if (!sym) return { ok: false, at: 0, why: "the instance names no symbol" };
      if (guids.length === 0 || (guids.length === 1 && guids[0] === sym)) return { ok: true, root: true, elements: [], resets: [], fallback: false, ignored: [] };
      if (guids.length > 1) return { ok: false, at: 1, why: "pending: part C" };
      const n = subtree(sym).get(guids[0]);
      if (!n) return { ok: false, at: 0, why: "not a layer of the declared symbol" };
      const i = cx.indexOf ? cx.indexOf(guids[0]) : undefined;
      return { ok: true, root: false, elements: [{ n, i, symbol: cx.typeName(n) === "INSTANCE" ? declared(n) : null, via: "declared" }], resets: [], fallback: false, ignored: [] };
    },
    effectiveSymbol(chain, node) {
      return declared(node);
    },
    inDerived(instanceNode, guids) {
      const g = guidStr(instanceNode.guid);
      if (!derivedKeys.has(g)) derivedKeys.set(g, new Set((instanceNode.derivedSymbolData || []).map((d) => (d.guidPath && d.guidPath.guids ? d.guidPath.guids : []).map(guidStr).join("/"))));
      return derivedKeys.get(g).has(guids.join("/"));
    },
  };
}
