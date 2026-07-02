// Parser do dial ESTRUTURADO. Port fiel de watchface_struct.rs:316-833.
import { u16le, u32le, i16le, i8, hasSeq, matchAt } from "./bytes.js";
import { lz4Decode, lz4DecodeStrict } from "./lz4.js";
import { rgb565ToRgb, bppOf, decodedSize } from "./rgb565.js";
import { mockFromSourceId, pointerRole } from "./mock.js";
import type { Layer, LayerKind, MockKind, ScannedAsset, StructDial } from "./types.js";

const SIG = [0x1f, 0x00, 0x01, 0x00];

/**
 * Varre o pool de assets a partir de 0x30: cada asset é `[dimsWord][len][1f000100 + LZ4]`.
 * Retorna `(offsetDoDimsWord, cf, w, h, len)`.
 */
export function scanAssets(bin: Uint8Array): ScannedAsset[] {
  const out: ScannedAsset[] = [];
  let i = 0x30;
  while (i + 12 <= bin.length) {
    const dw = u32le(bin, i);
    const cf = dw & 0x1f;
    const w = (dw >>> 10) & 0x7ff;
    const h = (dw >>> 21) & 0x7ff;
    // cf=1: JPEG cru (frame de animação). [dimsWord][len][JPEG].
    if (cf === 1 && w >= 1 && w <= 466 && h >= 1 && h <= 466) {
      const len = u32le(bin, i + 4);
      if (len >= 4 && i + 8 + len <= bin.length && bin[i + 8] === 0xff && bin[i + 9] === 0xd8) {
        out.push([i, cf, w, h, len]);
        i += 8 + len;
        continue;
      }
    }
    // cf=4/5/24/13.
    const need = decodedSize(cf, w, h);
    if (need !== undefined && w >= 1 && w <= 466 && h >= 1 && h <= 466) {
      const len = u32le(bin, i + 4);
      if (len >= 4 && i + 8 + len <= bin.length) {
        const payload = bin.subarray(i + 8, i + 8 + len);
        const sigOk = payload.length >= 4 && matchAt(payload, 0, SIG);
        const decodeOk = !sigOk && lz4DecodeStrict(payload, need) !== null;
        if (sigOk || decodeOk) {
          out.push([i, cf, w, h, len]);
          i += 8 + len;
          continue;
        }
      }
    }
    i += 1;
  }
  return out;
}

/** Conta "tinta" de um asset: pixels OPACOS e NÃO-pretos. Port de asset_ink. */
function assetInk(bin: Uint8Array, off: number, cf: number, w: number, h: number, len: number): number {
  const bpp = bppOf(cf);
  if (bpp === undefined) return 0;
  if (off + 8 + len > bin.length) return 0;
  const raw = lz4Decode(bin.subarray(off + 8, off + 8 + len), w * h * bpp);
  let ink = 0;
  for (let j = 0; j < w * h; j++) {
    const b = j * bpp;
    if (b + bpp > raw.length) break;
    let r: number, g: number, bl: number, a: number;
    if (cf === 4) {
      [r, g, bl] = rgb565ToRgb(raw[b] | (raw[b + 1] << 8));
      a = 255;
    } else if (cf === 5) {
      [r, g, bl] = rgb565ToRgb(raw[b] | (raw[b + 1] << 8));
      a = raw[b + 2];
    } else {
      r = raw[b];
      g = raw[b + 1];
      bl = raw[b + 2];
      a = raw[b + 3];
    }
    if (a > 128 && r + g + bl > 60) ink++;
  }
  return ink;
}

/** Acha a ÚLTIMA ocorrência do delimitador `40 01 00` em [start,end). Port de find_delim. */
function findDelim(bin: Uint8Array, start: number, end: number): number | undefined {
  const e = Math.min(end, bin.length) - 2;
  let found: number | undefined;
  for (let i = start; i < e; i++) {
    if (bin[i] === 0x40 && bin[i + 1] === 0x01 && bin[i + 2] === 0x00) found = i;
  }
  return found;
}

/** Fim de um record = próximo `61 [01|0a|0b] 00` cujo ptr resolve p/ asset, ou cap. */
function nextRecordOr(bin: Uint8Array, from: number, cap: number, isAsset: (p: number) => boolean): number {
  const e = Math.min(cap, bin.length);
  let i = from;
  while (i + 7 <= e) {
    if (bin[i] === 0x61 && (bin[i + 1] === 0x01 || bin[i + 1] === 0x0a || bin[i + 1] === 0x0b) && bin[i + 2] === 0) {
      const ptr = u32le(bin, i + 3);
      if (isAsset(ptr)) return i;
    }
    i += 1;
  }
  return cap;
}

