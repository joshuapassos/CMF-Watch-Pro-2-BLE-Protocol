// Gera TEMPLATES DIGITAIS a partir de bases do acervo (359/288/362), com arte 100% ORIGINAL:
//   fundo → gradiente | atlas de dígitos → numerais 7-seg próprios (0-9 + ':') | resto → transparente.
// Mantém os SLOTS (hora/minuto/data/etc.) pra editar só religando fonte + trocando imagem in-place.
// Same-footprint (arte simples comprime pequeno). Re-renderiza os thumbnails. Sem arte da CMF.
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { parseStructured, scanAssets } from "../src/codec/parse.js";
import { rgbaToRasterForCf } from "../src/codec/rgb565.js";
import { lz4CompressBest, lz4CompressLiteralsOnly } from "../src/codec/lz4.js";
import { writeU32le } from "../src/codec/bytes.js";
import { renderAt } from "../src/codec/render.js";

type RGB = [number, number, number];
const PAL: Record<string, [RGB, RGB, RGB]> = { // [topo, base, acento]
  "359": [[30, 70, 120], [8, 12, 26], [80, 180, 255]],   // azul c/ glow ciano
  "288": [[70, 26, 30], [16, 10, 14], [255, 120, 96]],   // ember
  "362": [[44, 50, 64], [10, 12, 18], [130, 150, 190]],  // grafite (mais claro p/ o gradiente aparecer)
};

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
function drawGlyph(w: number, h: number, ch: number, c: RGB): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  if (ch === 10) { // ':'
    const r = Math.max(2, Math.round(w * 0.16)), cx = w / 2;
    for (const cy of [h * 0.32, h * 0.68]) fillRoundRect(px, w, h, cx - r, cy - r, 2 * r, 2 * r, r, c);
    return px;
  }
  const s = SEG[ch]; if (!s) return px;
  const m = Math.min(w, h), t = Math.max(2, Math.round(m * 0.15));
  const padX = Math.round(w * 0.2), padY = Math.round(h * 0.12);
  const x1 = padX, x2 = w - padX, y1 = padY, y2 = h - padY, ym = h / 2;
  const hbar = (xa: number, xb: number, y: number) => fillRoundRect(px, w, h, xa, y - t / 2, xb - xa, t, t / 2, c);
  const vbar = (x: number, ya: number, yb: number) => fillRoundRect(px, w, h, x - t / 2, ya, t, yb - ya, t / 2, c);
  if (s[0]) hbar(x1, x2, y1); if (s[1]) vbar(x1, y1, ym); if (s[2]) vbar(x2, y1, ym);
  if (s[3]) hbar(x1, x2, ym); if (s[4]) vbar(x1, ym, y2); if (s[5]) vbar(x2, ym, y2); if (s[6]) hbar(x1, x2, y2);
  return px;
}
function gradient(W: number, H: number, top: RGB, bot: RGB): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) { const t = H <= 1 ? 0 : y / (H - 1); const r = Math.round(top[0] + (bot[0] - top[0]) * t), g = Math.round(top[1] + (bot[1] - top[1]) * t), b = Math.round(top[2] + (bot[2] - top[2]) * t);
    for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; } }
  return d;
}
// Fundo caprichado: gradiente vertical + BRILHO de luz (banda suave perto do topo, cor de acento).
// TUDO por LINHA (cada linha = uma cor) → mantém runs horizontais → LZ4 comprime barato. Radial
// (glow/vinheta em círculo) explodia o LZ4 (43k) e estourava o slot. Aqui é vertical → ~2k.
// `nb` = nº de faixas verticais distintas: nb=H → gradiente liso; nb menor → menos cores → menor.
function bgRaster(W: number, H: number, top: RGB, bot: RGB, accent: RGB, nb: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  const yGlow = H * 0.24, spread = H * 0.5, strength = 0.5;
  for (let y = 0; y < H; y++) {
    const bi = nb >= H ? y : Math.floor(y * nb / H);
    const yb = nb >= H ? y : (bi + 0.5) * H / nb; // y representativo da faixa
    const t = H <= 1 ? 0 : yb / (H - 1);
    let r = top[0] + (bot[0] - top[0]) * t, g = top[1] + (bot[1] - top[1]) * t, b = top[2] + (bot[2] - top[2]) * t;
    const bloom = Math.exp(-Math.pow((yb - yGlow) / spread, 2)) * strength; // luz suave no topo
    r += (accent[0] - r) * bloom; g += (accent[1] - g) * bloom; b += (accent[2] - b) * bloom;
    const R = Math.round(r), G = Math.round(g), B = Math.round(b);
    for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = 255; }
  }
  return d;
}
// Escolhe o fundo MAIS LISO que cabe no slot (len): tenta liso → vai afunilando as faixas. Garante
// que sempre cabe (o dial mais apertado ganha o gradiente mais grosseiro possível, mas nunca preto).
function background(W: number, H: number, top: RGB, bot: RGB, accent: RGB, cf: number, len: number): Uint8ClampedArray {
  for (const nb of [H, 96, 64, 48, 32, 24, 16, 12, 10, 8, 6, 4, 3, 2]) {
    const rgba = bgRaster(W, H, top, bot, accent, nb);
    let comp = lz4CompressBest(rgbaToRasterForCf(rgba, W, H, cf));
    if (comp.length > len) { const lit = lz4CompressLiteralsOnly(rgbaToRasterForCf(rgba, W, H, cf)); if (lit.length < comp.length) comp = lit; }
    if (comp.length <= len) return rgba;
  }
  return bgRaster(W, H, bot, bot, bot, 1); // último recurso: sólido escuro (sempre cabe)
}
// ---- PNG ----
function crc32(b: Uint8Array){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return(~c)>>>0;}
function png(rg: Uint8Array, w: number, h: number){const rw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){rw[y*(w*4+1)]=0;Buffer.from(rg.buffer,rg.byteOffset+y*w*4,w*4).copy(rw,y*(w*4+1)+1);}const idat=zlib.deflateSync(rw);const ch=(t:string,dd:Buffer)=>{const L=Buffer.alloc(4);L.writeUInt32BE(dd.length);const T=Buffer.from(t);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(Buffer.concat([T,dd])));return Buffer.concat([L,T,dd,c]);};const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ch("IHDR",ih),ch("IDAT",idat),ch("IEND",Buffer.alloc(0))]);}

