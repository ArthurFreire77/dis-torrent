export interface BotDocTopic {
  title: string
  lines: string[]
  tone?: 'info' | 'warn'
}

export type BotTemplate = 'vazio' | 'clima'

export interface BotTemplateDef {
  id: BotTemplate
  label: string
  desc: string
  config: string
}

export const BOT_CONFIG_MAX_KB = 64

const CLIMA_CONFIG = JSON.stringify(
  {
    prefix: '!',
    commands: [
      {
        name: 'clima',
        method: 'GET',
        url: 'https://api.open-meteo.com/v1/forecast?latitude={{arg0}}&longitude={{arg1}}&current=temperature_2m,wind_speed_10m',
        responsePath: 'current.temperature_2m',
        template: 'Agora faz {{value}} °C (vento {{json.current.wind_speed_10m}} km/h).',
      },
    ],
    channels: [],
  },
  null,
  2,
)

export const BOT_TEMPLATES: BotTemplateDef[] = [
  {
    id: 'vazio',
    label: 'Sem comandos ainda',
    desc: 'Cria o bot e o token. Você configura os comandos depois, no painel de Bots.',
    config: '',
  },
  {
    id: 'clima',
    label: 'Clima (pronto para usar)',
    desc: 'Responde "!clima -23.55 -46.63" (latitude e longitude) com a temperatura agora.',
    config: CLIMA_CONFIG,
  },
]

export function botTemplateConfig(id: BotTemplate): string {
  return BOT_TEMPLATES.find((t) => t.id === id)?.config ?? ''
}

export const BOT_DOCS: BotDocTopic[] = [
  {
    title: 'O que é um bot aqui',
    tone: 'info',
    lines: [
      'Um membro automatizado do servidor: tem nome, cargo, token e uma config JSON. Responde por prefixo (ex.: !clima) e pode reagir a 13 eventos.',
      'A resposta sai como mensagem no MESMO canal onde o comando foi digitado, assinada pelo servidor. O selo BOT na mensagem é só exibição.',
      'Opcionalmente o dono aponta uma pasta de código (com bot.json) e o app roda aquele programa como plugin, ligado pela ponte 127.0.0.1.',
    ],
  },
  {
    title: 'Quem faz o bot responder',
    tone: 'warn',
    lines: [
      'O runtime roda no aparelho do DONO do servidor. Com o app fechado no PC do dono, o bot não responde — não existe bot hospedado no DisTorrent.',
      'Só o dono vê e copia o token. Os outros membros veem o bot na lista, mas com o token mascarado.',
      'O bot ignora as mensagens do próprio dono e as que ele mesmo postou (é o que evita responder a si mesmo para sempre).',
    ],
  },
  {
    title: 'Token é senha',
    tone: 'warn',
    lines: [
      'Quem tem o token pode falar como o bot neste servidor. Não cole em canal, print ou webhook.',
      'Gerar outro token invalida o anterior na hora. Remover o bot derruba o acesso dele imediatamente.',
      'A ponte local NÃO usa token: o app injeta uma URL com caminho secreto no processo do plugin.',
    ],
  },
  {
    title: 'Configuração (JSON, até 64 KB)',
    lines: [
      'prefixo: 1 caractere de ! / . $ @ # % - (padrão "!").',
      'comandos: até 48 por padrão, cada um com exec = reply | http | script | admin, aliases, cooldownMs e permission.',
      'eventos: lista fechada de 13 nomes (mensagem, edição, exclusão, reação, membro, canal, chamada, voz).',
      'canais: lista de ids onde o bot atua. Vazio = todos os canais, inclusive os criados depois.',
      'channelKinds: lista de TIPOS onde ele atua — "text", "forum", "voice", "video". Vazio = todos os tipos.',
      'webhook: recebe POST com evento, autor, canal, texto e data. O token NUNCA vai no webhook.',
      'blockPrivate: bloqueia destino em rede privada (padrão ligado). maxRepliesPerMinute: 1 a 120.',
      'Exemplo de escopo: "channels": [] + "channelKinds": ["text"] = responde em todo canal de texto e em nenhum de voz.',
    ],
  },
  {
    title: 'Permissões administrativas',
    tone: 'warn',
    lines: [
      'O bot nasce SEM nenhuma permissão. Os bits são sete: banir, silenciar, apagar mensagens, gerenciar membros, montar o servidor, limpar canais e conteúdo e organização.',
      'Cada ação é conferida no core — a interface não é a barreira. O bot nunca se concede permissão.',
      '"Gerenciar membros": /kick, /role_assign e /role_unassign.',
      '"Montar o servidor": criar/renomear/excluir canal, mudar tópico e categoria, criar/excluir/editar cargo, renomear o servidor, mudar a descrição e a entrada pública, e gerar convite.',
      '"Limpar canais": /clear, /lock, /unlock e /slowmode; "apagar mensagens": /delete_msg.',
      '"Conteúdo e organização": /react, /pin, /thread_create, /poll_create, /emoji_add e /typing — não apaga nada de outro autor.',
      'Quem já tinha só o bit antigo "gerenciar" continua com tudo: a separação não tirou poder de bot configurado.',
      'O dono do servidor nunca é alvo, e toda ação que muda estado entra no audit log como bot:<ação>. Consulta (/userinfo, /audit, /channels) não grava nada.',
    ],
  },
  {
    title: 'Placeholders disponíveis',
    lines: [
      '{{args}} → todos os argumentos separados por "/". {{arg0}}, {{arg1}}… → um argumento.',
      '{{raw.args}} → argumentos crus, sem escape (só em corpo, nunca em URL).',
      '{{value}} → valor achado em responsePath. {{json}} → corpo inteiro da resposta.',
      '{{json.caminho.da.chave}} → um campo do JSON, inclusive lista (items[0].name).',
      'No script: {{author}}, {{bot}}, {{channel}}, {{event.campo}} e variáveis do próprio script.',
    ],
  },
  {
    title: 'O que o bot NÃO faz',
    tone: 'warn',
    lines: [
      'Pela config, não executa shell nem eval: a DSL é interpretada com instruções conhecidas.',
      'Não lê arquivo, câmera, microfone, tela, área de transferência nem banco.',
      'Não roda no PC de outra pessoa e não fala em nome de outra pessoa.',
      'Não tem retry de webhook: falha de rede é ignorada para não gerar fila de flood.',
      'No Android não há execução de código de bot (sem processo filho).',
    ],
  },
  {
    title: 'Por que um bot não vira vírus',
    tone: 'info',
    lines: [
      'Config é dado, não programa: o app interpreta JSON com campos conhecidos e descarta o resto. Não existe eval no caminho do bot.',
      'Só o dono executa os bots do próprio servidor; o core recusa mensagem de bot fora do dono e valida a assinatura de cada mensagem.',
      'A resposta é texto sanitizado: caracteres de controle, zero-width e bidi saem antes de virar mensagem, e o texto é cortado em 1900 caracteres.',
      'O plugin é a única execução de código, roda só por escolha explícita do dono, dentro da pasta importada. Não é sandbox de SO: só importe código confiável.',
    ],
  },
]

