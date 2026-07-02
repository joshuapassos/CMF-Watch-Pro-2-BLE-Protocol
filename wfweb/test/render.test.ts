// Smoke do render: renderAt compõe 466² e produz conteúdo (não fica tudo preto) p/ dials com fundo.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseStructured, completeness } from "../src/codec/parse.js";
import { renderAt, decodeLayer, CANVAS_DIM } from "../src/codec/render.js";
import { buildNotation, applyNotation } from "../src/codec/notation.js";
import { encodeInPlace } from "../src/codec/encode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(__dirname, "..", "..", "work", "store_dials", "bin");
const bins = existsSync(BIN_DIR)
  ? readdirSync(BIN_DIR).filter((f) => f.endsWith(".bin")).map((f) => join(BIN_DIR, f))
  : [];

function nonBlackFraction(data: Uint8ClampedArray): number {
  let nonBlack = 0;
  const px = data.length / 4;
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    if (data[o] > 8 || data[o + 1] > 8 || data[o + 2] > 8) nonBlack++;
  }
  return nonBlack / px;
}

describe("render smoke", () => {
  if (bins.length === 0) {
    it.skip("sem fixtures", () => {});
    return;
  }
  // pega dials com fundo full-frame (completeness alta) — devem renderizar conteúdo.
  const withBg = bins
    .map((p) => ({ p, dial: parseStructured(new Uint8Array(readFileSync(p))) }))
    .filter((x) => completeness(x.dial) >= 100)
    .slice(0, 20);

  it(`há dials de fundo full-frame p/ testar (${withBg.length})`, () => {
    expect(withBg.length).toBeGreaterThan(0);
  });

  for (const { p, dial } of withBg) {
    const name = p.split("/").pop()!;
    it(`render preserva o fundo: ${name}`, () => {
      const img = renderAt(dial, 10, 8, 30);
      expect(img.w).toBe(CANVAS_DIM);
      expect(img.h).toBe(CANVAS_DIM);
      // invariante: o render (fundo + sprites) tem pelo menos tanta "tinta" quanto o fundo sozinho
      // — blend só ADICIONA. Vale p/ fundos escuros (digitais) e claros (analógicos/arte).
      const bg = dial.layers.find((l) => l.kind === "background");
      if (!bg || bg.cf === 1) return; // sem fundo raster decodável → só validou as dimensões
      const bgImg = decodeLayer(dial, bg);
      const bgInk = nonBlackFraction(bgImg.data);
      expect(nonBlackFraction(img.data)).toBeGreaterThanOrEqual(bgInk * 0.9);
    });
  }
});

describe("notação round-trip (buildNotation->applyNotation não altera geometria)", () => {
  if (bins.length === 0) {
    it.skip("sem fixtures", () => {});
    return;
  }
  for (const p of bins.slice(0, 30)) {
    const name = p.split("/").pop()!;
    it(`notação idempotente: ${name}`, () => {
      const bin = new Uint8Array(readFileSync(p));
      const dial = parseStructured(bin);
      const notation = buildNotation(dial);
      const warns = applyNotation(dial, notation);
      // sem edições → aplicar a própria notação não deve mudar os bytes exportados.
      expect(warns.length).toBe(0);
      const out = encodeInPlace(dial);
      let diff = -1;
      for (let i = 0; i < bin.length; i++) if (out[i] !== bin[i]) { diff = i; break; }
      expect(diff).toBe(-1);
    });
  }
});
