//! Descoberta LAN via mDNS/DNS-SD (igual torrent local, sem servidor).
//!
//! - Anuncia `_distorrent._tcp.local.` com TXT (`fp`, `tcp_port`, `nickname`,
//!   mais `pk` com a pubkey ed25519 para validar o fingerprint antes de discar).
//! - Navega pelo mesmo tipo; cada serviço resolvido vira [`DiscoveredPeer`]
//!   (o mesmo tipo de `discovery.rs`) enviado pelo canal `tx` — o loop do
//!   engine trata igual ao UDP (upsert + dial direto + eleição direta vence relay).
//! - Puro Rust (`mdns-sd`, sem dependência de sistema).
//! - Degradação graciosa: em redes sem multicast (ex.: Android sem permissão
//!   `CHANGE_WIFI_MULTICAST_STATE`, CI sem rede) o daemon/register/browse pode
//!   falhar — tudo é só logado (`warn`), nunca `panic`, e o discovery UDP
//!   existente segue como fallback.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::identity::Keypair;
use crate::net::discovery::DiscoveredPeer;
use crate::DistorrentError;

/// Tipo de serviço mDNS anunciado e navegado.
pub const MDNS_SERVICE_TYPE: &str = "_distorrent._tcp.local.";

/// Descoberta mDNS ativa: segura o daemon (anúncio + browse) enquanto viva.
/// `Drop` remove o anúncio e encerra o daemon sem bloquear nem panicar.
pub struct MdnsDiscovery {
    daemon: Option<ServiceDaemon>,
    fullname: String,
    /// Vida do watcher de privacidade — `Drop` seta false e o thread sai
    /// (sem isto, `restart_engine` vazava um thread dormindo para sempre).
    alive: Arc<AtomicBool>,
}

impl Drop for MdnsDiscovery {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
        if let Some(daemon) = self.daemon.take() {
            if !self.fullname.is_empty() {
                if let Err(e) = daemon.unregister(&self.fullname) {
                    debug!("mDNS unregister falhou: {e}");
                }
            }
            if let Err(e) = daemon.shutdown() {
                debug!("mDNS shutdown falhou: {e}");
            }
        }
    }
}

