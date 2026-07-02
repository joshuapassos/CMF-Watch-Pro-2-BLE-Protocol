// Parser do dial ESTRUTURADO. Port fiel de watchface_struct.rs:316-833.
import { u16le, u32le, i16le, i8, hasSeq, matchAt } from "./bytes.js";
import { lz4Decode, lz4DecodeStrict } from "./lz4.js";
import { rgb565ToRgb, bppOf, decodedSize } from "./rgb565.js";
import { mockFromSourceId, pointerRole, digitForSource } from "./mock.js";
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

/**
 * Drawable extraído da CENA TLV (spec 26 / SDK Actions). Corpo de folha 0x30/0x38/0x70:
 * `01 xx 00 [X u16][Y u16] …attrs… 61 [count u16][base u32][count×id u16] [05 05 00 01 pivX pivY]`
 * (X,Y = canto sup-esq; pivô só em ponteiro; fonte do ponteiro = `[src] 00 3c 00` antes da tabela).
 * O scan plano de `61 01 00` misturava campos de nós ADJACENTES (frame-table do elemento N +
 * X/Y do N+1) — este walker lê cada corpo dentro da própria janela TLV.
 */
export interface SceneDrawable {
  tag: number;
  x: number;
  y: number;
  xOff: number;
  yOff: number;
  assetOff: number;
  frameCount: number;
  pivotX?: number;
  pivotY?: number;
  pivxOff?: number;
  pivyOff?: number;
  sourceId?: number;
  /** Há um attr-block `40 01 00 82 …` no corpo? (fonte veio de `82+0x14`, não do inline `+0x10`). */
  hasAttr?: boolean;
  /** Dimensões do rect (usado p/ arco vetorial compacto, que não tem asset). */
  w?: number;
  h?: number;
  /** Anel de progresso (0x81): setor = valor/max. `color`=arco vetorial compacto; senão disco texturizado. */
  arc?: { max: number; color?: [number, number, number]; width?: number; colorOff?: number };
}

const SCENE_DRAWABLE_TAGS = new Set([0x30, 0x38, 0x70]);

/** Frame-table `61 [count u16][base u32][ids]` dentro do corpo de um drawable; base = asset válido. */
function findFrameTable(bin: Uint8Array, body: number, ln: number, isAsset: (p: number) => boolean): { at: number; count: number; base: number } | null {
  for (let k = 6; k + 9 <= ln; k++) {
    if (bin[body + k] !== 0x61) continue;
    const c = u16le(bin, body + k + 1);
    if (c < 1 || c > 130) continue;
    const b0 = u32le(bin, body + k + 3);
    if (isAsset(b0)) return { at: k, count: c, base: b0 };
  }
  return null;
}

