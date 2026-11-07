use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::task::{Context, Poll};
use std::time::Duration;

#[path = "relay_mqtt.rs"]
mod relay_mqtt;
pub use relay_diag::{check_relay_legs, check_relay_legs_via, proxy_online_test};
use relay_mqtt::sanitize_client_part;
pub use relay_reasm::{chunk_frame, chunk_frame_opaque};
pub use relay_socks::{forward_via_socks, move_spawn_tunnel};

#[path = "relay_diag.rs"]
mod relay_diag;

#[path = "relay_socks.rs"]
mod relay_socks;

#[path = "relay_reasm.rs"]
mod relay_reasm;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::mpsc;

use crate::net::engine::NetworkEngine;
use crate::protocol::SecureFrame;
use crate::{DistorrentError, Result};

pub const RELAY_TOPIC_PREFIX: &str = "distorrent_r_";
pub const RELAY_CHUNK_B64: usize = 3000;
pub const RELAY_MAX_FRAME: usize = (1 << 20) + 4;

pub fn relay_topic(fp: &str) -> String {
    format!("{RELAY_TOPIC_PREFIX}{fp}")
}

pub fn announce_topic(fp: &str) -> String {
    format!("distorrent_a_{fp}")
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RelayStats {
    pub posts: u64,
    pub poll_hits: u64,
}

#[inline]
fn is_relay_topic(topic: &str) -> bool {
    topic.starts_with(RELAY_TOPIC_PREFIX)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RelayEnvelope {
    v: u8,
    from: String,
    to: String,
    msg_id: String,
    idx: u32,
    total: u32,
    data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OpaqueRelayEnvelope {
    v: u8,
    rid: String,
    idx: u32,
    total: u32,
    data: String,
}

pub trait RelayBackend: Send + Sync {
    fn post<'a>(
        &'a self,
        topic: &'a str,
        body: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;
    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>>;

    fn wakes(&self) -> Vec<Arc<tokio::sync::Notify>> {
        Vec::new()
    }

    fn stats(&self) -> RelayStats {
        RelayStats::default()
    }

    fn deliver_peer_relay(&self, _req_id: u32, _bodies: Vec<String>) -> bool {
        false
    }

    fn opaque_envelope(&self) -> bool {
        false
    }
}

pub struct SocksTunnel {
    pub local_addr: std::net::SocketAddr,
}

pub struct MqttRelay {
    host: String,
    port: u16,
    client_id: String,
    shared: Arc<StdMutex<MqttState>>,
    posts: Arc<AtomicU64>,
    poll_hits: Arc<AtomicU64>,
}

struct MqttState {
    client: Option<rumqttc::AsyncClient>,
    eventloop: Option<rumqttc::EventLoop>,
    pump: bool,
    subscribed: HashSet<String>,
    inbox: HashMap<String, Vec<String>>,
    last_err: Option<String>,
    consec_errs: u32,
    wake: Arc<tokio::sync::Notify>,
}

impl RelayBackend for MqttRelay {
    fn post<'a>(
        &'a self,
        topic: &'a str,
        body: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            if is_relay_topic(topic) {
                self.posts.fetch_add(1, Ordering::Relaxed);
            }
            let Some(client) = self.ensure() else {
                return Err(DistorrentError::Protocol("relay mqtt sem client".into()));
            };
            let leg_err = || {
                self.shared
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .last_err
                    .clone()
                    .unwrap_or_default()
            };
            tokio::time::timeout(
                Duration::from_secs(10),
                client.publish(
                    topic,
                    rumqttc::QoS::AtLeastOnce,
                    false,
                    body.as_bytes().to_vec(),
                ),
            )
            .await
            .map_err(|_| {
                let extra = leg_err();
                DistorrentError::Protocol(if extra.is_empty() {
                    "relay mqtt publish timeout".into()
                } else {
                    format!("relay mqtt publish timeout (perna: {extra})")
                })
            })?
            .map_err(|e| DistorrentError::Protocol(format!("relay mqtt post falhou: {e}")))?;
            Ok(())
        })
    }

    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>> {
        Box::pin(async move {
            let Some(client) = self.ensure() else {
                return Err(DistorrentError::Protocol("relay mqtt sem client".into()));
            };
            let need_sub = {
                !self
                    .shared
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .subscribed
                    .contains(topic)
            };
            if need_sub {
                if client
                    .try_subscribe(topic, rumqttc::QoS::AtLeastOnce)
                    .is_ok()
                {
                    self.shared
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .subscribed
                        .insert(topic.to_string());
                }
            }
            let mut st = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            let out = st.inbox.remove(topic).unwrap_or_default();
            if is_relay_topic(topic) && !out.is_empty() {
                self.poll_hits.fetch_add(1, Ordering::Relaxed);
            }
            Ok(out)
        })
    }

    fn wakes(&self) -> Vec<Arc<tokio::sync::Notify>> {
        vec![self
            .shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .wake
            .clone()]
    }

    fn stats(&self) -> RelayStats {
        RelayStats {
            posts: self.posts.load(Ordering::Relaxed),
            poll_hits: self.poll_hits.load(Ordering::Relaxed),
        }
    }
}

