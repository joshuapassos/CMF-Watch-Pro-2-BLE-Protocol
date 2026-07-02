// Desenho do preview no <canvas> + conversão de coords ponteiro→canvas 466².
import type { RgbaImage } from "../codec/render.js";
import { CANVAS_DIM } from "../codec/render.js";

/** Escreve um RgbaImage 466² no canvas. */
export function drawToCanvas(canvas: HTMLCanvasElement, img: RgbaImage): void {
  const ctx = canvas.getContext("2d")!;
  const id = new ImageData(new Uint8ClampedArray(img.data), img.w, img.h);
  ctx.putImageData(id, 0, 0);
}

/** Converte um evento de ponteiro em coords do canvas 466² (0..465). */
export function pointerToCanvas(canvas: HTMLCanvasElement, ev: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const sx = CANVAS_DIM / rect.width;
  const sy = CANVAS_DIM / rect.height;
  const x = Math.round((ev.clientX - rect.left) * sx);
  const y = Math.round((ev.clientY - rect.top) * sy);
  return [Math.max(0, Math.min(CANVAS_DIM - 1, x)), Math.max(0, Math.min(CANVAS_DIM - 1, y))];
}
