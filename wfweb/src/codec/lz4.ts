// LZ4 block codec (port de watchface_struct.rs:250 + codec_dfa.py lz4_compress/lz4_decompress).
//
// O relógio usa LZ4-block padrão. Aqui:
//  - `lz4Decode`: decoder tolerante (aceita as variantes do app oficial). Sempre devolve `outSize` B.
//  - `lz4Compress`: encoder de bloco COM matches (greedy + hash), p/ manter same-footprint nos reskins.
//  - `lz4CompressLiteralsOnly`: fallback garantido-válido (1 bloco só de literais) — infla, mas o
//    relógio aceita (confirmado §24.4.3). `lz4CompressBest` escolhe o menor.

/** Decoder LZ4-block tolerante. Para quando `out` atinge `outSize`; preenche o resto com 0. */
export function lz4Decode(src: Uint8Array, outSize: number): Uint8Array {
  const out = new Uint8Array(outSize);
  let oi = 0;
  let i = 0;
  const n = src.length;
  while (i < n && oi < outSize) {
    const tok = src[i];
    i += 1;
    let lit = tok >> 4;
    if (lit === 15) {
      for (;;) {
        if (i >= n) return out; // já preenchido com 0 até outSize
        const b = src[i];
        i += 1;
        lit += b;
        if (b !== 255) break;
      }
    }
    const take = Math.min(lit, n - i);
    for (let k = 0; k < take && oi < outSize; k++) out[oi++] = src[i + k];
    i += lit;
    if (oi >= outSize || i + 2 > n) break;
    const off = src[i] | (src[i + 1] << 8);
    i += 2;
    let ml = tok & 0xf;
    if (ml === 15) {
      for (;;) {
        if (i >= n) break;
        const b = src[i];
        i += 1;
        ml += b;
        if (b !== 255) break;
      }
    }
    ml += 4;
    if (off === 0 || off > oi) break;
    let start = oi - off;
    for (let k = 0; k < ml && oi < outSize; k++) {
      out[oi++] = out[start + k];
    }
  }
  return out;
}

/**
 * Decode LZ4-block ESTRITO: devolve o buffer só se produzir EXATAMENTE `outSize` bytes num bloco
 * bem-formado (sem padding, sem overrun). Senão `null`. Usado p/ validar assets re-comprimidos
 * (sem o sig `1f 00 01 00`) em `scanAssets`. Espelha o `lz4_flex::block::decompress` do Rust.
 */
export function lz4DecodeStrict(src: Uint8Array, outSize: number): Uint8Array | null {
  const out = new Uint8Array(outSize);
  let oi = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const tok = src[i++];
    let lit = tok >> 4;
    if (lit === 15) {
      for (;;) {
        if (i >= n) return null;
        const b = src[i++];
        lit += b;
        if (b !== 255) break;
      }
    }
    if (i + lit > n || oi + lit > outSize) return null;
    for (let k = 0; k < lit; k++) out[oi++] = src[i + k];
    i += lit;
    if (oi === outSize) {
      // bloco termina com literais; ok se consumiu tudo.
      return i === n ? out : null;
    }
    if (i + 2 > n) return null;
    const off = src[i] | (src[i + 1] << 8);
    i += 2;
    let ml = tok & 0xf;
    if (ml === 15) {
      for (;;) {
        if (i >= n) return null;
        const b = src[i++];
        ml += b;
        if (b !== 255) break;
      }
    }
    ml += 4;
    if (off === 0 || off > oi || oi + ml > outSize) return null;
    const start = oi - off;
    for (let k = 0; k < ml; k++) out[oi++] = out[start + k];
    if (oi === outSize) return i === n ? out : null;
  }
  return oi === outSize ? out : null;
}

// ---- Encoder ----

const MIN_MATCH = 4;
const LAST_LITERALS = 5;
const MF_LIMIT = 12; // matches não podem começar nos últimos 12 bytes
const HASH_LOG = 16;
const HASH_SIZE = 1 << HASH_LOG;