pub struct MultiRelay {
    legs: Vec<Arc<dyn RelayBackend>>,
}

impl MultiRelay {
    pub fn default_routes() -> Self {
        Self {
            legs: vec![
                Arc::new(MqttRelay::new("broker.emqx.io", 1883)),
                Arc::new(MqttRelay::new("test.mosquitto.org", 1883)),
                Arc::new(MqttRelay::new("broker.mqttdashboard.com", 1883)),
                Arc::new(MqttRelay::new("broker.hivemq.com", 1883)),
            ],
        }
    }

    pub fn default_routes_with_fp(fp: &str) -> Self {
        Self {
            legs: vec![
                Arc::new(MqttRelay::new_with_fp("broker.emqx.io", 1883, fp)),
                Arc::new(MqttRelay::new_with_fp("test.mosquitto.org", 1883, fp)),
                Arc::new(MqttRelay::new_with_fp("broker.mqttdashboard.com", 1883, fp)),
                Arc::new(MqttRelay::new_with_fp("broker.hivemq.com", 1883, fp)),
            ],
        }
    }

    pub fn routes_from_env_or_default(fp: &str) -> Self {
        let custom = std::env::var("DISTORRENT_MQTT_BROKERS")
            .ok()
            .map(|v| {
                v.split(',')
                    .filter_map(|part| {
                        let part = part.trim().trim_matches('/');
                        if part.is_empty() {
                            return None;
                        }
                        let bare = part
                            .strip_prefix("mqtt://")
                            .or_else(|| part.strip_prefix("tcp://"))
                            .unwrap_or(part);
                        let (host, port) = match bare.rsplit_once(':') {
                            Some((h, p)) if !h.is_empty() => {
                                let port = p.parse::<u16>().unwrap_or(1883);
                                (h.to_string(), port)
                            }
                            _ => (bare.to_string(), 1883),
                        };
                        if host.is_empty() {
                            return None;
                        }
                        Some((host, port))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if custom.is_empty() {
            return Self::default_routes_with_fp(fp);
        }
        tracing::info!(
            brokers = custom
                .iter()
                .map(|(h, p)| format!("{h}:{p}"))
                .collect::<Vec<_>>()
                .join(","),
            "relay: brokers MQTT próprios via DISTORRENT_MQTT_BROKERS"
        );
        Self {
            legs: custom
                .into_iter()
                .map(|(host, port)| {
                    Arc::new(MqttRelay::new_with_fp(&host, port, fp)) as Arc<dyn RelayBackend>
                })
                .collect(),
        }
    }

    pub fn of(legs: Vec<Arc<dyn RelayBackend>>) -> Self {
        Self { legs }
    }

    pub fn leg_count(&self) -> usize {
        self.legs.len()
    }

    pub fn proxied_routes(proxy: &str) -> Result<Self> {
        let (_, _) = crate::net::socks5::split_host_port(proxy)?;
        let mk = |host: &'static str, port: u16| {
            let tun = SocksTunnel::spawn(proxy.to_string(), host.to_string(), port);
            MqttRelay::new(&tun.local_addr.to_string(), tun.local_addr.port())
        };
        Ok(Self {
            legs: vec![
                Arc::new(mk("broker.emqx.io", 1883)),
                Arc::new(mk("test.mosquitto.org", 1883)),
                Arc::new(mk("broker.mqttdashboard.com", 1883)),
                Arc::new(mk("broker.hivemq.com", 1883)),
            ],
        })
    }

    pub fn proxied_routes_with_fp(proxy: &str, fp: &str) -> Result<Self> {
        let (_, _) = crate::net::socks5::split_host_port(proxy)?;
        let mk = |host: &'static str, port: u16| {
            let tun = SocksTunnel::spawn(proxy.to_string(), host.to_string(), port);
            let fp12: String = fp.chars().take(12).collect();
            let short = sanitize_client_part(host)
                .chars()
                .take(16)
                .collect::<String>();
            MqttRelay::new_with_client_id(
                &tun.local_addr.to_string(),
                tun.local_addr.port(),
                &format!("distorrent-{fp12}-{short}-px"),
            )
        };
        Ok(Self {
            legs: vec![
                Arc::new(mk("broker.emqx.io", 1883)),
                Arc::new(mk("test.mosquitto.org", 1883)),
                Arc::new(mk("broker.mqttdashboard.com", 1883)),
                Arc::new(mk("broker.hivemq.com", 1883)),
            ],
        })
    }
}

impl RelayBackend for MultiRelay {
    fn post<'a>(
        &'a self,
        topic: &'a str,
        body: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            if self.legs.is_empty() {
                return Err(DistorrentError::Protocol("relay sem pernas".into()));
            }
            if self.legs.len() == 1 {
                return self.legs[0].post(topic, body).await;
            }
            let topic = topic.to_string();
            let body = body.to_string();
            let n = self.legs.len();
            let (tx, mut rx) = mpsc::unbounded_channel::<Result<()>>();
            for leg in &self.legs {
                let (leg, topic, body, tx) = (leg.clone(), topic.clone(), body.clone(), tx.clone());
                tokio::spawn(async move {
                    let r = leg.post(&topic, &body).await;
                    let _ = tx.send(r);
                });
            }
            drop(tx);
            let mut last_err = DistorrentError::Protocol("relay sem pernas".into());
            let mut errs: usize = 0;
            while let Some(r) = rx.recv().await {
                match r {
                    Ok(()) => return Ok(()),
                    Err(e) => {
                        tracing::debug!("relay multi: perna falhou ({e}) — segue nas demais");
                        last_err = e;
                        errs += 1;
                        if errs >= n {
                            return Err(last_err);
                        }
                    }
                }
            }
            Err(last_err)
        })
    }

    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>> {
        Box::pin(async move {
            let topic = topic.to_string();
            let mut handles = Vec::with_capacity(self.legs.len());
            for leg in &self.legs {
                let (leg, topic) = (leg.clone(), topic.clone());
                handles.push(tokio::spawn(async move {
                    match tokio::time::timeout(Duration::from_secs(3), leg.poll(&topic)).await {
                        Ok(Ok(v)) => v,
                        _ => Vec::new(),
                    }
                }));
            }
            let mut out = Vec::new();
            for h in handles {
                if let Ok(mut v) = h.await {
                    out.append(&mut v);
                }
            }
            Ok(out)
        })
    }

    fn wakes(&self) -> Vec<Arc<tokio::sync::Notify>> {
        self.legs.iter().flat_map(|l| l.wakes()).collect()
    }

    fn stats(&self) -> RelayStats {
        let mut acc = RelayStats::default();
        for leg in &self.legs {
            let s = leg.stats();
            acc.posts += s.posts;
            acc.poll_hits += s.poll_hits;
        }
        acc
    }

    fn deliver_peer_relay(&self, req_id: u32, bodies: Vec<String>) -> bool {
        let mut ok = false;
        for leg in &self.legs {
            if leg.deliver_peer_relay(req_id, bodies.clone()) {
                ok = true;
            }
        }
        ok
    }

    fn opaque_envelope(&self) -> bool {
        self.legs.iter().any(|l| l.opaque_envelope())
    }
}

