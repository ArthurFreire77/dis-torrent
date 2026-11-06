# Bots do DisTorrent — criar, programar e executar

**Este documento descreve exatamente o que o código faz hoje.** Onde algo não
existe, está escrito que não existe. Não há "API futura" aqui.

Duas partes:

1. **Bot de servidor** — um membro automatizado do servidor, com token e cargo.
2. **Bot local (plugin)** — uma pasta de código que roda no PC do dono e fala
   com o servidor pela ponte `127.0.0.1`.

---

## 1. O que um bot é (e não é)

Um bot **não é um servidor hospedado pelo DisTorrent**. Ele é:

- uma **linha** na tabela `bots` do banco do servidor: id, nome, discriminador,
  avatar, token, cargo, `online`, `config` (JSON) e `perms` (permissões
  administrativas concedidas);
- um **runtime no dispositivo do dono** (`src/services/botEngine.ts`), que
  escuta eventos, roda comandos (resposta fixa, HTTP, script DSL ou ação
  administrativa) e posta em nome do bot;
- um **autor de mensagem** — ao responder, a mensagem é assinada pelo dono e
  marcada com `bot_id`, para a UI mostrar nome/avatar do bot;
- opcionalmente, um **plugin**: uma pasta com código do usuário que o app
  executa como processo filho e conecta à ponte local.

Consequências reais:

| Fato | Por quê |
|---|---|
| **Só o dono do servidor vê o token.** Para os outros membros o token vai vazio no estado sincronizado. | Token é credencial: quem tem fala como o bot. |
| **Só o dono executa o runtime.** | Em mesh, cada membro executando duplicaria as respostas. |
| **O bot não responde com o app fechado.** | Não existe hospedagem de bots. O PC do dono é o host. |
| **O bot é executado no PC do dono e o servidor serve todos**, inclusive Android. | O Android não abre a ponte local; os membros só recebem as mensagens pelo servidor. |
| **Bot `offline` não faz nenhuma chamada de rede.** | Desligar no painel significa zero requisição, não só "não postar". |

---

## 2. Painel do bot

Servidor → menu do servidor → **Bots** (só o dono vê a entrada).

Botões disponíveis e o que cada um faz de verdade:

| Botão | Ação real |
|---|---|
| **Criar bot** | Cria a linha em `bots`, gera discriminador e token, entra como membro automatizado. |
| **Adicionar bot existente** | Lê a **pasta** de um bot (`bot.json`) e cria o bot com nome, avatar, config e permissões. Não executa nada ainda. |
| **Gerenciar bots** | A própria lista: editar nome/cargo, ligar/desligar, copiar token, remover. |
| **Criar/Editar/Excluir comando** | Aba **Comandos** do painel do bot (editor visual, sem JSON). |
| **Testar comando** | Executa o comando contra o core e mostra o resultado no console (sem postar). |
| **Abrir painel local** | Aba **Ponte e plugin**: abre `http://127.0.0.1:<porta>`. |
| **Iniciar/Parar/Reiniciar bot** | Abre/fecha a ponte e sobe/derruba o processo do plugin. |
| **Ver logs** | Aba **Console**: últimas 500 linhas gravadas em `bot_logs` + saída do plugin. |
| **Exportar bot** | Gera um `bot.json` com config e permissões — **sem token**. |
| **Importar bot** | Mesmo caminho de "Adicionar bot existente". |

Cada bot na lista mostra: nome, discriminador, status online/offline, cargo,
quantidade de comandos, quantidade de eventos, quantas permissões
administrativas tem e se a config está inválida.

> **Token:** o painel mostra mascarado. "Mostrar", "Copiar" e "Gerar novo token"
> funcionam de verdade; gerar novo invalida o anterior na hora.

---

## 3. Configuração (JSON) — o que o runtime entende

Salva em `bots.config`. **Limite: 64 KB.** O parser é `parseBotConfig` em
`src/services/botCommands.ts` e, no core, `bots::parse_config`. O app **valida de
novo** no core antes de gravar (`bot_update`): config inválida não entra no banco.

