# Pesquisa Profunda — Como o Discord Real Funciona (2025-2026)

> Base: interface desktop estável + prints fornecidos (DM e Servidor JWAGNERVAZ) + comportamento mobile. Objetivo: extrair princípios de UX/arquitetura, não cópia visual.

## 1. Anatomia Macro (Desktop - 4 Colunas + Header)

```
+----+---------+---------------------------+----------+
| S  |  NAV2   |           MAIN              |  MEMBERS |
| E  | (240px) |        (flex:1)             | (240px)  |
| R  |         | [header][chat][composer]    | opcional |
| V  |(lista)  |                             | perfil   |
+----+---------+---------------------------+----------+
  72px
```

- **Coluna 0 - Server Rail (72px)**: lista vertical scrollável de servidores/comunidades + Home + DMs + Add Server + Discovery. Cada item é avatar circular → squircle on hover/select. Badge vermelho de notificações/menções. Separador. Estado online do sistema. Drag para reordenar + pastas.
- **Coluna 1 - Contextual (240px)**: muda totalmente conforme contexto. Em `Amigos/DMs`: searchbar + tabs (Amigos/Nitro/Loja/Missões) + seção Mensagens Diretas com lista de DMs/Grupos (avatar + nome + subtítulo + status + unread dot). Em `Servidor`: header do servidor (nome + dropdown + invite/convite + members) + canais + categorias colapsáveis + footer de voz (usuário + mute/deafen + config).
- **Coluna 2 - Main (flex)**: Header da conversa/canal (icone #/🔊, nome, tópico, actions: thread, bell, pin, members, inbox, help + search). Feed de mensagens virtualizado (windowing). Divisores de data ("15 de abril de 2026" + linha vermelha NOVO). Composer na base.
- **Coluna 3 - Lateral Direita (240-340px)**: Perfil/Info do usuário selecionado em DM (banner + avatar + nickname + mutuals + member since) ou lista de membros do servidor agrupada por cargo (Online/Offline). Pode ser colapsada.

**Header Global**: título central "Mensagens diretas" ou nome do servidor, window controls (min/max/close), help, inbox.

**Footer do usuário (coluna 1 base)**: avatar + nickname + status "Invisível" + mic/headphone + config.

## 2. Tela de Amigos / DMs (Print 1)

- **Tabs superiores**: Online, Todos, Pendente, Bloqueado, Adicionar Amigo — com contadores.
- **Barra de busca** "Encontre ou comece uma conversa" — filtro instantâneo.
- **Lista de DMs**: row 44px, avatar 32px + presence ring (🟢🟡🔴⚫), nome bold, subtítulo "4 membros" para grupos, badge unread vermelho (ex: 1,2,3...117), hover com bg #2b2d31, selected com gradiente/ativo.
- **Chat DM**: bolha implícita (sem borda), avatar 40px à esquerda, header nome+timestamp 13:33, conteúdo markdown (texto, code block, imagem, link). Agrupamento por autor/tempo (mensagens seguidas sem repetir avatar/header). Actions on hover: emoji, reply, forward, more, react.
- **Composer DM**: `+` attach + input "Conversar em @Rafa" + gift/GIF/sticker/emoji/app buttons. Typing indicator.

## 3. Tela de Servidor/Comunidade (Print 2)

- **Header servidor**: "JWAGNERVAZ ▾" + ícone de membros.
- **Canais**: categorias com prefixo `━━ 📁 GERAL ━━ ▾` colapsáveis. Cada canal: `#` hash + nome com prefixos emoji (ex: `🔊· boas-vindas`, `💬· bate-papo` com badge 90, `🔔· anuncio-geral` 8). Canais de voz com ícone 🔊/🎙. Canais travados mostram lock.
- **Unread**: bolinha branca à esquerda + badge vermelho à direita (ex: bate-papo 90). Canal selecionado: bg #2b2d31 + texto branco.
- **Main canal**: ícone `#` grande circular + "Bem-vindo(a) a #📞· atendimento!" + subtítulo. Separador de data com linha vermelha. Mensagem de APP (Sapphire BOT) com embed: borda esquerda azul, título, texto, imagem thumbnail, dropdown "Selecione seu pedido".
- **Composer bloqueado**: "Você não tem permissão para enviar mensagens neste canal." — bg desabilitado. Importante: feedback de permissão por canal/cargo.
- **Busca do servidor**: "Buscar JWAGNERVAZ" no header direito + ícones de threads, notificações, pins, members.

## 4. Sistema de Mensagens (Core)

- **Blocos**: text + markdown (bold/italic/code/inline code/quote + `>>>`), code block com syntax highlight, embed/card, attachment (imagem, vídeo, arquivo), invite card, reply reference (linha conectando), thread starter, system message (ex: Clyde APP - economia de banda).
- **Agrupamento**: mensagens do mesmo autor em <7min agrupadas.
- **Reações**: emoji + contador, add picker on hover.
- **Resposta**: quote acima do input + highlight.
- **Threads**: painel lateral deslizante ou sub-feed; indicador "3 respostas".
- **Estados**: sending (cinza), sent, edited (label), failed (vermelho + retry), deleted.

## 5. Canais e Voz/Vídeo

- **Texto**: # canal-texto, # canal-anúncios (follow), # fórum, # stage
- **Voz**: 🔊 canal-voz (mostra avatares conectados + mute/deaf/speaking ring verde). Ao entrar: painel inferior com controles + tiles de vídeo. Compartilhamento de tela: tile grande + thumbnails.
- **Chamada DM/Grupo**: mesmos tiles + convite por link.
- **Atividades**: overlay de jogos/apps.

## 6. Presença, Perfis e Social

- **Presence**: online (verde), idle (lua amarela), dnd (vermelho), invisible/offline (cinza), streaming (roxo). Dot 10px no canto do avatar + anel.
- **Perfil**: banner (cor/imagem) + avatar 80-92px com status ring + badges (Nitro, Boost, nivel) + display name + username + bio + mutual friends (2 amigos mútuos) + member since + roles (cor). Modal vs sidebar.
- **Status custom**: emoji + texto.
- **Amigos**: lista com actions (mensagem, chamada, mais). Solicitações com aceitar/recusar.

## 7. Notificações, Badges e Busca

- **Badge global**: no server rail + canal + bubble no título da janela.
- **Menciones**: @everyone, @here, @role (bg amarelo), @user, reply ping.
- **Inbox**: central de menções não lidas + threads + reações.
- **Busca**: full-text com filtros `from:`, `in:`, `mentions:`, `has:image`, `before:/after:` . Resultados com jump-to.
- **Atalhos**: Ctrl+K quick switcher (fuzzy finder de servidores/canais/DMs), Ctrl+Shift+M mute, etc.

## 8. Cargos, Permissões e Moderação

- **Roles**: cor, ícone, hierarquia, hoist (mostrar separado na lista de membros), mentionable.
- **Permissões**: bitwise por canal/categoria/role/overwrite (ver/enviar/moderar/conectar/falar). UI de toggles.
- **Moderação**: timeout, kick, ban, slowmode, AutoMod, audit log, convites com expiração/usos.

## 9. Convites, Threads, Emojis

- **Convite**: link `discord.gg/xxx` com preview (nome, members online, expiração).
- **Emoji**: Unicode + Custom (estático/animado) + reações.
- **Threads**: temporárias ou permanentes, arquivamento.
- **Resposividade**: Desktop 4 colunas; Tablet colapsa members; Mobile bottom nav + drawer (gestos, swipe para canais, long-press menus). Mobile mantém Composer fixo + attachment sheet.

## 10. Por que funciona (Princípios a preservar)

1. **Navegação espacial estável**: server rail sempre visível → muscle memory.
2. **Contexto à esquerda, foco ao centro, detalhe à direita** — padrão IDE/editor.
3. **Densidade calibrada**: ~44px rows, 16px gaps, tipografia 14-16px, contraste alto mas não puro preto/branco (cinzas #313338 bg).
4. **Feedback imediato**: hover/active/focus em 100ms, transições 150-200ms, skeletons em vez de spinners.
5. **Hierarquia por peso visual, não só cor**: badges vermelhos só para alerta; resto monocromático.
6. **Estados vazios úteis** (ex: welcome do canal) ensinam ao invés de só "sem mensagens".
7. **Virtualização + cache** para 10k+ mensagens sem lag.

## 11. O que NÃO copiar

- Logo, fonte proprietária (Ginto/Whitney), blurple #5865F2 literal, ícone do Discord, nomes "Nitro", "Clyde".
- Layout pixel-perfect. Vamos reinterpretar com identidade própria.
