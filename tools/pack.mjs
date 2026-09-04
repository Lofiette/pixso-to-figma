// Compress an IR subtree and emit chunked use_figma payloads (flat DFS stream).
// usage: node tools/pack.mjs <ir.json> <rootId> <outDir>
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

const [, , IR_PATH, ROOT_ID, OUTDIR = "out/chunks"] = process.argv;
const ir = JSON.parse(readFileSync(IR_PATH, "utf8"));
let target = null;
(function w(n) { if (n.id === ROOT_ID) { target = n; return; } if (n.children) n.children.forEach(w); })(ir.tree);
if (!target) { console.error("not found: " + ROOT_ID); process.exit(1); }

const A = { name:"a",type:"b",visible:"c",locked:"d",opacity:"e",blendMode:"f",isMask:"g",x:"h",y:"i",
  width:"j",height:"k",rotation:"l",clipsContent:"m",cornerRadius:"n",topLeftRadius:"o",
  topRightRadius:"p",bottomLeftRadius:"q",bottomRightRadius:"r",cornerSmoothing:"s",strokeWeight:"t",
  strokeAlign:"u",strokeJoin:"v",dashPattern:"w",layoutMode:"y",layoutWrap:"z",
  primaryAxisSizingMode:"A",counterAxisSizingMode:"B",primaryAxisAlignItems:"C",
  counterAxisAlignItems:"D",paddingLeft:"E",paddingRight:"F",paddingTop:"G",paddingBottom:"H",
  itemSpacing:"I",counterAxisSpacing:"J",layoutAlign:"K",layoutGrow:"L",layoutPositioning:"M",
  fills:"N",strokes:"O",effects:"P",constraints:"Q",vectorPaths:"R",characters:"S",fontSize:"T",
  fontName:"U",textAlignHorizontal:"V",textAlignVertical:"W",textAutoResize:"X",textCase:"Y",
  textDecoration:"Z",letterSpacing:"0",lineHeight:"1",paragraphIndent:"2",paragraphSpacing:"3" };

const DROP = { visible:true,locked:false,opacity:1,blendMode:"PASS_THROUGH",isMask:false,rotation:0,
  cornerRadius:0,topLeftRadius:0,topRightRadius:0,bottomLeftRadius:0,bottomRightRadius:0,
  cornerSmoothing:0,strokeWeight:1,strokeAlign:"INSIDE",strokeJoin:"MITER",layoutMode:"NONE",
  layoutWrap:"NO_WRAP",layoutAlign:"INHERIT",layoutGrow:0,layoutPositioning:"AUTO",paddingLeft:0,
  paddingRight:0,paddingTop:0,paddingBottom:0,itemSpacing:0,counterAxisSpacing:0,paragraphIndent:0,
  paragraphSpacing:0,textCase:"ORIGINAL",textDecoration:"NONE",textAlignVertical:"TOP" };

const STROKED = new Set(["VECTOR","LINE","BOOLEAN_OPERATION","ELLIPSE","POLYGON","STAR","RECTANGLE"]);
const INTERN = new Set(["fills","strokes","effects","constraints","vectorPaths","fontName",
  "letterSpacing","lineHeight","dashPattern"]);


const r2 = (x) => (typeof x === "number" && isFinite(x)) ? Math.round(x * 100) / 100 : x;
function round(v) {
  if (typeof v === "number") return r2(v);
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) {
      let x = v[k];
      if (k === "data" && typeof x === "string") x = x.replace(/-?\d+\.\d+(?:e[-+]?\d+)?/gi, (m) => String(r2(parseFloat(m))));
      o[k] = round(x);
    }
    return o;
  }
  return v;
}

const dict = [], dictIdx = new Map();
const intern = (v0) => { const v = round(v0); const k = JSON.stringify(v); if (dictIdx.has(k)) return dictIdx.get(k);
  const i = dict.length; dict.push(v); dictIdx.set(k, i); return i; };

const fonts = new Map();
const flat = [];   // DFS pre-order: { p: parentIndex | -1, d: encodedProps }

