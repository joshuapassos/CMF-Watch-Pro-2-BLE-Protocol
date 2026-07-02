// Render do dial num buffer RGBA 466². Port de watchface_struct.rs:882-1114 (decode_layer/
// atlas_glyphs/render_at/blend/rotate_blend). cf=1 (JPEG) usa um cache pré-decodificado (async no UI).
import { decodeAssetToRgba } from "./rgb565.js";
import { scanAssets } from "./parse.js";
import { mockSample } from "./mock.js";
import type { Layer, MockKind, StructDial } from "./types.js";

export interface RgbaImage {
  w: number;
  h: number;
  data: Uint8ClampedArray; // RGBA, w*h*4
}

export const CANVAS_DIM = 466;

/** Cache de assets JPEG (cf=1) já decodificados p/ RGBA: assetOff -> RgbaImage. */
export type JpegCache = Map<number, RgbaImage>;

/** Payload LZ4 (ou newPayload editado) de uma camada. */
function layerPayload(dial: StructDial, layer: Layer): Uint8Array {
  if (layer.newPayload) return layer.newPayload;
  return dial.raw.subarray(layer.assetOff + 8, layer.assetOff + 8 + layer.assetLen);
}

/** Decodifica o asset de uma camada em RgbaImage. cf=1 vem do cache (ou vazio). */
export function decodeLayer(dial: StructDial, layer: Layer, jpeg?: JpegCache): RgbaImage {
  if (layer.cf === 1) {
    const cached = jpeg?.get(layer.assetOff);
    if (cached) return cached;
    return { w: layer.w, h: layer.h, data: new Uint8ClampedArray(layer.w * layer.h * 4) };
  }
  const data = decodeAssetToRgba(layerPayload(dial, layer), layer.cf, layer.w, layer.h);
  return { w: layer.w, h: layer.h, data };
}

/** Glifos do atlas cujo "0" está em `baseOff`: assets cf/w/h consecutivos = 0123456789(+pontuação). */
export function atlasGlyphs(dial: StructDial, baseOff: number, max: number): RgbaImage[] {
  const assets = scanAssets(dial.raw).sort((a, b) => a[0] - b[0]);
  const start = assets.findIndex((a) => a[0] === baseOff);
  if (start < 0) return [];
  const [, cf0, w0, h0] = assets[start];
  const out: RgbaImage[] = [];
  for (let k = start; k < assets.length && out.length < max; k++) {
    const [off, cf, w, h, len] = assets[k];
    if (cf !== cf0 || w !== w0 || h !== h0) break;
    const ly: Layer = {
      kind: "image", name: "", cf, w, h, assetOff: off, assetLen: len,
      x: 0, y: 0, pivotX: 0, pivotY: 0, visible: true, mock: "none",
    };
    out.push(decodeLayer(dial, ly));
  }
  return out;
}

/** Alpha-composite `src` sobre `dst` (466²) no offset (ox,oy). Port de blend. */
function blend(dst: Uint8ClampedArray, dim: number, src: RgbaImage, ox: number, oy: number): void {
  for (let sy = 0; sy < src.h; sy++) {
    const dy = oy + sy;
    if (dy < 0 || dy >= dim) continue;
    for (let sx = 0; sx < src.w; sx++) {
      const dx = ox + sx;
      if (dx < 0 || dx >= dim) continue;
      const so = (sy * src.w + sx) * 4;
      const a = src.data[so + 3];
      if (a === 0) continue;
      const di = (dy * dim + dx) * 4;
      const ia = 255 - a;
      dst[di] = ((src.data[so] * a + dst[di] * ia) / 255) | 0;
      dst[di + 1] = ((src.data[so + 1] * a + dst[di + 1] * ia) / 255) | 0;
      dst[di + 2] = ((src.data[so + 2] * a + dst[di + 2] * ia) / 255) | 0;
      dst[di + 3] = 255;
    }
  }
}

/** Desenha `src` rotacionado por `angleDeg` (horário, 0°=cima), pivô do sprite caindo em (cx,cy). */
function rotateBlend(dst: Uint8ClampedArray, dim: number, src: RgbaImage, pivX: number, pivY: number, cx: number, cy: number, angleDeg: number): void {
  const a = (angleDeg * Math.PI) / 180;
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  const sw = src.w;
  const sh = src.h;
  const maxr = Math.max(src.w, src.h) + 2;
  for (let py = Math.max(cy - maxr, 0); py < Math.min(cy + maxr, dim); py++) {
    for (let px = Math.max(cx - maxr, 0); px < Math.min(cx + maxr, dim); px++) {
      const dx = px - cx;
      const dy = py - cy;
      const sxf = pivX + dx * cos + dy * sin;
      const syf = pivY - dx * sin + dy * cos;
      if (sxf < 0 || syf < 0 || sxf >= sw || syf >= sh) continue;
      const sx = sxf | 0;
      const sy = syf | 0;
      const so = (sy * sw + sx) * 4;
      const alpha = src.data[so + 3];
      if (alpha === 0) continue;
      const di = (py * dim + px) * 4;
      const ia = 255 - alpha;
      dst[di] = ((src.data[so] * alpha + dst[di] * ia) / 255) | 0;
      dst[di + 1] = ((src.data[so + 1] * alpha + dst[di + 1] * ia) / 255) | 0;
      dst[di + 2] = ((src.data[so + 2] * alpha + dst[di + 2] * ia) / 255) | 0;
      dst[di + 3] = 255;
    }
  }
}

