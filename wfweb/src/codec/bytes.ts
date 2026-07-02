// Helpers de leitura/escrita little-endian sobre Uint8Array (espelham u16le/u32le do Rust).

export function u16le(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

export function u32le(d: Uint8Array, o: number): number {
  // >>> 0 força unsigned 32-bit.
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

/** Lê u16 como inteiro com sinal (i16). */
export function i16le(d: Uint8Array, o: number): number {
  return (u16le(d, o) << 16) >> 16;
}

/** Lê u8 como inteiro com sinal (i8). */
export function i8(d: Uint8Array, o: number): number {
  return (d[o] << 24) >> 24;
}

export function writeU16le(d: Uint8Array, o: number, v: number): void {
  d[o] = v & 0xff;
  d[o + 1] = (v >>> 8) & 0xff;
}

export function writeU32le(d: Uint8Array, o: number, v: number): void {
  d[o] = v & 0xff;
  d[o + 1] = (v >>> 8) & 0xff;
  d[o + 2] = (v >>> 16) & 0xff;
  d[o + 3] = (v >>> 24) & 0xff;
}

/** true se `seq` aparece em `bin[start..end]`. */
export function hasSeq(bin: Uint8Array, start: number, end: number, seq: number[]): boolean {
  const e = Math.min(end, bin.length);
  if (seq.length === 0 || start + seq.length > e) return false;
  for (let p = start; p <= e - seq.length; p++) {
    let ok = true;
    for (let k = 0; k < seq.length; k++) {
      if (bin[p + k] !== seq[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** true se `bin[o..o+seq.length]` === seq. */
export function matchAt(bin: Uint8Array, o: number, seq: number[]): boolean {
  if (o + seq.length > bin.length) return false;
  for (let k = 0; k < seq.length; k++) if (bin[o + k] !== seq[k]) return false;
  return true;
}