```json
{
  "prefix": "!",
  "commands": [
    { "name": "ajuda", "description": "Mostra os comandos", "exec": "reply",
      "reply": "Olá! Comandos: {{prefix}}cep, {{prefix}}ping" },

    { "name": "cep", "method": "GET", "exec": "http",
      "url": "https://viacep.com.br/ws/{{arg0}}/json/",
      "responsePath": "logradouro",
      "template": "{{value}} — {{json.bairro}}/{{json.uf}}" },

    { "name": "ping", "exec": "script", "cooldownMs": 3000,
      "script": "reply \"pong\"" },

    { "name": "ban", "exec": "admin", "admin": "ban",
      "permission": "moderate" }
  ],
  "channels": [],
  "events": ["member_joined"],
  "webhook": { "url": "https://meu-servidor.exemplo/hook" },
  "blockPrivate": true,
  "maxRepliesPerMinute": 20
}
```

| Campo | Regra |
|---|---|
| `prefix` | **1** caractere de `! / . $ @ # % -`. Ausente = `!`. |
| `commands[]` | máx. **48**. `name` normalizado (a-z, 0-9, `-`, `_`, até 32). |
| `commands[].aliases` | até **4**; não podem repetir nome/alias de outro comando. |
| `commands[].exec` | `reply` \| `http` \| `script` \| `admin`. Sem o campo, é inferido pelo que foi preenchido. |
| `commands[].permission` | `""` (todos) \| `moderate` \| `manage` \| `owner`. |
| `commands[].cooldownMs` | 0 a 86.400.000 (24 h). Padrão **1.500 ms**, por autor. |
| `commands[].ephemeral` | resposta discreta (prefixo `-#`, sem notificação). |
| `commands[].enabled` | `false` desliga só aquele comando. |
| `commands[].args` | até **8**: `{ name, required, rest }`. |
| `events` | lista fechada (ver §5). Evento desconhecido é descartado. |
| `channels` | ids de canais. `[]` = todos, inclusive os criados depois. |
| `webhook.url` | http(s). Recebe **todo** evento do escopo **e** toda mensagem. |
| `blockPrivate` | padrão `true`: bloqueia destino em rede privada/loopback. |
| `maxRepliesPerMinute` | 1 a 120. Padrão **20**. Rate limit do runtime. |

### Placeholders

| Placeholder | Valor |
|---|---|
| `{{args}}` | argumentos separados por `/`, cada um URL-encoded |
| `{{query}}` | argumentos separados por `+`, URL-encoded |
| `{{arg0}}`, `{{arg1}}`… | argumento N, URL-encoded |
| `{{raw.args}}` | argumentos crus, separados por espaço (não use em URL) |
| `{{value}}` | valor do `responsePath` |
| `{{json}}` | corpo inteiro da resposta |
| `{{json.caminho}}` | caminho pontilhado (`data.temp`, `items[0].name`) |
| `{{var.nome}}` | variável persistente do bot (`setvar`) |

No **script**, além destes: `{{author}}`, `{{bot}}`, `{{channel}}`,
`{{event.campo}}`.

### Como o texto é reconhecido

`parseBotCommand(prefix, body)`:

- prefixo **no começo**, depois de `trim`;
- nome **imediatamente** após o prefixo, sem espaço (`!clima`);
- `!!texto` **não** é comando (é riso);
- argumentos até 16 palavras;
- alias funciona igual ao nome.

---

## 4. Os quatro tipos de comando

### 4.1 `reply` — resposta fixa

```json
{ "name": "oi", "exec": "reply", "reply": "olá, {{raw.args}}!" }
```

Testado, sanitizado (`sanitizeText`: sem controles, zero-width ou bidi) e
cortado em **1900** caracteres antes de virar mensagem.

### 4.2 `http` — chamar uma API

```json
{
  "name": "clima",
  "exec": "http",
  "method": "GET",
  "url": "https://api.exemplo.com/clima?q={{query}}",
  "headers": { "accept": "application/json" },
  "responsePath": "current.temp_c",
  "template": "Agora faz {{value}}°C em {{raw.args}}"
}
```

