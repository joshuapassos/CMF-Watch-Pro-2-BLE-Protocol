// Gera arte ORIGINAL e LIMPA pros templates, ciente do PAPEL de cada asset:
//   fundo → gradiente | ponteiro → mão afilada | atlas de dígitos → numerais 7-seg reais |
//   anel de marcas (pequeno, repetido) → tick fino | decorativo ambíguo → transparente.
// Tudo same-footprint (arte simples comprime pequeno). Re-renderiza thumbnails. Sem arte da CMF.
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { parseStructured, scanAssets } from "../src/codec/parse.js";
import { rgbaToRasterForCf } from "../src/codec/rgb565.js";
import { lz4CompressBest, lz4CompressLiteralsOnly } from "../src/codec/lz4.js";
import { writeU32le } from "../src/codec/bytes.js";
import { renderAt } from "../src/codec/render.js";
import type { Layer } from "../src/codec/types.js";

type RGB = [number, number, number];
const PAL: Record<string, [RGB, RGB, RGB]> = { // [topo, base, acento]
  "290": [[38, 44, 92], [12, 14, 30], [120, 150, 255]],
  "309": [[70, 24, 30], [14, 14, 20], [255, 120, 92]],
  "353": [[26, 28, 36], [10, 10, 14], [220, 224, 235]],
  "275": [[16, 34, 60], [8, 10, 18], [120, 200, 255]],
  "376": [[30, 30, 34], [12, 12, 14], [255, 150, 70]],
};
const HAND: RGB = [235, 238, 245];

function fillRoundRect(px: Uint8ClampedArray, W: number, H: number, x: number, y: number, w: number, h: number, r: number, c: RGB, alpha = 255) {
  const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
    const dx = Math.min(xx - x0, x1 - 1 - xx), dy = Math.min(yy - y0, y1 - 1 - yy);
    if (dx < r && dy < r) { const ex = r - dx, ey = r - dy; if (ex * ex + ey * ey > r * r) continue; }
    const o = (yy * W + xx) * 4; const a = alpha / 255;
    px[o] = Math.round(c[0] * a + px[o] * (1 - a)); px[o + 1] = Math.round(c[1] * a + px[o + 1] * (1 - a));
    px[o + 2] = Math.round(c[2] * a + px[o + 2] * (1 - a)); px[o + 3] = Math.max(px[o + 3], alpha);
  }
}
// dígito 7-seg (a,f,b,g,e,c,d)
const SEG: Record<number, number[]> = { 0:[1,1,1,0,1,1,1],1:[0,0,1,0,0,1,0],2:[1,0,1,1,1,0,1],3:[1,0,1,1,0,1,1],4:[0,1,1,1,0,1,0],5:[1,1,0,1,0,1,1],6:[1,1,0,1,1,1,1],7:[1,0,1,0,0,1,0],8:[1,1,1,1,1,1,1],9:[1,1,1,1,0,1,1] };
function drawDigit(px: Uint8ClampedArray, W: number, H: number, dw: number, dh: number, ch: number, c: RGB) {
  const s = SEG[ch]; if (!s) return;
  const m = Math.min(dw, dh);
  const t = Math.max(2, Math.round(m * 0.14));                 // espessura
  const padX = Math.round(dw * 0.22), padY = Math.round(dh * 0.12);
  const x1 = padX, x2 = dw - padX, y1 = padY, y2 = dh - padY, ym = dh / 2;
  const hbar = (xa: number, xb: number, y: number) => fillRoundRect(px, W, H, xa, y - t / 2, xb - xa, t, t / 2, c);
  const vbar = (x: number, ya: number, yb: number) => fillRoundRect(px, W, H, x - t / 2, ya, t, yb - ya, t / 2, c);
  if (s[0]) hbar(x1, x2, y1); if (s[1]) vbar(x1, y1, ym); if (s[2]) vbar(x2, y1, ym);
  if (s[3]) hbar(x1, x2, ym); if (s[4]) vbar(x1, ym, y2); if (s[5]) vbar(x2, ym, y2); if (s[6]) hbar(x1, x2, y2);
}
function gradient(W: number, H: number, top: RGB, bot: RGB): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) { const t = H <= 1 ? 0 : y / (H - 1); const r = Math.round(top[0] + (bot[0] - top[0]) * t), g = Math.round(top[1] + (bot[1] - top[1]) * t), b = Math.round(top[2] + (bot[2] - top[2]) * t);
    for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; } }
  return d;
}
function hand(W: number, H: number, c: RGB): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  const cx = W / 2, baseW = Math.max(4, W * 0.5), tipW = Math.max(2, W * 0.14);
  const tail = Math.round(H * 0.12); // pequena cauda além do pivô (base)
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);                       // 0 topo(ponta) .. 1 base
    if (y > H - 1 - tail * 0) {}                 // (mão simples afilada)
    const wline = tipW + (baseW - tipW) * t;
    const x0 = Math.round(cx - wline / 2), x1 = Math.round(cx + wline / 2);
    for (let x = x0; x <= x1; x++) { if (x < 0 || x >= W) continue; const o = (y * W + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
  }
  return d;
}
function tick(W: number, H: number, c: RGB): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  const pad = Math.round(Math.min(W, H) * 0.28);
  fillRoundRect(d, W, H, pad, pad, W - 2 * pad, H - 2 * pad, Math.min(W, H) * 0.3, c, 220);
  return d;
}

