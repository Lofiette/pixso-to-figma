
const MIXED = pixso.mixed;
const styleIds = new Set(), compRefs = new Map(), fonts = new Map(), imageHashes = new Set(), warn = [];
const COMMON = ["name","type","visible","locked","opacity","blendMode","isMask","x","y","width","height","rotation","layoutAlign","layoutGrow","layoutPositioning","clipsContent","strokeWeight","strokeAlign","strokeCap","strokeJoin","strokeMiterLimit","dashPattern","cornerRadius","topLeftRadius","topRightRadius","bottomLeftRadius","bottomRightRadius","cornerSmoothing","layoutMode","layoutWrap","primaryAxisSizingMode","counterAxisSizingMode","primaryAxisAlignItems","counterAxisAlignItems","paddingLeft","paddingRight","paddingTop","paddingBottom","itemSpacing","counterAxisSpacing","overflowDirection","minWidth","maxWidth","minHeight","maxHeight","fillStyleId","strokeStyleId","effectStyleId","gridStyleId"];
const TEXT_PROPS = ["characters","fontSize","fontName","fontWeight","textAlignHorizontal","textAlignVertical","textAutoResize","textCase","textDecoration","letterSpacing","lineHeight","paragraphIndent","paragraphSpacing","textStyleId","hyperlink","listSpacing"];
const SEG_FIELDS = ["fontName","fontSize","fontWeight","fills","textCase","textDecoration","letterSpacing","lineHeight","textStyleId","fillStyleId"];
function val(v){ if(v===MIXED) return {__mixed:true}; if(v===undefined) return undefined; if(v===null) return null;
  if(Array.isArray(v)) return v.map(val);
  if(typeof v==="object"){ const o={}; for(const k of Object.keys(v)){ if(k==="hash") continue; const x=val(v[k]); if(x!==undefined) o[k]=x; } return o; }
  return v; }
function grab(n,keys,into){ for(const k of keys){ try{ const v=n[k]; if(v!==undefined){ const s=val(v); if(s!==undefined) into[k]=s; } }catch(e){} } }
function noteStyle(o){ for(const k of ["fillStyleId","strokeStyleId","effectStyleId","gridStyleId","textStyleId"]){ const v=o[k]; if(v&&typeof v==="string") styleIds.add(v); } }
function noteFont(f){ if(f&&f.family) fonts.set(f.family+"|"+f.style,{family:f.family,style:f.style}); }
function notePaints(a){ if(Array.isArray(a)) for(const p of a) if(p&&p.type==="IMAGE"&&p.imageHash) imageHashes.add(p.imageHash); }
function ser(n,depth){
  const o={id:n.id}; grab(n,COMMON,o);
  try{ const f=n.fills; if(f!==undefined){ o.fills=val(f); notePaints(f);} }catch(e){}
  try{ const s=n.strokes; if(s!==undefined){ o.strokes=val(s); notePaints(s);} }catch(e){}
  try{ if(n.effects&&n.effects.length) o.effects=val(n.effects);}catch(e){}
  try{ if(n.constraints) o.constraints=val(n.constraints);}catch(e){}
  try{ if(n.layoutGrids&&n.layoutGrids.length) o.layoutGrids=val(n.layoutGrids);}catch(e){}
  try{ if(n.exportSettings&&n.exportSettings.length) o.exportSettings=val(n.exportSettings);}catch(e){}
  try{ if(n.reactions&&n.reactions.length) o.reactions=val(n.reactions);}catch(e){}
  try{ if(n.boundVariables&&Object.keys(n.boundVariables).length) o.boundVariables=val(n.boundVariables);}catch(e){}
  try{ if(n.componentPropertyReferences) o.componentPropertyReferences=val(n.componentPropertyReferences);}catch(e){}
  noteStyle(o);
  if(n.type==="TEXT"){ grab(n,TEXT_PROPS,o); noteStyle(o);
    if(o.fontName&&!o.fontName.__mixed) noteFont(o.fontName);
    try{ const segs=n.getStyledTextSegments(SEG_FIELDS);
      if(segs&&segs.length>1){ o.segments=segs.map(s=>{ const q=val(s); notePaints(s.fills); noteFont(s.fontName); return q; }); }
      else if(segs&&segs.length===1){ noteFont(segs[0].fontName); } }catch(e){ warn.push({id:n.id,w:"segments"}); }
  }
  if(n.type==="VECTOR"||n.type==="BOOLEAN_OPERATION"||n.type==="STAR"||n.type==="POLYGON"||n.type==="LINE"||n.type==="ELLIPSE"){
    try{ if(n.vectorPaths) o.vectorPaths=val(n.vectorPaths);}catch(e){}
    try{ const g=n.vectorNetwork; if(g&&g.vertices){ o.vectorNetwork={ vertices:g.vertices.map(function(v){return {x:v.x,y:v.y,cornerRadius:v.cornerRadius,handleMirroring:v.handleMirroring,strokeCap:v.strokeCap,strokeJoin:v.strokeJoin};}), segments:g.segments.map(function(sg){return {start:sg.start,end:sg.end,tangentStart:{x:sg.tangentStart.x,y:sg.tangentStart.y},tangentEnd:{x:sg.tangentEnd.x,y:sg.tangentEnd.y}};}), regions:(g.regions||[]).map(function(r){return {windingRule:r.windingRule,loops:r.loops};}) }; } }catch(e){}
    try{ if(n.arcData) o.arcData=val(n.arcData);}catch(e){}
    try{ if(n.pointCount) o.pointCount=n.pointCount;}catch(e){}
    try{ if(n.booleanOperation) o.booleanOperation=n.booleanOperation;}catch(e){}
  }
  if(n.type==="INSTANCE"){
    try{ const mc=n.mainComponent;
      if(mc){ o.mainComponentKey=mc.key; if(!compRefs.has(mc.key)) compRefs.set(mc.key,{id:mc.id,setId:(mc.parent&&mc.parent.type==="COMPONENT_SET")?mc.parent.id:null});
        if(mc.parent&&mc.parent.type==="COMPONENT_SET") o.mainComponentSetKey=mc.parent.key; }
      else warn.push({id:n.id,w:"noMainComponent"}); }catch(e){ warn.push({id:n.id,w:"mainComponent"}); }
    try{ if(n.componentProperties) o.componentProperties=val(n.componentProperties);}catch(e){}
    try{ if(n.overrides) o.overrides=val(n.overrides);}catch(e){}
    o.children=[]; try{ for(const c of n.children) o.children.push(ser(c,depth+1)); }catch(e){}
    return o;
  }
  if(n.children&&depth<60){ o.children=[]; for(const c of n.children) o.children.push(ser(c,depth+1)); }
  return o;
}
