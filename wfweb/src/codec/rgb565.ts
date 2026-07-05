// Conversões de cor + raster<->RGBA por formato (cf). Espelha watchface.rs:92-103 e decode_layer.
import { lz4Decode } from "./lz4.js";

/** Empacota RGB (8b/canal) em RGB565. */
export function rgbToRgb565(r: number, g: number, b: number): number {
  return (((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)) & 0xffff;
}

/** Desempacota RGB565 em RGB (8b/canal) — igual ao Python (*255/31, *255/63). */
export function rgb565ToRgb(p: number): [number, number, number] {
  const r = (((p >> 11) & 0x1f) * 255 / 31) | 0;
  const g = (((p >> 5) & 0x3f) * 255 / 63) | 0;
  const b = ((p & 0x1f) * 255 / 31) | 0;
  return [r, g, b];
}

/** Bytes/pixel por cf (4→2, 5→3, 24→4). Outros → undefined. */
export function bppOf(cf: number): number | undefined {
  if (cf === 4) return 2;
  if (cf === 5) return 3;
  if (cf === 24) return 4;
  return undefined;
}

/** Tamanho descomprimido (bytes) por cf. cf=13 = 4 bits/px (½ byte). */
export function decodedSize(cf: number, w: number, h: number): number | undefined {
  if (cf === 4 || cf === 5 || cf === 24) return w * h * (bppOf(cf) as number);
  if (cf === 13) return Math.ceil((w * h) / 2);
  return undefined;
}

/**
 * Decodifica um payload de asset (LZ4 já sem o header dimsWord/len) num RGBA `Uint8ClampedArray`
 * de w*h*4. Espelha `decode_layer` (cf=4 opaco, cf=5 alpha, cf=24 RGBA, cf=13 máscara de alfa).
 * cf=1 (JPEG) é tratado fora (precisa de decodificação de imagem do browser).
 */
export function decodeAssetToRgba(payload: Uint8Array, cf: number, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  if (cf === 13) {
    const raw = lz4Decode(payload, decodedSize(13, w, h) ?? 0);
    for (let j = 0; j < w * h; j++) {
      const byte = raw[j >> 1] ?? 0;
      const nib = j % 2 === 0 ? byte & 0x0f : byte >> 4;
      const o = j * 4;
      out[o] = 255;
      out[o + 1] = 255;
      out[o + 2] = 255;
      out[o + 3] = nib * 17; // 0..15 → 0..255
    }
    return out;
  }
  const bpp = bppOf(cf) ?? 2;
  const raw = lz4Decode(payload, w * h * bpp);
  for (let j = 0; j < w * h; j++) {
    const base = j * bpp;
    if (base + bpp > raw.length) break;
    const o = j * 4;
    if (cf === 4) {
      const p = raw[base] | (raw[base + 1] << 8);
      const [r, g, b] = rgb565ToRgb(p);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    } else if (cf === 5) {
      const p = raw[base] | (raw[base + 1] << 8);
      const [r, g, b] = rgb565ToRgb(p);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = raw[base + 2];
    } else {
      out[o] = raw[base];
      out[o + 1] = raw[base + 1];
      out[o + 2] = raw[base + 2];
      out[o + 3] = raw[base + 3];
    }
  }
  return out;
}

/**
 * Converte um raster RGBA (w*h*4) p/ o raster cru do cf (RGB565 / RGB565+alpha / RGBA8888).
 * Espelha `raster_for_cf` (assume que a imagem já foi redimensionada p/ w×h).
 */
export function rgbaToRasterForCf(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, cf: number): Uint8Array {
  // cf=13 = máscara A8 packed em NIBBLE (2 px/byte, par=low, ímpar=high; α→4 bits). Inverso exato do
  // decode. Sem isto, cf13 caía no ramo RGBA e virava lixo (dither) no re-skin/erase.
  if (cf === 13) {
    const out = new Uint8Array(Math.ceil((w * h) / 2));
    for (let j = 0; j < w * h; j++) {
      const nib = (Math.round(rgba[j * 4 + 3] / 17) & 0x0f);
      if (j % 2 === 0) out[j >> 1] = nib;
      else out[j >> 1] |= nib << 4;
    }
    return out;
  }
  const bpp = bppOf(cf) ?? 2;
  const out = new Uint8Array(w * h * bpp);
  let oi = 0;
  for (let j = 0; j < w * h; j++) {
    const o = j * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const a = rgba[o + 3];
    if (cf === 4) {
      const p = rgbToRgb565(r, g, b);
      out[oi++] = p & 0xff;
      out[oi++] = (p >> 8) & 0xff;
    } else if (cf === 5) {
      const p = rgbToRgb565(r, g, b);
      out[oi++] = p & 0xff;
      out[oi++] = (p >> 8) & 0xff;
      out[oi++] = a;
    } else {
      out[oi++] = r;
      out[oi++] = g;
      out[oi++] = b;
      out[oi++] = a;
    }
  }
  return out;
}
