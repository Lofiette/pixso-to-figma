// The resolver: which stored layer a guidPath of an instance's override or derived entry names, with
// swaps resolved (docs/M2A.md D7, §6 C). Part C owns this file.
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
//   (D7 rule 2 matches an assignment by raw id or by alias root: cx.props.rootOf(scope, id, from), from
//   the symbol the node sits in, so an alias id repeated on members with other parents is read right.)
//   R.effectiveSymbol(chain, node) -> symbol guid: the effective symbol of the nested INSTANCE `node` at
//     the end of `chain` (the instances walked so far, outermost first), by D7's order.
//   R.inDerived(instanceNode, guids) -> bool: whether the path is in the instance's derivedSymbolData.
// The resolver memoises a local-guid map per symbol, so each symbol's subtree is indexed once.
//
// What part C added beyond the frozen keys (each an extra key, so the contract's readers are unaffected):
//   on a success: holders, the instances whose own entries can address the target, outermost first:
//     [{ n, g, start, reset, symbol }] (n the stored instance, g its guid, start the index of the first
//     path element inside it, reset whether rule B reset its own overrides, symbol its effective symbol;
//     holders[0] is the instance itself); each element also carries reset (an INSTANCE element's own
//     overrides were reset) and src (where a swap came from: { instance, path, defId? }).
//   ignored items carry path too: the entry of `instance` (relative to it) that holds the assignment,
//     or null for the instance's own componentPropAssignment; target, the guid of the hop rule C forced;
//     and hop, the path of that hop relative to the instance resolved (overrides.mjs pins it when the
//     assignment sits on another instance, inside a master).
//   R.entriesOf(node) -> Map(path key -> [entry]): a stored instance's own symbolOverrides by guidPath
//     ("/"-joined local guids, "" for the empty path), memoised.
//   R.subtree(symbolGuid) -> Map(local guid -> stored node); R.declared(node) -> symbol guid | null;
//   R.pathKey(guids) -> the key entriesOf uses; R.pathGuids(entry) -> an entry's guidPath as strings;
//   R.rootEntries(node) -> an instance's own root entries; R.poolsFor(guids, k, holders) -> the
//     assignment pools of rule 2 for element k (the effective value of a bound field reads them too).
//
// D7, as implemented. The walk starts at the instance's declared symbol; element k is looked up by local
// guid among the stored descendants of the current symbol; every element but the last must be a nested
// INSTANCE, whose effective symbol is, in this order:
//   1. an overriddenSymbolID on an entry of any instance of the chain (holders) whose path, relative to
//      that instance, is this element's; the OUTERMOST holder wins (within one holder, the entry the
//      duplicate merge keeps, --override-merge: so the walk and the IR's swap agree);
//   2. for each componentPropRef of the element with field OVERRIDDEN_SYMBOL_ID and a defID other than
//      0:0, an assignment to that definition, matched by raw id or by alias root inside the definition
//      scope of the symbol the element sits in, from these pools in order: the outer holders' entries
//      addressed to the owning instance (the holder the element sits in), innermost holder first; that
//      instance's own root entries; its own componentPropAssignment. Within a pool its last matching
//      assignment counts. Rule A (--swap-dangling skip): a value naming no SYMBOL in the file is
//      skipped and the next pool is used (0:0 names none and is always skipped);
//   3. the element's declared symbolID.
// Rule B (--swap-reset on): an instance swapped by 1 or 2, even to its own declared symbol, loses its
// own entries and its own componentPropAssignment for everything below it.
// Rule C (--swap-fallback derived): when the walk fails at element k and the path is in
// derivedSymbolData, and element k-1's symbol was decided by a property (rule 2), the walk is retried
// with element k-1's declared symbol (via "fallback"), and the assignment that decided it is ignored.
// A failure behind a symbol decided by an override, or by the declared symbol, is never retried: that
// is how --swap-reset off fails rule B's case although rule C is on. A hop rule C forced on one
// derived path of an instance is forced on every derived path of that instance through it (the nested
// instance's own path included), so its derived and live entries agree on the symbol it shows; such a
// path reports fallback only when it does not resolve without the forcing.
//
// Settings (cx.settings, docs/M2A.md §3): swapDangling skip | strict (rule A), swapReset on | off
// (rule B), swapFallback derived | off (rule C); overrideMerge last | first | outer (rule 1's entry).
import { guidStr, guidSet } from "./util.mjs";

