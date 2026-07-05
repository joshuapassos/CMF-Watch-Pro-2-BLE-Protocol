import { readFileSync, writeFileSync } from "node:fs";
import { writeU16le } from "../src/codec/bytes.js";
import { parseStructured } from "../src/codec/parse.js";
import { renderAt } from "../src/codec/render.js";
import zlib from "node:zlib";

const SRC = "public/templates/359.bin";
const OUT = "TempHoraMin.bin";
const raw = new Uint8Array(readFileSync(SRC));
const out = raw.slice();

// #7 (date @207,283) → temperatura do clima (0x5f). srcOff=0x2df.
out[0x2df] = 0x5f;
// #8 (segundo campo de data) → escondido fora da tela (yOff=0x32c). Same-footprint (2 bytes).
writeU16le(out, 0x32c, 500);

console.log(`size ${out.length}==${raw.length}? ${out.length === raw.length}`);
writeFileSync(OUT, out);

// preview @10:12
const d = parseStructured(out);
const l7 = d.layers[7];
console.log(`#7 agora mock=${l7.mock} src=0x${(l7.sourceId ?? 0).toString(16)} @(${l7.x},${l7.y})`);
const img = renderAt(d, 10, 12, 30, undefined, false);
const dim = img.w, cxp = (dim - 1) / 2, r2 = (dim / 2) ** 2;
const buf = new Uint8Array(img.data);
for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) { const dx = x - cxp, dy = y - cxp; if (dx*dx+dy*dy>r2){const o=(y*dim+x)*4; buf[o]=buf[o+1]=buf[o+2]=0; buf[o+3]=255;} }
// PNG
function crc32(b:Uint8Array){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return(~c)>>>0;}
const w=dim,h=dim,rw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){rw[y*(w*4+1)]=0;Buffer.from(buf.buffer,buf.byteOffset+y*w*4,w*4).copy(rw,y*(w*4+1)+1);}
const idat=zlib.deflateSync(rw);const ch=(t:string,dd:Buffer)=>{const L=Buffer.alloc(4);L.writeUInt32BE(dd.length);const T=Buffer.from(t);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(Buffer.concat([T,dd])));return Buffer.concat([L,T,dd,c]);};
const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;
writeFileSync("TempHoraMin_preview.png", Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ch("IHDR",ih),ch("IDAT",idat),ch("IEND",Buffer.alloc(0))]));
console.log("wrote", OUT, "+ preview");