1. URL passa pela **guarda de destino** (§8).
2. Chamada com timeout de **10 s** (teto de 15 s do `http_fetch`).
3. `responsePath` inexistente → **não responde** (falha honesta, não inventa).
4. `template` (ou `{{json}}`) renderizado, sanitizado, cortado em 1900.
5. Posta no mesmo canal.

### 4.3 `script` — DSL em sandbox

Uma instrução por linha. **Não há `eval`**: o interpretador só conhece estas
instruções, então código do usuário não tem acesso a `window`, `process`,
`require` nem ao banco.

| Instrução | Efeito |
|---|---|
| `reply "texto"` | posta no canal (até 8 por execução) |
| `ephemeral "texto"` | posta como resposta discreta |
| `let x = valor` | variável **da execução** |
| `getvar x = chave` | lê variável **persistente** do bot (banco) |
| `setvar chave = valor` | grava variável persistente |
| `incvar chave + 5` | soma na variável persistente |
| `http get "url" as res` | GET; corpo em `res`, status em `res.status`, campos JSON em `res.campo` |
| `http post "url" body "{{args}}" as res` | POST |
| `if <cond>` / `else` / `end` | desvio |
| `admin <ação> ...` | pede ação administrativa ao core (qualquer uma do registro) |
| `stop` | encerra o script |

