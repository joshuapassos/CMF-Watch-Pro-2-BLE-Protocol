// Gera versões GENÉRICAS/ORIGINAIS dos templates: troca CADA asset do pool por uma forma simples
// (gradiente p/ fundo grande, barra p/ sprite alto/estreito = ponteiro, retângulo neutro no resto).
// Substitui o pool INTEIRO (inclui atlas de dígitos), então não sobra arte oficial da CMF.
// Same-footprint (arte simples comprime pequeno). Re-renderiza o thumbnail do dial modificado.
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { parseStructured, scanAssets } from "../src/codec/parse.js";
import { rgbaToRasterForCf } from "../src/codec/rgb565.js";
import { lz4CompressBest, lz4CompressLiteralsOnly } from "../src/codec/lz4.js";
import { writeU32le } from "../src/codec/bytes.js";
import { renderAt } from "../src/codec/render.js";

type RGB = [number, number, number];
const PALETTE: Record<string, [RGB, RGB]> = {
  "290": [[46, 50, 82], [18, 20, 34]],   // indigo
  "309": [[64, 22, 22], [16, 16, 20]],   // maroon
  "353": [[32, 32, 36], [12, 12, 14]],   // graphite
  "275": [[18, 32, 52], [10, 12, 20]],   // navy
  "376": [[36, 32, 28], [14, 12, 12]],   // warm charcoal
};
const HAND: RGB = [232, 232, 238];
const MARK: RGB = [148, 154, 170];

function gradient(w: number, h: number, top: RGB, bot: RGB): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const t = h <= 1 ? 0 : y / (h - 1);
    const r = Math.round(top[0] + (bot[0] - top[0]) * t), g = Math.round(top[1] + (bot[1] - top[1]) * t), b = Math.round(top[2] + (bot[2] - top[2]) * t);
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; }
  }
  return d;
}
function roundRect(w: number, h: number, x0: number, y0: number, rw: number, rh: number, rad: number, c: RGB, alpha: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  const x1 = x0 + rw, y1 = y0 + rh;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
    const dx = Math.min(x - x0, x1 - 1 - x), dy = Math.min(y - y0, y1 - 1 - y);
    if (dx < rad && dy < rad) { const ex = rad - dx, ey = rad - dy; if (ex * ex + ey * ey > rad * rad) continue; }
    const o = (y * w + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = alpha;
  }
  return d;
}
/** Arte simples p/ um asset, escolhida pelas dimensões (sem depender de layer). */
function artForAsset(id: string, w: number, h: number): Uint8ClampedArray {
  if (w >= 300 && h >= 300) { const [t, b] = PALETTE[id]; return gradient(w, h, t, b); } // fundo
  if (h >= w * 2.2 && h >= 60) { const bw = Math.max(3, Math.round(w * 0.42)); return roundRect(w, h, Math.round((w - bw) / 2), 0, bw, h, Math.min(bw, h) / 2, HAND, 255); } // ponteiro
  const pad = Math.max(1, Math.round(Math.min(w, h) * 0.12));
  return roundRect(w, h, pad, pad, w - 2 * pad, h - 2 * pad, Math.min(w, h) * 0.22, MARK, 150); // marcador
}

function crc32(buf: Uint8Array): number { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function png(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const idat = zlib.deflateSync(raw);
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const DIR = "public/templates";
for (const id of ["290", "309", "353", "275", "376"]) {
  const raw = new Uint8Array(readFileSync(`${DIR}/${id}.bin`));
  const out = raw.slice();
  let replaced = 0, skipped = 0;
  for (const [off, cf, w, h, len] of scanAssets(raw)) {
    if (cf === 1) { skipped++; continue; } // JPEG: não re-encoda aqui (nenhum nos 5 templates)
    const raster = rgbaToRasterForCf(artForAsset(id, w, h), w, h, cf);
    let comp = lz4CompressBest(raster);
    if (comp.length > len) { const lit = lz4CompressLiteralsOnly(raster); if (lit.length < comp.length) comp = lit; }
    if (comp.length > len) {
      // arte simples não coube no slot minúsculo → ERASE (transparente, comprime pra ~nada) p/ não
      // deixar nenhum pixel da CMF. Se nem o transparente couber (raríssimo), aí sim mantém.
      const empty = lz4CompressBest(rgbaToRasterForCf(new Uint8ClampedArray(w * h * 4), w, h, cf));
      if (empty.length > len) { skipped++; continue; }
      comp = empty;
    }
    writeU32le(out, off + 4, comp.length);
    out.set(comp, off + 8);
    for (let b = off + 8 + comp.length; b < off + 8 + len; b++) out[b] = 0; // zera cauda
    replaced++;
  }
  // thumbnail do dial modificado (10:10) + máscara circular preta
  const d = parseStructured(out);
  const img = renderAt(d, 10, 10, 0, undefined, false);
  const dim = img.w, cx = (dim - 1) / 2, r2 = (dim / 2) ** 2;
  const buf = new Uint8Array(img.data);
  for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) { const dx = x - cx, dy = y - cx; if (dx * dx + dy * dy > r2) { const o = (y * dim + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = 0; buf[o + 3] = 255; } }
  writeFileSync(`${DIR}/${id}.png`, png(buf, dim, dim));
  writeFileSync(`${DIR}/${id}.bin`, out);
  console.log(`${id}: replaced ${replaced} assets, skipped ${skipped}, size ${out.length}==${raw.length}? ${out.length === raw.length}`);
}
console.log("done.");
