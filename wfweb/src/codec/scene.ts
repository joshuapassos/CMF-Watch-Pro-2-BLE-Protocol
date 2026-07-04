// Builder/parser do container-cena `0x20` (.wfdl). Port de watchface_struct.rs:1198-1378.
//
// A cena é um TLV aninhado limpo `[tag u8][len u16 LE][corpo]`. Containers (0x20/0x21/0x22/0x68)
// serializam os filhos; folhas (0x30/0x70/0x80/0x81/0x86…) carregam o corpo cru. O firmware EXIGE
// que o corpo @0x24 comece com o envelope `0x20` (senão grava erro 0x0a).
import { u16le, u32le, writeU16le, writeU32le } from "./bytes.js";
import { scanAssets } from "./parse.js";
import type { StructDial } from "./types.js";

export interface SceneNode {
  tag: number;
  leaf: Uint8Array; // corpo cru (folhas)
  children: SceneNode[]; // filhos (containers)
}

/** Tags tratadas como CONTAINER (recursão TLV). Espelha o walk do fw. */
export const CONTAINER_TAGS = new Set([0x20, 0x21, 0x22, 0x68]);

export function sceneContainer(tag: number, children: SceneNode[]): SceneNode {
  return { tag, leaf: new Uint8Array(0), children };
}

export function sceneLeaf(tag: number, body: Uint8Array): SceneNode {
  return { tag, leaf: body, children: [] };
}

