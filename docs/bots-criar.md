# Criar um bot do DisTorrent — guia completo

**Como o bot funciona hoje, no código.** Se algo não existe, está dito aqui.

Um bot tem **duas partes** que trabalham juntas:

| Parte | Onde vive | Precisa configurar? |
|---|---|---|
| **Bot do servidor** (nome, avatar, cargo, permissões, comandos) | banco do servidor | no painel do app |
| **Código do bot** (opcional) | uma pasta no PC do dono | não: o app injeta tudo |

**Nada de token para colar.** Quem roda é o PC do dono; o servidor entrega as
mensagens a todos os membros (Windows, Linux, Android). O app gera a credencial
da ponte local sozinho e injeta no processo do plugin.

---

## 1. Os três jeitos de criar

### A. Bot simples (sem código) — 30 segundos

1. Servidor → **Bots** → **Criar bot** → nome → **Criar bot**.
2. O cartão do bot aparece → **Configurar** (ícone de engrenagem).
3. Aba **Comandos** → **Adicionar comando** → escolha o tipo:

   - **Resposta fixa** → escreva a resposta → **Salvar**.
   - **Chamar API (HTTP)** → URL + caminho da resposta → **Salvar**.
   - **Ação administrativa** → escolha `/ban`, `/kick`, etc. → aba
     **Permissões** → marque o que ele pode → **Salvar**.

Pronto. Ele já responde no servidor **sem** abrir ponte e **sem** rodar nada.

### B. Bot existente (pasta) — o jeito recomendado para bots complexos

1. Baixe/clone a pasta do bot (tem `bot.json` dentro).
2. Servidor → **Bots** → **Adicionar bot existente**.
3. Cole o caminho da pasta → **Importar pasta**.

O app lê o `bot.json`, valida a config no core **antes** de criar e monta o bot
com nome, avatar, comandos, eventos e permissões. Nada roda ainda: só quando
você mandar.

### C. Bot programado (você escreve o código)

1. Crie a pasta:

```
meu-bot/
├── bot.json
├── bot.js
└── package.json     (opcional)
```

2. `bot.json`:

```json
{
  "name": "MeuBot",
  "avatar": "🤖",
  "description": "O que ele faz",
  "run": "node bot.js",
  "config": {
    "prefix": "!",
    "commands": [
      { "name": "ping", "exec": "reply", "reply": "pong" }
    ],
    "events": ["member_joined"]
  }
}
```

3. **Adicionar bot existente** → caminho da pasta → **Importar**.
4. **Configurar** → aba **Ponte e plugin** → **Abrir ponte**.
5. No mesmo painel, **Iniciar plugin** (o comando já vem preenchido do `run`).

O app define `DISTORRENT_BOT_URL` no processo — **sem token, sem `.env`,
sem colar nada**. Feche o app e o plugin morre junto.

---

## 2. Ligar o bot: os três estados

| Estado | O que significa | Como ligar |
|---|---|---|
| **online** | pode postar e executar | botão do olho no cartão do bot |
| **ponte aberta** | o plugin tem canal com o servidor | aba Ponte → Abrir ponte |
| **plugin rodando** | o código da pasta está executando | aba Ponte → Iniciar plugin |

Bot **offline não faz nenhuma chamada de rede** — nem comando, nem webhook.
Ponte sem plugin roda só a DSL embutida (comandos `reply`/`http`/`script`/`admin`).

---

## 3. Ações que o bot pode fazer

Tudo é validado **no core**, com a permissão que você concedeu. O dono do
servidor nunca é alvo.

### Mensagens e moderação

| Comando | Permissão | Uso |
|---|---|---|
| `/ban` `/unban` | banir | `<membro> [motivo]` |
| `/kick` | gerenciar | `<membro> [motivo]` |
| `/mute` `/unmute` | silenciar | `<membro> [minutos] [motivo]` |
| `/warn` `/warnings` | silenciar | `<membro> [motivo]` |
| `/clear` | apagar | `[#canal] [N]` |
| `/lock` `/unlock` | gerenciar | `[#canal]` |
| `/slowmode` | gerenciar | `[#canal] [segundos]` |

### Montar o servidor inteiro

Estas são as que deixam um bot criar a estrutura sozinho:

