// Estilo do assistente de criação de servidor.
//
// ## Duas camadas, de propósito
//
// `layout` (inline) contém TODA a estrutura: grid, espaçamentos, cards, cores.
// Style inline sempre se aplica — não depende de `<style>` ser injetado, de CSP,
// nem de a folha global continuar carregada.
//
// `css` (folha) contém SÓ o que é impossível escrever inline: `:hover`,
// `:focus-visible` e `@media`. Se esse bloco não for aplicado (WebView que
// descarta `<style>`, CSP restritiva, preview de terceiros), a tela fica com
// aparência simples — **mas continua legível e utilizável**.
//
// POR QUE ISSO IMPORTA: um build anterior renderizava o wizard sem a folha e o
// resultado era o pior possível — rótulo e descrição grudados sem espaço
// ("ServidorSem tema definido…"), cards virando uma linha corrida de texto,
// etapas colando ("1Identidade 2Canais"). O usuário ficou sem saber o que era
// cada campo. O layout não pode depender do estilo "extra".

import type { CSSProperties } from 'react'
import { ui } from '../../shared/ui'

// ---------------------------------------------------------------------------
// Camada 1: layout inline (sempre aplicado)
// ---------------------------------------------------------------------------

export const layout = {
  /** Duas colunas no desktop; a folha troca para uma só abaixo de 860px. */
  cols: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 268px',
    gap: ui.lg,
    alignItems: 'start',
  } satisfies CSSProperties,

  /** Coluna de conteúdo. `minWidth: 0` impede o filho de estourar o grid. */
  main: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: ui.lg,
  } satisfies CSSProperties,

  side: {
    position: 'sticky',
    top: 0,
    minWidth: 0,
  } satisfies CSSProperties,

  stepHead: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: ui.md,
    paddingBottom: ui.md,
    borderBottom: `1px solid ${ui.border}`,
  } satisfies CSSProperties,

  stepNum: {
    width: 34,
    height: 34,
    borderRadius: 10,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(88,101,242,.16)',
    color: ui.accent,
    fontSize: 14,
    fontWeight: 900,
  } satisfies CSSProperties,

  stepTitle: {
    fontSize: 15,
    fontWeight: 800,
    color: ui.heading,
    lineHeight: 1.3,
  } satisfies CSSProperties,

  stepSub: {
    fontSize: 12,
    color: ui.muted,
    lineHeight: 1.5,
    marginTop: 3,
  } satisfies CSSProperties,

  /** Moldes em lista vertical (estilo Discord): uma linha por molde. */
  models: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: 8,
  } satisfies CSSProperties,

  /** Linha clicável de molde: ícone | texto | seta. `aria-pressed` realça. */
  card: (selected: boolean): CSSProperties => ({
    appearance: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    background: selected ? 'rgba(88,101,242,.14)' : ui.surface,
    border: `1px solid ${selected ? ui.accent : ui.border}`,
    borderRadius: 8,
    padding: '10px 12px',
    color: ui.text,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
    font: 'inherit',
  }),

  /** Caixa do ícone do molde, mesma linguagem dos cards de categoria. */
  modelIcon: (selected: boolean): CSSProperties => ({
    width: 30,
    height: 30,
    borderRadius: 9,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: selected ? 'rgba(88,101,242,.26)' : ui.input,
    color: selected ? '#fff' : ui.muted,
    flexShrink: 0,
  }),

  /** Seta ">" à direita, empurrada para o fim da linha. */
  cardChevron: {
    marginLeft: 'auto',
    color: ui.muted,
    flexShrink: 0,
    display: 'flex',
  } satisfies CSSProperties,

  /** Grade de ícones: colunas de 200px, quantas couberem. */
  cats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: ui.sm,
    alignItems: 'stretch',
  } satisfies CSSProperties,

  catCard: (selected: boolean): CSSProperties => ({
    appearance: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    background: selected ? 'rgba(88,101,242,.14)' : ui.surface,
    border: `1px solid ${selected ? ui.accent : ui.border}`,
    borderRadius: 10,
    padding: '11px 12px',
    color: ui.text,
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
    minWidth: 0,
    minHeight: 76,
    font: 'inherit',
  }),

  catIcon: (selected: boolean): CSSProperties => ({
    width: 30,
    height: 30,
    borderRadius: 9,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: selected ? 'rgba(88,101,242,.26)' : ui.input,
    color: selected ? '#fff' : ui.muted,
    flexShrink: 0,
  }),

  /** Linha de canal: ícone | nome | tipo | categoria | remover. */
  chanRow: (bad: boolean): CSSProperties => ({
    display: 'grid',
    gridTemplateColumns: '24px minmax(0, 1fr) 96px 160px 32px',
    gap: ui.sm,
    alignItems: 'start',
    background: ui.surface,
    border: `1px solid ${bad ? ui.danger : ui.border}`,
    borderRadius: 10,
    padding: '10px 11px',
  }),

  chanIcon: {
    color: ui.muted,
    display: 'flex',
    justifyContent: 'center',
    paddingTop: 10,
  } satisfies CSSProperties,

  roleCard: (on: boolean): CSSProperties => ({
    background: ui.surface,
    border: `1px solid ${ui.border}`,
    borderRadius: 10,
    padding: '11px 12px',
    opacity: on ? 1 : 0.6,
  }),

  roleTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  } satisfies CSSProperties,

  roleDot: (color: string): CSSProperties => ({
    width: 11,
    height: 11,
    borderRadius: '50%',
    flexShrink: 0,
    background: color,
    boxShadow: '0 0 0 3px rgba(255,255,255,.05)',
  }),

  /** Descrição do cargo alinhada ao NOME (checkbox 18 + gaps 10+10). */
  roleWhy: {
    fontSize: 11,
    color: ui.muted,
    lineHeight: 1.5,
    marginTop: 7,
    paddingLeft: 38,
  } satisfies CSSProperties,

  perms: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
    gap: 2,
    marginTop: 10,
    paddingTop: 10,
    borderTop: `1px solid ${ui.border}`,
  } satisfies CSSProperties,

  check: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    color: ui.text,
    cursor: 'pointer',
    padding: '5px 7px',
    borderRadius: 6,
  } satisfies CSSProperties,

  /** Barra de etapas (4 segmentos). */
  segWrap: {
    display: 'flex',
    gap: 6,
    marginBottom: ui.xl,
  } satisfies CSSProperties,

  seg: (_state: 'done' | 'now' | 'todo'): CSSProperties => ({
    appearance: 'none',
    cursor: 'pointer',
    background: 'transparent',
    border: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    minWidth: 0,
    textAlign: 'left',
    font: 'inherit',
    flex: 1,
  }),

  segBar: (state: 'done' | 'now' | 'todo'): CSSProperties => ({
    height: 3,
    borderRadius: 99,
    width: '100%',
    background: state === 'done' ? ui.success : state === 'now' ? ui.accent : ui.input,
  }),

  segLabel: (state: 'done' | 'now' | 'todo'): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 700,
    color: state === 'now' ? ui.heading : state === 'done' ? ui.text : ui.muted,
    minWidth: 0,
  }),

  segNum: (state: 'done' | 'now' | 'todo'): CSSProperties => ({
    width: 17,
    height: 17,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 9,
    fontWeight: 800,
    flexShrink: 0,
    background: state === 'done' ? 'rgba(35,165,89,.22)' : state === 'now' ? ui.accent : ui.input,
    color: state === 'done' ? '#a5e5bd' : state === 'now' ? '#fff' : ui.muted,
  }),

  segText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } satisfies CSSProperties,

  cap: {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: ui.muted,
    margin: `0 0 ${ui.sm}px`,
  } satisfies CSSProperties,

  /** Aviso "Falta: …" / erro de criação. */
  notice: {
    fontSize: 12,
    color: '#ffe0a3',
    lineHeight: 1.5,
    display: 'flex',
    gap: 7,
    alignItems: 'flex-start',
  } satisfies CSSProperties,

  /** Prévia do servidor no topo do resumo. */
  prev: {
    display: 'flex',
    alignItems: 'center',
    gap: ui.md,
    background: ui.surface,
    border: `1px solid ${ui.border}`,
    borderRadius: 12,
    padding: '13px 14px',
    marginBottom: ui.md,
  } satisfies CSSProperties,

  prevIcon: {
    width: 44,
    height: 44,
    borderRadius: 13,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(88,101,242,.2)',
    color: '#fff',
  } satisfies CSSProperties,

  prevName: {
    display: 'block',
    fontSize: 14,
    fontWeight: 800,
    color: ui.heading,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } satisfies CSSProperties,

  prevDesc: {
    display: '-webkit-box',
    fontSize: 11,
    color: ui.muted,
    lineHeight: 1.45,
    marginTop: 3,
    overflow: 'hidden',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  } satisfies CSSProperties,

  count: {
    fontSize: 11,
    color: ui.muted,
    textAlign: 'right',
    marginTop: 6,
    fontVariantNumeric: 'tabular-nums',
  } satisfies CSSProperties,

  sideBox: {
    background: ui.surface,
    border: `1px solid ${ui.border}`,
    borderRadius: 12,
    padding: '13px 14px',
    marginBottom: ui.md,
  } satisfies CSSProperties,

  sideTitle: {
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: ui.muted,
    marginBottom: 9,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  } satisfies CSSProperties,

  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 99,
    padding: '3px 9px',
    background: ui.input,
    border: `1px solid ${ui.border}`,
    color: ui.text,
  } satisfies CSSProperties,

  list: { display: 'flex', flexDirection: 'column', gap: 5 } satisfies CSSProperties,

  listItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 12,
    color: ui.text,
    minWidth: 0,
  } satisfies CSSProperties,

  ellipsis: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  } satisfies CSSProperties,

  listIcon: { color: ui.muted, flexShrink: 0, display: 'flex' } satisfies CSSProperties,

  empty: { fontSize: 12, color: ui.muted, lineHeight: 1.5 } satisfies CSSProperties,

  done: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: ui.md,
    padding: `${ui.lg}px 0 ${ui.xl}px`,
  } satisfies CSSProperties,

  doneIcon: {
    width: 68,
    height: 68,
    borderRadius: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(35,165,89,.18)',
    color: '#a5e5bd',
  } satisfies CSSProperties,
} as const

