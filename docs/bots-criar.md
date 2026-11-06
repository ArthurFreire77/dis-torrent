# Criar um bot do DisTorrent — guia do criador

**Como o bot funciona hoje, no código (schema v3).** Se algo não existe, está
dito aqui. O documento de referência técnica é `docs/bots.md`; este é o passo a
passo.

Um bot tem duas partes:

| Parte | Onde vive | Você configura? |
|---|---|---|
| **Bot do servidor** (nome, avatar, cargo, permissões, comandos) | banco do servidor | no painel do app |
| **Código do bot** (opcional) | uma pasta no PC de quem é dono do servidor | não: o app injeta tudo |

**Não existe token para colar em código.** Quem roda é o PC do dono; o servidor
entrega as mensagens a todos os membros (Windows, Linux, Android). O app gera a
credencial da ponte local sozinho e injeta no processo do plugin.

---

## 1. Escolha o modo antes de começar

`schema` v3 exige `mode` explícito. Escolher errado aqui é a maior fonte de
frustração.

| `mode` | Quando usar | O que precisa |
|---|---|---|
| `declarative` | 90% dos casos: resposta fixa, consulta HTTP, script, moderação. | Só a config. |
| `plugin` | Precisa de biblioteca, estado próprio, integração que a DSL não faz. | App aberto + runtime (Node/Python) instalado. |
| `service` | Você já tem um serviço na web e quer receber eventos por webhook. | App aberto para enviar; endpoint http(s) público. |
| `remote` | Você quer conectar de fora por TLS. | **Ainda não funciona:** não há transporte de entrada nesta versão. |

`runtime` só tem sentido em `plugin`:

| `runtime` | Estado |
|---|---|
| `none` | Sem processo; só a DSL. Padrão de `declarative`. |
| `process` | Executa a pasta como processo filho. Padrão de `plugin`. |
| `wasm` | **Não existe nesta versão: é recusado na leitura**, com erro explícito. |

---

## 2. Bot simples, sem código — 2 minutos

1. Abra **Bots** (menu do servidor, ou a rota `/bots`).
2. **Criar bot** → nome (2 a 32 caracteres) → **Criar bot**.
3. No cartão do bot, abra **Configurar** (ícone de engrenagem).
4. Aba **Comandos** → **Adicionar comando** → escolha o tipo:
   - **Resposta fixa** → escreva a resposta → **Salvar**.
   - **Chamar API (HTTP)** → URL + `responsePath` + template → **Salvar**.
   - **Script (DSL)** → as instruções, uma por linha.
   - **Ação administrativa** → escolha a ação → aba **Permissões** → marque o
     bit que ela exige → **Salvar**.

Pronto: ele responde no servidor **sem** abrir ponte e **sem** rodar nada.

O JSON que o editor grava é este (o `integrations` é preenchido sozinho):

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "commands": [
    { "name": "ajuda", "exec": "reply", "reply": "Comandos: !ping, !serverinfo" },
    { "name": "ping", "exec": "reply", "reply": "pong", "cooldownMs": 3000 },
    { "name": "serverinfo", "exec": "admin", "admin": "serverinfo" }
  ],
  "channels": [],
  "channelKinds": [],
  "events": [],
  "blockPrivate": true,
  "maxRepliesPerMinute": 20,
  "integrations": {
    "http": { "allowDomains": [], "maxCallsPerMinute": 60 },
    "limits": { "maxMessagesPerExecution": 20 },
    "retention": { "hours": 24 }
  }
}
```

---

## 3. Bot a partir de uma pasta pronta

1. Baixe/clone a pasta do bot (tem `bot.json` dentro).
2. **Adicionar bot existente** → cole o caminho da pasta → **Importar pasta**.

O app lê o `bot.json`, valida a config no **mesmo parser do core** e cria o bot
com nome e avatar. **Nada roda ainda.**

Regras que a importação aplica de verdade:

| Regra | Limite |
|---|---|
| Tamanho do `bot.json` | 256 KB |
| `name` | ≥2 caracteres (o app corta em 32) |
| `config` | objeto; precisa passar no parser |
| Conteúdo mínimo | `commands`, `events` ou `webhook` — senão "o bot não faz nada" |
| Listagem de arquivos | 200 arquivos, profundidade 4; ignora `.env`, `node_modules`, `target`, `.git`, `dist` |

`run` e `requires` são lidos, mas **não são aplicados na importação**: o comando
de execução é digitado na aba **Ponte e plugin**, e `requires` é só informativo.

---

## 4. Escrever o primeiro plugin

### 4.1 A pasta

```
meu-bot/
├── bot.json          ← obrigatório
├── bot.js            ← seu código
└── package.json      ← opcional
```

`bot.json`:

```json
{
  "name": "MeuBot",
  "avatar": "🤖",
  "description": "O que ele faz",
  "run": "node bot.js",
  "config": {
    "schema": 3,
    "mode": "plugin",
    "runtime": "process",
    "prefix": "!",
    "events": ["member_joined"],
    "commands": [
      { "name": "ping", "exec": "reply", "reply": "pong" }
    ]
  }
}
```

### 4.2 O código

Não há SDK, não há token. O app entrega a URL já autenticada em
`DISTORRENT_BOT_URL`.

```js
const url = process.env.DISTORRENT_BOT_URL // já autenticada: nada a configurar

