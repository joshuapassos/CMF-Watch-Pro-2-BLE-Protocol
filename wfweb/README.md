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

## Arquitetura

```
src/codec/   lz4 · rgb565 · parse · scene(0x20 TLV) · render · encode · notation   (puro, testável)
src/ui/      app · canvas · panels(inspector/assets) · jsoneditor · fileio · imageutil
```

Formato do `.bin`: ver `../spec/24-watchface-formato.md`.
