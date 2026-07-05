// Helpers de imagem baseados em <canvas> (browser). Conversão RGBA<->PNG, resize, decode JPEG.

/** Canvas offscreen reusável p/ conversões. */
function scratch(w: number, h: number): { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  return { cv, ctx };
}

/** Rasteriza um caractere (dígito ou ':') numa fonte real via canvas, RGBA w×h, fundo transparente,
 *  cor `color`, ocupando ~a altura toda e encolhendo se passar da largura. P/ trocar a fonte de um
 *  atlas de dígitos (re-skin glifo a glifo). `family` = qualquer font-family CSS. */
export function renderFontGlyph(ch: string, w: number, h: number, family: string, color: [number, number, number]): Uint8ClampedArray {
  const { ctx } = scratch(w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let size = Math.max(6, Math.floor(h * 0.92));
  ctx.font = `${size}px ${family}`; // peso normal (bold enche muito → não cabe no slot cf5)
  while (size > 6 && ctx.measureText(ch).width > w * 0.9) { size--; ctx.font = `${size}px ${family}`; }
  ctx.fillText(ch, w / 2, h / 2 + size * 0.03);
  return ctx.getImageData(0, 0, w, h).data;
}

/** RGBA (w*h*4) → PNG data-URL. */
export function rgbaToDataUrl(data: Uint8ClampedArray, w: number, h: number): string {
  const { cv, ctx } = scratch(w, h);
  const id = new ImageData(new Uint8ClampedArray(data), w, h);
  ctx.putImageData(id, 0, 0);
  return cv.toDataURL("image/png");
}

/** Carrega um File de imagem em ImageBitmap. */
export async function fileToBitmap(file: File | Blob): Promise<ImageBitmap> {
  return await createImageBitmap(file);
}

/** Desenha um bitmap redimensionado EXATO p/ w×h (stretch, = resize_exact) e devolve o RGBA. */
export function bitmapToRgbaExact(bmp: ImageBitmap, w: number, h: number): Uint8ClampedArray {
  const { ctx } = scratch(w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** Cobre um quadrado dim×dim recortando o centro (cover) e devolve o RGBA. P/ photo-dial. */
export function bitmapToRgbaCoverSquare(bmp: ImageBitmap, dim: number): Uint8ClampedArray {
  const { ctx } = scratch(dim, dim);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const scale = Math.max(dim / bmp.width, dim / bmp.height);
  const dw = bmp.width * scale;
  const dh = bmp.height * scale;
  ctx.drawImage(bmp, (dim - dw) / 2, (dim - dh) / 2, dw, dh);
  return ctx.getImageData(0, 0, dim, dim).data;
}

/** Cobre um retângulo w×h recortando o centro (object-fit: cover) — preserva o aspecto, corta o
 *  excesso. Diferente do `bitmapToRgbaExact` (que ESTICA e distorce). P/ inserir foto num slot. */
export function bitmapToRgbaCover(bmp: ImageBitmap, w: number, h: number): Uint8ClampedArray {
  const { ctx } = scratch(w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const scale = Math.max(w / bmp.width, h / bmp.height);
  const dw = bmp.width * scale;
  const dh = bmp.height * scale;
  ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return ctx.getImageData(0, 0, w, h).data;
}

/** Reescala um RGBA (ow×oh) p/ (nw×nh) via canvas (suave). P/ resize de elemento. */
export function rescaleRgba(data: Uint8ClampedArray | Uint8Array, ow: number, oh: number, nw: number, nh: number): Uint8ClampedArray {
  const src = scratch(ow, oh);
  src.ctx.putImageData(new ImageData(new Uint8ClampedArray(data), ow, oh), 0, 0);
  const dst = scratch(nw, nh);
  dst.ctx.imageSmoothingEnabled = true;
  dst.ctx.imageSmoothingQuality = "high";
  dst.ctx.drawImage(src.cv, 0, 0, nw, nh);
  return dst.ctx.getImageData(0, 0, nw, nh).data;
}

/** Sprite transparente sw×sh com `bmp` desenhado em (dx,dy) no tamanho dw×dh. P/ elemento no ponteiro. */
export function compositeImage(bmp: ImageBitmap, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): Uint8ClampedArray {
  const { ctx } = scratch(sw, sh);
  ctx.clearRect(0, 0, sw, sh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, dx, dy, dw, dh);
  return ctx.getImageData(0, 0, sw, sh).data;
}

/** Decodifica um payload JPEG (bytes) em RGBA w×h. */
export async function jpegPayloadToRgba(payload: Uint8Array, w: number, h: number): Promise<Uint8ClampedArray> {
  const blob = new Blob([payload.slice()], { type: "image/jpeg" });
  const bmp = await createImageBitmap(blob);
  return bitmapToRgbaExact(bmp, w, h);
}

/**
 * RGBA (w*h*4) → bytes JPEG, baixando a qualidade até caber em `maxBytes` (same-footprint por frame
 * de animação). Lança se não couber nem na qualidade mínima. cf=1 = JPEG cru (começa `ff d8`).
 */
export async function rgbaToJpeg(data: Uint8ClampedArray, w: number, h: number, maxBytes: number): Promise<Uint8Array> {
  const { cv, ctx } = scratch(w, h);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  const qualities = [0.92, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25, 0.15];
  let last = 0;
  for (const q of qualities) {
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/jpeg", q));
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    last = bytes.length;
    if (bytes.length <= maxBytes) return bytes;
  }
  throw new Error(`frame ${w}×${h} não cabe em ${maxBytes} B nem na qualidade mínima (${last} B)`);
}
