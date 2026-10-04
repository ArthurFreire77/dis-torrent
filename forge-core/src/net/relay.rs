//! Relay P2P via brokers MQTT públicos — "todo mundo na mesma rede".
//!
//! Quando a conexão TCP direta falha (NAT de operadora, CGNAT, sem UPnP, sem
//! porta aberta), os peers trocam frames pela infra pública de rendezvous,
//! sem nenhuma configuração. O tópico de cada identidade É o endereço:
//! `distorrent_r_<fingerprint>`.
//!
//! Segurança: o relay transporta bytes opacos. O handshake autenticado
//! (ed25519 + transcript) e a sessão ChaCha20Poly1305 rodam POR CIMA do
//! relay, idênticos ao TCP — o relay vê só ciphertext (+ Hello/HelloAck em
//! claro, mesma exposição do announce já existente). Nenhuma cripto nova.
//!
//! Frames grandes são fatiados (limite por mensagem dos brokers) e remontados.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::task::{Context, Poll};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::mpsc;

use crate::net::engine::NetworkEngine;
use crate::protocol::SecureFrame;
use crate::{ForgeError, Result};

pub const RELAY_TOPIC_PREFIX: &str = "distorrent_r_";
/// Tamanho máximo do `data` (base64) por mensagem de relay — envelope JSON +
/// folga para brokers MQTT e compat. com versões antigas do protocolo.
pub const RELAY_CHUNK_B64: usize = 3000;
/// Máximo de bytes de UM frame pelo relay (igual ao TCP).
pub const RELAY_MAX_FRAME: usize = (1 << 20) + 4;

pub fn relay_topic(fp: &str) -> String {
    format!("{RELAY_TOPIC_PREFIX}{fp}")
}

/// Tópico de ANÚNCIO de endpoint (direto P2P): `{fp, addr, lan, nickname}`.
/// Separado do relay (chunks): o manager ignora (sem `to`), e o lookup
/// permite dial DIRETA de baixa latência quando o NAT deixa (UPnP ok).
pub fn announce_topic(fp: &str) -> String {
    format!("distorrent_a_{fp}")
}

/// Contadores do plano de dados do relay (`distorrent_r_*`).
/// `posts` = nº de `post()` no tópico de relay; `poll_hits` = nº de `poll()`
/// no tópico de relay que retornaram dados (poll vazio do manager idle NÃO
/// conta). Tópicos de ANÚNCIO (`distorrent_a_*`, descoberta de endpoint para
/// dial direta) NÃO contam — senão o announce periódico de endpoint (a cada
/// 5s quando há IP público) poluía a prova "direta não usa relay".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RelayStats {
    pub posts: u64,
    pub poll_hits: u64,
}

/// true só para o plano de dados do relay (não anúncio/descoberta).
#[inline]
fn is_relay_topic(topic: &str) -> bool {
    topic.starts_with(RELAY_TOPIC_PREFIX)
}

/// Uma fatia de um frame.
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

/// Envelope OPACO do peer-relay (F3): o intermediário só vê um `rid`
/// aleatório, índices e o `data` (ciphertext E2E A↔B). SEM `from`/`to`/
/// `msg_id` em claro — a identidade é derivada no receptor (Hello em claro
/// ou decifra do AEAD).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct OpaqueRelayEnvelope {
    v: u8,
    rid: String,
    idx: u32,
    total: u32,
    data: String,
}

/// Backend de transporte do relay. O padrão é o `MultiRelay` com pernas MQTT
/// públicas (push, baixa latência, zero config); `MemRelay` é o backend de
/// testes (in-memory, sem rede). `NtfyRelay` só existe para os modos de
/// privacidade com proxy SOCKS5 ativados manualmente pelo usuário.
/// Métodos retornam futures boxeados para o trait ser `dyn` (sem async-trait).
pub trait RelayBackend: Send + Sync {
    fn post<'a>(
        &'a self,
        topic: &'a str,
        body: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;
    /// Retorna mensagens novas do tópico (poll curto; lista pode vir vazia).
    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>>;

    /// Sinais push (MQTT): acordam o manager sem esperar o tick de poll.
    /// Pernas sem push (memória) retornam vazio.
    fn wakes(&self) -> Vec<Arc<tokio::sync::Notify>> {
        Vec::new()
    }

    /// Contadores do plano de dados (default zerado p/ backends legados).
    fn stats(&self) -> RelayStats {
        RelayStats::default()
    }

    /// Entrega o corpo de um `SecureFrame::PeerRelayData` ao pedido pendente do
    /// peer-relay (correlaciona por `req_id`). Backends que NÃO são peer-relay
    /// retornam `false` (o engine só loga em debug). Default: não aplicável.
    fn deliver_peer_relay(&self, _req_id: u32, _bodies: Vec<String>) -> bool {
        false
    }

    /// (F3) O transporte deste backend usa o envelope OPACO ao intermediário
    /// (sem identidade)? Só o peer-relay devolve `true`.
    fn opaque_envelope(&self) -> bool {
        false
    }
}

