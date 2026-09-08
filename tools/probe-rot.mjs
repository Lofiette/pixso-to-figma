// Read back the rotations of a built subtree — a tiny report, unlike a render.
//   node probe-rot.mjs <figmaRootId> [pathPrefixRegex]
import { startJobServer } from "./jobserver.mjs";
const ID = process.argv[2], PRE = process.argv[3] || "^\.7";
const srv = startJobServer(3778);
await srv.ready;
const V = [
  "const root = await figma.getNodeByIdAsync(" + JSON.stringify(ID) + ");",
  "if (!root) { RESULT = { e: 'not found' }; } else {",
  "const out = [];",
  "(function walk(n, d, path) {",
  "  let rt = null; try { rt = n.relativeTransform; } catch (e) {}",
  "  let rot = null;",
  "  if (rt) rot = Math.round(Math.atan2(-rt[1][0], rt[0][0]) * 180 / Math.PI * 100) / 100;",
  "  out.push({ p: path, t: n.type, n: String(n.name).slice(0, 24), rot: rot, lp: n.layoutPositioning || null });",
  "  if (d < 5 && n.children) n.children.forEach(function (c, i) { walk(c, d + 1, path + '.' + i); });",
  "})(root, 0, '');",
  "const re = new RegExp(" + JSON.stringify(PRE) + ");",
  "RESULT = { nodes: out.filter(function (o) { return re.test(o.p); }).slice(0, 40) };",
  "}",
].join(String.fromCharCode(10));
try {
  const r = await srv.post({ kind: "render", rootNodeId: ID }, JSON.stringify({ V }), new Map(), 90000);
  if (r.e) console.log(r.e);
  else for (const o of r.nodes || []) {
    console.log(o.p.padEnd(12) + " " + String(o.t).padEnd(10) + " " + JSON.stringify(o.n).padEnd(26) +
      " rot " + String(o.rot).padStart(7) + "  pos " + (o.lp || "-"));
  }
} catch (e) { console.log("FAILED: " + e.message); }
srv.close();
