//! DHT lite + PEX (Peer Exchange) — Internet P2P sem IP manual.
//! Quando o usuário não tem tracker e não está na mesma LAN, peers conectados
//! trocam listas de peers conhecidos (gossip). Assim, se A conhece B e B conhece C,
//! A aprende sobre C via B — rede se auto-descobre sem central obrigatório.
//! Complementa UPnP + bootstrap tracker quando disponíveis.

use std::sync::Arc;
use std::time::Duration;
use tokio::time::interval;
use tracing::debug;

use crate::net::engine::NetworkEngine;

/// Inicia gossip PEX: a cada 20s, cada peer online recebe lista de até 10 peers
/// conhecidos do local (exceto ele mesmo). Receptor valida e tenta conectar nos
/// FPS que ainda não tem sessão.
pub async fn spawn_pex(engine: Arc<NetworkEngine>) {
    let mut tick = interval(Duration::from_secs(20));
    let cancel = engine.cancel_subscribe();
    loop {
        if engine.is_cancelled(&cancel) {
            return;
        }
        tick.tick().await;
        // privacidade: em proxy/full não gossipamos IPs
        let mode = engine.privacy_mode();
        if matches!(mode.as_str(), "proxy" | "full") {
            continue;
        }
        let known = engine.pex_peers(10);
        if known.is_empty() {
            continue;
        }
        // SEGURANÇA/PRIVACIDADE: só gossipa endereços para AMIGOS ACEITOS —
        // nunca para um peer conectado aleatório (evita vazar a peerlist).
        let online = engine.online_friend_fps();
        if online.is_empty() {
            continue;
        }
        debug!(peers=%known.len(), online=%online.len(), "PEX: compartilhando {} peers com {} online", known.len(), online.len());
        for fp in online {
            let peers_clone = known.clone();
            let frame = crate::protocol::SecureFrame::PeerExchange { peers: peers_clone };
            engine.send_to_peer(fp, frame);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DHT MAINLINE BITTORRENT (BEP-5) — descoberta 100% descentralizada
// ─────────────────────────────────────────────────────────────────────────────
/// Cada identidade vira um "infohash" na rede BitTorrent REAL:
/// `Id = blake3("forge-dht-v1:" + fingerprint)[..20]`.
/// O app ANUNCIA o próprio endpoint nesse infohash e faz `get_peers` no
/// infohash dos amigos — os nós da mainline DHT (milhões, sem dono, sem
/// servidor nosso) fazem o rendezvous. É o mecanismo de descoberta do
/// protocolo BitTorrent: nada de relay obrigatório, nada de API externa.
/// O handshake valida o fingerprint de qualquer jeito — endereço errado
/// nunca vira sessão trocada.
pub fn identity_infohash(fp: &str) -> mainline::Id {
    let h = blake3::hash(format!("forge-dht-v1:{fp}").as_bytes());
    let bytes: [u8; 20] = h.as_bytes()[..20].try_into().expect("blake3 gera 32B");
    mainline::Id::from_bytes(bytes).expect("Id aceita 20B")
}

/// Opt-in de produção: os BINÁRIOS (app Tauri / forge-host) setam `FORGE_DHT=1`
/// no boot. Testes não setam → engines de teste nunca tocam na rede BitTorrent
/// (senão os e2e descobririam uns aos outros via DHT real e quebrariam a
/// eleição relay/direta determinística dos asserts).
/// `FORGE_NO_DHT=1` força OFF mesmo com FORGE_DHT (kill-switch de emergência).
pub fn bit_dht_enabled() -> bool {
    if matches!(
        std::env::var("FORGE_NO_DHT")
            .ok()
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    ) {
        return false;
    }
    matches!(
        std::env::var("FORGE_DHT")
            .ok()
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Loop principal da DHT BitTorrent (1 tarefa por engine):
/// - mantém um nó mainline vivo (UDP + bootstrap público);
/// - ANUNCIA o próprio endpoint a cada 60s (e no boot);
/// - `get_peers` nos infohashes dos amigos SEM sessão (fila urgente + rodízio,
///   rate-limit 20s/peer) e disca DIRETO nos endereços descobertos
///   (outbound-first, igual torrent);
/// - privacidade: em proxy/Tor a DHT fica OFF (UDP vazaria o IP) e o motivo
///   aparece no diagnóstico da UI.
pub async fn spawn_bit_dht(engine: Arc<NetworkEngine>) {
    if !bit_dht_enabled() {
        debug!("DHT BitTorrent: desligada via FORGE_NO_DHT");
        return;
    }
    let mut next_announce = 0i64;
    let cancel = engine.cancel_subscribe();
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if engine.is_cancelled(&cancel) {
            return;
        }
        // Modo anônimo: UDP/DHT vazaria o IP real — desliga e diz por quê.
        let mode = engine.privacy_mode();
        if matches!(mode.as_str(), "proxy" | "full") {
            engine.shutdown_bit_dht();
            engine.diag_record_net(|d| {
                d.dht_ok = Some(false);
                d.dht_ms = crate::identity::now_ms();
            });
            continue;
        }
        // Nó vivo (bind UDP + bootstrap). Erro = tenta de novo no próximo tick.
        if engine.ensure_bit_dht().is_err() {
            engine.diag_record_net(|d| {
                d.dht_ok = Some(false);
                d.dht_ms = crate::identity::now_ms();
            });
            continue;
        }

        let now = crate::identity::now_ms();
        // ANÚNCIO próprio: no boot e a cada 60s (announce_peer no infohash).
        // Só com porta EXTERNA confirmada (STUN/UPnP via `dht_announce_port`):
        // anunciar a TCP interna gera dials mortos — pior que não anunciar.
        if now >= next_announce {
            next_announce = now + 60_000;
            if let Some(port) = engine.dht_announce_port() {
                let eng = engine.clone();
                let own = identity_infohash(&engine.identity().fingerprint);
                let r = tokio::task::spawn_blocking(move || eng.bit_dht_announce(own, port)).await;
                if let Ok(Ok(())) = r {
                    engine.diag_record_net(|d| {
                        d.dht_ok = Some(true);
                        d.dht_ms = crate::identity::now_ms();
                    });
                }
            } else {
                debug!("DHT: sem endpoint externo confirmado — pulo o announce (lookup segue)");
            }
        }

        // LOOKUP: fila urgente primeiro; senão rodízio dos amigos sem sessão.
        let mut targets = engine.dht_queue_pop(16);
        if targets.is_empty() {
            targets = engine.friends_without_session(8);
        }
        for fp in targets {
            if !engine.dht_lookup_due(&fp, 20_000) {
                continue;
            }
            let eng = engine.clone();
            let fp = fp.clone();
            tokio::task::spawn_blocking(move || eng.bit_dht_lookup_and_dial(fp));
        }
    }
}
