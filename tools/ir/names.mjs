// The name Pixso shows for a layer, where it is not the stored one (docs/M1.md §15.16).
//
//   import { AUTO_INSTANCE_NAME, textShownAs, shownNamesOf, rootNamesFromPix } from "./ir/names.mjs";
//   shownNamesOf(ir, rootNamesOf?) -> (i) => [name]   the names Pixso may show for IR record i
//   rootNamesFromPix(pix) -> (guid) => [name] | null  the names a stored instance's root entries carry
//
// Measured live in Pixso through its plugin API on U (counts only):
//   - an INSTANCE whose stored name is "Instance <n>" or "Экземпляр <n>" (AUTO_INSTANCE_NAME; U 4 867 and 18), or that has no
//     stored name (U 2 527), is shown under the name its root override entry carries (the entry naming
//     the instance itself, guidPath [] or [symbolID]), and without one under its master's name, or, when
//     the master is a variant of a state group, under the group's: 2026-10-06, 66 "Instance <n>" (25 and
//     50 sampled, 9 in both); 2026-10-12, 80 with no name; 146 of 146. The master's or the group's name
//     alone gave 138: the other 8 carry a root name that is neither, and showed it. A root entry's name
//     is never "" nor "Instance <n>" (on any of the six local files). A named instance whose stored name
//     is its master's or set's is shown under it (20 of 20, 2026-10-12). One whose stored name differs
//     from both (U 10 315) is shown under its stored name 47 times of 80, under its master's or set's 32,
//     under a root entry's 1: no stored field tells these apart (they look like auto names kept from
//     before the master was renamed), so the reader keeps the stored name and the identity check may
//     find such a sampled instance differing.
//   - a TEXT whose stored name is "" (U 466) is shown under its characters: 47 of 50 exactly, the
//     other 3 with each line break shown as a space and the trailing spaces trimmed (textShownAs). A
//     named text is shown under its stored name (10 of 10).
// The reader carries the first rule into the IR under --names display (tools/pix/ir/nodes.mjs); the
// builder leaves a TEXT with no name of its own to Figma's autoRename, which follows the characters
// (figma-plugin/src/ir/build-create.js); the identity check compares Pixso's names with shownNamesOf
// (tools/ir/identity.mjs), whatever setting the IR was read with.
import { CODE, headerSetting } from "./schema.mjs";

// Pixso's Russian interface names a new instance "Экземпляр <n>": U 18, P 15, O 13, M 0. On U they are
// shown by the same rule, 18 of 18: 15 under their root entry's name, 3 under the set's or the master's
// (measured live 2026-10-12).
export const AUTO_INSTANCE_NAME = /^(Instance|Экземпляр) \d+$/;

// The forms Pixso shows an empty-named text's characters in.
export function textShownAs(characters) {
  const s = String(characters == null ? "" : characters);
  const flat = s.replace(/\r\n|[\r\n\u2028\u2029]/g, " ").replace(/\s+$/, "");
  return flat === s ? [s] : [s, flat];
}

// The names Pixso may show for the records of a validated IR. The record's own name always; for an
// empty-named TEXT its characters; for an INSTANCE still named "Instance <n>" or "" (an IR read under
// --names stored or before the setting existed, or one display found no name for) the names its root
// entries carry, when rootNamesOf gives them (the IR keeps none: D8 drops a root name that differs from
// the record's), then its master's name and that of the master's state group. A state group is a
// COMPONENT_SET record when accepted and a FRAME with VARIANT_SET_REJECTED when rejected; only under
// --variant-sets frames and before version 3 (no families) is it a FRAME the IR cannot tell from a plain
// one, and only there is any FRAME parent's name taken (on U, 98 records named "Instance <n>" have their
// master in a FRAME: 22 in a rejected group, 76 in a plain frame, whose name the rule never gives). A
// master the IR names by its library identity alone has no name here.
export function shownNamesOf(ir, rootNamesOf) {
  const nodes = ir.nodes || [];
  const index = new Map(nodes.map((r, i) => [r.guid, i]));
  const h = ir.header || {};
  const unmarked = !(h.version >= 3) || headerSetting(h, "variantSets") === "frames";
  const rejected = new Set((ir.notes || []).filter((x) => x.code === CODE.VARIANT_SET_REJECTED && Number.isInteger(x.node)).map((x) => x.node));
  return (i) => {
    const r = nodes[i];
    const out = [r.name];
    if (r.type === "TEXT" && r.name === "") return out.concat(textShownAs(r.props && r.props.characters));
    if (r.type !== "INSTANCE" || !(r.name === "" || AUTO_INSTANCE_NAME.test(r.name))) return out;
    if (rootNamesOf) for (const s of rootNamesOf(r.guid)) out.push(s);
    const m = r.instance && r.instance.master;
    const mi = m && typeof m.guid === "string" ? index.get(m.guid) : undefined;
    if (mi === undefined) return out;
    const master = nodes[mi];
    out.push(master.name);
    const p = master.parent >= 0 ? nodes[master.parent] : null;
    if (p && (p.type === "COMPONENT_SET" || (p.type === "FRAME" && (unmarked || rejected.has(master.parent))))) out.push(p.name);
    return out;
  };
}

// The names a stored INSTANCE's root override entries carry (guidPath [] or [symbolID], docs/M2A.md D8),
// by guid, from the .pix readPix gave: what an IR read under --names stored cannot hold. null without
// the .pix's nodes (ir-audit has the run folder only). The map is made on the first lookup.
export function rootNamesFromPix(pix) {
  if (!pix || !Array.isArray(pix.nodes)) return null;
  const gs = (g) => (g ? g.sessionID + ":" + g.localID : null);
  let by = null;
  return (guid) => {
    if (!by) by = new Map(pix.nodes.map((n) => [gs(n.guid), n]));
    const n = by.get(guid), sd = n && n.symbolData;
    if (!sd) return [];
    const sid = gs(sd.symbolID);
    return (sd.symbolOverrides || []).filter((e) => {
      const p = (e.guidPath && e.guidPath.guids) || [];
      return typeof e.name === "string" && e.name !== "" && (p.length === 0 || (p.length === 1 && gs(p[0]) === sid));
    }).map((e) => e.name);
  };
}
