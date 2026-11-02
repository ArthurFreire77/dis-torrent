// Documentação dos bots em DADOS (sem JSX/cor) para ser usada em DOIS lugares:
// o passo "Bots" do assistente de criação e o painel de Bots do servidor.
//
// Por que um arquivo só: a mesma frase não pode divergir entre "criar" e
// "gerenciar". E por que sem JSX: `node --experimental-strip-types` não
// transforma JSX, então este arquivo precisa continuar importável nos testes.

export interface BotDocTopic {
  /** Título curto da seção. */
  title: string
  /** Linhas do tópico; cada uma é um parágrafo curto. */
  lines: string[]
  /** Tom do bloco — `warn` para o que limita de verdade. */
  tone?: 'info' | 'warn'
}

/** Modelos de bot que o assistente oferece (o `id` é o que vai para o estado). */
export type BotTemplate = 'vazio' | 'clima'

export interface BotTemplateDef {
  id: BotTemplate
  label: string
  desc: string
  /** Config inicial (JSON) — vazio = bot sem nenhuma ação ainda. */
  config: string
}

/**
 * `clima` usa a Open-Meteo: gratuita, sem chave e sem cadastro. Pede
 * latitude/longitude em vez de nome de cidade porque geocodificar exigiria
 * outra API e uma chave — prometer "!clima São Paulo" sem isso seria mentira.
 */
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

/**
 * O que explicar para quem está criando. Cada linha foi escrita a partir do
 * código (`botRuntime.ts`, `botCommands.ts`, `bot_post_message`), não de
 * intenção: o que não existe está dito como "não existe".
 */
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
]

/** Limite real do config — o mesmo do `bot_update` no Rust. */
export const BOT_CONFIG_MAX_KB = 16
