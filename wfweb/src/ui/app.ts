// App do editor — estado central + wiring dos painéis (camadas, inspector, notação, assets, canvas).
import "./styles.css";
import { parseStructured, setAod } from "../codec/parse.js";
import { renderAt, decodeLayer, type JpegCache } from "../codec/render.js";
import { encodeInPlace, setLayerImageRaster, isPhotoDial, buildPhotoDial, FULL_DIM, THUMB_DIM } from "../codec/encode.js";
import { buildNotation, applyNotation } from "../codec/notation.js";
import { MOCK_ALL, mockLabel } from "../codec/mock.js";
import type { Layer, MockKind, Notation, StructDial } from "../codec/types.js";
import { drawToCanvas, pointerToCanvas } from "./canvas.js";
import { readFileBytes, downloadBytes, outName } from "./fileio.js";
import { rgbaToDataUrl, fileToBitmap, bitmapToRgbaExact, bitmapToRgbaCoverSquare, jpegPayloadToRgba } from "./imageutil.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class App {
  dial?: StructDial;
  selected = -1;
  playing = false;
  simSeconds = 10 * 3600 + 8 * 60 + 30;
  jpegCache: JpegCache = new Map();
  private lastT = 0;
  private drag?: { startX: number; startY: number; layerX: number; layerY: number };

  // refs
  private canvas = $<HTMLCanvasElement>("preview");
  private layerList = $("layerList");
  private inspBody = $("inspBody");
  private assetBar = $("assetBar");
  private jsonText = $<HTMLTextAreaElement>("jsonText");
  private jsonError = $("jsonError");
  private clock = $("clock");
  private statusEl = $("status");

  constructor() {
    this.wire();
    this.tick = this.tick.bind(this);
  }

  private wire(): void {
    $<HTMLInputElement>("openBin").addEventListener("change", (e) => this.onOpenBin(e));
    $<HTMLInputElement>("openPhoto").addEventListener("change", (e) => this.onNewPhoto(e));
    $("btnExport").addEventListener("click", () => this.onExport());
    $("btnPlay").addEventListener("click", () => this.togglePlay());
    $("btnApplyJson").addEventListener("click", () => this.onApplyJson());
    $<HTMLInputElement>("chkAod").addEventListener("change", (e) => this.onAod((e.target as HTMLInputElement).checked));
    // drag na canvas
    this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", () => this.onPointerUp());
  }

  private status(msg: string, kind: "" | "ok" | "err" = ""): void {
    this.statusEl.className = `status ${kind}`;
    this.statusEl.innerHTML = msg;
  }

  // ---- Abrir .bin ----
  private async onOpenBin(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const bytes = await readFileBytes(file);
    if (isPhotoDial(bytes)) {
      this.status(
        "Este é um <b>photo-dial</b> (6c8dc4a5). O editor de camadas trabalha com dials " +
          "<b>estruturados</b>; use “🖼 Novo photo-dial” para criar um.",
        "err",
      );
      return;
    }
    try {
      const dial = parseStructured(bytes);
      this.dial = dial;
      this.selected = dial.layers.findIndex((l) => l.kind !== "background");
      await this.predecodeJpegs();
      this.enableUi(true);
      this.refreshAll();
      this.status(
        `Aberto <code>${file.name}</code> — id ${dial.perDialId}, “${dial.name}”, ${dial.layers.length} camadas.`,
        "ok",
      );
    } catch (err) {
      this.status(`Falha ao parsear: ${(err as Error).message}`, "err");
    }
  }

  private async predecodeJpegs(): Promise<void> {
    this.jpegCache.clear();
    if (!this.dial) return;
    for (const l of this.dial.layers) {
      if (l.cf === 1) {
        try {
          const payload = this.dial.raw.subarray(l.assetOff + 8, l.assetOff + 8 + l.assetLen);
          const data = await jpegPayloadToRgba(payload, l.w, l.h);
          this.jpegCache.set(l.assetOff, { w: l.w, h: l.h, data });
        } catch {
          /* frame JPEG inválido — ignora */
        }
      }
    }
  }

  private enableUi(on: boolean): void {
    for (const id of ["btnExport", "btnPlay", "btnApplyJson"]) ($(id) as HTMLButtonElement).disabled = !on;
    ($<HTMLInputElement>("chkAod")).disabled = !on || !this.dial?.aod;
  }

  // ---- Render ----
  private clockParts(): [number, number, number] {
    const t = Math.floor(this.simSeconds);
    return [Math.floor(t / 3600) % 24, Math.floor(t / 60) % 60, t % 60];
  }

  render(): void {
    if (!this.dial) return;
    const [hh, mm, ss] = this.clockParts();
    const img = renderAt(this.dial, hh, mm, ss, this.jpegCache);
    drawToCanvas(this.canvas, img);
    this.clock.textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  private refreshAll(): void {
    this.buildLayerList();
    this.buildInspector();
    this.buildAssetBar();
    this.refreshJson();
    this.render();
  }

  // ---- Painel de camadas ----
  private buildLayerList(): void {
    const d = this.dial;
    this.layerList.innerHTML = "";
    if (!d) return;
    d.layers.forEach((l, i) => {
      const li = document.createElement("li");
      if (i === this.selected) li.classList.add("sel");
      if (!l.visible) li.classList.add("hidden-layer");
      li.innerHTML = `<span>${iconFor(l.kind)}</span><span>${l.name}</span><span class="kind">${l.cf ? "cf" + l.cf : ""} ${l.w}×${l.h}</span>`;
      li.addEventListener("click", () => {
        this.selected = i;
        this.buildLayerList();
        this.buildInspector();
      });
      this.layerList.appendChild(li);
    });
  }

  // ---- Inspector ----
  private buildInspector(): void {
    const d = this.dial;
    const l = d?.layers[this.selected];
    if (!d || !l) {
      this.inspBody.className = "insp-empty";
      this.inspBody.textContent = "Selecione uma camada.";
      return;
    }
    this.inspBody.className = "";
    const movable = l.xOff !== undefined && l.yOff !== undefined;
    const pivotable = l.pivxOff !== undefined && l.pivyOff !== undefined;
    const frag = document.createElement("div");
    frag.innerHTML = `
      <div class="field"><label>Tipo</label><span>${iconFor(l.kind)} ${l.kind} · cf${l.cf} · ${l.w}×${l.h}</span></div>
      <div class="field"><label>X</label><input type="number" id="fX" value="${l.x}" ${movable ? "" : "disabled"}></div>
      <div class="field"><label>Y</label><input type="number" id="fY" value="${l.y}" ${movable ? "" : "disabled"}></div>
      <div class="field"><label>Pivot X</label><input type="number" id="fPX" value="${l.pivotX}" ${pivotable ? "" : "disabled"}></div>
      <div class="field"><label>Pivot Y</label><input type="number" id="fPY" value="${l.pivotY}" ${pivotable ? "" : "disabled"}></div>
      <div class="field"><label>Dado</label><select id="fMock"></select></div>
      <div class="field"><label>Visível</label><input type="checkbox" id="fVis" ${l.visible ? "checked" : ""}></div>
      <div class="field full"><button class="btn wide" id="fReplace">🖼 Trocar imagem…</button></div>
    `;
    this.inspBody.innerHTML = "";
    this.inspBody.appendChild(frag);

    const mockSel = $<HTMLSelectElement>("fMock");
    for (const m of MOCK_ALL) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = mockLabel(m);
      if (m === l.mock) opt.selected = true;
      mockSel.appendChild(opt);
    }

    const bindNum = (id: string, set: (v: number) => void) => {
      $<HTMLInputElement>(id).addEventListener("input", (e) => {
        set(parseInt((e.target as HTMLInputElement).value || "0", 10) | 0);
        this.render();
        this.refreshJson();
      });
    };
    bindNum("fX", (v) => (l.x = v));
    bindNum("fY", (v) => (l.y = v));
    bindNum("fPX", (v) => (l.pivotX = v));
    bindNum("fPY", (v) => (l.pivotY = v));
    mockSel.addEventListener("change", () => {
      l.mock = mockSel.value as MockKind;
      this.render();
      this.refreshJson();
    });
    $<HTMLInputElement>("fVis").addEventListener("change", (e) => {
      l.visible = (e.target as HTMLInputElement).checked;
      this.buildLayerList();
      this.render();
      this.refreshJson();
    });
    $("fReplace").addEventListener("click", () => this.replaceLayerImage(this.selected));
  }

  // ---- Barra de assets ----
  private buildAssetBar(): void {
    const d = this.dial;
    this.assetBar.innerHTML = "";
    if (!d) return;
    const seen = new Set<number>();
    d.layers.forEach((l, i) => {
      if (seen.has(l.assetOff)) return;
      seen.add(l.assetOff);
      const div = document.createElement("div");
      div.className = "asset";
      div.title = `${l.name} · cf${l.cf} · ${l.w}×${l.h} (${l.assetLen}B)`;
      if (l.cf === 1) {
        const cached = this.jpegCache.get(l.assetOff);
        if (cached) div.style.backgroundImage = `url(${rgbaToDataUrl(cached.data, cached.w, cached.h)})`;
      } else {
        const img = decodeLayer(d, l);
        const url = rgbaToDataUrl(img.data, img.w, img.h);
        const el = document.createElement("img");
        el.src = url;
        div.appendChild(el);
      }
      const cf = document.createElement("span");
      cf.className = "cf";
      cf.textContent = "cf" + l.cf;
      div.appendChild(cf);
      div.addEventListener("click", () => this.replaceLayerImage(i));
      this.assetBar.appendChild(div);
    });
  }

  // ---- Notação JSON ----
  private refreshJson(): void {
    if (!this.dial) return;
    const notation = buildNotation(this.dial); // sem data-urls (compacto)
    // remove `src` vazio p/ deixar o JSON legível.
    const json = JSON.stringify(notation, (k, v) => (k === "src" ? undefined : v), 2);
    this.jsonText.value = json;
    this.jsonError.hidden = true;
  }

  private onApplyJson(): void {
    if (!this.dial) return;
    let notation: Notation;
    try {
      notation = JSON.parse(this.jsonText.value);
    } catch (err) {
      this.jsonError.hidden = false;
      this.jsonError.textContent = "JSON inválido: " + (err as Error).message;
      return;
    }
    const warnings = applyNotation(this.dial, notation);
    this.jsonError.hidden = warnings.length === 0;
    if (warnings.length) this.jsonError.textContent = warnings.join("\n");
    this.buildLayerList();
    this.buildInspector();
    this.render();
    this.status("Notação aplicada.", "ok");
  }

  // ---- Troca de imagem de uma camada ----
  private replaceLayerImage(index: number): void {
    const d = this.dial;
    const l = d?.layers[index];
    if (!d || !l) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const bmp = await fileToBitmap(file);
        const rgba = bitmapToRgbaExact(bmp, l.w, l.h);
        const size = setLayerImageRaster(l, rgba);
        this.buildAssetBar();
        this.render();
        if (size > l.assetLen) {
          this.status(
            `Imagem trocada, mas comprime em ${size}B > ${l.assetLen}B do asset original — ` +
              `<b>não cabe no same-footprint</b>; exportação vai falhar até caber.`,
            "err",
          );
        } else {
          this.status(`Imagem trocada (${size}B ≤ ${l.assetLen}B). ✓`, "ok");
        }
      } catch (err) {
        this.status("Falha ao carregar imagem: " + (err as Error).message, "err");
      }
    });
    input.click();
  }

  // ---- AOD ----
  private onAod(on: boolean): void {
    if (!this.dial) return;
    setAod(this.dial, on);
    this.render();
  }

  // ---- Drag ----
  private onPointerDown(e: PointerEvent): void {
    const l = this.dial?.layers[this.selected];
    if (!l || l.xOff === undefined || l.yOff === undefined) return;
    const [x, y] = pointerToCanvas(this.canvas, e);
    this.drag = { startX: x, startY: y, layerX: l.x, layerY: l.y };
    this.canvas.classList.add("dragging");
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    const [x, y] = pointerToCanvas(this.canvas, e);
    ($("hover")).textContent = `${x}, ${y}`;
    if (!this.drag) return;
    const l = this.dial?.layers[this.selected];
    if (!l) return;
    l.x = Math.max(0, Math.min(465, this.drag.layerX + (x - this.drag.startX)));
    l.y = Math.max(0, Math.min(465, this.drag.layerY + (y - this.drag.startY)));
    this.render();
    const fx = document.getElementById("fX") as HTMLInputElement | null;
    const fy = document.getElementById("fY") as HTMLInputElement | null;
    if (fx) fx.value = String(l.x);
    if (fy) fy.value = String(l.y);
  }

  private onPointerUp(): void {
    if (this.drag) {
      this.drag = undefined;
      this.canvas.classList.remove("dragging");
      this.refreshJson();
    }
  }

  // ---- Animação ----
  private togglePlay(): void {
    this.playing = !this.playing;
    $("btnPlay").textContent = this.playing ? "⏸" : "▶";
    if (this.playing) {
      this.lastT = performance.now();
      requestAnimationFrame(this.tick);
    }
  }

  private tick(now: number): void {
    if (!this.playing) return;
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;
    this.simSeconds = (this.simSeconds + dt * 60) % (12 * 3600);
    this.render();
    requestAnimationFrame(this.tick);
  }

  // ---- Export .bin ----
  private onExport(): void {
    if (!this.dial) return;
    try {
      const bytes = encodeInPlace(this.dial);
      downloadBytes(bytes, outName(this.dial.perDialId, this.dial.name));
      this.status(`Exportado (${bytes.length}B). Instale pelo app/core (pipeline 0x9075).`, "ok");
    } catch (err) {
      this.status("Falha ao exportar: " + (err as Error).message, "err");
    }
  }

  // ---- Novo photo-dial ----
  private async onNewPhoto(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const bmp = await fileToBitmap(file);
      const full = bitmapToRgbaCoverSquare(bmp, FULL_DIM);
      const thumb = bitmapToRgbaCoverSquare(bmp, THUMB_DIM);
      const bytes = buildPhotoDial(full, thumb);
      downloadBytes(bytes, "meu_photo_dial.bin");
      this.status(
        `Photo-dial gerado (${bytes.length}B). Envie via pipeline 0x9063 (watchfaceId=0xFFFFFFFF).`,
        "ok",
      );
    } catch (err) {
      this.status("Falha ao gerar photo-dial: " + (err as Error).message, "err");
    }
  }
}

function iconFor(kind: Layer["kind"]): string {
  switch (kind) {
    case "background": return "🌄";
    case "image": return "🖼";
    case "pointer": return "🕳";
    case "text": return "🔢";
    default: return "▫";
  }
}
