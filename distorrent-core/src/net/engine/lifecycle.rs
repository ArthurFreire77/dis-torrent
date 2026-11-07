// Metodos de NetworkEngine: lifecycle.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn new(
        store: Arc<Store>,
        keypair: Keypair,
        nickname: String,
        data_dir: PathBuf,
    ) -> Arc<Self> {
        let identity = keypair.identity(&nickname);
        let relay_fp = identity.fingerprint.clone();
        let (events, _) = broadcast::channel(256);
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        Arc::new(Self {
            store: store.clone(),
            keypair: Arc::new(keypair),
            identity: identity.clone(),
            nickname,
            data_dir,
            links: StdMutex::new(HashMap::new()),
            events,
            cmd_tx,
            cmd_rx: StdMutex::new(Some(cmd_rx)),
            pending_joins: StdMutex::new(HashMap::new()),
            join_retry: StdMutex::new(HashMap::new()),
            community_sync_at: StdMutex::new(HashMap::new()),
            member_dial_at: StdMutex::new(HashMap::new()),
            listen_port: AtomicU16::new(0),
            started: StdMutex::new(false),
            shutdown: Arc::new(Notify::new()),
            handles: StdMutex::new(Vec::new()),
            relay_in: StdMutex::new(HashMap::new()),
            relay_backend: StdMutex::new(Arc::new(MultiRelay::routes_from_env_or_default(
                &relay_fp,
            ))),
            relay_backend_custom: AtomicBool::new(false),
            relay_proxied: AtomicBool::new(false),
            relay_disabled: AtomicBool::new(!env_relay_enabled()),
            peer_relay_disabled: AtomicBool::new(env_no_relay()),
            peer_relay_optin: AtomicBool::new(env_peer_relay_enabled()),
            peer_relay: Arc::new(StdMutex::new(None)),
            peer_relay_backend: StdMutex::new(None),
            relay_maintains: StdMutex::new(std::collections::HashSet::new()),
            direct_maintains: StdMutex::new(std::collections::HashSet::new()),
            punch_upgrades: StdMutex::new(HashMap::new()),
            punch_rate: StdMutex::new(HashMap::new()),
            pending_calls: StdMutex::new(HashMap::new()),
            ring_seen: StdMutex::new(std::collections::HashSet::new()),
            call_rooms: StdMutex::new(crate::net::call_room::Rooms::default()),
            cancel_tx: tokio::sync::watch::channel(false).0,
            public_addr: StdMutex::new(None),
            nat_external_port: Arc::new(AtomicU16::new(0)),
            punch_enabled: AtomicBool::new(env_punch_enabled()),
            dial_failures: StdMutex::new(HashMap::new()),
            peer_diag: StdMutex::new(HashMap::new()),
            net_diag: StdMutex::new(NetDiagInfo::default()),
            bit_dht: StdMutex::new(None),
            dht_lookups: StdMutex::new(HashMap::new()),
            dht_queue: StdMutex::new(Vec::new()),
            auto_proxy_switched: StdMutex::new(HashMap::new()),
            tunnel_sessions: StdMutex::new(HashMap::new()),
            tunnel_pending: StdMutex::new(HashMap::new()),
            peer_protos: StdMutex::new(HashMap::new()),
            tor_timeouts: StdMutex::new(HashMap::new()),
            tunnel_pings: StdMutex::new(HashMap::new()),
            tunnel_meta: StdMutex::new(HashMap::new()),
            tunnel_reasm: StdMutex::new(TunnelReassembler::new()),
            tunnel_disabled: AtomicBool::new(matches!(
                std::env::var("DISTORRENT_NO_TUNNEL")
                    .ok()
                    .as_deref()
                    .map(|s| s.trim().to_ascii_lowercase())
                    .as_deref(),
                Some("1" | "true" | "yes" | "on")
            )),
            spam_flood: StdMutex::new(HashMap::new()),
            spam_dup: StdMutex::new(HashMap::new()),
            reaction_limiter: StdMutex::new(ReactionLimiter::new()),
            release_trust: StdMutex::new(crate::release::ReleaseTrust::empty("inicializando")),
            peer_trust: StdMutex::new(HashMap::new()),
            attest_nonce: StdMutex::new(HashMap::new()),
            attest_sent_at: StdMutex::new(HashMap::new()),
            attest_transcript: StdMutex::new(HashMap::new()),
            netlimiter: NetLimiter::from_env(),
            #[cfg(target_os = "linux")]
            voice: StdMutex::new(build_voice_media()),
            #[cfg(target_os = "linux")]
            voice_calls: StdMutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            held_calls: StdMutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            voice_channel_calls: StdMutex::new(HashMap::new()),
        })
    }

    pub fn new_with_identity(
        store: Arc<Store>,
        keypair: Keypair,
        identity: Identity,
        data_dir: PathBuf,
    ) -> Arc<Self> {
        let nickname = identity.nickname.clone();
        let relay_fp = identity.fingerprint.clone();
        let (events, _) = broadcast::channel(256);
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        Arc::new(Self {
            store,
            keypair: Arc::new(keypair),
            identity,
            nickname,
            data_dir,
            links: StdMutex::new(HashMap::new()),
            events,
            cmd_tx,
            cmd_rx: StdMutex::new(Some(cmd_rx)),
            pending_joins: StdMutex::new(HashMap::new()),
            join_retry: StdMutex::new(HashMap::new()),
            community_sync_at: StdMutex::new(HashMap::new()),
            member_dial_at: StdMutex::new(HashMap::new()),
            listen_port: AtomicU16::new(0),
            started: StdMutex::new(false),
            shutdown: Arc::new(Notify::new()),
            handles: StdMutex::new(Vec::new()),
            relay_in: StdMutex::new(HashMap::new()),
            relay_backend: StdMutex::new(Arc::new(MultiRelay::routes_from_env_or_default(
                &relay_fp,
            ))),
            relay_backend_custom: AtomicBool::new(false),
            relay_proxied: AtomicBool::new(false),
            relay_disabled: AtomicBool::new(!env_relay_enabled()),
            peer_relay_disabled: AtomicBool::new(env_no_relay()),
            peer_relay_optin: AtomicBool::new(env_peer_relay_enabled()),
            peer_relay: Arc::new(StdMutex::new(None)),
            peer_relay_backend: StdMutex::new(None),
            relay_maintains: StdMutex::new(std::collections::HashSet::new()),
            direct_maintains: StdMutex::new(std::collections::HashSet::new()),
            punch_upgrades: StdMutex::new(HashMap::new()),
            punch_rate: StdMutex::new(HashMap::new()),
            pending_calls: StdMutex::new(HashMap::new()),
            ring_seen: StdMutex::new(std::collections::HashSet::new()),
            call_rooms: StdMutex::new(crate::net::call_room::Rooms::default()),
            cancel_tx: tokio::sync::watch::channel(false).0,
            public_addr: StdMutex::new(None),
            nat_external_port: Arc::new(AtomicU16::new(0)),
            punch_enabled: AtomicBool::new(env_punch_enabled()),
            dial_failures: StdMutex::new(HashMap::new()),
            peer_diag: StdMutex::new(HashMap::new()),
            net_diag: StdMutex::new(NetDiagInfo::default()),
            bit_dht: StdMutex::new(None),
            dht_lookups: StdMutex::new(HashMap::new()),
            dht_queue: StdMutex::new(Vec::new()),
            auto_proxy_switched: StdMutex::new(HashMap::new()),
            tunnel_sessions: StdMutex::new(HashMap::new()),
            tunnel_pending: StdMutex::new(HashMap::new()),
            peer_protos: StdMutex::new(HashMap::new()),
            tor_timeouts: StdMutex::new(HashMap::new()),
            tunnel_pings: StdMutex::new(HashMap::new()),
            tunnel_meta: StdMutex::new(HashMap::new()),
            tunnel_reasm: StdMutex::new(TunnelReassembler::new()),
            tunnel_disabled: AtomicBool::new(matches!(
                std::env::var("DISTORRENT_NO_TUNNEL")
                    .ok()
                    .as_deref()
                    .map(|s| s.trim().to_ascii_lowercase())
                    .as_deref(),
                Some("1" | "true" | "yes" | "on")
            )),
            spam_flood: StdMutex::new(HashMap::new()),
            spam_dup: StdMutex::new(HashMap::new()),
            reaction_limiter: StdMutex::new(ReactionLimiter::new()),
            release_trust: StdMutex::new(crate::release::ReleaseTrust::empty("inicializando")),
            peer_trust: StdMutex::new(HashMap::new()),
            attest_nonce: StdMutex::new(HashMap::new()),
            attest_sent_at: StdMutex::new(HashMap::new()),
            attest_transcript: StdMutex::new(HashMap::new()),
            netlimiter: NetLimiter::from_env(),
            #[cfg(target_os = "linux")]
            voice: StdMutex::new(build_voice_media()),
            #[cfg(target_os = "linux")]
            voice_calls: StdMutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            held_calls: StdMutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            voice_channel_calls: StdMutex::new(HashMap::new()),
        })
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    pub fn store_ref(&self) -> &Store {
        &self.store
    }

    pub fn keypair(&self) -> Keypair {
        (*self.keypair).clone()
    }

    pub fn secret_hex(&self) -> String {
        self.keypair.secret_hex()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }

    /// Emite um evento interno. Existe para testes de integração (ponte local do
    /// bot) conseguirem simular entradas sem abrir socket real.
    pub fn emit_for_test(&self, ev: EngineEvent) {
        let _ = self.events.send(ev);
    }

    pub fn listen_port(&self) -> u16 {
        self.listen_port.load(Ordering::Relaxed)
    }

    pub fn dht_announce_port(&self) -> Option<u16> {
        if let Some(addr) = self
            .public_addr
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            if let Ok(sa) = addr.parse::<std::net::SocketAddr>() {
                if sa.port() != 0 {
                    return Some(sa.port());
                }
            }
        }
        let ext = self.nat_external_port.load(Ordering::Relaxed);
        if ext != 0 {
            return Some(ext);
        }
        None
    }

    pub fn start(self: &Arc<Self>) -> Result<()> {
        self.start_with_discovery(true)
    }

    pub fn start_with_discovery(self: &Arc<Self>, discovery: bool) -> Result<()> {
        {
            let mut s = self.started.lock().unwrap_or_else(|e| e.into_inner());
            if *s {
                return Err(DistorrentError::AlreadyStarted);
            }
            *s = true;
        }
        let engine = self.clone();
        let handle = tokio::spawn(async move {
            let cmd_rx = engine
                .cmd_rx
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            let cmd_handle = cmd_rx.map(|rx| tokio::spawn(dial::command_loop(engine.clone(), rx)));
            let shutdown = engine.shutdown.clone();
            tokio::select! {
                r = runtime::run_engine(engine.clone(), discovery) => {
                    if let Err(e) = r {
                        tracing::error!("engine parou: {e}");
                    }
                }
                _ = shutdown.notified() => {
                    tracing::info!("engine shutdown solicitado");
                }
            }
            if let Some(h) = cmd_handle {
                h.abort();
            }
        });
        self.handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(handle);
        Ok(())
    }

    pub fn shutdown(&self) {
        let _ = self.cancel_tx.send(true);
        let port = self.listen_port.load(Ordering::Relaxed);
        if port != 0 {
            process_ports()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&port);
        }
        self.shutdown.notify_waiters();
        for fp in self.online_peer_fps() {
            self.disconnect_peer(&fp);
        }
        let mut hs = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        for h in hs.drain(..) {
            h.abort();
        }
        *self.started.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }

    pub fn disconnect_peer(&self, peer_fp: &str) {
        let link = self
            .links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_fp)
            .cloned();
        if let Some(l) = link {
            if let Some(tx) = &l.tx {
                let _ = tx.send((0, SecureFrame::Bye));
            }
            l.drop_notify.notify_one();
        }
    }

    pub(super) fn link_tx(&self, fp: &str) -> Option<mpsc::UnboundedSender<(u8, SecureFrame)>> {
        let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        let l = links.get(fp)?;
        if l.get_state() == PeerLinkState::Online {
            l.tx.clone()
        } else {
            None
        }
    }

    pub(super) fn emit_state(&self) {
        let _ = self.events.send(EngineEvent::StateChanged {
            state: self.aggregated_state(),
            online_peers: self.online_peer_fps().len(),
        });
    }
}
