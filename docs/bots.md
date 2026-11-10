# Bots do DisTorrent — referência técnica

**Este documento descreve o que o código faz hoje (schema v3).** Onde algo não
existe, está escrito que não existe. Não há "API futura" nem roteiro aqui.

Arquivos que mandam (nesta ordem de autoridade):

| Camada | Arquivo | Papel |
|---|---|---|
| Core | `distorrent-core/src/bots.rs` | parser, migração, guarda de URL, DSL — autoritativo |
| Core | `distorrent-core/src/moderation.rs` | registro único das ações (`BOT_ACTIONS`) e bits de permissão |
| Core | `distorrent-core/src/net/engine.rs` | `bot_create`, `bot_action_in`, `bot_replace_config`, logs, variáveis |
| Casca | `src-tauri/src/botbridge.rs` | ponte `127.0.0.1` (rotas, rate limit, idempotência, eventos) |
| `src-tauri/src/botzip.rs` | extração do `.zip` de importação com guarda anti zip-slip |
| Casca | `src-tauri/src/botplugin.rs` | execução do código do bot como processo filho |
| App | `src/services/botCommands.ts` | modelo do editor, migração v1/v2, `permAllows`, guarda de URL |
| App | `src/services/botEngine.ts` | runtime declarativo (comandos, DSL, eventos, webhook) |
| App | `src/services/botWebhook.ts` | assinatura HMAC-SHA256 do webhook de saída |

---

## 1. O que um bot é (e não é)

Um bot **não é um serviço hospedado pelo DisTorrent**. Ele é:

- uma **linha** na tabela `bots`: id, `community_id`, nome, discriminador,
  avatar, `role_id`, token, `online`, `owner_fp`, `config` (JSON) e `perms`;
- um **runtime no dispositivo do dono** (`src/services/botEngine.ts`), que
  interpreta a config, responde comandos e dispara webhook;
- um **autor de mensagem** — a mensagem sai com `bot_id`, e a UI mostra
  nome/avatar do bot;
- opcionalmente, um **plugin**: pasta com código do criador que o app executa
  como processo filho e liga à ponte local.

| Fato | Por quê |
|---|---|
| **Só o dono recebe o token.** Para os outros membros, o token vai vazio no estado sincronizado (`engine.rs::community_state_payload`). | Token é credencial: quem tem fala como o bot. |
| **Só o dono executa o runtime.** | Em mesh, cada membro executando duplicaria as respostas. |
| **O bot não responde com o app fechado.** | Não existe hospedagem. O PC do dono é o host. |
| **Os membros recebem as mensagens pelo servidor**, inclusive Android. | O Android não abre a ponte local nem executa plugin. |
| **Bot `offline` não faz nenhuma chamada de rede.** | `botIsActive` corta o runtime e o core recusa ação (`bot_action_in`). |

---

## 2. Modelos de execução

`mode` é **explícito no schema v3**: nunca é inferido do que foi preenchido.
`runtime` diz como o código roda dentro do modo `plugin`.

| `mode` | Rótulo | O que faz de verdade | Trade-off |
|---|---|---|---|
| `declarative` | Declarativo | Só config: resposta fixa, HTTP, DSL, ação administrativa. Nenhum código do criador executa. | Menos poder; nada a instalar. |
| `plugin` | Plugin local | O código da pasta roda no PC do dono e fala pela ponte `127.0.0.1`. | Capacidade total, mas só com o app aberto e sem sandbox de SO. |
| `service` | Serviço externo | O criador recebe os eventos por webhook HTTP assinado. | A lógica sai do PC do dono; o app ainda precisa estar aberto para enviar. |
| `remote` | Bot remoto | O criador conectaria de fora por TLS. | **Quebra a promessa "nada roda em nuvem".** Desligado por padrão e avisado no painel. |

**Aviso honesto sobre `remote`:** o modo é aceito, validado e exibido, mas
**não existe transporte de entrada para ele nesta versão** — nenhuma porta é
aberta, nenhum handshake TLS é feito. Declarar `remote` hoje só muda o rótulo em
`/v1/limits`. `service` idem: o único caminho de saída é o webhook; não há
callback de entrada.

Do mesmo jeito, `mode` **não altera o caminho de execução**: o runtime
declarativo roda igual em `declarative`, `service` e `remote`.

### `runtime`

| `runtime` | Estado |
|---|---|
| `none` | Sem processo: só a DSL embutida. Padrão de `declarative`. |
| `process` | Processo filho (`node bot.js`, `python bot.py`…). Padrão de `plugin` quando `runtime` é omitido. |
| `wasm` | **Não existe nesta versão: é recusado na leitura**, com erro explícito ("runtime `wasm` ainda não existe nesta versão"). |

WASM foi recusado de propósito: aceitar o campo e não rodar nada seria mentira.

---

## 3. Schema v3 — campo a campo

Limite do JSON: **64 KB** (`BOT_CONFIG_MAX`). O banco usa o **mesmo** valor:
antes `bot_update_patch` cortava em 16 KB e a config entre 16 e 64 KB passava no
parser e falhava ao salvar, sem a UI mostrar o limite real.

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "primitives": {
    "text": true,
    "ephemeral": true,
    "reaction": true,
    "pin": true,
    "thread": true,
    "poll": true,
    "http": true,
    "kv": true,
    "template": true
  },
  "prefix": "!",
  "commands": [
    { "name": "ajuda", "exec": "reply",
      "reply": "Comandos: !cep, !ping" },
    { "name": "cep", "exec": "http", "method": "GET",
      "url": "https://viacep.com.br/ws/{{arg0}}/json/",
      "responsePath": "logradouro",
      "template": "{{value}} — {{json.bairro}}/{{json.uf}}" },
    { "name": "ping", "exec": "script", "cooldownMs": 3000,
      "script": "reply \"pong\"" },
    { "name": "ban", "exec": "admin", "admin": "ban",
      "permission": "moderate" }
  ],
  "channels": [],
  "channelKinds": ["text"],
  "events": ["member_joined"],
  "webhook": { "url": "https://meu-servidor.exemplo/hook" },
  "blockPrivate": true,
  "maxRepliesPerMinute": 20,
  "integrations": {
    "http": { "allowDomains": ["viacep.com.br"], "maxCallsPerMinute": 60 },
    "limits": { "maxMessagesPerExecution": 20 },
    "retention": { "hours": 24 },
    "webhook": { "signed": true }
  }
}
```

### Campos de topo

| Campo | Tipo / regra | Padrão | Quem usa |
|---|---|---|---|
| `schema` | 1, 2 ou 3. Ausente = v2 migrado. Fora de 1..3 = **erro**. | 2 (sem campo) | parser, `/v1/limits` |
| `mode` | `declarative` \| `plugin` \| `service` \| `remote`. Desconhecido = **erro**. | `declarative` | parser, `/v1/limits` |
| `runtime` | `none` \| `process` \| `wasm` (recusado). | `none` (ou `process` se `mode=plugin`) | parser |
| `primitives` | objeto com as 20 chaves (§6). Chave ausente = padrão. | ver §6 | parser (poda comandos), `/v1/limits` |
| `prefix` | **1** caractere de `! / . $ @ # % -`. Inválido = erro. | `!` | runtime |
| `commands[]` | até **48**. `name` normalizado: minúsculas, sem acento, `a-z0-9_-`, até 32. | `[]` | runtime, `/v1/config` |
| `channels[]` | ids de canal; até 256, cada ≤128 chars. `[]` = todos, inclusive os criados depois. | `[]` | `channel_in_scope` |
| `channelKinds[]` | `text` \| `voice` \| `video` \| `forum`; até 4. `[]` = todos os tipos. | `[]` | `kind_in_scope` |
| `events[]` | lista **fechada** de 13 (§7). Desconhecido é descartado. | `[]` | runtime (webhook + script de evento) |
| `webhook` | objeto `{ "url": "http(s)://..." }` ou string. Só http(s). | ausente | runtime |
| `blockPrivate` | booleano. `false` é opt-in consciente do dono para LAN. | `true` | guarda de URL |
| `maxRepliesPerMinute` | 1..120 | 20 | runtime (`rateAllows`) |
| `integrations` | objeto (§ abaixo) | ver § | parser, `/v1/config`, `/v1/limits` |

