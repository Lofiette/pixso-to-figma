// Everything that can be checked without Pixso and without Figma.
//
//   node selftest.mjs
//
// Worth having because the two most expensive classes of mistake here are invisible until a run is
// well under way: the builder and the verifier are compiled only when Figma loads the plugin, so a
// typo in them surfaces as a plugin that will not start; and the plugin window's state line is
// the only thing telling a designer what is happening, so a wrong sentence there is a support
// conversation. Both are testable on this machine in under a second.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { buildPlugin } from "./build-plugin.mjs";
import { startJobServer } from "./jobserver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (m) => console.log("ok   " + m);
const fail = (m) => { failed++; console.log("FAIL " + m); };

// ---------- 1. the plugin as Figma will load it ----------
// The builder and the verifier no longer travel inside the payload; they are part of the generated
// plugin, so the generated plugin is what has to compile. Written to a scratch folder, never to
// figma-plugin/dist, which belongs to whichever runner last started.
const distDir = mkdtempSync(join(tmpdir(), "pxf-dist-"));
let built = null;
try {
  built = buildPlugin({ outDir: distDir, token: "0".repeat(64) });
  execFileSync("node", ["--check", built.codePath], { stdio: "pipe" });
  ok("bundled plugin compiles (build " + built.version + ", " + readFileSync(built.codePath, "utf8").length + " chars)");
} catch (e) { fail("bundled plugin does not build or compile: " + String(e.stderr || e.message).slice(0, 300)); }

// ---------- 2. the plugin frame ----------
const html = built ? readFileSync(built.uiPath, "utf8") : "";
const a = html.indexOf("<script>"), b = html.lastIndexOf("</script>");
if (a < 0 || b < 0) fail("ui.html has no script block");
const js = html.slice(a + 8, b);
const scratch = join(distDir, "uicheck.js");
writeFileSync(scratch, js, "utf8");
try { execFileSync("node", ["--check", scratch], { stdio: "pipe" }); ok("plugin window parses"); }
catch (e) { fail("plugin window does not parse: " + String(e.stderr || e.message).slice(0, 200)); }

// ---------- 3. the state line ----------
// A run passes through all of these. Two of them used to be reported in red as a lost connection
// when nothing was wrong: the runner busy in Pixso, and the runner finished and exited.
const el = () => ({ textContent: "", className: "", hidden: false, disabled: false, onclick: null, style: {}, value: "" });
const S = el(), byId = { s: S, l: el(), p: el(), go: el(), scope: el(), scoperow: el() };
const sent = [];
const ctx = createContext({
  // Records what the frame sends and never settles, so both loops park and nothing under test races.
  fetch: (u, o) => { sent.push({ url: String(u), body: o && o.body ? String(o.body) : "" }); return new Promise(() => {}); },
  document: { getElementById: (i) => byId[i] || el() },
  parent: { postMessage() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  AbortController: function () { this.abort = () => {}; this.signal = null; },
  Promise, Set, Math, JSON, String, Number, Object, Error, console,
});
try {
  runInContext(js, ctx);
  const line = (label, drive, wantText, wantClass) => {
    if (drive) ctx.state(drive);
    if (S.textContent.indexOf(wantText) < 0 || S.className !== wantClass) {
      fail("state line, " + label + ": got [" + S.className + "] " + S.textContent);
    } else ok("state line, " + label);
  };
  line("before any contact", null, "Проверяю связь", "wait");
  line("runner up, nothing started", { link: "up", phase: "idle" }, "Готов. Нажмите кнопку", "on");
  line("extracting, no job yet", { phase: "working" }, "Идёт извлечение из Pixso", "wait");
  line("between jobs", { everJob: true }, "готовит следующий объект", "wait");
  line("job running", { stage: "Собираю объект в Figma" }, "Собираю объект в Figma", "on");
  line("job failed", { trouble: "Объект не собрался: нет шрифта" }, "не собрался", "off");
  line("finished, runner up", { trouble: null, stage: null, phase: "done" }, "Смотрите результат", "on");
  line("finished, runner exited", { link: "down" }, "Раннер закончил работу", "on");
  line("runner never started", { sawDone: false, phase: "idle" }, "Раннер не запущен", "wait");
  line("stopped by an error", { link: "up", phase: "stopped" }, "остановлен", "off");
  // A second plugin window (another Figma file) is refused all of a run's work, and says to close it.
  line("another window has the run", { auth: "taken" }, "в другом окне плагина", "wait");
  ctx.state({ auth: "ok" });

  // ---------- the watchdog waits past the runner's ceiling ----------
  // A K-sized task at 30 ms a node has a 542 s ceiling; the window's 8-minute floor would report it
  // lost first, as a plain failed build, while the sandbox is still working (review S10).
  if (typeof ctx.watchdogMinutes !== "function") fail("the plugin window has no watchdogMinutes");
  else if (ctx.watchdogMinutes(0) !== 8 || ctx.watchdogMinutes(542000) !== 12 || ctx.watchdogMinutes(401540) !== 9) {
    fail("the watchdog: " + [ctx.watchdogMinutes(0), ctx.watchdogMinutes(542000), ctx.watchdogMinutes(401540)].join(", ") + " minutes");
  } else ok("the window's watchdog is 8 minutes, or the job's ceiling plus 2 minutes when that is longer");

  // ---------- the scope the button carries ----------
  // The runner cannot ask what to migrate after the press — by then it is already busy in Pixso —
  // so the choice has to travel with the press or it is lost.
  for (const want of ["file", "page", "selection"]) {
    sent.length = 0;
    byId.scope.value = want;
    byId.go.onclick();
    const start = sent.find((c) => c.url.indexOf("/start") >= 0);
    if (!start) fail("pressing the button sent no /start for scope " + want);
    else if (start.body.indexOf('"' + want + '"') < 0) fail("scope " + want + " did not travel: " + start.body);
    else ok("the button carries scope " + want);
  }
  if (!byId.scope.disabled) fail("the scope stayed editable while a run was starting");
  else ok("the scope locks once the run has been asked for");
} catch (e) { fail("plugin window threw on load: " + e.message); }

// ---------- 4. progress must be held, not polled ----------
// On a timer this ran once a minute whenever the plugin window was not in front, which is exactly
// when someone leaves it to watch extraction.
// Asked the way the plugin window asks: Origin "null" and this run's key (tools/jobserver.mjs).
const srv = startJobServer(0);
await srv.ready;
const PORT = srv.port;
const asPlugin = { Origin: "null", Authorization: "Bearer " + srv.token };
const ctl = (q) => fetch("http://127.0.0.1:" + PORT + "/control" + q, { headers: asPlugin }).then((r) => r.json());
try {
  let t = Date.now();
  const first = await ctl("?rev=0");
  if (Date.now() - t > 1000) fail("a client that has seen nothing was made to wait");
  else ok("first request answered at once (rev " + first.rev + ")");

  t = Date.now();
  const held = ctl("?rev=" + first.rev);
  setTimeout(() => srv.say("линия"), 400);
  const second = await held;
  const dt = Date.now() - t;
  if (dt < 300) fail("the request was not held");
  else if (dt > 3000) fail("it did not wake when a line was said (" + dt + " ms)");
  else ok("held until there was something to say (" + dt + " ms)");

  let early = false;
  ctl("?rev=" + second.rev).then(() => { early = true; });
  await new Promise((r) => setTimeout(r, 1200));
  if (early) fail("answered with nothing new to report");
  else ok("with nothing new, keeps holding");

  const p = ctl("?rev=" + second.rev);
  srv.phase("working");
  const third = await p;
  if (third.phase !== "working") fail("a phase change is not reported");
  else ok("a phase change wakes it too");

  // ---------- and the runner receives that choice ----------
  const waited = srv.waitForStart();
  await fetch("http://127.0.0.1:" + PORT + "/start", {
    method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, asPlugin),
    body: JSON.stringify({ scope: "selection" }),
  });
  const got = await waited;
  if (!got || got.scope !== "selection") fail("the runner did not receive the scope: " + JSON.stringify(got));
  else ok("the runner receives the scope the button sent");
} catch (e) { fail("progress endpoint: " + e.message); }
srv.close();
rmSync(distDir, { recursive: true, force: true });