interface BotExample {
  title: string
  desc: string
  prefix: string
  name: string
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  body?: string
  responsePath?: string
  template: string
}

const EXAMPLES: BotExample[] = [
  {
    title: 'CEP → endereço (ViaCEP)',
    desc: 'Responde "!cep 01001000" com rua, cidade e estado. Só GET, nenhuma chave de API.',
    prefix: '!',
    name: 'cep',
    method: 'GET',
    url: 'https://viacep.com.br/ws/{{arg0}}/json/',
    responsePath: 'logradouro',
    template: '{{value}} — {{json.bairro}}, {{json.localidade}}/{{json.uf}}',
  },
  {
    title: 'Cotação do dólar',
    desc: 'Responde "!dolar" com o valor em reais da última atualização pública.',
    prefix: '!',
    name: 'dolar',
    method: 'GET',
    url: 'https://open.er-api.com/v6/latest/USD',
    responsePath: 'rates.BRL',
    template: '1 USD = R$ {{value}}',
  },
  {
    title: 'Recado para a SUA API (POST)',
    desc: 'Troque a URL por um endpoint seu. O token do bot não vai nesse POST — quem recebe vê só o texto.',
    prefix: '!',
    name: 'recado',
    method: 'POST',
    url: 'https://seu-servidor.exemplo/api/recado',
    headers: { 'content-type': 'application/json' },
    body: '{"texto":"{{raw.args}}"}',
    template: 'recado enviado',
  },
]

function exampleConfig(e: BotExample): string {
  const cmd: Record<string, unknown> = { name: e.name, method: e.method, url: e.url }
  if (e.headers) cmd.headers = e.headers
  if (e.body) cmd.body = e.body
  if (e.responsePath) cmd.responsePath = e.responsePath
  cmd.template = e.template
  return JSON.stringify({ prefix: e.prefix, commands: [cmd], channels: [] }, null, 2)
}

const FULL_CONFIG_EXAMPLE = JSON.stringify(
  {
    prefix: '!',
    commands: [
      {
        name: 'clima',
        method: 'GET',
        url: 'https://api.exemplo.com/clima?q={{arg0}}',
        headers: { accept: 'application/json' },
        responsePath: 'current.temp_c',
        template: 'Agora faz {{value}} °C em {{raw.args}}',
      },
      {
        name: 'recado',
        method: 'POST',
        url: 'https://api.exemplo.com/recado',
        headers: { 'content-type': 'application/json' },
        body: '{"de":"{{arg0}}","texto":"{{raw.args}}"}',
        template: 'recado enviado',
      },
    ],
    channels: [],
    webhook: { url: 'https://api.exemplo.com/hook' },
  },
  null,
  2,
)

const TICKS = '```'

function mdCode(lang: string, body: string): string[] {
  return [TICKS + lang, body, TICKS]
}

function mdTable(head: string[], rows: string[][]): string[] {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [line(head), line(head.map(() => '---')), ...rows.map(line)]
}

export const BOT_DOCS_FILE_NAME = 'distorrent-bots.md'