impl MdnsDiscovery {
    /// Sobe anúncio + browse. `tx` recebe peers descobertos (não-eu).
    /// Nunca panica: falha de multicast vira `warn` + descoberta degradada
    /// (`daemon: None`, só o UDP segue) ou `Err` logado pelo chamador.
    ///
    /// `allowed` = gate de privacidade EM TEMPO REAL (false em proxy/full):
    /// eventos resolvidos são descartados (nada vira dial direto) e o
    /// watcher (des)registra o ANÚNCIO — fp+nickname não vazam presença
    /// na LAN no modo anônimo, sem reiniciar o app.
    pub fn spawn(
        keypair: Arc<Keypair>,
        nickname: String,
        tcp_port: u16,
        tx: mpsc::UnboundedSender<DiscoveredPeer>,
        allowed: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> crate::Result<Self> {
        let fp = keypair.fingerprint();
        let pubkey_hex = keypair.public_hex();
        let instance = format!("distorrent-{fp}");
        let host = format!("distorrent-{fp}.local.");
        // TXT: cada prop ≤255 bytes — apelido truncado por segurança.
        let nick_txt: String = nickname.chars().take(48).collect();
        let port_txt = tcp_port.to_string();
        let props = [
            ("fp", fp.as_str()),
            ("tcp_port", port_txt.as_str()),
            ("nickname", nick_txt.as_str()),
            ("pk", pubkey_hex.as_str()),
        ];

        // Bandeira de vida COMPARTILHADA: o watcher de privacidade segura a
        // MESMA Arc que vai no Self — Drop (restart_engine/shutdown) derruba
        // o thread. Uma Arc por construção deixaria o watcher órfão.
        let alive = Arc::new(AtomicBool::new(true));

        let daemon = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => {
                warn!("mDNS indisponível ({e}) — seguindo só com discovery UDP");
                return Ok(Self {
                    daemon: None,
                    fullname: String::new(),
                    alive,
                });
            }
        };
        let info = match ServiceInfo::new(
            MDNS_SERVICE_TYPE,
            &instance,
            &host,
            (),
            tcp_port,
            &props[..],
        ) {
            Ok(i) => i.enable_addr_auto(),
            Err(e) => {
                return Err(DistorrentError::Protocol(format!("mDNS ServiceInfo: {e}")));
            }
        };
        let fullname = info.get_fullname().to_string();
        let mut announced = false;
        match daemon.register(info) {
            Ok(()) => {
                info!("mDNS anunciando {instance} ({MDNS_SERVICE_TYPE}) porta {tcp_port}");
                announced = true;
            }
            Err(e) => warn!("mDNS register falhou ({e}) — anúncio off, browse segue"),
        }
        // WATCHER DE PRIVACIDADE: liga/desliga o ANÚNCIO conforme o modo
        // (poll 2s — trocar de modo em runtime vale sem reiniciar o app).
        // Em proxy/full a presença na LAN (fp+nickname) não pode vazar:
        // unregister() pára de responder por _distorrent._tcp; o
        // re-register traz o MESMO instance/host/TXT (determinístico).
        {
            let daemon_w = daemon.clone();
            let allowed_w = allowed.clone();
            let alive_w = alive.clone();
            let fullname_w = fullname.clone();
            let instance_w = instance.clone();
            let host_w = host.clone();
            let tcp_port_w = tcp_port;
            let nick_txt_w = nick_txt.clone();
            let port_txt_w = port_txt.clone();
            let fp_w = fp.clone();
            let pubkey_w = pubkey_hex.clone();
            let announced_w = announced;
            let _ = std::thread::Builder::new()
                .name("distorrent-mdns-privacy".into())
                .spawn(move || {
                    let mut announced = announced_w;
                    while alive_w.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_secs(2));
                        let anon = !allowed_w();
                        if anon && announced {
                            match daemon_w.unregister(&fullname_w) {
                                Ok(_) => {
                                    announced = false;
                                    debug!("mDNS: anúncio removido — modo anônimo (proxy/full)");
                                }
                                Err(e) => debug!("mDNS unregister (privacidade) falhou: {e}"),
                            }
                        } else if !anon && !announced {
                            let props = [
                                ("fp", fp_w.as_str()),
                                ("tcp_port", port_txt_w.as_str()),
                                ("nickname", nick_txt_w.as_str()),
                                ("pk", pubkey_w.as_str()),
                            ];
                            match ServiceInfo::new(
                                MDNS_SERVICE_TYPE,
                                &instance_w,
                                &host_w,
                                (),
                                tcp_port_w,
                                &props[..],
                            ) {
                                Ok(i) => match daemon_w.register(i.enable_addr_auto()) {
                                    Ok(()) => {
                                        announced = true;
                                        debug!("mDNS: anúncio restaurado — modo normal");
                                    }
                                    Err(e) => warn!("mDNS re-register falhou: {e}"),
                                },
                                Err(e) => warn!("mDNS ServiceInfo (re-register): {e}"),
                            }
                        }
                    }
                });
        }
        let receiver = match daemon.browse(MDNS_SERVICE_TYPE) {
            Ok(r) => r,
            Err(e) => {
                warn!("mDNS browse falhou ({e}) — seguindo só com discovery UDP");
                return Ok(Self {
                    daemon: Some(daemon),
                    fullname,
                    alive,
                });
            }
        };

        let own_fp = fp.clone();
        let allowed_b = allowed.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("distorrent-mdns-browse".into())
            .spawn(move || {
                while let Ok(event) = receiver.recv() {
                    // PRIVACIDADE: evento resolvido em modo anônimo não vira
                    // dial direto (vazaria o IP real). Gate por evento — a
                    // troca de modo em runtime vale na hora.
                    if !allowed_b() {
                        continue;
                    }
                    let ServiceEvent::ServiceResolved(resolved) = event else { continue };
                    let txt = resolved.get_properties();
                    let peer_fp = txt.get_property_val_str("fp").unwrap_or("").trim().to_lowercase();
                    if peer_fp.len() != 12 || !peer_fp.chars().all(|c| c.is_ascii_hexdigit()) {
                        continue;
                    }
                    if peer_fp == own_fp {
                        continue; // meu próprio anúncio (loopback mDNS)
                    }
                    // Porta: TXT manda; SRV é fallback p/ anunciantes mínimos.
                    let peer_port: u16 = match txt
                        .get_property_val_str("tcp_port")
                        .unwrap_or("")
                        .trim()
                        .parse::<u16>()
                    {
                        Ok(p) if p != 0 => p,
                        _ => {
                            let p = resolved.get_port();
                            if p == 0 {
                                continue;
                            }
                            p
                        }
                    };
                    let peer_nick = txt.get_property_val_str("nickname").unwrap_or("").to_string();
                    let pk = txt
                        .get_property_val_str("pk")
                        .or_else(|| txt.get_property_val_str("pubkey"))
                        .or_else(|| txt.get_property_val_str("pubkey_hex"))
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    // Com pubkey: anti-spoof igual ao UDP. Sem pubkey (anunciante
                    // mínimo só com fp/tcp_port/nickname): emite mesmo assim com
                    // pubkey vazia — o handshake TCP autentica pelo fp esperado
                    // e o `register_and_run` persiste a pubkey real.
                    let peer_pk = if pk.is_empty() {
                        String::new()
                    } else {
                        if !crate::identity::fingerprint_matches(&peer_fp, &pk) {
                            debug!(fp = %peer_fp, "mDNS: fingerprint não confere com a pubkey — ignorado");
                            continue;
                        }
                        pk
                    };
                    let mut emitted = false;
                    for scoped in resolved.get_addresses() {
                        let ip = scoped.to_ip_addr();
                        if ip.is_unspecified() {
                            continue;
                        }
                        let peer = DiscoveredPeer {
                            fp: peer_fp.clone(),
                            pubkey_hex: peer_pk.clone(),
                            nickname: peer_nick.clone(),
                            addr: SocketAddr::new(ip, peer_port),
                        };
                        if tx.send(peer).is_err() {
                            return; // engine fechou o canal
                        }
                        emitted = true;
                    }
                    if emitted {
                        debug!(fp = %peer_fp, port = peer_port, "mDNS: peer resolvido");
                    }
                }
            }) {
            warn!("mDNS browse thread falhou ({e}) — seguindo só com discovery UDP");
        }
        Ok(Self {
            daemon: Some(daemon),
            fullname,
            alive,
        })
    }
}
