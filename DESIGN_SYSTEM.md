# DESIGN_SYSTEM

O design é **único e congelado**. Este documento é referência, não guia de
mudança — ver [`CONTRIBUTING.md`](CONTRIBUTING.md) regra 1.

> Fork de seis variantes (NEXUS, AURORA, FORGE, PULSE, VEIL, IGUAL) existiram
> durante o desenvolvimento. A variante escolhida foi a **IGUAL** e as outras
> foram descartadas; o que está em produção é o tema único abaixo.

## Tokens

Todos os tokens de cor vivem em um único objeto, em
`src/designs/ThemeShell.tsx` (bloco `const t = { … }`):

| Grupo | Tokens |
|---|---|
| Superfícies | `rail` `#1e1f22` · `sidebar` `#2b2d31` · `main` `#313338` · `composer` `#383a40` |
| Controles | `input` `#1e1f22` · `hover` `#35373c` · `selected` `#404249` · `border` `#26272b` |
| Painéis | `panel` `#2b2d31` · `footer` `#232428` |
| Acento | `accent` `#5865f2` · `accentHover` `#4752c4` · `link` `#00a8fc` |
| Semântica | `green` `#23a559` · `yellow` `#f0b232` · `red` `#f23f42` |
| Texto | `text` `#dbdee1` · `heading` `#f2f3f5` · `muted` `#949ba4` |
| Tema claro | `lbg` `#ffffff` · `lsidebar` `#f2f3f5` · `lrail` `#e3e5e8` · `ltext` `#060607` · `lmuted` `#5c5e66` · `lborder` `#e3e5e8` · `linput` `#ebedef` |

Os shells desktop e mobile **duplicam** esses tokens localmente
(`src/mobile/MobileShell.tsx`) em vez de importar de um módulo comum. É dívida
conhecida: um token novo precisa ser adicionado em dois lugares.

## Tipografia

Carregadas pelo Google Fonts em `index.html`:

| Família | Pesos | Uso |
|---|---|---|
| Inter | 400, 500, 600, 700 | texto e UI |
| JetBrains Mono | 400, 600 | código, logs, identifiers |
| Space Grotesk | 500, 700 | títulos displays |

## Escala e métricas

Espaçamento em múltiplos de 4/8/12/16. Avatares: 40 px (completo), 32 px
(compacto). Raio de canto: 8 px (padrão), 16 px nos cards maiores, `999px` em
badges e pills.

Transições: 150 ms em hover/active/focus, 200 ms em transforms da rail.
`@media (prefers-reduced-motion: reduce)` desliga animação e transição
globalmente (`src/styles/global.css`).

## Breakpoints

| Largura | Comportamento |
|---|---|
| ≤ 860 px | Coluna de membros some; painel lateral vira overlay (`global.css`) |
| ≤ 768 px | Rail colapsa; o app passa a usar o `MobileShell` (`global.css`) |

## Ícones

SVG inline em `src/shared/icons.tsx`. Sem biblioteca de ícones — o conjunto é
fechado e versionado junto com a UI.