function hash4(seq: number): number {
  // (seq * 2654435761) >>> (32 - HASH_LOG), em aritmética 32-bit.
  return (Math.imul(seq >>> 0, 2654435761) >>> (32 - HASH_LOG)) & (HASH_SIZE - 1);
}

function read32(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

/** Emite um comprimento de literais (>=15) como cadeia 255,255,...,rem. */
function pushLen(out: number[], len: number): void {
  while (len >= 255) {
    out.push(255);
    len -= 255;
  }
  out.push(len);
}

/**
 * Compressão LZ4-block com matches (greedy, hash simples). Formato padrão: token
 * `[litLen<<4 | (matchLen-4)]`, literais, offset u16 LE, extensões de length. Os últimos 5 bytes
 * são sempre literais (LASTLITERALS). Round-trip byte-exato com `lz4Decode`.
 */
export function lz4Compress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out: number[] = [];
  if (n < MF_LIMIT + 1) {
    return lz4CompressLiteralsOnly(src);
  }
  const hashTable = new Int32Array(HASH_SIZE).fill(-1);
  const matchLimit = n - LAST_LITERALS;
  const mfLimit = n - MF_LIMIT;
  let anchor = 0;
  let i = 0;

  while (i < mfLimit) {
    const seq = read32(src, i);
    const h = hash4(seq);
    const ref = hashTable[h];
    hashTable[h] = i;

    // match válido? mesmo 4-byte word, offset em janela (<=65535), e não é o próprio i.
    if (ref >= 0 && i - ref <= 65535 && read32(src, ref) === seq) {
      // estende o match para frente.
      let mlen = MIN_MATCH;
      while (i + mlen < matchLimit && src[ref + mlen] === src[i + mlen]) mlen++;

      const litLen = i - anchor;
      const offset = i - ref;

      // token
      const tokenPos = out.length;
      out.push(0); // placeholder
      let tok = 0;
      if (litLen >= 15) {
        tok |= 0xf0;
        out[tokenPos] = tok; // set high nibble antes de pushLen
        pushLen(out, litLen - 15);
      } else {
        tok |= litLen << 4;
      }
      // literais
      for (let k = 0; k < litLen; k++) out.push(src[anchor + k]);
      // offset LE
      out.push(offset & 0xff, (offset >>> 8) & 0xff);
      // match length
      const mlCode = mlen - MIN_MATCH;
      if (mlCode >= 15) {
        tok |= 0x0f;
        pushLen(out, mlCode - 15);
      } else {
        tok |= mlCode;
      }
      out[tokenPos] = tok;

      i += mlen;
      anchor = i;
    } else {
      i++;
    }
  }

  // último bloco: só literais (de anchor até o fim).
  const litLen = n - anchor;
  if (litLen >= 15) {
    out.push(0xf0);
    pushLen(out, litLen - 15);
  } else {
    out.push(litLen << 4);
  }
  for (let k = 0; k < litLen; k++) out.push(src[anchor + k]);

  return Uint8Array.from(out);
}

/** Encoder mínimo: 1+ blocos só de literais (sem matches). Sempre válido; infla ~0.4%. */
export function lz4CompressLiteralsOnly(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const n = src.length;
  if (n === 0) {
    out.push(0);
    return Uint8Array.from(out);
  }
  while (i < n) {
    const chunk = Math.min(n - i, 0xffffff);
    if (chunk < 15) {
      out.push(chunk << 4);
    } else {
      out.push(0xf0);
      pushLen(out, chunk - 15);
    }
    for (let k = 0; k < chunk; k++) out.push(src[i + k]);
    i += chunk;
  }
  return Uint8Array.from(out);
}

/** Escolhe a menor entre a compressão com matches e a literals-only. */
export function lz4CompressBest(src: Uint8Array): Uint8Array {
  const a = lz4Compress(src);
  // Round-trip de segurança: se o decode não bater, cai no literals-only.
  const rt = lz4Decode(a, src.length);
  let ok = rt.length === src.length;
  if (ok) {
    for (let k = 0; k < src.length; k++) {
      if (rt[k] !== src[k]) {
        ok = false;
        break;
      }
    }
  }
  if (!ok) return lz4CompressLiteralsOnly(src);
  return a;
}
