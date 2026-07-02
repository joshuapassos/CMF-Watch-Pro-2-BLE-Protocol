// MockKind: dado de runtime que um elemento representa (só p/ preview). Port de watchface_struct.rs.
import type { MockKind } from "./types.js";

export const MOCK_ALL: MockKind[] = [
  "none", "time", "hour", "minute", "seconds", "ampm", "date", "weekday",
  "steps", "kcal", "bpm", "battery", "temp", "distance", "percent", "generic",
];

const pad2 = (n: number) => n.toString().padStart(2, "0");

/** String de exemplo p/ desenhar no preview (null → sem texto). */
export function mockSample(kind: MockKind, hh: number, mm: number, ss: number): string | null {
  switch (kind) {
    case "none": return null;
    case "time": return `${pad2(hh % 24)}:${pad2(mm)}`;
    case "hour": return pad2(hh % 24);
    case "minute": return pad2(mm);
    case "seconds": return pad2(ss);
    case "ampm": return hh < 12 ? "AM" : "PM";
    case "date": return "JUL 09";
    case "weekday": return "TUE";
    case "steps": return "6,240";
    case "kcal": return "156";
    case "bpm": return "68";
    case "battery": return "80%";
    case "temp": return "25°";
    case "distance": return "3.6km";
    case "percent": return "80%";
    case "generic": return "—";
  }
}

/** Rótulo curto p/ o dropdown do inspector. */
export function mockLabel(kind: MockKind): string {
  const m: Record<MockKind, string> = {
    none: "Nenhum", time: "Relógio", hour: "Hora", minute: "Minuto", seconds: "Segundos",
    ampm: "AM/PM", date: "Data", weekday: "Dia", steps: "Passos", kcal: "Kcal", bpm: "BPM",
    battery: "Bateria", temp: "Temp", distance: "Distância", percent: "Meta %", generic: "Genérico",
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
  if (id === 0x24) return "temp";
  if (id === 0x36) return "steps";
  if (id === 0x37 || id === 0x61) return "distance";
  if (id === 0x60) return "kcal";
  if (id === 0x25 || id === 0x26 || id === 0x27 || id === 0x49 || id === 0x6c || id === 0x6f) return "percent";
  return "none";
}

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
