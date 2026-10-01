// Conjunto de emojis por categoria (estilo Discord) — dados estáticos, sem
// dependência externa. Usado pelo seletor de emoji (composer + reações).

export interface EmojiGroup {
  id: string
  label: string
  icon: string
  emojis: string[]
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    id: 'recentes', label: 'Usados recentemente', icon: '🕘',
    emojis: ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '🙏'],
  },
  {
    id: 'rosto', label: 'Rostos e emoticons', icon: '😀',
    emojis: [
      '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩',
      '😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐',
      '🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒',
      '🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕',
      '😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖',
      '😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','💀','💩','🤡','👻','👽',
      '🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉','🙊',
    ],
  },
  {
    id: 'gestos', label: 'Gestos e pessoas', icon: '👋',
    emojis: [
      '👋','🤚','🖐','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆',
      '🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️',
      '💅','🤳','💪','🦾','🦵','🦶','👂','👃','🧠','🫀','👀','👁','👅','👄','💋','🩸',
    ],
  },
  {
    id: 'coracoes', label: 'Corações e símbolos', icon: '❤️',
    emojis: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖',
      '💘','💝','💟','☮️','✝️','☪️','🕉','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈',
      '♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️',
      '📴','📳','🈶','🈚','🈸','🈺','🈷','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹',
    ],
  },
  {
    id: 'animais', label: 'Animais e natureza', icon: '🐶',
    emojis: [
      '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈',
      '🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛',
      '🦋','🐌','🐞','🐜','🕷','🐢','🐍','🦎','🐙','🦑','🦀','🐡','🐠','🐟','🐬','🐳',
      '🐋','🦈','🌵','🎄','🌲','🌳','🌴','🌱','🌿','☘️','🍀','🎍','🍃','🍂','🍁','🌾',
      '🌸','💐','🌹','🌺','🌻','🌼','🌷','🌱','🌲','🌴','🌵','🍄','🌍','🌙','⭐️','🌟',
      '✨','⚡️','🔥','💥','☄️','🌈','☀️','🌤️','⛅️','☁️','🌧️','⛈️','🌩️','🌨️','❄️','☃️',
    ],
  },
  {
    id: 'comida', label: 'Comida e bebida', icon: '🍕',
    emojis: [
      '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🍈','🍒','🍑','🥭','🍍','🥥','🥝',
      '🍅','🍆','🥑','🥦','🥬','🥒','🌶','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🥯','🍞',
      '🥖','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🥙',
      '🍿','🧂','🥫','🍝','🍣','🍱','🍤','🍚','🍙','🍘','🍥','🥠','🥮','🍢','🍡','🍧',
      '🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','☕','🍵','🧃',
    ],
  },
  {
    id: 'atividade', label: 'Atividades e viagens', icon: '⚽',
    emojis: [
      '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍',
      '🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌',
      '🎿','⛷️','🏂','🏋️','🤼','🤸','⛹️','🤺','🤾','🏌️','🏇','🧘','🏄','🏊','🤽','🚣',
      '🧗','🚵','🚴','🏆','🥇','🥈','🥉','🎮','🕹️','🎲','🎯','🎳','🎰','🧩','🎨','🎬',
      '🎤','🎧','🎼','🎹','🥁','🎷','🎺','🎸','🪕','🎻','🚗','🚕','🚙','🚌','🏎️','🚓',
      '🚑','🚒','✈️','🚀','🛸','🚁','⛵️','🚤','🛥️','🛳️','⚓️','🏔️','⛰️','🌋','🗻','🏕️',
    ],
  },
  {
    id: 'objetos', label: 'Objetos e símbolos', icon: '💡',
    emojis: [
      '⌚️','📱','💻','⌨️','🖥','🖨','🖱','💽','💾','💿','📀','📷','📸','📹','🎥','📞',
      '☎️','📟','📠','📺','📻','🎙','⏱','⏲','⏰','🕰','⌛️','⏳','📡','🔋','🔌','💡',
      '🔦','🕯','🧯','🛢','💸','💵','💴','💶','💷','🪙','💰','💳','🧾','💎','⚖️','🔧',
      '🔨','⚒','🛠','⛏','🔩','⚙️','🧱','⛓','🧲','🔫','💣','🧨','🪓','🔪','🗡','⚔️',
      '🛡','🚬','⚰️','🏺','🔮','📿','🧿','💈','⚗️','🔭','🔬','🕳','💊','💉','🩸','🧬',
      '🩹','🩺','🌡','🧹','🧺','🧻','🚽','🚿','🛁','🛀','🧼','🪥','🪒','🧽','🧴','🛎',
    ],
  },
  {
    id: 'simbolos', label: 'Símbolos', icon: '✅',
    emojis: [
      '✅','❌','❎','✔️','☑️','➕','➖','➗','✖️','♾','⁉️','❓','❗️','⭕️','🚫','💯',
      '🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔺','🔻','🔸','🔹','🔶','🔷','🔳',
      '🔲','▪️','▫️','◾️','◽️','◼️','◻️','🟥','🟧','🟨','🟩','🟦','⬆️','⬇️','⬅️','➡️',
      '↗️','↘️','↙️','↖️','↕️','↔️','🔃','🔄','🔙','🔚','🔛','🔜','🔝','🆗','🆕','🆒',
    ],
  },
]

