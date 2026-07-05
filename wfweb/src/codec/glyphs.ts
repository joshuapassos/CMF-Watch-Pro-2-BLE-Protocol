// Desenho vetorial de dígitos (puro, sem DOM) p/ trocar a FONTE de um atlas de dígitos re-skinando
// cada glifo in-place. O estilo "7-seg" mora aqui; fontes reais (sans/mono/serif) usam canvas em
// imageutil.renderFontGlyph. Compartilhado com scripts/gen-*.
export type RGB = [number, number, number];

function fillRoundRect(px: Uint8ClampedArray, W: number, H: number, x: number, y: number, w: number, h: number, r: number, c: RGB, alpha = 255) {
  const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
    const dx = Math.min(xx - x0, x1 - 1 - xx), dy = Math.min(yy - y0, y1 - 1 - yy);
    if (dx < r && dy < r) { const ex = r - dx, ey = r - dy; if (ex * ex + ey * ey > r * r) continue; }
    const o = (yy * W + xx) * 4; const a = alpha / 255;
    px[o] = Math.round(c[0] * a + px[o] * (1 - a)); px[o + 1] = Math.round(c[1] * a + px[o + 1] * (1 - a));
    px[o + 2] = Math.round(c[2] * a + px[o + 2] * (1 - a)); px[o + 3] = Math.max(px[o + 3], alpha);
  }
}

// segmentos a,f,b,g,e,c,d
const SEG: Record<number, number[]> = {
  0: [1, 1, 1, 0, 1, 1, 1], 1: [0, 0, 1, 0, 0, 1, 0], 2: [1, 0, 1, 1, 1, 0, 1], 3: [1, 0, 1, 1, 0, 1, 1],
  4: [0, 1, 1, 1, 0, 1, 0], 5: [1, 1, 0, 1, 0, 1, 1], 6: [1, 1, 0, 1, 1, 1, 1], 7: [1, 0, 1, 0, 0, 1, 0],
  8: [1, 1, 1, 1, 1, 1, 1], 9: [1, 1, 1, 1, 0, 1, 1],
};

/** Quantiza o canal ALPHA de um RGBA em `levels` níveis (2 = binário on/off). Bordas suaves têm
 *  muitos valores de alpha distintos → LZ4 grande; reduzir os níveis encolhe o glifo p/ caber no slot,
 *  mantendo o dígito legível. `levels>=256` devolve o original. */
export function quantizeAlpha(rgba: Uint8ClampedArray, levels: number): Uint8ClampedArray {
  if (levels >= 256) return rgba;
  const n = Math.max(1, levels - 1);
  const out = new Uint8ClampedArray(rgba);
  for (let i = 3; i < out.length; i += 4) out[i] = Math.round(Math.round((rgba[i] / 255) * n) / n * 255);
  return out;
}

/** Dígito 7-seg (ou ':' quando ch===10) em RGBA w×h, cor `c`, fundo transparente. `thick` = fração da
 *  menor dimensão p/ a espessura da barra (0.15 = cheio; menor = fino, comprime menos → cabe em slot
 *  apertado sem perder a cara de 7-seg). */
export function draw7Seg(w: number, h: number, ch: number, c: RGB, thick = 0.15): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  if (ch === 10) { // ':'
    const r = Math.max(2, Math.round(w * Math.min(0.16, thick + 0.02))), cx = w / 2;
    for (const cy of [h * 0.32, h * 0.68]) fillRoundRect(px, w, h, cx - r, cy - r, 2 * r, 2 * r, r, c);
    return px;
  }
  const s = SEG[ch]; if (!s) return px;
  const m = Math.min(w, h), t = Math.max(2, Math.round(m * thick));
  const padX = Math.round(w * 0.2), padY = Math.round(h * 0.12);
  const x1 = padX, x2 = w - padX, y1 = padY, y2 = h - padY, ym = h / 2;
  const hbar = (xa: number, xb: number, y: number) => fillRoundRect(px, w, h, xa, y - t / 2, xb - xa, t, t / 2, c);
  const vbar = (x: number, ya: number, yb: number) => fillRoundRect(px, w, h, x - t / 2, ya, t, yb - ya, t / 2, c);
  if (s[0]) hbar(x1, x2, y1); if (s[1]) vbar(x1, y1, ym); if (s[2]) vbar(x2, y1, ym);
  if (s[3]) hbar(x1, x2, ym); if (s[4]) vbar(x1, ym, y2); if (s[5]) vbar(x2, ym, y2); if (s[6]) hbar(x1, x2, y2);
  return px;
}
