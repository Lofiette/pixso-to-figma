import { startJobServer } from "./jobserver.mjs";
const id = process.argv[2];
const srv = startJobServer(3778);
await srv.ready;
const V = "const n = await figma.getNodeByIdAsync(" + JSON.stringify(id) + ");" +
  "if (n && !n.removed) { n.remove(); RESULT = { removed: true }; } else { RESULT = { removed: false }; }";
try { console.log(JSON.stringify(await srv.post({ kind: "render", rootNodeId: id }, JSON.stringify({ V }), new Map(), 60000))); }
catch (e) { console.log("FAILED: " + e.message); }
srv.close();
