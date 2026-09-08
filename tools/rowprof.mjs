import { readFileSync } from "node:fs";
import { decodePNG } from "./pngutil.mjs";
for (const f of process.argv.slice(2)) {
  const p = decodePNG(readFileSync(f));
  const rows = [];
  for (let y = 0; y < p.H; y++) {
    let n = 0;
    for (let x = 0; x < p.W; x++) {
      const o = (y * p.W + x) * 4;
      if ((p.rgba[o] * 299 + p.rgba[o + 1] * 587 + p.rgba[o + 2] * 114) / 1000 < 100) n++;
    }
    rows.push(n);
  }
  const bands = [];
  let s = -1;
  for (let y = 0; y <= p.H; y++) {
    const on = y < p.H && rows[y] > 0;
    if (on && s < 0) s = y;
    if (!on && s >= 0) { bands.push([s, y - 1]); s = -1; }
  }
  console.log(f.replace(/.*[\/]/, "").padEnd(10) + " ink bands: " + bands.map((b) => b[0] + ".." + b[1]).join(", "));
}
