// Oráculo: parse -> encodeInPlace deve reproduzir o `.bin` byte-a-byte nos 103 dials da loja
// (mesmo invariante dos testes Rust scene_roundtrip_identity / build_reframe_identity).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseStructured } from "../src/codec/parse.js";
import { encodeInPlace } from "../src/codec/encode.js";
import { parseScene, serializeScene, firstAssetOff } from "../src/codec/scene.js";
import { u16le } from "../src/codec/bytes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(__dirname, "..", "..", "work", "store_dials", "bin");

function listBins(): string[] {
  if (!existsSync(BIN_DIR)) return [];
  return readdirSync(BIN_DIR)
    .filter((f) => f.endsWith(".bin"))
    .map((f) => join(BIN_DIR, f));
}

const bins = listBins();

describe("roundtrip parse->encodeInPlace (byte-idêntico)", () => {
  if (bins.length === 0) {
    it.skip("sem fixtures em work/store_dials/bin", () => {});
    return;
  }
  it(`tem ${bins.length} dials de fixture`, () => {
    expect(bins.length).toBeGreaterThan(50);
  });

  for (const path of bins) {
    const name = path.split("/").pop()!;
    it(`identidade: ${name}`, () => {
      const bin = new Uint8Array(readFileSync(path));
      const dial = parseStructured(bin);
      const out = encodeInPlace(dial);
      expect(out.length).toBe(bin.length);
      // comparação byte-a-byte
      let firstDiff = -1;
      for (let i = 0; i < bin.length; i++) {
        if (out[i] !== bin[i]) {
          firstDiff = i;
          break;
        }
      }
      expect(firstDiff, `diverge no offset ${firstDiff}`).toBe(-1);
    });
  }
});

describe("scene TLV roundtrip (parseScene->serializeScene)", () => {
  if (bins.length === 0) {
    it.skip("sem fixtures", () => {});
    return;
  }
  for (const path of bins) {
    const name = path.split("/").pop()!;
    it(`cena reproduz: ${name}`, () => {
      const bin = new Uint8Array(readFileSync(path));
      // só dials com envelope-cena 0x20 @0x24 (ignora stubs/photo).
      if (bin.length < 0x2a || bin[0x24] !== 0x20) {
        return;
      }
      const l0 = u16le(bin, 0x25);
      const sceneEnd = 0x27 + l0;
      const fa = firstAssetOff(bin);
      // a cena tem que fechar no início do pool.
      expect(sceneEnd).toBe(fa);
      const nodes = parseScene(bin, 0x24, sceneEnd);
      const reser = serializeScene(nodes[0]);
      const original = bin.subarray(0x24, sceneEnd);
      expect(reser.length).toBe(original.length);
      let diff = -1;
      for (let i = 0; i < original.length; i++) {
        if (reser[i] !== original[i]) {
          diff = i;
          break;
        }
      }
      expect(diff, `cena diverge no offset ${diff}`).toBe(-1);
    });
  }
});