function mkLayer(partial: Partial<Layer> & Pick<Layer, "kind" | "name" | "cf" | "w" | "h" | "assetOff" | "assetLen">): Layer {
  return {
    x: 0, y: 0, pivotX: 0, pivotY: 0, visible: true, mock: "none",
    ...partial,
  };
}

/** Parseia o `.bin` estruturado em camadas editáveis. Port de parse_structured. */
export function parseStructured(bin: Uint8Array): StructDial {
  const assets = scanAssets(bin);
  const assetMap = new Map<number, [number, number, number, number]>(); // off -> [cf,w,h,len]
  for (const [o, cf, w, h, l] of assets) assetMap.set(o, [cf, w, h, l]);
  const firstAsset = assets.length ? assets.reduce((m, a) => Math.min(m, a[0]), Infinity) : bin.length;

  const perDialId = bin.length >= 4 ? u32le(bin, 0) : 0;
  const sizeA = bin.length >= 0x1c ? u32le(bin, 0x18) : 0;
  let name = "";
  {
    let end = 8;
    for (let k = 8; k < Math.min(bin.length, 0x18); k++) {
      if (bin[k] === 0) {
        end = k;
        break;
      }
      end = k + 1;
    }
    name = new TextDecoder().decode(bin.subarray(8, end));
  }

  const layers: Layer[] = [];
  const usedAssets = new Set<number>();

  // 1) Fundo.
  const full = assets.filter((a) => a[2] >= 440 && a[3] >= 440);
  const inkMax = (cands: ScannedAsset[]): ScannedAsset | undefined => {
    if (cands.length === 0) return undefined;
    let best = cands[0];
    let bestInk = assetInk(bin, best[0], best[1], best[2], best[3], best[4]);
    for (let k = 1; k < cands.length; k++) {
      const c = cands[k];
      const ink = assetInk(bin, c[0], c[1], c[2], c[3], c[4]);
      if (ink > bestInk) {
        best = c;
        bestInk = ink;
      }
    }
    return best;
  };

  let bgPick: ScannedAsset | undefined;
  let bgX = 0;
  let bgY = 0;
  if (full.length > 0) {
    bgPick = inkMax(full);
  } else {
    const art = assets.filter((a) => a[2] > 270 && a[3] > 270);
    const p = inkMax(art);
    if (p) {
      bgPick = p;
      bgX = Math.floor(Math.max(0, 466 - p[2]) / 2);
      bgY = Math.floor(Math.max(0, 466 - p[3]) / 2);
    } else {
      const jpegs = assets.filter((a) => a[1] === 1);
      if (jpegs.length) {
        bgPick = jpegs.reduce((m, a) => (a[2] * a[3] > m[2] * m[3] ? a : m), jpegs[0]);
      }
    }
  }
  if (bgPick) {
    const [off, cf, w, h, len] = bgPick;
    layers.push(mkLayer({
      kind: "background", name: "Fundo", cf, w, h, assetOff: off, assetLen: len, x: bgX, y: bgY,
    }));
    usedAssets.add(off);
  }

  // Frame-sheet do fundo + AOD.
  let bgFrames: Array<[number, number]> = [];
  let bgFrameIdx = 0;
  let aod: [number, number] | undefined;
  if (bgPick) {
    const [off, cf, w, h] = bgPick;
    const fr: Array<[number, number]> = assets
      .filter((a) => a[1] === cf && a[2] === w && a[3] === h)
      .map((a) => [a[0], a[4]] as [number, number]);
    fr.sort((a, b) => a[0] - b[0]);
    if (fr.length === 2) {
      const active = fr.find((x) => x[0] === off) ?? fr[0];
      const other = fr.find((x) => x[0] !== off);
      bgFrames = [active];
      bgFrameIdx = 0;
      aod = other;
    } else {
      bgFrames = fr;
      bgFrameIdx = Math.max(0, fr.findIndex((x) => x[0] === off));
    }
  }

  // 2) Pré-scan de NÓS DE GRUPO `68 [id] 00 48 15 00 [X][Y][W][H]`.
  const placed = new Set<string>();
  const groups: Array<[number, number, number, number, number]> = []; // [offset,x,y,w,h]
  {
    let g = 0x30;
    while (g + 14 < firstAsset) {
      if (bin[g] === 0x68 && bin[g + 2] === 0 && bin[g + 3] === 0x48 && bin[g + 4] === 0x15 && bin[g + 5] === 0x00) {
        const x = u16le(bin, g + 6);
        const y = u16le(bin, g + 8);
        const w = u16le(bin, g + 10);
        const h = u16le(bin, g + 12);
        if (w >= 1 && w <= 466 && h >= 1 && h <= 466 && x <= 466 && y <= 466) {
          groups.push([g, x, y, w, h]);
        }
      }
      g += 1;
    }
  }
  const groupOf = (o: number): number | undefined => {
    let best: number | undefined;
    for (let k = 0; k < groups.length; k++) {
      if (groups[k][0] <= o) best = k;
    }
    return best;
  };
  const inGroupBody = (o: number): boolean =>
    groups.some((gr) => {
      const len = u16le(bin, gr[0] + 1);
      return o >= gr[0] + 3 && o < gr[0] + 3 + len;
    });
  const digitGroups = new Map<number, Array<[number, number]>>(); // gk -> [(source, ptr)]

  const isAsset = (p: number) => assetMap.has(p);

  let i = 0x30;
  let idx = 0;
  while (i + 8 < firstAsset) {
    if (bin[i] === 0x61 && (bin[i + 1] === 0x01 || bin[i + 1] === 0x0a || bin[i + 1] === 0x0b) && bin[i + 2] === 0) {
      const ptr = u32le(bin, i + 3);
      const asset = assetMap.get(ptr);
      if (asset) {
        const [cf, w, h, alen] = asset;
        if (usedAssets.has(ptr)) {
          i += 1;
          continue;
        }
        if (inGroupBody(i)) {
          if (i >= 24 && (bin[i - 24] === 0x60 || bin[i - 24] === 0x30)) {
            const s = bin[i - 5];
            const gk = groupOf(i);
            if (gk !== undefined) {
              const arr = digitGroups.get(gk) ?? [];
              arr.push([s, ptr]);
              digitGroups.set(gk, arr);
            }
          }
          i += 1;
          continue;
        }
        const typ = bin[i + 1];
        const fullFrame = w >= 400 || (w === 270 && h === 270);
        const recEnd = nextRecordOr(bin, i + 3, firstAsset, isAsset);
        const has0505 = i + 13 <= bin.length && matchAt(bin, i + 9, [0x05, 0x05, 0x00, 0x01]);

        let kind: LayerKind = "other";
        let x = 0, y = 0, pivx = 0, pivy = 0;
        let xOff: number | undefined, yOff: number | undefined, pivxOff: number | undefined, pivyOff: number | undefined;

        const fullRec = has0505 && i + 27 <= bin.length && bin[i + 20] === 0x01 && bin[i + 21] === 0x1b && bin[i + 22] === 0x00;

        let sourceId: number | undefined;
        let mock: MockKind = "none";
        if (fullRec && !fullFrame) {
          const px = u16le(bin, i + 13);
          const py = u16le(bin, i + 15);
          const cx = u16le(bin, i + 23);
          const cy = u16le(bin, i + 25);
          if (px <= w + 4 && py <= h + 4 && cx <= 480 && cy <= 480) {
            const f3 = bin[i + 17];
            kind = f3 === 0x70 ? "pointer" : "image";
            pivx = px;
            pivy = py;
            x = cx;
            y = cy;
            pivxOff = i + 13;
            pivyOff = i + 15;
            xOff = i + 23;
            yOff = i + 25;
            if (kind === "pointer") {
              const s = bin[i + 36];
              sourceId = s;
              mock = pointerRole(s);
            }
          }
        }
        if ((typ === 0x0a || typ === 0x0b) && !fullFrame) {
          const dpos = findDelim(bin, i, recEnd);
          if (dpos !== undefined) {
            const b = dpos + 3; // marcador 82
            const rx = i16le(bin, b + 7);
            const ry = i16le(bin, b + 9);
            let ax = 0, ay = 0;
            if (b + 0x0f <= bin.length) {
              ax = i8(bin, b + 0x0c);
              ay = i8(bin, b + 0x0e);
            }
            const fx = ax < 0 ? 466 + rx - w : rx;
            const fy = ay < 0 ? 466 + ry - h : ry;
            if (fx >= 0 && fx <= 480 && fy >= 0 && fy <= 480) {
              kind = "text";
              x = fx;
              y = fy;
              if (ax >= 0 && ay >= 0) {
                xOff = b + 7;
                yOff = b + 9;
              }
            }
            if (b + 0x15 <= bin.length) {
              const id = bin[b + 0x14];
              if (id <= 0x8d) {
                sourceId = id;
                mock = mockFromSourceId(id);
              }
            }
          }
        }

        if (kind === "text" && mock === "none" && hasSeq(bin, i, recEnd, [0x28, 0x11, 0x00, 0x08, 0x0e, 0x00])) {
          mock = "seconds";
        }

        // dedup normal/AOD
        const key = `${ptr},${x},${y}`;
        if (kind !== "other") {
          if (placed.has(key)) {
            i += 1;
            continue;
          }
          placed.add(key);
        }
        const kname =
          kind === "pointer" ? `Ponteiro ${idx}`
          : kind === "text" ? `Texto ${idx}`
          : kind === "image" ? `Imagem ${idx}`
          : `Camada ${idx} (não-posicionada)`;
        layers.push(mkLayer({
          kind, name: kname, cf, w, h, assetOff: ptr, assetLen: alen,
          x, y, pivotX: pivx, pivotY: pivy, xOff, yOff, pivxOff, pivyOff, mock, sourceId,
        }));
        idx += 1;
      }
    }
    i += 1;
  }

  // GRUPO-DE-VALOR: um layer de texto por grupo 0x68 com filhos 0x60.
  const gks = [...digitGroups.keys()].sort((a, b) => a - b);
  const gplaced = new Set<string>();
  for (const gk of gks) {
    const kids = digitGroups.get(gk)!;
    if (kids.length === 0) continue;
    const [src0, ptr] = kids[0];
    const [, gx, gy, gw, gh] = groups[gk];
    const has = (lo: number, hi: number) => kids.some(([s]) => s >= lo && s <= hi);
    const isClock = has(0x01, 0x09) && has(0x0b, 0x0d);
    const mock: MockKind = isClock ? "time" : mockFromSourceId(src0);
    if (mock === "none") continue;
    const gkey = `${gx},${gy}`;
    if (gplaced.has(gkey)) continue;
    gplaced.add(gkey);
    const a = assetMap.get(ptr) ?? [5, gw, gh, 0];
    layers.push(mkLayer({
      kind: "text",
      name: isClock ? "Relógio (grupo)" : `${mock} (grupo)`,
      cf: a[0], w: a[1], h: a[2], assetOff: ptr, assetLen: a[3],
      x: gx, y: gy, mock, sourceId: src0,
    }));
  }

  // FALLBACK: texto sem fonte → o maior perto do centro vira Time; os demais Generic.
  const hasTime = layers.some((l) => l.mock === "time" || l.mock === "hour" || l.mock === "minute" || l.mock === "seconds");
  let bigText: number | undefined;
  if (!hasTime) {
    let bestArea = -1;
    layers.forEach((l, k) => {
      if (l.kind === "text" && l.mock === "none" && l.x >= 120 && l.x <= 346) {
        const area = l.w * l.h;
        if (area > bestArea) {
          bestArea = area;
          bigText = k;
        }
      }
    });
  }
  layers.forEach((l, k) => {
    if (l.kind === "text" && l.mock === "none") {
      l.mock = k === bigText ? "time" : "generic";
    }
  });

  return { perDialId, name, sizeA, layers, raw: bin, bgFrames, bgFrameIdx, aod };
}

