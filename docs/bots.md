# Bots do servidor — criar, configurar e reagir a eventos

**Atualizado em 2026-11-02.** Este documento descreve apenas o que o código faz
hoje. Onde algo não existe, está escrito que não existe — não há "API futura"
aqui.

## 1. O que um bot é (e não é)

Um bot do DisTorrent **não é um processo separado**. Ele é:

- uma **linha** no banco do servidor (`bots`): id, nome, discriminador, avatar,
  token, cargo, `online`, `config` (JSON);
- um **runtime no dispositivo do dono** (`src/services/botRuntime.ts`), que
  escuta mensagens recebidas e dispara HTTP GET/POST + webhook;
- um **autor de mensagem** — quando responde, a mensagem é assinada pelo dono e
  marcada com `bot_id` para a UI mostrar avatar/nome do bot.

Consequências importantes:

- **Só o dono do servidor tem o token.** O estado sincronizado envia o token
  **mascarado** (`""`) para os outros membros; só o dono recebe o valor real.
- **Só o dono executa o runtime.** Um membro comum não responde pelos bots (e
  isso é de propósito: em mesh duplicaria a resposta).
- **O bot não roda com o app fechado.** Não há servidor de bots hospedado; se o
  dono fecha o app, os comandos não respondem.
- **O bot só continua "online" enquanto o dono o deixar ligado** no painel: o
  core recusa `bot_post_message` de bot com `online = false`.

## 2. Criar um bot (painel)

1. Abra o servidor → menu do servidor → **Bots** (só o dono vê a entrada).
2. **Novo bot**: nome (sem espaços no fim), discriminador, avatar.
3. O bot nasce **offline**. Ligue-o no cartão dele (**Ativar**) antes de esperar
   resposta — postar com ele desligado devolve
   `bot está offline — ative-o no painel`.
4. **Copiar token** quando precisar integrar um serviço externo. **Gerar novo
   token** invalida o anterior na hora (é o mesmo `credential` do bot).

O bot pode ter um **cargo** (`role_id`) para aparecer na cor/lista certa.

## 3. Configuração (JSON) — o que o runtime entende

Salva em `bots.config` (máx. 16 KB). O parser é `parseBotConfig` em
`src/services/botCommands.ts`; tudo que não casa com o formato é **descartado**,
não gera erro silencioso de rede.

```json
{
  "prefix": "!",
  "commands": [
    {
      "name": "clima",
      "method": "GET",
      "url": "https://api.exemplo.com/clima?q={{args}}",
      "headers": { "accept": "application/json" },
      "responsePath": "current.temp_c",
      "template": "Agora faz {{value}}°C em {{raw.args}}"
    },
    {
      "name": "recado",
      "method": "POST",
      "url": "https://api.exemplo.com/recado",
      "body": "{\"de\":\"{{arg0}}\",\"texto\":\"{{raw.args}}\"}",
      "template": "recado enviado"
    }
  ],
  "channels": [],
  "webhook": { "url": "https://api.exemplo.com/hook" }
}
```

| Campo | Regra |
|---|---|
| `prefix` | **1 caractere** de `! / . $ @ # % -`. Ausente = `!`. |
| `commands[]` | máx. **16**. `name` (a-z, 0-9, hífen) + `url` **http/https** são obrigatórios. |
| `method` | `GET` ou `POST` (qualquer outro cai em `GET`). |
| `headers` | até **16** pares; chave ≤64, valor ≤512 caracteres. |
| `body` | só em POST; até **2048** caracteres. |
| `responsePath` | caminho pontilhado (`data.temp`, `items[0].name`). |
| `template` | até **512**; sem `responsePath`, o padrão é `{{json}}`. |
| `channels` | ids de canais onde o bot atua. **`[]` = todos os canais**, inclusive os criados depois. |
| `webhook.url` | http/https, ≤512. Recebe **toda** mensagem do escopo (comando ou não). |

### Placeholders (só em `url`, `body` e `template`)

| Placeholder | Valor |
|---|---|
| `{{args}}` | todos os argumentos separados por `/`, cada um URL-encoded |
| `{{query}}` | todos os argumentos separados por `+`, URL-encoded |
| `{{arg0}}`, `{{arg1}}`… | argumento N, URL-encoded |
| `{{raw.args}}` | argumentos crus separados por espaço (NÃO use em URL) |
| `{{value}}` | valor extraído por `responsePath` |
| `{{json}}` | corpo inteiro da resposta |
| `{{json.caminho.da.chave}}` | caminho pontilhado do JSON |

### Comando: como o texto é reconhecido

`parseBotCommand(prefix, body)`:

- exige o prefixo **no começo** do texto (depois de `trim`);
- nome do comando **imediatamente** após o prefixo, sem espaço (`!clima`);
- argumentos até **16** palavras.

`!clima são paulo` → `{ name: 'clima', args: ['são', 'paulo'] }`.

### Resposta