function encode(n, parentIdx) {
  const o = {};
  for (const key of Object.keys(n)) {
    if (key === "children") continue;
    const a = A[key];
    if (!a) continue;
    let v = n[key];
    if (v === null || v === undefined || v === "unable") continue;
    if (v && typeof v === "object" && v.__mixed) continue;
    if (key in DROP && JSON.stringify(v) === JSON.stringify(DROP[key])) continue;
    if (key === "strokes" && Array.isArray(v) && v.length === 0 && !STROKED.has(n.type)) continue;
    if (key === "constraints" && v.horizontal === "MIN" && v.vertical === "MIN") continue;
    if (key === "fontName" && v.family) fonts.set(v.family + "|" + v.style, v.family + " " + v.style);
    o[a] = INTERN.has(key) && typeof v === "object" ? intern(v) : round(v);
  }
  const idx = flat.length;
  flat.push({ p: parentIdx, d: o });
  for (const c of n.children || []) encode(c, idx);
  return idx;
}
encode(target, -1);

const DEC = `const K={a:"name",b:"type",c:"visible",d:"locked",e:"opacity",f:"blendMode",g:"isMask",h:"x",i:"y",j:"width",k:"height",l:"rotation",m:"clipsContent",n:"cornerRadius",o:"topLeftRadius",p:"topRightRadius",q:"bottomLeftRadius",r:"bottomRightRadius",s:"cornerSmoothing",t:"strokeWeight",u:"strokeAlign",v:"strokeJoin",w:"dashPattern",y:"layoutMode",z:"layoutWrap",A:"primaryAxisSizingMode",B:"counterAxisSizingMode",C:"primaryAxisAlignItems",D:"counterAxisAlignItems",E:"paddingLeft",F:"paddingRight",G:"paddingTop",H:"paddingBottom",I:"itemSpacing",J:"counterAxisSpacing",K:"layoutAlign",L:"layoutGrow",M:"layoutPositioning",N:"fills",O:"strokes",P:"effects",Q:"constraints",R:"vectorPaths",S:"characters",T:"fontSize",U:"fontName",V:"textAlignHorizontal",W:"textAlignVertical",X:"textAutoResize",Y:"textCase",Z:"textDecoration","0":"letterSpacing","1":"lineHeight","2":"paragraphIndent","3":"paragraphSpacing"};
const REF=new Set(["N","O","P","Q","R","U","0","1","w"]);
function dec(p){const o={};for(const a of Object.keys(p)){const k=K[a];if(!k)continue;o[k]=REF.has(a)?D[p[a]]:p[a];}return o;}
const R={nodes:0,failures:[],fontSub:[]};
const FB={family:"Inter",style:"Regular"};
function ts(nd,k,v,nm){try{nd[k]=v;}catch(e){if(R.failures.length<40)R.failures.push(nm+"."+k+": "+String(e.message||e).slice(0,60));}}
function mk(t){if(t==="TEXT")return figma.createText();if(t==="RECTANGLE")return figma.createRectangle();if(t==="ELLIPSE")return figma.createEllipse();if(t==="LINE")return figma.createLine();if(t==="POLYGON")return figma.createPolygon();if(t==="STAR")return figma.createStar();if(t==="VECTOR"||t==="BOOLEAN_OPERATION")return figma.createVector();if(t==="SECTION")return figma.createSection();return figma.createFrame();}
async function mkNode(n,parent){
  const node=mk(n.type);
  parent.appendChild(node);R.nodes++;
  if(n.name)ts(node,"name",n.name,n.name);
  if(n.vectorPaths&&node.type==="VECTOR")ts(node,"vectorPaths",n.vectorPaths,n.name);
  if(n.width!==undefined&&n.height!==undefined&&node.resize){try{node.resize(Math.max(0.01,n.width),Math.max(0.01,n.height));}catch(e){}}
  if(n.type==="TEXT"){
    const f=n.fontName&&n.fontName.family?{family:n.fontName.family,style:n.fontName.style}:FB;
    let use=f;
    try{await figma.loadFontAsync(f);}catch(e){use=FB;await figma.loadFontAsync(FB);R.fontSub.push(n.name+" <- "+f.family+" "+f.style);}
    node.fontName=use;
    if(n.characters!==undefined)ts(node,"characters",n.characters,n.name);
    for(const k of ["fontSize","textAlignHorizontal","textAlignVertical","textCase","textDecoration","letterSpacing","lineHeight","paragraphIndent","paragraphSpacing"])if(n[k]!==undefined)ts(node,k,n[k],n.name);
    if(n.textAutoResize!==undefined)ts(node,"textAutoResize",n.textAutoResize,n.name);
  }
  for(const k of ["fills","strokes","effects","constraints","strokeWeight","strokeAlign","strokeJoin","dashPattern","cornerRadius","topLeftRadius","topRightRadius","bottomLeftRadius","bottomRightRadius","cornerSmoothing","clipsContent","opacity","blendMode","visible","locked","isMask","rotation"])if(n[k]!==undefined)ts(node,k,n[k],n.name);
  if(n.layoutMode&&n.layoutMode!=="NONE"){ts(node,"layoutMode",n.layoutMode,n.name);
    for(const k of ["layoutWrap","primaryAxisSizingMode","counterAxisSizingMode","primaryAxisAlignItems","counterAxisAlignItems","paddingLeft","paddingRight","paddingTop","paddingBottom","itemSpacing","counterAxisSpacing"])if(n[k]!==undefined)ts(node,k,n[k],n.name);}
  const pAL=parent.layoutMode&&parent.layoutMode!=="NONE";
  if(pAL){for(const k of ["layoutAlign","layoutGrow","layoutPositioning"])if(n[k]!==undefined)ts(node,k,n[k],n.name);}
  else{if(n.x!==undefined)ts(node,"x",n.x,n.name);if(n.y!==undefined)ts(node,"y",n.y,n.name);}
  return node;
}`;