/** Reações rápidas da barra flutuante (as mesmas do Discord em 1 toque). */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥']

/** Emojis "clássicos" do Discord para a reaction bar. */
export const REACTION_POOL = [
  '👍','👎','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','✨','⭐️','🔥','🎉',
  '😂','🤣','😅','😆','😮','😲','😢','😭','😡','🤔','😐','🙃','😴','🤯','🥳','🤩',
  '👀','🙈','👍🏻','👎🏻','💯','✅','❌','⚡️','🚀','🍕','🎮','📌','🐛','🧠','☕️','🌚',
]

/** Flat com todos (pra busca). */
export const ALL_EMOJI = Array.from(new Set(EMOJI_GROUPS.filter(g => g.id !== 'recentes').flatMap(g => g.emojis)))

// ---------------------------------------------------------------------------
// Índice por NOME
//
// Sem isto a busca do seletor é inútil: o dataset guarda só o caractere, e
// digitar "risada" nunca casaria com "😂". Este índice liga cada emoji aos
// nomes em inglês e português (o app é pt-BR), e é dele que saem tanto a busca
// quanto o autocompletar `:nome:` do composer.
// ---------------------------------------------------------------------------

export interface NamedEmoji { char: string; names: string[] }

const NAME_TABLE: [string, string[]][] = [
  ['👍', ['thumbsup', 'polegar', 'like', 'ok']],
  ['👎', ['thumbsdown', 'dedo', 'dislike']],
  ['❤️', ['coracao', 'heart', 'amor', 'love']],
  ['🔥', ['fogo', 'fire', 'flame', 'quente']],
  ['😂', ['risada', 'lol', 'riso', 'haha']],
  ['🤣', ['rostochorando', 'rofl', 'lol']],
  ['😅', ['sorriso', 'sweat_smile']],
  ['😆', ['sorriso', 'grin']],
  ['😮', ['surpreso', 'open_mouth']],
  ['😲', ['surpreso', 'astonished']],
  ['😢', ['triste', 'cry']],
  ['😭', ['chorando', 'sob', 'sob_chiar']],
  ['😡', ['bravo', 'raiva', 'rage']],
  ['🤔', ['pensando', 'pensativo', 'thinking']],
  ['😐', ['neutro', 'neutral']],
  ['🙃', ['irônico', 'ironic']],
  ['😴', ['dormindo', 'sleeping']],
  ['🤯', ['explodindo', 'mindblown']],
  ['🥳', ['festa', 'partying']],
  ['🤩', ['estrela', 'starstruck']],
  ['👀', ['olhos', 'eyes', 'vendo']],
  ['🙈', ['macaco', 'see_no_evil']],
  ['🙏', ['por_favor', 'pray', 'obrigado']],
  ['💯', ['cem', '100']],
  ['✅', ['check', 'certo', 'feito']],
  ['❌', ['x', 'errado', 'nao']],
  ['⚡', ['raio', 'zap', 'rapido']],
  ['🚀', ['foguete', 'rocket', 'lancar']],
  ['🍕', ['pizza']],
  ['🎮', ['games', 'videogame', 'jogo']],
  ['📌', ['pin', 'fixado']],
  ['🐛', ['bicho', 'bug']],
  ['🧠', ['cerebro', 'brain', 'inteligencia']],
  ['☕', ['cafe', 'coffee']],
  ['🌚', ['lua', 'riso_escuro']],
  ['👀‍🗨️', ['olhos_vidente']],
  ['🎉', ['comemorar', 'party', 'festa']],
  ['✨', ['brilho', 'sparkles']],
  ['⭐', ['estrela', 'star']],
  ['💔', ['coracao_partido', 'broken_heart']],
  ['🤝', ['aperto_mao', 'handshake']],
  ['👋', ['ola', 'wave', 'tchau']],
  ['👍🏿', ['thumbsup_escuro']],
  ['🎯', ['alvo', 'target', 'gol']],
  ['💡', ['ideia', 'bulb', 'lampada']],
  ['📎', ['anexo', 'paperclip']],
  ['🔒', ['cadeado', 'lock', 'privado']],
  ['🔑', ['chave', 'key']],
  ['⏰', ['relogio', 'clock', 'alarme']],
  ['📅', ['calendario', 'calendar']],
  ['📊', ['grafico', 'chart', 'stats']],
  ['📈', ['subindo', 'up', 'crescimento']],
  ['📉', ['descendo', 'down', 'queda']],
  ['🏆', ['trofeu', 'trophy', 'vencedor']],
  ['🥇', ['ouro', 'gold', 'primeiro']],
  ['⚽', ['futebol', 'soccer']],
  ['🎵', ['musica', 'music', 'nota']],
  ['🎤', ['microfone', 'microphone', 'karaoke']],
  ['🎧', ['fone', 'headphone', 'musica']],
  ['📷', ['camera', 'foto']],
  ['🎬', ['filme', 'movie', 'cinema']],
  ['💬', ['balao', 'bubble', 'chat']],
  ['👋🏻', ['ola_claro']],
  ['😴‍💤', ['dormindo_z']],
  ['😤', ['bufando', 'triumph']],
  ['🤯🤯', ['cerebro_explodindo']],
  ['💪', ['forca', 'muscle', 'forte']],
  ['🙏🏽', ['por_favor_medio']],
  ['🫶', ['coracoes', 'heart_hands']],
  ['😌', ['aliviado', 'relieved']],
  ['🥲', ['sorriso_chocho', 'holding_back_tears']],
  ['🫠', ['derreter', 'melting']],
  ['👀🫶', ['olhos_coracao']],
  ['💅', ['unha', 'nail']],
  ['🫡', ['saudacao', 'salute']],
  ['😇', ['anjo', 'angel']],
  ['🤡', ['palhaco', 'clown']],
  ['👻', ['fantasma', 'ghost']],
  ['💩', ['cocô', 'poop', 'shit']],
  ['🤖', ['robo', 'bot', 'robot']],
  ['👾', ['invasao', 'space_invader']],
  ['👻‍🌾', ['fantasma_planta']],
  ['🧌', ['goblin']],
  ['🗿', ['momo', 'moai']],
  ['🦄', ['unicornio', 'unicorn']],
  ['🐉', ['dragao', 'dragon']],
  ['🐙', ['polvo', 'octopus']],
  ['🦖', ['dino', 'dinosaurio']],
  ['🐳', ['baleia', 'whale']],
  ['🌊', ['onda', 'wave_agua']],
  ['☔', ['chuva', 'rain']],
  ['❄️', ['neve', 'snow', 'frio']],
  ['🔥‍🔥', ['fogo_duplo']],
  ['🌈', ['arco_iris', 'rainbow']],
  ['🌙', ['lua_noite', 'moon']],
  ['☀️', ['sol', 'sun']],
  ['⛅', ['nublado', 'cloudy']],
  ['🌧️', ['chuva2', 'rainy']],
  ['🌪️', ['tornado']],
  ['🍀', ['trevo', 'clover', 'sorte']],
  ['🌸', ['flor', 'flower', 'sakura']],
  ['🌹', ['rosa', 'rose']],
  ['🐝', ['abelha', 'bee']],
  ['🦋', ['borboleta', 'butterfly']],
  ['🐢', ['tartaruga', 'turtle']],
  ['🐈', ['gato', 'cat']],
  ['🐕', ['cachorro', 'dog']],
  ['🦊', ['raposa', 'fox']],
  ['🐻', ['urso', 'bear']],
  ['🐸', ['sapo', 'frog']],
  ['🐵', ['macaco_monkey']],
  ['🦁', ['leao', 'lion']],
  ['🐷', ['porco', 'pig']],
  ['🐔', ['galinha', 'chicken']],
  ['🐧', ['pinguim', 'penguin']],
  ['🐦', ['passaro', 'bird']],
  ['🦅', ['aguia', 'eagle']],
  ['🦄✨', ['unicornio_brilho']],
  ['🍎', ['maca', 'apple']],
  ['🍌', ['banana']],
  ['🍉', ['melancia', 'watermelon']],
  ['🍓', ['morango', 'strawberry']],
  ['🥑', ['abacate', 'avocado']],
  ['🍔', ['hamburger']],
  ['🍟', ['batata_frita', 'fries']],
  ['🍩', ['dona', 'donut']],
  ['🍪', ['biscoito', 'cookie']],
  ['🎂', ['bolo', 'cake']],
  ['🍻', ['cerveja', 'beer']],
  ['☕', ['cafe', 'coffee']],
  ['🧋', ['cha_bubble', 'bubble_tea']],
  ['🥤', ['copo', 'soda']],
  ['🧊', ['gelo', 'ice']],
  ['🧂', ['sal', 'salt']],
]

/** Índice nome->emoji, gerado da tabela acima. */
export const EMOJI_NAME_INDEX: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const [ch, names] of NAME_TABLE) for (const n of names) if (!m.has(n)) m.set(n, ch)
  return m
})()

/** Todos os emojis COM nome — base do autocompletar `:nome:`. */
export const NAMED_EMOJI: NamedEmoji[] = NAME_TABLE.map(([char, names]) => ({ char, names }))

/** Busca por nome (pt-BR e en). Retorna emojis, não nomes. */
export function searchEmojis(q: string, limit = 24): string[] {
  const s = q.trim().toLowerCase()
  if (!s) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const { char, names } of NAMED_EMOJI) {
    if (names.some(n => n.includes(s)) && !seen.has(char)) { seen.add(char); out.push(char) }
    if (out.length >= limit) break
  }
  return out
}

/** Resolve `:nome:` para o caractere. */
export function emojiByName(name: string): string | null {
  return EMOJI_NAME_INDEX.get(name.trim().toLowerCase()) ?? null
}

