// Sistema de ícones da interface.
//
// REGRA DA CASA: ícone de interface é SEMPRE SVG daqui. Emoji é conteúdo de
// mensagem (reação, texto do usuário) e nunca substitui um ícone de UI.
//
// Consistência garantida por construção, não por convenção:
//   - viewBox único (24×24) → todos os ícones se alinham no mesmo grid;
//   - `stroke` herdado do `currentColor` → um `<Icon color>` colore todos;
//   - espessura e traço fixos, então dois ícones nunca ficam com pesos
//     diferentes;
//   - `aria-hidden` por padrão: o ícone decora, quem nomeia é o `aria-label`
//     do botão — assim leitor de tela não lê "botão-imagem" duas vezes.

export interface IconProps {
  /** Caminho(s) `d` do SVG. Vários elementos = ícone compuesto. */
  d: string | string[]
  size?: number
  /** Espessura do traço. Padrão 1.6 casa com o resto da UI. */
  stroke?: number
  color?: string
  /** Rotaciona o ícone — usado em chevron expandido/retraído. */
  rotate?: number
  className?: string
  /** Só para ícone decorativo com texto ao lado; o padrão é decorativo. */
  label?: string
}

export function Icon({ d, size = 16, stroke = 1.6, color, rotate, className, label }: IconProps) {
  const paths = Array.isArray(d) ? d : [d]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      {paths.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  )
}

/**
 * Catálogo. Traços de 1.6 e cantos arredondados em tudo, para que ícones de
 * seções diferentes pareçam da mesma família.
 */
export const Icons = {
  // navegação / estrutura
  home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  chevron: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronDown: 'M6 9l6 6 6-6',
  externalLink: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3',

  // servidores / canais
  server: 'M3 8h18 M3 12h18 M3 16h18',
  hash: 'M4 9h16 M4 15h16 M10 3L8 21 M16 3l-2 12',
  speaker: 'M11 5L6 9H2v6h4l5 4z M15.54 8.46a5 5 0 0 1 0 7.08 M19.07 4.93a10 10 0 0 1 0 14.14',
  video: 'M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  tag: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z M7 7h.01',

  // pessoas
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  people: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  crown: 'M2 18h20 M4 18l-1-9 5.5 3L12 5l3.5 7L21 9l-1 9',

  // ação
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  check: 'M20 6L9 17l-5-5',
  checkDouble: 'M1 12l5 5L16 7 M8 12l5 5L23 7',
  x: 'M18 6L6 18 M6 6l12 12',
  edit: 'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z',
  trash: 'M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14 M10 11v6 M14 11v6',
  copy: 'M9 9h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8',
  refresh: 'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  search: 'M21 21l-6-6 M10 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2.5v2.2 M12 19.3v2.2 M2.5 12h2.2 M19.3 12h2.2 M5.2 5.2l1.6 1.6 M17.2 17.2l1.6 1.6 M18.8 5.2l-1.6 1.6 M6.8 17.2l-1.6 1.6',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  sort: 'M11 5h10 M11 9h7 M11 13h4 M3 17l3 3 3-3 M6 6v14',
  drag: 'M9 5h.01 M9 12h.01 M9 19h.01 M15 5h.01 M15 12h.01 M15 19h.01',
  moveUp: 'M12 19V5 M5 12l7-7 7 7',
  moveDown: 'M12 5v14 M19 12l-7 7-7-7',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01',
  warn: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  eyeOff: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94 M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19 M14.12 14.12a3 3 0 1 1-4.24-4.24 M1 1l22 22',

  // segurança
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3',
  lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M7 11V7a5 5 0 0 1 10 0v4',
  unlock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M7 11V7a5 5 0 0 1 9.9-1',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M4.93 4.93l14.14 14.14',

  // mídia / comunicação
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-6 9-6 9h16s-6-2-6-9 M13.73 21a2 2 0 0 1-3.46 0',
  phone: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
  smile: 'M8 14s1.5 2 4 2 4-2 4-2 M9 9h.01 M15 9h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  mic: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v4 M8 23h8',
  micOff: 'M1 1l22 22 M9 9v3a3 3 0 0 0 5.12 2.12 M15 9.34V4a3 3 0 0 0-5.94-.6 M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23 M12 19v4 M8 23h8',
  headphones: 'M3 18v-6a9 9 0 0 1 18 0v6 M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z',
  volumeX: 'M11 5L6 9H2v6h4l5 4z M23 9l-6 6 M17 9l6 6',
  send: 'M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z',
  attach: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  screen: 'M2 4h20v12H2z M8 20h8 M12 16v4',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8',
  pin: 'M12 17v5 M9 10.8V4h6v6.8l2.2 2.2a1 1 0 0 1-.7 1.7H7.5a1 1 0 0 1-.7-1.7z',

  // automação / integração
  bot: 'M4 4h16v16H4z M9 9h6v6H9z M9 1v3 M15 1v3 M9 20v3 M15 20v3 M1 9h3 M1 15h3 M20 9h3 M20 15h3',
  terminal: 'M4 17l6-6-6-6 M12 19h8',
  code: 'M16 18l6-6-6-6 M8 6l-6 6 6 6',
  plug: 'M9 2v6 M15 2v6 M6 8h12v3a6 6 0 0 1-12 0z M12 17v5',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  webhook: 'M9.5 3h5l.5 5h-6z M5 21l1.5-6h11L19 21 M12 8v7 M8.5 21l1-4 M15.5 21l-1-4',

  // servidor host / rede
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  wifi: 'M5 12.55a11 11 0 0 1 14.08 0 M1.42 9a16 16 0 0 1 21.16 0 M8.53 16.11a6 6 0 0 1 6.95 0 M12 20h.01',
  monitor: 'M20 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z M8 21h8 M12 17v4',
  smartphone: 'M17 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z M12 18h.01',
  history: 'M3 3v5h5 M3.05 13A9 9 0 1 0 6 5.3L3 8 M12 7v5l4 2',
  sparkle: 'M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z',
} as const

export type IconName = keyof typeof Icons

/**
 * Ícone por nome, com o tamanho explícito. Preferir isto a `<Icon d={Icons.x}>`
 * em código novo: dá autocomplete e impede digitar o caminho errado.
 */
export function Ic({
  name,
  size = 16,
  stroke,
  color,
  rotate,
}: {
  name: IconName
  size?: number
  stroke?: number
  color?: string
  rotate?: number
}) {
  return <Icon d={Icons[name]} size={size} stroke={stroke} color={color} rotate={rotate} />
}