Condições: `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `startswith`,
`is empty`, `is not empty`.

Limites: **200 linhas**, até 8 mensagens, até 2000 passos. Timeout de rede de
10 s por chamada. Variável persistente: chave até 64, valor até 2 048.

Exemplo (`/pontos`):

```
incvar pontos:{{author}} + 10
setvar ultimo:{{author}} = {{raw.args}}
reply "você tem {{pontos:{{author}}}} pontos"
```

> Placeholders aninhados não são suportados. Use `getvar`:
> `getvar p = pontos` exige chave fixa. Para economia, use uma chave por autor
> montada pelo comando (ex.: `/pontos` com `args[0]` = autor).

### 4.4 `admin` — ação administrativa real

```json
{ "name": "ban", "exec": "admin", "admin": "ban", "permission": "moderate" }
```

Ação executada **pelo core** (`NetworkEngine::bot_admin`), nunca pela UI. O
core confere: bot existe, está **online**, e tem a **permissão específica**
concedida em `bots.perms`. O dono do servidor **nunca é alvo** e toda ação vira
`audit_log` com `bot:<ação>` e o `bot_id` como autor.

| Ação | Permissão | Argumentos |
|---|---|---|
| `ban` / `unban` | banir | `<membro> [motivo]` |
| `kick` | gerenciar membros | `<membro> [motivo]` |
| `mute` / `unmute` | silenciar | `<membro> [minutos] [motivo]` |
| `warn` / `warnings` | silenciar | `<membro> [motivo]` |
| `warnings_clear` | silenciar | `<membro>` |
| `delete_msg` | apagar mensagens | `<id-da-mensagem>` |
| `clear` | limpar canais | `[#canal] [N]` |
| `lock` / `unlock` | limpar canais | `[#canal]` |
| `slowmode` | limpar canais | `[#canal] [segundos]` |
| `channel_create` | montar o servidor | `<nome> [text\|voice\|video\|forum]` |
| `channel_delete` | montar o servidor | `[#canal]` |
| `channel_edit` | montar o servidor | `<canal> <novo-nome>` |
| `channel_topic` | montar o servidor | `<canal> <tópico>` |
| `channel_category` | montar o servidor | `<canal> <categoria>` |
| `role_create` | montar o servidor | `<nome> [#RRGGBB]` |
| `role_delete` | montar o servidor | `<cargo>` |
| `role_edit` | montar o servidor | `<cargo> [novo-nome] [#RRGGBB]` |
| `role_assign` | gerenciar membros | `<cargo> <membro>` |
| `role_unassign` | gerenciar membros | `<cargo> <membro>` |
| `server_edit` | montar o servidor | `<novo-nome>` |
| `server_meta` | montar o servidor | `[descrição]` |
| `server_public` | montar o servidor | `<on\|off>` |
| `make_invite` | montar o servidor | `[horas] [fp-alvo]` |
| `react` | conteúdo e organização | `<id-da-mensagem> <emoji>` |
| `pin` / `unpin` | conteúdo e organização | `<id-da-mensagem>` |
| `thread_create` | conteúdo e organização | `<nome> [tags]` |
| `thread_archive` | conteúdo e organização | `<id-da-thread> [on\|off]` |
| `poll_create` | conteúdo e organização | `<pergunta> \| <opção> \| <opção>` |
| `emoji_add` / `emoji_del` | conteúdo e organização | `<nome> <emoji>` / `<nome>` |
| `typing` | conteúdo e organização | — |
| `userinfo` | — | `<membro>` |
| `serverinfo` | — | — |
| `ping` | — | — |
| `audit` / `bans` / `timeouts` | — | `[N]` / — / — |
| `channels` / `roles` | — | — |

O alvo aceita **fingerprint**, **apelido** ou menção `<@fp>`. Consulta
(`userinfo`, `serverinfo`, `ping`, `audit`, `bans`, `timeouts`, `channels`,
`roles`) não exige permissão e não grava auditoria — só o que muda estado entra
em `audit_log`.

As ações que dependem de um canal (`thread_create`, `poll_create`, `typing`) usam
o canal onde a mensagem chegou. Na ponte, mande `channel` no corpo do
`/v1/admin` para escolher outro. A lista completa e viva está em
`distorrent_core::moderation::BOT_ACTIONS` (o `/v1/info` a devolve em `actions`).

---

## 5. Eventos

O runtime assina `services.subscribe` e trata estes eventos (lista **fechada**):

| Evento | Quando |
|---|---|
| `message_new` | mensagem recebida (direção `in`, sem `bot_id`) |
| `message_edited` | corpo mudou |
| `message_deleted` | mensagem apagada |
| `mention` | menção ao nome/id do bot (no payload de `message_new`) |
| `reaction` | alguém reagiu |
| `member_joined` | convite aceito ou entrada pública |
| `member_left` | saiu, foi expulso ou banido |
| `channel_created` / `channel_deleted` | canal criado/removido |
| `call_started` / `call_ended` | sala de chamada abriu/fechou |
| `voice_joined` / `voice_left` | entrou/saiu de canal de voz |

Para reagir a um evento além do webhook, crie um comando com **nome igual ao
evento** e `exec: script`. Exemplo:

```json
{
  "events": ["member_joined"],
  "commands": [
    { "name": "member_joined", "exec": "script",
      "script": "reply \"bem-vindo, {{event.nickname}}!\"" }
  ]
}
```

**Loop:** mensagem postada pelo bot tem `bot_id`, então o runtime a ignora.

---

## 6. Bot local: a ponte `127.0.0.1`

A ponte é o **canal do bot com o servidor**. Não é um painel: ela entrega
eventos e recebe mensagens/ações. Escuta **só em loopback** e o app entrega ao
plugin a URL **já autenticada** — não existe token para colar, guardar nem vazar.

A credencial é um **caminho secreto** (`/b/<32 hex>`) gerado a cada abertura.
Vale só neste PC e só enquanto a ponte estiver aberta: fechar a ponte (ou o app)
invalida o segredo. Sem ele a rota responde 404 — a ponte nem confirma que existe.

### Abrir

Painel do bot → aba **Ponte e plugin** → **Abrir ponte**. O app escolhe uma
porta livre (ou você informa a porta). O painel mostra URL e token.

### Rotas

O prefixo secreto já vem na URL (ex.: `http://127.0.0.1:41234/b/9f2c…`). Não há
header de autenticação.

| Rota | O que faz |
|---|---|
| `GET /v1/info` | bot, servidor, canais, membros e a lista **viva** de ações (`actions`) |
| `GET /v1/events?since=<seq>&wait=<ms>` | long-poll (até 25 s) dos eventos do servidor |
| `POST /v1/message` | `{"channel":"geral","body":"texto"}` — publica como o bot |
| `POST /v1/admin` | `{"action":"ban","target":"fp","reason":"spam","number":null,"channel":"opcional"}` |
| `GET /v1/config` | a config atual **deste** bot (sem token de ninguém) |
| `POST /v1/commands` | `{"config":"<json>"}` — o bot troca a **própria** config (comandos novos em tempo de execução) |
| `POST /v1/log` | `{"level":"info","message":"..."}` — grava no console |
| `POST /v1/stop` | encerra a ponte |

Exemplo em qualquer linguagem:

```bash
curl "$DISTORRENT_BOT_URL/v1/info"

curl -X POST "$DISTORRENT_BOT_URL/v1/message" \
  -H 'content-type: application/json' \
  -d '{"channel":"geral","body":"oi do bot"}'
```

### Segurança da ponte

- **Origin de navegador é recusado** (403): uma página aberta não fala com a ponte.
- **Host precisa ser `127.0.0.1:<porta>` ou `localhost:<porta>`** (421): fecha DNS rebinding.
- **Segredo só no caminho**, nunca em header, log ou saída do processo.
- **120 requisições/minuto**; corpo até 64 KB; mensagem até 1900 chars.
- Texto de saída passa por `sanitize_text` no core.
- Fechar o app fecha todas as pontes (`RunEvent::Exit`) — socket não fica órfão.
- **Android:** a ponte não abre. O painel mostra que não existe, em vez de fingir.

---

## 7. Código do bot (plugin)

O app **executa o código da pasta** como processo filho, com a ponte já aberta.

### Formato da pasta

```
meu-bot/
├── bot.json          ← obrigatório
├── bot.js            ← seu código
└── package.json      ← opcional
```

`bot.json`:

```json
{
  "name": "FreireBot",
  "avatar": "🤖",
  "description": "Ajuda e utilidades",
  "run": "node bot.js",
  "requires": ["node >= 20"],
  "config": {
    "prefix": "!",
    "events": ["member_new"],
    "commands": []
  }
}
```

- `name` com 2–32 caracteres é obrigatório.
- `config` é a **mesma** config da §3, validada pelo core no import. A pasta é
  recusada se a config não tiver `commands`, `events` nem `webhook` (bot que não
  faz nada).
- `run` é opcional. Sem ele, o bot usa só a DSL embutida (não precisa de Node).
- `run` vira **argv direto, sem shell**: `;`, `&&` e `|` são argumentos literais.
- O programa precisa estar **dentro da pasta** importada.

### Variáveis de ambiente entregues ao processo

| Variável | Valor |
|---|---|
| `DISTORRENT_BOT_URL` | URL completa **já autenticada**: `http://127.0.0.1:<porta>/b/<segredo>` |
| `DISTORRENT_BOT_PORT` | só a porta |
| `DISTORRENT_API` | `distorrent-bot/1` |

**Não existe token.** O segredo vai no caminho da URL que o app injeta: o plugin
não configura, não guarda e não protege credencial nenhuma.

O ambiente é **limpo** (`env_clear`): só `PATH` e estas variáveis.

### Exemplo mínimo (`bot.js`)

```js
const url = process.env.DISTORRENT_BOT_URL   // já autenticada: nada a configurar

async function post(channel, body) {
  await fetch(`${url}/v1/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, body }),
  })
}