export function botDocsMarkdown(): string {
  const out: string[] = []

  out.push(
    '# Bots do DisTorrent — guia completo',
    '',
    'Gerado pelo próprio app (Configurações do servidor → Bots → **Baixar documentação (.md)**).',
    'Descreve **só o que o código faz hoje**. Onde algo não existe, está escrito que não existe.',
    '',
    'Este arquivo **não contém token** nem dado pessoal: pode ser copiado e repassado à vontade.',
    '',
    '## Resumo em 20 segundos',
    '',
    '- Bot = membro automatizado do servidor (nome, cargo, token e uma config JSON).',
    '- Quem faz o bot responder é o **app do dono do servidor, aberto**. Não existe bot hospedado.',
    '- O bot tem **quatro tipos de comando**: resposta fixa, HTTP, **script (DSL)** e **ação administrativa**.',
    `- A config é JSON, no máximo **${BOT_CONFIG_MAX_KB} KB**, e é salva pelo painel do servidor.`,
    '- O bot reage a mensagem **e a 13 eventos** (membro entrou/saiu, canal, reação, chamada, voz…).',
    '- Opcionalmente o dono roda o **código da pasta do bot como plugin** no PC dele, falando pela ponte `127.0.0.1` — **sem token**.',
    '',
    '## 1. O que é um bot aqui',
    '',
    'Um bot tem duas partes:',
    '',
    '- uma **linha** no banco do servidor: id, nome, discriminador, avatar, token, cargo,',
    '  `online`, `config` (JSON) e `perms` (permissões administrativas);',
    '- um **runtime** dentro do app do dono, que escuta eventos, roda comandos e posta;',
    '- um **autor de mensagem**: quando responde, a mensagem é assinada pelo dono e marcada',
    '  com `bot_id`, para a interface mostrar o nome/avatar do bot.',
    '',
    'O selo BOT é só exibição. A assinatura criptográfica continua sendo a do dono do servidor.',
    '',
    'Opcionalmente o dono aponta uma **pasta de código** (com `bot.json`) e o app executa',
    'aquele programa como processo filho, ligado ao servidor pela ponte local. Ver §16.',
    '',
    '## 2. Quem executa o bot (e quem não executa)',
    '',
    '| Quem | O que faz |',
    '| --- | --- |',
    '| **Dono do servidor** (o app dele) | Roda o runtime, chama as URLs e posta as respostas. |',
    '| **Core/motor P2P** | Guarda o bot, valida a mensagem (membro, canal, bot existente, `online`) e retransmite assinado. |',
    '| **Outros membros** | Só veem o bot na lista, com **token mascarado**. Não executam config de ninguém. |',
    '| **Servidor do DisTorrent** | Não existe. Nenhum bot roda em nuvem. |',
    '',
    'Consequências honestas:',
    '',
    '- **App fechado no PC do dono = bot mudo.** Não há fila nem retry.',
    '- Mensagem de bot vinda de um membro comum é **recusada** pelo core.',
    '- Bot `offline` no painel: o core devolve `bot está offline — ative-o no painel`.',
    '',
    '## 3. Criar e ligar um bot (passo a passo)',
    '',
    '1. Abra o servidor → menu do servidor → **Bots** (a entrada só aparece para o dono).',
    '2. **Criar bot**: nome (2 a 32 caracteres, sem barras), cargo opcional.',
    '3. O bot nasce **online**. Se desligar, ligue de novo no cartão dele antes de esperar resposta.',
    '4. Clique no ícone de engrenagem do bot → **Credenciais** → **Copiar token** (é a senha do bot).',
    '5. Aba **Comandos** → **Adicionar comando** → escolha o tipo:',
    '   - **Resposta fixa**: escreva a resposta (`{{raw.args}}` interpola os argumentos).',
    '   - **Chamar API (HTTP)**: URL, método e caminho da resposta.',
    '   - **Script (DSL)**: lógica de várias linhas, sem `eval` (ver §11).',
    '   - **Ação administrativa**: escolha `/ban`, `/kick`… e conceda o bit na aba **Permissões**.',
    '6. Aba **Eventos**: marque o que o bot deve receber e, se quiser, a URL do webhook.',
    '7. Aba **Permissões**: conceda só o necessário (o bot nasce **sem nenhuma**).',
    '8. **Salvar**. O bot só passa a responder depois de salvo e online.',
    '',
    '### Baixar esta documentação',
    '',
    'No painel de Bots, clique em **Baixar documentação (.md)**. O app gera o arquivo',
    `\`${BOT_DOCS_FILE_NAME}\` na hora, a partir desta mesma fonte, e entrega ao navegador/WebView.`,
    'Nada de binário no repositório: o texto é montado em memória e o link temporário é',
    'liberado logo depois do download. Para repassar a alguém, envie o `.md` — ele não tem',
    'token, então é seguro compartilhar.',
    '',
    '## 4. Formato da config (JSON, até ' + BOT_CONFIG_MAX_KB + ' KB)',
    '',
    'Este é o formato completo, com todos os campos que o parser entende:',
    '',
    ...mdCode('json', FULL_CONFIG_EXAMPLE),
    '',
    ...mdTable(
      ['Campo', 'Regra real'],
      [
        ['`prefix`', '**1 caractere** de `! / . $ @ # % -`. Ausente = `!`. Outro valor invalida a config.'],
        ['`commands[]`', 'Até **48**. `name` (minúsculo, sem acento, espaços viram hífen, até 32).'],
        ['`commands[].exec`', '`reply` | `http` | `script` | `admin`. Sem o campo, é inferido pelo que foi preenchido.'],
        ['`aliases`', 'Até **4** nomes extras; não podem repetir nome/alias de outro comando.'],
        ['`permission`', '`""` (todos) | `moderate` | `manage` | `owner`. O autor precisa ter o cargo.'],
        ['`cooldownMs`', '0 a 86.400.000 (24 h). Padrão **1.500**. É por autor.'],
        ['`enabled`', '`false` desliga só aquele comando (sem apagar).'],
        ['`method`', '`GET` ou `POST`. Qualquer outro valor cai em `GET`.'],
        ['`headers`', 'Até **16** pares; chave até 64 caracteres, valor até 1024.'],
        ['`body`', 'Só em POST; até **8192** caracteres. Aceita placeholders.'],
        ['`responsePath`', 'Caminho pontilhado no JSON da resposta (`data.temp`, `items[0].name`), até 128.'],
        ['`template`', 'Até **1900**. Sem `responsePath`, o padrão é `{{json}}`.'],
        ['`events[]`', 'Lista **fechada** (ver §11). Evento desconhecido é descartado.'],
        ['`channels`', 'Ids de canais onde o bot atua (até 256). **`[]` = todos**, inclusive os criados depois.'],
        ['`webhook.url`', 'http/https, até 2048. Recebe **todo** evento do escopo **e** toda mensagem.'],
        ['`blockPrivate`', 'Padrão `true`: bloqueia destino em rede privada/loopback.'],
        ['`maxRepliesPerMinute`', '1 a 120. Padrão **20**. Rate limit do runtime.'],
      ],
    ),
    '',
    `O limite de **${BOT_CONFIG_MAX_KB} KB** é aplicado duas vezes: no painel (antes de salvar) e no`,
    'core, que recusa `config` maior que isso. Config inválida não gera erro de rede: o parser',
    'descarta o campo/comando que não casa.',
    '',
    '## 5. Placeholders (só em `url`, `body` e `template`)',
    '',
    ...mdTable(
      ['Placeholder', 'Valor'],
      [
        ['`{{args}}`', 'Todos os argumentos separados por `/`, cada um URL-encoded'],
        ['`{{query}}`', 'Todos os argumentos separados por `+`, URL-encoded (bom para busca)'],
        ['`{{arg0}}`, `{{arg1}}`…', 'Argumento N, URL-encoded'],
        ['`{{raw.args}}`', 'Argumentos crus separados por espaço — **nunca use em URL**'],
        ['`{{value}}`', 'Valor extraído por `responsePath`'],
        ['`{{json}}`', 'Corpo inteiro da resposta'],
        ['`{{json.caminho.da.chave}}`', 'Caminho pontilhado do JSON, inclusive lista (`items[0].name`)'],
      ],
    ),
    '',
    '## 6. Como o texto vira comando',
    '',
    '- O prefixo precisa estar **no começo** do texto (depois de `trim`).',
    '- O nome vem **imediatamente** depois do prefixo, sem espaço: `!clima` e não `! clima`.',
    '- Até **16** argumentos separados por espaço.',
    '',
    '`!clima são paulo` → comando `clima`, argumentos `["são", "paulo"]`.',
    '',
    '## 7. Como a resposta vira mensagem',
    '',
    '1. O app chama a URL (timeout **10 s**; no desktop o teto do comando de rede é **15 s**).',
    '2. A resposta é lida até **256 KB**.',
    '3. Se `responsePath` existir e não resolver, o bot **não responde** (falha honesta, sem texto inventado).',
    '4. O `template` é renderizado, **sanitizado** (caracteres de controle, zero-width e bidi saem)',
    '   e cortado em **1900** caracteres antes de virar mensagem.',
    '5. O texto é postado no **mesmo canal** da mensagem.',
    '6. Com `online = false` o bot nem chega a chamar a URL. Se o canal não existir, o post falha',
    '   e **não há retry**.',
    '',
    '## 8. Modelos prontos',
    '',
  )

  for (const t of BOT_TEMPLATES) {
    out.push(`### ${t.label}`, '', t.desc, '')
    if (t.config) out.push(...mdCode('json', t.config), '')
    else out.push('Sem comandos: serve para criar o bot e configurar depois.', '')
  }

  out.push(
    '## 9. Exemplos prontos para copiar',
    '',
    'Cada exemplo diz o que preencher no painel (aba **Comandos**) e mostra o JSON equivalente,',
    'para quem for versionar a config ou montar o webhook.',
    '',
  )

  for (const e of EXAMPLES) {
    out.push(
      `### ${e.title}`,
      '',
      e.desc,
      '',
      `- Nome: \`${e.name}\``,
      `- Método: \`${e.method}\``,
      `- URL: \`${e.url}\``,
    )
    if (e.headers) out.push(`- Cabeçalhos: \`${JSON.stringify(e.headers)}\``)
    if (e.body) out.push(`- Corpo: \`${e.body}\``)
    if (e.responsePath) out.push(`- Caminho da resposta: \`${e.responsePath}\``)
    out.push(`- Template: \`${e.template}\``, '', ...mdCode('json', exampleConfig(e)), '')
  }

  out.push(
    '## 10. Webhook de saída',
    '',
    'Se `webhook.url` estiver preenchida, **toda** mensagem do escopo vira um POST:',
    '',
    ...mdCode(
      'http',
      [
        'POST <webhook.url>',
        'content-type: application/json',
        '',
        '{',
        '  "author": "<fingerprint de quem escreveu>",',
        '  "nickname": "<mesmo fingerprint — o runtime não tem apelido aqui>",',
        '  "channel": "<id do canal>",',
        '  "body": "<texto da mensagem>",',
        '  "ts": 1760000000000',
        '}',
      ].join('\n'),
    ),
    '',
    '- O **token do bot não vai** no webhook.',
    '- Só URL `http/https` é aceita; outra coisa e o webhook é simplesmente descartado.',
    '- Falha de rede é ignorada (`best-effort`), sem retry e sem fila.',
    '- Aponte para um endpoint **seu**: o autor é identificado pelo fingerprint.',
    '',
    '## 9.1. Onde o bot atua (canais e tipos)',
    '',
    'Duas listas independentes controlam o alcance. **Vazio em cada uma = todos.**',
    '',
    ...mdTable(
      ['Campo', 'O que limita'],
      [
        [
          '`channels`',
          'Ids de canal. Só estes recebem comando e evento. Use o id, não o nome.',
        ],
        [
          '`channelKinds`',
          'Tipos: `text`, `forum`, `voice`, `video`. Ex.: `["text"]` ignora os canais de voz.',
        ],
      ],
    ),
    '',
    'As duas se somam (E lógico): para o bot responder num canal, ele precisa estar na lista',
    '`channels` (ou a lista estar vazia) **e** o tipo do canal precisa estar em `channelKinds`',
    '(ou essa lista estar vazia).',
    '',
    '```json',
    '{',
    '  "prefix": "!",',
    '  "channelKinds": ["text"],',
    '  "channels": [],',
    '  "commands": [{ "name": "ping", "exec": "reply", "reply": "pong" }]',
    '}',
    '```',
    '',
    'Esse bot responde `!ping` em **todo** canal de texto e em **nenhum** canal de voz, vídeo',
    'ou fórum — inclusive nos canais que ainda não existem.',
    '',
    'O que cada tipo permite hoje:',
    '',
    ...mdTable(
      ['Tipo', 'Comandos de texto', 'Eventos', 'Mídia'],
      [
        ['`text`', 'sim', 'sim', 'não'],
        ['`forum`', 'sim', 'sim', 'não'],
        ['`voice`', 'não', 'sim (`voice_joined`/`voice_left`)', 'não'],
        ['`video`', 'não', 'sim', 'não'],
      ],
    ),
    '',
    '> **Honestidade:** o bot **não entra na call**, não fala e não toca som. Eventos de voz',
    '> só avisam quem entrou e quem saiu — não há rota de áudio na API.',
    '',
    '## 11. Gatilhos que existem hoje',
    '',
    'O runtime assina os eventos do app. Ele trata comandos em `message_new` (mensagem',
    '**recebida de outra pessoa**) e entrega estes eventos, quando marcados na aba **Eventos**:',
    '',
    ...mdTable(
      ['Evento', 'Quando dispara'],
      [
        ['`message_new`', 'mensagem recebida (direção `in`, sem `bot_id`)'],
        ['`message_edited`', 'o corpo da mensagem mudou'],
        ['`message_deleted`', 'a mensagem foi apagada'],
        ['`mention`', 'a mensagem menciona o nome/id do bot'],
        ['`reaction`', 'alguém reagiu a uma mensagem'],
        ['`member_joined`', 'convite aceito ou entrada em servidor público'],
        ['`member_left`', 'saiu, foi expulso ou banido'],
        ['`channel_created` / `channel_deleted`', 'canal criado/removido'],
        ['`call_started` / `call_ended`', 'sala de chamada abriu/fechou'],
        ['`voice_joined` / `voice_left`', 'entrou/saiu de canal de voz'],
      ],
    ),
    '',
    'Para reagir a um evento **com script**, crie um comando com o **nome igual ao evento**',
    'e `exec: "script"`. Exemplo para dar boas-vindas:',
    '',
    ...mdCode(
      'json',
      JSON.stringify(
        {
          prefix: '!',
          events: ['member_joined'],
          commands: [
            {
              name: 'member_joined',
              exec: 'script',
              script: 'reply "bem-vindo, {{event.nickname}}!"',
            },
          ],
        },
        null,
        2,
      ),
    ),
    '',
    'O que ele **não** faz:',
    '',
    '- mensagens do próprio dono (`direction = "out"`) — evita loop;',
    '- mensagens do próprio bot (`bot_id` preenchido);',
    '- thread, presença, cargo criado, emoji, enquete.',
    '',
    'Se você precisa de outro gatilho, ele não existe — não é configurável por JSON. A saída',
    'honesta hoje é o webhook de saída + um serviço seu.',
    '',
    '## 12. O que um bot NÃO pode fazer',
    '',
    '- **Não executa shell/comando do sistema pela config.** A DSL é interpretada, sem `eval`.',
    '  Um programa externo só roda se o dono importar uma pasta e clicar em **Iniciar plugin**.',
    '- **Não instala, baixa ou abre arquivo.** Não existe API de disco no runtime.',
    '- **Não lê arquivo, câmera, microfone, tela, área de transferência ou banco.**',
    '- **Não roda no PC de outra pessoa.** Só o dono executa os bots do próprio servidor.',
    '- **Não fala em nome de outra pessoa.** O post é assinado pela chave do dono e o core',
    '  recusa mensagem de bot vinda de quem não é o host.',
    '- **Não cria bot, não muda `perms` e não age além do que recebeu.** Cada ação',
    '  administrativa é conferida no core; nem o próprio bot consegue se conceder permissão.',
    '- **Não escapa de http/https.** `file://`, `ftp://` e host vazio são recusados, tanto na',
    '  URL do comando quanto na do webhook.',
    '- **Não responde sozinho para sempre.** Ignora as próprias mensagens e as do dono.',
    '- **Não recebe nem envia o token** pelo webhook; membros comuns veem o token mascarado.',
    '- **Não chama nem um endereço quando está desligado.** `online = false` corta o bot antes',
    '  de qualquer requisição — não só o post.',
    `- **Não passa dos limites:** ${BOT_CONFIG_MAX_KB} KB de config, 48 comandos, 1900 caracteres de resposta,`,
    '  20 respostas/min por padrão.',
    '',
    '## 13. Por que um bot não vira vírus',
    '',
    'Isto não é promessa de marketing: são as barreiras que o código aplica hoje.',
    '',
    '1. **Config é dado, não código.** O app interpreta JSON com campos conhecidos',
    '   (`parseBotConfig`) e descarta o que não casa. Não existe `eval`, não existe script.',
    '2. **Nenhum processo do SO.** O caminho do bot não cria processo: o core não tem',
    '   `Command::new` em lugar nenhum, e o runtime no app só chama dois comandos de rede',
    '   (buscar URL e postar mensagem).',
    '3. **Tamanho limitado.** Config acima de ' + BOT_CONFIG_MAX_KB + ' KB é recusada pelo painel **e**',
    '   pelo core; mensagem do core tem teto de 64 KB; resposta é cortada em 1900 caracteres.',
    '4. **Só dois esquemas.** A URL (do comando **e** do webhook) precisa começar com `http://` ou',
    '   `https://`. O comando de rede do desktop recusa outro esquema e host vazio, limita a 16',
    '   cabeçalhos e 256 KB de resposta, e tem timeout.',
    '5. **Saída é texto sanitizado.** A resposta passa por `sanitizeText` (remove caracteres de',
    '   controle, zero-width e bidi) e a interface renderiza como **texto** — não há HTML',
    '   injetado; só links `http/https/mailto` viram link, com `rel="noopener noreferrer"`.',
    '6. **Assinatura, não confiança.** Cada mensagem é um envelope assinado pela chave do dono;',
    '   o destinatário rejeita assinatura inválida e `author_fp` diferente do peer da conexão.',
    '7. **Só o dono executa.** O runtime filtra comunidades onde `owner_fp` é o seu fingerprint.',
    '   Entrar num servidor não faz o app rodar a config do bot de outra pessoa.',
    '8. **Bot desligado não posta e não chama rede.** Com `online = false` o bot é ignorado antes',
    '   de qualquer HTTP; o core também recusa `bot_post_message` nesse estado.',
    '',
    '### O que um bot malicioso AINDA pode fazer (leia antes de copiar config de alguém)',
    '',
    'O bot não é vírus, mas **config é escolha de quem instala**. Um JSON mal-intencionado pode:',
    '',
    '- fazer o **seu** app chamar uma URL arbitrária (inclusive da sua rede local) — por isso',
    '  revise as URLs antes de salvar e não cole config de desconhecido;',
    '- postar mensagens em excesso no canal enquanto estiver online (desligue/remova o bot);',
    '- publicar um link malicioso como texto (não vira execução; quem clicar sai do app).',
    '',
    'Regra prática: **trate a config de um bot como você trata um script que pediu para rodar.**',
    'Leia a URL, o corpo e o template. O token é a senha do bot: não compartilhe.',
    '',
    '## 14. Solução de problemas',
    '',
    ...mdTable(
      ['Sintoma', 'Causa real', 'O que fazer'],
      [
        ['"bot está offline — ative-o no painel"', '`online = false` na linha do bot', 'ligar o bot no cartão dele'],
        ['comando não responde', 'prefixo errado, canal fora de `channels`, bot sem `config`', 'conferir os três e salvar de novo'],
        ['resposta vazia', '`responsePath` não existe no JSON da API', 'testar o endpoint na aba **Comandos**'],
        ['webhook não chega', 'URL inválida/não http(s) ou serviço fora', 'o runtime ignora a falha, sem retry'],
        ['bot não responde com o app fechado', 'não há hospedagem de bots', 'manter o app aberto no PC do dono'],
        ['outro membro não vê o token', 'token é do dono', 'comportamento esperado'],
      ],
    ),
    '',
    '## 15. Script (DSL) — sem `eval`',
    '',
    'Uma instrução por linha. O interpretador só conhece estas instruções, então código do',
    'usuário não tem acesso a `window`, `process`, `require` nem ao banco.',
    '',
    ...mdTable(
      ['Instrução', 'Efeito'],
      [
        ['`reply "texto"`', 'posta no canal (até 8 por execução)'],
        ['`ephemeral "texto"`', 'posta como resposta discreta'],
        ['`let x = valor`', 'variável da execução'],
        ['`getvar x = chave`', 'lê variável persistente do bot (banco)'],
        ['`setvar chave = valor`', 'grava variável persistente'],
        ['`incvar chave + 5`', 'soma na variável persistente'],
        ['`http get "url" as res`', 'GET; corpo em `res`, status em `res.status`, campos em `res.campo`'],
        ['`http post "url" body "..." as res`', 'POST'],
        ['`if <cond>` / `else` / `end`', 'desvio'],
        ['`admin <ação> ...`', 'pede ação administrativa ao core (qualquer uma do registro)'],
        ['`stop`', 'encerra o script'],
      ],
    ),
    '',
    'Condições: `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `startswith`,',
    '`is empty`, `is not empty`. Limites: **200 linhas**, 8 mensagens, 2000 passos.',
    '',
    'Placeholders no script: `{{raw.args}}` `{{args}}` `{{arg0}}` `{{author}}` `{{bot}}`',
    '`{{channel}}` `{{event.campo}}` e o nome de qualquer variável do próprio script.',
    'Para agir sobre a mensagem que disparou o comando, use `{{event.message_id}}`;',
    '`{{event.channel}}` é o canal onde ela chegou.',
    '',
    '## 16. Ações administrativas (conferidas no core)',
    '',
    'O bot **nasce sem nenhuma** permissão. Cada ação exige um bit concedido na aba',
    '**Permissões**; a checagem final é do core, não da interface. O **dono do servidor',
    'nunca é alvo**, e toda ação que muda estado entra no `audit_log` como `bot:<ação>`.',
    'Consulta (`userinfo`, `serverinfo`, `ping`, `audit`, `bans`, `timeouts`, `channels`,',
    '`roles`) não exige permissão e não suja a auditoria.',
    '',
    'Os sete bits: **banir**, **silenciar**, **apagar mensagens**, **gerenciar membros**,',
    '**montar o servidor**, **limpar canais** e **conteúdo e organização**. "Conceder',
    'todas" liga os sete de uma vez. Quem já tinha o bit antigo "gerenciar" (que liberava',
    'separação não tirou poder de bot que já estava configurado.',
    '',
    ...mdTable(
      ['Ação', 'Permissão', 'Argumentos'],
      [
        ['`ban` / `unban`', 'banir', '`<membro> [motivo]`'],
        ['`kick`', 'gerenciar membros', '`<membro> [motivo]`'],
        ['`mute` / `unmute`', 'silenciar', '`<membro> [minutos] [motivo]`'],
        ['`warn` / `warnings`', 'silenciar', '`<membro> [motivo]`'],
        ['`warnings_clear`', 'silenciar', '`<membro>`'],
        ['`delete_msg`', 'apagar mensagens', '`<id-da-mensagem>`'],
        ['`clear`', 'limpar canais', '`[#canal] [N]`'],
        ['`lock` / `unlock`', 'limpar canais', '`[#canal]`'],
        ['`slowmode`', 'limpar canais', '`[#canal] [segundos]`'],
        ['`channel_create`', 'montar o servidor', '`<nome> [text|voice|video|forum]`'],
        ['`channel_edit`', 'montar o servidor', '`<canal> <novo-nome>`'],
        ['`channel_delete`', 'montar o servidor', '`[#canal]`'],
        ['`channel_topic`', 'montar o servidor', '`<canal> <tópico>`'],
        ['`channel_category`', 'montar o servidor', '`<canal> <categoria>`'],
        ['`role_create`', 'montar o servidor', '`<nome> [#RRGGBB]`'],
        ['`role_delete`', 'montar o servidor', '`<cargo>`'],
        ['`role_edit`', 'montar o servidor', '`<cargo> [novo-nome] [#RRGGBB]`'],
        ['`role_assign` / `role_unassign`', 'gerenciar membros', '`<cargo> <membro>`'],
        ['`server_edit`', 'montar o servidor', '`<novo-nome>`'],
        ['`server_meta`', 'montar o servidor', '`[descrição]`'],
        ['`server_public`', 'montar o servidor', '`<on|off>`'],
        ['`make_invite`', 'montar o servidor', '`[horas] [fp-alvo]`'],
        ['`react`', 'conteúdo e organização', '`<id-da-mensagem> <emoji>`'],
        ['`pin` / `unpin`', 'conteúdo e organização', '`<id-da-mensagem>`'],
        ['`thread_create`', 'conteúdo e organização', '`<nome> [tags]`'],
        ['`thread_archive`', 'conteúdo e organização', '`<id-da-thread> [on|off]`'],
        ['`poll_create`', 'conteúdo e organização', '`<pergunta> | <opção> | <opção>`'],
        ['`emoji_add` / `emoji_del`', 'conteúdo e organização', '`<nome> <emoji>` / `<nome>`'],
        ['`typing`', 'conteúdo e organização', '—'],
        ['`userinfo` / `serverinfo` / `ping`', '—', '`<membro>` / — / —'],
        ['`audit` / `bans` / `timeouts`', '—', '`[N]` / — / —'],
        ['`channels` / `roles`', '—', '—'],
      ],
    ),
    '',
    'O alvo aceita **fingerprint**, **apelido** ou menção `<@fp>`. As ações que precisam',
    'de um canal (`thread_create`, `poll_create`, `typing`) usam o canal onde a mensagem',
    'chegou; na ponte, mande `channel` no corpo do `/v1/admin` para escolher outro.',
    '',
    '### Exemplo: bot que monta o servidor inteiro',
    '',
    ...mdCode(
      'json',
      JSON.stringify(
        {
          name: 'SetupBot',
          config: {
            prefix: '!',
            commands: [
              {
                name: 'montar',
                exec: 'script',
                permission: 'owner',
                script:
                  'admin channel_create regras text\nadmin channel_create avisos text\nadmin channel_create geral text\nadmin channel_create voz voice\nadmin role_create Membro #57f287\nadmin role_create Moderador #ed4245\nreply "servidor montado"',
              },
            ],
          },
        },
        null,
        2,
      ),
    ),
    '',
    'Com a permissão **montar o servidor** concedida, esse único `!montar` cria canais e',
    'cargos de verdade.',
    '',
    '## 17. Ponte local e código do bot (plugin)',
    '',
    'O dono pode apontar uma **pasta de código** (com `bot.json`) e o app executa aquele',
    'programa como processo filho, ligado ao servidor por uma ponte em `127.0.0.1`.',
    '',
    '**Não existe token.** O app gera um **caminho secreto** (`/b/<32 hex>`) a cada abertura e',
    'entrega a URL pronta ao processo em `DISTORRENT_BOT_URL`. Fechar a ponte invalida o',
    'segredo. A ponte recusa `Origin` de navegador, exige `Host` de loopback e limita a',
    '120 requisições/minuto.',
    '',
    ...mdTable(
      ['Rota', 'O que faz'],
      [
        ['`GET /v1/info`', 'bot, servidor, canais e membros'],
        ['`GET /v1/events?since=&wait=`', 'long-poll (até 25 s) dos eventos'],
        ['`GET /v1/config`', 'config atual **deste** bot'],
        ['`POST /v1/message`', '`{"channel":"geral","body":"texto"}`'],
        ['`POST /v1/admin`', '`{"action":"ban","target":"fp","reason":"","number":null}`'],
        ['`POST /v1/commands`', 'o bot troca a **própria** config (sem poder mudar `perms`)'],
        ['`POST /v1/log`', '`{"level":"info","message":"..."}`'],
        ['`POST /v1/stop`', 'encerra a ponte'],
      ],
    ),
    '',
    '`bot.js` mínimo:',
    '',
    ...mdCode(
      'js',
      [
        'const url = process.env.DISTORRENT_BOT_URL // já autenticada',
        '',
        'const post = (channel, body) =>',
        "  fetch(`${url}/v1/message`, {",
        "    method: 'POST',",
        "    headers: { 'content-type': 'application/json' },",
        '    body: JSON.stringify({ channel, body }),',
        '  })',
        '',
        'let since = 0',
        'for (;;) {',
        '  const { events } = await (await fetch(`${url}/v1/events?since=${since}&wait=20000`)).json()',
        '  for (const e of events ?? []) {',
        '    since = e.seq',
        "    if (e.event === 'message_new' && e.data.body === '!ping') {",
        "      await post(e.data.conv_id, 'pong')",
        '    }',
        '  }',
        '}',
      ].join('\n'),
    ),
    '',
    'Limites honestos do plugin: roda **só no PC do dono**; no Android não há execução de',
    'processo; o programa precisa estar **dentro da pasta** importada e roda com as',
    'permissões do seu usuário — **não é sandbox de sistema operacional**. Só importe código',
    'em que você confia.',
    '',
    '## 18. Referência rápida (os mesmos tópicos do painel)',
    '',
    'As seções abaixo são exatamente as do acordeão "Como o bot funciona" no app, para que este',
    'arquivo e o painel não contem histórias diferentes.',
    '',
  )

  for (const doc of BOT_DOCS) {
    out.push(`### ${doc.title}`, '')
    for (const line of doc.lines) out.push(`- ${line}`)
    out.push('')
  }

  out.push(
    '---',
    '',
    'Documento gerado pelo DisTorrent. Se algo aqui não bater com o app, o comportamento do',
    'app é a verdade — e vale abrir um relato.',
    '',
  )

  return out.join('\n')
}
