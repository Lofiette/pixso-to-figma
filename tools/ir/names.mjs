// The name Pixso shows for a layer, where it is not the stored one (docs/M1.md §15.16).
//
//   import { AUTO_INSTANCE_NAME, textShownAs, shownNames } from "./ir/names.mjs";
//   shownNames(ir, i, indexOf) -> [name]   the names Pixso may show for IR record i (indexOf: guid -> index)
//
// Measured live in Pixso through its plugin API on U, 2026-10-06 (counts only):
//   - an INSTANCE whose stored name is "Instance <n>" (AUTO_INSTANCE_NAME; U 4 867) is shown under its
//     master's name, or, when the master is a variant of a state group, under the group's: 46 of 50
//     sampled. The other 4 showed neither (the live file had changed since the export, or the set was
//     renamed): unknown, not a rule. A named instance is shown under its stored name (14 of 15; the
//     other was renamed in the live file).
//   - a TEXT whose stored name is "" (U 466) is shown under its characters: 47 of 50 exactly, the
//     other 3 with each line break shown as a space and the trailing spaces trimmed (textShownAs). A
//     named text is shown under its stored name (10 of 10).
// The reader carries the first rule into the IR under --names display (tools/pix/ir/nodes.mjs); the
// builder leaves a TEXT with no name of its own to Figma's autoRename, which follows the characters
// (figma-plugin/src/ir/build-create.js); the identity check compares Pixso's names with shownNames
// (tools/ir/identity.mjs), which holds for an IR read under either setting.
export const AUTO_INSTANCE_NAME = /^Instance \d+$/;

// The forms Pixso shows an empty-named text's characters in.
export function textShownAs(characters) {
  const s = String(characters == null ? "" : characters);
  const flat = s.replace(/\r\n|[\r\n\u2028\u2029]/g, " ").replace(/\s+$/, "");
  return flat === s ? [s] : [s, flat];
}

// The names Pixso may show for record i of a validated IR. The record's own name always; for an
// empty-named TEXT its characters; for an INSTANCE still named "Instance <n>" (an IR read under
// --names stored, or before the setting existed) its master's name and, where the master's parent is a
// COMPONENT_SET or a FRAME, the parent's: a state group is a FRAME under --variant-sets frames or when
// rejected, and the IR does not mark it, so a FRAME parent's name is taken too. A master the IR names by
// its library identity alone has no name here.
export function shownNames(ir, i, indexOf) {
  const r = ir.nodes[i];
  const out = [r.name];
  if (r.type === "TEXT" && r.name === "") return out.concat(textShownAs(r.props && r.props.characters));
  if (r.type !== "INSTANCE" || !AUTO_INSTANCE_NAME.test(r.name)) return out;
  const m = r.instance && r.instance.master;
  const mi = m && typeof m.guid === "string" ? indexOf(m.guid) : undefined;
  if (mi === undefined) return out;
  const master = ir.nodes[mi];
  out.push(master.name);
  const p = master.parent >= 0 ? ir.nodes[master.parent] : null;
  if (p && (p.type === "COMPONENT_SET" || p.type === "FRAME")) out.push(p.name);
  return out;
}