### `commands[]`

| Campo | Regra |
|---|---|
| `name` | obrigatório; normalizado (sem acento — `/tópico` e `/topico` são o mesmo). |
| `aliases` | até **4**; não podem repetir o nome nem outro alias do mesmo comando. |
| `description` | até 200 chars; só exibição. |
| `exec` | `reply` \| `http` \| `script` \| `admin`. Sem o campo, é inferido pelo preenchimento. |
| `permission` | `""` \| `moderate` \| `manage` \| `owner` — permissão exigida **do autor**, nunca maior que a do bot. |
| `cooldownMs` | 0..86.400.000 (24 h). Padrão **1.500 ms**, por autor e por comando. |
| `ephemeral` | publica com prefixo `-#` (sem notificação). |
| `enabled` | `false` desliga só aquele comando (`find_command` ignora). |
| `autocomplete` | guardado e reenviado; **nenhuma UI lê isso hoje**. |
| `args` | até **8** `{ name, required, rest }`; guardado, sem validação de obrigatoriedade no runtime. |
| `method` | `GET` (qualquer coisa ≠ POST) ou `POST`. |
| `url` | até 2048; precisa ser http(s) com host quando `exec=http`. |
| `headers` | até 16 pares; chave ≤64, valor ≤1024. Preencha no painel (aba Comandos) para mandar `Authorization` a APIs de IA. |
| `body` | até 8192; usado no POST. `{{jsonargs}}` coloca o texto do usuário escapado para JSON. |
| `responsePath` | até 128; caminho pontilhado no JSON da resposta. |
| `template` | até 1900; renderizado com os placeholders. |
| `timeoutMs` | 1000..90000; timeout HTTP do comando. Padrão 10 s — aumente para APIs de IA (LLM). |
| `reply` | até 1900; só `exec=reply`. |
| `script` | até 200 × 160 chars; só `exec=script`. |
| `admin` | nome de ação do registro (§8); só `exec=admin`. |

Regras de descarte na leitura: comando sem `name`, `reply` vazio, `script` vazio,
`admin` sem ação válida ou `http` com URL inválida **não entram** na lista.

### `integrations`

| Caminho | Regra | Padrão | Enforcement real |
|---|---|---|---|
| `integrations.http.allowDomains` | até 256 domínios, ≤253, sem `/`. Vazio = qualquer destino público. Sufixo conta (`exemplo.com` cobre `api.exemplo.com`). | `[]` | **sim** — `hostAllowed` em comando HTTP e `http` de script (§14) |
| `integrations.http.maxCallsPerMinute` | 1..600 | 60 | **declarado e devolvido em `/v1/limits`; não é aplicado** |
| `integrations.limits.maxMessagesPerExecution` | 1..20 | 20 | **declarado; o runtime corta em 8 mensagens por script** |
| `integrations.retention.hours` | 0..720 | 24 | **declarado e devolvido; o console não apaga por idade** (guarda as 500 últimas) |
| `integrations.webhook.secret` | 16..128 chars | ausente | **sim** — HMAC-SHA256 do webhook (§11) |

Campos declarados e não aplicados ficam visíveis em `/v1/limits` de propósito:
o criador lê o limite real, não o prometido.

---

## 4. Migração v1/v2 → v3

**O que muda**

| Antes (v1/v2) | Agora (v3) |
|---|---|
| Sem `schema` (ou `schema` < 3) | Lido como v2 e devolvido como **v3** na próxima gravação. |
| Sem `mode` | `declarative` — nunca `plugin`, mesmo que exista `run` na pasta. |
| Sem `runtime` | `none`; se `mode=plugin`, `process`. |
| Sem `primitives` | os 9 padrões ligados (text, ephemeral, reaction, pin, thread, poll, http, kv, template). |
| Sem `integrations` | `allowDomains=[]`, 60 HTTP/min, 20 mensagens/exec, 24 h. |
| `webhook` como string | Aceito na leitura e normalizado para `{ "url": ... }`. |

**O que NÃO muda**

- Comando antigo com `url` e sem `exec` continua `http`.
- `admin` presente ⇒ `admin`; `script` presente ⇒ `script`; `reply` sem `url` ⇒
  `reply` (a mesma inferência de antes).
- Nenhum bot existente precisa ser recriado; `perms` ausente já entra como `0`
  desde o schema de banco 14.
- `prefix`, `channels`, `events`, `blockPrivate`, `maxRepliesPerMinute` mantêm
  nome e semântica.

**O que passa a ser erro (e antes era silêncio)**

- `schema` fora de 1..3.
- `mode` desconhecido (ex.: `"telepatia"`) — antes cairia em declarativo.
- `runtime: "wasm"`.
- `prefix` com mais de 1 caractere ou fora da lista.

O segredo do webhook **nunca volta** na serialização: `normalize()` grava apenas
`integrations.webhook.signed = true`. O valor real não é exportado, não vai para
o log e não aparece no `bot.json` de um bot compartilhado.

---

## 5. Os quatro tipos de comando

### 5.1 `reply` — resposta fixa

```json
{ "name": "oi", "exec": "reply", "reply": "olá, {{raw.args}}!" }
```

Renderizado, sanitizado (`sanitize_text`: sem controles, zero-width ou bidi) e
cortado em **1900** caracteres.

### 5.2 `http` — chamar uma API

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

Exemplo com API de IA (POST com a pergunta do usuário e chave no header):

```json
{
  "name": "ia",
  "exec": "http",
  "method": "POST",
  "url": "https://api.exemplo.com/v1/chat",
  "headers": { "authorization": "Bearer SUA-CHAVE" },
  "body": "{\"prompt\": \"{{jsonargs}}\"}",
  "timeoutMs": 60000,
  "responsePath": "answer",
  "template": "{{value}}"
}
```

1. URL passa pela guarda de destino e pela allowlist (§14).
2. Timeout de **10 s** por padrão; `timeoutMs` sobe até **90 s** (use para LLM). O
   teto do `http_fetch` da casca é 90 s.
3. `headers` do comando são enviados (até 16; `Authorization: Bearer …` para
   APIs de IA).
4. `responsePath` inexistente ⇒ **não responde** (não inventa texto).
5. Status ≥400 ⇒ só log (`warn`), sem resposta no canal.
6. Corpo de resposta limitado a 256 KB no `http_fetch`.

### 5.3 `script` — DSL sem `eval`

