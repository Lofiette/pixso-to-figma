import { startJobServer } from "./jobserver.mjs";
const srv = startJobServer(3778);
await srv.ready;
const V = [
  "await figma.loadAllPagesAsync();",
  "function count(n){var c=1;var k=n.children;if(k)for(var i=0;i<k.length;i++)c+=count(k[i]);return c;}",
  "const out = [];",
  "for (const p of figma.root.children) {",
  "  out.push({ name: p.name, top: p.children.length, nodes: count(p) - 1 });",
  "}",
  "RESULT = { pages: out };",
].join(String.fromCharCode(10));
try {
  const r = await srv.post({ kind: "render", rootNodeId: "0:0" }, JSON.stringify({ V }), new Map(), 180000);
  for (const p of r.pages || []) console.log("  " + String(p.nodes).padStart(7) + " nodes, " + String(p.top).padStart(4) + " top-level   " + JSON.stringify(p.name));
} catch (e) { console.log("FAILED: " + e.message); }
srv.close();
