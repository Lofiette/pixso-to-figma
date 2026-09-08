import { startJobServer } from "./jobserver.mjs";
const srv = startJobServer(3778);
await srv.ready;
for (const L of [100000, 400000, 900000, 1400000]) {
  const V = "RESULT = { n: " + L + ", d: new Array(" + L + " + 1).join('x') };";
  const t0 = Date.now();
  try {
    const r = await srv.post({ kind: "render", rootNodeId: "0:0" }, JSON.stringify({ V }), new Map(), 45000);
    console.log(L + " -> got " + (r && r.d ? r.d.length : JSON.stringify(r)) + " in " + (Date.now() - t0) + "ms");
  } catch (e) { console.log(L + " -> FAILED: " + e.message); break; }
}
srv.close();
