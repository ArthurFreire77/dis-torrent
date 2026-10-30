// Componentes da CAMADA SOCIAL v3 — paridade Discord.
//
// ## O que mudou (e por que)
//
// Este arquivo tinha 1508 linhas e 27 exports: tema, primitivas, reações,
// perfil, busca, moderação, eventos, atalhos, inbox. Qualquer ajuste no modal de
// perfil arriscava a paleta de comandos, e achar onde mora uma coisa exigia
// rolar mil linhas.
//
// Agora cada assunto tem seu módulo:
//   - `socialTheme.tsx`           tema, presença, formatação de tempo;
//   - `socialPrimitives.tsx`      RichText, Avatar, Modal, Field, botões;
//   - `socialReactions.tsx`       barra/popover/seletor de reação;
//   - `socialMessages.tsx`        divisores de data e de não lidas;
//   - `socialHooks.tsx`           atalhos e paleta de comandos;
//   - `socialProfile.tsx`         modal de perfil;
//   - `socialSearchPanels.tsx`    busca, fixadas, enquete, threads;
//   - `socialModeration.tsx`      moderação e eventos;
//   - `socialChannelSettings.tsx` slowmode/NSFW/emoji do canal;
//   - `socialInbox.tsx`           mensagens salvas e inbox.
//
// Este arquivo continua sendo a PORTA DE ENTRADA: reexporta os mesmos 27 nomes,
// então nenhum importador (`ThemeShell`, `MobileShell`, `MessageList`) mudou.
// Todos consomem `services` (nativo OU browser): a UI não sabe a diferença e
// nunca decide permissão — quem valida é o motor.

export * from './socialTheme'
export * from './socialPrimitives'
export * from './socialReactions'
export * from './socialMessages'
export * from './socialHooks'
export * from './socialProfile'
export * from './socialSearchPanels'
export * from './socialModeration'
export * from './socialChannelSettings'
export * from './socialInbox'