// ---------------------------------------------------------------------------
// Camada 2: folha — SÓ o que não existe inline
// ---------------------------------------------------------------------------

export const css = `
/* Realce/estado que não se expressa em style inline. Tudo o mais (estrutura,
   espacos, cores, grades) esta em \`layout\`, aplicado inline. Se esta folha nao
   carregar, a tela continua legivel e utilizavel. */

.csw-card:hover:not(:disabled){ background:${ui.surfaceHover} !important; border-color:${ui.borderStrong} !important }
.csw-card:active:not(:disabled){ transform:translateY(1px) }
.csw-card:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }

.csw-seg:hover:not(:disabled){ opacity:.92 }
.csw-seg:focus-visible{ outline:2px solid ${ui.link}; outline-offset:3px; border-radius:4px }
.csw-seg:disabled{ cursor:default; opacity:.75 }

.csw-check:hover{ background:${ui.surfaceHover} }
.csw-check:focus-within{ box-shadow:0 0 0 2px ${ui.accent}66 }

.csw-role:focus-within{ border-color:${ui.borderStrong} !important }
.csw-role-name{ flex:1; min-width:0 }
.csw-role-name input{ height:32px; padding:5px 9px; font-size:13px; font-weight:700 }
.csw-role-top input[type="checkbox"]{ appearance:none; -webkit-appearance:none; margin:0; width:18px; height:18px; flex-shrink:0; cursor:pointer; border-radius:5px; border:1.5px solid ${ui.borderStrong}; background:${ui.input}; position:relative }
.csw-role-top input[type="checkbox"]:checked{ background:${ui.accent}; border-color:${ui.accent} }
.csw-role-top input[type="checkbox"]:checked::after{ content:""; position:absolute; left:5px; top:2px; width:5px; height:9px; border:solid #fff; border-width:0 2px 2px 0; transform:rotate(45deg) }
.csw-role-top input[type="checkbox"]:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }

/* Abaixo de 860px a coluna de 268px rouba a largura do conteúdo. O resumo desce
   (order:2) em vez de sumir: é ele que mostra a contagem de canais e cargos. */
@media (max-width: 860px){
  .csw-cols{ grid-template-columns:minmax(0,1fr) !important }
  .csw-side{ position:static !important; order:2 }
  .csw-models{ grid-template-columns:minmax(0,1fr) !important }
}
/* 560px: 4 colunas de canal não cabem. Tipo e categoria descem. */
@media (max-width: 560px){
  .csw-chan{ grid-template-columns:24px minmax(0,1fr) 32px !important }
  .csw-chan-name{ grid-column:2 / 4 }
  .csw-chan-kind{ grid-column:1 / 2 }
  .csw-chan-cat{ grid-column:1 / 3 }
  .csw-chan-del{ grid-column:3; grid-row:1 }
  .csw-cats{ grid-template-columns:minmax(0,1fr) !important }
  .csw-perms{ grid-template-columns:minmax(0,1fr) !important }
  .csw-seg-t{ display:none }
}
`