pub const PEER_RELAY_POLL_TIMEOUT: Duration = Duration::from_secs(2);
pub const PEER_RELAY_MAX_PENDING: usize = 512;

pub struct PeerRelayBackend {
    engine: Weak<NetworkEngine>,
    relay_fp: String,
    pending: StdMutex<HashMap<u32, tokio::sync::oneshot::Sender<Vec<String>>>>,
    wake: Arc<tokio::sync::Notify>,
    posts: Arc<AtomicU64>,
    poll_hits: Arc<AtomicU64>,
}

impl PeerRelayBackend {
    pub fn new(engine: Weak<NetworkEngine>, relay_fp: String) -> Self {
        Self {
            engine,
            relay_fp,
            pending: StdMutex::new(HashMap::new()),
            wake: Arc::new(tokio::sync::Notify::new()),
            posts: Arc::new(AtomicU64::new(0)),
            poll_hits: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn relay_fp(&self) -> &str {
        &self.relay_fp
    }

    pub fn deliver(&self, req_id: u32, bodies: Vec<String>) -> bool {
        let tx = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&req_id);
        match tx {
            Some(tx) => {
                let _ = tx.send(bodies);
                self.wake.notify_waiters();
                true
            }
            None => false,
        }
    }

    pub fn pending_len(&self) -> usize {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn pending_req_ids(&self) -> Vec<u32> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect()
    }
}

fn new_req_id() -> u32 {
    rand::random::<u32>()
}

impl RelayBackend for PeerRelayBackend {
    fn post<'a>(
        &'a self,
        topic: &'a str,
        body: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            if is_relay_topic(topic) {
                self.posts.fetch_add(1, Ordering::Relaxed);
            }
            let Some(engine) = self.engine.upgrade() else {
                return Err(DistorrentError::Protocol(
                    "peer-relay: engine encerrado".into(),
                ));
            };
            engine.send_to_peer(
                self.relay_fp.clone(),
                SecureFrame::PeerRelayPut {
                    topic: topic.to_string(),
                    body: body.to_string(),
                },
            );
            Ok(())
        })
    }

    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>> {
        let (req_id, rx) = {
            let mut p = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if p.len() >= PEER_RELAY_MAX_PENDING {
                p.clear();
            }
            let mut id = new_req_id();
            while id == 0 || p.contains_key(&id) {
                id = new_req_id();
            }
            let (tx, rx) = tokio::sync::oneshot::channel::<Vec<String>>();
            p.insert(id, tx);
            (id, rx)
        };
        let Some(engine) = self.engine.upgrade() else {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&req_id);
            return Box::pin(async { Ok::<Vec<String>, DistorrentError>(Vec::new()) });
        };
        engine.send_to_peer(
            self.relay_fp.clone(),
            SecureFrame::PeerRelayGet {
                topic: topic.to_string(),
                req_id,
            },
        );
        Box::pin(async move {
            match tokio::time::timeout(PEER_RELAY_POLL_TIMEOUT, rx).await {
                Ok(Ok(bodies)) => {
                    if is_relay_topic(topic) && !bodies.is_empty() {
                        self.poll_hits.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(bodies)
                }
                _ => {
                    self.pending
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&req_id);
                    Ok(Vec::new())
                }
            }
        })
    }

    fn wakes(&self) -> Vec<Arc<tokio::sync::Notify>> {
        vec![self.wake.clone()]
    }

    fn stats(&self) -> RelayStats {
        RelayStats {
            posts: self.posts.load(Ordering::Relaxed),
            poll_hits: self.poll_hits.load(Ordering::Relaxed),
        }
    }

    fn deliver_peer_relay(&self, req_id: u32, bodies: Vec<String>) -> bool {
        self.deliver(req_id, bodies)
    }

    fn opaque_envelope(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RelayLegStatus {
    pub name: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Clone, Default)]
