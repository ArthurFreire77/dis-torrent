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
      'Bot pronto se importa em **Adicionar bot existente** com um clique: escolha o `.zip` (ou a pasta) e o app extrai, valida e cria o bot. A extração vai para uma pasta privada do app, sem escrever fora dela.',
    ],
  },
  {
    title: 'Primeiros 2 minutos (sem código)',
    tone: 'info',
    lines: [
      '1) Criar bot → nome de 2 a 32 caracteres. Ele nasce online, mas ainda sem comando.',
      '2) Configurar → aba Comandos → Adicionar comando → "Resposta fixa" → nome "ping", resposta "pong" → Salvar.',
      '3) Mande !ping num canal de texto. Se não responder, abra a aba Console: o motivo aparece lá.',
      'Para consultar uma API, repita com o tipo "Chamar API (HTTP)"; o botão Testar executa sem postar no canal.',
    ],
  },
  {
    title: 'Quem faz o bot responder',
    tone: 'warn',
    lines: [
      'O runtime roda no aparelho do DONO do servidor. Com o app fechado no PC do dono, o bot não responde — não existe bot hospedado no DisTorrent.',
      'Só o dono vê e copia o token. Os outros membros veem o bot na lista, mas com o token mascarado.',
      'O bot ignora as mensagens do próprio dono e as que ele mesmo postou (é o que evita responder a si mesmo para sempre).',
      'Android recebe as mensagens do bot pelo servidor, mas não executa plugin nem abre a ponte local.',
    ],
  },
  {
    title: 'Token é senha',
    tone: 'warn',
    lines: [
      'Quem tem o token pode falar como o bot neste servidor. Não cole em canal, print ou webhook.',
      'Gerar outro token invalida o anterior na hora. Remover o bot derruba o acesso dele imediatamente.',
      'A ponte local NÃO usa token: o app injeta uma URL com caminho secreto no processo do plugin.',
      'A chave de uma API de IA, se você colocar nos headers do comando, fica na config do bot e é sincronizada para os membros: use uma chave restrita e troque se vazar.',
    ],
  },
  {
    title: 'Chamar uma API ou IA sem errar',
    tone: 'info',
    lines: [
      'Tipo "Chamar API (HTTP)": escolha método, URL, caminho da resposta e template.',
      'POST precisa de corpo: use {{jsonargs}} para a pergunta do usuário — ela vai escapada e não quebra o JSON. {{raw.args}} é cru, só para texto.',
      'Headers: um por linha, no formato "Authorization: Bearer SUA-CHAVE". Até 16 pares.',
      'Timeout vazio = 10 s; teto de 90 s. IA precisa de 60 s.',
      'Antes de salvar, use "Testar com argumentos" + Testar. Ele mostra status, tempo e o texto, ou o erro exato (401, 404, allowlist, rede privada).',
      'Se o Testar disser que não achou texto, o responsePath está errado: confira o campo no JSON de resposta.',
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
      'runtime "wasm" não existe nesta versão: a config é recusada na leitura. Use "none" ou "process".',
      'Exemplo de escopo: "channels": [] + "channelKinds": ["text"] = responde em todo canal de texto e em nenhum de voz.',
    ],
  },
  {
    title: 'Erros comuns (o texto exato)',
    tone: 'warn',
    lines: [
      '"bot está offline — ative-o no painel": o bot está desligado no cartão. Ligue.',
      '"resposta vazia (responsePath/template)": o caminho não existe no JSON. Ajuste o responsePath ou use {{json}}.',
      '"domínio fora da allowlist": a allowlist está preenchida sem esse host. Ajuste em Modo e primitivas.',
      '"rede privada bloqueada (host) — desligue \\"bloquear rede local\\" para permitir": destino é LAN/loopback e blockPrivate está ligado.',
      '"prefixo precisa ser 1 caractere de ! / . $ @ # % -": o prefixo tem mais de um caractere ou está fora da lista.',
      '"runtime `wasm` ainda não existe nesta versão — use `process` (plugin) ou `declarative`": troque o runtime.',
      '"config de bot muito grande (máx 64 KB)": encurte scripts e templates.',
      '"o bot não tem permissão para `ban` — conceda no painel de Bots": falta o bit na aba Permissões.',
      '"o dono do servidor não pode ser alvo de moderação": comportamento esperado.',
      'Ponte: 404 = URL sem segredo; 403 = chamada de navegador (Origin); 421 = Host não é loopback; 429 = passou de 120 req/min; 503 = ponte encerrada.',
    ],
  },
  {
    title: 'Receitas prontas para colar',
    lines: [
      'Ping: comando "ping", exec reply, resposta "pong", cooldownMs 3000. Serve para provar que o bot está vivo.',
      'Ajuda: comando "ajuda" com aliases ["help"] e a lista dos comandos na resposta.',
      'Clima (sem chave): GET em https://api.open-meteo.com/v1/forecast?latitude={{arg0}}&longitude={{arg1}}&current=temperature_2m,wind_speed_10m, responsePath current.temperature_2m.',
      'IA: POST na URL compatível com OpenAI, header Authorization: Bearer SUA-CHAVE, corpo com {{jsonargs}}, responsePath choices[0].message.content, timeout 60 s.',
      'Moderação: comandos exec admin "ban", "kick" e "mute" com permission "moderate", depois conceda os bits na aba Permissões.',
      'Enquete: comando exec admin "poll_create"; a pergunta é a primeira palavra e as opções vêm separadas por |. Exige o bit conteúdo e organização.',
      'O guia completo, com os JSONs inteiros, é o arquivo "Baixar documentação (.md)".',
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
      'Quem já tinha só o bit antigo "gerenciar" continua com tudo: a separação não tirou poder de bot configurado. O painel mostra o alcance real desse bit.',
      'O bot não distribui cargo com permissão que ele mesmo não tem: um cargo com "banir" criado pelo dono só pode ser dado por um bot que também bane.',
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
      'Não entra em call/voz como um participante próprio: não aparece na lista de quem está na call nem tem track separada. O tipo "Música na call" toca arquivos locais pela conexão de quem é dono do bot — o dono precisa estar na chamada.',
      'Não faz música remota: sem o dono na call, o som sai só no PC dele e o bot avisa isso em vez de fingir.',
      'Não manda mensagem direta (DM), não monta embed/cartão, não cria botão/select/modal e não anexa arquivo.',
      'Não usa WASM: runtime "wasm" é recusado na leitura. Não há marketplace, federação, SDK nem CLI.',
      'O modo "remote" existe no schema mas não tem transporte de entrada nesta versão — só o rótulo.',
      'Pela config, não executa shell nem eval: a DSL é interpretada com instruções conhecidas.',
      'Não lê arquivo, câmera, microfone, tela, área de transferência nem banco.',
      'Não roda no PC de outra pessoa e não fala em nome de outra pessoa.',
      'Webhook: o app tenta duas vezes em caso de 5xx/timeout e registra o status no console. Com segredo configurado, cada evento vai assinado (X-Distorrent-Signature).',
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
    schema: 3,
    mode: 'declarative',
    runtime: 'none',
    primitives: {
      text: true,
      ephemeral: true,
      http: true,
      template: true,
      reaction: true,
      pin: true,
      thread: true,
      poll: true,
      kv: true,
    },
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
    integrations: {
      http: { allowDomains: ['api.exemplo.com'], maxCallsPerMinute: 60 },
      limits: { maxMessagesPerExecution: 20 },
      retention: { hours: 24 },
    },
  },
  null,
  2,
)

// O guia em markdown vive em botDocsMarkdown.ts (arquivo próprio para não
// passar de 1.000 linhas e para o teste de sincronia comparar os dois lados).
export { BOT_DOCS_FILE_NAME, botDocsMarkdown } from './botDocsMarkdown.ts'