let since = 0
for (;;) {
  const res = await fetch(`${url}/v1/events?since=${since}&wait=20000`)
  const { events } = await res.json()
  for (const e of events ?? []) {
    since = e.seq
    if (e.event === 'message_new' && e.data.body === '!ping') {
      await post(e.data.conv_id, 'pong')
    }
  }
}
```

### Ciclo de vida

- **Iniciar plugin** só funciona com a ponte aberta.
- O processo roda com `cwd` na pasta do bot.
- Ao **Parar plugin** (ou fechar o app), o processo é morto e aguardado.
- Se o processo morrer sozinho, o painel mostra `parado (código N)` — não fica
  dizendo "rodando".
- Saída (stdout/stderr) aparece no console do painel.
- **Android:** executar código não existe; o painel diz isso.

### Limite honesto de isolamento

Um processo filho roda com as permissões do **seu usuário no sistema**. A
barreira real é a API da ponte (só loopback, só token, só o que as rotas
expõem) + o opt-in explícito do dono. **Não é sandbox de SO.** Só importe código
em que você confia — o mesmo critério de instalar um programa.

---

## 8. Segurança

### Guarda de destino (SSRF)

Valem para comando `http`, script `http` e webhook:

- esquema **http/https** apenas, host obrigatório, URL ≤ 2 048;
- `169.254.x.x`, `0.0.0.0` e `metadata.google.internal` são **sempre** bloqueados;
- `127.x`, `10.x`, `172.16–31.x`, `192.168.x`, `::1`, ULA e link-local são
  bloqueados quando `blockPrivate` = `true` (padrão). Um bot de LAN pode
  desligar, conscientemente.

### Tokens

- O token é o mesmo do bot na ponte (não existe segundo segredo).
- Só o dono recebe o token no estado sincronizado; os membros recebem `""`.
- Não vai no corpo do webhook.
- `Gerar novo token` invalida o anterior na hora.
- **Não existe token na ponte.** A URL entregue ao plugin já carrega o segredo
  e morre quando a ponte fecha. Nada para colocar em `bot.json`.

### Permissões

- Bot nasce com `perms = 0` (zero poder administrativo).
- Cada ação mapeia para um bit (`banir`, `silenciar`, `apagar mensagens`,
  `gerenciar membros`, `montar o servidor`, `limpar canais`,
  `conteúdo e organização`), num registro único (`BOT_ACTIONS`) que o painel, a
  DSL e a ponte compartilham.
- O core confere **de novo** a cada ação — a interface não é a barreira.
- O dono do servidor nunca é alvo.
- `BotPatch.perms` é mascarado por `PERM_ALL` no core.

### Saída

Toda resposta (HTTP, script, fixa) passa por `sanitizeText`/`sanitize_text` e é
cortada em 1900 caracteres. A UI renderiza como texto, nunca HTML.

### Por que um bot não vira vírus

| # | Barreira | Onde |
|---|---|---|
| 1 | Config é **dado**, não código: JSON com campos conhecidos, sem `eval` | `botCommands.ts`, `bots.rs` |
| 2 | O caminho DSL não cria processo; o plugin só roda por escolha explícita | `botEngine.ts`, `botplugin.rs` |
| 3 | Tamanho limitado no painel **e** no core | `storage.rs`, `botModel.ts` |
| 4 | Só http/https com guarda de destino | `botCommands.ts`, `bots.rs` |
| 5 | Saída sanitizada | `renderBotReply`, `bots::run_script` |
| 6 | Mensagem é envelope assinado; `bot_id` não autentica ninguém | `protocol.rs`, `engine.rs` |
| 7 | Só o dono executa; Bot offline = zero rede | `botEngine.ts`, `engine.rs::bot_admin` |
| 8 | Operações de arquivo não existem na API do bot | — |

**O que um bot malicioso ainda pode fazer:** chamar uma URL pública arbitrária
(SSRF é limitado, não eliminado), postar em excesso até o rate limit, publicar
um link perigoso como texto. Trate a config de um bot como um programa que
alguém pediu para você rodar.

---

## 9. Banco de dados

| Tabela | Conteúdo |
|---|---|
| `bots` | id, community_id, name, discriminator, avatar, role_id, token, online, owner_fp, created_at, config, **perms** |
| `bot_logs` | console (500 por bot, mais recentes primeiro) |
| `bot_vars` | variáveis persistentes de script (`community_id, bot_id, key, value`) |
| `warnings` | avisos de moderação (`/warn`, `/warnings`) |
| `messages.bot_id` | liga a mensagem ao bot que a postou |

Migration: `schema_version` **14** adiciona `bots.perms`, `bot_logs`, `bot_vars`
e `warnings`. Bots existentes continuam válidos: `perms` entra como `0` e a
`config` antiga (só HTTP) segue funcionando.

---

## 10. Solução de problemas

| Sintoma | Causa real | O que fazer |
|---|---|---|
| "bot está offline — ative-o no painel" | `online = false` | ligue o bot no cartão |
| comando não responde | prefixo errado, canal fora do escopo, comando `enabled: false` | confira os três |
| resposta vazia | `responsePath` não existe no JSON | ajuste o caminho ou teste o endpoint |
| "o bot não tem permissão para `ban`" | `perms` não inclui o bit | aba **Permissões** → conceder |
| "pasta do bot não existe" | caminho inválido | selecione a pasta que tem `bot.json` |
| "bot.json não encontrado" | importou o arquivo, não a pasta | importe a pasta |
| "o bot não faz nada" | `config` sem `commands`, `events` nem `webhook` | adicione ao menos um |
| "programa não encontrado na pasta" | `run` aponta para fora | coloque o código dentro da pasta ou instale a dependência |
| "abra a ponte local antes de iniciar o plugin" | plugin precisa da URL/token | aba **Ponte e plugin** → Abrir ponte |
| ponte retorna 401 | token errado/ausente | use `Authorization: Bearer <token>` |
| ponte retorna 403 | requisição com `Origin` de navegador | fale pela linha de comando, não pelo navegador |
| ponte retorna 421 | `Host` não é loopback | use `127.0.0.1:porta` |
| ponte retorna 429 | mais de 120 req/min | reduza a frequência |
| "rede privada bloqueada" | `blockPrivate` ligado | desligue na aba **Eventos** se for LAN |
| bot não responde com o app fechado | não há hospedagem | mantenha o app aberto no PC do dono |

---

## 11. Ambiente de desenvolvimento

### Rodar o app

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:TEMP\node24\node-v24.22.1-win-x64;$env:PATH"
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run tauri:dev
```