/// Túnel TCP local → SOCKS5: escuta em 127.0.0.1:porta-efêmera e encaminha
/// CADA conexão aceita pelo proxy SOCKS5 (ex.: Tor em 127.0.0.1:9050) até o
/// alvo `host:porta` — com o HOSTNAME entregue ao proxy (semântica socks5h:
/// DNS resolvido DENTRO do proxy/rede Tor; nada de DNS local vazando o alvo).
///
/// Por quê: rumqttc só fala TCP/TLS direto (sem SOCKS). Com este túnel, as
/// pernas MQTT públicas continuam sendo usadas até em proxy/Tor — o tráfego
/// do broker nunca sai direto, passa SEMPRE pelo proxy. Nada de ntfy.sh.
pub struct SocksTunnel {
    /// Endereço local do listener (127.0.0.1:porta) para apontar o rumqttc.
    pub local_addr: std::net::SocketAddr,
}

impl SocksTunnel {
    /// Sobe o túnel para `target_host:target_port` via `proxy` ("host:porta").
    /// 100% std (listener + threads): precisa funcionar EM QUALQUER contexto,
    /// inclusive comandos Tauri síncronos sem runtime tokio rodando (é o caso
    /// do `privacy_set` ativando o modo proxy). Falha de proxy só loga em
    /// debug — o MQTT reconecta sozinho e o accept loop nunca morre.
    pub fn spawn(proxy: String, target_host: String, target_port: u16) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback túnel");
        let local_addr = listener.local_addr().expect("local_addr túnel");
        let target = crate::net::socks5::SocksTarget::Host(target_host, target_port);
        move_spawn_tunnel(listener, proxy, target);
        Self { local_addr }
    }
}

