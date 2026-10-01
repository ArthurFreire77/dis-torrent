//! Descoberta de peers em LAN: UDP broadcast periódico + escuta.
//! Sem servidor de bootstrap — peers se encontram na mesma rede.
//! Fase futura (internet): DHT/rendezvous documentados em AUX_SERVICES.md.

use std::net::SocketAddr;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};
use tracing::{debug, info, warn};

use crate::identity::Keypair;
use crate::Result;

pub const DISCOVERY_PORT: u16 = 45900;
const ANNOUNCE_INTERVAL_SECS: u64 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Announcement {
    pub proto: String,
    pub fp: String,
    pub pubkey_hex: String,
    pub nickname: String,
    pub tcp_port: u16,
    pub ts: i64,
}

#[derive(Debug, Clone)]
pub struct DiscoveredPeer {
    pub fp: String,
    pub pubkey_hex: String,
    pub nickname: String,
    pub addr: SocketAddr, // ip do anunciante + porta TCP dele
}

pub struct Discovery {
    pub local_addr: SocketAddr,
}

impl Discovery {
    /// Sobe UDP listener + broadcaster. `tx` recebe peers descobertos (não-eu).
    pub async fn spawn(
        keypair: Arc<Keypair>,
        nickname: String,
        tcp_port: u16,
        tx: mpsc::UnboundedSender<DiscoveredPeer>,
    ) -> Result<Self> {
        let bound = match UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)).await {
            Ok(s) => s,
            Err(e) => {
                // conflito com outra instância local: bind em porta efêmera
                // (a instância original ainda faz broadcast e nos encontrará)
                warn!("porta {DISCOVERY_PORT} ocupada ({e}); usando porta efêmera");
                UdpSocket::bind(("0.0.0.0", 0)).await?
            }
        };
        let socket = Arc::new(bound);
        socket.set_broadcast(true)?;
        let local_addr = socket.local_addr()?;
        info!(%local_addr, "discovery UDP ativo");

        // broadcaster
        {
            let socket = socket.clone();
            let keypair = keypair.clone();
            let nickname = nickname.clone();
            tokio::spawn(async move {
                let mut tick = interval(Duration::from_secs(ANNOUNCE_INTERVAL_SECS));
                loop {
                    tick.tick().await;
                    let ann = Announcement {
                        proto: crate::protocol::PROTOCOL_NAME.to_string(),
                        fp: keypair.fingerprint(),
                        pubkey_hex: keypair.public_hex(),
                        nickname: nickname.clone(),
                        tcp_port,
                        ts: crate::identity::now_ms(),
                    };
                    let payload = match serde_json::to_vec(&ann) {
                        Ok(p) => p,
                        Err(e) => {
                            debug!("serialização do anúncio falhou: {e}");
                            continue;
                        }
                    };
                    // 100% automático: broadcast em todas subnets + loopback + multicast.
                    // Extras via FORGE_DISCOVERY_BROADCASTS (ex. broadcast da
                    // subnet do ZeroTier/Radmin: "10.147.0.255:45900"): o
                    // broadcast limitado (255.255.255.255) sai pela rota padrão
                    // e NÃO alcança adaptadores virtuais de VPN — sem o alvo
                    // explícito, peers na LAN virtual nunca se descobrem.
                    let mut targets: Vec<(String, u16)> = [
                        ("255.255.255.255", DISCOVERY_PORT),
                        ("127.255.255.255", DISCOVERY_PORT),
                        ("224.0.0.1", DISCOVERY_PORT), // multicast local
                        ("192.168.1.255", DISCOVERY_PORT),
                        ("192.168.0.255", DISCOVERY_PORT),
                        ("192.168.100.255", DISCOVERY_PORT),
                        ("10.0.0.255", DISCOVERY_PORT),
                    ]
                    .iter()
                    .map(|(h, p)| (h.to_string(), *p))
                    .collect();
                    for extra in std::env::var("FORGE_DISCOVERY_BROADCASTS")
                        .unwrap_or_default()
                        .split(',')
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                    {
                        if let Ok(sa) = extra.parse::<SocketAddr>() {
                            targets.push((sa.ip().to_string(), sa.port()));
                        }
                    }
                    for target in &targets {
                        let addr = format!("{}:{}", target.0, target.1);
                        let _ = socket.send_to(&payload, addr.as_str()).await;
                    }
                }
            });
        }

        // listener
        {
            let socket = socket;
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match socket.recv_from(&mut buf).await {
                        Ok((n, from)) => {
                            let Ok(ann) = serde_json::from_slice::<Announcement>(&buf[..n]) else {
                                continue;
                            };
                            if ann.proto != crate::protocol::PROTOCOL_NAME {
                                continue;
                            }
                            if !crate::identity::fingerprint_matches(&ann.fp, &ann.pubkey_hex) {
                                debug!(%from, "anúncio com fingerprint inválido — ignorado");
                                continue;
                            }
                            let _ = tx.send(DiscoveredPeer {
                                fp: ann.fp,
                                pubkey_hex: ann.pubkey_hex,
                                nickname: ann.nickname,
                                addr: SocketAddr::new(from.ip(), ann.tcp_port),
                            });
                        }
                        Err(e) => {
                            debug!("udp recv erro: {e}");
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                    }
                }
            });
        }

        Ok(Self { local_addr })
    }
}