pub struct MemRelay {
    hub: Arc<StdMutex<HashMap<String, Vec<String>>>>,
    wake: Arc<tokio::sync::Notify>,
    posts: Arc<AtomicU64>,
    poll_hits: Arc<AtomicU64>,
}

impl MemRelay {
    pub fn new() -> Self {
        Self::default()
    }
}

impl RelayBackend for MemRelay {
    fn post<'a>(
        &'a self,
        topic: &'a str,
        body: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            if is_relay_topic(topic) {
                self.posts.fetch_add(1, Ordering::Relaxed);
            }
            let wake = {
                let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
                hub.entry(topic.to_string())
                    .or_default()
                    .push(body.to_string());
                self.wake.clone()
            };
            wake.notify_waiters();
            Ok(())
        })
    }

    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>> {
        Box::pin(async move {
            let out: Vec<String> = self
                .hub
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(topic)
                .unwrap_or_default();
            if is_relay_topic(topic) && !out.is_empty() {
                self.poll_hits.fetch_add(1, Ordering::Relaxed);
            }
            Ok(out)
        })
    }

    fn wakes(&self) -> Vec<Arc<tokio::sync::Notify>> {
        vec![self.wake.clone()]
    }

    fn stats(&self) -> RelayStats {
        RelayStats {
            posts: self.posts.load(Ordering::Relaxed),
            poll_hits: self.poll_hits.load(Ordering::Relaxed),
        }
    }
}

