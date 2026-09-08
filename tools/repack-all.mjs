// Repack every extracted object, so a change to the builder or the packer reaches all payloads.
//   node repack-all.mjs <dirs list file>
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dirs = readFileSync(process.argv[2], "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
let ok = 0, skipped = 0, failed = 0;
const t0 = Date.now();
for (const d of dirs) {
  const f = (n) => join(d, n);
  if (!existsSync(f("ir.json"))) { skipped++; continue; }
  const meta = JSON.parse(readFileSync(f("payload-meta.json"), "utf8"));
  const env = Object.assign({}, process.env, { PX_PLACE_ABS: "1" });
  if (existsSync(f("textruns.json"))) env.PX_TEXTRUNS = f("textruns.json"); else delete env.PX_TEXTRUNS;
  if (existsSync(f("paintsub.json"))) env.PX_PAINTSUB = f("paintsub.json"); else delete env.PX_PAINTSUB;
  try {
    execFileSync("node", [join(HERE, "pack4.mjs"), f("ir.json"), meta.rootId, f("svg.json"),
      f("bounds.json"), f("abs.json"), f("payload.png"), f("textink.json")],
      { cwd: HERE, env, stdio: ["ignore", "ignore", "pipe"] });
    ok++;
  } catch (e) { failed++; console.log("  FAILED " + d + ": " + String(e.message).slice(0, 120)); }
  if ((ok + failed) % 50 === 0) console.log("  " + (ok + failed) + "/" + dirs.length + "  (" + Math.round((Date.now() - t0) / 1000) + "s)");
}
console.log("repacked " + ok + ", skipped " + skipped + ", failed " + failed + " in " + Math.round((Date.now() - t0) / 1000) + "s");