/** Corpo serializado (SEM o próprio [tag][len]). */
function bodyBytes(node: SceneNode): Uint8Array {
  if (node.children.length === 0) return node.leaf;
  const parts = node.children.map(serializeScene);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** `[tag u8][len u16 LE][corpo]` com o `len` COMPUTADO a partir do corpo (nunca herdado). */
export function serializeScene(node: SceneNode): Uint8Array {
  const body = bodyBytes(node);
  const out = new Uint8Array(3 + body.length);
  out[0] = node.tag;
  writeU16le(out, 1, body.length);
  out.set(body, 3);
  return out;
}

export type WfdlError = "NotEnvelope" | "ChildOverflow" | "SceneMisaligned" | "Truncated";

export class WfdlValidationError extends Error {
  constructor(public code: WfdlError) {
    super(`WFDL: ${code}`);
  }
}

/** Início do pool de assets (= first_asset). bin.length se não há assets. */
export function firstAssetOff(bin: Uint8Array): number {
  const assets = scanAssets(bin);
  if (assets.length === 0) return bin.length;
  return assets.reduce((m, a) => Math.min(m, a[0]), Infinity);
}

/** Parseia a árvore-cena TLV em [off,end) (recursivo). Inverso de serializeScene. */
export function parseScene(bin: Uint8Array, off: number, end: number): SceneNode[] {
  const nodes: SceneNode[] = [];
  let i = off;
  while (i < end) {
    if (i + 3 > end) throw new WfdlValidationError("Truncated");
    const tag = bin[i];
    const ln = u16le(bin, i + 1);
    const body = i + 3;
    if (body + ln > end) throw new WfdlValidationError("ChildOverflow");
    let node: SceneNode;
    if (CONTAINER_TAGS.has(tag)) {
      node = sceneContainer(tag, parseScene(bin, body, body + ln));
    } else {
      node = sceneLeaf(tag, bin.slice(body, body + ln));
    }
    nodes.push(node);
    i = body + ln;
  }
  return nodes;
}

/**
 * Valida um `.bin` como o firmware faz ANTES de renderizar: corpo@0x24 começa com envelope `0x20`,
 * `0x27+L0` fecha no pool, e todo filho cabe na janela do pai. Lança WfdlValidationError.
 */
export function validateContainer(bin: Uint8Array): void {
  if (bin.length < 0x2a || bin[0x24] !== 0x20) throw new WfdlValidationError("NotEnvelope");
  const l0 = u16le(bin, 0x25);
  const fa = firstAssetOff(bin);
  if (0x27 + l0 !== fa) throw new WfdlValidationError("SceneMisaligned");
  const roots = parseScene(bin, 0x24, 0x27 + l0);
  if (!(roots.length > 0 && roots[0].tag === 0x20)) throw new WfdlValidationError("NotEnvelope");
}

export interface AssetBlock {
  cf: number;
  w: number;
  h: number;
  /** inclui o `1f 00 01 00` + bloco LZ4 (o que scan_assets conta como `len`). */
  payload: Uint8Array;
}

/** Empacota a dimsWord: cf nos 5 bits baixos, w<<10, h<<21. */
export function dimsWord(cf: number, w: number, h: number): number {
  return ((cf & 0x1f) | ((w & 0x7ff) << 10) | ((h & 0x7ff) << 21)) >>> 0;
}

/** Serializa o pool: cada asset = [dimsWord u32][len u32][payload], contíguo. */
export function serializePool(assets: AssetBlock[]): Uint8Array {
  const total = assets.reduce((s, a) => s + 8 + a.payload.length, 0);
  const pool = new Uint8Array(total);
  let o = 0;
  for (const a of assets) {
    writeU32le(pool, o, dimsWord(a.cf, a.w, a.h));
    writeU32le(pool, o + 4, a.payload.length);
    pool.set(a.payload, o + 8);
    o += 8 + a.payload.length;
  }
  return pool;
}

/** Offsets absolutos de cada asset no arquivo final, dado o tamanho do stream-cena. */
export function layoutPool(sceneLen: number, assets: AssetBlock[]): number[] {
  const offs: number[] = [];
  let off = 0x24 + sceneLen;
  for (const a of assets) {
    offs.push(off);
    off += 8 + a.payload.length;
  }
  return offs;
}

/** Monta o `.bin` a partir do stream-cena e do pool já serializados. scene DEVE começar com 0x20. */
export function buildContainerRaw(
  perDialId: number,
  name: string,
  idWord0: number,
  sceneBytes: Uint8Array,
  poolBytes: Uint8Array,
): Uint8Array {
  const firstAsset = 0x24 + sceneBytes.length;
  const filesize = firstAsset + poolBytes.length;
  const sizeA = filesize - 36;
  const sizeB = filesize - 36 - firstAsset;
  const out = new Uint8Array(filesize);
  writeU32le(out, 0, perDialId);
  writeU32le(out, 4, 1); // version = 1
  const nb = new TextEncoder().encode(name);
  const n = Math.min(nb.length, 15); // name[16], NUL-terminated
  out.set(nb.subarray(0, n), 8);
  writeU32le(out, 0x18, sizeA);
  writeU32le(out, 0x1c, sizeB);
  writeU32le(out, 0x20, idWord0);
  out.set(sceneBytes, 0x24);
  out.set(poolBytes, firstAsset);
  return out;
}

/** Resultado de um rebuild same-footprint (p/ o indicador de tamanho decidir se ativa). */
export interface RebuildResult {
  /** Bytes do `.bin` reconstruído (padded pro tamanho original); null se estourou o orçamento. */
  bytes: Uint8Array | null;
  /** Tamanho do CONTEÚDO real (sem padding) = 0x24 + cena + pool compactado. */
  contentSize: number;
  /** Orçamento = tamanho original do arquivo. contentSize ≤ budget ⇒ ativa (mesmo footprint). */
  budget: number;
}

/**
 * REBUILD "same-footprint estrutural": aplica delete/clone/add e reconstrói o `.bin` mantendo o
 * tamanho EXATO do original (o relógio só ativa dial do mesmo tamanho; crescer ⇒ a065=0x0a).
 *
 * Como fecha o footprint: (1) remove os nós `deleted` da cena; (2) insere clones (bytes provados do
 * nó-fonte, X/Y patchados); (3) COMPACTA o pool descartando só os assets dos elementos deletados que
 * ninguém mais referencia (libera espaço p/ as adições); (4) re-serializa a cena e reescreve CADA
 * ponteiro de asset (mapa old→new, pois o pool foi re-layoutado — não é mais delta uniforme);
 * (5) se o conteúdo ≤ original, faz PAD com zeros na cauda do pool até bater o tamanho original
 * (padding não-referenciado é ignorado pelo fw, igual a asset órfão). Se conteúdo > original, LANÇA
 * (estourou o orçamento). Detecção de ponteiro: `u32` na CENA que casa exato com um offset de asset.
 */
export function rebuildSameFootprint(dial: StructDial): RebuildResult {
  const raw = dial.raw;
  const budget = raw.length;
  const perDialId = raw.length >= 4 ? u32le(raw, 0) : 0;
  const idWord0 = raw.length >= 0x24 ? u32le(raw, 0x20) : 0;
  const assets = scanAssets(raw);
  if (assets.length === 0 || raw[0x24] !== 0x20) return { bytes: raw.slice(), contentSize: budget, budget };
  const firstAsset = assets.reduce((m, a) => Math.min(m, a[0]), raw.length);
  const oldOffs = new Set<number>(assets.map((a) => a[0]));

  const del = new Set(dial.layers.filter((l) => l.deleted && !l.isClone).map((l) => `${l.assetOff},${l.x},${l.y}`));
  const clones = dial.layers.filter((l) => l.isClone && !l.deleted);
  if (del.size === 0 && clones.length === 0) return { bytes: raw.slice(), contentSize: budget, budget };

  // chave de um nó-folha drawable: base da frame-table + X/Y do corpo.
  const leafKey = (n: SceneNode): string | null => {
    const b = n.leaf;
    if (b.length < 9 || b[0] !== 0x01) return null;
    for (let k = 6; k + 9 <= b.length; k++) {
      if (b[k] !== 0x61) continue;
      const c = u16le(b, k + 1);
      if (c < 1 || c > 130) continue;
      const base = u32le(b, k + 3);
      if (oldOffs.has(base)) return `${base},${u16le(b, 3)},${u16le(b, 5)}`;
    }
    return null;
  };

  const prune = (nodes: SceneNode[]): SceneNode[] =>
    nodes.filter((n) => {
      if (n.children.length > 0) {
        n.children = prune(n.children);
        return true;
      }
      const key = leafKey(n);
      return !(key !== null && del.has(key));
    });

  const roots = prune(parseScene(raw, 0x24, firstAsset));

  // INSERE clones (mesma lógica do Duplicate): copia os bytes do nó-fonte, patcha X/Y.
  const insertClone = (nodes: SceneNode[], srcKey: string, nx: number, ny: number): boolean => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.children.length > 0) {
        if (insertClone(n.children, srcKey, nx, ny)) return true;
        continue;
      }
      if (leafKey(n) === srcKey) {
        const leaf = n.leaf.slice();
        writeU16le(leaf, 3, nx);
        writeU16le(leaf, 5, ny);
        nodes.splice(i + 1, 0, { tag: n.tag, leaf, children: [] });
        return true;
      }
    }
    return false;
  };
  for (const cl of clones) if (cl.sourceKey) insertClone(roots, cl.sourceKey, cl.x, cl.y);

  // cena serializada (ponteiros ainda com offsets ANTIGOS).
  const parts = roots.map(serializeScene);
  const newScene = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  { let o = 0; for (const p of parts) { newScene.set(p, o); o += p.length; } }

  // POOL VERBATIM: mantém o pool inteiro byte-a-byte (gaps, cauda, assets não-mapeados — tudo
  // preservado), só relocado por um DELTA UNIFORME (a cena mudou de tamanho → o pool desliza). NÃO
  // compacta (compactar arriscaria dropar bytes que o scanAssets não reconhece, ex. gaps não-zero do
  // 342 ou a cauda de 36 B). Assets órfãos de um delete ficam (inofensivos: `len` limita a leitura).
  const newFirst = 0x24 + newScene.length;
  const delta = newFirst - firstAsset;
  if (delta !== 0) {
    for (let i = 0; i + 4 <= newScene.length; i++) {
      const v = u32le(newScene, i);
      if (oldOffs.has(v)) { writeU32le(newScene, i, v + delta); i += 3; }
    }
  }
  const poolVerbatim = raw.subarray(firstAsset);
  const contentSize = newFirst + poolVerbatim.length; // = budget + delta
  if (contentSize > budget) return { bytes: null, contentSize, budget }; // cresceu → estourou orçamento
  // pool verbatim + PAD com zeros na cauda até bater o tamanho original (mesmo footprint).
  const pool = new Uint8Array(budget - newFirst);
  pool.set(poolVerbatim, 0);
  const bytes = buildContainerRaw(perDialId, dial.name, idWord0, newScene, pool);
  return { bytes, contentSize, budget };
}

/** Compat: retorna só os bytes; lança se a estrutura estourou o orçamento (tamanho original). */
export function rebuildContainer(dial: StructDial): Uint8Array {
  const r = rebuildSameFootprint(dial);
  if (!r.bytes) {
    throw new Error(
      `estrutura excede o orçamento: ${r.contentSize} B > ${r.budget} B — delete/erase algo p/ liberar ` +
        `${r.contentSize - r.budget} B (o relógio só ativa dial do mesmo tamanho).`,
    );
  }
  return r.bytes;
}

/** Monta um dial estruturado DO ZERO: header + envelope-cena + pool. */
export function buildContainer(
  perDialId: number,
  name: string,
  idWord0: number,
  sceneRoot: SceneNode,
  assets: AssetBlock[],
): Uint8Array {
  const sceneBytes = serializeScene(sceneRoot);
  const poolBytes = serializePool(assets);
  return buildContainerRaw(perDialId, name, idWord0, sceneBytes, poolBytes);
}