Uma instrução por linha. O interpretador só conhece estas instruções: código do
usuário não alcança `window`, `process`, `require` nem o banco.

| Instrução | Efeito |
|---|---|
| `reply "texto"` | posta no canal (até **8** por execução) |
| `ephemeral "texto"` (ou `reply_ephemeral`) | posta como `-# texto` |
| `let x = valor` (ou `set`) | variável **da execução** |
| `getvar x = chave` | lê variável persistente do bot |
| `setvar chave = valor` | grava variável persistente |
| `incvar chave + 5` | soma inteiro na variável persistente |
| `http get "url" as res` | GET; corpo em `res`, status em `res.status`, campos JSON em `res.campo` |
| `http post "url" body "{{args}}" as res` | POST (corpo enviado como JSON) |
| `if <cond>` / `else` / `end` | desvio (aceita também `endif`) |
| `admin <ação> <alvo> <motivo>` | pede ação administrativa ao core |
| `stop` | encerra o script |

Condições: `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `startswith`,
`is empty`, `is not empty`, e uma palavra solta (falso para vazio, `0`, `false`).

Limites: **200 linhas**, 8 mensagens, 4000 passos (o runtime TS corta em 2000 e
o core em 4000). HTTP de 10 s por chamada. Variável persistente: chave ≤64,
valor ≤2048.

Comentário: linha começando com `#` ou `//`, ou trecho após `" # "`.

### 5.4 `admin` — ação administrativa real

```json
{ "name": "ban", "exec": "admin", "admin": "ban", "permission": "moderate" }
```

Executada **pelo core** (`NetworkEngine::bot_action_in`), nunca pela UI. O core
confere: bot existe, está **online**, tem o **bit da ação** e o alvo não é o dono
do servidor. Toda ação que muda estado vira `audit_log` com `bot:<ação>` e o
`bot_id` como autor.

### Placeholders

| Placeholder | Valor |
|---|---|
| `{{args}}` | argumentos separados por `/`, cada um URL-encoded |
| `{{query}}` | argumentos separados por `+`, URL-encoded |
| `{{arg0}}`, `{{arg1}}`… | argumento N, URL-encoded |
| `{{raw.args}}` | argumentos crus separados por espaço (não use em URL) |
| `{{jsonargs}}` | argumentos crus **escapados para JSON** — use no corpo POST para mandar o texto do usuário sem quebrar o JSON (pergunta com aspas, barra invertida ou quebra de linha) |
| `{{author}}` | nome do autor do comando |
| `{{value}}` | valor do `responsePath` |
| `{{json}}` | corpo inteiro da resposta |
| `{{json.caminho}}` | caminho pontilhado (`data.temp`, `items[0].name`) |
| `{{var.nome}}` | variável persistente (`setvar`) |

No script, além destes: `{{author}}`, `{{bot}}`, `{{channel}}`, `{{mention}}`,
`{{event.campo}}`.

### Como o texto vira comando

- prefixo no começo, depois de `trim`;
- nome imediatamente após o prefixo, sem espaço (`!clima`);
- `!!texto` **não** é comando (é riso);
- até 16 palavras de argumento;
- alias funciona igual ao nome.

---

## 6. Primitivas — o que o bot pode entregar

São **20** no schema. `implemented` vem de `Primitives::iter()` no core e de
`BOT_PRIMITIVES` no app — as duas listas têm de bater.

| id | Implementado hoje? | Consumido por |
|---|---|---|
| `text` | **sim** | resposta fixa e mensagens em geral |
| `ephemeral` | **sim** | `ephemeral`/`-#` |
| `dm` | não | — |
| `embed` | não | — |
| `component` | não | — |
| `attachment` | não | — |
| `reaction` | **sim** | ação `react` |
| `pin` | **sim** | ações `pin`/`unpin` |
| `thread` | **sim** | ações `thread_create`/`thread_archive` |
| `poll` | **sim** | ação `poll_create` |
| `edit` | não | — (o padrão vem ligado, mas `implemented:false` nega) |
| `audioFrame` | **parcial** | `/v1/audio/frames` toca no alto-falante do dono (Linux); **não** vai para a call (§12) |
| `videoFrame` | não | — |
| `screenFrame` | não | — |
| `http` | **sim** | comando `http` e `http` de script |
| `blob` | não | — |
| `kv` | **sim** | `getvar`/`setvar`/`incvar` (tabela `bot_vars`) |
| `job` | não | — |
| `template` | **sim** | placeholders |
| `invokeBot` | não | — |

Só `text`, `ephemeral`, `http` e `template` mudam o parser: desligar `text` e
`ephemeral` **remove** os comandos de resposta; desligar `http` remove os
comandos HTTP. As demais primitivas são lidas, gravadas e devolvidas em
`/v1/limits` com `implemented:false` — nenhuma rota as consome, porque elas não
existem. `Primitives::allows()` existe no core e é usado pelos testes.

---

## 7. Eventos

### 7.1 Runtime (`config.events`) — lista fechada de 13

| Evento | Quando |
|---|---|
| `message_new` | mensagem recebida (direção `in`, sem `bot_id`) |
| `message_edited` | corpo mudou |
| `message_deleted` | mensagem apagada |
| `mention` | marcador dentro do payload de `message_new` (`mention: true/false`) |
| `reaction` | alguém reagiu |
| `member_joined` | convite aceito ou entrada pública |
| `member_left` | saiu, foi expulso ou banido |
| `channel_created` | canal criado |
| `channel_deleted` | canal removido |
| `call_started` | sala de chamada abriu |
| `call_ended` | sala de chamada fechou |
| `voice_joined` | entrou em canal de voz |
| `voice_left` | saiu do canal de voz |

**Honestidade sobre `mention`:** ele está no catálogo porque é aceito e
armazenado, mas **não existe evento próprio de menção** — `mapEngineEvent` não o
produz. Quem quer reagir a menção usa `events: ["message_new"]` e testa
`{{event.mention}}` (ou o campo `mention` do webhook).

Para reagir a um evento além do webhook, crie um comando **com o mesmo nome do
evento** e `exec: script`:

```json
{
  "schema": 3,
  "mode": "declarative",
  "prefix": "!",
  "events": ["member_joined"],
  "commands": [
    { "name": "member_joined", "exec": "script",
      "script": "reply \"bem-vindo, {{event.nickname}}!\"" }
  ]
}
```

Loop: mensagem postada pelo bot tem `bot_id`, então o runtime a ignora.

### 7.2 Ponte (`/v1/events`) — nomes crus do motor

A ponte entrega o fluxo do `EngineEvent`, **não** os 13 ids acima. Os nomes que
saem (mapeados em `botbridge::to_queued`):

`message_new`, `message_edited`, `message_deleted`, `message_pinned`,
`reaction_changed`, `member_joined`, `member_left`, `channel_created`,
`channel_deleted`, `voice_joined`, `voice_left`, `voice_state_changed`,
`call_room`, `moderation_applied`, `bot_created`.

Regras reais da ponte:

- `message_status` é **sempre descartado**.
- `message_new` do **próprio bot** é descartado (fim do auto-loop).
- Evento de **outro servidor** é descartado.
- `config.events` e `config.channels` **não filtram** a ponte: ela entrega o que
  o motor emite para aquele servidor. Filtre no plugin.

---

## 8. Ações administrativas — 44 no registro