/// Accept loop do túnel: thread própria, 1 thread por conexão encaminhada.
fn move_spawn_tunnel(
    listener: std::net::TcpListener,
    proxy: String,
    target: crate::net::socks5::SocksTarget,
) {
    std::thread::spawn(move || {
        loop {
            match listener.accept() {
                Ok((down, _)) => {
                    let (proxy, target) = (proxy.clone(), target.clone());
                    std::thread::spawn(move || {
                        forward_via_socks(down, &proxy, &target).ok();
                    });
                }
                Err(_) => {
                    // erro transiente de accept não derruba o túnel
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });
}

/// Um lado de forward: negocia SOCKS5 (sync) e encosta `down` ↔ `up` com
/// io::copy nas duas direções (1 thread extra p/ uplink; esta trata downlink).
fn forward_via_socks(
    down: std::net::TcpStream,
    proxy: &str,
    target: &crate::net::socks5::SocksTarget,
) -> std::io::Result<()> {
    let up = crate::net::socks5::socks5_connect_sync(proxy, target).map_err(|e| {
        tracing::debug!(%proxy, "túnel socks: circuito não abriu ({e})");
        std::io::Error::other(e.to_string())
    })?;
    down.set_nodelay(true).ok();
    up.set_nodelay(true).ok();
    let mut down_c = down.try_clone()?;
    let mut up_c = up.try_clone()?;
    // uplink em thread paralela — copy_bidirectional síncrona daria deadlock.
    let uplink = std::thread::spawn(move || {
        let _ = std::io::copy(&mut down_c, &mut up_c);
    });
    let mut down = down;
    let mut up = up; // downlink neste thread
    let _ = std::io::copy(&mut up, &mut down);
    // um lado fechou → força o outro a sair do io::copy e a thread uplink acaba
    let _ = up.shutdown(std::net::Shutdown::Both);
    let _ = down.shutdown(std::net::Shutdown::Both);
    uplink.join().ok();
    Ok(())
}

/// Backend real nº 2: MQTT público (porta 1883) — passa onde HTTPS filtrado
/// por host cai. Sem conta, sem cadastro: publica no tópico do peer, assina o próprio.
/// Push (não poll): o pump entrega no inbox; `poll()` assina (1ª vez) e drena.
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
    /// Acordado a cada publish recebido — o manager pula o poll sem esperar o tick.
    wake: Arc<tokio::sync::Notify>,
}

/// Sanitiza um fragmento para o client_id MQTT (só [a-z0-9-]).
fn sanitize_client_part(s: &str) -> String {
    let mut out: String = s
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').to_string()
}

impl MqttRelay {
    pub fn new(host: &str, port: u16) -> Self {
        // client_id estável por host (sem rand): com clean_session=false o
        // broker retoma a sessão entre restarts e entrega o que chegou offline.
        let stable = sanitize_client_part(host);
        let short = stable.chars().take(24).collect::<String>();
        Self::new_with_client_id(host, port, &format!("forge-{short}"))
    }

    /// client_id explícito (produção: `forge-{fp12}-{host}` estável por
    /// identidade — ver `MultiRelay::default_routes_with_fp`).
    pub fn new_with_client_id(host: &str, port: u16, client_id: &str) -> Self {
        Self {
            host: host.to_string(),
            port,
            client_id: client_id.to_string(),
            shared: Arc::new(StdMutex::new(MqttState {
                client: None,
                eventloop: None,
                pump: false,
                subscribed: HashSet::new(),
                inbox: HashMap::new(),
                wake: Arc::new(tokio::sync::Notify::new()),
            })),
            posts: Arc::new(AtomicU64::new(0)),
            poll_hits: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Perna MQTT com identidade estável: `forge-{fp[:12]}-{host}`.
    pub fn new_with_fp(host: &str, port: u16, fp: &str) -> Self {
        let fp12: String = fp.chars().take(12).collect();
        let short = sanitize_client_part(host)
            .chars()
            .take(16)
            .collect::<String>();
        Self::new_with_client_id(host, port, &format!("forge-{fp12}-{short}"))
    }

    /// Garante client + pump rodando (idempotente, sem tópico ainda).
    fn ensure(&self) -> Option<rumqttc::AsyncClient> {
        let mut st = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        if st.client.is_none() {
            let mut opts =
                rumqttc::MqttOptions::new(self.client_id.clone(), self.host.clone(), self.port);
            // keepalive 10s (4G/NAT fecha idle rápido; 15s morria em rádio
            // dormindo sem detectar — 10s mantém o NAT binding e detecta
            // queda em ~15s para o pump reconectar).
            opts.set_keep_alive(Duration::from_secs(10));
            // Sessão persistente: o broker guarda assinatura + offline
            // (QoS1) para este client_id estável — frame publicado com o
            // celular dormindo é entregue ao voltar.
            opts.set_clean_session(false);
            let (client, eventloop) = rumqttc::AsyncClient::new(opts, 64);
            st.client = Some(client);
            st.eventloop = Some(eventloop);
        }
        let client = st.client.clone()?;
        if !st.pump {
            st.pump = true;
            let shared = self.shared.clone();
            let host = self.host.clone();
            if let Some(eventloop) = st.eventloop.take() {
                tokio::spawn(async move {
                    mqtt_pump(eventloop, shared, &host).await;
                });
            }
        }
        Some(client)
    }
}

/// Pump: mantém a conexão e entrega publishes no inbox POR TÓPICO.
/// Reconexão: rumqttc 0.25 já reconecta sozinho dentro de `eventloop.poll()`
/// (backoff interno, sem código manual — aqui só logamos e seguimos no loop;
/// `poll()` nunca retorna Err fatal, sempre tenta de novo). QoS1
/// (AtLeastOnce): o broker retém para sessão persistente e reentrega ao
/// voltar do 4G dormindo; a camada engine já dedupa (retransmissão Hello +
/// outbox/ACK de DM). Inbox por tópico com cap 512/tópico: best-effort.
/// Tópico `distorrent_r_<fp>` e envelope JSON inalterados (compat 4.3.1/4.3.2).
async fn mqtt_pump(
    mut eventloop: rumqttc::EventLoop,
    shared: Arc<StdMutex<MqttState>>,
    host: &str,
) {
    loop {
        match eventloop.poll().await {
            Ok(rumqttc::Event::Incoming(rumqttc::Incoming::ConnAck(_))) => {
                // Reassina no próximo poll (idempotente; com sessão persistente
                // o broker em geral já reteve, mas reassinar cobre expiração).
                let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
                st.subscribed.clear();
            }
            Ok(rumqttc::Event::Incoming(rumqttc::Incoming::Publish(p))) => {
                if let Ok(text) = String::from_utf8(p.payload.to_vec()) {
                    let wake = {
                        let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
                        // CAP 512/tópico (~1.5MB) + 256 tópicos: evita OOM se o
                        // peer esma ou o celular dorme com pump acumulando.
                        // Além do cap, descarta (best-effort): o dial retransmite
                        // Hello a cada 5s e o HelloOk vai 3x, então o handshake se
                        // recupera; DMs usam outbox/ACK na camada engine.
                        let topic = p.topic.clone();
                        let entry = st.inbox.entry(topic).or_default();
                        if entry.len() < 512 {
                            entry.push(text);
                        } else if st.inbox.len() > 256 {
                            // muitos tópicos distintos: poda o mais cheio
                            if let Some((k, _)) = st
                                .inbox
                                .iter()
                                .max_by_key(|(_, v)| v.len())
                                .map(|(k, v)| (k.clone(), v.len()))
                            {
                                st.inbox.remove(&k);
                            }
                        }
                        st.wake.clone()
                    };
                    wake.notify_one(); // push: acorda o manager na hora (sem esperar o tick)
                }
            }
            Ok(_) => {}
            Err(e) => {
                tracing::debug!("relay mqtt ({host}) evento/reconexão: {e}");
            }
        }
    }
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
                return Err(ForgeError::Protocol("relay mqtt sem client".into()));
            };
            // QoS1: o broker confirma (PUBACK) e retém para sessão persistente —
            // frame com o celular offline é entregue ao voltar (4G dormindo).
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
            .map_err(|_| ForgeError::Protocol("relay mqtt publish timeout".into()))?
            .map_err(|e| ForgeError::Protocol(format!("relay mqtt post falhou: {e}")))?;
            Ok(())
        })
    }

    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>> {
        Box::pin(async move {
            let Some(client) = self.ensure() else {
                return Err(ForgeError::Protocol("relay mqtt sem client".into()));
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
                // `try_subscribe` NÃO espera o SUBACK: enfileira e segue. Antes,
                // um broker inalcançável (ex.: porta 1883 bloqueada no 4G) fazia
                // o subscribe esperar 10s e TRAVAVA o poll inteiro — daí o delay.
                // A assinatura sai sozinha quando/se a conexão subir; o ConnAck
                // limpa `subscribed` para reassinar após reconexão.
                // Várias assinaturas coexistem (relay + announce); o inbox é
                // por tópico, então polls concorrentes não se roubam.
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

/// Multi-estrada: posta em TODAS as pernas, lê de TODAS e junta.
/// Vale QUALQUER UMA mutuamente alcançável (dedupe por conteúdo já existe
/// no manager). Pernas padrão: 4 brokers MQTT públicos (ntfy removido).
/// `post` é CONCORRENTE e retorna no PRIMEIRO Ok (latência = min das pernas,
/// não max nem soma); as demais pernas seguem em background (detached) como
/// cópias redundantes — redundância sem pagar max-latency. Só retorna Err se
/// TODAS falharem (espera todas nesse caso; `relay_post_loop` usa Err para
/// derrubar a sessão e o maintain rediscar). `poll` aguarda todas (completude:
/// junta o que cada perna tem; perna com erro é ignorada).
pub struct MultiRelay {
    legs: Vec<Arc<dyn RelayBackend>>,
}

impl MultiRelay {
    /// Rotas padrão: SOMENTE brokers MQTT públicos com push (baixa latência).
    /// ntfy.sh foi removido do caminho principal (lento/poll/dependência
    /// externa instável); o relay RESTANTE é MQTT multi-estrada com primeiro-Ok.
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

    /// Rotas padrão com client_id estável por identidade
    /// (`forge-{fp12}-{host}`): com clean_session=false o broker retém
    /// assinatura + QoS1 offline entre restarts.
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

    /// Rotas alternativas (testes e debug).
    pub fn of(legs: Vec<Arc<dyn RelayBackend>>) -> Self {
        Self { legs }
    }

    /// Rota de relay para modos anônimos (proxy/Tor ativados manualmente):
    /// AS MESMAS 4 pernas MQTT públicas, cada uma pelo PRÓPRIO túnel SOCKS5
    /// (`SocksTunnel` — hostname resolvido PELO proxy, sem DNS local). O
    /// tráfego nunca sai direto: broker só vê o IP do proxy/Tor. ntfy.sh foi
    /// REMOVIDO por completo — nada de dependência externa HTTP.
    pub fn proxied_routes(proxy: &str) -> Result<Self> {
        // Fail-fast honesto: proxy com formato inválido dá Err claro (o
        // engine fail-closed desliga o relay nesses modos, nunca vaza IP).
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

    /// `proxied_routes` com client_id estável por identidade. O id deriva do
    /// host ALVO (não do 127.0.0.1:porta efêmera do túnel, que muda por boot).
    ///
    /// BUG que isto corrige: o id era IDÊNTICO ao do modo direto
    /// (`forge-{fp12}-{broker}`). Ligar o proxy cria um backend NOVO sem
    /// derrubar o ANTIGO — as sessões antigas continuam vivas dentro do
    /// `relay_post_loop`. Com o mesmo `client_id` e `clean_session(false)`, o
    /// broker despeja uma sessão quando a outra entra, e o `mqtt_pump`
    /// reconecta: ping-pong INFINITO de connect/kick. O proxy ficava mudo
    /// (nenhuma entrega → nenhum Ack → o outbox do remetente reenvia a cada
    /// 15s → o destinatário vê a mesma mensagem em loop), e a legada ainda
    /// assinava o tópico, enchendo o inbox sem nunca ser drenada.
    ///
    /// O sufixo `-px` dá à perna via proxy uma sessão PERSISTENTE própria: o
    /// broker não expulsa mais a outra, o offline queue continua funcionando,
    /// e voltar ao modo direto (que usa o id sem sufixo) reabastece a sessão
    /// antiga em vez de brigar com a proxied.
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
                &format!("forge-{fp12}-{short}-px"),
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
            // PRIMEIRO-Ok com background: latência = min das pernas (não max).
            // Cada perna roda em task detached (tokio::spawn): o 1º Ok retorna
            // já ao `relay_post_loop` (que segue p/ o próximo chunk/frame sem
            // esperar a perna lenta);
            // as demais tasks NÃO são abortadas (drop do rx não cancela spawn)
            // e completam o post em background como cópias redundantes
            // (lossy: 20%/leg → 0.2^n com n pernas; ChaCha sem retry segue
            // protegida pela redundância). Só retorna Err se TODAS falharem
            // (espera as n respostas; `relay_post_loop` usa Err p/ derrubar
            // a sessão e o maintain rediscar — 1 Ok já prova perna viva).
            // Fast-path 1 perna: sem spawn/channel.
            if self.legs.is_empty() {
                return Err(ForgeError::Protocol("relay sem pernas".into()));
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
            let mut last_err = ForgeError::Protocol("relay sem pernas".into());
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
            // CONCORRENTE, cada perna com TETO de 3s, e COLETA TODAS.
            // IMPORTANTE: NÃO retornar cedo — `MqttRelay::poll` faz
            // `mem::take` do inbox (o broker NÃO re-serve), então cancelar a
            // tarefa no meio perderia mensagens de vez; por isso esperamos
            // todas. O teto de 3s por perna evita que uma perna travada
            // (broker bloqueado no 4G) segure o poll para sempre.
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
        // Repassa às pernas (na prática só a PeerRelayBackend resolve).
        let mut ok = false;
        for leg in &self.legs {
            if leg.deliver_peer_relay(req_id, bodies.clone()) {
                ok = true;
            }
        }
        ok
    }

    fn opaque_envelope(&self) -> bool {
        // Em produção o peer-relay é um backend único; MultiRelay fica no relay
        // público (clássico). Ainda assim, propaga a marca se houver perna opaca.
        self.legs.iter().any(|l| l.opaque_envelope())
    }
}

/// Backend peer-relay: roteia o transporte por UM peer intermediário ONLINE
/// (cifrado E2E de ponta a ponta) em vez do broker público. `post` vira
/// `PeerRelayPut` e `poll` vira `PeerRelayGet` + espera `PeerRelayData`
/// (correlacionado por `req_id` via oneshot). O intermediário só vê ciphertext.
///
/// `engine` é `Weak` para não criar ciclo (o engine guarda este backend).
pub const PEER_RELAY_POLL_TIMEOUT: Duration = Duration::from_secs(2);
/// Cap de pedidos pendentes (anti-DoS local; acima disso limpa o mapa).
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

    /// Resolve o oneshot pendente do `req_id`. `false` se não havia pedido
    /// (resposta órfã/atrasada) — o engine só loga em debug.
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

    /// Nº de pedidos aguardando resposta (diagnóstico/testes).
    pub fn pending_len(&self) -> usize {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// (F2) Ids pendentes (diagnóstico/testes).
    pub fn pending_req_ids(&self) -> Vec<u32> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect()
    }
}

/// (F2) `req_id` ALEATÓRIO (nunca sequencial/previsível).
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
                return Err(ForgeError::Protocol("peer-relay: engine encerrado".into()));
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
        // (F2) req_id ALEATÓRIO e único entre os pendentes (não sequencial).
        let (req_id, rx) = {
            let mut p = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if p.len() >= PEER_RELAY_MAX_PENDING {
                p.clear(); // anti-DoS local: descarta pedidos velhos
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
            return Box::pin(async { Ok::<Vec<String>, ForgeError>(Vec::new()) });
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
                    // timeout/remetente caiu: limpa e devolve vazio (poll-driven)
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

/// Estado de UMA perna do relay para diagnóstico (tela "Diagnóstico de conexão").
/// `ok` = alcançável agora; `last_error` = motivo curto da falha (para 4G/NAT);
/// `latency_ms` = ida-volta do probe (quando ok).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RelayLegStatus {
    pub name: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub last_error: Option<String>,
}

/// Probes curtos (timeout ~3s direto / ~10s via proxy) nos MESMOS endpoints do
/// `MultiRelay::default_routes`.
/// - MQTT (1883): TCP connect — detecta porta bloqueada no 4G/NAT/CGNAT.
///   Em modo proxy/Tor o connect vai por SOCKS5 (mesmo túnel do relay).
/// Não posta nada (sem spam na infra pública), só mede alcançabilidade.
/// `proxy = None` → direto. Use [`check_relay_legs_via`] nos modos proxy/Tor.
pub async fn check_relay_legs() -> Vec<RelayLegStatus> {
    check_relay_legs_via(None).await
}

/// Igual a [`check_relay_legs`], mas roteia TODAS as pernas por SOCKS5 quando
/// `proxy` é informado (`host:porta`, ex.: `127.0.0.1:9050` do Tor).
///
/// Por que existe: em privacidade "proxy"/"Tor" o probe direto revelaria o IP
/// real aos hosts públicos. Aqui o TCP do MQTT passa por `socks5_connect` —
/// nada sai direto.
pub async fn check_relay_legs_via(proxy: Option<&str>) -> Vec<RelayLegStatus> {
    use std::time::{Duration, Instant};

    let via = proxy.map(|p| format!(" via {p}")).unwrap_or_default();
    let is_proxied = proxy.is_some();
    // connect timeout: Tor abre circuito (pode passar de 5s); direto falha rápido.
    let connect_timeout = if is_proxied {
        Duration::from_secs(10)
    } else {
        Duration::from_secs(3)
    };
    let mqtt_hosts = [
        ("mqtt broker.emqx.io:1883", "broker.emqx.io", 1883u16),
        (
            "mqtt test.mosquitto.org:1883",
            "test.mosquitto.org",
            1883u16,
        ),
        (
            "mqtt broker.mqttdashboard.com:1883",
            "broker.mqttdashboard.com",
            1883u16,
        ),
        ("mqtt broker.hivemq.com:1883", "broker.hivemq.com", 1883u16),
    ];
    let mut out = Vec::new();
    for (name, host, port) in mqtt_hosts {
        let t0 = Instant::now();
        let res = tokio::time::timeout(connect_timeout, async {
            match proxy {
                Some(p) => crate::net::socks5::socks5_connect(
                    p,
                    &crate::net::socks5::SocksTarget::Host(host.to_string(), port),
                )
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
                None => tokio::net::TcpStream::connect((host, port))
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
            }
        })
        .await;
        match res {
            Ok(Ok(())) => out.push(RelayLegStatus {
                name: format!("{name}{via}"),
                ok: true,
                latency_ms: Some(t0.elapsed().as_millis() as u64),
                last_error: None,
            }),
            Ok(Err(e)) => out.push(RelayLegStatus {
                name: format!("{name}{via}"),
                ok: false,
                latency_ms: None,
                last_error: Some(short_err(&e)),
            }),
            Err(_) => out.push(RelayLegStatus {
                name: format!("{name}{via}"),
                ok: false,
                latency_ms: None,
                last_error: Some(format!(
                    "timeout {}s{}",
                    connect_timeout.as_secs(),
                    if is_proxied {
                        " (proxy/Tor inacessível ou lento?)"
                    } else {
                        " (porta 1883 bloqueada no 4G/NAT?)"
                    }
                )),
            }),
        }
    }
    // (sem probe ntfy: ntfy.sh foi removido por completo — nos modos proxy/Tor
    // as pernas são os MESMOS brokers MQTT, e o túnel SOCKS5 acima já os cobre)
    out
}

fn short_err(s: &str) -> String {
    let mut t = s.trim().replace('\n', " ");
    if t.len() > 160 {
        t.truncate(160);
    }
    t
}

/// TESTE ONLINE do proxy SOCKS5 (botão "Testar conexão" da UI): abre um
/// circuito REAL pelo proxy até os brokers MQTT públicos (mesmas pernas do
/// relay) e devolve a latência do primeiro que responder. Sem ntfy, sem
/// HTTP externo — é exatamente o caminho que o relay vai usar.
/// Err traz o motivo técnico (proxy inacessível / não é SOCKS5 / exige auth /
/// timeout) para a UI mostrar honestamente.
pub async fn proxy_online_test(proxy: &str) -> std::result::Result<u64, String> {
    use std::time::Instant;
    let t0 = Instant::now();
    let brokers = [
        ("broker.emqx.io", 1883u16),
        ("test.mosquitto.org", 1883),
        ("broker.hivemq.com", 1883),
    ];
    // CONCORRENTE: o 1º circuito que abrir encerra o teste (latência mínima).
    let (tx, mut rx) = mpsc::unbounded_channel::<std::result::Result<(), String>>();
    for (host, port) in brokers {
        let (tx, proxy) = (tx.clone(), proxy.to_string());
        tokio::spawn(async move {
            let r = crate::net::socks5::socks5_connect(
                &proxy,
                &crate::net::socks5::SocksTarget::Host(host.to_string(), port),
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string());
            let _ = tx.send(r);
        });
    }
    drop(tx);
    let mut first_err = "proxy não respondeu".to_string();
    while let Some(r) = rx.recv().await {
        match r {
            Ok(()) => return Ok(t0.elapsed().as_millis() as u64),
            Err(e) => first_err = e,
        }
    }
    Err(short_err(&first_err))
}

/// Backend de testes (in-memory, sem rede) COM push: `post()` acorda os
/// managers via `wakes()` (igual ao push MQTT), então o handshake em teste
/// fecha em ~RTT em vez de esperar o tick de poll. Sem risco p/ produção
/// (só testes usam; `notify_waiters` acorda TODOS — hub compartilhado).
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
            // waiters (não one): o hub é COMPARTILHADO entre os managers dos
            // dois peers em teste — `notify_one` poderia acordar só o
            // remetente (inbox vazio) e deixar o destinatário dormindo.
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

/// Fatia um frame completo (bytes length-prefixed) em envelopes prontos p/ post.
/// Fast-path single-chunk (handshake, chat, ACK, sinalização: 1 chunk): 1
/// base64 + 1 JSON direto, sem Vec intermediário/split/filter — overhead ~0
/// vs direta (só o envelope). Multi-chunk (arquivo/grande) segue fatiado.
pub fn chunk_frame(from: &str, to: &str, msg_id: &str, frame: &[u8]) -> Vec<String> {
    if frame.is_empty() {
        return Vec::new();
    }
    let b64 = B64.encode(frame);
    // FAST-PATH: cabe em 1 chunk → 1 envelope direto.
    if b64.len() <= RELAY_CHUNK_B64 {
        let s = serde_json::to_string(&RelayEnvelope {
            v: 1,
            from: from.to_string(),
            to: to.to_string(),
            msg_id: msg_id.to_string(),
            idx: 0,
            total: 1,
            data: b64,
        })
        .unwrap_or_default();
        if s.is_empty() {
            return Vec::new();
        }
        return vec![s];
    }
    let parts: Vec<&str> = b64
        .as_bytes()
        .chunks(RELAY_CHUNK_B64)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect();
    let total = parts.len().max(1) as u32;
    if parts.is_empty() {
        return Vec::new();
    }
    parts
        .into_iter()
        .enumerate()
        .map(|(i, data)| {
            serde_json::to_string(&RelayEnvelope {
                v: 1,
                from: from.to_string(),
                to: to.to_string(),
                msg_id: msg_id.to_string(),
                idx: i as u32,
                total,
                data: data.to_string(),
            })
            .unwrap_or_default()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// (F3) Fatiador OPACO do peer-relay: sem `from`/`to`/`msg_id`. O `rid`
/// aleatório (128 bits) só serve p/ remontar no receptor; o intermediário
/// não vê identidade alguma (só tamanho/índices e o ciphertext E2E).
pub fn chunk_frame_opaque(frame: &[u8]) -> Vec<String> {
    if frame.is_empty() {
        return Vec::new();
    }
    let b64 = B64.encode(frame);
    let rid = hex::encode(rand::random::<[u8; 16]>());
    // FAST-PATH: cabe em 1 chunk → 1 envelope direto.
    if b64.len() <= RELAY_CHUNK_B64 {
        let s = serde_json::to_string(&OpaqueRelayEnvelope {
            v: 1,
            rid,
            idx: 0,
            total: 1,
            data: b64,
        })
        .unwrap_or_default();
        if s.is_empty() {
            return Vec::new();
        }
        return vec![s];
    }
    let parts: Vec<&str> = b64
        .as_bytes()
        .chunks(RELAY_CHUNK_B64)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect();
    let total = parts.len().max(1) as u32;
    if parts.is_empty() {
        return Vec::new();
    }
    parts
        .into_iter()
        .enumerate()
        .map(|(i, data)| {
            serde_json::to_string(&OpaqueRelayEnvelope {
                v: 1,
                rid: rid.clone(),
                idx: i as u32,
                total,
                data: data.to_string(),
            })
            .unwrap_or_default()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// Remontagem de fatias → frame completo. Retorna `Some(frame)` quando fecha.
pub struct Reassembler {
    pending: HashMap<String, Vec<Option<String>>>,
}

impl Reassembler {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
        }
    }

    /// Alimenta com UMA mensagem do tópico. `my_fp` filtra o destinatário.
    /// Retorna `(remetente, frame_bytes)` quando uma mensagem completa.
    /// Fast-path single-chunk (`total==1`, handshake/chat/ACK): decodifica
    /// direto sem tocar no `pending` (sem HashMap/Vec/collect) — overhead ~0.
    pub fn feed(&mut self, my_fp: &str, raw: &str) -> Option<(String, Vec<u8>)> {
        // 1) envelope clássico do relay público (identidade + filtro por `to`).
        if let Ok(env) = serde_json::from_str::<RelayEnvelope>(raw) {
            return self.feed_classic(my_fp, env);
        }
        // 2) envelope OPACO do peer-relay (F3): sem identidade. Devolve `""`
        //    como remetente — o engine deriva do Hello em claro ou difunde aos
        //    streams de relay (o AEAD só autentica no peer certo).
        let env: OpaqueRelayEnvelope = serde_json::from_str(raw).ok()?;
        self.feed_opaque(env)
    }

    fn feed_classic(&mut self, my_fp: &str, env: RelayEnvelope) -> Option<(String, Vec<u8>)> {
        if env.v != 1 || env.to != my_fp {
            return None;
        }
        if env.from.len() > 64 || env.msg_id.len() > 64 || env.total == 0 || env.total > 512 {
            return None;
        }
        if env.idx >= env.total || env.data.len() > RELAY_CHUNK_B64 + 64 {
            return None;
        }
        // FAST-PATH: 1 chunk → sem estado, direto.
        if env.total == 1 {
            if env.idx != 0 {
                return None;
            }
            let bytes = B64.decode(env.data.as_bytes()).ok()?;
            if bytes.len() > RELAY_MAX_FRAME || bytes.len() < 4 {
                return None;
            }
            return Some((env.from, bytes));
        }
        // cap anti-DoS: esquece remontagens antigas
        if self.pending.len() > 256 {
            self.pending.clear();
        }
        let key = format!("{}:{}", env.from, env.msg_id);
        let slot = self
            .pending
            .entry(key)
            .or_insert_with(|| vec![None; env.total as usize]);
        if slot.len() != env.total as usize {
            return None;
        }
        slot[env.idx as usize] = Some(env.data.clone());
        if slot.iter().all(|p| p.is_some()) {
            let b64: String = slot.iter().flatten().cloned().collect();
            self.pending.remove(&format!("{}:{}", env.from, env.msg_id));
            let bytes = B64.decode(b64.as_bytes()).ok()?;
            if bytes.len() > RELAY_MAX_FRAME || bytes.len() < 4 {
                return None;
            }
            return Some((env.from, bytes));
        }
        None
    }

    fn feed_opaque(&mut self, env: OpaqueRelayEnvelope) -> Option<(String, Vec<u8>)> {
        if env.v != 1 || env.rid.len() > 64 || env.total == 0 || env.total > 512 {
            return None;
        }
        if env.idx >= env.total || env.data.len() > RELAY_CHUNK_B64 + 64 {
            return None;
        }
        // FAST-PATH: 1 chunk → sem estado, direto.
        if env.total == 1 {
            if env.idx != 0 {
                return None;
            }
            let bytes = B64.decode(env.data.as_bytes()).ok()?;
            if bytes.len() > RELAY_MAX_FRAME || bytes.len() < 4 {
                return None;
            }
            return Some((String::new(), bytes));
        }
        if self.pending.len() > 256 {
            self.pending.clear();
        }
        let key = format!("o:{}", env.rid);
        let slot = self
            .pending
            .entry(key)
            .or_insert_with(|| vec![None; env.total as usize]);
        if slot.len() != env.total as usize {
            return None;
        }
        slot[env.idx as usize] = Some(env.data.clone());
        if slot.iter().all(|p| p.is_some()) {
            let b64: String = slot.iter().flatten().cloned().collect();
            self.pending.remove(&format!("o:{}", env.rid));
            let bytes = B64.decode(b64.as_bytes()).ok()?;
            if bytes.len() > RELAY_MAX_FRAME || bytes.len() < 4 {
                return None;
            }
            return Some((String::new(), bytes));
        }
        None
    }
}

impl Default for Reassembler {
    fn default() -> Self {
        Self::new()
    }
}

/// Stream virtual sobre o relay: implementa AsyncRead/AsyncWrite com frames
/// length-prefixed idênticos ao fio TCP. `inbound` recebe frames completos
/// (do poller); `outbound` emite frames completos (o loop de post fatia e envia).
pub struct RelayStream {
    inbound: mpsc::UnboundedReceiver<Vec<u8>>,
    outbound: mpsc::UnboundedSender<Vec<u8>>,
    read_buf: Vec<u8>,
    read_pos: usize,
    write_buf: Vec<u8>,
}

impl RelayStream {
    pub fn new(
        inbound: mpsc::UnboundedReceiver<Vec<u8>>,
        outbound: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Self {
        Self {
            inbound,
            outbound,
            read_buf: Vec::new(),
            read_pos: 0,
            write_buf: Vec::new(),
        }
    }

    fn flush_frames(&mut self) -> std::io::Result<()> {
        loop {
            if self.write_buf.len() < 4 {
                break;
            }
            let len = u32::from_be_bytes([
                self.write_buf[0],
                self.write_buf[1],
                self.write_buf[2],
                self.write_buf[3],
            ]) as usize;
            if len > (1 << 20) {
                return Err(std::io::Error::other("frame gigante no relay"));
            }
            if self.write_buf.len() < 4 + len {
                break;
            }
            let frame: Vec<u8> = self.write_buf.drain(..4 + len).collect();
            self.outbound
                .send(frame)
                .map_err(|_| std::io::Error::other("relay fechado"))?;
        }
        Ok(())
    }
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
                Poll::Ready(None) => return Poll::Ready(Ok(())), // EOF
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

/// Loop de post: drena frames completos, fatia e publica no tópico do peer.
/// Fast-path single-chunk (1 post, sem loop): handshake/chat/ACK pagam 1
/// `post` (que já é 1º-Ok/min-latency no MultiRelay) sem overhead extra.
/// Só retorna (derruba sessão p/ o maintain rediscar) se TODAS as pernas
/// falharem — `MultiRelay::post` só dá Err nesse caso.
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
        // (F3) No peer-relay o envelope é OPACO ao intermediário (sem
        // from/to/msg_id); no relay público mantém o envelope clássico.
        let chunks = if backend.opaque_envelope() {
            chunk_frame_opaque(&frame)
        } else {
            let msg_id = format!("{}-{counter}", &my_fp[..my_fp.len().min(6)]);
            chunk_frame(&my_fp, &peer_fp, &msg_id, &frame)
        };
        // FAST-PATH: 1 chunk → 1 post direto (caso comum: handshake/chat/ACK).
        if chunks.len() == 1 {
            if let Err(e) = backend.post(&topic, &chunks[0]).await {
                tracing::debug!(%peer_fp, "relay post falhou (sessão cai, maintain tenta de novo): {e}");
                return; // relay fora — a sessão cai e o maintain tenta de novo
            }
            continue;
        }
        for chunk in chunks {
            if let Err(e) = backend.post(&topic, &chunk).await {
                tracing::debug!(%peer_fp, "relay post falhou (sessão cai, maintain tenta de novo): {e}");
                return; // relay fora — a sessão cai e o maintain tenta de novo
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_reassemble_roundtrip() {
        let frame: Vec<u8> = (0..20000u32).map(|i| (i % 251) as u8).collect();
        let mut prefixed = (frame.len() as u32).to_be_bytes().to_vec();
        prefixed.extend_from_slice(&frame);
        let chunks = chunk_frame("aaa", "bbb", "m1", &prefixed);
        assert!(chunks.len() > 1);
        let mut re = Reassembler::new();
        let mut done = None;
        // entrega fora de ordem (reverso) — tem que remontar igual
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
        // to != my_fp
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

    /// Modo proxy/Tor: o túnel SOCKS5 entrega o tráfego ao broker PELO proxy.
    /// Prova: servidor echo local só é alcançável através do mock SOCKS5 —
    /// se os bytes chegam/idam-e-voltam, o túnel roteou pelo proxy.
    #[tokio::test]
    async fn socks_tunnel_roteia_pelo_proxy() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 1) servidor echo local (faz o papel do "broker")
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

        // 2) proxy SOCKS5 mock (CONNECT real ao alvo por hostname)
        let proxy = crate::net::socks5::mock_server::spawn().await;

        // 3) túnel apontando ao echo VIA proxy (hostname, não IP — rota socks5h)
        let tun = SocksTunnel::spawn(proxy.to_string(), "127.0.0.1".to_string(), echo_addr.port());

        // 4) cliente conecta no LOCAL e ecoa — bytes só chegam se passaram
        //    pelo proxy (o mock faz CONNECT de verdade).
        let mut c = tokio::net::TcpStream::connect(tun.local_addr)
            .await
            .unwrap();
        c.write_all(b"via-tunel-socks5").await.unwrap();
        let mut buf = [0u8; 16];
        c.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"via-tunel-socks5");
    }

    /// `proxied_routes` monta as 4 pernas MQTT (uma por túnel) e valida o
    /// formato do proxy — endereço inválido dá Err claro (fail-closed).
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

    /// (F3) O envelope do peer-relay é opaco: nada de from/to/msg_id no corpo
    /// que o intermediário enxerga.
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
        // roundtrip pelo reassembler opaco devolve remetente desconhecido.
        let mut re = Reassembler::new();
        let (from, bytes) = re.feed("qualquer", raw).expect("opaco remonta");
        assert_eq!(from, "", "opaco não carrega identidade");
        assert_eq!(bytes, prefixed);
    }

    /// (F3) Fragmentação opaca remonta fora de ordem.
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

    /// BUG4: `poll(t)` devolve SÓ o tópico pedido — relay e announce não se roubam.
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
        // o anúncio sobreviveu ao poll do relay
        let out_a = r.poll(&ann_topic).await.expect("poll announce");
        assert_eq!(out_a, vec!["A1".to_string()]);
        // segundo poll esvazia (sem re-servir)
        let out_r2 = r.poll(&relay_topic).await.expect("poll relay vazio");
        assert!(out_r2.is_empty());
    }

    /// BUG5: client_id estável por identidade (não rand por boot).
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

    /// (F2) `req_id` é aleatório, nunca sequencial/previsível.
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
}
