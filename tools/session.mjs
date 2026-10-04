// One run's connection to the plugin: a fresh key, the plugin rebuilt to carry it, and the job server.
//
//   const srv = await openSession();          // instead of startJobServer(3778) + await srv.ready
//   await waitForPlugin(srv);                 // before the first job, in a tool that posts at once
//
// Every tool that talks to the plugin starts here, so they all behave the same way:
//   1. a new key (32 random bytes) and a new six-digit pairing code for this run;
//   2. figma-plugin/dist/ written from the sources with the key inside (tools/build-plugin.mjs), so a
//      plugin opened from now on carries it and runs the builder in this checkout;
//   3. the job server on the port, demanding that key and that plugin build (tools/jobserver.mjs);
//   4. the code printed, for a plugin window that was already open and holds an older key.
//
// A window that was already open runs the code it was opened with, not what step 2 wrote. If that is
// the same build — the sources have not changed since — the code pairs it and nothing is lost. If it
// is not, the job server answers it 409 and it asks to be closed and reopened; it is never paired and
// never given a job, so every build and verify in this run comes from the builder in this checkout.
// The build id is in every report as well (`plugin`), and tools/build-lib.mjs says so if one differs.
//
// The plugin files are written before the server starts, so no window can be opened in between and
// come up with the old key. If the port turns out to be taken — another runner is alive — the files
// are put back as they were: they hold the live runner's key, and overwriting them would lock its
// plugin out the next time someone opens it. That error has `code` "PORT_TAKEN", for a caller that
// would rather wait for the port than give up (tools/wait-plugin.mjs).
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
  // Throws before writing anything if the plugin would not compile (a mistake in builder4.js).
  const built = buildPlugin({ outDir: distDir, token: secrets.token });
  const srv = startJobServer(port, Object.assign({ pluginVersion: built.version, log }, secrets));
  try { await srv.ready; }
  catch (e) {
    restore(distDir, before);
    srv.close();
    if (e && e.code === "EADDRINUSE") {
      const busy = new Error("port " + port + " is already taken — another runner is still running. Close its window, or find it: " +
        "netstat -ano | findstr :" + port + "  (macOS: lsof -nP -iTCP:" + port + ")");
      busy.code = "PORT_TAKEN";
      throw busy;
    }
    throw e;
  }
  log("plugin build " + built.version + " written to figma-plugin/dist with this run's key");
  // Spaced for reading aloud and typing; the window accepts it with or without the space.
  log("Код для окна плагина: " + secrets.pairCode.slice(0, 3) + " " + secrets.pairCode.slice(3) +
    "  (нужен, только если плагин был открыт до запуска раннера)");
  return srv;
}

// Wait until a plugin window holding this session's key asks for work, before the first job is posted.
//
//   await waitForPlugin(srv);                 // right after openSession, in a tool that posts jobs
//
// Every session has a new key, so a window left open from the tool before — in the documented flow,
// the run itself — is answered 401 and asks for the code. Posting at once then spends each job's own
// timeout on a window that cannot take it: two minutes per object in the visual audit, for every
// object, until somebody types the code. So the tools wait here, saying every 30 s what is needed,
// and give up after `ms`, throwing. Returns how long it waited.
export async function waitForPlugin(srv, ms = 10 * 60 * 1000, log = console.log) {
  const t0 = Date.now();
  let said = t0 - 25000;          // first hint after 5 s: a window opened after the start is in by then
  while (srv.lastPoll() === 0) {
    if (Date.now() - t0 > ms) throw new Error("no plugin window after " + Math.round(ms / 60000) + " minutes");
    if (Date.now() - said > 30000) {
      said = Date.now();
      log("жду окно плагина — введите в нём код из этого окна или откройте плагин заново (Plugins → Development → pix-to-fig runner)");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return Date.now() - t0;
}