pub struct Reassembler {
    pending: HashMap<String, Vec<Option<String>>>,
}

pub struct RelayStream {
    inbound: mpsc::UnboundedReceiver<Vec<u8>>,
    outbound: mpsc::UnboundedSender<Vec<u8>>,
    read_buf: Vec<u8>,
    read_pos: usize,
    write_buf: Vec<u8>,
}

impl AsyncRead for RelayStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        loop {
            if self.read_pos < self.read_buf.len() {
                let n = (self.read_buf.len() - self.read_pos).min(buf.remaining());
                buf.put_slice(&self.read_buf[self.read_pos..self.read_pos + n]);
                self.read_pos += n;
                if self.read_pos >= self.read_buf.len() {
                    self.read_buf.clear();
                    self.read_pos = 0;
                }
                return Poll::Ready(Ok(()));
            }
            match self.inbound.poll_recv(cx) {
                Poll::Ready(Some(frame)) => {
                    self.read_buf = frame;
                    self.read_pos = 0;
                }
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl AsyncWrite for RelayStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        self.write_buf.extend_from_slice(buf);
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(self.flush_frames())
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let _ = self.flush_frames();
        Poll::Ready(Ok(()))
    }
}

pub async fn relay_post_loop(
    backend: Arc<dyn RelayBackend>,
    my_fp: String,
    peer_fp: String,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    let topic = relay_topic(&peer_fp);
    let mut counter: u64 = 0;
    while let Some(frame) = rx.recv().await {
        counter += 1;
        let chunks = if backend.opaque_envelope() {
            chunk_frame_opaque(&frame)
        } else {
            let msg_id = format!("{}-{counter}", &my_fp[..my_fp.len().min(6)]);
            chunk_frame(&my_fp, &peer_fp, &msg_id, &frame)
        };
        if chunks.len() == 1 {
            if let Err(e) = backend.post(&topic, &chunks[0]).await {
                tracing::debug!(%peer_fp, "relay post falhou (sessão cai, maintain tenta de novo): {e}");
                return;
            }
            continue;
        }
        for chunk in chunks {
            if let Err(e) = backend.post(&topic, &chunk).await {
                tracing::debug!(%peer_fp, "relay post falhou (sessão cai, maintain tenta de novo): {e}");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as TestMutex;

    static ENV_LOCK: TestMutex<()> = TestMutex::new(());

    #[test]
    fn routes_from_env_or_default() {
        let _g = ENV_LOCK.lock().unwrap();
        let fp = "abcdef0123456789";
        std::env::remove_var("DISTORRENT_MQTT_BROKERS");
        assert_eq!(MultiRelay::routes_from_env_or_default(fp).leg_count(), 4);
        std::env::set_var("DISTORRENT_MQTT_BROKERS", "mqtt.seu-vps:1883,outro.lan");
        assert_eq!(MultiRelay::routes_from_env_or_default(fp).leg_count(), 2);
        std::env::set_var("DISTORRENT_MQTT_BROKERS", " , ,");
        assert_eq!(MultiRelay::routes_from_env_or_default(fp).leg_count(), 4);
        std::env::set_var("DISTORRENT_MQTT_BROKERS", "mqtt://a:1883,tcp://b:1884");
        assert_eq!(MultiRelay::routes_from_env_or_default(fp).leg_count(), 2);
        std::env::remove_var("DISTORRENT_MQTT_BROKERS");
    }

    #[test]
    fn chunk_reassemble_roundtrip() {
        let frame: Vec<u8> = (0..20000u32).map(|i| (i % 251) as u8).collect();
        let mut prefixed = (frame.len() as u32).to_be_bytes().to_vec();
        prefixed.extend_from_slice(&frame);
        let chunks = chunk_frame("aaa", "bbb", "m1", &prefixed);
        assert!(chunks.len() > 1);
        let mut re = Reassembler::new();
        let mut done = None;
        for c in chunks.iter().rev() {
            if let Some(r) = re.feed("bbb", c) {
                done = Some(r);
            }
        }
        let (from, bytes) = done.expect("deveria completar");
        assert_eq!(from, "aaa");
        assert_eq!(bytes, prefixed);
    }

    #[test]
    fn reassembler_rejeita_lixo() {
        let mut re = Reassembler::new();
        assert!(re.feed("bbb", "não é json").is_none());
        assert!(re
            .feed(
                "bbb",
                r#"{"v":2,"from":"a","to":"bbb","msg_id":"x","idx":0,"total":1,"data":"eA=="}"#
            )
            .is_none());
        assert!(re
            .feed(
                "ccc",
                r#"{"v":1,"from":"a","to":"bbb","msg_id":"x","idx":0,"total":1,"data":"eA=="}"#
            )
            .is_none());
    }

    #[tokio::test]
    async fn relay_stream_pipe() {
        let (tx_a, rx_a) = mpsc::unbounded_channel::<Vec<u8>>();
        let (tx_b, rx_b) = mpsc::unbounded_channel::<Vec<u8>>();
        let mut a = RelayStream::new(rx_a, tx_b);
        let mut b = RelayStream::new(rx_b, tx_a);
        let payload = b"hello relay".to_vec();
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&payload);
        {
            use tokio::io::AsyncWriteExt;
            a.write_all(&frame).await.unwrap();
            a.flush().await.unwrap();
        }
        {
            use tokio::io::AsyncReadExt;
            let mut len_buf = [0u8; 4];
            b.read_exact(&mut len_buf).await.unwrap();
            let len = u32::from_be_bytes(len_buf) as usize;
            let mut body = vec![0u8; len];
            b.read_exact(&mut body).await.unwrap();
            assert_eq!(body, payload);
        }
    }

    #[tokio::test]
    async fn socks_tunnel_roteia_pelo_proxy() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_addr = echo.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = echo.accept().await else {
                    continue;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    if let Ok(n) = s.read(&mut buf).await {
                        let _ = s.write_all(&buf[..n]).await;
                    }
                });
            }
        });

        let proxy = crate::net::socks5::mock_server::spawn().await;

        let tun = SocksTunnel::spawn(proxy.to_string(), "127.0.0.1".to_string(), echo_addr.port());

        let mut c = tokio::net::TcpStream::connect(tun.local_addr)
            .await
            .unwrap();
        c.write_all(b"via-tunel-socks5").await.unwrap();
        let mut buf = [0u8; 16];
        c.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"via-tunel-socks5");
    }

    #[tokio::test]
    async fn proxied_routes_valida_endereco_do_proxy() {
        assert!(
            MultiRelay::proxied_routes("127.0.0.1:9050").is_ok(),
            "host:porta válido"
        );
        assert!(
            MultiRelay::proxied_routes("sem-porta").is_err(),
            "sem porta → Err"
        );
        assert!(MultiRelay::proxied_routes("").is_err(), "vazio → Err");
    }

    #[test]
    fn envelope_opaco_sem_identidade() {
        let frame = b"conteudo-cifrado".to_vec();
        let mut prefixed = (frame.len() as u32).to_be_bytes().to_vec();
        prefixed.extend_from_slice(&frame);
        let chunks = chunk_frame_opaque(&prefixed);
        assert_eq!(chunks.len(), 1);
        let raw = &chunks[0];
        for marker in ["\"from\"", "\"to\"", "\"msg_id\"", "\"author\""] {
            assert!(
                !raw.contains(marker),
                "envelope opaco não deve conter {marker}: {raw}"
            );
        }
        let env: OpaqueRelayEnvelope = serde_json::from_str(raw).unwrap();
        assert_eq!(env.v, 1);
        assert_eq!(env.rid.len(), 32, "rid = 16 bytes hex");
        let mut re = Reassembler::new();
        let (from, bytes) = re.feed("qualquer", raw).expect("opaco remonta");
        assert_eq!(from, "", "opaco não carrega identidade");
        assert_eq!(bytes, prefixed);
    }

    #[test]
    fn envelope_opaco_multichunk_roundtrip() {
        let frame: Vec<u8> = (0..20000u32).map(|i| (i % 251) as u8).collect();
        let mut prefixed = (frame.len() as u32).to_be_bytes().to_vec();
        prefixed.extend_from_slice(&frame);
        let chunks = chunk_frame_opaque(&prefixed);
        assert!(chunks.len() > 1);
        let mut re = Reassembler::new();
        let mut done = None;
        for c in chunks.iter().rev() {
            if let Some(r) = re.feed("x", c) {
                done = Some(r);
            }
        }
        let (from, bytes) = done.expect("deveria completar");
        assert_eq!(from, "");
        assert_eq!(bytes, prefixed);
    }

    #[tokio::test]
    async fn mqtt_poll_isola_topicos() {
        let r = MqttRelay::new("127.0.0.1", 1883);
        {
            let mut st = r.shared.lock().unwrap_or_else(|e| e.into_inner());
            st.subscribed.insert("distorrent_r_aaa".to_string());
            st.subscribed.insert("distorrent_a_aaa".to_string());
            st.inbox.insert(
                "distorrent_r_aaa".to_string(),
                vec!["R1".to_string(), "R2".to_string()],
            );
            st.inbox
                .insert("distorrent_a_aaa".to_string(), vec!["A1".to_string()]);
        }
        let relay_topic = "distorrent_r_aaa".to_string();
        let ann_topic = "distorrent_a_aaa".to_string();
        let out_r = r.poll(&relay_topic).await.expect("poll relay");
        assert_eq!(out_r, vec!["R1".to_string(), "R2".to_string()]);
        let out_a = r.poll(&ann_topic).await.expect("poll announce");
        assert_eq!(out_a, vec!["A1".to_string()]);
        let out_r2 = r.poll(&relay_topic).await.expect("poll relay vazio");
        assert!(out_r2.is_empty());
    }

    #[test]
    fn mqtt_client_id_estavel_por_fp() {
        let a = MqttRelay::new_with_fp("broker.emqx.io", 1883, "abcdef0123456789");
        let b = MqttRelay::new_with_fp("broker.emqx.io", 1883, "abcdef0123456789");
        assert_eq!(a.client_id, b.client_id, "mesma fp+host = mesmo id");
        assert!(
            a.client_id.contains("abcdef012345"),
            "id carrega fp[:12]: {}",
            a.client_id
        );
        let c = MqttRelay::new_with_fp("broker.emqx.io", 1883, "outrafp0000000000");
        assert_ne!(a.client_id, c.client_id, "fp distinta = id distinto");
        let routes = MultiRelay::default_routes_with_fp("abcdef0123456789");
        assert_eq!(routes.legs.len(), 4);
    }

    #[test]
    fn req_id_aleatorio_nao_sequencial() {
        let ids: Vec<u32> = (0..16).map(|_| new_req_id()).collect();
        let uniq: std::collections::HashSet<u32> = ids.iter().copied().collect();
        assert!(uniq.len() > 8, "ids devem ser distintos: {ids:?}");
        let todos_sequenciais = ids.windows(2).all(|w| w[1] == w[0].wrapping_add(1));
        assert!(!todos_sequenciais, "ids não podem ser sequenciais: {ids:?}");
        assert!(
            ids.iter().any(|&v| v > 0xFFFF),
            "deve cobrir o espaço todo, não começar em 1: {ids:?}"
        );
    }

    #[tokio::test]
    async fn mqtt_connack_recusa_servidor_que_nao_e_broker() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            if let Ok((mut s, _)) = l.accept().await {
                let _ = s.write_all(&[0xff, 0xff, 0xff]).await;
            }
        });
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let r = relay_mqtt::mqtt_connack(stream, "127.0.0.1").await;
        assert!(r.is_err(), "lixo na resposta não pode passar como perna OK");
        let _ = srv.await;
    }

    async fn drain_connect<S>(s: &mut S)
    where
        S: tokio::io::AsyncRead + Unpin,
    {
        use tokio::io::AsyncReadExt;
        let mut head = [0u8; 1];
        if s.read_exact(&mut head).await.is_err() {
            return;
        }
        let mut len: usize = 0;
        let mut mult: usize = 1;
        loop {
            let mut b = [0u8; 1];
            if s.read_exact(&mut b).await.is_err() {
                return;
            }
            len += (b[0] as usize & 0x7f) * mult;
            if b[0] & 0x80 == 0 {
                break;
            }
            mult *= 128;
            if mult > 128 * 128 * 128 {
                return;
            }
        }
        let mut body = vec![0u8; len];
        let _ = s.read_exact(&mut body).await;
    }

    #[tokio::test]
    async fn mqtt_connack_recusa_rc_diferente_de_zero() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            if let Ok((mut s, _)) = l.accept().await {
                drain_connect(&mut s).await;
                let _ = s.write_all(&[0x20, 0x02, 0x00, 0x05]).await;
            }
        });
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let err = relay_mqtt::mqtt_connack(stream, "127.0.0.1")
            .await
            .expect_err("rc=5 deve ser recusa");
        assert!(err.contains("rc=5"), "erro deve citar o código: {err}");
        let _ = srv.await;
    }

    #[tokio::test]
    async fn mqtt_connack_aceita_rc_zero() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            if let Ok((mut s, _)) = l.accept().await {
                drain_connect(&mut s).await;
                let _ = s.write_all(&[0x20, 0x02, 0x00, 0x00]).await;
            }
        });
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        relay_mqtt::mqtt_connack(stream, "127.0.0.1")
            .await
            .expect("rc=0 é conexão aceita");
        let _ = srv.await;
    }
}
