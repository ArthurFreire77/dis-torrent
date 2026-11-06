# Skill: distorrent-app

Controla o **app REAL do DisTorrent** (janela WebView2 no Windows) por CDP, para
ver a interface de verdade, medir layout na janela real e reproduzir bugs com o
motor real (Tauri IPC, SQLite, motor P2P em Rust, WebRTC da WebView).

Não é aba de navegador: é o binário aberto na tela do usuário.

## REGRA DURA — a conta do usuário é intocável

O app real usa `%APPDATA%\com.distorrent.app` (SQLite + log). **Nunca** mova,
apague, renomeie ou substitua `distorrent.db*`. Apagar o `.db` faz o app abrir em
"Criar conta" e a conta do usuário some da tela — já aconteceu uma vez.

Neste app:

- ✅ medir layout, ler DOM, tirar print, ler log, ler estado das stores
- ✅ clicar em navegação que não escreve (abrir canal, abrir painel)
- ❌ criar conta, importar cofre, trocar nome, apagar conversa/grupo
- ❌ qualquer coisa que grave no SQLite do usuário

Fluxo que **cria identidade** (criar conta, importar cofre, dois dispositivos
com contas separadas) roda no **modo navegador**: `npm run dev` + Chromium do
Playwright. Lá o estado é `sessionStorage`/`localStorage` do contexto efêmero e
não encosta no banco do app. Ver `reference.md`.

Se um teste realmente precisar de uma segunda instância do app nativo, isso
exige decisão do usuário (o app é single-instance) — pergunte antes.

## Começar

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .opencode/skills/distorrent-app/app.ps1 status
```

Se responder `CDP OFF`, suba o app com depuração (fecha o app: avise o usuário):

```powershell
... app.ps1 launch
```

## Comandos

| comando | o que faz |
|---|---|
| `app.ps1 status` | app e porta 9222 de pé? |
| `app.ps1 launch` | sobe o app real com CDP (**fecha o app atual**) |
| `app.ps1 kill` | fecha o app e o WebView2 |
| `app.ps1 eval "<js>"` | roda JS no contexto da página, imprime JSON |
| `app.ps1 shot <arquivo.png>` | print da janela real |
| `app.ps1 layout` | mede a árvore de layout e acusa caixa esmagada |
| `app.ps1 prova` | **antes/depois numérico** do painel vs. coluna principal |
| `app.ps1 watch [seg]` | amostra o layout e grava quando muda |
| `app.ps1 log [win\|core] [n]` | log do WebView ou do core |

## Prova antes/depois (o padrão obrigatório)

```powershell
... app.ps1 launch
... app.ps1 prova
```

`prova` abre um canal de texto (só navegação, não grava nada), mede o chrome
fixo real no DOM, aplica a margem da regra antiga e da nova e imprime as duas
larguras do composer. Saída de referência (janela 1280, servidor aberto):

```
painel      ANTIGO margem  coluna  composer   |  NOVO margem  coluna  composer
normal          461     247        85   |      0     708       546
expanded        717       0         0   |      0     708       546
```

Sem os dois números, a correção não está provada.

## Medir layout (o caso do "vídeo/coluna achatada")

`layout` devolve `viewport`, `nodeCount` e `problems[]`, classificando:

- `squeezed` — `clientWidth < scrollWidth` (conteúdo mais largo que a caixa)
- `flattened` — `clientHeight < scrollHeight` com `overflow: hidden`
- `sliver` — caixa com menos de 90 px numa direção dentro de pai grande

A assinatura do bug relatado é um `<textarea>` do composer com `clientWidth`
minúsculo (desenha **uma letra por linha**) enquanto uma região grande fica
vazia ao lado. `watch` mostra **qual ação** (abrir painel, entrar em chamada,
abrir servidor) provoca o colapso.

## Não confunda

- Print prova pixel, não prova áudio/vídeo nem conexão entre máquinas.
- `eval` roda com os poderes do app (Tauri IPC) — use o mínimo necessário.
- O CDP escuta só em `127.0.0.1` e só enquanto o app roda. Feche com `kill`.
