import { readFileSync } from "node:fs";
import { decodePNG } from "./pngutil.mjs";
for (const f of process.argv.slice(2)) {
  const p = decodePNG(readFileSync(f));
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < p.H; y++) for (let x = 0; x < p.W; x++) {
    const o = (y * p.W + x) * 4;
    const lum = (p.rgba[o] * 299 + p.rgba[o + 1] * 587 + p.rgba[o + 2] * 114) / 1000;
    if (lum > 180) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  console.log(f.replace(/.*[\/]/, "").padEnd(30) + " light px " + String(n).padStart(7) +
    "  bbox x " + x0 + ".." + x1 + "  y " + y0 + ".." + y1 + "  (" + (x1 - x0 + 1) + " x " + (y1 - y0 + 1) + ")");
}