O registro único é `distorrent_core::moderation::BOT_ACTIONS`. O painel, a DSL e
a ponte leem dele; `/v1/info` devolve a lista viva em `actions`.

> O prompt de origem falava em 45 ações. O registro real tem **44** (contadas em
> `BOT_ACTIONS` e em `BOT_ADMIN_ACTIONS`). Documentar 45 seria inventar.

| Ação | Bit exigido | Argumentos |
|---|---|---|
| `ban` | banir | `<membro> [motivo]` |
| `unban` | banir | `<membro>` |
| `kick` | gerenciar membros | `<membro> [motivo]` |
| `mute` | silenciar | `<membro> [minutos] [motivo]` |
| `unmute` | silenciar | `<membro> [motivo]` |
| `warn` | silenciar | `<membro> [motivo]` |
| `warnings` | silenciar | `<membro>` |
| `warnings_clear` | silenciar | `<membro>` |
| `delete_msg` | apagar mensagens | `<id-da-mensagem>` |
| `clear` | limpar canais | `[#canal] [N]` |
| `lock` | limpar canais | `[#canal]` |
| `unlock` | limpar canais | `[#canal]` |
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
| `pin` | conteúdo e organização | `<id-da-mensagem>` |
| `unpin` | conteúdo e organização | `<id-da-mensagem>` |
| `thread_create` | conteúdo e organização | `<nome> [tag1,tag2]` |
| `thread_archive` | conteúdo e organização | `<id-da-thread> [on\|off]` |
| `poll_create` | conteúdo e organização | `<pergunta> \| <opção> \| <opção>` |
| `emoji_add` | conteúdo e organização | `<nome> <emoji>` |
| `emoji_del` | conteúdo e organização | `<nome>` |
| `typing` | conteúdo e organização | — |
| `userinfo` | — (livre) | `<membro>` |
| `serverinfo` | — (livre) | — |
| `ping` | — (livre) | — |
| `audit` | — (livre) | `[N]` |
| `bans` | — (livre) | — |
| `timeouts` | — (livre) | — |
| `channels` | — (livre) | — |
| `roles` | — (livre) | — |

Alvo aceita **fingerprint**, **apelido** ou menção `<@fp>`. Consulta (as 8
últimas) não exige bit e **não grava auditoria** — só o que muda estado entra em
`audit_log`. Ações que dependem de canal (`thread_create`, `poll_create`,
`typing`) usam o canal de contexto; na ponte, mande `channel` no corpo de
`/v1/admin`.

---

## 9. Permissões

### Os 7 bits (`PERM_ALL`)

| Bit | Rótulo | Valor |
|---|---|---|
| `PERM_BAN` | banir | 1 |
| `PERM_MUTE` | silenciar | 2 |
| `PERM_DELETE` | apagar mensagens | 4 |
| `PERM_MANAGE` | gerenciar membros | 8 |
| `PERM_STRUCTURE` | montar o servidor | 16 |
| `PERM_PURGE` | limpar canais | 32 |
| `PERM_CONTENT` | conteúdo e organização | 64 |

Bot nasce com `perms = 0`. `BotPatch.perms` é mascarado por `PERM_ALL` no core.

### Exceção herdada de `manage`

Antes de os bits serem separados, `PERM_MANAGE` liberava tudo. Quem já tinha esse
bit **continua** podendo estrutura e purga (`perm_satisfied`). O painel espelha
exatamente isso em `permAllows` — sem o espelho, a UI dizia "não pode" enquanto a
ponte executava.

### Escalada por cargo: `perm_can_grant`

`role_assign` só exige `PERM_MANAGE`, mas o cargo atribuído pode ter `ban`/
`mute`. Por isso o core compara o cargo com os bits do bot:

```
extra = role_perms & PERM_ALL & !granted
se extra == 0 -> pode
senão -> só se o bot tem MANAGE e o extra está dentro de {STRUCTURE, PURGE, MANAGE}
```

Sem isso, um bot com `manage` distribuía moderação para qualquer um — escalada
lateral. A mensagem de erro é "o bot não pode dar um cargo com permissões que ele
não tem".

---

## 10. Ponte local `127.0.0.1`

A ponte é o **canal do bot com o servidor**. Não é painel: não edita bot, não
lista servidores, não desenha nada. Escuta **só em loopback** (`tiny_http` em
`127.0.0.1:<porta>`, porta 0 = efêmera) e cada bot tem a **sua** ponte.

Credencial: um **caminho secreto** `/b/<64 hex>` (32 bytes do gerador do core,
128 bits de entropia), gerado a cada abertura. Fechar a ponte invalida o segredo.
Sem ele a rota responde **404** — a ponte nem confirma que existe.

### Rotas

O prefixo secreto já vem na URL (ex.: `http://127.0.0.1:41234/b/9f2c…`). Não há
header de autenticação.

| Rota | O que faz |
|---|---|
| `GET /v1/info` | bot, servidor, canais, membros e a lista viva de `actions` |
| `GET /v1/events?since=<seq>&wait=<ms>` | long-poll (teto de 25 s, 50 eventos por resposta) |
| `GET /v1/config` | prefix, commands, events e channels **deste** bot |
| `GET /v1/limits` | modo, runtime, limites reais e as 20 primitivas |
| `GET /v1/health` | `ok`, `online`, eventos pendentes, descartados, requisições |
| `POST /v1/message` | publica como o bot |
| `POST /v1/admin` | pede uma ação do registro (§8) |
| `POST /v1/commands` | o bot troca a **própria** config |
| `POST /v1/log` | grava no console do bot |
| `POST /v1/stop` | encerra a ponte |

Rota inexistente devolve 404 com a lista de rotas válidas.

#### `GET /v1/info`

```bash
curl "$DISTORRENT_BOT_URL/v1/info"
```

Devolve `api: "distorrent-bot/1"`, `bot` (`id`, `name`, `discriminator`,
`perms`, `online`), `community` (`id`, `name`, `owner_fp`), `channels`
(`id`, `name`, `kind`), `members` (`fp`, `nickname`, `role`) e `actions`
(`action`, `perm`, `args`, `label`).

#### `GET /v1/events`

```bash
curl "$DISTORRENT_BOT_URL/v1/events?since=0&wait=20000"
```

```json
{ "events": [ { "seq": 1, "event": "member_joined", "data": {} } ], "since": 1 }
```

Sem evento no prazo: `{"events": [], "since": null}`. Com a ponte fechando no
meio do long-poll: **503** `{"error":"ponte encerrada"}`. Buffer de **500**
eventos; ao encher, o mais antigo sai e `dropped` sobe.

#### `GET /v1/config`

```bash
curl "$DISTORRENT_BOT_URL/v1/config"
```

Devolve apenas `prefix`, `commands` (`name`, `aliases`, `exec`, `permission`),
`events` e `channels`. **Não devolve** `mode`, `runtime`, `primitives`,
`integrations` nem token.

#### `GET /v1/limits`

```bash
curl "$DISTORRENT_BOT_URL/v1/limits"
```

```json
{
  "api": "distorrent-bot/1",
  "mode": "declarative",
  "runtime": "none",
  "limits": {
    "requestsPerMinute": 120,
    "eventsPerPoll": 50,
    "maxBodyBytes": 65536,
    "maxMessageChars": 1900,
    "maxRepliesPerMinute": 20,
    "maxHttpPerMinute": 60,
    "maxMessagesPerExecution": 20,
    "retentionHours": 24
  },
  "primitives": [ { "id": "text", "enabled": true, "implemented": true } ]
}
```