// ---- PNG ----
function crc32(b: Uint8Array){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return(~c)>>>0;}
function png(rg: Uint8Array, w: number, h: number){const rw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){rw[y*(w*4+1)]=0;Buffer.from(rg.buffer,rg.byteOffset+y*w*4,w*4).copy(rw,y*(w*4+1)+1);}const idat=zlib.deflateSync(rw);const ch=(t:string,dd:Buffer)=>{const L=Buffer.alloc(4);L.writeUInt32BE(dd.length);const T=Buffer.from(t);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(Buffer.concat([T,dd])));return Buffer.concat([L,T,dd,c]);};const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ch("IHDR",ih),ch("IDAT",idat),ch("IEND",Buffer.alloc(0))]);}

const DIR = "public/templates";
for (const id of ["290", "309", "275"]) {
  const raw = new Uint8Array(readFileSync(`public/corpus/bin/${id}.bin`));
  const d = parseStructured(raw);
  const [top, bot, accent] = PAL[id];
  const assets = scanAssets(raw); // [off,cf,w,h,len]
  const byOff = new Map(assets.map((a) => [a[0], a]));

  // papéis por offset
  const bgOff = d.layers.find((l) => l.kind === "background" && !l.aod)?.assetOff ?? -1;
  const handOff = new Map<number, RGB>();
  for (const l of d.layers) if (l.kind === "pointer") handOff.set(l.assetOff, l.mock === "seconds" ? accent : HAND);
  // frames de SHEETS indexados por valor (anel de marcas / posicional) → viram TICKS, não dígitos.
  const u32 = (o: number) => (raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16) | (raw[o + 3] << 24)) >>> 0;
  const tickOff = new Set<number>();
  for (const l of d.layers) {
    if ((l.frames ?? 1) <= 1 || l.aod) continue;
    let off = l.assetOff;
    for (let k = 0; k < l.frames! && byOff.has(off); k++) { tickOff.add(off); off += 8 + u32(off + 4); }
  }
  // atlas de dígitos = run de assets consecutivos com mesmo cf/dims, tamanho 10..14, FORA dos sheets.
  const sorted = [...assets].sort((a, b) => a[0] - b[0]);
  const glyphIndex = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    const [off0, cf, w, h] = sorted[i];
    if (w < 8 || h < 8 || w > 220 || h > 220 || tickOff.has(off0)) continue;
    let j = i; while (j + 1 < sorted.length && sorted[j + 1][1] === cf && sorted[j + 1][2] === w && sorted[j + 1][3] === h && !tickOff.has(sorted[j + 1][0])) j++;
    const runLen = j - i + 1;
    if (runLen >= 10 && runLen <= 14) { for (let k = i; k <= j; k++) glyphIndex.set(sorted[k][0], k - i); i = j; }
  }

  const out = raw.slice();
  let stats = { bg: 0, hand: 0, digit: 0, tick: 0, hidden: 0, skip: 0 };
  for (const [off, cf, w, h, len] of assets) {
    if (cf === 1) { stats.skip++; continue; }
    let art: Uint8ClampedArray;
    if (off === bgOff) { art = gradient(w, h, top, bot); stats.bg++; }
    else if (handOff.has(off)) { art = hand(w, h, handOff.get(off)!); stats.hand++; }
    else if (tickOff.has(off)) { art = tick(w, h, accent); stats.tick++; }             // frame de anel → tick
    else if (glyphIndex.has(off)) { const gi = glyphIndex.get(off)!; art = new Uint8ClampedArray(w * h * 4); if (gi < 10) drawDigit(art, w, h, w, h, gi, [235, 238, 245]); stats.digit++; }
    else if (w <= 60 && h <= 60) { art = tick(w, h, accent); stats.tick++; }         // marca pequena → tick
    else { art = new Uint8ClampedArray(w * h * 4); stats.hidden++; }                   // decorativo grande → some
    let comp = lz4CompressBest(rgbaToRasterForCf(art, w, h, cf));
    if (comp.length > len) { const lit = lz4CompressLiteralsOnly(rgbaToRasterForCf(art, w, h, cf)); if (lit.length < comp.length) comp = lit; }
    if (comp.length > len) { const empty = lz4CompressBest(rgbaToRasterForCf(new Uint8ClampedArray(w * h * 4), w, h, cf)); if (empty.length <= len) comp = empty; else { stats.skip++; continue; } }
    writeU32le(out, off + 4, comp.length); out.set(comp, off + 8);
    for (let b = off + 8 + comp.length; b < off + 8 + len; b++) out[b] = 0;
  }

  // thumbnail (10:10) + máscara circular
  const d2 = parseStructured(out);
  const img = renderAt(d2, 10, 10, 0, undefined, false);
  const dim = img.w, cx = (dim - 1) / 2, r2 = (dim / 2) ** 2;
  const buf = new Uint8Array(img.data);
  for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) { const dx = x - cx, dy = y - cx; if (dx * dx + dy * dy > r2) { const o = (y * dim + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = 0; buf[o + 3] = 255; } }
  writeFileSync(`${DIR}/${id}.png`, png(buf, dim, dim));
  writeFileSync(`${DIR}/${id}.bin`, out);
  console.log(`${id}: ${JSON.stringify(stats)} size ${out.length}==${raw.length}? ${out.length === raw.length}`);
}
console.log("done.");