/** Score de completude do render (p/ ordenar templates). Port de StructDial::completeness. */
export function completeness(dial: StructDial): number {
  let s = 0;
  const bg = dial.layers.find((l) => l.kind === "background");
  if (bg) {
    if (bg.w >= 440 && bg.h >= 440) s += 100;
    else if (bg.w > 0) s += 60;
  }
  for (const l of dial.layers) {
    if (l.kind === "pointer") s += 12;
    else if (l.kind === "image") s += 6;
    else if (l.kind === "text") {
      s += 3;
      if (l.mock !== "none" && l.mock !== "generic") s += 5;
    }
  }
  if (dial.bgFrames.length > 1) s += 8;
  return s;
}

/** Mostra a variante AOD do fundo (on) ou volta ao ativo (off). Preview-only. */
export function setAod(dial: StructDial, on: boolean): void {
  const target = on ? dial.aod : dial.bgFrames[dial.bgFrameIdx];
  if (target) {
    const bg = dial.layers.find((l) => l.kind === "background");
    if (bg) {
      bg.assetOff = target[0];
      bg.assetLen = target[1];
    }
  }
}

/** Troca o frame de FUNDO exibido (preview-only). */
export function setBgFrame(dial: StructDial, idx: number): void {
  if (idx >= dial.bgFrames.length) return;
  dial.bgFrameIdx = idx;
  const [off, len] = dial.bgFrames[idx];
  const bg = dial.layers.find((l) => l.kind === "background");
  if (bg) {
    bg.assetOff = off;
    bg.assetLen = len;
  }
}