É a fonte honesta para o criador: `implemented:false` significa "não existe".

#### `GET /v1/health`

```bash
curl "$DISTORRENT_BOT_URL/v1/health"
```

```json
{ "ok": true, "online": true, "events_pending": 0, "dropped": 0, "requests": 12 }
```

#### `POST /v1/message`

```bash
curl -X POST "$DISTORRENT_BOT_URL/v1/message" \
  -H 'content-type: application/json' \
  -d '{"channel":"geral","body":"oi do bot"}'
```

`200` → `{"ok":true,"message_id":"...","channel":"..."}`.
`400` mensagem vazia ou acima de 1900 chars. `404` canal inexistente.
`409` erro do core (bot offline, canal inválido).

#### `POST /v1/admin`

```bash
curl -X POST "$DISTORRENT_BOT_URL/v1/admin" \
  -H 'content-type: application/json' \
  -d '{"action":"ban","target":"<fp-ou-apelido>","reason":"spam","number":null,"channel":"geral"}'
```

`200` → `{"ok":true,"result":"..."}`. Qualquer erro (ação inválida, sem bit, bot
offline, alvo inexistente, alvo é o dono) devolve **403** com `error`.

#### `POST /v1/commands`

```bash
curl -X POST "$DISTORRENT_BOT_URL/v1/commands" \
  -H 'content-type: application/json' \
  -d '{"config":"{\"schema\":3,\"prefix\":\"!\",\"commands\":[{\"name\":\"ping\",\"exec\":\"reply\",\"reply\":\"pong\"}]}"}'
```

O core revalida a config inteira, **preserva a política do dono**
(`blockPrivate` e `http.allowDomains` são copiados da config atual do banco) e
**não deixa o bot mudar `perms`**. Resposta: `{"ok":true,"commands":1}`.
Qualquer falha (JSON inválido, config recusada, bot offline/inexistente) devolve
**400** com `error`.

O segredo do webhook **não passa por aqui**: ele mora na coluna local
`bots.webhook_secret`, não em `bots.config`. Esta rota preserva o valor atual
(o bot nunca troca a própria assinatura) e o painel também não o apaga.

#### `POST /v1/log` e `POST /v1/stop`

```bash
curl -X POST "$DISTORRENT_BOT_URL/v1/log" \
  -H 'content-type: application/json' \
  -d '{"level":"info","message":"ciclo concluído"}'

curl -X POST "$DISTORRENT_BOT_URL/v1/stop"
```

`/v1/log`: `200` `{"ok":true}`; `409` se o bot não existir. Nível fora de
`warn`/`error` vira `info`; mensagem cortada em 1000 chars.
`/v1/stop`: `200` `{"ok":true,"stopping":true}` e a thread da ponte encerra.

### Idempotência

`Idempotency-Key` vale **só para POST**, até 128 chars:

- janela de **5 minutos** e no máximo **200** chaves em memória;
- a resposta (status + corpo, até 8 KB) é repetida sem refazer o efeito;
- aplica-se a `/v1/message` e `/v1/admin` (os que mudam estado). `/v1/log`,
  `/v1/commands` e `/v1/stop` **não** guardam chave.

```bash
curl -X POST "$DISTORRENT_BOT_URL/v1/message" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: pedido-123' \
  -d '{"channel":"geral","body":"uma vez só"}'
```

### Rate limits reais

| Balde | Limite | Protege |
|---|---|---|
| Global | **120 requisições/min** | o processo do app de um plugin descontrolado |
| `/v1/events` | **120/min** | o long-poll não come o orçamento de escrita |
| Demais rotas de escrita | **120/min** | mensagens, admin, log |

Estourou: **429** com `{"error":..., "hint":"respeite o Retry-After...",
"retry_after":60}`. O status `Retry-After` em header **não** é enviado — só o
campo no corpo.

### Segurança da ponte

- **`Origin` presente ⇒ 403.** Navegador sempre manda; programa local não.
- **`Host` precisa ser `127.0.0.1:<porta>` ou `localhost:<porta>`** ⇒ senão 421
  (fecha DNS rebinding).
- **Segredo só no caminho**, comparado em **tempo constante**
  (`secret_matches` usa XOR acumulado, não `starts_with`).
- Corpo até **64 KB**; mensagem até **1900** chars; texto passa por
  `sanitize_text` no core.
- `cache-control: no-store` em toda resposta.
- Fechar o app fecha todas as pontes (`RunEvent::Exit`) — socket não fica órfão.
- **Android:** a ponte não abre (sem processo, sem servidor local).

---

## 11. Webhook de saída (HMAC)

Quando `webhook.url` existe, **todo evento do escopo e toda mensagem** viram um
POST JSON (`botWebhook::buildWebhook`):

```json
{
  "event": "member_joined",
  "delivery": "srv:bot:member_joined:1700000000000",
  "timestamp": 1700000000,
  "data": { "fp": "aaaa", "nickname": "Novo" }
}
```

| Header | Conteúdo |
|---|---|
| `content-type` | `application/json` |
| `x-distorrent-delivery` | id da entrega (receptor deduplica) |
| `x-distorrent-timestamp` | segundos do envio |
| `x-distorrent-signature` | `sha256=<hex>` — só quando há segredo |

Assinatura: **HMAC-SHA256** de `${timestamp}.${body}`, comparada em tempo
constante no receptor; a janela de tolerância é **300 s** (`verifyWebhook`).
Sem o timestamp dentro da mensagem assinada, um corpo capturado valeria para
sempre.

Retry: até **2 tentativas**; 4xx não repete (a URL está errada), 5xx/timeout
repete. Falha vira `warn` no console, sem fila persistente.

**Onde o segredo mora:** coluna local `bots.webhook_secret` (schema 15), **não**
em `bots.config`. Isso resolve três problemas de uma vez: (1) o JSON de config é
sincronizado para todos os membros, e um segredo de assinatura ali vazaria; (2)
qualquer regravação normalizada (`painel`, `POST /v1/commands`) apagaria o valor;
(3) o `bot.json` exportado levaria a credencial sem querer. O estado enviado a
quem **não é dono** traz `webhook_secret` vazio, do mesmo jeito que o `token`.

O `integrations.webhook.signed: true` no JSON é só um marcador informativo: ele
**não** carrega o valor. Quem assina de verdade é o runtime do dono, lendo a
coluna local.

---

## 12. Música do bot (`/v1/audio/*`)

**O que funciona:** o bot manda PCM i16 mono 48 kHz e o som sai no
**alto-falante do PC do dono**, misturado com a voz da chamada. É o `AudioHub`
(`media_voice.rs`) somando os `inbox` no buffer de saída.

```bash
curl -X POST "$DISTORRENT_BOT_URL/v1/audio/open"
# 1 s de silêncio (48000 amostras * 2 bytes, base64), só para medir a rota:
curl -X POST "$DISTORRENT_BOT_URL/v1/audio/frames" \
  -H 'content-type: application/json' \
  -d "{\"pcm\":\"$(head -c 96000 /dev/zero | base64 -w0)\",\"gain\":1.0}"
curl "$DISTORRENT_BOT_URL/v1/audio/status"
curl -X POST "$DISTORRENT_BOT_URL/v1/audio/stop"
```