| Comando | Permissão | Uso |
|---|---|---|
| `/channel_create` | gerenciar | `<nome> [text\|voice\|video]` |
| `/channel_edit` | gerenciar | `<canal> <novo-nome>` |
| `/channel_delete` | gerenciar | `<canal>` |
| `/role_create` | gerenciar | `<nome> [#RRGGBB]` |
| `/role_delete` | gerenciar | `<cargo>` |
| `/role_assign` | gerenciar | `<cargo> <membro>` |
| `/role_unassign` | gerenciar | `<cargo> <membro>` |
| `/server_edit` | gerenciar | `<novo-nome>` |

### Consulta (sem permissão)

`/userinfo <membro>`, `/serverinfo`, `/ping`.

**Exemplo de bot que monta um servidor inteiro** (`bot.json`):

```json
{
  "name": "SetupBot",
  "avatar": "🏗️",
  "config": {
    "prefix": "!",
    "commands": [
      { "name": "montar", "exec": "script", "permission": "owner",
        "script": "admin channel_create regras text\nadmin channel_create avisos text\nadmin channel_create geral text\nadmin channel_create voz voice\nadmin role_create Membro #57f287\nadmin role_create Moderador #ed4245\nreply \"servidor montado\"" }
    ]
  }
}
```

Com a permissão **gerenciar** concedida, esse único `!montar` cria os canais e os
cargos de verdade (e o audit registra cada ação com o `bot_id`).

---

## 4. Comandos: os quatro tipos

```json
{ "name": "oi", "exec": "reply", "reply": "olá, {{raw.args}}!" }
```

```json
{ "name": "cep", "exec": "http", "method": "GET",
  "url": "https://viacep.com.br/ws/{{arg0}}/json/",
  "responsePath": "logradouro",
  "template": "{{value}} — {{json.bairro}}/{{json.uf}}" }
```

```json
{ "name": "pontos", "exec": "script", "cooldownMs": 5000,
  "script": "incvar pontos + 1\nreply \"você tem {{pontos}} pontos\"" }
```

```json
{ "name": "ban", "exec": "admin", "admin": "ban", "permission": "moderate" }
```

### Script (DSL, sem `eval`)

| Instrução | Efeito |
|---|---|
| `reply "texto"` / `ephemeral "texto"` | posta (até 8 por execução) |
| `let x = valor` | variável da execução |
| `getvar x = chave` / `setvar chave = valor` / `incvar chave + 5` | variável persistente do bot |
| `http get "url" as res` / `http post "url" body "..." as res` | chamada HTTP |
| `if <cond>` / `else` / `end` | desvio |
| `admin ban @alvo motivo` | ação administrativa |
| `stop` | encerra |

Condições: `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `startswith`,
`is empty`, `is not empty`. Limites: 200 linhas, 8 mensagens, 2000 passos.

### Placeholders

`{{args}}` `{{query}}` `{{arg0}}` `{{raw.args}}` `{{value}}` `{{json.campo}}`
`{{var.nome}}` `{{author}}` `{{bot}}` `{{channel}}` `{{event.campo}}`

---

## 5. Eventos

Marque na aba **Eventos**. Lista fechada:

`message_new`, `message_edited`, `message_deleted`, `mention`, `reaction`,
`member_joined`, `member_left`, `channel_created`, `channel_deleted`,
`call_started`, `call_ended`, `voice_joined`, `voice_left`.

Para reagir a um evento com script, crie um comando **com o mesmo nome do
evento**:

```json
{
  "events": ["member_joined"],
  "commands": [
    { "name": "member_joined", "exec": "script",
      "script": "reply \"bem-vindo, {{event.nickname}}!\"" }
  ]
}
```

---

## 6. O plugin: código do bot (automático)

Painel → aba **Ponte e plugin**:

1. **Abrir ponte** — o app abre `127.0.0.1` numa porta livre e gera o segredo.
2. **Iniciar plugin** — o app executa o `run` do `bot.json` com:
   - `DISTORRENT_BOT_URL` = URL completa **já autenticada**
   - `DISTORRENT_BOT_PORT` = a porta
   - `DISTORRENT_API` = `distorrent-bot/1`
   - ambiente limpo (só `PATH` e estas)
   - `cwd` na pasta do bot

`bot.js` mínimo:

```js
const url = process.env.DISTORRENT_BOT_URL // nada a configurar

