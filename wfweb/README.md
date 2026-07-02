# wfweb — editor de watchface CMF (100% no navegador)

Editor de watchface do **CMF Watch Pro 2** que **lê e edita `.bin`** inteiramente no front-end — sem
backend, hospedável no GitHub Pages. Porta o codec validado do core Rust
(`../cmfwatch/core-rust/src/watchface_struct.rs`) + Python (`../work/codec_dfa.py`) para TypeScript
puro, no espírito do `watchface-web-editor`: app estático + **notação JSON legível** + preview em
`<canvas>`.

## O que faz (v1)

- **Abre** um `.bin` estruturado da loja → parseia camadas (fundo cf=4, sprites cf=5/24, ponteiros,
  texto/atlas) e mostra a **árvore de camadas** + **preview 466²** ao vivo.
- **Edita**: mover camadas (arrastar no canvas ou X/Y/pivô no inspector), trocar imagem de qualquer
  camada (PNG/JPEG → cf da camada, LZ4), trocar o fundo, alterar a fonte de dado (mock) e visibilidade.
- **Notação JSON**: editor de texto ao vivo (fonte de verdade legível) com barra de erro.
- **Exporta** um `.bin` (same-footprint, caminho de templating confirmado que renderiza no relógio).
- **Novo photo-dial**: gera um `.bin` `6c8dc4a5` a partir de uma imagem (466² + thumb 270²).

O **envio ao relógio** (BLE) continua no app/core existente — o editor só exporta o arquivo.

## Rodar

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # gera dist/ estático (GitHub Pages)
npm test           # vitest: roundtrip byte-exato nos 103 dials + decode + render
```

## Testes (oráculo)

`npm test` valida contra o corpus real em `../work/store_dials/`:
- **roundtrip**: `parse → encodeInPlace` byte-idêntico nos 103 `.bin`; cena TLV `parse → serialize` idem.
- **decode**: todo asset cf=4/5/24 descomprime exato em `w*h*bpp`; LZ4 round-trip.
- **render**: `renderAt` preserva o fundo (invariante blend-só-adiciona).

**Oráculo visual** (`/compare.html` no dev server): renderiza os 103 dials da loja @ 10:12 pelo
pipeline real do app e compara pixel-a-pixel com os PNGs oficiais (corpus symlinkado em
`public/corpus`). Tabela ordenável com render/asset lado a lado; dados brutos em `window.results`.
É o **guard de regressão** de qualquer mudança em `parse.ts`/`render.ts` (estado 02/07:
**72 bons / 25 médios / 2 ruins, diff médio 6.4%**). Os 2 ruins: 282 (animação tick-driven,
intratável por thumbnail estático) e 284 (dígitos-arte ~31%, visualmente quase idêntico).

### Mecanismos de render decodificados (cruzados com o SDK Actions + firmware RE)
- **Frame-sheet / flip-clock:** drawable com `61 [count>1][base]` → o valor seleciona 1 frame
  (`frame=valor` p/ dígito/enum, `(count−1)·val/100` p/ %). Ex. 327 (hora 0–12).
- **Anel de progresso (`0x81`):** 1 disco (`count==1`) recortado num **setor** (`blendSector`,
  `frac=valor/max`) — corrige a leitura "frame-sheet" da spec 25 §2. 20 dials.
- **cf=13 (máscara A8):** tingida pela cor RGB do elemento (`body+11`); dígito único por fonte
  tens/units (spec 25 §1.1). Atlas segue a ordem do pool (glifos de tamanho variável).

## Parser de camadas = cena TLV (spec 26)

Imagens e ponteiros vêm de `scanSceneDrawables` (walker da cena `0x20→0x21→folhas`, spec 26 =
SDK Actions): corpo `01 xx 00 [X][Y] … 61 [count][base][ids] [05 05 00 01 pivX pivY]`, com
X/Y = canto sup-esq e centro de rotação do ponteiro = **(X+pivX, Y+pivY)**. O scan plano de
`61 01 00` era **off-by-one entre nós adjacentes** (ver spec 24 §24.4.5) e ficou só para TEXTO
e como fallback de `.bin` sem envelope-cena.

## Arquitetura

```
src/codec/   lz4 · rgb565 · parse · scene(0x20 TLV) · render · encode · notation   (puro, testável)
src/ui/      app · canvas · panels(inspector/assets) · jsoneditor · fileio · imageutil
```

Formato do `.bin`: ver `../spec/24-watchface-formato.md`.
