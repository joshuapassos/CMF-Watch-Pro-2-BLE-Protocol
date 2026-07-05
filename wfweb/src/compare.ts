// Harness de comparação: renderiza cada .bin do corpus e compara com o PNG oficial (asset).
// Reusa o pipeline real do app: parseStructured → predecode JPEG → renderAt.
import { parseStructured, scanAssets } from "./codec/parse.js";
import { isPhotoDial } from "./codec/encode.js";
import { renderAt, type JpegCache, type RgbaImage } from "./codec/render.js";
import { jpegPayloadToRgba } from "./ui/imageutil.js";

const DIM = 466;

interface CatEntry { id: number; name: string; style: string; reskin: boolean }
interface Row {
  id: number; name: string; style: string; size: number; layers: number;
  diffPct: number; meanDiff: number; err: string;
  render?: RgbaImage; asset?: Uint8ClampedArray;
}

async function predecodeJpegs(dial: ReturnType<typeof parseStructured>): Promise<JpegCache> {
  const cache: JpegCache = new Map();
  // Pré-decodifica TODOS os assets cf=1 do pool (não só as camadas): inclui os GLIFOS do atlas de
  // dígitos JPEG (ex. 285 hora/minuto), que o atlasGlyphs precisa no cache p/ desenhar.
  for (const [off, cf, w, h, len] of scanAssets(dial.raw)) {
    if (cf !== 1 || cache.has(off)) continue;
    try {
      const payload = dial.raw.subarray(off + 8, off + 8 + len);
      cache.set(off, { w, h, data: await jpegPayloadToRgba(payload, w, h) });
    } catch { /* frame inválido */ }
  }
  return cache;
}

async function loadAsset(id: number): Promise<Uint8ClampedArray | undefined> {
  const resp = await fetch(`/corpus/img/${id}.png`);
  if (!resp.ok) return undefined;
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(DIM, DIM);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, DIM, DIM);
  return ctx.getImageData(0, 0, DIM, DIM).data;
}

/** Diff: % de pixels com Δmáx de canal > 32, e média absoluta por canal RGB. */
function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): { diffPct: number; meanDiff: number } {
  let bad = 0, sum = 0;
  const n = DIM * DIM;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = Math.abs(a[o] - b[o]);
    const dg = Math.abs(a[o + 1] - b[o + 1]);
    const db = Math.abs(a[o + 2] - b[o + 2]);
    sum += dr + dg + db;
    if (Math.max(dr, dg, db) > 32) bad++;
  }
  return { diffPct: (bad / n) * 100, meanDiff: sum / (n * 3) };
}

function thumb(img: RgbaImage | Uint8ClampedArray): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = DIM; c.height = DIM; c.className = "thumb";
  const ctx = c.getContext("2d")!;
  const data = img instanceof Uint8ClampedArray ? img : img.data;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), DIM, DIM), 0, 0);
  return c;
}

const rows: Row[] = [];
(window as any).results = rows;

async function run() {
  const cat: CatEntry[] = await (await fetch("/corpus/catalog.json")).json();
  cat.sort((a, b) => a.id - b.id);
  const summary = document.getElementById("summary")!;

  for (const e of cat) {
    const row: Row = { id: e.id, name: e.name, style: e.style, size: 0, layers: 0, diffPct: NaN, meanDiff: NaN, err: "" };
    rows.push(row);
    try {
      const binResp = await fetch(`/corpus/bin/${e.id}.bin`);
      if (!binResp.ok) { row.err = "sem .bin"; continue; }
      const bytes = new Uint8Array(await binResp.arrayBuffer());
      row.size = bytes.length;
      if (bytes.length === 173) { row.err = "stub nativo (173B, ref de firmware)"; continue; }
      if (isPhotoDial(bytes)) { row.err = "photo-dial"; continue; }
      const dial = parseStructured(bytes);
      row.layers = dial.layers.length;
      const jpeg = await predecodeJpegs(dial);
      row.render = renderAt(dial, 10, 12, 30, jpeg); // hora dos thumbnails oficiais (10:12:30 — seg no 6)
      row.asset = await loadAsset(e.id);
      if (row.asset) {
        const d = diff(row.render.data, row.asset);
        row.diffPct = d.diffPct; row.meanDiff = d.meanDiff;
      } else {
        row.err = "sem asset png";
      }
    } catch (err) {
      row.err = (err as Error).message;
    }
    summary.textContent = `${rows.length}/${cat.length} processados…`;
  }

  render();
  const done = rows.filter((r) => !isNaN(r.diffPct));
  const avg = done.reduce((s, r) => s + r.diffPct, 0) / (done.length || 1);
  const errs = rows.filter((r) => r.err).length;
  summary.textContent = `${cat.length} dials · ${done.length} comparados · diff médio ${avg.toFixed(1)}% · ${errs} c/ status`;
  (window as any).done = true;
}

let sortKey = "diffPct", sortDir = -1;
function render() {
  const tbody = document.getElementById("rows")!;
  const sorted = [...rows].sort((a, b) => {
    const av = (a as any)[sortKey], bv = (b as any)[sortKey];
    if (typeof av === "number") return (( isNaN(av) ? -1 : av) - (isNaN(bv) ? -1 : bv)) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  });
  tbody.innerHTML = "";
  for (const r of sorted) {
    const tr = document.createElement("tr");
    const cls = isNaN(r.diffPct) ? "" : r.diffPct > 25 ? "bad" : r.diffPct > 8 ? "warn" : "ok";
    tr.innerHTML = `<td class="num">${r.id}</td><td>${r.name}</td><td>${r.style}</td>` +
      `<td class="num">${r.size || ""}</td><td class="num">${r.layers || ""}</td>` +
      `<td class="num ${cls}">${isNaN(r.diffPct) ? "—" : r.diffPct.toFixed(1)}</td>` +
      `<td class="num">${isNaN(r.meanDiff) ? "—" : r.meanDiff.toFixed(1)}</td>`;
    const cmp = document.createElement("td");
    const box = document.createElement("div"); box.className = "cmp";
    if (r.render) { const d = document.createElement("div"); d.appendChild(thumb(r.render)); const l = document.createElement("div"); l.className = "lbl"; l.textContent = "render"; d.appendChild(l); box.appendChild(d); }
    if (r.asset) { const d = document.createElement("div"); d.appendChild(thumb(r.asset)); const l = document.createElement("div"); l.className = "lbl"; l.textContent = "asset"; d.appendChild(l); box.appendChild(d); }
    cmp.appendChild(box); tr.appendChild(cmp);
    const st = document.createElement("td"); st.className = "err"; st.textContent = r.err; tr.appendChild(st);
    tbody.appendChild(tr);
  }
}

document.querySelectorAll("th[data-k]").forEach((th) => {
  th.addEventListener("click", () => {
    const k = (th as HTMLElement).dataset.k!;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === "name" || k === "style" ? 1 : -1; }
    render();
  });
});

run();
