// Render do dial num buffer RGBA 466². Port de watchface_struct.rs:882-1114 (decode_layer/
// atlas_glyphs/render_at/blend/rotate_blend). cf=1 (JPEG) usa um cache pré-decodificado (async no UI).
import { decodeAssetToRgba } from "./rgb565.js";
import { scanAssets } from "./parse.js";
import { mockSample, digitForSource, simEnv } from "./mock.js";
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
  const [, cf0] = assets[start];
  const out: RgbaImage[] = [];
  for (let k = start; k < assets.length && out.length < max; k++) {
    const [off, cf, w, h, len] = assets[k];
    // Só o cf precisa casar: glifos-arte (ex. 284) têm w/h por-dígito diferentes; a frame-table
    // limita a contagem via `max`. (Antes exigia w/h iguais → só 4-5 dos 10 glifos decodavam.)
    if (cf !== cf0) break;
    const ly: Layer = {
      kind: "image", name: "", cf, w, h, assetOff: off, assetLen: len,
      x: 0, y: 0, pivotX: 0, pivotY: 0, visible: true, mock: "none",
    };
    out.push(decodeLayer(dial, ly));
  }
  return out;
}

/** Blend de `src` só onde o pixel cai no SETOR [0, frac·360°), horário a partir das 12h (−90°).
 *  Anel de progresso: disco cf5 recortado em runtime (spec 25 §2, RE do 322). */
function blendSector(dst: Uint8ClampedArray, dim: number, src: RgbaImage, ox: number, oy: number, frac: number): void {
  if (frac >= 1) return blend(dst, dim, src, ox, oy);
  if (frac <= 0) return;
  const cx = src.w / 2;
  const cy = src.h / 2;
  const sweep = frac * 360;
  for (let sy = 0; sy < src.h; sy++) {
    const dy = oy + sy;
    if (dy < 0 || dy >= dim) continue;
    for (let sx = 0; sx < src.w; sx++) {
      const dx = ox + sx;
      if (dx < 0 || dx >= dim) continue;
      const so = (sy * src.w + sx) * 4;
      const a = src.data[so + 3];
      if (a === 0) continue;
      let ang = (Math.atan2(sx - cx, cy - sy) * 180) / Math.PI; // 0 no topo, +horário
      if (ang < 0) ang += 360;
      if (ang > sweep) continue;
      const di = (dy * dim + dx) * 4;
      const ia = 255 - a;
      dst[di] = ((src.data[so] * a + dst[di] * ia) / 255) | 0;
      dst[di + 1] = ((src.data[so + 1] * a + dst[di + 1] * ia) / 255) | 0;
      dst[di + 2] = ((src.data[so + 2] * a + dst[di + 2] * ia) / 255) | 0;
      dst[di + 3] = 255;
    }
  }
}

/** Anel VETORIAL de cor sólida: setor [0, frac·360°) horário das 12h, entre raio r-width e r
 *  (RE do 371 — arco compacto 0x81 sem textura, cor inline). Centro em (cx,cy). */