| Rota | O que faz |
|---|---|
| `POST /v1/audio/open` | abre o canal (idempotente); devolve `delivered:"local"` |
| `POST /v1/audio/frames` | `{"pcm":"<base64 i16 LE>","gain":1.0}` → `accepted`/`dropped` |
| `GET /v1/audio/status` | `open`, `accepted`, `dropped` |
| `POST /v1/audio/stop` | silencia e fecha o canal |

Limites: fila de **250 frames de 20 ms** (5 s); passou disso, o frame **mais
velho** cai e `dropped` sobe (backpressure visível, sem crescer a memória). Até
**480 KB** de PCM por requisição. `gain` 0..2, com saturação (clipping é ruído
para todos).

**O que NÃO funciona, e por quê:** o som **não é transmitido aos outros
participantes da call**. O caminho para isso é o `spawn_send_loop` de cada peer,
alimentado pelo **microfone**; colocar música ali faria o bot soar como o
próprio dono, e o cancelamento de eco (AEC) trataria a música como eco e a
abafaria. Fazer isso direito exige um track de saída separado por peer no
`media_voice.rs` — não existe ainda. A rota responde `to_call: false` em vez de
deixar o criador acreditar que a call toda está ouvindo.

**Plataforma:** só no **Linux** com mídia nativa. No Windows e no Android o
áudio da chamada é da WebView (`RTCPeerConnection`), que o core não alcança; o
comando devolve erro explicando isso em vez de falhar em silêncio.

---

## 13. Plugin (código do criador)

O app executa a pasta como **processo filho**, com a ponte já aberta.

```
meu-bot/
├── bot.json          ← obrigatório na importação
├── bot.js            ← seu código
└── package.json      ← opcional
```

```json
{
  "name": "FreireBot",
  "avatar": "🤖",
  "description": "Ajuda e utilidades",
  "run": "node bot.js",
  "requires": ["node >= 20"],
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

Regras da importação (`botbridge::read_bot_folder`):

- `bot.json` ≤ **256 KB**, `name` com ≥2 caracteres;
- `config` precisa ser objeto e passar no **mesmo** parser do core;
- recusa quando não há `commands`, `events` nem `webhook` ("o bot não faz nada");
- lista até 200 arquivos, profundidade 4, ignorando `.env`, `node_modules`,
  `target`, `.git`, `dist`;
- **`run` e `requires` são lidos mas não são aplicados** na importação: o
  comando de execução é digitado na aba **Ponte e plugin**. `requires` é só
  informativo.

### Importar de um `.zip`

**Adicionar bot existente** aceita pasta, `bot.json` direto ou um arquivo `.zip`.
O `.zip` passa por `botzip::extract_bot_zip` na casca (`bot_zip_read`):

| Guarda | Limite real |
|---|---|
| Extensão + assinatura | precisa terminar em `.zip` e começar com `PK\x03\x04` |
| Caminho de cada entrada | só componentes normais: `..`, absoluto, prefixo de unidade e `:` são recusados (zip-slip) |
| Link simbólico | qualquer entrada symlink recusa o ZIP inteiro |
| Destino | conferido com `canonicalize` + `starts_with` na pasta de importação |
| Tamanho | até **1000** entradas, **8 MB** por arquivo e **32 MB** no total |
| Destino no disco | `<app_data>/bot-imports/<12 bytes hex>` — a pasta **fica** para o plugin rodar dela (importações antigas não são apagadas) |

Depois de extrair, o app reusa `read_bot_folder` — o `bot.json` passa pelo mesmo
parser do core. Se algo é recusado, a pasta temporária é apagada. O `.zip` **não
executa nada**: importar é ler config; o código só roda em **Iniciar plugin**.

### Variáveis de ambiente entregues ao processo

| Variável | Valor |
|---|---|
| `DISTORRENT_BOT_URL` | URL completa **já autenticada**: `http://127.0.0.1:<porta>/b/<segredo>` |
| `DISTORRENT_BOT_PORT` | só a porta |
| `DISTORRENT_API` | `distorrent-bot/1` |

**Não existe token.** O ambiente é limpo (`env_clear`): só `PATH` e estas
variáveis. `cwd` = pasta do bot. `stdin` = nulo; stdout/stderr capturados.

### Execução

- `run` vira **argv direto, sem shell**: `;`, `&&` e `|` são argumentos literais.
- O programa precisa resolver **dentro** da pasta importada
  (`canonicalize` + `starts_with`).
- `Iniciar plugin` exige a ponte aberta.
- Ao parar o plugin (ou fechar o app), o processo é morto e aguardado.
- Se morrer sozinho, o painel mostra `parado (código N)`.
- Console do plugin: 400 linhas, cada uma cortada em 500 chars.
- **Android:** executar código não existe; o erro diz isso.

### Limite honesto de isolamento

O processo filho roda com as permissões do **seu usuário**. A barreira real é a
API da ponte + o opt-in do dono. **Não é sandbox de SO.**

---

## 14. Segurança

### Guarda de URL canônica (SSRF)

Vale para comando `http`, `http` de script e webhook. Implementação no core:
`url_allowed` + `canonical_host`.

1. Esquema **http/https** apenas, host obrigatório, URL ≤ 2048.
2. Host é normalizado pelo parser WHATWG (`url::Url`), não por split de texto:
   `http://2130706433/`, `http://127.1/` e `http://a@127.0.0.1/` resolvem todos
   para `127.0.0.1`.
3. **Sempre bloqueado, nem com opt-in:** `169.254.0.0/16` (metadados de nuvem),
   `0.0.0.0`, `::`, `metadata.google.internal`, `metadata`.
4. **Bloqueado com `blockPrivate` (padrão):**
   - IPv4: `0/8`, `10/8`, `127/8`, `255.255.255.255`, `100.64/10` (CGNAT),
     `172.16/12`, `192.168/16`, `198.18/15` (benchmark), `169.254/16`,
     `192.0.2/24`, `198.51.100/24`, `203.0.113/24` (documentação);
   - IPv6: `::1`, `::`, `fc00::/7` (ULA), `fe80::/10` (link-local);
   - IPv4 mapeado em IPv6: `::ffff:127.0.0.1` é recursado na checagem IPv4;
   - `localhost` e `*.localhost`.
5. Allowlist `http.allowDomains`: vazia libera qualquer destino público;
   `*.` é aceito e não há casamento por sufixo solto (`evil-exemplo.com` não casa
   com `exemplo.com`).

**Redirect:** `http_fetch` revalida **cada salto** com `url_allowed` e pára em
3 redirects. Antes, um 302 para `http://127.0.0.1` furava a guarda.

**Duas camadas:** o renderer recusa antes de salvar (`urlProblem`) e a casca
recusa de novo no `http_fetch` (`allow_private` chega do `blockPrivate`). Sem a
segunda, chamar `http_fetch` direto pela UI alcançava a LAN.

### Tokens

- Token do bot: `bot_<24 hex>_<8 hex>`, gerado no core.
- Só o dono recebe o token no estado sincronizado; os outros recebem `""`.
- `Gerar novo token` invalida o anterior na hora.
- **A ponte não usa o token do bot**: a credencial é o caminho secreto, que morre
  quando a ponte fecha. Nada para colar em `bot.json`.