const DIR = "public/templates";
for (const id of ["359", "288", "362"]) {
  const raw = new Uint8Array(readFileSync(`public/corpus/bin/${id}.bin`));
  const d = parseStructured(raw);
  const [top, bot, accent] = PAL[id];
  const assets = scanAssets(raw); // [off,cf,w,h,len]
  const byOff = new Map(assets.map((a) => [a[0], a]));
  const sorted = assets.slice().sort((a, b) => a[0] - b[0]);

  const bgOff = d.layers.find((l) => l.kind === "background" && !l.aod)?.assetOff ?? -1;
  const gcol = (yc: number): RGB => { const t = Math.max(0, Math.min(1, yc / 466)); return [Math.round(top[0] + (bot[0] - top[0]) * t), Math.round(top[1] + (bot[1] - top[1]) * t), Math.round(top[2] + (bot[2] - top[2]) * t)]; };
  const layerY = new Map<number, number>();
  for (const l of d.layers) if (!layerY.has(l.assetOff)) layerY.set(l.assetOff, l.y + l.h / 2);

  // Runs de ATLAS de dígitos: a partir do assetOff de cada camada de TEXTO, os assets cf consecutivos
  // e "tamanho de glifo" (≤120px) são os glifos 0-9(+':'). Marca cada glifo com o dígito a desenhar.
  const glyphDigit = new Map<number, number>(); // off -> dígito (0-9) ou 10 (':')
  const textBases = new Set(d.layers.filter((l) => l.kind === "text" && l.assetOff > 0).map((l) => l.assetOff));
  for (const base of textBases) {
    const start = sorted.findIndex((a) => a[0] === base);
    if (start < 0) continue;
    const [, cf0, w0, h0] = sorted[start]; // 1º glifo define o tamanho; só do MESMO tamanho é dígito
    for (let k = start, i = 0; k < sorted.length && i < 10; k++, i++) { // só 0-9 (o 11º asset costuma ser separador '/' de tamanho ~igual → não desenhar colon nele)
      const [off, cf, w, h] = sorted[k];
      if (cf !== cf0 || Math.abs(w - w0) > 4 || Math.abs(h - h0) > 4) break; // para em elemento de outro tamanho (decoração)
      if (!glyphDigit.has(off)) glyphDigit.set(off, i);
    }
  }

  const out = raw.slice();
  const stats = { bg: 0, glyph: 0, blank: 0, skip: 0 };
  for (const [off, cf, w, h, len] of assets) {
    if (cf === 1) { stats.skip++; continue; } // JPEG: deixa
    let art: Uint8ClampedArray;
    if (off === bgOff) { art = background(w, h, top, bot, accent, cf, len); stats.bg++; }
    else if (glyphDigit.has(off)) { art = drawGlyph(w, h, glyphDigit.get(off)!, glyphDigit.get(off)! === 10 ? accent : [235, 238, 245]); stats.glyph++; }
    else if (cf === 4) { // cf4 SEM alpha: zeros = preto → preenche com a cor do gradiente (some no fundo)
      const c = gcol(layerY.get(off) ?? 233); art = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) { art[i * 4] = c[0]; art[i * 4 + 1] = c[1]; art[i * 4 + 2] = c[2]; art[i * 4 + 3] = 255; }
      stats.blank++;
    } else { art = new Uint8ClampedArray(w * h * 4); stats.blank++; } // cf5/13/24: transparente (slot em branco)
    let comp = lz4CompressBest(rgbaToRasterForCf(art, w, h, cf));
    if (comp.length > len) { const lit = lz4CompressLiteralsOnly(rgbaToRasterForCf(art, w, h, cf)); if (lit.length < comp.length) comp = lit; }
    if (comp.length > len) { stats.skip++; continue; }
    writeU32le(out, off + 4, comp.length); out.set(comp, off + 8);
    for (let b = off + 8 + comp.length; b < off + 8 + len; b++) out[b] = 0;
  }

  // thumbnail (10:12:30) + máscara circular
  const d2 = parseStructured(out);
  const img = renderAt(d2, 10, 12, 30, undefined, false);
  const dim = img.w, cx = (dim - 1) / 2, r2 = (dim / 2) ** 2;
  const buf = new Uint8Array(img.data);
  for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) { const dx = x - cx, dy = y - cx; if (dx * dx + dy * dy > r2) { const o = (y * dim + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = 0; buf[o + 3] = 255; } }
  writeFileSync(`${DIR}/${id}.png`, png(buf, dim, dim));
  writeFileSync(`${DIR}/${id}.bin`, out);
  console.log(`${id}: ${JSON.stringify(stats)} size ${out.length}==${raw.length}? ${out.length === raw.length}`);
}
console.log("done.");
