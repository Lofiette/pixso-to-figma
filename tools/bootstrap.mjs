// Emits the code to paste into Figma `use_figma`. The payload PNG carries the tree, the SVG
// assets, the builder (PAY.B) and the verifier (PAY.V); this is only the ~1.2 KB reader that
// decodes the carrier and runs one of them.
//
//   node bootstrap.mjs build  <imageHash>
//   node bootstrap.mjs verify <imageHash> <rootNodeId>
//
// The carrier is written by pack4.mjs with stored deflate blocks, so unpacking is a block walk
// rather than a full inflate. TextDecoder does not exist in the Figma sandbox: UTF-8 is decoded
// by hand.

const [, , MODE, HASH, ROOT] = process.argv;
if (!HASH || (MODE !== "build" && MODE !== "verify") || (MODE === "verify" && !ROOT)) {
  console.error("usage: node bootstrap.mjs build <imageHash> | verify <imageHash> <rootNodeId>");
  process.exit(1);
}

const READER = `
const z = await figma.getImageByHash(${JSON.stringify(HASH)}).getBytesAsync();
let q = 8, W = 0; const idat = [];
while (q < z.length) {
  const L = ((z[q]<<24)|(z[q+1]<<16)|(z[q+2]<<8)|z[q+3])>>>0;
  const T = String.fromCharCode(z[q+4],z[q+5],z[q+6],z[q+7]);
  if (T === "IHDR") W = ((z[q+8]<<24)|(z[q+9]<<16)|(z[q+10]<<8)|z[q+11])>>>0;
  if (T === "IDAT") idat.push(z.subarray(q+8, q+8+L));
  q += 12 + L; if (T === "IEND") break;
}
let tl = 0; for (const a of idat) tl += a.length;
const zz = new Uint8Array(tl); { let o = 0; for (const a of idat) { zz.set(a,o); o += a.length; } }
let p = 2, rl = 0; const blocks = [];
for (;;) {
  const last = zz[p] & 1, bl = zz[p+1] | (zz[p+2]<<8); p += 5;
  blocks.push(zz.subarray(p, p+bl)); rl += bl; p += bl; if (last) break;
}
const rb = new Uint8Array(rl); { let o = 0; for (const c of blocks) { rb.set(c,o); o += c.length; } }
const H = Math.floor(rb.length / (W+1)); const body = new Uint8Array(H*W);
for (let y = 0; y < H; y++) body.set(rb.subarray(y*(W+1)+1, y*(W+1)+1+W), y*W);
const jl = ((body[0]<<24)|(body[1]<<16)|(body[2]<<8)|body[3])>>>0;
let s = "", i = 4, end = 4 + jl;
while (i < end) {
  const c = body[i];
  if (c < 128) { s += String.fromCharCode(c); i += 1; }
  else if (c < 224) { s += String.fromCharCode(((c&31)<<6)|(body[i+1]&63)); i += 2; }
  else if (c < 240) { s += String.fromCharCode(((c&15)<<12)|((body[i+1]&63)<<6)|(body[i+2]&63)); i += 3; }
  else { let cp = ((c&7)<<18)|((body[i+1]&63)<<12)|((body[i+2]&63)<<6)|(body[i+3]&63); cp -= 0x10000;
         s += String.fromCharCode(0xD800+(cp>>10), 0xDC00+(cp&1023)); i += 4; }
}
const PAY = JSON.parse(s);
const AF = Object.getPrototypeOf(async function () {}).constructor;
const NL2 = String.fromCharCode(10);`;

const BR = String.fromCharCode(10) + String.fromCharCode(10);

console.log(MODE === "build"
  ? READER + BR +
    'return await new AF("figma","PAY","let RESULT=null;" + NL2 + PAY.B + NL2 + "return RESULT;")(figma, PAY);'
  : READER + BR +
    'return await new AF("figma","PAY","ROOT_NODE_ID","let RESULT=null;" + NL2 + PAY.V + NL2 + "return RESULT;")(figma, PAY, ' + JSON.stringify(ROOT) + ');');