### Gates

```powershell
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run typecheck
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run lint
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run test:unit
```

Rust (WSL, onde há toolchain):

```bash
cd distorrent-core && cargo test --test bots_exec
cd src-tauri && cargo test --lib bot
```

### Onde mexer

| Arquivo | Responsabilidade |
|---|---|
| `src/services/botCommands.ts` | modelo, parser, guarda de URL, serialização |
| `src/services/botEngine.ts` | runtime puro (testável): comandos, DSL, eventos, rate limit |
| `src/services/botRuntime.ts` | fiação com `services` (não é importável em teste) |
| `src/components/server/BotPanel.tsx` | painel: comandos, permissões, eventos, ponte, console |
| `src/components/server/BotManager.tsx` | lista, criar, adicionar existente, remover |
| `distorrent-core/src/bots.rs` | parser/DSL autoritativos |
| `distorrent-core/src/net/engine.rs` | `bot_admin`, logs, variáveis |
| `src-tauri/src/botbridge.rs` | ponte 127.0.0.1 + leitura de pasta |
| `src-tauri/src/botplugin.rs` | execução do código como processo |

---

## 12. Exemplos

Os exemplos **não vêm no repositório**: eles são publicados como plugins no
GitHub. Para usar um, baixe a pasta e use **Adicionar bot existente**.

