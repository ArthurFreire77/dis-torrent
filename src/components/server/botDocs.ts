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

export const BOT_CONFIG_MAX_KB = 16

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
      'Um membro automatizado do servidor: tem nome, cargo e um token. Ele responde comandos por prefixo (ex.: !clima) e pode avisar um endereço seu a cada mensagem.',
      'A resposta sai como mensagem no MESMO canal onde o comando foi digitado, assinada pelo servidor. O selo BOT na mensagem é só exibição.',
    ],
  },
  {
    title: 'Quem faz o bot responder',
    tone: 'warn',
    lines: [
      'O runtime roda no aparelho do DONO do servidor. Com o app fechado no PC do dono, o bot não responde — não existe bot hospedado no DisTorrent.',
      'Só o dono vê e copia o token. Os outros membros veem o bot na lista, mas com o token mascarado.',
      'O bot só responde mensagens RECEBIDAS de outras pessoas: ele ignora as do próprio dono e as que ele mesmo postou (é o que evita responder a si mesmo para sempre).',
    ],
  },
  {
    title: 'Token é senha',
    tone: 'warn',
    lines: [
      'Quem tem o token pode falar como o bot neste servidor. Não cole em canal, print ou webhook.',
      'Gerar outro token invalida o anterior na hora. Remover o bot derruba o acesso dele imediatamente.',
    ],
  },
  {
    title: 'Configuração (JSON, até 16 KB)',
    lines: [
      'prefixo: 1 caractere de ! / . $ @ # % - (padrão "!").',
      'comandos: até 16. Cada um tem nome, URL http/https, método GET ou POST, cabeçalhos opcionais, corpo opcional (só POST) e um template de resposta.',
      'canais: lista de ids onde o bot atua. Vazio = todos os canais, inclusive os criados depois.',
      'webhook: recebe POST com autor, canal, texto e data a cada mensagem do escopo. O token NUNCA vai no webhook.',
    ],
  },
  {
    title: 'Placeholders disponíveis',
    lines: [
      '{{args}} → todos os argumentos separados por "/". {{arg0}}, {{arg1}}… → um argumento.',
      '{{raw.args}} → argumentos crus, sem escape (só em corpo, nunca em URL).',
      '{{value}} → valor achado em responsePath. {{json}} → corpo inteiro da resposta.',
      '{{json.caminho.da.chave}} → um campo do JSON, inclusive lista (items[0].name).',
    ],
  },
  {
    title: 'O que o bot NÃO faz',
    tone: 'warn',
    lines: [
      'Não reage a criar canal, entrar/sair, reação ou chamada: o runtime só escuta mensagem recebida.',
      'Não executa código local nem comando de shell. Ele só faz HTTP GET/POST.',
      'Não tem retry de webhook: falha de rede é ignorada para não gerar fila de flood.',
    ],
  },
  {
    title: 'Por que um bot não vira vírus',
    tone: 'info',
    lines: [
      'Config é dado, não programa: o app só interpreta JSON com campos conhecidos e descarta o resto. Não existe shell, processo nem download de binário no caminho do bot.',
      'Só o dono executa os bots do próprio servidor; um membro comum não roda config de ninguém. O core recusa mensagem de bot fora do dono e valida a assinatura de cada mensagem.',
      'A resposta é texto sanitizado: caracteres de controle, zero-width e bidi saem antes de virar mensagem, e o texto é cortado em 1900 caracteres. Um bot malicioso ainda pode apontar uma URL ruim — quem instala precisa ler o que aprova.',
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
    '- O bot **não executa código**: ele lê mensagens, faz HTTP GET/POST e posta **texto**.',
    `- A config é JSON, no máximo **${BOT_CONFIG_MAX_KB} KB**, e é salva pelo painel do servidor.`,
    '- O bot só responde mensagens **recebidas de outras pessoas**, no mesmo canal.',
    '',
    '## 1. O que é um bot aqui',
    '',
    'Um bot não é um processo separado nem um programa que roda no seu PC. Ele é:',
    '',
    '- uma **linha** no banco do servidor: id, nome, discriminador, avatar, token, cargo,',
    '  `online` e `config` (JSON);',
    '- um **runtime** dentro do app do dono, que escuta mensagens e dispara HTTP;',
    '- um **autor de mensagem**: quando responde, a mensagem é assinada pelo dono e marcada',
    '  com `bot_id`, para a interface mostrar o nome/avatar do bot.',
    '',
    'O selo BOT é só exibição. A assinatura criptográfica continua sendo a do dono do servidor.',
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
    '5. Aba **Comandos** → **Adicionar** → preencha nome, método, URL, `responsePath` e template.',
    '   Use **Testar** para ver a resposta da API antes de salvar.',
    '6. Aba **Escopos e webhook** → marque os canais (vazio = todos) e, se quiser, a URL do webhook.',
    '7. **Salvar**. O bot só passa a responder depois de salvo e online.',
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
        ['`commands[]`', 'Até **16**. `name` (minúsculo, espaços viram hífen, até 32) e `url` **http/https** são obrigatórios.'],
        ['`method`', '`GET` ou `POST`. Qualquer outro valor cai em `GET`.'],
        ['`headers`', 'Até **16** pares; chave com menos de 64 caracteres, valor até 512.'],
        ['`body`', 'Só em POST; até **2048** caracteres. Aceita placeholders.'],
        ['`responsePath`', 'Caminho pontilhado no JSON da resposta (`data.temp`, `items[0].name`), até 128.'],
        ['`template`', 'Até **512**. Sem `responsePath`, o padrão é `{{json}}`.'],
        ['`channels`', 'Ids de canais onde o bot atua (até 64). **`[]` = todos**, inclusive os criados depois.'],
        ['`webhook.url`', 'http/https, até 512 (fora disso é descartado). Recebe **toda** mensagem do escopo, com ou sem comando.'],
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
    '## 11. Gatilhos que existem hoje',
    '',
    'O runtime assina os eventos do app e trata **um**: `message_new` com `direction = "in"` e',
    '`bot_id` vazio. Ou seja, ele reage a mensagens **recebidas de outras pessoas**.',
    '',
    'Ele **não** reage a:',
    '',
    '- mensagens do próprio dono (`direction = "out"`) — evita loop de bot respondendo a si mesmo;',
    '- mensagens do próprio bot (`bot_id` preenchido);',
    '- criar/apagar canal, cargo ou membro, reação, chamada, thread, presença;',
    '- menções fora de uma mensagem.',
    '',
    'Se você precisa de outro gatilho, ele não existe — não é configurável por JSON. A saída',
    'honesta hoje é o webhook de saída + um serviço seu.',
    '',
    '## 12. O que um bot NÃO pode fazer',
    '',
    '- **Não executa shell, comando do sistema ou programa.** O caminho do bot não tem criação',
    '  de processo; o core não abre processo para bot nenhum.',
    '- **Não instala, baixa ou abre arquivo.** Não existe API de disco no runtime.',
    '- **Não lê arquivo, câmera, microfone, tela, área de transferência ou banco.**',
    '- **Não roda no PC de outra pessoa.** Só o dono executa os bots do próprio servidor.',
    '- **Não fala em nome de outra pessoa.** O post é assinado pela chave do dono e o core',
    '  recusa mensagem de bot vinda de quem não é o host.',
    '- **Não cria bot, não muda cargo e não apaga canal.** Essas operações exigem ser dono.',
    '- **Não escapa de http/https.** `file://`, `ftp://` e host vazio são recusados, tanto na',
    '  URL do comando quanto na do webhook.',
    '- **Não responde sozinho para sempre.** Ignora as próprias mensagens e as do dono.',
    '- **Não recebe nem envia o token** pelo webhook; membros comuns veem o token mascarado.',
    '- **Não chama nem um endereço quando está desligado.** `online = false` corta o bot antes',
    '  de qualquer requisição — não só o post.',
    `- **Não passa dos limites:** ${BOT_CONFIG_MAX_KB} KB de config, 16 comandos, 1900 caracteres de resposta.`,
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
    '## 15. Referência rápida (os mesmos tópicos do painel)',
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