/** Bounding-box opaca (lo,hi) em x de um glifo (alpha>24). */
function bbox(g: RgbaImage): [number, number] {
  let lo = g.w;
  let hi = 0;
  for (let x = 0; x < g.w; x++) {
    let opaque = false;
    for (let y = 0; y < g.h; y++) {
      if (g.data[(y * g.w + x) * 4 + 3] > 24) {
        opaque = true;
        break;
      }
    }
    if (opaque) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x + 1);
    }
  }
  if (hi <= lo) return [0, g.w];
  return [lo, hi];
}

/** Compõe o dial num buffer RGBA 466² com os ponteiros rotacionados p/ hh:mm:ss. Port de render_at. */
export function renderAt(dial: StructDial, hh: number, mm: number, ss: number, jpeg?: JpegCache): RgbaImage {
  const dim = CANVAS_DIM;
  const data = new Uint8ClampedArray(dim * dim * 4);
  // fundo preto opaco.
  for (let k = 0; k < dim * dim; k++) data[k * 4 + 3] = 255;

  // fundo + imagens estáticas
  for (const layer of dial.layers) {
    if (!layer.visible || layer.kind === "other" || layer.kind === "text" || layer.kind === "pointer") continue;
    const img = decodeLayer(dial, layer, jpeg);
    let ox: number, oy: number;
    if (layer.kind === "background") {
      ox = layer.x;
      oy = layer.y;
    } else {
      ox = layer.x - layer.pivotX;
      oy = layer.y - layer.pivotY;
    }
    blend(data, dim, img, ox, oy);
  }

  const angHour = (hh % 12) * 30 + mm * 0.5;
  const angMin = mm * 6 + ss * 0.1;
  const angSec = ss * 6;
  const ptrs = dial.layers.filter((l) => l.visible && l.kind === "pointer").slice();
  ptrs.sort((a, b) => a.h - b.h);
  const n = ptrs.length;
  ptrs.forEach((l, i) => {
    const role: MockKind = l.sourceId !== undefined ? pointerRoleLocal(l.sourceId) : "none";
    let angle: number;
    if (role === "hour") angle = angHour;
    else if (role === "minute") angle = angMin;
    else if (role === "seconds") angle = angSec;
    else if (n <= 1) angle = angMin;
    else if (i === 0) angle = angHour;
    else if (i + 1 === n) angle = angSec;
    else angle = angMin;
    const img = decodeLayer(dial, l, jpeg);
    rotateBlend(data, dim, img, l.pivotX, l.pivotY, 233, 233, angle);
  });

  // TEXTO/NÚMERO: desenha o valor-mock com os glifos reais do atlas.
  for (const l of dial.layers) {
    if (!l.visible || l.kind !== "text") continue;
    const s = mockSample(l.mock, hh, mm, ss);
    if (s === null) continue;
    const digits: number[] = [];
    for (const c of s) {
      const d = c.charCodeAt(0) - 48;
      if (d >= 0 && d <= 9) digits.push(d);
    }
    if (digits.length === 0) continue;
    const glyphs = atlasGlyphs(dial, l.assetOff, 12);
    if (glyphs.length < 10) continue;
    const gw = glyphs[0].w;
    const widths: Array<[number, number]> = [];
    for (let d = 0; d < 10; d++) widths.push(bbox(glyphs[d]));
    const spans = widths.map(([lo, hi]) => hi - lo);
    const proportional = Math.max(...spans) - Math.min(...spans) > gw / 6;
    const gap = Math.max(gw >> 3, 1);
    let cx = l.x;
    const top = l.y;
    for (const d of digits) {
      const g = glyphs[d];
      if (g) {
        if (proportional) {
          const [lo, hi] = widths[d];
          blend(data, dim, g, cx - lo, top);
          cx += hi - lo + gap;
        } else {
          blend(data, dim, g, cx, top);
          cx += gw;
        }
      } else {
        cx += gw;
      }
    }
  }

  return { w: dim, h: dim, data };
}

// local (evita ciclo com mock.ts já importado; reusa a mesma tabela).
function pointerRoleLocal(src: number): MockKind {
  if (src === 0x0a || src === 0x70) return "hour";
  if (src === 0x0e || src === 0x71) return "minute";
  if (src === 0x12 || src === 0x72) return "seconds";
  return "none";
}
