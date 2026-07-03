// Tipos do codec — espelham os structs Rust em `core-rust/src/watchface_struct.rs`.

/** Tipo de camada (para UI/edição). */
export type LayerKind =
  | "background" // fundo (sem record; posição implícita 0,0 ou centrado)
  | "image" // imagem estática posicionada (record 61 01 00)
  | "pointer" // ponteiro (record 61 01 00, f3==0x70) — rotaciona em runtime
  | "text" // widget de texto/número (record 61 0a 00) — atlas de glifos
  | "arc" // anel de progresso (0x81): disco cf5 recortado num setor = valor/max (spec 25 §2)
  | "other"; // asset não posicionado (thumb/atlas) — não editável por geometria

/**
 * Que dado de RUNTIME um elemento representa. O relógio desenha o valor real; o editor mostra um
 * mock (valor de exemplo) só no preview — NÃO é persistido no `.bin`.
 */
export type MockKind =
  | "none"
  | "time"
  | "hour"
  | "minute"
  | "seconds"
  | "ampm"
  | "date"
  | "weekday"
  | "steps"
  | "kcal"
  | "bpm"
  | "battery"
  | "temp"
  | "distance"
  | "percent"
  | "generic";

/** Uma camada do dial. Guarda os offsets dos campos editáveis no `raw` p/ reescrita in-place. */
export interface Layer {
  kind: LayerKind;
  name: string;
  cf: number;
  w: number;
  h: number;
  /** Offset do dimsWord do asset no `raw`. */
  assetOff: number;
  /** Tamanho atual do payload LZ4 do asset (campo `len`). */
  assetLen: number;
  /** Posição/âncora no canvas 466² (canto sup-esq = (x−pivotX, y−pivotY)). */
  x: number;
  y: number;
  pivotX: number;
  pivotY: number;
  /** Offsets dos campos no `raw` p/ reescrever (undefined p/ Background, que não tem record). */
  xOff?: number;
  yOff?: number;
  pivxOff?: number;
  pivyOff?: number;
  /** Payload LZ4 novo (setado por uma troca de imagem); aplicado no `encodeInPlace`. */
  newPayload?: Uint8Array;
  visible: boolean;
  /** Dado de runtime que este elemento mostra (mock no preview; NÃO persistido no `.bin`). */
  mock: MockKind;
  /** Id da fonte de dado do firmware (0x00–0x8d), se for texto/complicação/ponteiro. */
  sourceId?: number;
  /** Offset no `raw` do byte da fonte (p/ reescrever no export). */
  srcOff?: number;
  /** Offset no `raw` dos 3 bytes RGB da cor (p/ reescrever no export). */
  colorOff?: number;
  /** Nº de frames do frame-sheet (complicação fill por frame-index); 1/undefined = imagem única. */
  frames?: number;
  /** Cor RGB do elemento (tinge máscara A8 cf=13, colorida em runtime). undefined = branco. */
  color?: [number, number, number];
  /** Anel de progresso (kind "arc"): denominador do valor (setor = valor/arcMax × 360°). */
  arcMax?: number;
  /** Largura da linha do arco vetorial compacto (0x5b+12); undefined = anel cheio/texturizado. */
  arcWidth?: number;
  /** Override de frame p/ preview (scrubber do editor); undefined = frame vem do valor mock. */
  previewFrame?: number;
  /** Marcada p/ remoção — some do preview e é omitida no export (rebuild do container). */
  deleted?: boolean;
  /** Camada NOVA (clone de um nó existente) — inserida no export via rebuild. */
  isClone?: boolean;
  /** Variante ALWAYS-ON (do container `0x22`): só aparece no modo AOD do editor, não na tela normal. */
  aod?: boolean;
  /** Largura/altura do RECT do picregion de um img_number standalone (distribui os dígitos). W=0 =
   *  amontoa; setar largura espalha N dígitos. Offsets p/ reescrever in-place. */
  rectW?: number;
  rectH?: number;
  rectWOff?: number;
  rectHOff?: number;
  /** Chave `assetOff,x,y` do nó-fonte a clonar (bytes comprovados) no rebuild. */
  sourceKey?: string;
}

/** Dial estruturado parseado + editável. */
export interface StructDial {
  perDialId: number;
  name: string;
  sizeA: number;
  layers: Layer[];
  raw: Uint8Array;
  /** Frames do fundo (assets de mesmo cf/w/h = "frame-sheet"). `(assetOff, len)` por offset. */
  bgFrames: Array<[number, number]>;
  bgFrameIdx: number;
  /** Variante AOD do fundo `(off,len)`, quando há par ativo+AOD. */
  aod?: [number, number];
}

/** Um asset escaneado do pool: `(offsetDoDimsWord, cf, w, h, len)`. */
export type ScannedAsset = [number, number, number, number, number];

// ---- Notação JSON (fonte de verdade da UI) ----

export interface NotationAsset {
  cf: number;
  w: number;
  h: number;
  /** PNG data-URL do asset decodificado (p/ visualizar/editar). */
  src: string;
  /** Nº de glifos consecutivos, quando é um atlas de dígitos. */
  atlas?: number;
}

export interface NotationLayer {
  type: LayerKind;
  /** chave em `assets` (ou "background"/"image"/"pointer"). */
  asset?: string;
  x?: number;
  y?: number;
  pivotX?: number;
  pivotY?: number;
  /** nome legível da fonte de dado (hour/minute/second/steps/...). */
  source?: string;
  visible?: boolean;
  /** cor `#rrggbb` (anel de progresso / tint de dígito cf=13). */
  color?: string;
  /** denominador do anel de progresso (setor = valor/max). */
  arcMax?: number;
  /** nº de frames do frame-sheet (informativo). */
  frames?: number;
}

export interface Notation {
  format: "cmf-wf/1";
  id: number;
  name: string;
  size: [number, number];
  assets: Record<string, NotationAsset>;
  layers: NotationLayer[];
}