### Saída

Toda resposta (fixa, HTTP, script) passa por `sanitize_text` (sem controles,
zero-width ou bidi) e é cortada em 1900 chars. A UI renderiza como texto, nunca
HTML. Payload de webhook é sanitizado em até 2 níveis (40 chaves, strings ≤4000).

### Escalada

| Vetor | Barreira |
|---|---|
| Bot se conceder permissão | `bot_replace_config` grava `perms: None` |
| Bot dar cargo forte a alguém | `perm_can_grant` |
| Bot mirar o dono | `bot_action_in` recusa |
| Bot religar rede privada pela ponte | `blockPrivate` do dono é preservado |
| Bot apontar o webhook para outro destino | **não é impedido**: `webhook.url` vem da config nova; só a guarda SSRF (pública/http) vale. O **segredo** e a **allowlist** continuam os do dono: `bot_replace_config` restaura `webhook_secret`, `blockPrivate` e `http.allowDomains` da config atual (§11) |
| Plugin escapar da pasta | `canonicalize` + `starts_with` |

**O que um bot malicioso ainda pode fazer:** chamar uma URL pública arbitrária
(SSRF limitado, não eliminado), postar até o rate limit, publicar link perigoso
como texto, e — no modo `plugin` — tudo o que o seu usuário pode no sistema.

---

## 15. Banco de dados

| Tabela | Conteúdo |
|---|---|
| `bots` | id, community_id, name, discriminator, avatar, role_id, token, online, owner_fp, created_at, **config**, **perms** |
| `bot_logs` | console: 500 linhas por bot, mensagem ≤1000 chars |
| `bot_vars` | variáveis persistentes (`community_id, bot_id, key, value, updated_at`) |
| `warnings` | avisos de moderação (`active` para os vigentes) |
| `messages.bot_id` | liga a mensagem ao bot que a postou |
| `audit_log` | toda ação que muda estado, com `bot:<ação>` |

Migrações relevantes: `bots.config` entra no **schema 7**; `bots.perms`,
`bot_logs`, `bot_vars` e `warnings` no **schema 14**. Bots existentes continuam
válidos: `perms` entra como `0` e a config antiga segue funcionando.

---

## 16. Painel: o que existe de verdade

Servidor → **Bots**, ou a rota `/bots` (tela cheia), ou o painel embutido.

Abas reais do painel do bot (`BotPanel.tsx`):

| Aba | O que tem |
|---|---|
| **Credenciais** | token mascarado; Mostrar, Copiar, Gerar novo; cargo e online |
| **Comandos** | prefixo, respostas/min, editor visual por comando |
| **Permissões** | os 7 bits, com aviso do alcance de `manage` e do "tudo concedido" |
| **Modo e primitivas** | `mode`, as 20 primitivas (as não implementadas ficam desabilitadas), allowlist de domínios, segredo do webhook, mensagens/execução, retenção |
| **Eventos** | os 13 checkboxes, URL do webhook, "bloquear rede local" |
| **Ponte e plugin** | Abrir/Fechar ponte, URL pronta, pasta, comando de execução, Iniciar/Parar plugin, saída do processo |
| **Console** | `bot_logs` + saída do plugin, com Limpar |

Botões da lista (`BotManager.tsx`): **Criar bot**, **Adicionar bot existente**
(lê a pasta ou o `.zip` e cria), **Baixar documentação (.md)**, e por bot:
configurar, ligar/desligar, copiar token, remover.

**O que o painel NÃO tem hoje:** exportar `bot.json` e "testar comando" no
painel atual. A validação sem gravar existe como comando de casca
(`bot_config_validate`, exposto em `services.botConfigValidate`), mas nenhuma
tela o chama hoje.

`BotsApp`/`/bots` tem o botão **Abrir em janela**, que invoca `open_bots_window`
(registrado em `generate_handler!`, janela `bots` declarada em `tauri.conf.json`
com `create:false`). No desktop a janela é criada/trazida para a frente; no
celular o comando devolve erro dizendo que ali a tela é a própria rota `/bots`.

---

## 17. Solução de problemas

| Sintoma | Causa real | O que fazer |
|---|---|---|
| "bot está offline — ative-o no painel" | `online = false` | ligue o bot no cartão |
| comando não responde | prefixo errado, canal/tipo fora do escopo, `enabled:false` ou primitiva desligada | confira os quatro |
| resposta vazia | `responsePath` não existe no JSON | ajuste o caminho ou o template |
| "config inválida: ..." ao salvar | `schema`/`mode`/`prefix`/URL recusados pelo core | leia a mensagem: ela aponta o campo |
| "config de bot muito grande (máx 64KB)" | config acima de 64 KB | encurte scripts/templates |
| "o bot não tem permissão para `ban`" | falta o bit | aba **Permissões** |
| "o bot não pode dar um cargo com permissões que ele não tem" | `perm_can_grant` | conceda o mesmo bit ao bot ou use cargo mais fraco |
| "rede privada bloqueada" | `blockPrivate` ligado | desligue na aba **Eventos**, se for LAN |
| "domínio fora da allowlist" | `http.allowDomains` preenchida | ajuste a lista na aba **Modo e primitivas** |
| "runtime `wasm` ainda não existe" | `runtime: "wasm"` | use `process` ou `declarative` |
| "pasta do bot não existe" | caminho inválido | selecione a pasta que tem `bot.json` |
| "bot.json não encontrado" | apontou o arquivo, não a pasta | importe a **pasta** (ou o `.zip` do bot) |
| "arquivo não é um ZIP" / "caminho fora da pasta de importação" | `.zip` corrompido ou com entrada `..`/absoluta | reempacote o bot com caminhos relativos |
| "o bot não faz nada" | config sem `commands`, `events` nem `webhook` | adicione ao menos um |
| "programa não encontrado na pasta do bot" | `run` aponta para fora | coloque o código dentro da pasta |
| "abra a ponte local do bot antes de iniciar o plugin" | plugin precisa da URL | aba **Ponte e plugin** → Abrir ponte |
| ponte responde 404 | URL sem o segredo (ou segredo de outra sessão) | use a URL que o app mostra |
| ponte responde 403 | `Origin` de navegador, ou ação sem permissão | fale por programa/CLI; conceda o bit |
| ponte responde 421 | `Host` não é loopback | use `127.0.0.1:porta` |
| ponte responde 429 | >120 req/min em algum balde | diminua a frequência e respeite `retry_after` |
| evento duplicado no plugin | falta `Idempotency-Key` no retry | mande a mesma chave por 5 min |
| webhook responde 5xx | serviço do criador fora | o runtime tenta 2× e loga `warn` |
| bot não responde com o app fechado | não há hospedagem | mantenha o app aberto no PC do dono |

---

## 18. Limitações reais e o que não existe

