# Como testar o DisTorrent (regra para qualquer agente)

> **Regra do dono:** todo agente que for testar o DisTorrent testa **do mesmo jeito
> que o agente principal testa**: no app de verdade e com prova numérica, não por
> leitura de código. Código alterado ≠ bug corrigido.

## 1. Hierarquia de evidência

Só vale como prova, nesta ordem:

1. **App real medido** — binário `src-tauri/target/release/distorrent.exe` aberto
   na máquina, controlado por CDP, com número antes/depois. Skill
   `distorrent-app` (`app.ps1`).
2. **Dois processos de verdade** — duas instâncias do motor (Rust) ou duas
   máquinas, para o que é rede/mídia. `cargo test` de integração com dois nós
   (`distorrent-core/tests/`) é o padrão aceito.
3. **Navegador real** (Playwright + Chromium local) — para WebRTC e layout no
   mesmo motor da WebView. Prova negociação/render; **não** prova o motor Rust
   nem conexão entre máquinas.
4. **Teste unitário** — trava a regra pura. Necessário, nunca suficiente.
5. **Leitura de código** — só serve para formular hipótese.

Print de tela prova **pixel**. Não prova áudio, vídeo, conexão, nem que o
download terminou íntegro.

## 2. O ciclo obrigatório (o mesmo que usei)

```powershell
# 0. baseline: nada pode estar vermelho antes de você mexer
powershell -NoProfile -ExecutionPolicy Bypass -File .opencode/skills/distorrent/run-verify.ps1

# 1. reproduza o bug e GUARDE o número
powershell -NoProfile -ExecutionPolicy Bypass -File .opencode/skills/distorrent-app/app.ps1 layout

# 2. conserte e prove a regra pura
npm run typecheck; npm run lint; npm run test:unit

# 3. recompile e MEÇA o mesmo número no app real
npm run tauri build -- --no-bundle
... app.ps1 launch
# compare antes/depois; se o número não mudou, NÃO está corrigido
```

Regra prática: **se você não tem um número antes e o mesmo número depois, não
declare correção.**

## 3. Prova de layout (o bug do "achatado")

O composer com uma letra por linha é a assinatura de coluna colapsada. Medir:

```js
// no app real, via app.ps1 eval
const ta = document.querySelector('textarea')
const r = ta?.getBoundingClientRect()
return { w: Math.round(r.width), h: Math.round(r.height) }
```

Com painel de chamada aberto, `w` **tem** de ficar ≥ 320 px em janela de
1280 px. Antes da correção dava 85 px em 1280 e 0 a partir de 1100 px.

`app.ps1 layout` já classifica `squeezed` / `flattened` / `sliver` sozinho.

## 4. Prova de câmera / tela entre dois pares

O que **não** prova nada: ver a própria câmera (é só o preview local).

O mínimo aceitável, automatizado, no navegador real:

- duas `RTCPeerConnection` no mesmo processo (loopback) com `ontrack`;
- `<video>` remoto com `videoWidth > 0`;
- `currentTime` avançando;
- amostra de pixels do canvas **não preta** (`notBlack`);
- `getStats()` com `framesDecoded` crescendo e `packetsReceived` > 0.

Modelo pronto: `e2e/screen-share-p2p.spec.ts` (captura real, WebRTC real,
métricas reais). Reuse antes de escrever outro.

Entre duas máquinas, o relato tem de vir com: os dois fingerprints, a rota ICE
reportada (`getRungSummary`), `packets_out`/`packets_in` e `video_codec` de cada
lado. Sem isso é opinião.

## 5. Prova de download

- hash do arquivo final **igual** ao da origem (blake3/sha256);
- arquivo com tamanho exato, sem `.part` sobrando;
- progresso medido em % > 0 e velocidade > 0 durante a transferência;
- interromper (matar a rede/peer) e retomar, conferindo que o hash final ainda bate;
- no Android, dizer honestamente o que é background e o que não é.

## 6. O que nunca fazer

- ❌ criar conta / importar cofre no **app real** (destrói a identidade do dono —
  ver `distorrent-app/reference.md`);
- ❌ mover ou apagar `%APPDATA%\com.distorrent.app\distorrent.db*`;
- ❌ declarar "funciona no Android" sem Android;
- ❌ declarar "corrigido" porque o build passou;
- ❌ rodar dois `tauri build` Linux em paralelo;
- ❌ commitar com teste vermelho.
