// "Adicionar componente" por REBASE: como adicionar/remover camada é estrutural (não instala), o jeito
// que ativa no relógio é TROCAR a base por um dial que JÁ tem o slot desejado. Aqui: indexar bases por
// componentes, achar a mais parecida com o dial atual que tem o componente pedido (rebase automático),
// e portar as edições compatíveis (cor/fonte/imagem) casando por identidade de componente.
import { parseStructured } from "./parse.js";
import { mockFromSourceId } from "./mock.js";
import type { StructDial, Layer } from "./types.js";

/** Chave de "componente" de uma camada: o dado que ela mostra (mock) ou, se genérico, o tipo. */
export function componentKey(l: Layer): string {
  return l.mock && l.mock !== "none" ? l.mock : l.kind;
}

/** Conjunto de componentes de um dial (ignora AOD e assets não posicionados). */
export function dialComponents(dial: StructDial): Set<string> {
  const s = new Set<string>();
  for (const l of dial.layers) {
    if (l.aod || l.kind === "other") continue;
    s.add(componentKey(l));
  }
  return s;
}

/** Nome amigável de um componente (p/ a UI). */
export const COMP_LABEL: Record<string, string> = {
  seconds: "Segundos", timeSec: "Relógio c/ segundos", time: "Relógio",
  temp: "Temperatura", date: "Data", weekday: "Dia da semana",
  kcal: "Calorias", percent: "Anel de progresso / %", distance: "Distância",
  steps: "Passos", bpm: "Batimentos", ampm: "AM / PM", battery: "Bateria",
  arc: "Anel", pointer: "Ponteiro", image: "Imagem / arte",
};

/** Componentes "interessantes" de adicionar (exclui os quase-onipresentes/estruturais). */
const BORING = new Set(["background", "hour", "minute", "other"]);

export interface BaseInfo {
  id: string;
  name: string;
  comps: Set<string>;
}

export interface Scored {
  base: BaseInfo;
  /** similaridade Jaccard (0..1) com o dial atual. */
  jaccard: number;
  /** nº de componentes em comum. */
  shared: number;
}

/** Componentes que ALGUMA base tem e o dial atual NÃO — candidatos a "adicionar" (via rebase). */
export function addableComponents(current: Set<string>, bases: BaseInfo[]): string[] {
  const all = new Set<string>();
  for (const b of bases) for (const c of b.comps) if (!current.has(c) && !BORING.has(c)) all.add(c);
  return [...all].sort();
}

/** Bases que têm `wanted`, ranqueadas por similaridade com o dial atual (rebase automático = [0]). */
export function scoreBases(current: Set<string>, bases: BaseInfo[], wanted: string): Scored[] {
  return bases
    .filter((b) => b.comps.has(wanted))
    .map((b) => {
      const shared = [...current].filter((c) => b.comps.has(c)).length;
      const union = new Set([...current, ...b.comps]).size;
      return { base: b, jaccard: union ? shared / union : 0, shared };
    })
    .sort((a, b) => b.jaccard - a.jaccard || b.shared - a.shared);
}

export interface CarryResult {
  applied: string[];
  skipped: string[];
}

/**
 * Porta as edições do `current` para o `newBase` (nova base já parseada), casando camadas por
 * componente (mock/kind). Carrega o que é conteúdo do usuário — imagem re-skinada (se o slot for
 * compatível), cor e fonte de dado — NÃO a posição (o layout é força da base nova). Diffa contra o
 * estado pristino (`current.raw`) p/ saber o que o usuário realmente mudou. Muta `newBase` in-place.
 */
export function carryOver(current: StructDial, newBase: StructDial): CarryResult {
  const baseline = parseStructured(current.raw); // estado original (sem edições) p/ diff
  const applied: string[] = [];
  const skipped: string[] = [];
  const used = new Set<Layer>();

  current.layers.forEach((l, i) => {
    const orig = baseline.layers[i];
    const key = componentKey(l);
    const edit: { newPayload?: Uint8Array; cf?: number; w?: number; h?: number; color?: [number, number, number]; sourceId?: number } = {};
    let has = false;
    if (l.newPayload) { edit.newPayload = l.newPayload; edit.cf = l.cf; edit.w = l.w; edit.h = l.h; has = true; }
    if (l.color && (!orig?.color || l.color.join() !== orig.color.join())) { edit.color = l.color; has = true; }
    if (l.sourceId !== undefined && orig && l.sourceId !== orig.sourceId) { edit.sourceId = l.sourceId; has = true; }
    if (!has) return;

    const label = COMP_LABEL[key] ?? key;
    const target = newBase.layers.find((t) => !used.has(t) && componentKey(t) === key);
    if (!target) { skipped.push(`${label} (base nova não tem esse slot)`); return; }
    used.add(target);

    let did = false, noted = false;
    if (edit.color) {
      if (target.colorOff !== undefined || target.kind === "arc" || target.cf === 13) { target.color = edit.color; did = true; }
      else { skipped.push(`${label} (cor não editável no slot novo)`); noted = true; }
    }
    if (edit.sourceId !== undefined) {
      if (target.srcOff !== undefined) { target.sourceId = edit.sourceId; target.mock = mockFromSourceId(edit.sourceId); did = true; }
      else { skipped.push(`${label} (fonte fixa no slot novo)`); noted = true; }
    }
    if (edit.newPayload) {
      if (target.cf === edit.cf && target.w === edit.w && target.h === edit.h && edit.newPayload.length <= target.assetLen) {
        target.newPayload = edit.newPayload; did = true;
      } else { skipped.push(`${label} (imagem incompatível com o slot novo)`); noted = true; }
    }
    if (did) applied.push(label);
    else if (!noted) skipped.push(label);
  });

  return { applied, skipped };
}
