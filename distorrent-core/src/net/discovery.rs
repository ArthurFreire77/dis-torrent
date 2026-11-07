use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};
use tracing::{debug, info, warn};

use crate::identity::Keypair;
use crate::net::netlimit::{Decision, NetLimiter};
use crate::Result;

pub const DISCOVERY_PORT: u16 = 45900;
const ANNOUNCE_INTERVAL_SECS: u64 = 2;

/// Grupo multicast do DisTorrent. Broadcast puro morre em Wi-Fi de escola e em
/// rede com isolamento de cliente; o multicast é a segunda rota e é o que faz
/// dois PCs do mesmo roteador se verem mesmo quando o broadcast é filtrado.
const DISCOVERY_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 42, 99);

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
    pub addr: SocketAddr,
}

/// Anúncio próprio, montado do estado local.
pub fn announcement(
    fp: &str,
    pubkey_hex: &str,
    nickname: &str,
    tcp_port: u16,
    ts: i64,
) -> Announcement {
    Announcement {
        proto: crate::protocol::PROTOCOL_NAME.to_string(),
        fp: fp.to_string(),
        pubkey_hex: pubkey_hex.to_string(),
        nickname: nickname.to_string(),
        tcp_port,
        ts,
    }
}

pub struct Discovery {
    pub local_addr: SocketAddr,
}

/// Endereços de broadcast REAIS das interfaces locais.
///
/// A lista fixa anterior (`192.168.1.255`, `192.168.0.255`, ...) só acertava
/// três faixas domésticas: um roteador em `192.168.100.0/24`, `10.150.0.0/16` ou
/// o Wi-Fi de uma escola nunca recebia o anúncio. Sem anúncio não há descoberta
/// e dois PCs no MESMO roteador ficavam invisíveis um para o outro.
fn broadcast_targets() -> Vec<SocketAddrV4> {
    let mut out: Vec<SocketAddrV4> = Vec::new();
    #[cfg(not(target_os = "android"))]
    {
        let Ok(ifaces) = if_addrs::get_if_addrs() else {
            return out;
        };
        for i in ifaces {
            let if_addrs::IfAddr::V4(v4) = i.addr else {
                continue;
            };
            if v4.ip.is_loopback() || v4.ip.is_link_local() || v4.ip.is_unspecified() {
                continue;
            }
            // /31 e /32 não têm endereço de broadcast útil.
            if v4.prefixlen >= 31 {
                continue;
            }
            let b = v4.broadcast.unwrap_or_else(|| {
                let ip = u32::from(v4.ip);
                let mask = u32::from(v4.netmask);
                Ipv4Addr::from(ip | !mask)
            });
            let target = SocketAddrV4::new(b, DISCOVERY_PORT);
            if !out.contains(&target) {
                out.push(target);
            }
        }
    }
    #[cfg(target_os = "android")]
    {
        if let Ok(ip) = local_ipv4() {
            let o = ip.octets();
            let b = Ipv4Addr::new(o[0], o[1], o[2], 255);
            out.push(SocketAddrV4::new(b, DISCOVERY_PORT));
        }
    }
    out
}

/// Endereço IPv4 local pela rota padrão (UDP connect não envia pacote).
#[cfg(target_os = "android")]
fn local_ipv4() -> std::result::Result<Ipv4Addr, ()> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|_| ())?;
    sock.connect("8.8.8.8:80").map_err(|_| ())?;
    match sock.local_addr().map_err(|_| ())? {
        std::net::SocketAddr::V4(a) => Ok(*a.ip()),
        _ => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcast_sai_da_mascara_e_nao_de_lista_fixa() {
        let ip = Ipv4Addr::new(192, 168, 100, 2);
        let mask = Ipv4Addr::new(255, 255, 255, 0);
        assert_eq!(
            Ipv4Addr::from(u32::from(ip) | !u32::from(mask)),
            Ipv4Addr::new(192, 168, 100, 255)
        );

        // 10.150.7.31/16 -> 10.150.255.255
        let ip = Ipv4Addr::new(10, 150, 7, 31);
        let mask = Ipv4Addr::new(255, 255, 0, 0);
        assert_eq!(
            Ipv4Addr::from(u32::from(ip) | !u32::from(mask)),
            Ipv4Addr::new(10, 150, 255, 255)
        );

        // 172.20.3.9/22 -> 172.20.3.255 (a rede começa em 172.20.0.0)
        let ip = Ipv4Addr::new(172, 20, 3, 9);
        let mask = Ipv4Addr::new(255, 255, 252, 0);
        assert_eq!(
            Ipv4Addr::from(u32::from(ip) | !u32::from(mask)),
            Ipv4Addr::new(172, 20, 3, 255)
        );
    }

    #[test]
    fn anuncio_carrega_o_que_o_outro_lado_precisa_para_discar() {
        let ann = announcement("abc123", "pubkey", "Fulano", 12345, 42);
        assert_eq!(ann.proto, crate::protocol::PROTOCOL_NAME);
        assert_eq!(ann.fp, "abc123");
        assert_eq!(ann.tcp_port, 12345);
        assert_eq!(ann.ts, 42);
        let json = serde_json::to_vec(&ann).unwrap();
        let volta: Announcement = serde_json::from_slice(&json).unwrap();
        assert_eq!(volta.fp, ann.fp);
        assert_eq!(volta.pubkey_hex, ann.pubkey_hex);
        assert_eq!(volta.tcp_port, ann.tcp_port);
    }

    #[tokio::test]
    async fn resposta_ao_anuncio_chega_em_milissegundos_nao_em_2s() {
        let a = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
        let b = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
        let b_addr = b.local_addr().unwrap();

        let pedido = announcement("fp-a", "pk-a", "A", a.local_addr().unwrap().port(), 1);
        let bytes = serde_json::to_vec(&pedido).unwrap();
        a.send_to(&bytes, b_addr).await.unwrap();

        let mut buf = [0u8; 2048];
        let (n, de) = tokio::time::timeout(Duration::from_secs(2), b.recv_from(&mut buf))
            .await
            .expect("o anúncio tinha de chegar")
            .unwrap();
        assert_eq!(de.port(), a.local_addr().unwrap().port());
        let recebido: Announcement = serde_json::from_slice(&buf[..n]).unwrap();
        assert_eq!(recebido.fp, "fp-a");

        // resposta imediata (mesmo caminho que o laço de recepção faz)
        let resposta = announcement("fp-b", "pk-b", "B", b_addr.port(), 2);
        let rbytes = serde_json::to_vec(&resposta).unwrap();
        let t0 = std::time::Instant::now();
        b.send_to(&rbytes, de).await.unwrap();

        let (m, _) = tokio::time::timeout(Duration::from_secs(1), a.recv_from(&mut buf))
            .await
            .expect("a resposta tem de chegar em menos de 1 s, não no próximo tick")
            .unwrap();
        assert!(t0.elapsed() < Duration::from_secs(1));
        let volta: Announcement = serde_json::from_slice(&buf[..m]).unwrap();
        assert_eq!(volta.fp, "fp-b");
    }

    #[test]
    fn alvos_reais_nao_incluem_loopback_nem_link_local() {
        for b in broadcast_targets() {
            let ip = *b.ip();
            assert!(
                !ip.is_loopback(),
                "broadcast de loopback não descobre ninguém"
            );
            assert!(!ip.is_link_local(), "169.254.x não tem rota útil");
            assert_eq!(b.port(), DISCOVERY_PORT, "a porta combinada não muda");
        }
    }
}

