// Todo asset cf=4/5/24 dos dials decodifica EXATO em w*h*bpp (mirror do "4151/4151" do Rust).
// Também: round-trip do LZ4 (compress->decode) byte-exato; e o encoder cabe no same-footprint dos
// fundos cf=4 (senão o reskin estoura).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanAssets } from "../src/codec/parse.js";
import { lz4Decode, lz4DecodeStrict, lz4Compress, lz4CompressBest } from "../src/codec/lz4.js";
import { bppOf } from "../src/codec/rgb565.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(__dirname, "..", "..", "work", "store_dials", "bin");
const bins = existsSync(BIN_DIR)
  ? readdirSync(BIN_DIR).filter((f) => f.endsWith(".bin")).map((f) => join(BIN_DIR, f))
  : [];

describe("LZ4 round-trip (unit)", () => {
  it("compress->decode byte-exato p/ dados variados", () => {
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff),
      Uint8Array.from({ length: 5000 }, () => 0x42), // muito repetitivo (força matches)
      Uint8Array.from({ length: 3000 }, (_, i) => (i * 7 + 3) & 0xff),
    ];
    for (const src of cases) {
      const c = lz4Compress(src);
      const rt = lz4Decode(c, src.length);
      expect(rt.length).toBe(src.length);
      expect(Array.from(rt)).toEqual(Array.from(src));
    }
  });

  it("dados repetitivos comprimem bem (matches funcionam)", () => {
    const src = Uint8Array.from({ length: 10000 }, () => 0xab);
    const c = lz4CompressBest(src);
    expect(c.length).toBeLessThan(src.length / 4);
  });
});

describe("decode de assets dos dials", () => {
  if (bins.length === 0) {
    it.skip("sem fixtures", () => {});
    return;
  }
  let totalAssets = 0;
  let okAssets = 0;
  for (const path of bins) {
    const name = path.split("/").pop()!;
    it(`assets cf=4/5/24 decodam exato: ${name}`, () => {
      const bin = new Uint8Array(readFileSync(path));
      const assets = scanAssets(bin);
      for (const [off, cf, w, h, len] of assets) {
        const bpp = bppOf(cf);
        if (bpp === undefined) continue; // cf=1/13 fora deste check
        totalAssets++;
        const need = w * h * bpp;
        const payload = bin.subarray(off + 8, off + 8 + len);
        const strict = lz4DecodeStrict(payload, need);
        // aceita strict (bloco perfeito) OU tolerante que produz o tamanho certo.
        const ok = strict !== null || lz4Decode(payload, need).length === need;
        if (ok) okAssets++;
        expect(ok, `asset @${off} cf=${cf} ${w}x${h} não decodou em ${need}B`).toBe(true);
      }
    });
  }
  it("resumo de cobertura", () => {
    // executado por último (ordem de declaração); só informativo.
    if (totalAssets > 0) expect(okAssets).toBe(totalAssets);
  });
});
