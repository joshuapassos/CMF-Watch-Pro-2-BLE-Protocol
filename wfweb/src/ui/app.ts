// App do editor — estado central + wiring dos painéis (camadas, inspector, notação, assets, canvas).
import "./styles.css";
import { parseStructured, setAod } from "../codec/parse.js";
import { renderAt, decodeLayer, type JpegCache } from "../codec/render.js";
import { encodeInPlace, setLayerImageRaster, isPhotoDial, buildPhotoDial, FULL_DIM, THUMB_DIM } from "../codec/encode.js";
import { rebuildContainer, validateContainer } from "../codec/scene.js";
import { buildNotation, applyNotation } from "../codec/notation.js";
import { MOCK_ALL, mockLabel, DATA_SOURCES, mockFromSourceId, pointerRole } from "../codec/mock.js";
import { simEnv } from "../codec/mock.js";
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
  private undoStack: Layer[][] = [];
  private redoStack: Layer[][] = [];
  private zoom = 1;
  private guides: Array<{ x?: number; y?: number }> = [];

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
    // zoom (ctrl/⌘ + roda) na canvas
    $("stage").addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.zoom = Math.max(0.5, Math.min(4, this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      this.canvas.style.transform = `scale(${this.zoom})`;
    }, { passive: false });
    // undo/redo
    window.addEventListener("keydown", (e) => {
      const z = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z";
      const y = (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"));
      if (y) { e.preventDefault(); this.redo(); }
      else if (z) { e.preventDefault(); this.undo(); }
    });
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
        "This is a <b>photo dial</b> (6c8dc4a5). The layer editor works with <b>structured</b> " +
          "dials; use \u201c🖼 New photo dial\u201d to create one.",
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
        `Opened <code>${file.name}</code> — id ${dial.perDialId}, \u201c${dial.name}\u201d, ${dial.layers.length} layers.`,
        "ok",
      );
    } catch (err) {
      this.status(`Parse failed: ${(err as Error).message}`, "err");
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
    const img = renderAt(this.dial, hh, mm, ss, this.jpegCache, this.aodMode);
    if (this.aodMode) { // AOD = tela always-on dimmed
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) { d[i] *= 0.5; d[i + 1] *= 0.5; d[i + 2] *= 0.5; }
    }
    drawToCanvas(this.canvas, img);
    // guias de alinhamento (durante o snap do drag)
    if (this.guides.length) {
      const ctx = this.canvas.getContext("2d")!;
      ctx.save();
      ctx.strokeStyle = "#ff6a3d";
      ctx.lineWidth = 1;
      for (const g of this.guides) {
        ctx.beginPath();
        if (g.x !== undefined) { ctx.moveTo(g.x + 0.5, 0); ctx.lineTo(g.x + 0.5, 466); }
        if (g.y !== undefined) { ctx.moveTo(0, g.y + 0.5); ctx.lineTo(466, g.y + 0.5); }
        ctx.stroke();
      }
      ctx.restore();
    }
    // selection outline for the currently-selected layer (so you see what's selected on-canvas)
    const sel = this.dial.layers[this.selected];
    if (sel && !sel.deleted && sel.kind !== "background") {
      const ctx = this.canvas.getContext("2d")!;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#4da3ff";
      if (sel.kind === "pointer") {
        // ponteiro é rotacionado em runtime — a borda acompanha (mesmo centro+ângulo do render).
        const { angle, cx, cy } = this.pointerXform(sel, hh, mm, ss);
        ctx.translate(cx, cy);
        ctx.rotate((angle * Math.PI) / 180);
        ctx.translate(-sel.pivotX, -sel.pivotY);
        ctx.strokeRect(0.5, 0.5, sel.w, sel.h);
      } else {
        const ox = sel.kind === "image" ? sel.x - sel.pivotX : sel.x;
        const oy = sel.kind === "image" ? sel.y - sel.pivotY : sel.y;
        ctx.strokeRect(ox + 0.5, oy + 0.5, Math.max(sel.w, 6), Math.max(sel.h, 6));
      }
      ctx.restore();
    }
    this.clock.textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  /** Centro + ângulo de rotação de um ponteiro (espelha render.ts::renderAt) p/ a borda de seleção. */
  private pointerXform(l: Layer, hh: number, mm: number, ss: number): { angle: number; cx: number; cy: number } {
    const angHour = (hh % 12) * 30 + mm * 0.5, angMin = mm * 6 + ss * 0.1, angSec = ss * 6;
    const role = l.sourceId !== undefined ? pointerRole(l.sourceId) : "none";
    const ptrs = this.dial!.layers.filter((p) => p.visible && !p.deleted && p.kind === "pointer").slice().sort((a, b) => a.h - b.h);
    const n = ptrs.length, i = ptrs.indexOf(l);
    let angle: number;
    if (role === "hour") angle = angHour;
    else if (role === "minute") angle = angMin;
    else if (role === "seconds") angle = angSec;
    else if (n <= 1) angle = angMin;
    else if (i === 0) angle = angHour;
    else if (i + 1 === n) angle = angSec;
    else angle = angMin;
    const hasPiv = l.pivotX !== 0 || l.pivotY !== 0;
    return { angle, cx: hasPiv ? l.x + l.pivotX : 233, cy: hasPiv ? l.y + l.pivotY : 233 };
  }

  // ---- Undo/redo: snapshot = clone raso do array de camadas (cobre add/delete/reorder/campos) ----
  private snapshot(): Layer[] {
    return this.dial ? this.dial.layers.map((l) => ({ ...l })) : [];
  }

  private restore(snap: Layer[]): void {
    if (!this.dial) return;
    this.dial.layers = snap.map((l) => ({ ...l }));
    this.selected = -1;
    this.refreshAll();
  }

  private lastUndoT = 0;
  private pushUndo(): void {
    if (!this.dial) return;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.lastUndoT = performance.now();
  }
  /** Um snapshot por "gesto" (agrupa arrastar de slider): só empilha se passou >400ms. */
  private pushUndoDebounced(): void {
    if (performance.now() - this.lastUndoT > 400) this.pushUndo();
  }

  private undo(): void {
    if (!this.dial || this.undoStack.length === 0) return;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop()!);
    this.status("Undone.", "ok");
  }

  private redo(): void {
    if (!this.dial || this.redoStack.length === 0) return;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop()!);
    this.status("Redone.", "ok");
  }

  private refreshAll(): void {
    this.buildLayerList();
    this.buildInspector();
    this.buildAssetBar();
    this.buildSimPanel();
    this.refreshJson();
    this.render();
  }

  /** Painel de VALORES DE PREVIEW (estilo editor Mi Band): setar hora + dados p/ ver dígitos,
   *  anéis e complicações reagirem, sem depender do play. Escreve simSeconds/simEnv. */
  private buildSimPanel(): void {
    const body = document.getElementById("simBody");
    if (!body || !this.dial) return;
    const t = Math.floor(this.simSeconds);
    const rows: Array<[string, number, number, number, (v: number) => void, () => string]> = [
      ["Time of day", 0, 12 * 3600 - 1, t, (v) => (this.simSeconds = v), () => {
        const s = Math.floor(this.simSeconds); return `${String(Math.floor(s / 3600) % 24).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      }],
      ["% goal / battery", 0, 100, simEnv.percent, (v) => { simEnv.percent = v; simEnv.battery = v; }, () => `${simEnv.percent}%`],
      ["Steps", 0, 15000, simEnv.steps, (v) => (simEnv.steps = v), () => String(simEnv.steps)],
      ["Heart rate", 40, 200, simEnv.bpm, (v) => (simEnv.bpm = v), () => `${simEnv.bpm} bpm`],
      ["Weekday", 0, 6, simEnv.weekday, (v) => (simEnv.weekday = v), () => ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][simEnv.weekday]],
    ];
    body.innerHTML = "";
    for (const [label, min, max, val, set, fmt] of rows) {
      const row = document.createElement("div");
      row.className = "simrow";
      const lab = document.createElement("label");
      lab.textContent = label;
      const out = document.createElement("span");
      out.className = "simval";
      out.textContent = fmt();
      const sl = document.createElement("input");
      sl.type = "range";
      sl.min = String(min); sl.max = String(max); sl.value = String(val);
      sl.addEventListener("input", () => {
        set(parseInt(sl.value, 10) | 0);
        out.textContent = fmt();
        this.render();
      });
      row.append(lab, sl, out);
      body.appendChild(row);
    }
  }

  // ---- Painel de camadas ----
  private buildLayerList(): void {
    const d = this.dial;
    this.layerList.innerHTML = "";
    if (!d) return;
    d.layers.forEach((l, i) => {
      if (l.deleted) return; // camada removida — some da lista (export faz rebuild sem ela)
      const li = document.createElement("li");
      if (i === this.selected) li.classList.add("sel");
      if (!l.visible) li.classList.add("hidden-layer");
      li.innerHTML = `<span>${iconFor(l.kind)}</span><span class="lname">${l.name}</span><span class="kind">${l.cf ? "cf" + l.cf : ""} ${l.w}×${l.h}</span>` +
        `<span class="reorder"><button data-up title="Subir (z-order)">▲</button><button data-dn title="Descer">▼</button></span>`;
      li.addEventListener("click", () => {
        this.selected = i;
        this.buildLayerList();
        this.buildInspector();
        this.render(); // redraw so the selection outline follows the picked layer
      });
      const move = (dir: number) => (ev: Event) => {
        ev.stopPropagation();
        const j = i + dir;
        if (!this.dial || j < 0 || j >= this.dial.layers.length) return;
        this.pushUndo();
        const arr = this.dial.layers;
        [arr[i], arr[j]] = [arr[j], arr[i]]; // z-order do preview (export é in-place, não muda)
        this.selected = j;
        this.buildLayerList();
        this.buildInspector();
        this.render();
      };
      li.querySelector("[data-up]")!.addEventListener("click", move(-1));
      li.querySelector("[data-dn]")!.addEventListener("click", move(1));
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
    const movable = (l.xOff !== undefined && l.yOff !== undefined) || !!l.isClone;
    const pivotable = l.pivxOff !== undefined && l.pivyOff !== undefined;
    const hasColor = l.kind === "arc" || (l.kind === "text" && l.cf === 13) || l.colorOff !== undefined;
    const isArc = l.kind === "arc";
    const isDataBound = l.kind === "text" || l.kind === "pointer" || l.kind === "arc";
    const hex = l.color ? "#" + l.color.map((c) => c.toString(16).padStart(2, "0")).join("") : "#ffffff";
    const persistNote = l.srcOff !== undefined || l.colorOff !== undefined ? "" : " (preview only)";

    const frag = document.createElement("div");
    frag.innerHTML = `
      <div class="field"><label>Type</label><span>${iconFor(l.kind)} ${l.kind} · cf${l.cf} · ${l.w}×${l.h}${l.frames ? ` · ${l.frames} frames` : ""}</span></div>
      <div class="field"><label>X</label><input type="number" id="fX" value="${l.x}" ${movable ? "" : "disabled"}></div>
      <div class="field"><label>Y</label><input type="number" id="fY" value="${l.y}" ${movable ? "" : "disabled"}></div>
      <div class="field"><label>Pivot X</label><input type="number" id="fPX" value="${l.pivotX}" ${pivotable ? "" : "disabled"}></div>
      <div class="field"><label>Pivot Y</label><input type="number" id="fPY" value="${l.pivotY}" ${pivotable ? "" : "disabled"}></div>
      ${isDataBound ? `<div class="field"><label>Source${persistNote}</label><select id="fSrc"></select></div>` : ""}
      ${hasColor ? `<div class="field"><label>Color${l.colorOff === undefined ? " (preview only)" : ""}</label><input type="color" id="fColor" value="${hex}"></div>` : ""}
      ${isArc ? `<div class="field"><label>Max (ring)</label><input type="number" id="fMax" value="${l.arcMax ?? 100}"></div>` : ""}
      ${l.frames && l.frames > 1 && !isArc ? `<div class="field"><label>Frame</label><input type="range" id="fFrame" min="0" max="${l.frames - 1}" value="${l.previewFrame ?? 0}"><span id="fFrameV">${l.previewFrame ?? "auto"}</span></div>` : ""}
      <div class="field"><label>Data (mock)</label><select id="fMock"></select></div>
      <div class="field"><label>Visible</label><input type="checkbox" id="fVis" ${l.visible ? "checked" : ""}></div>
      <div class="field full"><button class="btn wide" id="fReplace">🖼 Replace image…</button></div>
      <div class="field full"><button class="btn wide" id="fErase">🧽 Erase (keep size)</button></div>
      <div class="field full"><button class="btn wide" id="fDup">⧉ Duplicate layer</button></div>
      <div class="field full"><button class="btn wide danger" id="fDelete">🗑 Delete layer</button></div>
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

    // Fonte de dado real (enum do firmware) — escreve sourceId (persistido no export via srcOff).
    if (isDataBound) {
      const srcSel = $<HTMLSelectElement>("fSrc");
      for (const s of DATA_SOURCES) {
        const opt = document.createElement("option");
        opt.value = String(s.id);
        opt.textContent = `${s.label} (0x${s.id.toString(16)})`;
        if (s.id === l.sourceId) opt.selected = true;
        srcSel.appendChild(opt);
      }
      srcSel.addEventListener("change", () => {
        this.pushUndo();
        const id = parseInt(srcSel.value, 10);
        l.sourceId = id;
        l.mock = mockFromSourceId(id);
        mockSel.value = l.mock;
        this.render();
        this.refreshJson();
      });
    }

    const bindNum = (id: string, set: (v: number) => void) => {
      $<HTMLInputElement>(id).addEventListener("input", (e) => {
        this.pushUndoDebounced();
        set(parseInt((e.target as HTMLInputElement).value || "0", 10) | 0);
        this.render();
        this.refreshJson();
      });
    };
    bindNum("fX", (v) => (l.x = v));
    bindNum("fY", (v) => (l.y = v));
    bindNum("fPX", (v) => (l.pivotX = v));
    bindNum("fPY", (v) => (l.pivotY = v));
    if (isArc) bindNum("fMax", (v) => (l.arcMax = v || 100));

    const frameSl = document.getElementById("fFrame") as HTMLInputElement | null;
    if (frameSl) {
      frameSl.addEventListener("input", () => {
        this.pushUndoDebounced();
        l.previewFrame = parseInt(frameSl.value, 10) | 0;
        const v = document.getElementById("fFrameV");
        if (v) v.textContent = String(l.previewFrame);
        this.render();
      });
    }

    if (hasColor) {
      $<HTMLInputElement>("fColor").addEventListener("input", (e) => {
        this.pushUndoDebounced();
        const v = (e.target as HTMLInputElement).value; // #rrggbb
        l.color = [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
        this.render();
        this.refreshJson();
      });
    }

    mockSel.addEventListener("change", () => {
      this.pushUndo();
      l.mock = mockSel.value as MockKind;
      this.render();
      this.refreshJson();
    });
    $<HTMLInputElement>("fVis").addEventListener("change", (e) => {
      this.pushUndo();
      l.visible = (e.target as HTMLInputElement).checked;
      this.buildLayerList();
      this.render();
      this.refreshJson();
    });
    $("fReplace").addEventListener("click", () => this.replaceLayerImage(this.selected));
    // Apaga a camada trocando seu asset por um raster TRANSPARENTE do mesmo w×h. Comprime pequeno
    // (≤ len original) → SAME-FOOTPRINT: o export fica com o tamanho idêntico e instala pelo re-skin
    // (delete muda o tamanho → a065=0x0a no relógio). Ideal p/ "sumir" com um elemento (ex.: colon).
    $("fErase").addEventListener("click", () => {
      this.pushUndo();
      const zeros = new Uint8ClampedArray(l.w * l.h * 4); // RGBA 0 = transparente (cf5/24) / preto (cf4)
      const sz = setLayerImageRaster(l, zeros);
      if (sz > l.assetLen) {
        l.newPayload = undefined;
        this.status(`Erase failed: transparent payload ${sz}B > ${l.assetLen}B (asset original).`, "err");
        return;
      }
      this.render();
      this.refreshJson();
      this.status(`Layer "${l.name}" erased — transparent, ${sz}B ≤ ${l.assetLen}B (same footprint → installs).`, "ok");
    });
    $("fDup").addEventListener("click", () => {
      if (!this.dial) return;
      this.pushUndo();
      // clona o nó comprovado (mesmo asset), desloca +12,+12; export insere via rebuild.
      // Zera os *Off (apontam pros bytes da FONTE) — o rebuild posiciona o clone via bytes do nó,
      // e o encodeInPlace não deve reescrever nada da fonte com dados do clone.
      const clone: Layer = {
        ...l, x: Math.min(465, l.x + 12), y: Math.min(465, l.y + 12), isClone: true,
        sourceKey: `${l.assetOff},${l.x},${l.y}`,
        xOff: undefined, yOff: undefined, pivxOff: undefined, pivyOff: undefined, colorOff: undefined, srcOff: undefined,
      };
      this.dial.layers.splice(this.selected + 1, 0, clone);
      this.selected += 1;
      this.refreshAll();
      this.status(`Layer duplicated. Export inserts the new node (rebuild). Replace its image if you want.`, "ok");
    });
    $("fDelete").addEventListener("click", () => {
      this.pushUndo();
      l.deleted = true;
      this.selected = -1;
      this.refreshAll();
      this.status(`Layer "${l.name}" removed. Export will rebuild the container (Ctrl+Z undoes).`, "ok");
    });
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
    this.status("Notation applied.", "ok");
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
          this.status(`Image replaced (${size}B ≤ ${l.assetLen}B). ✓`, "ok");
        }
      } catch (err) {
        this.status("Image load failed: " + (err as Error).message, "err");
      }
    });
    input.click();
  }

  // ---- AOD ----
  private aodMode = false;
  private onAod(on: boolean): void {
    if (!this.dial) return;
    this.aodMode = on;
    setAod(this.dial, on); // troca o fundo p/ a variante AOD (arte real always-on)
    this.render();
  }

  // ---- Drag ----
  private onPointerDown(e: PointerEvent): void {
    const l = this.dial?.layers[this.selected];
    // arrastável se tem offsets de geometria (persistidos in-place) OU é um clone (posição via rebuild).
    if (!l || (!l.isClone && (l.xOff === undefined || l.yOff === undefined))) return;
    this.pushUndo();
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
    let nx = Math.max(0, Math.min(465, this.drag.layerX + (x - this.drag.startX)));
    let ny = Math.max(0, Math.min(465, this.drag.layerY + (y - this.drag.startY)));
    // SNAP: centro do sprite → centro do canvas (233) ou bordas, com guias visuais.
    this.guides = [];
    const T = 6;
    const cx = nx + l.w / 2, cy = ny + l.h / 2;
    if (Math.abs(cx - 233) < T) { nx = 233 - l.w / 2; this.guides.push({ x: 233 }); }
    else if (Math.abs(nx) < T) { nx = 0; this.guides.push({ x: 0 }); }
    if (Math.abs(cy - 233) < T) { ny = 233 - l.h / 2; this.guides.push({ y: 233 }); }
    else if (Math.abs(ny) < T) { ny = 0; this.guides.push({ y: 0 }); }
    l.x = Math.round(nx);
    l.y = Math.round(ny);
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
      this.guides = [];
      this.render();
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
    this.driveData(this.simSeconds); // simulação: varia passos/FC/%meta p/ ver anéis/complicações
    this.render();
    requestAnimationFrame(this.tick);
  }

  /** Varia os dados mock num ciclo de ~30s (espelha sim.ts) — anéis varrem, complicações trocam. */
  private driveData(t: number): void {
    const cyc = (t % 30) / 30;
    simEnv.percent = Math.round(cyc * 100);
    simEnv.battery = Math.round(100 - cyc * 100);
    simEnv.steps = Math.round(cyc * 12000);
    simEnv.kcal = Math.round(cyc * 300);
    simEnv.distance = +(cyc * 8).toFixed(1);
    simEnv.bpm = Math.round(70 + 40 * Math.sin(t / 3));
    simEnv.temp = Math.round(15 + cyc * 25);
    simEnv.weekday = Math.floor(t / 4) % 7;
    simEnv.month = Math.floor(t / 6) % 12;
  }

  // ---- Export .bin ----
  private onExport(): void {
    if (!this.dial) return;
    try {
      const structural = this.dial.layers.some((l) => l.deleted || l.isClone);
      let bytes: Uint8Array;
      if (structural) {
        // REBUILD: camadas removidas mudam o footprint → reconstrói cena+pool e reajusta ponteiros.
        const inPlace = encodeInPlace(this.dial); // aplica geometria/cor/fonte primeiro
        bytes = rebuildContainer({ ...this.dial, raw: inPlace });
        validateContainer(bytes); // invariante do firmware (1º byte 0x20, lengths fecham)
      } else {
        bytes = encodeInPlace(this.dial);
      }
      downloadBytes(bytes, outName(this.dial.perDialId, this.dial.name));
      // same-footprint (tamanho idêntico ao original) é o único caminho de re-skin PROVADO no relógio;
      // tamanho diferente (delete/add) tende a a065=0x0a (armazena, não ativa).
      const sameFootprint = bytes.length === this.dial.raw.length;
      this.status(
        sameFootprint
          ? `Exported (${bytes.length}B) — same-footprint ✓ installs via re-skin (0x9075, old_id = active dial).`
          : `Exported (${bytes.length}B) — ⚠ footprint changed (${this.dial.raw.length}→${bytes.length}); the watch may store-not-activate (a065=0x0a). Use “Erase (keep size)” instead of Delete/Duplicate to keep it installable.`,
        sameFootprint ? "ok" : "err",
      );
    } catch (err) {
      this.status("Export failed: " + (err as Error).message, "err");
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
      this.status("Photo-dial generation failed: " + (err as Error).message, "err");
    }
  }
}

function iconFor(kind: Layer["kind"]): string {
  switch (kind) {
    case "background": return "🌄";
    case "image": return "🖼";
    case "pointer": return "🕳";
    case "text": return "🔢";
    case "arc": return "◠";
    default: return "▫";
  }
}
