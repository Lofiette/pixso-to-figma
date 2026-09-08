// Wait until the runner plugin answers, without touching it by hand.
import { startJobServer } from "./jobserver.mjs";
const deadline = Date.now() + Number(process.argv[2] || 1800) * 1000;
while (Date.now() < deadline) {
  const srv = startJobServer(3778);
  try { await srv.ready; } catch (e) { srv.close(); continue; }
  try {
    await srv.post({ kind: "render", rootNodeId: "0:0" }, JSON.stringify({ V: "RESULT = { ok: 1 };" }), new Map(), 40000);
    srv.close();
    console.log("plugin answered after " + Math.round((Date.now() - (deadline - Number(process.argv[2] || 1800) * 1000)) / 1000) + "s");
    process.exit(0);
  } catch (e) { srv.close(); }
}
console.log("plugin never answered");
process.exit(1);