async function post(channel, body) {
  const res = await fetch(`${url}/v1/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Sem isto, um retry de rede posta a mensagem duas vezes.
      'idempotency-key': `msg-${Date.now()}-${Math.random()}`,
    },
    body: JSON.stringify({ channel, body }),
  })
  return res.json()
}

// Descubra os limites reais em vez de adivinhar.
const limits = await (await fetch(`${url}/v1/limits`)).json()

let since = 0
for (;;) {
  const res = await fetch(`${url}/v1/events?since=${since}&wait=20000`)
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 60000)) // respeite o balde
    continue
  }
  const { events, since: last } = await res.json()
  if (typeof last === 'number') since = last
  for (const e of events ?? []) {
    if (e.event === 'message_new' && e.data.body === '!ping') {
      await post(e.data.conv_id, 'pong')
    }
  }
}
```

### 4.3 Rodar

1. **Configurar** → aba **Ponte e plugin** → **Abrir ponte** (o app escolhe uma
   porta livre e gera o segredo).
2. Preencha **Pasta do bot** e **Comando de execução** (`node bot.js`).
3. **Iniciar plugin**.

O processo recebe:

| Variável | Valor |
|---|---|
| `DISTORRENT_BOT_URL` | `http://127.0.0.1:<porta>/b/<segredo>` |
| `DISTORRENT_BOT_PORT` | a porta |
| `DISTORRENT_API` | `distorrent-bot/1` |

O ambiente é limpo (`env_clear`): só `PATH` e estas variáveis. `cwd` é a pasta do
bot; `stdin` é nulo; stdout/stderr aparecem no console do painel.

`run` vira **argv direto, sem shell** — `;`, `&&` e `|` são argumentos literais —
e o programa precisa estar **dentro** da pasta importada.

---

## 5. Testar

Não existe comando "testar" no painel atual. O caminho real é:

1. **Mande o comando no canal.** O console (aba **Console**) mostra
   `/<nome> respondeu (Nms)` ou o motivo da recusa.
2. **Leia o console** para `warn`/`error`: permissão faltando, URL bloqueada,
   `responsePath` inexistente, HTTP ≥400.
3. **Para o plugin**, use `/v1/health` e `/v1/info` com a URL da ponte:

```bash
curl "$DISTORRENT_BOT_URL/v1/health"
curl "$DISTORRENT_BOT_URL/v1/info"
```

4. **Diagnostique a config sem gravar** pelo comando de casca
   `bot_config_validate` (exposto como `services.botConfigValidate`): ele devolve
   o erro exato do campo. Nenhuma tela chama isso hoje — use o console do devtools
   ou salve pelo painel, que valida antes de gravar.

Checklist antes de publicar:

| Verificar | Como |
|---|---|
| Config válida no core | salvar pelo painel; erro aparece na hora |
| Comando responde | mandar no canal e olhar o console |
| Permissão certa | aba **Permissões**; `permAllows` do painel espelha o core |
| URL pública e na allowlist | `http.allowDomains` na aba **Modo e primitivas** |
| Sem loop | a mensagem do próprio bot não volta em `/v1/events` |
| Sem duplicata em retry | `Idempotency-Key` nos POSTs |
| Webhook assinado | segredo ≥16 chars + `x-distorrent-signature` conferido |

---

## 6. Publicar

Não existe marketplace, federação nem registro oficial. Publicar é:

1. Suba a pasta (com `bot.json`) num repositório público.
2. Escreva um `README.md` dizendo o modo, os comandos, as permissões exigidas e
   as variáveis (se o seu código usa alguma).
3. Quem for usar baixa e faz **Adicionar bot existente**.

Antes de publicar, **não** inclua token, segredo de webhook, `.env` ou dados de
servidor real.

---

## 7. O que NÃO existe nesta versão

Isto é a lista do que o prompt original pedia e o código **não** tem. Se você
precisar de um destes, não é bug de configuração — o recurso não existe.

| Recurso | Estado |
|---|---|
| SDK oficial (JS, Python, Rust) | **não existe** — a API é HTTP na ponte |
| CLI de bots | **não existe** |
| Módulo WASM (`runtime: "wasm"`) | **não existe** e é recusado na leitura |
| Embed (cartão com título/campos) | **não existe** |
| Componente (botão, select, modal) | **não existe** |
| Anexo de arquivo pelo bot | **não existe** |
| Bot em canal de voz / áudio / tela | **não existe** |
| Bot-a-bot (`invokeBot`) | **não existe** |
| Marketplace de bots | **não existe** |
| Federação entre servidores | **não existe** |
| Replay de eventos | **não existe** — buffer em memória de 500 |
| OpenTelemetry / tracing | **não existe** — só `bot_logs` |
| Canary / deploy gradual | **não existe** |
| TTL em chave-valor | **não existe** — `bot_vars` não expira |
| Blob / storage binário por bot | **não existe** |
| Fila / cron / agendamento (`job`) | **não existe** |
| Vault / segredo por bot | **não existe** |
| Edição de mensagem em streaming (`edit`) | **não existe** |
| Mensagem direta (DM) por bot | **não existe** |
| Exportar `bot.json` pelo painel | **não existe** — só importar pasta |
| Testar comando sem postar | **não existe** no painel atual |
| Modo `remote` com transporte de entrada | **não existe** — só o rótulo |
| Janela separada de bots | **funciona no desktop**; no celular a tela é a rota `/bots` |

Também vale saber: `integrations.http.maxCallsPerMinute`,
`integrations.limits.maxMessagesPerExecution` e `integrations.retention.hours`
são **declarados e devolvidos** em `/v1/limits`, mas **não são aplicados**. O
corte real de mensagens por script é **8**.

---

## 8. Problemas comuns

| Sintoma | Causa | Solução |
|---|---|---|
| não responde | bot offline / prefixo errado / canal fora do escopo / primitiva desligada | confira os quatro |
| "não tem permissão para ban" | falta o bit | aba **Permissões** |
| "config inválida" | `schema`, `mode`, `prefix` ou URL recusados | leia a mensagem: ela aponta o campo |
| "config de bot muito grande (máx 16KB)" | config entre 16 e 64 KB | encurte scripts/templates |
| "runtime `wasm` ainda não existe" | `runtime: "wasm"` | use `process` ou `declarative` |
| "bot.json não encontrado" | apontou o arquivo, não a pasta | importe a **pasta** |
| "o bot não faz nada" | config sem commands/events/webhook | adicione um |
| "programa não encontrado na pasta" | `run` aponta para fora | ponha o código dentro da pasta |
| "abra a ponte antes de iniciar o plugin" | plugin precisa da URL | **Abrir ponte** |
| ponte responde 404 | URL sem o segredo | use a URL que o app mostra |
| ponte responde 403 | chamada de navegador (`Origin`), ou sem permissão | chame por programa; conceda o bit |
| ponte responde 421 | `Host` não é loopback | use `127.0.0.1:porta` |
| ponte responde 429 | >120 req/min | diminua a frequência |
| evento duplicado | retry sem `Idempotency-Key` | mande a mesma chave |
| webhook não chega | URL inválida/não http(s) ou serviço fora | o runtime tenta 2× e loga `warn` |
| plugin não sobe | falta runtime (node/python) | instale ou use a DSL |

---

## 9. Arquivos que mandam

| Arquivo | Papel |
|---|---|
| `distorrent-core/src/bots.rs` | parser, migração, DSL, guarda de URL |
| `distorrent-core/src/moderation.rs` | `BOT_ACTIONS`, bits e `perm_can_grant` |
| `distorrent-core/src/net/engine.rs` | `bot_create`, `bot_action_in`, `bot_replace_config` |
| `src-tauri/src/botbridge.rs` | rotas da ponte, rate limit, idempotência |
| `src-tauri/src/botplugin.rs` | execução do processo do plugin |
| `src/services/botCommands.ts` | modelo do editor, `permAllows`, `urlProblem` |
| `src/services/botEngine.ts` | runtime declarativo |
| `src/services/botWebhook.ts` | assinatura HMAC do webhook |
| `src/components/server/BotPanel.tsx` | painel do bot (abas reais) |
| `docs/bots.md` | referência técnica completa |

---

## 10. Gates antes de entregar

```powershell
$env:PATH = "$env:TEMP\node24\node-v24.22.1-win-x64;$env:PATH"
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run typecheck
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run lint
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run test:unit
```

Suítes que cobrem bot: `botCommands`, `botRuntime`, `botSchemaV3`, `botWizard`,
`botsDocSync` (no front) e `bots.rs`, `bots_exec.rs`, `botbridge.rs`,
`botplugin.rs` (no Rust).
