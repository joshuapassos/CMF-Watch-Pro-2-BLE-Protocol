// Encoders: in-place (templating same-footprint) + photo-dial. Port de watchface_struct.rs:1140 e
// watchface.rs:266 (photo-dial 6c8dc4a5). Puro (sem DOM) — a conversão de imagem→RGBA fica no UI.
import { writeU16le, writeU32le } from "./bytes.js";
import { lz4CompressBest, lz4CompressLiteralsOnly } from "./lz4.js";
import { rgbaToRasterForCf } from "./rgb565.js";
import type { Layer, StructDial } from "./types.js";

/**
 * Reescreve os campos editáveis no `raw` e os payloads trocados (same-footprint) → novo `.bin`.
 * Lança se algum payload novo não couber no `len` original (arquivo cresceria). Port de encode().
 */
export function encodeInPlace(dial: StructDial): Uint8Array {
  const out = dial.raw.slice(); // clone
  for (const layer of dial.layers) {
    if (layer.xOff !== undefined) writeU16le(out, layer.xOff, layer.x);
    if (layer.yOff !== undefined) writeU16le(out, layer.yOff, layer.y);
    if (layer.pivxOff !== undefined) writeU16le(out, layer.pivxOff, layer.pivotX);
    if (layer.pivyOff !== undefined) writeU16le(out, layer.pivyOff, layer.pivotY);
    // Cor (RGB, 3 bytes) e fonte de dado (1 byte) editadas no inspector — same-footprint.
    if (layer.colorOff !== undefined && layer.color) {
      out[layer.colorOff] = layer.color[0];
      out[layer.colorOff + 1] = layer.color[1];
      out[layer.colorOff + 2] = layer.color[2];
    }
    if (layer.srcOff !== undefined && layer.sourceId !== undefined) out[layer.srcOff] = layer.sourceId;
    // Largura/altura do rect do img_number (distribui os dígitos) — 2 bytes cada, same-footprint.
    if (layer.rectWOff !== undefined && layer.rectW !== undefined) writeU16le(out, layer.rectWOff, layer.rectW);
    if (layer.rectHOff !== undefined && layer.rectH !== undefined) writeU16le(out, layer.rectHOff, layer.rectH);
    if (layer.newPayload) {
      const payload = layer.newPayload;
      if (payload.length > layer.assetLen) {
        throw new Error(
          `camada '${layer.name}': imagem nova (${payload.length} B) não cabe no asset original ` +
            `(${layer.assetLen} B) — same-footprint`,
        );
      }
      const off = layer.assetOff;
      writeU32le(out, off + 4, payload.length);
      out.set(payload, off + 8);
      // zera a cauda do payload antigo (cosmético; `len` já limita a leitura).
      for (let b = off + 8 + payload.length; b < off + 8 + layer.assetLen; b++) out[b] = 0;
    }
  }
  return out;
}

/**
 * Comprime um raster RGBA (já no tamanho w×h) p/ o payload de uma camada e o anexa como
 * `newPayload` (com o header `1f 00 01 00`? NÃO — o payload conta a partir do 1º token LZ4;
 * o `1f 00 01 00` é só o 1º token que o LZ4 do app gera. Aqui geramos LZ4 próprio, válido).
 * Retorna o tamanho comprimido (p/ o UI avisar se estourou o same-footprint).
 */
export function setLayerImageRaster(layer: Layer, rgba: Uint8ClampedArray | Uint8Array): number {
  const raster = rgbaToRasterForCf(rgba, layer.w, layer.h, layer.cf);
  let comp = lz4CompressBest(raster);
  if (comp.length > layer.assetLen) {
    // tenta o literals-only (às vezes menor p/ dados muito aleatórios não é o caso; mantém o menor).
    const lit = lz4CompressLiteralsOnly(raster);
    if (lit.length < comp.length) comp = lit;
  }
  layer.newPayload = comp;
  return comp.length;
}

// ---- Photo-dial (6c8dc4a5) ----

const MAGIC = [0x6c, 0x8d, 0xc4, 0xa5];
const TAG_FULL = [0x04, 0x48, 0x47, 0x3a];
const TAG_THUMB = [0x04, 0x38, 0xc4, 0x21];
const PHOTO_COUNT = 18; // constante (não é nº de elementos)
export const FULL_DIM = 466;
export const THUMB_DIM = 270;

/** true se (x,y) está FORA do círculo inscrito de lado `dim`. Port de outside_circle. */
export function outsideCircle(x: number, y: number, dim: number): boolean {
  const c = (dim - 1) / 2;
  const radius2 = (dim / 2) ** 2;
  const dx = x - c;
  const dy = y - c;
  return dx * dx + dy * dy > radius2;
}

/** Zera (preto) os pixels fora do círculo inscrito, in-place, num RGBA dim². */
function circleMaskBlack(rgba: Uint8ClampedArray | Uint8Array, dim: number): void {
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      if (outsideCircle(x, y, dim)) {
        const o = (y * dim + x) * 4;
        rgba[o] = 0;
        rgba[o + 1] = 0;
        rgba[o + 2] = 0;
      }
    }
  }
}

function buildBlock(tag: number[], payload: Uint8Array): Uint8Array {
  const b = new Uint8Array(8 + payload.length);
  b.set(tag, 0);
  writeU32le(b, 4, payload.length);
  b.set(payload, 8);
  return b;
}

/**
 * Monta um `.bin` photo-dial a partir de dois rasters RGBA já redimensionados (full 466², thumb 270²).
 * Aplica o crop circular (preto fora do círculo), converte p/ RGB565-LE, comprime (LZ4) e embrulha.
 * Port de watchface.rs::encode.
 */
export function buildPhotoDial(fullRgba: Uint8ClampedArray | Uint8Array, thumbRgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  circleMaskBlack(fullRgba, FULL_DIM);
  circleMaskBlack(thumbRgba, THUMB_DIM);
  const rawFull = rgbaToRasterForCf(fullRgba, FULL_DIM, FULL_DIM, 4);
  const rawThumb = rgbaToRasterForCf(thumbRgba, THUMB_DIM, THUMB_DIM, 4);
  const payFull = lz4CompressBest(rawFull);
  const payThumb = lz4CompressBest(rawThumb);
  const fullBlock = buildBlock(TAG_FULL, payFull);
  const thumbBlock = buildBlock(TAG_THUMB, payThumb);

  const out = new Uint8Array(4 + 4 + 8 + 4 + fullBlock.length + thumbBlock.length + 4);
  let o = 0;
  out.set(MAGIC, o); o += 4;
  writeU32le(out, o, PHOTO_COUNT); o += 4;
  o += 8; // 8 zeros
  writeU32le(out, o, fullBlock.length); o += 4;
  out.set(fullBlock, o); o += fullBlock.length;
  out.set(thumbBlock, o); o += thumbBlock.length;
  out.set(MAGIC, o);
  return out;
}

export function isPhotoDial(bin: Uint8Array): boolean {
  return bin.length >= 4 && bin[0] === MAGIC[0] && bin[1] === MAGIC[1] && bin[2] === MAGIC[2] && bin[3] === MAGIC[3];
}