function fillArcSector(dst: Uint8ClampedArray, dim: number, cx: number, cy: number, r: number, width: number, rgb: [number, number, number], frac: number): void {
  if (frac <= 0) return;
  const sweep = Math.min(1, frac) * 360;
  const rIn = Math.max(0, r - width);
  const [cr, cg, cb] = rgb;
  for (let py = Math.max(0, cy - r); py <= Math.min(dim - 1, cy + r); py++) {
    for (let px = Math.max(0, cx - r); px <= Math.min(dim - 1, cx + r); px++) {
      const dx = px - cx, dy = py - cy;
      const rr = Math.hypot(dx, dy);
      if (rr < rIn || rr > r) continue;
      let ang = (Math.atan2(dx, -dy) * 180) / Math.PI;
      if (ang < 0) ang += 360;
      if (ang > sweep) continue;
      const di = (py * dim + px) * 4;
      dst[di] = cr; dst[di + 1] = cg; dst[di + 2] = cb; dst[di + 3] = 255;
    }
  }
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

/**
 * Índice do frame de um frame-sheet de complicação p/ o valor MOCK (espelha o seletor do fw
 * `0x101b7810`: frame = (count−1)·val/100). null = fonte sem valor de preview → não desenhar.
 * Valores = os dos thumbnails oficiais (mockSample): 80% meta/bateria, TUE, JUL, 68 BPM…
 */
function sheetFrameIdx(mock: MockKind, frames: number, hh: number, mm: number, ss: number): number | null {
  const pct = (v: number) => Math.round(((frames - 1) * v) / 100);
  const clampFrame = (v: number) => Math.min(Math.max(v, 0), frames - 1);
  switch (mock) {
    // flip-clock/número-por-frame (frame = valor direto): frames 0..N-1 = número renderizado.
    case "hour": return clampFrame(hh < frames ? hh : (hh % 12 === 0 ? 12 : hh % 12));
    case "minute": return clampFrame(mm);
    case "percent": return pct(simEnv.percent);
    case "battery": return pct(simEnv.battery);
    case "steps": return pct(Math.min(100, (simEnv.steps / 8000) * 100));
    case "kcal": return pct(Math.min(100, (simEnv.kcal / 240) * 100));
    case "distance": return pct(Math.min(100, (simEnv.distance / 5) * 100));
    case "bpm": return pct(Math.min(100, ((simEnv.bpm - 40) / 120) * 100));
    case "temp": return pct(Math.min(100, (simEnv.temp / 50) * 100));
    case "weekday":
      return Math.min(simEnv.weekday, frames - 1);
    case "date":
      return Math.min(simEnv.month, frames - 1);
    case "ampm":
      return hh < 12 ? 0 : Math.min(1, frames - 1);
    case "seconds":
      // 60 frames → frame=segundo; senão sweep proporcional.
      return frames >= 60 ? clampFrame(ss) : Math.min(Math.floor((ss / 60) * frames), frames - 1);
    default:
      return null;
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

  // fundo + imagens estáticas (+ frame-sheets de complicação: frame escolhido pelo valor MOCK,
  // como o seletor do firmware: frame = (count−1)·val/100 — os valores casam com os thumbnails
  // oficiais: 80% meta/bateria, TUE, JUL, 68 BPM etc.)
  for (const layer of dial.layers) {
    if (!layer.visible || layer.kind === "other" || layer.kind === "text" || layer.kind === "pointer") continue;
    // ANEL DE PROGRESSO: disco recortado num setor = valor-mock / arcMax (spec 25 §2, RE do 322).
    if (layer.kind === "arc") {
      const raw = mockSample(layer.mock, hh, mm, ss);
      const val = raw === null ? 0 : parseInt(raw, 10) || 0;
      const frac = Math.min(1, Math.max(0, val / (layer.arcMax || 100)));
      if (layer.color) {
        // arco vetorial compacto (371/364/366/372): anel de cor sólida, sem textura.
        const r = layer.w / 2;
        const cx = layer.x + r, cy = layer.y + r;
        fillArcSector(data, dim, cx, cy, r, layer.arcWidth || Math.max(6, r * 0.06), layer.color, frac);
      } else {
        blendSector(data, dim, decodeLayer(dial, layer, jpeg), layer.x, layer.y, frac);
      }
      continue;
    }
    let img: RgbaImage;
    if (layer.frames && layer.frames > 1) {
      const idx = layer.previewFrame !== undefined
        ? layer.previewFrame
        : sheetFrameIdx(layer.mock, layer.frames, hh, mm, ss);
      if (idx === null) continue;
      const frames = atlasGlyphs(dial, layer.assetOff, layer.frames);
      img = frames[Math.min(idx, frames.length - 1)] ?? decodeLayer(dial, layer, jpeg);
    } else {
      img = decodeLayer(dial, layer, jpeg);
    }
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
    // Centro de rotação = (x+pivotX, y+pivotY) — x,y é o canto sup-esq do sprite (cena TLV).
    // Sem pivô decodificado, cai no centro do canvas (comportamento antigo).
    const hasPiv = l.pivotX !== 0 || l.pivotY !== 0;
    const cx = hasPiv ? l.x + l.pivotX : 233;
    const cy = hasPiv ? l.y + l.pivotY : 233;
    rotateBlend(data, dim, img, l.pivotX, l.pivotY, cx, cy, angle);
  });

  // TEXTO/NÚMERO: desenha o valor-mock com os glifos reais do atlas.
  for (const l of dial.layers) {
    if (!l.visible || l.kind !== "text") continue;
    // Fonte de dígito ÚNICO (tens/units, spec 25 §1.1) → um dígito; senão o valor-mock inteiro.
    const single = l.sourceId !== undefined ? digitForSource(l.sourceId, hh, mm, ss) : null;
    const s = single ?? mockSample(l.mock, hh, mm, ss);
    if (s === null) continue;
    const glyphs = atlasGlyphs(dial, l.assetOff, 12);
    if (glyphs.length < 10) continue;
    // cf=13 = máscara A8 (RGB branco, alpha=mask); o firmware pinta com a cor do elemento.
    if (l.cf === 13 && l.color) {
      const [cr, cg, cb] = l.color;
      for (const g of glyphs) {
        for (let p = 0; p < g.w * g.h; p++) {
          g.data[p * 4] = cr;
          g.data[p * 4 + 1] = cg;
          g.data[p * 4 + 2] = cb;
        }
      }
    }
    // Dígitos 0–9 + `:` (índice 10 nos atlas de 11+ glifos — `0123456789:`).
    const digits: number[] = [];
    for (const c of s) {
      const d = c.charCodeAt(0) - 48;
      if (d >= 0 && d <= 9) digits.push(d);
      else if (c === ":" && glyphs.length >= 11) digits.push(10);
    }
    if (digits.length === 0) continue;
    const gw = glyphs[0].w;
    const widths: Array<[number, number]> = [];
    for (let d = 0; d < glyphs.length; d++) widths.push(bbox(glyphs[d]));
    const spans = widths.slice(0, 10).map(([lo, hi]) => hi - lo);
    const proportional = Math.max(...spans) - Math.min(...spans) > gw / 6;
    const gap = Math.max(gw >> 3, 1);
    let cx = l.x;
    const top = l.y;
    for (const d of digits) {
      const g = glyphs[d];
      if (g) {
        if (proportional || d >= 10) {
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
