# Servidores: público × privado

**Atualizado em 2026-11-04.** Como um servidor decide quem entra, onde a regra
mora no código e o que ela **não** promete.

## A escolha

O servidor tem um campo `is_public` no banco (`communities.is_public`):

| Valor | Quem entra | Como |
|---|---|---|
| `0` (padrão) | só quem tem convite | token assinado pelo dono |
| `1` | qualquer pessoa | `JoinCommunity` **sem token** |

O padrão é **privado** — inclusive para banco antigo, cliente antigo e frame
antigo sem o campo (`#[serde(default)]` em `SecureFrame::CommunityState`). Nada
abre por omissão.

## Onde se escolhe

1. **Criação** → passo *Identidade* → interruptor **Servidor público**
   (`PublicToggle` em `src/components/server/wizardSteps.tsx`, campo `isPublic`
   em `CreateCommunityOptions`).
2. **Depois** → Configurações do servidor → *Visão geral* → card **Quem pode
   entrar**. Só o dono muda (`require_owner` no core), e o estado novo vai para
   todos os membros na mesma hora (`broadcast_community_state`).

O resumo lateral do assistente mostra a escolha em texto, para não criar um
servidor aberto sem perceber.

## Entrar num servidor público

`src/services`: `joinPublicCommunity(hostFp, communityId)`.

- O host precisa aceitar a chamada; o pedido vai por `JoinCommunity` com
  **token vazio**.
- O core confere `community_is_public`. Se for privado, responde
  `este servidor é privado — peça um convite` (nunca aceita em silêncio).
- Do lado de quem entra, o `CommunityState` é aceito quando o pending join está
  vazio **e** quem mandou é o dono (`peer_fp == owner_fp`): o dono assina o
  próprio estado, então não há como um terceiro forjar a entrada.

## Rate limit (o "com rate limit" do pedido)

Servidor público **não** é porta aberta para script. Cada peer tem um balde
próprio (`NetLimiter::allow_public_join`):

| Parâmetro | Padrão | Env |
|---|---|---|
| tentativas por 10 s | 6 | `DISTORRENT_LIMIT_JOIN_10S` |
| burst | 3 | `DISTORRENT_LIMIT_JOIN_BURST` |

Estourou → `muitas tentativas de entrada — aguarde um pouco`, e o contador
`join_attempt` sobe em `RejectedCounters` (aparece no diagnóstico de rede).
Os demais limites (frames, bytes, chamadas, arquivos) continuam valendo igual:
entrar não dá passe livre para flood de mensagem.

## O que NÃO muda

- **Convite continua funcionando** em servidor público: é o caminho normal para
  mandar para um amigo.
- **Aprovação/aceite do dono é só do privado.** Em público não existe fila de
  aprovação — a pessoa entra direto. Em privado, quem não é dono nem membro cai
  em `membro não autorizado como seed deste servidor` e precisa do convite.
- **Descoberta não é automática.** Marcar público não publica o servidor num
  diretório: para entrar, a pessoa precisa do **fingerprint do dono** e do **ID
  do servidor** (o mesmo `id` que aparece em *Visão geral → Informações
  técnicas*). Criar um diretório/busca de servidores é trabalho separado.
- **Banir/expulsar continua valendo.** Público muda quem *entra*, não quem *fica*.

## Como testar

1. Máquina A cria um servidor com o interruptor **ligado**; anote dono + ID.
2. Máquina B: *Entrar* → **Servidor público** → cola os dois campos → entra sem
   convite.
3. Em A, desligue o interruptor. B (uma instalação nova) recebe "privado —
   peça um convite".
4. Dispare 10 joins seguidos de B para A: a partir do limite, a resposta é
   "muitas tentativas".
