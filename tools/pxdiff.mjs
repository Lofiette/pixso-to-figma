// Magnitude distribution of the difference between two same-size renders.
//
//   node pxdiff.mjs <a.png> <b.png>
//
// Counting differing blocks says nothing useful: a whole page shifted by half a pixel and a
// missing element both light up. What matters is how far apart the pixels are, so this reports
// the distribution — and, separately, the pixels that are inked on one side only, which is the
// signature of something that did not migrate at all.
import { readFileSync } from "node:fs";
import { decodePNG } from "./pngutil.mjs";

const [, , A, B] = process.argv;
const a = decodePNG(readFileSync(A)), b = decodePNG(readFileSync(B));
if (a.W !== b.W || a.H !== b.H) { console.error("different sizes: " + a.W + "x" + a.H + " vs " + b.W + "x" + b.H); process.exit(1); }

const buckets = [0, 1, 2, 4, 8, 16, 32, 64, 128, 192, 256];
const hist = new Array(buckets.length).fill(0);
let sum = 0, worst = 0, worstAt = null;
const n = a.W * a.H;
for (let i = 0; i < n; i++) {
  const o = i * 4;
  const d = Math.max(Math.abs(a.rgba[o] - b.rgba[o]), Math.abs(a.rgba[o + 1] - b.rgba[o + 1]),
                     Math.abs(a.rgba[o + 2] - b.rgba[o + 2]), Math.abs(a.rgba[o + 3] - b.rgba[o + 3]));
  sum += d;
  if (d > worst) { worst = d; worstAt = [i % a.W, (i / a.W) | 0]; }
  let k = 0; while (k < buckets.length - 1 && d >= buckets[k + 1]) k++;
  hist[k]++;
}
console.log(a.W + " x " + a.H + "   " + n + " pixels");
for (let k = 0; k < hist.length; k++) {
  if (!hist[k]) continue;
  const lo = buckets[k], hi = k + 1 < buckets.length ? buckets[k + 1] - 1 : 255;
  const pct = (hist[k] / n * 100).toFixed(2);
  console.log("  delta " + (lo === hi ? String(lo) : lo + "-" + hi).padStart(8) + "   " +
    String(hist[k]).padStart(9) + "   " + pct.padStart(6) + " %");
}
console.log("mean delta " + (sum / n).toFixed(2) + ", worst " + worst + " at " + JSON.stringify(worstAt));