impl Discovery {
    pub async fn spawn(
        keypair: Arc<Keypair>,
        nickname: String,
        tcp_port: u16,
        tx: mpsc::UnboundedSender<DiscoveredPeer>,
        allowed: Arc<dyn Fn() -> bool + Send + Sync>,
        limiter: Arc<NetLimiter>,
    ) -> Result<Self> {
        let bound = match UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)).await {
            Ok(s) => s,
            Err(e) => {
                warn!("porta {DISCOVERY_PORT} ocupada ({e}); usando porta efêmera");
                UdpSocket::bind(("0.0.0.0", 0)).await?
            }
        };
        let socket = Arc::new(bound);
        socket.set_broadcast(true)?;
        if let Err(e) = socket.join_multicast_v4(DISCOVERY_GROUP, Ipv4Addr::UNSPECIFIED) {
            debug!("multicast de descoberta indisponível ({e}); seguindo só com broadcast");
        }
        let local_addr = socket.local_addr()?;
        info!(%local_addr, "discovery UDP ativo");
        // Dados próprios para responder um anúncio recebido sem esperar o tick.
        let self_fp = keypair.fingerprint();
        let self_pubkey = keypair.public_hex();
        let self_nickname = nickname.clone();
        let self_port = tcp_port;

        {
            let socket = socket.clone();
            let keypair = keypair.clone();
            let nickname = nickname.clone();
            let allowed = allowed.clone();
            tokio::spawn(async move {
                let mut tick = interval(Duration::from_secs(ANNOUNCE_INTERVAL_SECS));
                loop {
                    tick.tick().await;
                    if !allowed() {
                        continue;
                    }
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
                    let mut targets: Vec<(String, u16)> = vec![
                        (DISCOVERY_GROUP.to_string(), DISCOVERY_PORT),
                        ("255.255.255.255".to_string(), DISCOVERY_PORT),
                        ("127.255.255.255".to_string(), DISCOVERY_PORT),
                    ];
                    for b in broadcast_targets() {
                        targets.push((b.ip().to_string(), b.port()));
                    }
                    for extra in std::env::var("DISTORRENT_DISCOVERY_BROADCASTS")
                        .unwrap_or_default()
                        .split(',')
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                    {
                        if let Ok(sa) = extra.parse::<SocketAddr>() {
                            targets.push((sa.ip().to_string(), sa.port()));
                        }
                    }
                    targets.sort();
                    targets.dedup();
                    for target in &targets {
                        let addr = format!("{}:{}", target.0, target.1);
                        let _ = socket.send_to(&payload, addr.as_str()).await;
                    }
                }
            });
        }

        {
            let socket = socket;
            let allowed = allowed;
            let limiter = limiter;
            let self_fp = self_fp;
            let self_pubkey = self_pubkey;
            let self_nickname = self_nickname;
            let self_port = self_port;
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match socket.recv_from(&mut buf).await {
                        Ok((n, from)) => {
                            if !allowed() {
                                continue;
                            }
                            if limiter.allow_disc_datagram(from.ip()) == Decision::Blocked {
                                continue;
                            }
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
                            let ja_sou_eu = ann.fp == self_fp;
                            let _ = tx.send(DiscoveredPeer {
                                fp: ann.fp,
                                pubkey_hex: ann.pubkey_hex,
                                nickname: ann.nickname,
                                addr: SocketAddr::new(from.ip(), ann.tcp_port),
                            });
                            if !ja_sou_eu {
                                let ack = announcement(
                                    &self_fp,
                                    &self_pubkey,
                                    &self_nickname,
                                    self_port,
                                    crate::identity::now_ms(),
                                );
                                if let Ok(payload) = serde_json::to_vec(&ack) {
                                    let _ = socket.send_to(&payload, from).await;
                                }
                            }
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
