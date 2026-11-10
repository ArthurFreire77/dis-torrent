# Criar um bot do DisTorrent — guia do criador

**Este é o guia passo a passo.** Ele descreve o que o código faz hoje (schema v3).
Se algo não existe, está escrito que não existe — não é bug de configuração.
A referência técnica completa é `docs/bots.md`.

Um bot tem duas partes:

| Parte | Onde vive | Você configura? |
|---|---|---|
| **Bot do servidor** (nome, avatar, cargo, permissões, comandos) | banco do servidor | no painel do app |
| **Código do bot** (opcional) | uma pasta no PC de quem é dono do servidor | não: o app injeta tudo |

**Não existe token para colar em código.** Quem roda é o PC do dono; o servidor
entrega as mensagens a todos os membros (Windows, Linux, Android). O app gera a
credencial da ponte local sozinho e injeta no processo do plugin.

> **App fechado no PC do dono = bot mudo.** Não existe hospedagem de bot no
> DisTorrent: não há fila, retry nem nuvem.

---

## Sumário

1. [Comece aqui](#1-comece-aqui)
   - [Caminho A — resposta ou consulta em 2 minutos](#11-caminho-a--resposta-ou-consulta-em-2-minutos)
   - [Caminho B — chamar uma API ou uma IA](#12-caminho-b--chamar-uma-api-ou-uma-ia)
   - [Caminho C — bot com código (plugin local)](#13-caminho-c--bot-com-código-plugin-local)
2. [Receitas prontas (colar e usar)](#2-receitas-prontas-colar-e-usar)
3. [Entender a config (schema v3)](#3-entender-a-config-schema-v3)
4. [Placeholders](#4-placeholders)
5. [Como testar de verdade](#5-como-testar-de-verdade)
6. [Erros comuns e como ler a mensagem](#6-erros-comuns-e-como-ler-a-mensagem)
7. [O que o bot NÃO faz](#7-o-que-o-bot-não-faz)
8. [Permissões e ações administrativas](#8-permissões-e-ações-administrativas)
9. [Ponte local e plugin (referência)](#9-ponte-local-e-plugin-referência)
10. [Publicar o bot](#10-publicar-o-bot)
11. [Arquivos que mandam e gates](#11-arquivos-que-mandam-e-gates)

---

## 1. Comece aqui

Escolha **um** caminho. Todos terminam no mesmo lugar: um bot online no painel,
respondendo no canal. Você pode trocar de caminho depois sem recriar o bot.

| Se você quer… | Vá para | Precisa de |
|---|---|---|
| resposta fixa ou consulta simples | [Caminho A](#11-caminho-a--resposta-ou-consulta-em-2-minutos) | nada além do app |
| chamar uma API, IA ou webhook | [Caminho B](#12-caminho-b--chamar-uma-api-ou-uma-ia) | URL pública e, se exigir, chave |
| lógica própria, biblioteca, estado | [Caminho C](#13-caminho-c--bot-com-código-plugin-local) | Node/Python instalado no PC do dono |

Antes de qualquer caminho, abra **Servidor → Bots** (ou a rota `/bots`) e clique
em **Criar bot**. Nome: 2 a 32 caracteres, letras/números/espaço/ponto/hífen.
O bot nasce **online**, mas ainda sem comando.

### 1.1 Caminho A — resposta ou consulta em 2 minutos

O bot mais simples possível: resposta fixa, sem rede, sem código.

1. No cartão do bot, abra **Configurar** (engrenagem).
2. Aba **Comandos** → **Adicionar comando**.
3. Tipo **Resposta fixa**; nome `ping`; resposta `pong`.
4. **Salvar**. Mande `!ping` num canal de texto.

Pronto. Se não responder, veja [erros comuns](#6-erros-comuns-e-como-ler-a-mensagem).

A consulta (GET) é o mesmo caminho, mudando o tipo:

1. **Adicionar comando** → tipo **Chamar API (HTTP)**.
2. Método `GET`, URL com placeholders (`{{arg0}}`), **Caminho da resposta** e
   **Template**.
3. **Testar com argumentos** → **Testar** (executa sem postar no canal).
4. Quando o teste ficar ✅, **Salvar**.

Exemplo real sem chave (CEP):

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "commands": [
    {
      "name": "cep",
      "exec": "http",
      "method": "GET",
      "url": "https://viacep.com.br/ws/{{arg0}}/json/",
      "responsePath": "logradouro",
      "template": "{{value}} — {{json.bairro}}, {{json.localidade}}/{{json.uf}}"
    }
  ],
  "channels": [],
  "integrations": {
    "http": { "allowDomains": ["viacep.com.br"] }
  }
}
```

### 1.2 Caminho B — chamar uma API ou uma IA

O roteiro completo, campo a campo. O mesmo vale para qualquer API HTTP.

1. **Configurar** → aba **Comandos** → **Adicionar comando**.
2. Tipo **Chamar API (HTTP)**.
3. **Método**: `POST` (a maioria das APIs de IA) ou `GET` (consultas).
4. **URL**: `https://...` — nunca `http://` para dado sensível, e nada de
   `localhost` com “bloquear rede local” ligado (é o padrão).
5. **Caminho da resposta**: onde está o texto que você quer no JSON de volta.
   `items[0].name` e `data.temp` são aceitos. O botão **Testar** mostra o corpo
   quando o caminho não acha nada.
6. **Corpo (POST)**: o JSON enviado. Use `{{jsonargs}}` para a pergunta do
   usuário — ela já sai escapada (aspas, barra e quebra de linha não quebram o
   JSON). `{{raw.args}}` é cru, use só fora de JSON.
7. **Headers** (um por linha): `Authorization: Bearer SUA-CHAVE`,
   `content-type: application/json`. Até 16 pares.
8. **Timeout (s)** — vazio = 10 s, teto de 90 s. **IA precisa de 60.**
9. **Template da resposta**: `{{value}}` (o campo escolhido) ou
   `{{json.caminho}}`.
10. **Testar com argumentos** → **Testar** → confira status, tempo e texto; só
    então **Salvar**.

Exemplo com API compatível com OpenAI:

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "commands": [
    {
      "name": "ia",
      "exec": "http",
      "method": "POST",
      "url": "https://api.openai.com/v1/chat/completions",
      "headers": {
        "authorization": "Bearer COLE-SUA-CHAVE",
        "content-type": "application/json"
      },
      "body": "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"{{jsonargs}}\"}]}",
      "responsePath": "choices[0].message.content",
      "timeoutMs": 60000,
      "template": "{{value}}"
    }
  ],
  "channels": [],
  "integrations": {
    "http": { "allowDomains": ["api.openai.com"] }
  }
}
```

Troque o modelo e a URL pelo provedor compatível que você usa. Três avisos
honestos:

- **A chave fica na config do bot**, que é sincronizada para os membros do
  servidor. Use uma chave restrita/descartável e troque se vazar. Para segredo
  de verdade, o caminho é o plugin (Caminho C), que lê variável de ambiente.
- **Timeout curto mata LLM.** Abaixo de ~30 s a resposta chega depois do corte.
- **`responsePath` errado = silêncio.** O bot não inventa texto: se o caminho não
  existir, o console registra `resposta vazia` e nada é postado.

### 1.3 Caminho C — bot com código (plugin local)

Use quando a DSL não basta (biblioteca, estado próprio, integração complexa).

1. Crie uma pasta com `bot.json` e o código:

```
meu-bot/
├── bot.json          ← obrigatório
├── bot.js            ← seu código
└── package.json      ← opcional
```

2. `bot.json`:

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

3. Código mínimo (`bot.js`) — **não há SDK e não há token**:

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

4. No painel: **Configurar** → aba **Ponte e plugin** → **Abrir ponte** (o app
   escolhe a porta e gera o segredo) → preencha **Pasta do bot** e **Comando de
   execução** (`node bot.js`) → **Iniciar plugin**.

O processo recebe só `PATH`, `DISTORRENT_BOT_URL`, `DISTORRENT_BOT_PORT` e
`DISTORRENT_API`. `run` vira **argv direto, sem shell** (`;`, `&&`, `|` são
argumentos literais) e o programa precisa estar **dentro** da pasta importada.
**Não é sandbox de sistema operacional:** rode só código em que você confia.

### 1.4 Importar um bot pronto (um clique)

1. Baixe o `.zip` do bot (tem `bot.json` dentro) — ou já tenha a pasta dele.
2. **Adicionar bot existente** → **Escolher .zip** (ou **Escolher pasta**).
3. Pronto. O app salva o arquivo, extrai, lê o `bot.json`, valida no **mesmo
   parser do core**, cria o bot com nome e avatar e aplica a configuração.

Não há caminho para digitar: o seletor nativo do Windows abre na hora. Se
precisar, a opção "Preferir digitar o caminho" continua embaixo.

O código **não** começa a rodar na importação. Ele fica pronto: abra
**Configurar → Ponte e plugin**, clique em **Abrir ponte** e **Iniciar plugin**.

Um `.zip` é extraído para `<app_data>/bot-imports/<aleatório>` (pasta privada do
app, que fica lá para o plugin rodar dela). A extração é defensiva:

| Guarda | Limite real |
|---|---|
| Formato | extensão `.zip` **e** assinatura `PK\x03\x04` |
| Caminho de cada entrada | só relativo; `..`, caminho absoluto e letra de unidade são recusados (zip-slip) |
| Link simbólico | recusa o `.zip` inteiro |
| Tamanho | 1000 entradas, 8 MB por arquivo, 32 MB no total |
| Conteúdo | mesma regra da pasta: 200 arquivos listados, profundidade 4, `.env`/`node_modules`/`target`/`.git`/`dist` ignorados |

Se o `bot.json` for recusado, a pasta extraída é apagada. Um `.zip` com
`../algo` **não** é "corrigido": reempacote com caminhos relativos.

---

## 2. Receitas prontas (colar e usar)

Todas são config completa. Para usar: **Configurar** → (se o painel oferecer
colar JSON, cole; senão recrie os campos na aba **Comandos**) → **Salvar**.
Cada receita diz o que faz, o que precisa e como testar.

Trocar o prefixo `!` por `/`, `.`, `$`, `@`, `#`, `%` ou `-` é permitido.

### 2.1 Ping — o teste de vida

**O que faz:** responde `pong` a `!ping`, com 3 s de cooldown por pessoa.
**O que precisa:** nada além de criar o bot e salvar.
**Como testar:** mande `!ping` num canal de texto; o console mostra
`/ping respondeu`.

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "commands": [
    { "name": "ping", "exec": "reply", "reply": "pong 🏓", "cooldownMs": 3000 }
  ],
  "channels": []
}
```

### 2.2 Ajuda — a lista de comandos

**O que faz:** responde a lista quando alguém manda `!ajuda` (ou `!help`).
**O que precisa:** nada. Depois acrescente os outros comandos na mesma config.
**Como testar:** `!ajuda` no canal.

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "commands": [
    {
      "name": "ajuda",
      "aliases": ["help", "comandos"],
      "exec": "reply",
      "reply": "Comandos:\n!ping — teste de vida\n!clima <lat> <lon> — temperatura agora\n!ia <pergunta> — responde com IA"
    }
  ],
  "channels": []
}
```

### 2.3 Clima — Open-Meteo, sem chave

**O que faz:** `!clima -23.55 -46.63` responde a temperatura e o vento agora.
**O que precisa:** nada além de internet. A allowlist cobre o domínio.
**Como testar:** **Testar com argumentos** = `-23.55 -46.63` (o botão não posta);
depois `!clima -23.55 -46.63` no canal.

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "commands": [
    {
      "name": "clima",
      "exec": "http",
      "method": "GET",
      "url": "https://api.open-meteo.com/v1/forecast?latitude={{arg0}}&longitude={{arg1}}&current=temperature_2m,wind_speed_10m",
      "responsePath": "current.temperature_2m",
      "template": "Agora faz {{value}} °C (vento {{json.current.wind_speed_10m}} km/h)."
    }
  ],
  "channels": [],
  "integrations": {
    "http": { "allowDomains": ["api.open-meteo.com"] }
  }
}
```

### 2.4 IA — API compatível com OpenAI

**O que faz:** `!ia explique buracos negros` manda a pergunta como está e posta a
resposta.
**O que precisa:** chave da API compatível, o modelo certo e **timeout de 60 s**.
A chave fica na config (sincronizada para os membros): use uma restrita.
**Como testar:** **Testar com argumentos** = `diga oi em uma frase`; o teste
mostra o status HTTP e o texto. Se der `HTTP 401`, a chave está errada; `HTTP
404`, o modelo/URL não existe.

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "commands": [
    {
      "name": "ia",
      "exec": "http",
      "method": "POST",
      "url": "https://api.openai.com/v1/chat/completions",
      "headers": {
        "authorization": "Bearer COLE-SUA-CHAVE",
        "content-type": "application/json"
      },
      "body": "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"{{jsonargs}}\"}]}",
      "responsePath": "choices[0].message.content",
      "timeoutMs": 60000,
      "template": "{{value}}"
    }
  ],
  "channels": [],
  "integrations": {
    "http": { "allowDomains": ["api.openai.com"] }
  }
}
```

### 2.5 Moderação — ban, kick e mute

**O que faz:** `!ban <membro> <motivo>`, `!kick <membro> <motivo>`,
`!mute <membro> <minutos> <motivo>` e `!avisos <membro>`.
**O que precisa:** conceder na aba **Permissões** os bits **banir**,
**gerenciar membros** e **silenciar**. Quem usa o comando precisa de cargo com a
mesma permissão (campo `permission`). O **dono do servidor nunca é alvo** e toda
ação que muda estado entra no audit log.
**Como testar:** não há botão Testar para ação administrativa — use um membro de
teste no canal. O console registra `/ban por <autor>` ou o erro exato.
**Limite honesto:** o alvo é **a primeira palavra**; apelido com espaço não
funciona — use o fingerprint ou `<@fp>`.

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "commands": [
    { "name": "ban", "exec": "admin", "admin": "ban", "permission": "moderate" },
    { "name": "kick", "exec": "admin", "admin": "kick", "permission": "moderate" },
    { "name": "mute", "exec": "admin", "admin": "mute", "permission": "moderate" },
    { "name": "avisos", "exec": "admin", "admin": "warnings" }
  ],
  "channels": [],
  "events": []
}
```

### 2.6 Enquete — poll nativo

**O que faz:** `!enquete Pizza | sim | nao` cria uma enquete no canal.
**O que precisa:** bit **conteúdo e organização** concedido ao bot.
**Como testar:** mande no canal; não há Testar para admin.
**Limite honesto:** a pergunta é **uma palavra** (o alvo do comando é o primeiro
token). Use `!enquete Pizza | sim | nao`, não uma frase com espaços.

```json
{
  "schema": 3,
  "mode": "declarative",
  "runtime": "none",
  "prefix": "!",
  "commands": [
    { "name": "enquete", "exec": "admin", "admin": "poll_create" }
  ],
  "channels": [],
  "events": []
}
```

---

## 3. Entender a config (schema v3)

O painel grava JSON, mas você quase nunca precisa digitá-lo. Campos que mudam o
comportamento:

| Campo | Regra real |
|---|---|
| `schema` | `3` é o atual. Sem o campo = v2 migrado. Fora de 1..3 invalida. |
| `mode` | `declarative` (padrão), `plugin`, `service`, `remote`. Desconhecido invalida. |
| `runtime` | `none` ou `process`. **`wasm` é recusado** — não existe nesta versão. |
| `prefix` | **1** caractere de `! / . $ @ # % -`. Ausente = `!`. |
| `commands[]` | até 48. `name` vira minúsculo, sem acento, espaço vira hífen, até 32. |
| `exec` | `reply` \| `http` \| `script` \| `admin`. Sem o campo, é inferido. |
| `permission` | exige do **autor** `moderate`, `manage` ou `owner`. Nunca maior que o bot. |
| `cooldownMs` | 0 a 86.400.000; padrão 1.500 ms, por autor e por comando. |
| `channels` | ids de canal; `[]` = todos, inclusive os criados depois. |
| `channelKinds` | `text` \| `voice` \| `video` \| `forum`; `[]` = todos. |
| `events` | lista fechada de 13; desconhecido é descartado. |
| `webhook.url` | POST de saída para http(s); sem token no corpo. |
| `blockPrivate` | padrão `true`: bloqueia rede privada/loopback. O bot não desliga sozinho. |
| `integrations.http.allowDomains` | vazio = qualquer destino público; `exemplo.com` cobre subdomínios. |
| `maxRepliesPerMinute` | 1 a 120; padrão 20. |

Limite total: **64 KB** de config. `maxCallsPerMinute`,
`maxMessagesPerExecution` e `retentionHours` são **declarados e devolvidos** em
`/v1/limits`, mas **não são aplicados**; o corte real de mensagens por script é
**8**.

`mode` não muda o caminho de execução: o runtime declarativo roda igual em
`declarative`, `service` e `remote`. E `remote` **não tem transporte de entrada
nesta versão** — só o rótulo.

### Os quatro tipos de comando

| Tipo | Para quê | Testável no painel? |
|---|---|---|
| `reply` | texto fixo com placeholders | pelo canal |
| `http` | GET/POST numa API | **sim**, botão **Testar** |
| `script` | lógica de várias linhas, sem `eval` | pelo canal + console |
| `admin` | ação do registro de moderação | pelo canal (precisa de bit) |

---

## 4. Placeholders

Só funcionam em `url`, `body`, `template` e `reply` (e no script, com as
variantes abaixo).

| Placeholder | Valor |
|---|---|
| `{{args}}` | argumentos separados por `/`, cada um URL-encoded |
| `{{query}}` | argumentos separados por `+`, URL-encoded |
| `{{arg0}}`, `{{arg1}}`… | argumento N, URL-encoded |
| `{{raw.args}}` | argumentos crus separados por espaço — **nunca em URL** |
| `{{jsonargs}}` | argumentos **escapados para JSON** — use no corpo do POST |
| `{{author}}` | nome de quem mandou o comando |
| `{{value}}` | valor achado em `responsePath` |
| `{{json}}` | corpo inteiro da resposta |
| `{{json.caminho}}` | caminho pontilhado, inclusive lista (`items[0].name`) |
| `{{var.nome}}` | variável persistente (`setvar`) |

No script também existem `{{bot}}`, `{{channel}}`, `{{mention}}` e
`{{event.campo}}`.

---

## 5. Como testar de verdade

1. **Botão Testar (só HTTP).** Aba **Comandos** → **Testar com argumentos** →
   **Testar**. Ele chama a URL de verdade, **sem postar no canal**, e mostra:
   - `✅ HTTP 200 (312ms) — resposta: ...` quando deu certo;
   - `⚠️ HTTP 200 (ms), mas o responsePath/template não achou texto (...)`;
   - `❌ HTTP 401 (ms): ...` quando a API recusou;
   - `❌ domínio fora da allowlist` / `❌ rede privada bloqueada (...)`.
2. **Canal.** Mande o comando como um membro comum. O console (aba **Console**)
   mostra `/<nome>: HTTP 200`, `resposta vazia (responsePath/template)`,
   `domínio fora da allowlist` ou o erro.
3. **Plugin.** Com a ponte aberta:

```bash
curl "$DISTORRENT_BOT_URL/v1/health"
curl "$DISTORRENT_BOT_URL/v1/info"
```

4. **Validar config sem gravar** (console de devtools): o comando de casca
   `bot_config_validate` devolve o erro exato do campo. Nenhuma tela o chama
   hoje; salvar pelo painel já valida antes de gravar.

Checklist antes de considerar pronto:

| Verificar | Como |
|---|---|
| Config válida no core | salvar no painel; o erro aparece na hora |
| Comando responde | mandar no canal e olhar o console |
| Permissão certa | aba **Permissões**; o bot nasce com zero |
| URL pública e na allowlist | aba **Modo e primitivas** |
| Sem loop | mensagem do próprio bot não volta em `/v1/events` |
| Sem duplicata em retry | `Idempotency-Key` nos POSTs |
| Webhook assinado | segredo ≥16 chars + `x-distorrent-signature` |

---

## 6. Erros comuns e como ler a mensagem

O texto entre aspas é o que o app/core devolve hoje. Leia a mensagem inteira: ela
quase sempre aponta o campo.

| Mensagem exata | Causa | O que fazer |
|---|---|---|
| `bot está offline — ative-o no painel` | `online = false` no bot | ligar no cartão do bot |
| `o bot não tem permissão para \`ban\` — conceda no painel de Bots` | falta o bit da ação | aba **Permissões** |
| `o bot não tem permissão para /ban — o dono precisa conceder no painel` | mesma coisa, dita pelo runtime | idem |
| `/ping recusado: <fp> não tem permissão (moderate)` | o autor não tem o cargo exigido por `permission` | dar cargo ao autor ou esvaziar `permission` |
| `config de bot não é JSON válido: ...` | vírgula/chave sobrando | corrigir o JSON |
| `config de bot precisa ser um objeto JSON` | colou lista ou texto | use `{ ... }` |
| `config de bot muito grande (máx 64 KB)` | passou de 64 KB | encurtar scripts/templates |
| `prefixo precisa ser 1 caractere de ! / . $ @ # % -` | prefixo com 2 chars ou fora da lista | usar um dos oito |
| `modo desconhecido: \`x\` (use declarative\|plugin\|service\|remote)` | `mode` inventado | corrigir |
| `runtime desconhecido: \`x\` (use none\|process\|wasm)` | `runtime` inventado | `none` ou `process` |
| `runtime \`wasm\` ainda não existe nesta versão — use \`process\` (plugin) ou \`declarative\`` | pediu WASM | não existe: troque |
| `schema N não é suportado (este app entende 1, 2 e 3)` | `schema` fora da faixa | usar 3 |
| `resposta vazia (responsePath/template)` | o caminho não existe no JSON | ajustar `responsePath` ou pôr `{{json}}` |
| `domínio fora da allowlist` | allowlist preenchida sem esse host | aba **Modo e primitivas** |
| `rede privada bloqueada (host) — desligue "bloquear rede local" para permitir` | destino é LAN/loopback com `blockPrivate` | desligar só se for intencional |
| `destino bloqueado (host)` | metadados de nuvem/0.0.0.0 etc. | nunca é permitido, nem com opt-in |
| `o bot não pode dar um cargo com permissões que ele não tem` | `role_assign` escalaria privilégio | conceder o mesmo bit ao bot ou usar cargo menor |
| `membro \`x\` não encontrado neste servidor` | alvo errado | usar fingerprint ou `<@fp>` |
| `o dono do servidor não pode ser alvo de moderação` | tentou banir/kickar o dono | comportamento esperado |
| `informe o membro alvo` | comando admin sem alvo | mandar o membro |
| `uso: /poll <pergunta> \| <opção> \| <opção>` | enquete com menos de 2 opções | separar por `\|` |
| `o bot não faz nada: declare \`commands\` (prefixo+comando) ou \`events\`` | importou pasta sem conteúdo | adicionar comando ou evento |
| `bot.json grande demais (máx 256KB)` | manifesto enorme | reduzir |
| `bot.json precisa de um \`name\` com pelo menos 2 caracteres` | nome curto/vazio | corrigir no `bot.json` |
| `\`config\` do bot.json precisa ser um objeto` | `config` não é objeto | usar `{ ... }` |
| `arquivo de bot não encontrado/ilegível em <caminho>` | apontou arquivo/pasta errada | escolher a pasta com `bot.json` (ou o `.zip`) |
| `pasta do bot não existe: <caminho>` | caminho inválido | reselecionar a pasta |
| `o arquivo do bot precisa terminar em .zip` | informou outro tipo de arquivo | compactar em `.zip` ou apontar a pasta |
| `arquivo não é um ZIP (assinatura inválida)` | arquivo corrompido/renomeado | reempacotar |
| `caminho fora da pasta de importação: <nome>` | entrada `..` ou absoluta no `.zip` | reempacotar com caminhos relativos |
| `ZIP contém link simbólico, recusado: <nome>` | pacote com symlink | remover o link do pacote |
| `ZIP grande demais depois de extrair` / `arquivos demais` | passou dos tetos (32 MB / 1000) | enxugar o pacote |
| `programa \`node\` não encontrado na pasta do bot` | `run` aponta para fora da pasta | pôr o código dentro ou usar interpretador |
| `abra a ponte local do bot antes de iniciar o plugin` | plugin precisa da URL | aba **Ponte e plugin** → Abrir ponte |
| `{"error":"rota inexistente"}` (404) | URL sem o segredo ou rota errada | usar a URL que o app mostra |
| `{"error":"origem de navegador não é aceita pela ponte local"}` (403) | chamou do navegador (tem `Origin`) | chamar por programa |
| `{"error":"Host inválido"}` (421) | `Host` não é loopback | usar `127.0.0.1:porta` |
| `{"error":"limite de requisições por minuto","retry_after":60}` (429) | passou de 120 req/min | diminuir e esperar |
| `{"error":"ponte encerrada"}` (503) | a ponte fechou durante o long-poll | reabrir a ponte |
| `{"error":"mensagem vazia"}` / `mensagem acima de 1900 caracteres` | corpo inválido no POST | corrigir |
| evento duplicado no plugin | retry sem `Idempotency-Key` | mandar a mesma chave por 5 min |
| webhook responde 5xx | serviço do criador fora | o runtime tenta 2× e loga `warn`; sem fila |
| bot não responde com o app fechado | não há hospedagem | manter o app aberto no PC do dono |

---

## 7. O que o bot NÃO faz

Esta lista é honestidade de projeto, não falta de configuração.

| Recurso | Estado |
|---|---|
| Bot entrar em canal de voz/call, falar ou ter track própria | **não existe** — não há caminho de mídia no runtime |
| Música “remota” (bot tocando sem o dono na call) | **não existe**. O tipo **Música na call** funciona, mas o som sai pela conexão do **dono**, que precisa estar na chamada; sem call o bot avisa em vez de fingir |
| Mensagem direta (DM) por bot | **não existe** |
| Embed / cartão com campos | **não existe** |
| Botão, select, modal | **não existe** |
| Anexo de arquivo pelo bot | **não existe** |
| Módulo WASM (`runtime: "wasm"`) | **não existe** e é **recusado** na leitura |
| Marketplace / federação / registro oficial | **não existe** |
| `remote` com transporte de entrada | **não existe** — só o rótulo |
| SDK oficial (JS/Python/Rust) e CLI | **não existe** — a API é HTTP na ponte |
| Bot-a-bot (`invokeBot`) | **não existe** |
| Blob, vault, TTL no chave-valor, fila/cron | **não existem** |
| Editar mensagem em streaming | **não existe** |
| Replay de eventos | **não existe** — buffer em memória de 500 |
| OpenTelemetry/tracing, canary | **não existem** — só `bot_logs` |
| Responder com o app fechado | **não existe** — sem hospedagem |
| Ponte no Android | **não existe** — sem processo/servidor local |
| Sandbox de SO para o plugin | **não existe** — roda com as permissões do seu usuário |

Também não existe **evento próprio de menção**: `mention` é um campo de
`message_new`. Para reagir a menção use `events: ["message_new"]` e teste
`{{event.mention}}`.

O bot **não executa shell pela config** (a DSL é interpretada, sem `eval`), não
lê arquivo/câmera/microfone/tela/clipboard/banco, não roda no PC de outra pessoa
e não fala em nome de outra pessoa.

---

## 8. Permissões e ações administrativas

Bot nasce com **zero** permissão. Os sete bits:

| Bit | Libera |
|---|---|
| banir | `ban`, `unban` |
| silenciar | `mute`, `unmute`, `warn`, `warnings`, `warnings_clear` |
| apagar mensagens | `delete_msg` |
| gerenciar membros | `kick`, `role_assign`, `role_unassign` |
| montar o servidor | canal, cargo, nome/descrição/entrada pública, convite |
| limpar canais | `clear`, `lock`, `unlock`, `slowmode` |
| conteúdo e organização | `react`, `pin`, `unpin`, `thread_*`, `poll_create`, `emoji_*`, `typing` |

Consulta (`userinfo`, `serverinfo`, `ping`, `audit`, `bans`, `timeouts`,
`channels`, `roles`) não exige bit e não grava auditoria. Quem já tinha o bit
antigo “gerenciar” continua podendo estrutura e purga.

Ações que dependem de um canal (`thread_create`, `poll_create`, `typing`) usam o
canal onde a mensagem chegou. Na ponte, mande `channel` no corpo do `/v1/admin`.

O registro tem **44 ações** — `GET /v1/info` devolve a lista viva em `actions`.
Não invente nome: ação fora do registro devolve `ação inválida: <nome>`.

---

## 9. Ponte local e plugin (referência)

A ponte é o canal do bot com o servidor: **só loopback**, uma por bot, com
segredo no caminho (`/b/<64 hex>`), gerado a cada abertura. Fechar a ponte
invalida o segredo; sem ele a rota responde 404.

| Rota | O que faz |
|---|---|
| `GET /v1/info` | bot, servidor, canais, membros e `actions` |
| `GET /v1/events?since=&wait=` | long-poll (até 25 s, 50 eventos) |
| `GET /v1/config` | prefixo, comandos, eventos e canais do bot |
| `GET /v1/limits` | limites reais e as 20 primitivas (`implemented`) |
| `GET /v1/health` | estado, fila de eventos e contadores |
| `POST /v1/message` | publica como o bot |
| `POST /v1/admin` | pede uma ação do registro |
| `POST /v1/commands` | o bot troca a própria config (sem `perms`) |
| `POST /v1/log` | grava no console do bot |
| `POST /v1/stop` | encerra a ponte |

`Idempotency-Key` (até 128 chars, janela de 5 min) vale para POST e evita
duplicata em retry. Rate limit: **120 requisições/min** por balde. `Origin`
presente = 403; `Host` fora de loopback = 421.

O ambiente do plugin é limpo (`env_clear`): só `PATH` e as três variáveis
`DISTORRENT_*`. `cwd` é a pasta do bot; `stdin` é nulo; stdout/stderr aparecem
no console do painel.

---

## 10. Publicar o bot

Não existe marketplace, federação nem registro oficial. Publicar é:

1. subir a pasta (com `bot.json`) num repositório público — a pasta ou um `.zip`;
2. escrever um `README.md` com modo, comandos, permissões exigidas e variáveis;
3. quem for usar baixa e faz **Adicionar bot existente** (aponta a pasta ou o `.zip`).

Antes de publicar, **não** inclua token, segredo de webhook, `.env` ou dados de
servidor real. A importação recusa config sem `commands`, `events` nem `webhook`
(“o bot não faz nada”) e lê até 200 arquivos, profundidade 4, ignorando `.env`,
`node_modules`, `target`, `.git` e `dist`. `run` e `requires` são lidos mas
**não aplicados** na importação.

---

## 11. Arquivos que mandam e gates

| Arquivo | Papel |
|---|---|
| `distorrent-core/src/bots.rs` | parser, migração, DSL, guarda de URL |
| `distorrent-core/src/moderation.rs` | `BOT_ACTIONS`, bits e `perm_can_grant` |
| `distorrent-core/src/net/engine.rs` | `bot_create`, `bot_action_in`, `bot_replace_config` |
| `src-tauri/src/botbridge.rs` | rotas da ponte, rate limit, idempotência |
| `src-tauri/src/botzip.rs` | extração do `.zip` de importação (zip-slip, symlink, tetos) |
| `src-tauri/src/botplugin.rs` | execução do processo do plugin |
| `src/services/botCommands.ts` | modelo do editor, `permAllows`, `urlProblem` |
| `src/services/botEngine.ts` | runtime declarativo |
| `src/services/botWebhook.ts` | assinatura HMAC do webhook |
| `src/components/server/botDocs.ts` | documentação embutida no painel |
| `docs/bots.md` | referência técnica completa |

Gates antes de entregar:

```powershell
$env:PATH = "$env:TEMP\node24\node-v24.22.1-win-x64;$env:PATH"
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run typecheck
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run lint
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run test:unit
```

Suítes que cobrem bot: `botCommands`, `botRuntime`, `botSchemaV3`, `botWizard`,
`botsDocSync`, `botZipImport` (front) e `bots.rs`, `bots_exec.rs`, `botbridge.rs`,
`botzip.rs`, `botplugin.rs` (Rust).
