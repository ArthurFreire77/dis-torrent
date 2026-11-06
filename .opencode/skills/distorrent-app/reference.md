# Referência — app real, modo navegador e segurança do perfil

## 1. Onde o app guarda estado

| Caminho | Conteúdo |
|---|---|
| `%APPDATA%\com.distorrent.app\distorrent.db` | identidade, conversas, mensagens, comunidades, voz |
| `%APPDATA%\com.distorrent.app\distorrent.db-wal` / `-shm` | WAL do SQLite (faz parte do banco) |
| `%APPDATA%\com.distorrent.app\distorrent.log` | log do core (Rust) |
| Credential Manager, alvo `identity.secret`, usuário `distorrent-app` | segredo ed25519 (fallback dentro do SQLite) |

O segredo é lido **primeiro do SQLite** (`load_secret_hex`); o Credential
Manager é fallback. Ou seja: quem manda é o `.db`.

## 2. Por que "criar conta" no app real é proibido

`create_identity` regrava a identidade no SQLite e reinicia o motor. Se o `.db`
do usuário estiver no lugar, a conta dele é substituída. Se o `.db` for movido,
o app abre em "Criar conta" e a conta **parece** perdida.

Recuperação, se algum dia acontecer de novo:

```powershell
$d = "$env:APPDATA\com.distorrent.app"
Stop-Process -Name distorrent -Force -ErrorAction SilentlyContinue
# o backup tem de existir ANTES; sem backup não há recuperação (chave privada)
Copy-Item "$env:APPDATA\dt-rig-orig\distorrent.db"     "$d\distorrent.db" -Force
Copy-Item "$env:APPDATA\dt-rig-orig\distorrent.db-wal" "$d\distorrent.db-wal" -Force
Copy-Item "$env:APPDATA\dt-rig-orig\distorrent.db-shm" "$d\distorrent.db-shm" -Force
```

Confira depois: a lista de conversas tem de voltar e o mesmo fingerprint tem de
aparecer em Definições.

## 3. Modo navegador (onde criar conta É seguro)

```powershell
$env:PATH = "$env:TEMP\node24\node-v24.22.1-win-x64;$env:PATH"
npm run dev            # vite em http://127.0.0.1:5173
```

```js
// script Node com playwright-core
const { chromium } = require('playwright-core')
const b = await chromium.launch({ headless: false, args: ['--use-fake-ui-for-media-stream'] })
const ctx = await b.newContext()          // contexto efêmero: nada toca o app
const a = await ctx.newPage(); const c = await ctx.newPage()
await a.goto('http://127.0.0.1:5173');    // "Criar conta" aqui é descartável
```

`services.kind === 'browser'`: o estado vive em `sessionStorage`/`localStorage`
e a presença entre abas vai por `BroadcastChannel`. **Prova** negociação,
render, layout e regras; **não prova** o motor Rust nem conexão entre máquinas
físicas.

Para câmera/captura dentro do navegador, as flags que funcionam:

```
--use-fake-ui-for-media-stream
--use-fake-device-for-media-stream   (câmera sintética, imagem de teste)
--auto-select-desktop-capture-source=Entire screen
--allow-http-screen-capture
```

## 4. Medir sem escrever

`layout` e `eval` só leem. Para forçar estados da UI sem gravar nada, prefira
navegação pura (abrir canal, abrir painel de downloads, abrir diagnóstico) e
`window.innerWidth/innerHeight` do próprio app.

Para provar o bug de coluna esmagada, basta:

1. `layout` no estado normal → guarde `problems`.
2. Reproduza o estado (abrir o painel da chamada, redimensionar, abrir servidor).
3. `layout` de novo → compare; a coluna do `<textarea>` cai de ~600 px para
   poucas dezenas de px.

## 5. Encerrar

```powershell
... app.ps1 kill
```

Deixe o app fechado ou reaberto **sem** a variável de depuração quando terminar —
o CDP aberto permite a qualquer processo local controlar a página.
