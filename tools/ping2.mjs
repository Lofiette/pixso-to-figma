import { startJobServer } from "./jobserver.mjs";
const srv = startJobServer(3778);
await srv.ready;
console.log("posting ping…");
try {
  const r = await srv.post({ kind: "render", rootNodeId: "0:0" },
    JSON.stringify({ V: "RESULT = { ok: 1, page: figma.currentPage.name };" }), new Map(), 240000);
  console.log("report: " + JSON.stringify(r));
} catch (e) { console.log("FAILED: " + e.message); }
srv.close();
