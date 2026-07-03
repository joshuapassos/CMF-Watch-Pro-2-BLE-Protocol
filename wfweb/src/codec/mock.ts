// MockKind: dado de runtime que um elemento representa (só p/ preview). Port de watchface_struct.rs.
import type { MockKind } from "./types.js";

export const MOCK_ALL: MockKind[] = [
  "none", "time", "hour", "minute", "seconds", "ampm", "date", "weekday",
  "steps", "kcal", "bpm", "battery", "temp", "distance", "percent", "generic",
];

const pad2 = (n: number) => n.toString().padStart(2, "0");

/**
 * Dados de runtime MOCK (fonte única p/ texto E frame-index de complicação). Valores default =
 * os que casam com os thumbnails da loja (oráculo). O harness de simulação (`sim.ts`) muta estes
 * campos ao longo do tempo p/ animar anéis/complicações; o oráculo estático usa os defaults.
 */
export const simEnv = {
  percent: 80, // % de meta genérica (anel de progresso)
  battery: 80,
  steps: 6240,
  kcal: 156,
  bpm: 68,
  temp: 25,
  distance: 3.6, // km
  weekday: 2, // 0=dom … 6=sáb (TUE=2)
  month: 6, // 0=jan … (JUL=6)
  day: 9,
};

/** String de exemplo p/ desenhar no preview (null → sem texto). */
export function mockSample(kind: MockKind, hh: number, mm: number, ss: number): string | null {
  const WD = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const MO = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  switch (kind) {
    case "none": return null;
    case "time": return `${pad2(hh % 24)}:${pad2(mm)}`;
    case "hour": return pad2(hh % 24);
    case "minute": return pad2(mm);
    case "seconds": return pad2(ss);
    case "ampm": return hh < 12 ? "AM" : "PM";
    case "date": return `${MO[simEnv.month] ?? "JUL"} ${pad2(simEnv.day)}`;
    case "weekday": return WD[simEnv.weekday] ?? "TUE";
    case "steps": return simEnv.steps.toLocaleString("en-US");
    case "kcal": return String(simEnv.kcal);
    case "bpm": return String(simEnv.bpm);
    case "battery": return `${simEnv.battery}%`;
    case "temp": return `${simEnv.temp}°`;
    case "distance": return `${simEnv.distance.toFixed(1)}km`;
    case "percent": return `${simEnv.percent}%`;
    case "generic": return "—";
  }
}

/** Rótulo curto p/ o dropdown do inspector. */
export function mockLabel(kind: MockKind): string {
  const m: Record<MockKind, string> = {
    none: "None", time: "Clock", hour: "Hour", minute: "Minute", seconds: "Seconds",
    ampm: "AM/PM", date: "Date", weekday: "Weekday", steps: "Steps", kcal: "Kcal", bpm: "BPM",
    battery: "Battery", temp: "Temp", distance: "Distance", percent: "Goal %", generic: "Generic",
  };
  return m[kind];
}

/**
 * Mapeia a fonte de dado do firmware (id 0x00–0x8d) p/ um mock. Espelha MockKind::from_source_id.
 * Ids não-mapeados → "none" (cai na heurística de posição).
 */
export function mockFromSourceId(id: number): MockKind {
  if (id >= 0x01 && id <= 0x09) return "hour";
  if (id >= 0x0b && id <= 0x0d) return "minute";
  if (id >= 0x0f && id <= 0x11) return "seconds";
  if (id === 0x13) return "ampm";
  if (id === 0x15 || id === 0x16 || id === 0x17) return "date";
  if (id === 0x18) return "weekday";
  if (id === 0x19 || id === 0x48 || id === 0x74 || id === 0x75) return "bpm";
  if (id === 0x1b) return "battery";
  if (id === 0x24 || id === 0x5f) return "temp";
  if (id === 0x36) return "steps";
  if (id === 0x37 || id === 0x61) return "distance";
  if (id === 0x60) return "kcal";
  if (id === 0x25 || id === 0x26 || id === 0x27 || id === 0x49 || id === 0x6c || id === 0x6f) return "percent";
  return "none";
}

/**
 * Dígito ÚNICO de uma fonte de decomposição (spec 25 §1.1, CONFIRMED). Ids tens/units renderizam
 * só um dígito — sem isso cada slot desenha o valor inteiro sobreposto (ex. 284 Square). null = a
 * fonte não é um split de dígito (usa mockSample normal).
 */
