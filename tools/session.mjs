// One run's connection to the plugin: a fresh key, the plugin rebuilt to carry it, and the job server.
//
//   const srv = await openSession();          // instead of startJobServer(3778) + await srv.ready
//
// Every tool that talks to the plugin starts here, so they all behave the same way:
//   1. a new key (32 random bytes) and a new six-digit pairing code for this run;
//   2. figma-plugin/dist/ written from the sources with the key inside (tools/build-plugin.mjs), so a
//      plugin opened from now on carries it, and so the plugin always runs the builder in this checkout;
//   3. the job server on the port, demanding that key (tools/jobserver.mjs);
//   4. the code printed, for a plugin window that was already open and holds an older key.
//
// The plugin files are written before the server starts, so no window can be opened in between and
// come up with the old key. If the port turns out to be taken — another runner is alive — the files
// are put back as they were: they hold the live runner's key, and overwriting them would lock its
// plugin out the next time someone opens it.
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newSecrets, startJobServer } from "./jobserver.mjs";
import { buildPlugin, DIST_DIR } from "./build-plugin.mjs";

function snapshot(dir) {
  const keep = {};
  for (const f of ["code.js", "ui.html"]) {
    const p = join(dir, f);
    keep[f] = existsSync(p) ? readFileSync(p) : null;
  }
  return keep;
}
function restore(dir, keep) {
  for (const f of Object.keys(keep)) {
    const p = join(dir, f);
    try { if (keep[f] === null) rmSync(p, { force: true }); else writeFileSync(p, keep[f]); } catch (e) {}
  }
}

export async function openSession({ port = 3778, distDir = DIST_DIR, log = console.log } = {}) {
  const secrets = newSecrets();
  const before = snapshot(distDir);
  const built = buildPlugin({ outDir: distDir, token: secrets.token });
  const srv = startJobServer(port, secrets);
  try { await srv.ready; }
  catch (e) {
    restore(distDir, before);
    srv.close();
    if (e && e.code === "EADDRINUSE") {
      throw new Error("port " + port + " is already taken — another runner is still running. Close its window, or find it: " +
        "netstat -ano | findstr :" + port + "  (macOS: lsof -nP -iTCP:" + port + ")");
    }
    throw e;
  }
  log("plugin build " + built.version + " written to figma-plugin/dist with this run's key");
  // Spaced for reading aloud and typing; the window accepts it with or without the space.
  log("Код для окна плагина: " + secrets.pairCode.slice(0, 3) + " " + secrets.pairCode.slice(3) +
    "  (нужен, только если плагин был открыт до запуска раннера)");
  return srv;
}