Estrutura de um bot publicado:

```
freirebot/
├── bot.json
├── README.md
└── bot.js
```

`bot.json` de um FreireBot:

```json
{
  "name": "FreireBot",
  "avatar": "🤖",
  "description": "Ajuda e utilidades do servidor",
  "config": {
    "prefix": "!",
    "commands": [
      { "name": "ajuda", "exec": "reply",
        "reply": "Comandos: !ping, !serverinfo, !userinfo @membro" },
      { "name": "ping", "exec": "reply", "reply": "pong", "cooldownMs": 3000 },
      { "name": "serverinfo", "exec": "admin", "admin": "serverinfo" },
      { "name": "userinfo", "exec": "admin", "admin": "userinfo" }
    ]
  }
}
```

`bot.json` de um ModeradorBot (exige permissões concedidas no painel):

```json
{
  "name": "ModeradorBot",
  "avatar": "🛡️",
  "description": "Moderação com permissões explícitas",
  "config": {
    "prefix": "/",
    "events": ["message_new"],
    "commands": [
      { "name": "ban", "exec": "admin", "admin": "ban", "permission": "moderate" },
      { "name": "kick", "exec": "admin", "admin": "kick", "permission": "moderate" },
      { "name": "warn", "exec": "admin", "admin": "warn", "permission": "moderate" },
      { "name": "warnings", "exec": "admin", "admin": "warnings" },
      { "name": "clear", "exec": "admin", "admin": "clear", "permission": "moderate" },
      { "name": "lock", "exec": "admin", "admin": "lock", "permission": "manage" },
      { "name": "slowmode", "exec": "admin", "admin": "slowmode", "permission": "manage" }
    ]
  }
}
```