export function digitForSource(id: number, hh: number, mm: number, ss: number): string | null {
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  switch (id) {
    case 0x02: return String(Math.floor(h12 / 10)); // hora 12h dezena
    case 0x03: return String(h12 % 10); // hora 12h unidade
    case 0x05: case 0x08: return String(Math.floor(hh / 10)); // hora dezena (24h / 12h-aware)
    case 0x06: case 0x09: return String(hh % 10); // hora unidade
    case 0x0c: return String(Math.floor(mm / 10)); // min dezena
    case 0x0d: return String(mm % 10); // min unidade
    case 0x10: return String(Math.floor(ss / 10)); // seg dezena
    case 0x11: return String(ss % 10); // seg unidade
    default: return null;
  }
}

/**
 * Fontes de dado editáveis (id do firmware 0x00–0x8d → rótulo + mock), spec 25 §1.1. Curado p/ o
 * dropdown do inspector: escrever o `id` no record rebinda a complicação/texto no relógio.
 */
export const DATA_SOURCES: Array<{ id: number; label: string; mock: MockKind }> = [
  { id: 0x07, label: "Hour (12h)", mock: "hour" },
  { id: 0x04, label: "Hour (24h)", mock: "hour" },
  { id: 0x0b, label: "Minute", mock: "minute" },
  { id: 0x0f, label: "Second", mock: "seconds" },
  { id: 0x13, label: "AM/PM", mock: "ampm" },
  { id: 0x17, label: "Day of month", mock: "date" },
  { id: 0x16, label: "Month", mock: "date" },
  { id: 0x18, label: "Weekday", mock: "weekday" },
  { id: 0x36, label: "Steps", mock: "steps" },
  { id: 0x60, label: "Calories", mock: "kcal" },
  { id: 0x61, label: "Distance", mock: "distance" },
  { id: 0x48, label: "Heart rate", mock: "bpm" },
  { id: 0x1b, label: "Battery %", mock: "battery" },
  { id: 0x5f, label: "Weather temp", mock: "temp" },
  { id: 0x24, label: "Temperature (local)", mock: "temp" },
  { id: 0x25, label: "% of goal", mock: "percent" },
  // Descobertos varrendo o corpus (aparecem sempre colados no 0x5f = clima). Significado inferido
  // pela posição/nº de dígitos — não 100% confirmado. Use "Source id (raw)" p/ varrer se preciso.
  { id: 0x1a, label: "Weather metric (0x1a · 3-digit)", mock: "generic" },
  { id: 0x1e, label: "Weather metric (0x1e · 4-digit)", mock: "generic" },
  { id: 0x70, label: "Hour hand", mock: "hour" },
  { id: 0x71, label: "Minute hand", mock: "minute" },
  { id: 0x72, label: "Second hand", mock: "seconds" },
];

/** Papel de um PONTEIRO pela fonte em @36. 0x0a/0x70→hora, 0x0e/0x71→min, 0x12/0x72→seg. */
export function pointerRole(src: number): MockKind {
  if (src === 0x0a || src === 0x70) return "hour";
  if (src === 0x0e || src === 0x71) return "minute";
  if (src === 0x12 || src === 0x72) return "seconds";
  return "none";
}

/** MockKind → nome legível p/ o campo `source` da notação (none → undefined). */
export function mockToSource(kind: MockKind): string | undefined {
  if (kind === "none") return undefined;
  return kind;
}

/** Nome legível ↔ MockKind p/ o campo `source` da notação. */
export function sourceToMock(source: string | undefined): MockKind {
  if (!source) return "none";
  const s = source.toLowerCase();
  const map: Record<string, MockKind> = {
    hour: "hour", hora: "hour",
    minute: "minute", min: "minute", minuto: "minute",
    second: "seconds", seconds: "seconds", seg: "seconds", segundo: "seconds",
    time: "time", clock: "time", relogio: "time",
    ampm: "ampm", date: "date", weekday: "weekday", dia: "weekday",
    steps: "steps", passos: "steps", kcal: "kcal", bpm: "bpm", hr: "bpm",
    battery: "battery", bateria: "battery", temp: "temp", distance: "distance",
    percent: "percent", generic: "generic",
  };
  return map[s] ?? "none";
}
