// Renderiza alguns dials via o codec TS e salva PNGs (prova visual). Roda com vite-node.
//   npx vite-node scripts/render-samples.ts <outDir> <id> [<id>...]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { parseStructured } from "../src/codec/parse.js";
import { renderAt } from "../src/codec/render.js";
import type { RgbaImage } from "../src/codec/render.js";

const BIN_DIR = join(import.meta.dirname, "..", "..", "work", "store_dials", "bin");

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const body = new Uint8Array(t.length + data.length);
  body.set(t, 0);
  body.set(data, t.length);
  const out = new Uint8Array(4 + body.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(4 + body.length, crc32(body));
  return out;
}
function encodePng(img: RgbaImage): Uint8Array {
  const { w, h, data } = img;
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw));
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const [outDir, ...ids] = process.argv.slice(2);
const files = readdirSync(BIN_DIR).filter((f) => f.endsWith(".bin"));
for (const id of ids) {
  const file = files.find((f) => f.startsWith(id + "_"));
  if (!file) {
    console.error(`id ${id} não encontrado`);
    continue;
  }
  const bin = new Uint8Array(readFileSync(join(BIN_DIR, file)));
  const dial = parseStructured(bin);
  const img = renderAt(dial, 10, 8, 30);
  const outPath = join(outDir, `render_${id}.png`);
  writeFileSync(outPath, encodePng(img));
  console.log(`${id} → ${outPath}  (${dial.name}, ${dial.layers.length} camadas)`);
}
