# SERVIÇOS AUXILIARES — o que é opcional, por quê e como auto-hospedar

Princípio: **o produto funciona sem nenhum serviço externo na LAN.**
Infraestrutura auxiliar existe só para casos específicos e é sempre explícita,
opcional e substituível.

## Estado atual

Toda a pilha de rede já está implementada e **nenhuma peça é obrigatória**:

| Função | Sem serviço externo | Como está implementado |
|---|---|---|
| Descoberta LAN | UDP broadcast + mDNS | `net/discovery.rs` — 7 alvos de broadcast, porta 45900 |
| Conexão | TCP direto entre os dois apps | `net/transport.rs` |
| Cifra | E2E no protocolo | `net/transport.rs` — transcript ed25519 + X25519 + HKDF → ChaCha20Poly1305 |
| Storage | SQLite local (WAL) | `storage.rs` |
| IP público | NAT-PMP e UPnP no roteador | `net/natpmp.rs` — abre a porta sozinho |
| Endereço reflexive | STUN | `net/stun.rs` |
| Atravessar NAT | Hole punching com frame de coordenação próprio | `net/engine.rs` |
| Achar peer distante | DHT mainline | `net/dht.rs` |
| Fallback de mídia | Relay (LMTP sobre MQTT) e TURN configurável | `net/relay.rs` |
| Mídia | WebRTC nativo (Linux) / WebRTC do navegador (resto) | `net/media_voice.rs` |
| Torne virtual por peer | Túnel com IP determinístico `fd9d::/64` | `net/vtunnel.rs` |

**Não há libp2p, QUIC nem circuit-v2 neste projeto.** A stack de rede é própria,
sobre tokio. **Nada passa por servidor da FORGE ou de terceiros** — não existe
padrão embutido para nenhum endpoint auxiliar, inclusive o tracker HTTP, que roda
desligado até você apontar `FORGE_BOOTSTRAP_URL` para o seu.

## O que ainda pode precisar de infraestrutura

| Serviço | Quando é preciso | O que ele observa | Como auto-hospedar |
|---|---|---|---|
| **Tracker HTTP** | Quer que peers te achem sem ser amigo de ninguém na LAN. Desligado por padrão | fingerprint, IP público, nickname, porta | `host --bootstrap PORTA` — o Community Host é o tracker |
| **Broker MQTT** | Quer mais resiliência de announce/relay que o tracker dá | fingerprint + endpoint anunciado (nunca corpo de mensagem) | Broker MQTT qualquer (Mosquitto, EMQX); o ponto é configurável |
| **STUN** | Atrás de NAT simétrico, para obter o IP reflexive | IP público e momento da consulta — **não** conteúdo | `coturn` num VPS; o endpoint é configurável |
| **TURN** | Mídia quando o ICE não fecha atrás de CGNAT simétrico duplo | Volume e IPs; o RTP vai em DTLS (ilegível para o TURN) | `coturn`, com credenciais |

## Regras duras

1. Nenhum endpoint auxiliar é obrigatório e nenhum tem padrão embutido. Todos são
   configuráveis por variável de ambiente — ver [`.env.example`](.env.example).
2. O app funciona 100% em LAN e offline. Sem tracker, sem relay, sem broker, sem
   STUN — os peers que se conhecem continuam conversando direto.
3. Recursos de internet degradam com honestidade: sem STUN/hole punching, o estado
   da conexão mostra `RECONNECTING`/`OFFLINE`, nunca um "conectado" falso.
4. Metadados mínimos: endpoints auxiliares **nunca** recebem corpos de mensagem.
   O tráfego é cifrado E2E antes de sair do processo.
5. Kill-switches: `FORGE_NO_RELAY`, `FORGE_NO_TUNNEL`, `FORGE_NO_ANNOUNCE`,
   `FORGE_NO_DHT` derrubam cada peça isoladamente para depurar.