// ---------- 5. the .pix reader on the synthetic fixture (tools/test-pix.mjs) ----------
// It needs zstd, which node:zlib has from Node 22.15. On an older Node that is not a fault in the
// repository, and the failure says so instead of pointing at the reader.
const zlib = await import("node:zlib");
if (typeof zlib.zstdCompressSync !== "function") fail("this Node (" + process.version + ") has no zstd — the .pix reader needs Node 22.15 or newer");
else { try { execFileSync(process.execPath, [join(HERE, "test-pix.mjs")], { stdio: "inherit" }); } catch (e) { fail("the .pix reader on the synthetic fixture (tools/test-pix.mjs)"); } }

// ---------- 6. the IR schema and the repository's data hygiene, each a script of its own ----------
for (const t of ["test-ir.mjs", "test-hygiene.mjs"]) { try { process.stdout.write(execFileSync(process.execPath, [join(HERE, t)], { encoding: "utf8" })); } catch (e) { process.stdout.write(String(e.stdout || "")); fail(t + " failed"); } }

// ---------- 7. the Pixso channel: object states, full errors, circuit breaker (tools/test-mcp.mjs) ----------
try { execFileSync(process.execPath, [join(HERE, "test-mcp.mjs")], { stdio: "inherit" }); } catch (e) { fail("test-mcp.mjs: the Pixso channel checks failed, see above"); }

// ---------- 8. the plugin's fixed commands and the runner's door: tools/test-plugin.mjs ----------
try { console.log(""); execFileSync("node", [join(HERE, "test-plugin.mjs")], { stdio: "inherit" }); } catch (e) { fail("tools/test-plugin.mjs failed (exit " + e.status + ")"); }

// ---------- 9. M1: the frozen contract, then each part's tests (docs/M1.md §5.5) ----------
// test-m1-contract.mjs is part P0's and stays. The others start as stubs that print "pending: part X"
// and exit 0; each part replaces only its own file, in this order: the reader (A), the double (E),
// the builder (B), verify and the judge (C), the planner and acceptance (D), end to end (F).
const M1_TESTS = [["test-m1-contract.mjs", "P0"], ["test-irread.mjs", "A"], ["test-double.mjs", "E"], ["test-irbuild.mjs", "B"],
  ["test-irverify.mjs", "C"], ["test-pixrun.mjs", "D"], ["test-m1-e2e.mjs", "F"], ["test-iraudit.mjs", "the render audit"]];
for (const [t, part] of M1_TESTS) {
  console.log("");
  try { execFileSync(process.execPath, [join(HERE, t)], { stdio: "inherit" }); }
  catch (e) { fail("tools/" + t + " (part " + part + ") failed (exit " + e.status + ")"); }
}

console.log("");
console.log(failed ? failed + " check" + (failed === 1 ? "" : "s") + " FAILED" : "all checks pass");
process.exit(failed ? 1 : 0);