const post = (channel, body) =>
  fetch(`${url}/v1/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, body }),
  })

let since = 0
for (;;) {
  const { events } = await (await fetch(`${url}/v1/events?since=${since}&wait=20000`)).json()
  for (const e of events ?? []) {
    since = e.seq
    if (e.event === 'message_new' && e.data.body === '!ping') {
      await post(e.data.conv_id, 'pong')
    }
  }
}
```

### Rotas da ponte

O segredo vai no caminho. Não há header de autenticação.

| Rota | O que faz |
|---|---|
| `GET /v1/info` | bot, servidor, canais e membros |
| `GET /v1/events?since=&wait=` | long-poll (até 25 s) |
| `GET /v1/config` | config atual **deste** bot |
| `POST /v1/message` | `{"channel":"geral","body":"texto"}` |
| `POST /v1/admin` | `{"action":"ban","target":"fp","reason":"","number":null}` |
| `POST /v1/commands` | `{"config":"<json>"}` — troca a **própria** config |
| `POST /v1/log` | `{"level":"info","message":"..."}` |
| `POST /v1/stop` | encerra a ponte |

> `POST /v1/commands` deixa o bot criar/editar **os próprios comandos** em tempo
> de execução. O core revalida a config inteira e **não** deixa o bot mudar
> `perms`: ele nunca se concede permissão.

### Segurança do plugin

- roda só no **PC do dono**; Android não executa código;
- `run` vira argv direto (**sem shell**), e o programa tem que estar **dentro da
  pasta** importada;
- o processo é morto ao **Parar plugin** e ao fechar o app;
- a barreira é a API da ponte (loopback + segredo + rate limit de 120 req/min).
  **Não é sandbox de SO** — só importe código em que você confia.

---

## 7. Segurança em uma página

| Regra | Onde |
|---|---|
| Bot nasce **sem** permissão administrativa | `bots.perms = 0` |
| Cada ação confere o **bit** no core | `engine.rs::bot_admin` |
| Dono do servidor nunca é alvo | `bot_admin` |
| Toda ação vai para o audit como `bot:<ação>` | `audit_log` |
| Saída sanitizada e cortada em 1900 chars | `sanitize_text` |
| URL só http/https, LAN opcional, metadados sempre bloqueados | `bots::url_allowed` |
| Bot offline = zero rede | `botEngine.ts`, `bot_admin` |
| Ponte: só loopback, segredo no caminho, recusa `Origin`, 120 req/min | `botbridge.rs` |

---

## 8. Problemas comuns

| Sintoma | Causa | Solução |
|---|---|---|
| não responde | bot offline / prefixo errado / canal fora do escopo | confira os três |
| "não tem permissão para ban" | falta o bit | aba **Permissões** |
| "bot.json não encontrado" | importou arquivo, não pasta | importe a **pasta** |
| "o bot não faz nada" | config sem commands/events/webhook | adicione um |
| "abra a ponte antes de iniciar o plugin" | plugin precisa da URL | **Abrir ponte** |
| ponte responde 404 | URL sem o segredo | use a URL que o app mostra |
| ponte responde 403 | chamada veio de navegador | chame por programa/CLI |
| ponte responde 429 | >120 req/min | diminua a frequência |
| plugin não sobe | falta runtime (node/python) | instale ou use a DSL |

---

## 9. Testes que travam isso

| Suíte | Cobre |
|---|---|
| `distorrent-core/tests/bots_exec.rs` (16) | admin, permissões, montar servidor, config própria, logs, avisos, variáveis |
| `distorrent-core/src/bots.rs` (13) | parser, DSL, guarda de URL, config antiga |
| `src-tauri/src/botbridge.rs` (8) | segredo no caminho, loopback, eventos, post, admin, parar |
| `src-tauri/src/botplugin.rs` (4) | argv sem shell, pasta, programa dentro da pasta |
| `tests/botCommands.test.ts` (32) | config, aliases, permissões, serialização |
| `tests/botRuntime.test.ts` (16) | comandos, cooldown, rate limit, script, eventos |
