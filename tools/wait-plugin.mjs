// Wait until a runner plugin window can be reached, without touching it by hand.
//   node wait-plugin.mjs [seconds]
//
// What this proves is narrow: that a plugin window is open in Figma and answers this session. It is
// not a gate that keeps the window ready for the next tool. Every session makes a new key and rewrites
// figma-plugin/dist (tools/session.mjs), so the tool started after this one has a key the window has
// never seen: the window will ask for that tool's code, or has to be closed and reopened.
//
// One session for the whole wait: starting one per attempt would lock out a plugin window that had
// just been given the previous one's code. It asks with the fixed RENDER "ping" operation and prints
// which plugin build answered. If another runner holds the port, it says so once and waits for the
// port as well, rather than dying.
import { createServer } from "node:net";
import { openSession } from "./session.mjs";
const secs = Number(process.argv[2] || 1800);
const t0 = Date.now(), deadline = t0 + secs * 1000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
// Asked before each attempt, because an attempt rewrites figma-plugin/dist and puts it back when the
// port is taken: done every two seconds for half an hour, that is a lot of chances for a window to be
// opened in between and come up with a key nobody holds. Both loopbacks, as the runner binds both
// (tools/jobserver.mjs): a holder of [::1] alone keeps the port as surely as one of 127.0.0.1. A
// machine with no IPv6 loopback at all answers EADDRNOTAVAIL or EAFNOSUPPORT there, which is free.
const freeOn = (port, host) => new Promise((r) => {
  const s = createServer();
  s.once("error", (e) => r(host === "::1" && e && (e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT")));
  s.listen(port, host, () => s.close(() => r(true)));
});
const portFree = async (port) => (await freeOn(port, "127.0.0.1")) && (await freeOn(port, "::1"));

let srv = null, saidBusy = false;
while (!srv && Date.now() < deadline) {
  if (saidBusy && !(await portFree(3778))) { await pause(2000); continue; }
  try { srv = await openSession(); }
  catch (e) {
    if (e && e.code !== "PORT_TAKEN") { console.log("could not start: " + (e.message || e)); process.exit(1); }
    if (!saidBusy) { console.log(e.message + NL + "waiting for the port to come free…"); saidBusy = true; }
    await pause(2000);
  }
}
if (!srv) { console.log("the port never came free"); process.exit(1); }

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