// ---- chunk the flat stream ----
mkdirSync(OUTDIR, { recursive: true });
try { rmSync(OUTDIR, { recursive: true, force: true }); } catch (e) {}
mkdirSync(OUTDIR, { recursive: true });

const LIMIT = Number(process.env.CHUNK_LIMIT || 26000);
const chunks = [];
let i = 0;
while (i < flat.length) {
  const group = [];
  const used = new Map();       // globalDictIdx -> localIdx
  const localDict = [];
  let overhead = DEC.length + 700;
  while (i < flat.length) {
    const e = flat[i];
    const refs = [];
    for (const a of Object.keys(e.d)) if ("NOPQRU01w".indexOf(a) >= 0) refs.push(e.d[a]);
    let add = 0;
    for (const g of refs) if (!used.has(g)) add += JSON.stringify(dict[g]).length + 1;
    const entrySize = JSON.stringify(e).length + 1;
    if (group.length && overhead + entrySize + add > LIMIT) break;
    for (const g of refs) if (!used.has(g)) { used.set(g, localDict.length); localDict.push(dict[g]); }
    const remapped = { p: e.p, d: {} };
    for (const a of Object.keys(e.d)) remapped.d[a] = "NOPQRU01w".indexOf(a) >= 0 ? used.get(e.d[a]) : e.d[a];
    group.push(remapped);
    overhead += entrySize + add;
    i++;
  }
  const first = chunks.length === 0;
  const body = "const D=" + JSON.stringify(localDict) + ";\nconst F=" + JSON.stringify(group) + ";\n" + DEC + "\n";
  const tail = first
    ? "const page=figma.currentPage;let mx=0;for(const c of page.children)mx=Math.max(mx,c.x+c.width);\n" +
      "const map=[];\nfor(const e of F){const parent=e.p<0?page:map[e.p];map.push(await mkNode(dec(e.d),parent));}\n" +
      "map[0].x=mx+200;map[0].y=80;\nreturn {rootId:map[0].id,built:R.nodes,failures:R.failures,fontSub:R.fontSub};"
    : "const root=await figma.getNodeByIdAsync(ROOT_ID);\nif(!root)return{error:\"root missing\"};\n" +
      "const map=[];(function w(n){map.push(n);if(n.children)n.children.forEach(w);})(root);\n" +
      "const base=map.length;\nfor(const e of F){const parent=map[e.p];if(!parent){R.failures.push(\"missing parent \"+e.p);continue;}map.push(await mkNode(dec(e.d),parent));}\n" +
      "return {baseBefore:base,built:R.nodes,total:map.length,failures:R.failures,fontSub:R.fontSub,rootSize:[Math.round(root.width),Math.round(root.height)]};";
  chunks.push({ code: body + tail, count: group.length, first: first });
}

chunks.forEach((c, n) => writeFileSync(OUTDIR + "/c" + String(n).padStart(2, "0") + ".js", c.code, "utf8"));

console.log("root:        " + target.type + ' "' + target.name + '"');
console.log("nodes:       " + flat.length);
console.log("dictionary:  " + dict.length + " global entries");
console.log("fonts:       " + [...fonts.values()].join(", "));
console.log("chunks:      " + chunks.length);
let tot = 0, cum = 0;
chunks.forEach((c, n) => { tot += c.code.length; cum += c.count;
  console.log("  c" + String(n).padStart(2, "0") + "  " + String(c.code.length).padStart(6) + " chars  " + String(c.count).padStart(4) + " nodes  (cum " + cum + ")"); });
console.log("total:       " + tot.toLocaleString() + " chars");
