// Is the file open in Pixso the .pix being migrated? (docs/M1.md D9, docs/REWRITE.md §4)
//
//   import { checkIdentity } from "./ir/identity.mjs";
//   const id = await checkIdentity(pix, ir, mcp);   // mcp: makeMcpClient(...) or null
//   id = { same, q5, detail, code, transport, sample: { asked, agree, missing, typeDiffers, nameDiffers } }
//
// same   the open file's root name and page guids are the .pix's: the name compared without a
//        trailing ".pix" and surrounding spaces; every user page of the IR is open in Pixso, and every
//        page Pixso lists is a page of the IR (the internal canvas may or may not be listed)
// q5     Pixso's API ids are the .pix guids (Q5): every one of SAMPLE_SIZE sampled IR records is found
//        by its guid with the same name and the same type (an IR FRAME may be Pixso's COMPONENT_SET:
//        a state group, D7)
// code   null when both hold, else CODE.SOURCE_IDENTITY_MISMATCH: the planner then skips the MCP links
//        of the image chain (links 2 and 3). A Pixso that does not answer gives same false, transport
//        true; that is not a mismatch, and the code is null (the links are skipped as unavailable)
// detail counts only: no name from either file is written into it (it lands in states.json)
//
// The sample is deterministic: SAMPLE_SIZE records spread evenly over the IR's buildable records,
// leaving out those whose type the reader changed (notes SOURCE_FEATURE_UNSUPPORTED, BOOLEAN_FLATTENED,
// GEOMETRY_INVALID: a CONNECTLINE or a flattened boolean is a VECTOR in the IR and not in Pixso).
import { CODE } from "./schema.mjs";
import { BUILT_TYPE } from "./task.mjs";
import { SCRIPTS } from "./mcp-readonly.mjs";

export const SAMPLE_SIZE = 20;
const CHANGED_BY_READER = [CODE.SOURCE_FEATURE_UNSUPPORTED, CODE.BOOLEAN_FLATTENED, CODE.GEOMETRY_INVALID];
// The Pixso API types an IR type may stand for.
const SAME_TYPE = { FRAME: ["FRAME", "COMPONENT_SET"] };

export function sampleGuids(ir, n) {
  const k = n || SAMPLE_SIZE;
  const changed = new Set((ir.notes || []).filter((x) => CHANGED_BY_READER.indexOf(x.code) >= 0 && Number.isInteger(x.node)).map((x) => x.node));
  const cand = [];
  (ir.nodes || []).forEach((r, i) => { if (!changed.has(i) && Object.prototype.hasOwnProperty.call(BUILT_TYPE, r.type)) cand.push(i); });
  if (cand.length <= k) return cand;
  const out = [];
  for (let j = 0; j < k; j++) out.push(cand[Math.floor((j * cand.length) / k)]);
  return out;
}

export const normName = (s) => String(s == null ? "" : s).trim().replace(/\.pix$/i, "").trim();

export function documentNameOf(pix, ir) {
  const h = ir && ir.header && ir.header.source;
  if (h && typeof h.documentName === "string" && h.documentName) return h.documentName;
  if (pix && pix.document && typeof pix.document.name === "string") return pix.document.name;
  return null;
}

// The comparison alone, for answers already read (the tests call it directly).
export function compareIdentity(ir, expectName, open, sampled, answers) {
  const parts = [];
  let same = true;
  if (expectName === null || normName(expectName) !== normName(open && open.file)) { same = false; parts.push("the root name differs"); }
  const irPages = ir.pages || [];
  const all = new Set(irPages.map((p) => p.guid));
  const user = irPages.filter((p) => !p.internal).map((p) => p.guid);
  const openIds = new Set(((open && open.pageIds) || []).map(String));
  const userOpen = user.filter((g) => openIds.has(g)).length;
  const foreign = [...openIds].filter((g) => !all.has(g)).length;
  if (userOpen !== user.length || foreign) { same = false; parts.push("pages: " + userOpen + " of " + user.length + " user pages open, " + foreign + " open pages not in the .pix"); }
  else parts.push(user.length + " of " + user.length + " user pages open");
  const s = { asked: sampled.length, agree: 0, missing: 0, typeDiffers: 0, nameDiffers: 0 };
  const byId = new Map((Array.isArray(answers) ? answers : []).filter((a) => a && typeof a.id === "string").map((a) => [a.id, a]));
  for (const i of sampled) {
    const r = ir.nodes[i];
    const a = byId.get(r.guid);
    if (!a || a.missing) { s.missing++; continue; }
    const types = SAME_TYPE[r.type] || [r.type];
    const typeOk = types.indexOf(a.type) >= 0, nameOk = a.name === r.name;
    if (!typeOk) s.typeDiffers++;
    if (!nameOk) s.nameDiffers++;
    if (typeOk && nameOk) s.agree++;
  }
  const q5 = s.asked > 0 && s.agree === s.asked;
  parts.push(s.agree + " of " + s.asked + " sampled guids agree" + (s.asked - s.agree ? " (" + s.missing + " missing, " + s.typeDiffers + " differ in type, " + s.nameDiffers + " in name)" : ""));
  return { same, q5, sample: s, detail: parts.join("; ") };
}

export async function checkIdentity(pix, ir, mcp) {
  const sampled = sampleGuids(ir);
  const empty = { asked: sampled.length, agree: 0, missing: 0, typeDiffers: 0, nameDiffers: 0 };
  if (!mcp) return { same: false, q5: false, transport: false, code: null, sample: empty, detail: "no Pixso: the identity was not checked" };
  const open = await mcp.run(SCRIPTS.identity());
  if (!open.ok) {
    return { same: false, q5: false, transport: !!open.transport || !!open.refused, code: open.transport || open.refused ? null : CODE.SOURCE_IDENTITY_MISMATCH,
      sample: empty, detail: "Pixso did not answer the identity script: " + String(open.error).slice(0, 200) };
  }
  let answers = [];
  if (sampled.length) {
    const r = await mcp.run(SCRIPTS.sample(sampled.map((i) => ir.nodes[i].guid)));
    if (!r.ok) {
      return { same: false, q5: false, transport: !!r.transport || !!r.refused, code: r.transport || r.refused ? null : CODE.SOURCE_IDENTITY_MISMATCH,
        sample: empty, detail: "Pixso did not answer the guid sample: " + String(r.error).slice(0, 200) };
    }
    answers = r.value;
  }
  const c = compareIdentity(ir, documentNameOf(pix, ir), open.value, sampled, answers);
  return Object.assign(c, { transport: false, code: c.same && c.q5 ? null : CODE.SOURCE_IDENTITY_MISMATCH });
}