| Funcionalidade | Estado |
|---|---|
| Comandos, aliases, cooldown, rate limit, permissões | **funciona** |
| Resposta fixa, HTTP, DSL, admin nativo | **funciona** |
| Webhook de saída + HMAC | **funciona**; o segredo mora na coluna local e sobrevive a regravação normalizada (§11) |
| Eventos do runtime (§7.1) | **funciona** (só com app aberto no PC do dono) |
| Ponte `127.0.0.1` com segredo no caminho | **funciona** (desktop) |
| Execução de código como plugin | **funciona** (desktop; não é sandbox de SO) |
| Bot responder com o app fechado | **não existe** (sem hospedagem) |
| Ponte no Android | **não existe** (sem processo/servidor local) |
| Bot em canal de voz, áudio ou tela | **parcial**: `/v1/audio/*` toca PCM no alto-falante do PC do dono (Linux com mídia nativa). **Não** transmite aos outros participantes da call (§12.1) |
| Bot em vários servidores com o mesmo processo | **não existe** — um bot pertence a um servidor e a ponte é por bot |
| Interface web de edição na ponte | **não existe** — a ponte é canal de API |
| Sandbox de SO para o código do bot | **não existe** |
| Transporte de entrada para `service`/`remote` | **não existe** nesta versão (só o rótulo) |
| Janela separada de bots (`open_bots_window`) | **funciona no desktop** (`create:false`, criada sob demanda); no celular devolve erro |
| Edição de mensagem em streaming (`edit`) | **não existe** |
| Blob/armazenamento binário por bot | **não existe** |
| Fila/agendamento (`job`, cron, retry) | **não existe** |
| TTL de chave-valor | **não existe** — `bot_vars` não expira |
| Vault/segredo por bot | **não existe** |
| Replay de eventos | **não existe** — buffer em memória de 500 |
| OpenTelemetry/tracing | **não existe** — só `bot_logs` |
| Canary/deploy gradual | **não existe** |
| Bot-a-bot (`invokeBot`) | **não existe** |
| SDK oficial | **não existe** — a API é HTTP na ponte |
| CLI de bots | **não existe** |
| Marketplace de bots | **não existe** — os exemplos ficam em repositórios externos |
| Federação de bots entre servidores | **não existe** |
| Módulo WASM | **não existe** e é recusado na leitura |
| Embed, componente e anexo por bot | **não existe** |
| `maxCallsPerMinute`, `maxMessagesPerExecution` e `retentionHours` aplicados | **não** — declarados e devolvidos, sem enforcement |

---

## 19. Ambiente de desenvolvimento

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:TEMP\node24\node-v24.22.1-win-x64;$env:PATH"
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run tauri:dev
```

Gates do front:

```powershell
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run typecheck
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run lint
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run test:unit
```

Testes Rust (onde há toolchain):

```bash
cd distorrent-core && cargo test --test bots_exec
cd distorrent-core && cargo test bots::
cd src-tauri && cargo test botbridge
cd src-tauri && cargo test botzip
cd src-tauri && cargo test botplugin
```

Suítes que travam o comportamento:

| Suíte | Cobre |
|---|---|
| `distorrent-core/src/bots.rs` (18 testes) | parser, migração, DSL, guarda de URL, primitivas |
| `distorrent-core/tests/bots_exec.rs` (21) | permissões, montar servidor, config própria, logs, variáveis, `perm_can_grant` |
| `src-tauri/src/botbridge.rs` (17) | segredo no caminho, loopback, eventos, idempotência, health/limits |
| `src-tauri/src/botzip.rs` (7) | extensão/assinatura, zip-slip (`..`, absoluto, `:`), symlink, pasta aninhada |
| `src-tauri/src/botplugin.rs` (4) | argv sem shell, pasta, programa dentro da pasta |
| `tests/botCommands.test.ts` (38) | modelo, parser, aliases, serialização |
| `tests/botRuntime.test.ts` (18) | comandos, cooldown, rate limit, script, eventos |
| `tests/botSchemaV3.test.ts` (22) | schema v3, SSRF canônico, HMAC, `permAllows` |
| `tests/botWizard.test.ts` (9) | modelos prontos e markdown do painel |
| `tests/botsDocSync.test.ts` (8) | este documento e o markdown do painel falam o mesmo |

---

## 20. Exemplos de `bot.json`

Os exemplos **não vêm no repositório**: são publicados como plugins no GitHub.
Para usar um, baixe a pasta (ou o `.zip`) e use **Adicionar bot existente**.

UtilityBot (CEP, sem código externo):

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
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
```

ModeradorBot (exige permissões concedidas no painel):

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
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
```

WelcomeBot (evento, sem prefixo em uso):

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "events": ["member_joined"],
  "commands": [
    { "name": "member_joined", "exec": "script",
      "script": "reply \"bem-vindo, {{event.nickname}}!\"" }
  ]
}
```

EconomyBot (variáveis persistentes):

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "commands": [
    { "name": "diario", "exec": "script", "cooldownMs": 86400000,
      "script": "incvar moedas + 10\nreply \"+10 moedas\"" },
    { "name": "saldo", "exec": "script",
      "script": "getvar m = moedas\nreply \"seu saldo: {{m}}\"" }
  ]
}
```

MusicBot: **não é funcional**. Tocar áudio exigiria o bot entrar no canal de voz
pelo protocolo de mídia, e o runtime de bot não tem caminho de áudio.

---

## 21. Changelog

### 2026-11-06 — schema v3 e correções de segurança

**Schema**

- `schema` explícito (1, 2 ou 3); ausência é v2 migrado, fora de 1..3 é erro.
- `mode` (`declarative`, `plugin`, `service`, `remote`) e `runtime`
  (`none`, `process`, `wasm`) explícitos — nunca inferidos do que foi preenchido.
- `runtime: wasm` é **recusado** com erro claro (não existe nesta versão).
- `primitives` com 20 chaves e flag `implemented`; desligar `text`/`ephemeral`/
  `http` remove os comandos que dependem delas.
- Novos campos: `channelKinds`, `integrations.http.allowDomains`,
  `integrations.http.maxCallsPerMinute`, `integrations.limits`,
  `integrations.retention`, `integrations.webhook.secret`.
- `normalize()` devolve o JSON v3 canônico e **nunca** serializa o segredo do
  webhook (só `{"signed":true}`).
- Migração v1/v2 → v3 na leitura, sem exigir recriação de bot.

**Segurança**

- `canonical_host()` usa `url::Url`: `2130706433`, `127.1` e `a@127.0.0.1`
  deixam de furar a guarda.
- `is_private_host` cobre `0/8`, `100.64/10`, `198.18/15`, faixas de
  documentação e IPv4 mapeado em IPv6 (`::ffff:127.0.0.1`).
- `http_fetch` recebe `allow_private` e revalida **cada salto de redirect**.
- `perm_can_grant`: o bot não distribui cargo com permissão que não tem.
- Segredo da ponte comparado em **tempo constante**.
- `POST /v1/commands` preserva `blockPrivate` e `http.allowDomains` do dono.
- Webhook de saída assinado com **HMAC-SHA256** (timestamp na mensagem, janela de
  300 s, comparação em tempo constante).

**Ponte**

- Três baldes de rate limit: global 120/min, `/v1/events` 120/min, escrita
  120/min — o long-poll não consome mais o orçamento de post.
- `Idempotency-Key` (5 min, 200 chaves) em `/v1/message` e `/v1/admin`.
- `MAX_EVENTS_PER_POLL = 50`: um `since=0` não devolve mais o buffer inteiro.
- Rotas novas: **`GET /v1/limits`** (limites reais + primitivas com
  `implemented`) e **`GET /v1/health`**.
- A mensagem do próprio bot **não** volta em `/v1/events` (fim do auto-loop).
- `403` para `Origin`, `421` para `Host` não-loopback, `429` com `retry_after`.

