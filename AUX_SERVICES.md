# SERVIÇOS AUXILIARES — o que é opcional, por quê e como auto-hospedar

Princípio: **o produto funciona sem NENHUM serviço externo na LAN.** Infraestrutura auxiliar existe só para casos específicos e é sempre explícita e substituível.

## Fase atual (LAN P2P) — ZERO infraestrutura

| Função | Como funciona sem serviço |
|---|---|
| Descoberta | UDP broadcast na rede local (porta 45900) |
| Conexão | TCP direto entre os dois apps |
| Cifra | E2E no protocolo (X25519+ChaCha20Poly1305) |
| Storage | SQLite local |

**Nada passa por servidor da FORGE ou de terceiros.**

## Fase internet P2P (próxima)

| Serviço | Necessário porque | O que observa | Como auto-hospedar / trocar |
|---|---|---|---|
| **STUN** | Descobrir seu IP/porta público atrás de NAT p/ hole-punching UDP (WebRTC/QUIC) | Seu IP público e momento da consulta — **não** conteúdo | `coturn` num VPS qualquer; endpoint configurável no app |
| **Rendezvous/bootstrap** (DHT ou nó anunciador) | Dois peers que nunca se viram precisam se achar na internet | Fingerprint + endereço anunciado; timestamps | libp2p rendezvous ou Kademlia DHT público; pode rodar o próprio nó num VPS |
| **DCUtR hole-punching** | Abrir furo em NAT simétrico duplo | Coordenado entre os dois peers (relay só encaminha mensagens de coordenação) | Embutido no protocolo, sem infra própria |
| **Relay (circuit-v2)** | Fallback quando hole-punch falha (~10-20% dos NATs) | Tráfego cifrado E2E passa por ele; vê IPs e volume, não conteúdo | `libp2p relay` self-hosted; o app pode DESABILITAR relay por configuração |
| **TURN** | Último recurso de mídia (voz/vídeo) quando até relay lógico falha | Tráfego RTP relayado (DTLS — ilegível para o TURN) | `coturn` com credenciais efêmeras |

## Regras duras

1. Nenhum endpoint auxiliar é **hardcoded obrigatório** — todos configuráveis (`settings`), com padrão público documentado aqui.
2. O app funciona 100% offline/LAN. Recursos de internet degradam graciosamente: sem STUN/rendezvous → só peers conhecidos por endereço manual.
3. Nada de "P2P falso": se um dado precisar passar por relay, o estado da conexão mostra `RELAYED` (fase internet).
4. Metadados mínimos: endpoints auxiliares nunca recebem corpos de mensagem (sempre E2E).
