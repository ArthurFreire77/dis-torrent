# DisTorrent — comunicação P2P descentralizada

DisTorrent é um aplicativo de comunicação **local-first e P2P**: identidade
criptográfica própria (ed25519), mensagens diretas e em canal assinadas e
cifradas fim-a-fim entre peers, histórico persistido localmente em SQLite.
**Sem servidor central, sem cadastro, sem email, sem telefone.**

Design congelado — `src/designs/ThemeShell.tsx` + `src/shared/icons.tsx`.

## O que é REAL (verificado por testes automatizados)

- **Identidade local estável**: par ed25519 gerado no primeiro uso; fingerprint
  = `blake3(pubkey)[..12]` — **imutável** e sobrevive a reinícios, exportação e
  troca de dispositivo. Chave privada no keyring do SO ou cofre com senha (Argon2id).
- **P2P direto pela internet**: TCP autenticado (handshake ed25519 + X25519
  efêmero + ChaCha20Poly1305), **UPnP** automático, **bootstrap HTTP** para
  achar amigos pelo fingerprint, SOCKS5/Tor opcional. LAN via UDP broadcast.
- **Amigos**: pedido → aceite → recusa → remover → bloquear, tudo via frames
  assinados; offline fica enfileirado e sai ao reconectar.
- **Mensagens DM e Grupo**: ACK criptográfico de entrega, outbox persistente
  (pendente → enviado → entregue), grupos sincronizados (GroupCreated) com
  re-sincronização na reconexão.
- **Servidores**: criar/entrar por convite assinado com expiração; **canais**
  (criar/renomear/tópico/categoria/excluir, texto e voz), **cargos** com
  permissões, **bots** com token, **kick** — tudo persistido no SQLite e
  sincronizado do dono para os membros (CommunityState/CommunityKicked).
- **Chamadas/voz**: sinalização WebRTC (offer/answer/ICE) pelo túnel P2P.
- **Arquivos**: swarm estilo torrent (chunks 256KB, hashes blake3, todos semeiam).
- **Privacidade**: 4 modos reais — Sem segurança / Seguro (E2E) / Seguro +
  (proxy SOCKS5, desliga discovery+announce) / Tor 7 nós.
- **Estados verdadeiros**: `CONECTADO/CONECTANDO/RECONECTANDO/OFFLINE` e
  `pendente/enviando/enviado/entregue` — nada de texto fixo.

## Testes

```bash
cd forge-core && cargo test      # 34 testes — incluindo E2E: 2 usuários completos
                                 # conversando através de um PROXY TCP (redes distintas):
                                 # amizade, DM, grupo, comunidade, canais, cargos,
                                 # kick, queda de rede e reconexão, identidade estável
npm run typecheck && npm run lint && npm run build
```

Screenshots de auditoria da UI: `docs/screenshots/audit/`.

## Rodar

Instruções completas em [EXECUTAR.md](EXECUTAR.md). Resumo:

```bash
npm install
npm run dev          # navegador (sem rede P2P — honesto)
npm run tauri:dev    # app nativo com motor P2P real
```

Conexão pela internet: direta quando o NAT permite (UPnP + bootstrap pelo
fingerprint). Em rede móvel/CGNAT (4G/5G) o ICE usa STUN (candidato `srflx`) e
TURN (candidato `relay`) como rotas de reserva — a mídia continua WebRTC
criptografado de ponta a ponta entre os peers; o TURN só encaminha os pacotes.
**Não há fallback de áudio pelo túnel P2P**: se a rota não fechar, a chamada
reinicia o ICE até um orçamento fixo e depois encerra com aviso honesto, em vez
de ficar em "Conectando…" para sempre. Dois peers atrás de CGNAT **simétrico**
sò fecham via TURN — se também cair o TURN, nenhum software resolve, é
limitação de rede. `ip:porta`/`dominio:porta` manual fica em Configurações →
Avançado.

## Segurança

E2E por design nas conversas. Sem senhas/e-mail (pseudonimidade por chave).
Limitações honestas (IP visível ao peer, tokens de bot no sync, etc.):
[THREAT_MODEL.md](THREAT_MODEL.md). Reporte vulnerabilidades: [SECURITY.md](SECURITY.md).

## Licença

MIT — ver LICENSE.
