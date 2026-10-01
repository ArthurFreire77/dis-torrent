# DESIGN_SYSTEM — Resumo dos 6

Todos em `src/designs/ThemeShell.tsx:4` tokens. Troca via CSS vars + condicional.

| Design | Bg | Sidebar | Accent | Radius | Fonte | Diferença layout |
|--------|----|---------|--------|--------|-------|------------------|
| NEXUS | #070b14 | #0e1426 | #00e5cc | 14 | Inter | glow, glass |
| AURORA | #f6f7f9 | #fff | #111 | 16 | Inter | top nav clean, bolhas |
| FORGE | #13151a | #1a1d23 | #ff6b35 | 6 | JetBrains Mono | denso, admin |
| PULSE | #0c0c12 | #17171f | #ff006e | 20 | Space Grotesk | gradientes, cards |
| VEIL | #0a1014 | #0f1a1f | #10b981 | 10 | Inter | fingerprint+E2E |
| IGUAL | #1e1f22 | #2b2d31 | #5865ea | 8 | Inter | flat discord |

Cada possui: cores, tipografia, espaçamento 8/12/16, sombras, avatares 40/32, presence dot, badges, composer, reactions, embed, estados (hover/active/focus 150ms).

Mobilidade: `@media(max-width:900px)` esconde rail; composer fixo.