export function scanSceneDrawables(bin: Uint8Array, isAsset: (p: number) => boolean): SceneDrawable[] {
  const out: SceneDrawable[] = [];
  if (bin.length < 0x2a || bin[0x24] !== 0x20) return out; // sem envelope → scan plano
  const sceneEnd = Math.min(0x27 + u16le(bin, 0x25), bin.length);
  // (ox,oy) = origem do container/grupo (rect do 0x68) herdada pelos filhos posicionados.
  const walk = (off: number, end: number, ox: number, oy: number, inGroup: boolean): void => {
    let i = off;
    while (i + 3 <= end) {
      const tag = bin[i];
      const ln = u16le(bin, i + 1);
      const body = i + 3;
      if (body + ln > end) return; // janela malformada — aborta este nível
      if (tag === 0x20 || tag === 0x21) {
        walk(body, body + ln, ox, oy, inGroup);
        // 0x22 (AOD) fica fora do walker.
      } else if (tag === 0x68) {
        // GRUPO (SDK sty_group_t): filhos posicionais distribuídos pelo firmware (spec 25 §6/§7).
        // Não emitimos como drawables (regride 357/376 — colidem com sprites top-level). Recursa só.
        walk(body, body + ln, ox, oy, true);
      } else if (tag === 0x81 && ln >= 12 && bin[body] === 0x01) {
        // ANEL DE PROGRESSO (spec 25 §2 revisado pelo RE do 322): 0x81 = 1 disco cf5 (count=1)
        // recortado num SETOR em runtime (frac=valor/max, horário das 12h). NÃO é frame-sheet.
        // Deve rodar mesmo inGroup (a fatia vive dentro de um 0x68). Sub 0x01 = geometria+frame,
        // sub 0x5b = params (max @+4). Confirmado em 20 dials.
        const c = body + 3; // conteúdo do sub-record 0x01
        const c1len = u16le(bin, body + 1);
        let ax = u16le(bin, c);
        let ay = u16le(bin, c + 2);
        const aw = u16le(bin, c + 4);
        const ah = u16le(bin, c + 6);
        const ftbl = findFrameTable(bin, body, c1len + 3, isAsset);
        // Forma PURA-COMPACTA (371/364/366/372, RE 02/07): SEM frame-table — é um arco VETORIAL de
        // cor sólida (não disco texturizado). Assinatura `01 ff` em content+11..12; cor RGB em
        // content+8..10 (provado: 3 anéis coloridos sobre o bezel = img/371.png).
        const compact = !ftbl && bin[c + 11] === 0x01 && bin[c + 12] === 0xff;
        if ((ftbl || compact) && aw >= 1 && aw <= 480 && ah >= 1 && ah <= 480) {
          if (ax === 0 && aw >= 200) ax = Math.floor((466 - aw) / 2); // disco/anel grande centrado
          if (ay === 0 && ah >= 200) ay = Math.floor((466 - ah) / 2);
          let max = 100;
          let width: number | undefined;
          let r = c1len + 3; // sub-records após o 0x01
          while (r + 3 <= ln) {
            const t = bin[body + r];
            const l = u16le(bin, body + r + 1);
            if (r + 3 + l > ln) break;
            if (t === 0x5b && l >= 6) {
              max = u16le(bin, body + r + 3 + 4) || 100;
              if (l >= 13) width = bin[body + r + 3 + 12] || undefined; // largura da linha (0x5b+12)
            }
            r += 3 + l;
          }
          const color: [number, number, number] | undefined = compact
            ? [bin[c + 8], bin[c + 9], bin[c + 10]]
            : undefined;
          // Arcos compactos GROSSOS (width>24, ex. 364 w=35) pertencem a um estilo/variante não
          // exibido no preview ativo (364 é digital) — desenhá-los sobrepinta tudo. Só finos (anéis
          // de progresso reais: 371 w=6, 366 w=18, 372 w=4/7) são emitidos.
          if (!(compact && width !== undefined && width > 24)) {
            out.push({
              tag, x: ax, y: ay, xOff: c, yOff: c + 2, w: aw, h: ah,
              assetOff: ftbl ? ftbl.base : 0, frameCount: 1,
              arc: { max, color, width, colorOff: compact ? c + 8 : undefined },
            });
          }
        }
      } else if (!inGroup && SCENE_DRAWABLE_TAGS.has(tag) && ln >= 16 && bin[body] === 0x01) {
        const x = ox + u16le(bin, body + 3);
        const y = oy + u16le(bin, body + 5);
        // frame-table `61 [count][base][ids]` dentro do corpo.
        const ftbl = findFrameTable(bin, body, ln, isAsset);
        const ft = ftbl ? ftbl.at : -1;
        const count = ftbl ? ftbl.count : 0;
        const base = ftbl ? ftbl.base : 0;
        if (ft >= 0 && x <= 480 && y <= 480) {
          const d: SceneDrawable = { tag, x, y, xOff: body + 3, yOff: body + 5, assetOff: base, frameCount: count };
          // fonte de dado da COMPLICAÇÃO: attr-block `82` após o último `40 01 00` do corpo,
          // id em `82+0x14` (RE §4/§5 — mesmo layout do widget de texto).
          for (let k = ln - 3; k >= 6; k--) {
            if (bin[body + k] === 0x40 && bin[body + k + 1] === 0x01 && bin[body + k + 2] === 0x00) {
              d.hasAttr = true;
              const b82 = k + 3;
              if (b82 + 0x15 <= ln) {
                const id = bin[body + b82 + 0x14];
                if (id <= 0x8d) d.sourceId = id;
              }
              break;
            }
          }
          // Dígito img_number SEM attr-block (spec 25 §7): a fonte fica inline no cabeçalho de 21
          // bytes do corpo, em `body+0x10` (ex. 376/339 grandes dígitos: 0x08/0x09/0x0c/0x0d).
          if (!d.hasAttr && count > 1) {
            const s = bin[body + 0x10];
            if (s >= 1 && s <= 0x8d) d.sourceId = s;
          }
          if (tag === 0x70) {
            // pivô no trailer `05 05 00 01 [pivX][pivY]` (após a frame-table).
            for (let k = ft + 9; k + 8 <= ln; k++) {
              if (bin[body + k] === 5 && bin[body + k + 1] === 5 && bin[body + k + 2] === 0 && bin[body + k + 3] === 1) {
                d.pivotX = u16le(bin, body + k + 4);
                d.pivotY = u16le(bin, body + k + 6);
                d.pivxOff = body + k + 4;
                d.pivyOff = body + k + 6;
                break;
              }
            }
            // fonte de dado: `[src] 00 3c 00` (scale=60) antes da frame-table.
            for (let k = 8; k + 4 <= ft; k++) {
              if (bin[body + k] !== 0 && bin[body + k + 1] === 0 && bin[body + k + 2] === 0x3c && bin[body + k + 3] === 0) {
                d.sourceId = bin[body + k];
                break;
              }
            }
          }
          out.push(d);
        }
      }
      i = body + ln;
    }
  };
  walk(0x24, sceneEnd, 0, 0, false);
  return out;
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

  // CENA TLV (spec 26): fonte primária de imagens/ponteiros — sem o off-by-one do scan plano.
  const sceneDrawables = scanSceneDrawables(bin, isAsset);
  const sceneMode = sceneDrawables.length > 0;
  // Frames do sheet do fundo (variantes normal/AOD/estilo) — não desenhar de novo por cima.
  const bgFrameSet = new Set<number>(bgFrames.map(([o]) => o));
  if (aod) bgFrameSet.add(aod[0]);
  let idx = 0;
  if (sceneMode) {
    for (const d of sceneDrawables) {
      // ANEL DE PROGRESSO (0x81): tratado ANTES do guard de asset — o arco vetorial compacto
      // (371/364/366/372) não tem asset (assetOff=0). Disco texturizado (322) usa o asset.
      if (d.arc) {
        const key = `arc,${d.x},${d.y}`;
        if (placed.has(key)) continue;
        placed.add(key);
        const at = assetMap.get(d.assetOff);
        layers.push(mkLayer({
          kind: "arc", name: `Anel ${idx}`,
          cf: at ? at[0] : 5, w: d.w ?? (at ? at[1] : 0), h: d.h ?? (at ? at[2] : 0),
          assetOff: d.assetOff, assetLen: at ? at[3] : 0,
          x: d.x, y: d.y, mock: "percent", arcMax: d.arc.max,
          color: d.arc.color, arcWidth: d.arc.width, colorOff: d.arc.colorOff,
        }));
        idx += 1;
        continue;
      }
      if (usedAssets.has(d.assetOff)) continue; // fundo/frame já representado
      // frame-sheet (count>1): complicação fill por frame-index. Desenhável se a fonte de dado
      // decodificou (o frame do preview vem do valor mock). Atlas de dígito (10/11) fica com o
      // caminho de texto; fonte desconhecida → não desenhar (evita frame errado por cima da arte).
      const a = assetMap.get(d.assetOff);
      if (!a) continue;
      const [cf, w, h, alen] = a;
      // DÍGITO GRANDE img_number (count 10/11) SEM attr-block: cada frame do atlas é um glifo 0-9,
      // a fonte tens/units está inline (`body+0x10`). O caminho de imagem pula count 10/11 (fica
      // p/ texto) e o scan-plano de texto só pega atlas COM attr-block (284/351/367) — então o
      // atlas inline (376/339) não era desenhado. Emite como TEXTO (render escolhe o glifo pelo
      // dígito via digitForSource). Atlas in-group (357) nunca vira SceneDrawable (0x68 é pulado),
      // logo não há colisão com a grade nem com o anel de dias (0x30 top-level count=1).
      if ((d.frameCount === 10 || d.frameCount === 11) && d.tag !== 0x70
          && !d.hasAttr && d.sourceId !== undefined
          && digitForSource(d.sourceId, 0, 0, 0) !== null) {
        const key = `dig,${d.x},${d.y}`;
        if (!placed.has(key)) {
          placed.add(key);
          layers.push(mkLayer({
            kind: "text", name: `Dígito ${idx}`,
            cf, w, h, assetOff: d.assetOff, assetLen: alen,
            x: d.x, y: d.y, mock: mockFromSourceId(d.sourceId), sourceId: d.sourceId,
          }));
          idx += 1;
        }
        continue;
      }
      let sheetMock: MockKind = "none";
      if (d.frameCount > 1) {
        if (d.tag === 0x70 || d.frameCount === 10 || d.frameCount === 11) continue;
        sheetMock = d.sourceId !== undefined ? mockFromSourceId(d.sourceId) : "none";
        if (d.frameCount === 7 && sheetMock === "none") sheetMock = "weekday"; // sheet de 7 = dias
        // Flip-clock: sheet numérico grande de 12/13 frames sem source = HORA (frames 0..12).
        // Ex. 327 Digit Max (frame N = número N; frame=hora). watch_clock/img_number model.
        if (sheetMock === "none" && (d.frameCount === 12 || d.frameCount === 13) && (w >= 200 || h >= 200)) {
          sheetMock = "hour";
        }
        if (sheetMock === "none") continue;
      }
      if (d.tag !== 0x70 && bgFrameSet.has(d.assetOff)) continue; // variante do fundo
      // dedupe por rect: nós irmãos = variantes (normal/AOD/estilo) do MESMO elemento.
      // (NB: dedup por fonte p/ separar as 3 mãos foi testado e REGREDIU — no 371 as 3 mãos
      // reusam UM sprite longo de 466px; desenhar 3 mãos longas idênticas fica pior que 1.)
      const key = `${d.tag},${d.x},${d.y},${w},${h}`;
      if (placed.has(key)) continue;
      placed.add(key);
      const kind: LayerKind = d.tag === 0x70 ? "pointer" : "image";
      layers.push(mkLayer({
        kind,
        name: kind === "pointer" ? `Ponteiro ${idx}` : `Imagem ${idx}`,
        cf, w, h, assetOff: d.assetOff, assetLen: alen,
        x: d.x, y: d.y,
        pivotX: d.pivotX ?? 0, pivotY: d.pivotY ?? 0,
        xOff: d.xOff, yOff: d.yOff, pivxOff: d.pivxOff, pivyOff: d.pivyOff,
        mock: kind === "pointer" && d.sourceId !== undefined ? pointerRole(d.sourceId) : sheetMock,
        sourceId: d.sourceId,
        frames: d.frameCount > 1 ? d.frameCount : undefined,
      }));
      idx += 1;
    }
  }

  let i = 0x30;
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

        // Correção OFF-BY-ONE do atlas de dígito (spec 25 §7 / RE 282/284/302/351): o attr-block do
        // elemento fica IMEDIATAMENTE ANTES da sua frame-table `61 0a/0b`, mas o findDelim procura
        // pra FRENTE e pega o `82`/`40 01 00` do PRÓXIMO elemento → X/Y e fonte do vizinho (número
        // grande do 282 virava minuto; hora sumia em 334/307/320/359/290). A fonte correta é o
        // byte em `i-5`, X em `i-18`, Y em `i-16`. Assinatura: wrapper `0x60`/`0x30` em i-24 +
        // `00 01` em i-22..21 (ou o marcador `01 ff` em i-7 da variante colorida cf13). Verificado
        // em 13 dials: `i-5` é sempre a fonte certa; `forward` é sistematicamente deslocado.
        const precAttr = i >= 25 && (bin[i - 24] === 0x60 || bin[i - 24] === 0x30)
          && bin[i - 22] === 0x00 && bin[i - 21] === 0x01 && bin[i - 5] >= 1 && bin[i - 5] <= 0x8d;
        // Path colorido cf13 (`01 ff` em i-7): sempre corrige (validado — 351/284). Path `precAttr`
        // amplo mexe X/Y de records onde o forward acertou → só dispara quando o forward NÃO achou
        // fonte (o bug do "hora sumida": 334/307/320/359/290) — não regride quem já funcionava.
        const cf13Colored = i >= 18 && bin[i - 7] === 0x01 && bin[i - 6] === 0xff;
        if (kind === "text" && (cf13Colored || (sourceId === undefined && precAttr))) {
          x = u16le(bin, i - 18);
          y = u16le(bin, i - 16);
          const s = bin[i - 5];
          if (s >= 1 && s <= 0x8d) {
            sourceId = s;
            mock = mockFromSourceId(s);
          }
        }

        // Cor do elemento (spec 25 §5): no corpo `0x60`, `[RGB] 01 ff [src]` precede o `61 0a 00`
        // do scan em 10 bytes. Tinge a máscara A8 cf=13 (colorida em runtime). Validado nas cores
        // conhecidas de 284/288/298/303 (branco p/ dials de dígito branco).
        let color: [number, number, number] | undefined;
        let colorOff: number | undefined;
        let srcOff: number | undefined;
        if (kind === "text" && cf === 13 && i >= 10 && bin[i - 7] === 0x01 && bin[i - 6] === 0xff) {
          const rgb: [number, number, number] = [bin[i - 10], bin[i - 9], bin[i - 8]];
          if (rgb[0] + rgb[1] + rgb[2] > 0) { color = rgb; colorOff = i - 10; }
          if (sourceId !== undefined) srcOff = i - 5;
        }

        // Em sceneMode, imagens/ponteiros vêm da cena TLV — o scan plano só contribui TEXTO.
        if (sceneMode && kind !== "text") {
          i += 1;
          continue;
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
          x, y, pivotX: pivx, pivotY: pivy, xOff, yOff, pivxOff, pivyOff, mock, sourceId, color, colorOff, srcOff,
        }));
        idx += 1;
      }
    }
    i += 1;
  }

  // GRUPO-DE-VALOR: um layer de texto por grupo 0x68 com filhos 0x60.
  const gks = [...digitGroups.keys()].sort((a, b) => a - b);
  // Dials DOT-MATRIX (357 Silhouette 96 células, 281 Metaball) têm dezenas de grupos do MESMO
  // tamanho numa GRADE — não são um relógio de campos (h/m/s), são um display de matriz onde o
  // firmware acende UMA célula pelo horário. Não modelamos; emitir "12" em cada célula é pior que
  // nada. Detecta a grade por histograma de tamanho (≥8 grupos idênticos) — assim o relógio de
  // tamanho único de dials mistos (325 Metric) NÃO é suprimido.
  const sizeHist = new Map<string, number>();
  for (const gk of gks) {
    const gr = groups[gk];
    const k = `${gr[3]}x${gr[4]}`;
    sizeHist.set(k, (sizeHist.get(k) ?? 0) + 1);
  }
  const gplaced = new Set<string>();
  for (const gk of gks) {
    const gr = groups[gk];
    if ((sizeHist.get(`${gr[3]}x${gr[4]}`) ?? 0) >= 8) continue; // célula de matriz → não emite
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
