// CSS do assistente de criação de servidor.
//
// `hover`, `focus-visible` e `@media` não se expressam em `style` inline —
// precisam de seletor. Mesmo caminho que o `BotConfigPanel` usa. Ficava dentro
// do componente (145 das 1191 linhas); separado aqui, o componente volta a ser
// só lógica de tela.

import { ui } from '../../shared/ui'

export const css = `
/* ==========================================================================
   Assistente de criação de servidor
   --------------------------------------------------------------------------
   Estrutura: [conteúdo 1fr] [resumo 268px]. O resumo fica STICKY porque é ele
   que confirma o que está sendo criado — em um formulário longo, perder o
   resumo de vista obriga a pessoa a rolar de volta para conferir o nome.
   ========================================================================== */
.csw-cols{ display:grid; grid-template-columns:minmax(0,1fr) 268px; gap:${ui.lg}px; align-items:start }
/* grid-template-columns com minmax(0,1fr) é obrigatório: com 1fr puro o
   mínimo automático da coluna é o conteúdo, e o grid devolvia 534px de 558
   disponíveis (medido) — sobrava espaço e os cards ficavam estreitos. */
.csw-cols > *{ min-width:0 }
.csw-side{ position:sticky; top:0; min-width:0 }
.csw-main{ min-width:0; display:flex; flex-direction:column; gap:${ui.lg}px }
/* Filhos do flex precisam width:100%: sem isso um DIV com grid dentro
   encolhe para o conteúdo (medido: csw-cats ocupava 534px de 858px e os cards
   ficavam com 263px, cortando a descrição). */
.csw-main > *{ width:100% }

/* ---- cabeçalho do passo ------------------------------------------------- */
.csw-step-head{ display:flex; align-items:flex-start; gap:${ui.md}px; padding-bottom:${ui.md}px; border-bottom:1px solid ${ui.border} }
.csw-step-num{ width:34px; height:34px; border-radius:10px; flex-shrink:0; display:flex; align-items:center; justify-content:center; background:rgba(88,101,242,.16); color:${ui.accent}; font-size:14px; font-weight:900 }
.csw-step-title{ font-size:15px; font-weight:800; color:${ui.heading}; line-height:1.3 }
.csw-step-sub{ font-size:12px; color:${ui.muted}; line-height:1.5; margin-top:3px }

/* ---- modelos (atalhos) -------------------------------------------------- */
.csw-models{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:${ui.sm}px }
.csw-model{ appearance:none; text-align:left; cursor:pointer; background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; padding:12px 13px; color:${ui.text}; display:flex; flex-direction:column; gap:6px; min-width:0; transition:background .15s, border-color .15s, transform .12s }
.csw-model:hover:not(:disabled){ background:${ui.surfaceHover}; border-color:${ui.borderStrong} }
.csw-model:active:not(:disabled){ background:${ui.elevated}; transform:translateY(1px) }
.csw-model:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.csw-model[aria-pressed="true"]{ border-color:${ui.accent}; background:rgba(88,101,242,.14) }
.csw-model-row{ display:flex; align-items:center; gap:8px; min-width:0 }
.csw-model-t{ display:block; font-size:13px; font-weight:800; color:${ui.heading}; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.csw-model-d{ display:block; font-size:11px; color:${ui.muted}; line-height:1.45; min-width:0 }

/* ---- categorias de ícone -------------------------------------------------
   Título e descrição são elementos de BLOCO: como spans inline eles saíam
   grudados ("ServidorSem tema definido…"), defeito que já apareceu em build
   publicado. min-width:0 é o que deixa o ellipsis funcionar no card.
   -------------------------------------------------------------------------- */
.csw-cats{ display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:${ui.sm}px; align-items:stretch }
.csw-cat{ appearance:none; text-align:left; cursor:pointer; background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; padding:11px 12px; color:${ui.text}; display:flex; gap:10px; align-items:flex-start; min-width:0; min-height:76px; transition:background .15s, border-color .15s, transform .12s }
.csw-cat:hover:not(:disabled){ background:${ui.surfaceHover}; border-color:${ui.borderStrong} }
.csw-cat:active:not(:disabled){ background:${ui.elevated}; transform:translateY(1px) }
.csw-cat:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.csw-cat[aria-pressed="true"]{ border-color:${ui.accent}; background:rgba(88,101,242,.14) }
.csw-cat-ic{ width:30px; height:30px; border-radius:9px; display:flex; align-items:center; justify-content:center; background:${ui.input}; color:${ui.muted}; flex-shrink:0; transition:background .15s, color .15s }
.csw-cat[aria-pressed="true"] .csw-cat-ic{ background:rgba(88,101,242,.26); color:#fff }
.csw-cat-body{ min-width:0; flex:1 }
.csw-cat-t{ display:block; font-size:12px; font-weight:800; color:${ui.heading}; line-height:1.3; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.csw-cat-d{ display:block; font-size:11px; color:${ui.muted}; line-height:1.45; margin-top:2px }

/* ---- canais ------------------------------------------------------------- */
.csw-chan{ display:grid; grid-template-columns:24px minmax(0,1fr) 96px 160px 32px; gap:${ui.sm}px; align-items:start; background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; padding:10px 11px; transition:border-color .15s }
.csw-chan:focus-within{ border-color:${ui.borderStrong} }
.csw-chan[data-bad="true"]{ border-color:${ui.danger} }
.csw-chan-ic{ color:${ui.muted}; display:flex; justify-content:center; padding-top:10px }
.csw-chan > div > div:last-child{ margin-bottom:0 !important }

/* ---- cargos ------------------------------------------------------------- */
.csw-role{ background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; padding:11px 12px; transition:opacity .15s, border-color .15s }
.csw-role:focus-within{ border-color:${ui.borderStrong} }
.csw-role[data-on="false"]{ opacity:.6 }
.csw-role-top{ display:flex; align-items:center; gap:10px }
/* O campo de nome ocupa a linha inteira e o text-field padrão tem altura de
   formulário; em uma lista de 3 cargos isso vira três caixas gigantes. Aqui ele
   fica compacto, sem label, alinhado ao checkbox. */
.csw-role-name{ flex:1; min-width:0 }
.csw-role-name input{ height:32px; padding:5px 9px; font-size:13px; font-weight:700 }
.csw-role-top input[type="checkbox"]{ appearance:none; -webkit-appearance:none; margin:0; width:18px; height:18px; flex-shrink:0; cursor:pointer; border-radius:5px; border:1.5px solid ${ui.borderStrong}; background:${ui.input}; position:relative; transition:background .15s, border-color .15s }
.csw-role-top input[type="checkbox"]:checked{ background:${ui.accent}; border-color:${ui.accent} }
.csw-role-top input[type="checkbox"]:checked::after{ content:""; position:absolute; left:5px; top:2px; width:5px; height:9px; border:solid #fff; border-width:0 2px 2px 0; transform:rotate(45deg) }
.csw-role-top input[type="checkbox"]:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.csw-role-dot{ width:11px; height:11px; border-radius:50%; flex-shrink:0; box-shadow:0 0 0 3px rgba(255,255,255,.05) }
/* A descrição alinha com o NOME (não com o checkbox): padding-left = checkbox
   (18) + gaps (10+10). Sem isso o texto ficava deslocado à esquerda. */
.csw-role-why{ font-size:11px; color:${ui.muted}; line-height:1.5; margin-top:7px; padding-left:38px }
.csw-check{ display:flex; align-items:center; gap:8px; font-size:12px; color:${ui.text}; cursor:pointer; padding:5px 7px; border-radius:6px; transition:background .15s }
.csw-check:hover{ background:${ui.surfaceHover} }
.csw-check input{ margin:0; width:15px; height:15px; flex-shrink:0; cursor:pointer; accent-color:${ui.accent} }
.csw-check:focus-within{ box-shadow:0 0 0 2px ${ui.accent}66 }
.csw-perms{ display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:2px; margin-top:10px; padding-top:10px; border-top:1px solid ${ui.border} }

/* ---- barra de etapas ---------------------------------------------------- */
.csw-seg{ appearance:none; cursor:pointer; background:transparent; border:0; padding:0; display:flex; flex-direction:column; gap:7px; min-width:0; text-align:left; font:inherit }
.csw-seg-bar{ height:3px; border-radius:99px; background:${ui.input}; transition:background .18s; width:100% }
.csw-seg:hover:not(:disabled) .csw-seg-bar{ background:${ui.borderStrong} }
.csw-seg[data-state="done"] .csw-seg-bar{ background:${ui.success} }
.csw-seg[data-state="now"] .csw-seg-bar{ background:${ui.accent} }
.csw-seg:focus-visible{ outline:2px solid ${ui.link}; outline-offset:3px; border-radius:4px }
.csw-seg:disabled{ cursor:default }
.csw-seg-l{ display:flex; align-items:center; gap:6px; font-size:11px; font-weight:700; color:${ui.muted}; min-width:0; transition:color .15s }
.csw-seg[data-state="now"] .csw-seg-l{ color:${ui.heading} }
.csw-seg[data-state="done"] .csw-seg-l{ color:${ui.text} }
.csw-seg-n{ width:17px; height:17px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:9px; font-weight:800; flex-shrink:0; background:${ui.input}; color:${ui.muted}; transition:background .15s, color .15s }
.csw-seg[data-state="done"] .csw-seg-n{ background:rgba(35,165,89,.22); color:#a5e5bd }
.csw-seg[data-state="now"] .csw-seg-n{ background:var(--csw-accent, ${ui.accent}); color:#fff }
.csw-seg-t{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap }

/* ---- utilitários -------------------------------------------------------- */
.csw-cap{ font-size:11px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; color:${ui.muted}; margin:0 0 ${ui.sm}px }
.csw-falta{ font-size:12px; color:#ffe0a3; line-height:1.5; display:flex; gap:7px; align-items:flex-start }
.csw-prev{ display:flex; align-items:center; gap:${ui.md}px; background:${ui.surface}; border:1px solid ${ui.border}; border-radius:12px; padding:13px 14px; margin-bottom:${ui.md}px }
.csw-prev-ic{ width:44px; height:44px; border-radius:13px; flex-shrink:0; display:flex; align-items:center; justify-content:center; background:rgba(88,101,242,.2); color:#fff }
.csw-prev-body{ min-width:0; flex:1 }
.csw-prev-n{ display:block; font-size:14px; font-weight:800; color:${ui.heading}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.csw-prev-d{ display:block; font-size:11px; color:${ui.muted}; line-height:1.45; margin-top:3px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical }
.csw-count{ font-size:11px; color:${ui.muted}; text-align:right; margin-top:6px; font-variant-numeric:tabular-nums }
.csw-done{ display:flex; flex-direction:column; align-items:center; text-align:center; gap:${ui.md}px; padding:${ui.lg}px 0 ${ui.xl}px }
.csw-done-ic{ width:68px; height:68px; border-radius:22px; display:flex; align-items:center; justify-content:center; background:rgba(35,165,89,.18); color:#a5e5bd }
.csw-side-box{ background:${ui.surface}; border:1px solid ${ui.border}; border-radius:12px; padding:13px 14px; margin-bottom:${ui.md}px }
.csw-side-t{ font-size:10px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; color:${ui.muted}; margin-bottom:9px; display:flex; align-items:center; gap:6px }
.csw-tag{ display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700; border-radius:99px; padding:3px 9px; background:${ui.input}; border:1px solid ${ui.border}; color:${ui.text} }
.csw-list{ display:flex; flex-direction:column; gap:5px }
.csw-li{ display:flex; align-items:center; gap:7px; font-size:12px; color:${ui.text}; min-width:0 }
.csw-li span{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.csw-li-i{ color:${ui.muted}; flex-shrink:0; display:flex }
.csw-empty{ font-size:12px; color:${ui.muted}; line-height:1.5 }

/* Abaixo de 860px a coluna de 268px rouba a largura do conteúdo: o resumo desce
   para baixo (order:2) em vez de sumir, porque é ele que mostra a contagem de
   canais e cargos que a pessoa está criando. */
@media (max-width: 860px) {
  .csw-cols{ grid-template-columns:minmax(0,1fr); gap:${ui.lg}px }
  .csw-side{ position:static; order:2 }
  .csw-models{ grid-template-columns:minmax(0,1fr) }
}
/* 560px: 4 colunas de canal não cabem. Tipo e categoria descem para a linha de
   baixo; o nome fica com o espaço que sobrar. */
@media (max-width: 560px) {
  .csw-chan{ grid-template-columns:24px minmax(0,1fr) 32px }
  .csw-chan-ic{ grid-row:1 }
  .csw-chan-name{ grid-column:2 / 4 }
  .csw-chan-kind{ grid-column:1 / 2 }
  .csw-chan-cat{ grid-column:1 / 3 }
  .csw-chan-del{ grid-column:3; grid-row:1 }
  .csw-cats{ grid-template-columns:minmax(0,1fr) }
  .csw-perms{ grid-template-columns:minmax(0,1fr) }
  .csw-seg-t{ display:none }
  .csw-step-head{ gap:${ui.sm}px }
}
`