1. chama a URL (timeout **10 s**; no desktop o `http_fetch` do Tauri limita a
   **15 s** e resposta a **256 KB**);
2. se `responsePath` existir e não resolver, **não responde** (falha honesta);
3. renderiza `template` (ou `{{json}}`);
4. corta em **1900** caracteres e posta no **mesmo canal** da mensagem;
5. se o bot está desligado ou o canal não existe, o post falha e **não há
   retry** (evita flood).

### Webhook de saída

```
POST <webhook.url>
content-type: application/json

{
  "author": "<fingerprint do autor>",
  "nickname": "<mesmo fingerprint — o runtime não tem apelido aqui>",
  "channel": "<id do canal>",
  "body": "<texto da mensagem>",
  "ts": 1760000000000
}
```

- o **token do bot NÃO vai no webhook**;
- dispara para toda mensagem do escopo, mesmo sem comando;
- falha de rede é ignorada (`best-effort`).

## 4. Eventos que o runtime consome hoje

O runtime assina `services.subscribe` e trata **um** tipo:

| Evento | Reação |
|---|---|
| `message_new` com `direction = "in"` e `bot_id` vazio | procura os servidores do dono, filtra os bots do canal, roda comando/webhook |

Ou seja: **hoje o bot reage a mensagens recebidas de outras pessoas**. Ele
**não** reage a:

- mensagens que o próprio dono postou (`direction = "out"`) — é o que evita
  loop de bot respondendo a si mesmo;
- mensagens do próprio bot (`bot_id` preenchido);
- eventos de canal/cargo/membro (criar canal, entrar/sair, chamada);
- menções fora de `message_new`.

Se você precisa de outro gatilho, ele **não existe** — não é configurável por
JSON. A alternativa honesta hoje é o webhook de saída + um serviço seu.

## 5. Eventos internos do motor (para quem for estender)

A lista abaixo é a fonte real (`EngineEvent` em
`distorrent-core/src/net/engine.rs`), serializada com o campo `type` em
snake_case. Ela é útil para um bot **embutido** (feito no código), não para o
JSON do painel:

| `type` | Quando |
|---|---|
| `state_changed` | estado agregado da rede mudou |
| `peer_online` / `peer_offline` / `peer_discovered` | sessão de peer |
| `message_new` / `message_status` | mensagem recebida; status de envio |
| `friend_request_in` / `friend_accepted` / `friend_removed` | amizade |
| `community_joined` / `community_removed` | entrou/saiu/foi removido de servidor |
| `group_synced` | roster de grupo atualizado |
| `channel_created` / `channel_deleted` / `role_created` / `role_deleted` / `bot_created` | **só no modo navegador** (o motor nativo avisa via `community_joined` após o sync) |
| `call_incoming` / `call_accepted` / `call_ringing` / `call_rejected` / `call_ended` | sinalização de chamada |
| `call_offer` / `call_answer` / `call_ice` / `call_participant_added` | mídia WebRTC |
| `voice_joined` / `voice_left` / `voice_state_changed` | roster de canal de voz/vídeo |
| `call_room` | sala de chamada anunciada (grupo/DM) |
| `file_announce` / `file_chunk_request` / `file_chunk_data` | swarm de arquivos |
| `typing`, `reaction_changed`, `message_edited`, `message_deleted`, `message_pinned`, `message_reply` | camada social |
| `presence_changed`, `profile_changed` | presença/perfil |
| `moderation_applied`, `thread_created`, `emoji_updated` | moderação/threads/emoji |

> **Nota de honestidade:** `channel_created`/`role_created`/`bot_created` são
> emitidos pelo store local do navegador. No app nativo a estrutura chega pelo
> `CommunityState` e o motor emite `community_joined`. Se o seu código escuta
> apenas `channel_created`, ele **não** funciona no desktop/mobile nativo.

## 6. Limites e erros conhecidos

| Sintoma | Causa real | O que fazer |
|---|---|---|
| "bot está offline — ative-o no painel" | `online = false` no BotRow | ligar o bot no cartão |
| comando não responde | prefixo errado, canal fora de `channels`, bot sem `config` | conferir os três |
| resposta vazia | `responsePath` não existe no JSON | testar o endpoint no painel (aba **Comandos** tem teste) |
| webhook não chega | URL inválida/não http(s) ou serviço fora | o runtime ignora falha, sem retry |
| bot some para outro membro | token/funcionalidade é do dono; o membro só vê o bot na lista | comportamento esperado |
| bot não responde com o app fechado | não há hospedagem de bots | manter o app aberto no PC do dono |

## 7. Segurança

- o token é um **credential**: não vai para o webhook, não é enviado a membros
  comuns e não deve ser colado em canal;
- URLs só `http`/`https`; o `http_fetch` recusa outro esquema e host vazio;
- cabeçalhos limitados (16 pares) e corpo limitado (16 KB de config);
- mensagem de bot é **assinada pelo dono** (o `bot_id` é só display) — um
  membro não consegue se passar pelo bot.
