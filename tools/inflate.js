// Compact raw-DEFLATE inflate (puff-style canonical Huffman) + UTF-8 decode.
// Exported as source so the packer can inline it into a use_figma script.
export const INFLATE_SRC = `
function inflateRaw(b){
  var p=0,bit=0,out=new Uint8Array(1<<18),len=0;
  function grow(n){ if(len+n<=out.length)return; var s=out.length; while(s<len+n)s*=2; var o=new Uint8Array(s); o.set(out.subarray(0,len)); out=o; }
  function bits(n){ var v=0,i; for(i=0;i<n;i++){ v|=((b[p]>>bit)&1)<<i; if(++bit===8){bit=0;p++;} } return v; }
  function build(lens,n){
    var h={count:new Int32Array(16),symbol:new Int32Array(n)},i;
    for(i=0;i<n;i++) h.count[lens[i]]++;
    h.count[0]=0;
    var offs=new Int32Array(16);
    for(i=1;i<16;i++) offs[i]=offs[i-1]+h.count[i-1];
    for(i=0;i<n;i++) if(lens[i]) h.symbol[offs[lens[i]]++]=i;
    return h;
  }
  function decode(h){
    var code=0,first=0,index=0,l,count;
    for(l=1;l<16;l++){
      code|=bits(1);
      count=h.count[l];
      if(code-first<count) return h.symbol[index+(code-first)];
      index+=count; first+=count; first<<=1; code<<=1;
    }
    throw new Error("bad huffman code");
  }
  var LB=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  var LE=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  var DB=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  var DE=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  var fixedL=null,fixedD=null,i;
  for(;;){
    var last=bits(1),type=bits(2),lt,dt;
    if(type===0){
      if(bit){bit=0;p++;}
      var sl=b[p]|(b[p+1]<<8); p+=4;
      grow(sl); out.set(b.subarray(p,p+sl),len); len+=sl; p+=sl;
    } else {
      if(type===1){
        if(!fixedL){
          var fl=new Uint8Array(288);
          for(i=0;i<144;i++)fl[i]=8; for(;i<256;i++)fl[i]=9; for(;i<280;i++)fl[i]=7; for(;i<288;i++)fl[i]=8;
          fixedL=build(fl,288);
          var fd=new Uint8Array(30); for(i=0;i<30;i++)fd[i]=5; fixedD=build(fd,30);
        }
        lt=fixedL; dt=fixedD;
      } else if(type===2){
        var hlit=bits(5)+257,hdist=bits(5)+1,hclen=bits(4)+4;
        var ord=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
        var cl=new Uint8Array(19),j;
        for(j=0;j<hclen;j++) cl[ord[j]]=bits(3);
        var ct=build(cl,19),all=new Uint8Array(hlit+hdist),n=0;
        while(n<hlit+hdist){
          var s=decode(ct),r;
          if(s<16) all[n++]=s;
          else if(s===16){ r=3+bits(2); var prev=all[n-1]; while(r--) all[n++]=prev; }
          else if(s===17){ r=3+bits(3); while(r--) all[n++]=0; }
          else { r=11+bits(7); while(r--) all[n++]=0; }
        }
        lt=build(all.subarray(0,hlit),hlit); dt=build(all.subarray(hlit),hdist);
      } else throw new Error("bad block type");
      for(;;){
        var sym=decode(lt);
        if(sym===256) break;
        if(sym<256){ grow(1); out[len++]=sym; }
        else {
          var li=sym-257,length=LB[li]+bits(LE[li]);
          var ds=decode(dt),dist=DB[ds]+bits(DE[ds]);
          grow(length);
          for(var k=0;k<length;k++){ out[len]=out[len-dist]; len++; }
        }
      }
    }
    if(last) break;
  }
  return out.subarray(0,len);
}
function utf8(b){
  var parts=[],buf=[],i=0,n=b.length;
  while(i<n){
    var c=b[i++],cp;
    if(c<128) buf.push(c);
    else if(c<224) buf.push(((c&31)<<6)|(b[i++]&63));
    else if(c<240) buf.push(((c&15)<<12)|((b[i++]&63)<<6)|(b[i++]&63));
    else { cp=((c&7)<<18)|((b[i++]&63)<<12)|((b[i++]&63)<<6)|(b[i++]&63); cp-=65536;
      buf.push(55296+(cp>>10),56320+(cp&1023)); }
    if(buf.length>8192){ parts.push(String.fromCharCode.apply(null,buf)); buf=[]; }
  }
  if(buf.length) parts.push(String.fromCharCode.apply(null,buf));
  return parts.join("");
}
`;