`bot.json` de um WelcomeBot (evento):

```json
{
  "name": "WelcomeBot",
  "avatar": "👋",
  "events": ["member_joined"],
  "config": {
    "prefix": "!",
    "events": ["member_joined"],
    "commands": [
      { "name": "member_joined", "exec": "script",
        "script": "reply \"bem-vindo, {{event.nickname}}!\"" }
    ]
  }
}
```

`bot.json` de um UtilityBot (CEP, sem código externo):

```json
{
  "name": "UtilityBot",
  "avatar": "🧰",
  "config": {
    "prefix": "!",
    "commands": [
      { "name": "cep", "exec": "http", "method": "GET",
        "url": "https://viacep.com.br/ws/{{arg0}}/json/",
        "responsePath": "logradouro",
        "template": "{{value}} — {{json.bairro}}/{{json.uf}}" },
      { "name": "serverinfo", "exec": "admin", "admin": "serverinfo" },
      { "name": "userinfo", "exec": "admin", "admin": "userinfo" }
    ]
  }
}
```

`bot.json` de um EconomyBot (variáveis persistentes):

```json
{
  "name": "EconomyBot",
  "avatar": "🪙",
  "config": {
    "prefix": "!",
    "commands": [
      { "name": "diario", "exec": "script", "cooldownMs": 86400000,
        "script": "incvar moedas + 10\nreply \"+10 moedas. Saldo: {{moedas}}\"" },
      { "name": "saldo", "exec": "script",
        "script": "getvar m = moedas\nreply \"seu saldo: {{m}}\"" }
    ]
  }
}
```

> **MusicBot:** não é funcional. Tocar áudio por bot exigiria o bot entrar no
> canal de voz pelo protocolo de mídia, e o runtime de bot não tem caminho de
> áudio hoje. Não publique como funcional.

---

## 13. Limitações reais (sem maquiagem)

| Funcionalidade | Estado |
|---|---|
| Comandos, aliases, cooldown, rate limit, permissões | **funciona** |
| Resposta fixa, HTTP, script DSL, admin nativo | **funciona** |
| Eventos da §5 | **funciona** (só com app aberto no PC do dono) |
| Ponte 127.0.0.1 + token + loopback | **funciona** (desktop) |
| Execução de código como plugin | **funciona** (desktop; não é sandbox de SO) |
| Bot responder com o app fechado | **não existe** (sem hospedagem) |
| Ponte no Android | **não existe** (app é congelado em background) |
| Bot entrar em canal de voz / tocar áudio | **não existe** |
| Bot em vários servidores com o mesmo processo | **não existe** hoje: cada bot pertence a um servidor e a ponte é por bot |
| Interface web em `127.0.0.1` para editar o bot | **não existe** — a ponte é canal de API, não painel; edição é no app |
| Sandbox de sistema operacional para o código do bot | **não existe** — é processo filho com as permissões do usuário |

---

## 14. Por que o formato antigo continua valendo

A config antiga era só HTTP:

```json
{ "prefix": "!", "commands": [{ "name": "clima", "url": "https://...", "template": "{{json}}" }] }
```

Ela continua **válida**: `exec` é inferido como `http` quando há `url`. Campo
desconhecido é descartado. `bots.perms` ausente vira `0`. Nenhum bot existente
precisa ser recriado.

Os testes que travam isso:

- `distorrent-core/src/bots.rs` → `config_antigo_continua_valido`
- `tests/botCommands.test.ts` → `parseBotConfig: JSON válido`, `serializeBotConfig: ida e volta`
- `distorrent-core/tests/bots_exec.rs` → `config_de_bot_existente_nao_e_perdida_na_migracao`
