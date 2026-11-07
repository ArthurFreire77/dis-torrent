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

pub const MDNS_SERVICE_TYPE: &str = "_distorrent._tcp.local.";

pub struct MdnsDiscovery {
    daemon: Option<ServiceDaemon>,
    fullname: String,
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
        let nick_txt: String = nickname.chars().take(48).collect();
        let port_txt = tcp_port.to_string();
        let props = [
            ("fp", fp.as_str()),
            ("tcp_port", port_txt.as_str()),
            ("nickname", nick_txt.as_str()),
            ("pk", pubkey_hex.as_str()),
        ];

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
                        continue;
                    }
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
                            return;
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
