// Mapeamento StructDial <-> Notation JSON (a fonte de verdade legível da UI).
// A notação carrega geometria/fonte/visibilidade (editáveis por texto) + assets (PNG data-URL,
// editáveis pela barra de imagens). Aplicar a notação de volta reescreve os campos in-place.
import { mockToSource, sourceToMock } from "./mock.js";
import { decodeAssetToRgba } from "./rgb565.js";
import { atlasGlyphs } from "./render.js";
import type { Notation, NotationLayer, StructDial } from "./types.js";

/** Converte um RgbaImage-like em PNG data-URL (só no browser). null em node/testes. */
export type RgbaToDataUrl = (data: Uint8ClampedArray, w: number, h: number) => string;

function keyForLayer(layer: { kind: string }, i: number): string {
  if (layer.kind === "background") return "bg";
  return `${layer.kind}_${i}`;
}

/** Gera a notação JSON a partir de um dial parseado. `toDataUrl` preenche o preview dos assets. */
export function buildNotation(dial: StructDial, toDataUrl?: RgbaToDataUrl): Notation {
  const assets: Notation["assets"] = {};
  const offToKey = new Map<number, string>();
  const layers: NotationLayer[] = [];

  dial.layers.forEach((l, i) => {
    let assetKey = offToKey.get(l.assetOff);
    if (assetKey === undefined) {
      assetKey = keyForLayer(l, i);
      offToKey.set(l.assetOff, assetKey);
      let atlas: number | undefined;
      if (l.kind === "text") {
        const g = atlasGlyphs(dial, l.assetOff, 12);
        if (g.length >= 10) atlas = g.length;
      }
      let src = "";
      if (toDataUrl && l.cf !== 1) {
        // decodifica só o asset da própria camada.
        const payload = l.newPayload ?? dial.raw.subarray(l.assetOff + 8, l.assetOff + 8 + l.assetLen);
        const rgba = decodeAssetToRgba(payload, l.cf, l.w, l.h);
        src = toDataUrl(rgba, l.w, l.h);
      }
      assets[assetKey] = { cf: l.cf, w: l.w, h: l.h, src, ...(atlas ? { atlas } : {}) };
    }
    layers.push({
      type: l.kind,
      asset: assetKey,
      x: l.x,
      y: l.y,
      ...(l.pivotX || l.pivotY ? { pivotX: l.pivotX, pivotY: l.pivotY } : {}),
      ...(mockToSource(l.mock) ? { source: mockToSource(l.mock) } : {}),
      ...(l.visible ? {} : { visible: false }),
    });
  });

  return {
    format: "cmf-wf/1",
    id: dial.perDialId,
    name: dial.name,
    size: [466, 466],
    assets,
    layers,
  };
}

/**
 * Aplica a notação (geometria/fonte/visibilidade) de volta ao dial, casando camadas por ORDEM.
 * Não mexe em pixels (isso vem da barra de imagens). Retorna a lista de avisos (mismatches).
 */
export function applyNotation(dial: StructDial, notation: Notation): string[] {
  const warnings: string[] = [];
  if (notation.layers.length !== dial.layers.length) {
    warnings.push(
      `nº de camadas da notação (${notation.layers.length}) ≠ do dial (${dial.layers.length}); ` +
        `casando por ordem até o menor.`,
    );
  }
  const n = Math.min(notation.layers.length, dial.layers.length);
  for (let i = 0; i < n; i++) {
    const nl = notation.layers[i];
    const l = dial.layers[i];
    if (nl.type !== l.kind) {
      warnings.push(`camada ${i}: tipo "${nl.type}" ≠ "${l.kind}" — só geometria aplicada.`);
    }
    if (typeof nl.x === "number") l.x = nl.x | 0;
    if (typeof nl.y === "number") l.y = nl.y | 0;
    if (typeof nl.pivotX === "number") l.pivotX = nl.pivotX | 0;
    if (typeof nl.pivotY === "number") l.pivotY = nl.pivotY | 0;
    if (nl.source !== undefined) l.mock = sourceToMock(nl.source);
    if (typeof nl.visible === "boolean") l.visible = nl.visible;
  }
  return warnings;
}
