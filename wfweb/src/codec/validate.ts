// Validação do editor: (a) ao vivo, sobre o estado em memória (validateDial) — alimenta o painel de
// alertas e o estado do botão Export; (b) final, sobre os bytes exportados (validateBin) — rede de
// segurança que RE-PARSEIA o resultado e recusa qualquer `.bin` que não instale/parseie.
import { parseStructured } from "./parse.js";
import { mockFromSourceId } from "./mock.js";
import type { StructDial, Layer } from "./types.js";

export interface Issue {
  level: "error" | "warn";
  /** índice da camada (quando o problema é de uma camada específica). */
  layer?: number;
  msg: string;
}

const MAX_DIM = 0x7ff; // 11 bits no dimsWord

/** Checa o estado EM MEMÓRIA (antes de exportar). `error` = não instala/corrompe; `warn` = suspeito. */
export function validateDial(dial: StructDial): Issue[] {
  const issues: Issue[] = [];
  dial.layers.forEach((l, i) => {
    // Estrutural: delete/add/duplicate não ativam no relógio (firmware rejeita o layout reconstruído).
    if (l.deleted) issues.push({ level: "error", layer: i, msg: `"${l.name}": remover camada é estrutural — não instala (o relógio cai no dial original).` });
    if (l.isClone) issues.push({ level: "error", layer: i, msg: `"${l.name}": camada nova/duplicada é estrutural — não instala.` });
    // Imagem re-skinada não pode estourar o slot (same-footprint).
    if (l.newPayload && l.newPayload.length > l.assetLen) {
      issues.push({ level: "error", layer: i, msg: `"${l.name}": imagem ${l.newPayload.length}B > ${l.assetLen}B do slot — não cabe (same-footprint).` });
    }
    // Frames re-skinados: cada frame no seu orçamento.
    if (l.newFramePayloads && l.frameLens) {
      for (let f = 0; f < l.newFramePayloads.length; f++) {
        const fp = l.newFramePayloads[f];
        if (fp && fp.length > (l.frameLens[f] ?? 0)) {
          issues.push({ level: "error", layer: i, msg: `"${l.name}" frame ${f}: ${fp.length}B > ${l.frameLens[f]}B — não cabe.` });
        }
      }
    }
    // Resize: dimensões precisam caber no dimsWord.
    if (l.resized && (l.w > MAX_DIM || l.h > MAX_DIM || l.w < 1 || l.h < 1)) {
      issues.push({ level: "error", layer: i, msg: `"${l.name}": dimensão ${l.w}×${l.h} fora do limite (1..${MAX_DIM}).` });
    }
    // Fonte de dado: byte válido (0..0x8d) e reconhecida pelo tipo do slot.
    if (l.srcOff !== undefined && l.sourceId !== undefined) {
      if (l.sourceId < 0 || l.sourceId > 0x8d) {
        issues.push({ level: "error", layer: i, msg: `"${l.name}": fonte 0x${l.sourceId.toString(16)} fora do range (0x00..0x8d).` });
      } else if ((l.kind === "text" || l.kind === "pointer") && mockFromSourceId(l.sourceId) === "none") {
        issues.push({ level: "warn", layer: i, msg: `"${l.name}": fonte 0x${l.sourceId.toString(16)} não é reconhecida — pode não mostrar nada.` });
      }
    }
  });
  return issues;
}

/** true se `dial` tem QUALQUER edição pendente (usada p/ decidir se roda a validação final no export). */
export function hasEdits(dial: StructDial): boolean {
  return dial.layers.some((l) =>
    l.newPayload || l.deleted || l.isClone || l.resized ||
    (l.newFramePayloads && l.newFramePayloads.some(Boolean)),
  );
}

/** Rede de segurança FINAL: re-parseia os bytes exportados e confere invariantes contra o original.
 *  Qualquer `error` aqui deve BLOQUEAR o download (o arquivo não instala ou corrompe a lista de dials). */
export function validateBin(exported: Uint8Array, original: StructDial): Issue[] {
  const issues: Issue[] = [];
  // Same-footprint: tamanho idêntico é o único caminho de re-skin PROVADO no relógio.
  if (exported.length !== original.raw.length) {
    issues.push({ level: "error", msg: `footprint mudou (${original.raw.length}→${exported.length}B) — o relógio tende a armazenar sem ativar (a065=0x0a).` });
  }
  // Envelope da cena intacto (0x20 em 0x24), se o original tinha.
  const hadEnvelope = original.raw.length >= 0x2a && original.raw[0x24] === 0x20;
  if (hadEnvelope && !(exported.length >= 0x2a && exported[0x24] === 0x20)) {
    issues.push({ level: "error", msg: "envelope da cena corrompido (byte 0x24 ≠ 0x20)." });
  }
  // Re-parse: precisa parsear sem lançar e manter a contagem de camadas.
  try {
    const re = parseStructured(exported);
    if (re.layers.length !== original.layers.length) {
      issues.push({ level: "error", msg: `contagem de camadas mudou (${original.layers.length}→${re.layers.length}) — layout inconsistente.` });
    }
  } catch (e) {
    issues.push({ level: "error", msg: `bytes exportados não re-parseiam: ${(e as Error).message}` });
  }
  return issues;
}

/** Só os erros duros (bloqueiam export/download). */
export function errorsOf(issues: Issue[]): Issue[] {
  return issues.filter((x) => x.level === "error");
}

/** Tamanho comprimido "usado" de uma camada (payload novo, ou o `len` original do slot). */
export function usedBytes(l: Layer): number {
  return l.newPayload?.length ?? l.assetLen;
}