const pathKey = (guids) => guids.join("/");
const pathGuids = (e) => (e && e.guidPath && Array.isArray(e.guidPath.guids) ? e.guidPath.guids.map(guidStr) : []);

export function makeResolver(cx) {
  const settings = cx.settings || {};
  const strict = settings.swapDangling === "strict";
  const resetOn = settings.swapReset !== "off";
  const fallbackOn = settings.swapFallback !== "off";
  const fieldOf = cx.en("ComponentPropRef", "componentPropNodeField");
  const symbolKnown = (g) => (cx.props ? cx.props.symbolKnown(g) : (!!cx.byGuid.get(g) && cx.typeName(cx.byGuid.get(g)) === "SYMBOL"));

  const descendants = new Map();   // symbol guid -> Map(local guid -> stored node)
  const subtree = (symbolGuid) => {
    let m = descendants.get(symbolGuid);
    if (m) return m;
    m = new Map();
    const root = symbolGuid ? cx.byGuid.get(symbolGuid) : null;
    if (root) {
      const stack = [root];
      while (stack.length) {
        const n = stack.pop();
        for (const k of cx.childrenOf(n)) { m.set(guidStr(k.guid), k); stack.push(k); }
      }
    }
    descendants.set(symbolGuid, m);
    return m;
  };
  const declared = (n) => (n && n.symbolData && guidSet(n.symbolData.symbolID) ? guidStr(n.symbolData.symbolID) : null);

  const entryMaps = new WeakMap();   // stored instance -> Map(path key -> [entry])
  const entriesOf = (n) => {
    let m = entryMaps.get(n);
    if (m) return m;
    m = new Map();
    for (const e of (n.symbolData && n.symbolData.symbolOverrides) || []) {
      const k = pathKey(pathGuids(e));
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    entryMaps.set(n, m);
    return m;
  };
  // An instance's own root entries: the empty path and [its declared symbol].
  const rootEntries = (n) => {
    const m = entriesOf(n), s = declared(n);
    return (m.get("") || []).concat(s ? m.get(s) || [] : []);
  };

  const derivedKeys = new WeakMap();   // stored instance -> Set(path key)
  const inDerived = (instanceNode, guids) => {
    let s = derivedKeys.get(instanceNode);
    if (!s) {
      s = new Set((instanceNode.derivedSymbolData || []).map((d) => pathKey(pathGuids(d))));
      derivedKeys.set(instanceNode, s);
    }
    return s.has(pathKey(guids));
  };

  // A swap target as rule A sees it: a guid, or null when the value is to be skipped.
  const usable = (g) => (g && (strict || symbolKnown(g)) ? g : null);
  // The swap of one holder's entries on one path: the one the duplicate merge keeps (D17,
  // --override-merge, as overrides.mjs mergeEntries orders them; the winner comes last), so the walk
  // and the swap the IR writes name the same symbol.
  const mergeRule = settings.overrideMerge || "outer";
  const level = (e) => (typeof e.overrideLevel === "number" && Number.isFinite(e.overrideLevel) ? e.overrideLevel : 0);
  const mergedSwap = (list) => {
    let order = list.map((e, k) => ({ e, k }));
    if (mergeRule === "first") order = order.reverse();
    else if (mergeRule === "outer") order.sort((a, b) => (level(b.e) - level(a.e)) || (a.k - b.k));
    let v = null;
    for (const { e } of order) if (guidSet(e.overriddenSymbolID)) { const s = usable(guidStr(e.overriddenSymbolID)); if (s) v = s; }
    return v;
  };

  // The assignments that can reach a property of the instance element k sits in (the innermost holder,
  // the "owning instance"), as pools in D7 rule 2's order: the outer holders' entries addressed to it,
  // innermost holder first; its own root entries; its own componentPropAssignment. A holder reset by
  // rule B gives nothing of its own. Each pool: { list: [raw assignment], src: { instance, path } }.
  function poolsFor(guids, k, holders) {
    const owner = holders[holders.length - 1];
    const pools = [];
    for (let j = holders.length - 2; j >= 0; j--) {
      const h = holders[j];
      if (h.reset) continue;
      const rel = guids.slice(h.start, k);
      for (const e of entriesOf(h.n).get(pathKey(rel)) || []) if ((e.componentPropAssignment || []).length) pools.push({ list: e.componentPropAssignment, src: { instance: h.g, path: rel } });
    }
    if (!owner.reset) {
      for (const e of rootEntries(owner.n)) if ((e.componentPropAssignment || []).length) pools.push({ list: e.componentPropAssignment, src: { instance: owner.g, path: pathGuids(e) } });
      if ((owner.n.componentPropAssignment || []).length) pools.push({ list: owner.n.componentPropAssignment, src: { instance: owner.g, path: null } });
    }
    return pools;
  }

  // Element k's effective symbol (rules 1-3). holders: the instances walked so far, outermost first;
  // cur: the symbol element k sits in.
  function decide(guids, k, n, holders, cur, forced) {
    const own = declared(n);
    if (forced) return { symbol: own, via: "fallback", src: null };
    // 1. an override swap, the outermost holder winning.
    for (const h of holders) {
      if (h.reset) continue;
      const rel = guids.slice(h.start, k + 1);
      const list = entriesOf(h.n).get(pathKey(rel));
      if (!list) continue;
      const v = mergedSwap(list);
      if (v) return { symbol: v, via: "override", src: { instance: h.g, path: rel } };
    }
    // 2. a swap property bound on the element, assigned to the instance it sits in.
    const refs = (n.componentPropRef || []).filter((r) => r && guidSet(r.defID) && fieldOf(r.componentPropNodeField) === "OVERRIDDEN_SYMBOL_ID");
    if (refs.length && cx.props) {
      const pools = poolsFor(guids, k, holders);
      if (pools.length) {
        const scope = cx.props.scopeOf(cur);
        for (const ref of refs) {
          const id = guidStr(ref.defID);
          const root = scope ? cx.props.rootOf(scope, id, cur) : null;
          for (const pool of pools) {
            let hit = null;
            for (const a of pool.list) {
              if (!a || !guidSet(a.defID)) continue;
              const aid = guidStr(a.defID);
              if (aid === id || (root && scope && cx.props.rootOf(scope, aid, cur) === root)) hit = a;
            }
            if (!hit) continue;
            const gv = hit.value && guidSet(hit.value.guidValue) ? guidStr(hit.value.guidValue) : null;
            const s = usable(gv);
            if (!s) continue;   // rule A: the next pool
            return { symbol: s, via: "property", src: Object.assign({ defId: guidStr(hit.defID) }, pool.src) };
          }
        }
      }
    }
    // 3. the declared symbol.
    return { symbol: own, via: "declared", src: null };
  }

  function walk(I, guids, forced) {
    const S0 = declared(I);
    const holders = [{ n: I, g: guidStr(I.guid), start: 0, reset: false, symbol: S0 }];
    const elements = [], resets = [];
    let cur = S0;
    for (let k = 0; k < guids.length; k++) {
      const n = subtree(cur).get(guids[k]);
      if (!n) return { ok: false, at: k, why: k === 0 ? "not a layer of the master" : "not a layer of the effective symbol of element " + (k - 1), elements };
      const last = k === guids.length - 1;
      const isInstance = cx.typeName(n) === "INSTANCE";
      if (!last && !isInstance) return { ok: false, at: k, why: "a path goes on below a layer that is not an instance", elements };
      let symbol = null, via = null, src = null, reset = false;
      if (isInstance) {
        const d = decide(guids, k, n, holders, cur, forced.has(k));
        symbol = d.symbol; via = d.via; src = d.src;
        reset = resetOn && (via === "override" || via === "property");
        if (reset) resets.push(guidStr(n.guid));
        if (!last) { holders.push({ n, g: guidStr(n.guid), start: k + 1, reset, symbol }); cur = symbol; }
      }
      elements.push({ n, i: cx.indexOf ? cx.indexOf(guids[k]) : undefined, symbol, via, reset, src });
    }
    return { ok: true, root: false, elements, resets, fallback: forced.size > 0, ignored: [], holders };
  }

  const memo = new WeakMap();   // stored instance -> Map(path key -> result)
  function resolve(instanceNode, guids) {
    let m = memo.get(instanceNode);
    if (!m) { m = new Map(); memo.set(instanceNode, m); }
    const key = pathKey(guids);
    if (m.has(key)) return m.get(key);
    const out = resolveOnce(instanceNode, guids);
    m.set(key, out);
    return out;
  }
  function resolveOnce(I, guids) {
    const S0 = declared(I);
    if (!S0) return { ok: false, at: 0, why: "the instance names no symbol" };
    if (guids.length === 0 || (guids.length === 1 && guids[0] === S0)) {
      return { ok: true, root: true, elements: [], resets: [], fallback: false, ignored: [], holders: [{ n: I, g: guidStr(I.guid), start: 0, reset: false, symbol: S0 }] };
    }
    const own = retry(I, guids);
    // A nested instance whose swap assignment rule C ignored on one derived path is drawn with its
    // declared symbol on every derived path through it (its own path included), so the instance's
    // derived and live entries agree on which symbol it shows.
    if (inDerived(I, guids)) {
      const learned = prepare(I), pre = new Set(), items = [];
      for (let k = 0; k < guids.length; k++) {
        const it = learned.get(pathKey(guids.slice(0, k + 1)));
        if (it) { pre.add(k); items.push(it); }
      }
      if (pre.size) {
        const r = walk(I, guids, pre);
        if (r.ok) {
          r.fallback = !own.ok || own.fallback;
          r.ignored = items;
          return r;
        }
      }
    }
    return own;
  }
  // Rule C on one path: retry with the declared symbol at the failing hop, when a property decided it
  // and the path is in derived; each retry forces one more hop, so the loop ends.
  const retried = new WeakMap();   // stored instance -> Map(path key -> retry's result)
  function retry(I, guids) {
    let m = retried.get(I);
    if (!m) { m = new Map(); retried.set(I, m); }
    const key = pathKey(guids);
    if (!m.has(key)) m.set(key, retryOnce(I, guids));
    return m.get(key);
  }
  function retryOnce(I, guids) {
    const forced = new Set(), ignored = [], hops = [];
    let r = walk(I, guids, forced);
    while (!r.ok && fallbackOn && r.at > 0 && !forced.has(r.at - 1) && inDerived(I, guids)) {
      const hop = r.elements[r.at - 1];
      if (!hop || hop.via !== "property") break;
      forced.add(r.at - 1);
      const item = { instance: hop.src.instance, path: hop.src.path, defId: hop.src.defId, target: guidStr(hop.n.guid), hop: guids.slice(0, r.at) };
      ignored.push(item);
      hops.push([r.at - 1, item]);
      r = walk(I, guids, forced);
    }
    if (!r.ok) return { ok: false, at: r.at, why: r.why };
    r.ignored = ignored;
    r.forcedHops = hops;
    return r;
  }
  // The hops rule C forced on any derived path of the instance: path prefix key -> ignored item.
  const learnedOf = new WeakMap();
  function prepare(I) {
    let m = learnedOf.get(I);
    if (m) return m;
    m = new Map();
    learnedOf.set(I, m);
    if (!fallbackOn) return m;
    for (const d of I.derivedSymbolData || []) {
      const guids = pathGuids(d);
      if (!guids.length) continue;
      const r = retry(I, guids);
      if (r.ok) for (const [k, item] of r.forcedHops) m.set(pathKey(guids.slice(0, k + 1)), item);
    }
    return m;
  }

  return {
    resolve,
    effectiveSymbol(chain, node) {
      if (!chain || !chain.length) return declared(node);
      const guids = chain.slice(1).map((x) => guidStr(x.guid)).concat([guidStr(node.guid)]);
      const r = resolve(chain[0], guids);
      return r.ok && r.elements.length ? r.elements[r.elements.length - 1].symbol : declared(node);
    },
    inDerived,
    entriesOf,
    rootEntries,
    poolsFor,
    subtree,
    declared,
    pathKey,
    pathGuids,
  };
}
