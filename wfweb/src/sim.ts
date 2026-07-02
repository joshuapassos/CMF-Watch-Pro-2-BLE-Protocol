// Harness de SIMULAÇÃO: anima relógio + dados mock num dial, p/ ver o comportamento dinâmico
// (ponteiros varrendo, segundos, flip-clock, setor do anel, animação) que o frame estático esconde.
import { parseStructured } from "./codec/parse.js";
import { isPhotoDial } from "./codec/encode.js";
import { renderAt, type JpegCache } from "./codec/render.js";
import { simEnv } from "./codec/mock.js";
import { jpegPayloadToRgba } from "./ui/imageutil.js";

const DIM = 466;
const cv = document.getElementById("cv") as HTMLCanvasElement;
const ctx = cv.getContext("2d")!;
const hud = document.getElementById("hud")!;
const info = document.getElementById("info")!;
const assetImg = document.getElementById("asset") as HTMLImageElement;
const dialSel = document.getElementById("dial") as HTMLSelectElement;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const speedEl = document.getElementById("speed") as HTMLInputElement;
const spdLbl = document.getElementById("spd")!;
const autoData = document.getElementById("autoData") as HTMLInputElement;

interface Loaded { dial: ReturnType<typeof parseStructured>; jpeg: JpegCache; name: string }
let cur: Loaded | null = null;
let playing = true;
let simSec = 10 * 3600 + 12 * 60; // começa 10:12:00
let last = 0;

async function predecode(dial: ReturnType<typeof parseStructured>): Promise<JpegCache> {
  const cache: JpegCache = new Map();
  for (const l of dial.layers) {
    if (l.cf === 1) {
      try {
        const payload = dial.raw.subarray(l.assetOff + 8, l.assetOff + 8 + l.assetLen);
        cache.set(l.assetOff, { w: l.w, h: l.h, data: await jpegPayloadToRgba(payload, l.w, l.h) });
      } catch { /* frame inválido */ }
    }
  }
  return cache;
}

async function load(id: number): Promise<void> {
  const bytes = new Uint8Array(await (await fetch(`/corpus/bin/${id}.bin`)).arrayBuffer());
  if (isPhotoDial(bytes)) { hud.textContent = "photo-dial (sem camadas)"; cur = null; return; }
  const dial = parseStructured(bytes);
  cur = { dial, jpeg: await predecode(dial), name: dial.name };
  assetImg.src = `/corpus/img/${id}.png`;
  const kinds: Record<string, number> = {};
  for (const l of dial.layers) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
  info.textContent = `id ${id} · "${dial.name}"\n${dial.layers.length} camadas: ` +
    Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ") +
    `\nanéis: ${dial.layers.filter((l) => l.kind === "arc").length}` +
    ` · frame-sheets: ${dial.layers.filter((l) => l.frames && l.frames > 1).length}`;
}

/** Varia os dados mock ao longo de um ciclo de ~30s de sim (passos sobem, FC oscila, %meta varre). */
function driveData(t: number): void {
  if (!autoData.checked) return;
  const cyc = (t % 30) / 30; // 0..1
  simEnv.percent = Math.round(cyc * 100);
  simEnv.battery = Math.round(100 - cyc * 100);
  simEnv.steps = Math.round(cyc * 12000);
  simEnv.kcal = Math.round(cyc * 300);
  simEnv.distance = +(cyc * 8).toFixed(1);
  simEnv.bpm = Math.round(70 + 40 * Math.sin(t / 3));
  simEnv.temp = Math.round(15 + cyc * 25);
  simEnv.weekday = Math.floor(t / 4) % 7;
  simEnv.month = Math.floor(t / 6) % 12;
  simEnv.day = 1 + (Math.floor(t / 2) % 28);
}

function frame(ts: number): void {
  if (last === 0) last = ts;
  const dt = (ts - last) / 1000;
  last = ts;
  if (playing) simSec += dt * Number(speedEl.value);
  spdLbl.textContent = `${speedEl.value}×`;

  const t = Math.floor(simSec);
  const hh = Math.floor(t / 3600) % 24, mm = Math.floor(t / 60) % 60, ss = t % 60;
  driveData(simSec);

  if (cur) {
    const img = renderAt(cur.dial, hh, mm, ss, cur.jpeg);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), DIM, DIM), 0, 0);
    hud.textContent =
      `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}   ` +
      `meta ${simEnv.percent}%  bat ${simEnv.battery}%  ${simEnv.steps} passos  ${simEnv.bpm} bpm  ${simEnv.distance}km`;
  }
  requestAnimationFrame(frame);
}

async function main() {
  const cat: Array<{ id: number; name: string; style: string }> = await (await fetch("/corpus/catalog.json")).json();
  cat.sort((a, b) => a.id - b.id);
  for (const e of cat) {
    const o = document.createElement("option");
    o.value = String(e.id);
    o.textContent = `${e.id} — ${e.name} (${e.style})`;
    dialSel.appendChild(o);
  }
  const start = new URLSearchParams(location.search).get("id") ?? "371";
  dialSel.value = start;
  await load(Number(start));
  dialSel.addEventListener("change", () => load(Number(dialSel.value)));
  playBtn.addEventListener("click", () => { playing = !playing; playBtn.textContent = playing ? "⏸ pausar" : "▶ tocar"; });
  requestAnimationFrame(frame);
}

(window as any).simGoto = (id: number) => { dialSel.value = String(id); return load(id); };
(window as any).simSet = (s: number) => { simSec = s; };
main();
