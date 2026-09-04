// Pack an IR subtree into ONE compressed use_figma payload.
// usage: node tools/pack2.mjs <ir.json> <rootId> <out.js> [--parts N]
import { readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { INFLATE_SRC } from "./inflate.js";

const args = process.argv.slice(2);
const [IR_PATH, ROOT_ID, OUT = "out/payload.js"] = args;
const partsFlag = args.indexOf("--parts");
const PARTS = partsFlag >= 0 ? Number(args[partsFlag + 1]) : 1;

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
const intern = (v0) => { const v = round(v0); const k = JSON.stringify(v);
  if (dictIdx.has(k)) return dictIdx.get(k);
  const i = dict.length; dict.push(v); dictIdx.set(k, i); return i; };
const fonts = new Map();
const flat = [];

function encode(n, parentIdx) {
  const o = {};
  for (const key of Object.keys(n)) {
    if (key === "children") continue;
    const a = A[key]; if (!a) continue;
    const v = n[key];
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

const RUNTIME = `
const K={a:"name",b:"type",c:"visible",d:"locked",e:"opacity",f:"blendMode",g:"isMask",h:"x",i:"y",j:"width",k:"height",l:"rotation",m:"clipsContent",n:"cornerRadius",o:"topLeftRadius",p:"topRightRadius",q:"bottomLeftRadius",r:"bottomRightRadius",s:"cornerSmoothing",t:"strokeWeight",u:"strokeAlign",v:"strokeJoin",w:"dashPattern",y:"layoutMode",z:"layoutWrap",A:"primaryAxisSizingMode",B:"counterAxisSizingMode",C:"primaryAxisAlignItems",D:"counterAxisAlignItems",E:"paddingLeft",F:"paddingRight",G:"paddingTop",H:"paddingBottom",I:"itemSpacing",J:"counterAxisSpacing",K:"layoutAlign",L:"layoutGrow",M:"layoutPositioning",N:"fills",O:"strokes",P:"effects",Q:"constraints",R:"vectorPaths",S:"characters",T:"fontSize",U:"fontName",V:"textAlignHorizontal",W:"textAlignVertical",X:"textAutoResize",Y:"textCase",Z:"textDecoration","0":"letterSpacing","1":"lineHeight","2":"paragraphIndent","3":"paragraphSpacing"};
const REF={N:1,O:1,P:1,Q:1,R:1,U:1,"0":1,"1":1,w:1};
function dec(p){const o={};for(const a in p){const k=K[a];if(!k)continue;o[k]=REF[a]?D[p[a]]:p[a];}return o;}
const R={nodes:0,failures:[],fontSub:[]};
const FB={family:"Inter",style:"Regular"};
const loaded={};
function ts(nd,k,v,nm){try{nd[k]=v;}catch(e){if(R.failures.length<30)R.failures.push(nm+"."+k+": "+String(e.message||e).slice(0,55));}}
function mk(t){if(t==="TEXT")return figma.createText();if(t==="RECTANGLE")return figma.createRectangle();if(t==="ELLIPSE")return figma.createEllipse();if(t==="LINE")return figma.createLine();if(t==="POLYGON")return figma.createPolygon();if(t==="STAR")return figma.createStar();if(t==="VECTOR"||t==="BOOLEAN_OPERATION")return figma.createVector();if(t==="SECTION")return figma.createSection();return figma.createFrame();}
async function mkNode(n,parent){
  const node=mk(n.type);
  parent.appendChild(node);R.nodes++;
  if(n.name)ts(node,"name",n.name,n.name);
  if(n.vectorPaths&&node.type==="VECTOR")ts(node,"vectorPaths",n.vectorPaths,n.name);
  if(n.width!==undefined&&n.height!==undefined&&node.resize){try{node.resize(Math.max(0.01,n.width),Math.max(0.01,n.height));}catch(e){}}
  if(n.type==="TEXT"){
    const f=n.fontName&&n.fontName.family?{family:n.fontName.family,style:n.fontName.style}:FB;
    const key=f.family+"|"+f.style;
    let use=f;
    if(loaded[key]===2)use=FB;
    else if(loaded[key]!==1){
      try{await figma.loadFontAsync(f);loaded[key]=1;}
      catch(e){loaded[key]=2;use=FB;R.fontSub.push(f.family+" "+f.style);}
    }
    if(use===FB&&!loaded["Inter|Regular"]){await figma.loadFontAsync(FB);loaded["Inter|Regular"]=1;}
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

function emit(part, from, to, first) {
  const slice = flat.slice(from, to);
  const used = new Map(), localDict = [];
  for (const e of slice) for (const a in e.d) if ("NOPQRU01w".indexOf(a) >= 0) {
    const g = e.d[a];
    if (!used.has(g)) { used.set(g, localDict.length); localDict.push(dict[g]); }
  }
  const remapped = slice.map((e) => {
    const d = {};
    for (const a in e.d) d[a] = "NOPQRU01w".indexOf(a) >= 0 ? used.get(e.d[a]) : e.d[a];
    return { p: e.p, d: d };
  });
  const json = JSON.stringify({ D: localDict, F: remapped });
  const b64 = deflateRawSync(Buffer.from(json, "utf8"), { level: 9 }).toString("base64");
  const tail = first
    ? `const page=figma.currentPage;let mx=0;for(const c of page.children)mx=Math.max(mx,c.x+c.width);
const map=[];for(const e of F){const parent=e.p<0?page:map[e.p];map.push(await mkNode(dec(e.d),parent));}
map[0].x=mx+200;map[0].y=80;
return {rootId:map[0].id,built:R.nodes,failures:R.failures,fontSub:R.fontSub,size:[Math.round(map[0].width),Math.round(map[0].height)]};`
    : `const root=await figma.getNodeByIdAsync(ROOT_ID);if(!root)return{error:"root missing"};
const map=[];(function w(n){map.push(n);if(n.children)n.children.forEach(w);})(root);
const before=map.length;
for(const e of F){const parent=map[e.p];if(!parent){R.failures.push("missing parent "+e.p);continue;}map.push(await mkNode(dec(e.d),parent));}
return {before:before,built:R.nodes,total:map.length,failures:R.failures,fontSub:R.fontSub,size:[Math.round(root.width),Math.round(root.height)]};`;
  const code = `const B="${b64}";${INFLATE_SRC}
const S=JSON.parse(utf8(inflateRaw(figma.base64Decode(B))));
const D=S.D,F=S.F;${RUNTIME}
${tail}`;
  const name = OUT.replace(/\.js$/, "") + (PARTS > 1 ? ".p" + part : "") + ".js";
  writeFileSync(name, code, "utf8");
  return { name, chars: code.length, b64: b64.length, nodes: slice.length, raw: json.length };
}

const per = Math.ceil(flat.length / PARTS);
const results = [];
for (let i = 0; i < PARTS; i++) {
  const from = i * per, to = Math.min(flat.length, from + per);
  if (from >= to) break;
  results.push(emit(i, from, to, i === 0));
}

console.log("root:        " + target.type + ' "' + target.name + '"');
console.log("nodes:       " + flat.length);
console.log("fonts:       " + [...fonts.values()].join(", "));
for (const r of results) {
  console.log("  " + r.name + "  " + String(r.chars).padStart(6) + " chars total  (" +
    r.nodes + " nodes, raw " + r.raw.toLocaleString() + " -> b64 " + r.b64.toLocaleString() +
    ", " + (r.raw / r.b64).toFixed(1) + "x)" + (r.chars > 50000 ? "   OVER LIMIT" : ""));
}
