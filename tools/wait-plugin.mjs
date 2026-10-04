// Wait until the runner plugin answers, without touching it by hand.
//   node wait-plugin.mjs [seconds]
// One session for the whole wait: every session makes a new key, and starting one per attempt would
// lock out a plugin window that had just been given the previous one. It asks with the fixed RENDER
// "ping" operation and prints which plugin build answered.
import { openSession } from "./session.mjs";
const secs = Number(process.argv[2] || 1800);
const t0 = Date.now(), deadline = t0 + secs * 1000;
const srv = await openSession();
while (Date.now() < deadline) {
  try {
    const r = await srv.post({ kind: "render" }, JSON.stringify({ op: "ping" }), new Map(), 40000);
    if (r && r.ok) {
      srv.close();
      console.log("plugin " + (r.plugin || "?") + " answered after " + Math.round((Date.now() - t0) / 1000) + "s");
      process.exit(0);
    }
    console.log("the plugin answered, but not to ping: " + JSON.stringify(r).slice(0, 160));
    break;
  } catch (e) { /* not there yet */ }
}
srv.close();
console.log("plugin never answered");
process.exit(1);
