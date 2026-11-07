// Relay mqtt: parte de net/relay.rs.
// Irmao do relay.rs; usa os tipos la declarados via super::*.

use super::relay_diag::short_err;
use super::*;

pub(crate) async fn mqtt_pump(
    mut eventloop: rumqttc::EventLoop,
    shared: Arc<StdMutex<MqttState>>,
    host: &str,
) {
    loop {
        match eventloop.poll().await {
            Ok(rumqttc::Event::Incoming(rumqttc::Incoming::ConnAck(_))) => {
                let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
                st.subscribed.clear();
                st.consec_errs = 0;
                st.last_err = None;
            }
            Ok(rumqttc::Event::Incoming(rumqttc::Incoming::Publish(p))) => {
                if let Ok(text) = String::from_utf8(p.payload.to_vec()) {
                    let wake = {
                        let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
                        let topic = p.topic.clone();
                        let entry = st.inbox.entry(topic).or_default();
                        if entry.len() < 512 {
                            entry.push(text);
                        } else if st.inbox.len() > 256 {
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
                    wake.notify_one();
                }
            }
            Ok(_) => {
                shared.lock().unwrap_or_else(|e| e.into_inner()).consec_errs = 0;
            }
            Err(e) => {
                let msg = e.to_string();
                tracing::debug!("relay mqtt ({host}) evento/reconexão: {msg}");
                let base_ms: u64 = if msg.contains("NotAuthorized")
                    || msg.contains("ServiceUnavailable")
                    || msg.contains("BadUserNamePassword")
                {
                    5000
                } else {
                    500
                };
                let wait = {
                    let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
                    st.consec_errs = st.consec_errs.saturating_add(1);
                    st.last_err = Some(short_err(&msg));
                    let shift = st.consec_errs.min(6);
                    (base_ms << shift).min(30_000)
                };
                tokio::time::sleep(Duration::from_millis(wait)).await;
            }
        }
    }
}

pub async fn mqtt_connack<S>(mut stream: S, client_id_host: &str) -> std::result::Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let client_id = format!(
        "distorrent-probe-{}-{}",
        crate::identity::now_ms(),
        client_id_host.replace('.', "-")
    );
    let host = client_id_host.as_bytes();
    let cid = client_id.as_bytes();

    let mut body = Vec::with_capacity(64 + cid.len());
    body.extend_from_slice(&[0x00, 0x04, b'M', b'Q', b'T', b'T']);
    body.push(0x04);
    body.push(0x02);
    body.extend_from_slice(&[0x00, 0x1e]);
    body.extend_from_slice(&[(cid.len() >> 8) as u8, (cid.len() & 0xff) as u8]);
    body.extend_from_slice(cid);
    let _ = host;

    let mut packet = vec![0x10u8];
    let mut n = body.len();
    loop {
        let mut d = (n % 128) as u8;
        n /= 128;
        if n > 0 {
            d |= 0x80;
        }
        packet.push(d);
        if n == 0 {
            break;
        }
    }
    packet.extend_from_slice(&body);

    stream
        .write_all(&packet)
        .await
        .map_err(|e| format!("escrita CONNECT: {e}"))?;

    let mut head = [0u8; 2];
    stream
        .read_exact(&mut head)
        .await
        .map_err(|e| format!("sem CONNACK: {e}"))?;
    if head[0] != 0x20 {
        return Err(format!("resposta inesperada do broker (0x{:02x})", head[0]));
    }
    let mut payload = vec![0u8; head[1] as usize];
    stream
        .read_exact(&mut payload)
        .await
        .map_err(|e| format!("CONNACK incompleto: {e}"))?;
    let rc = payload.get(1).copied().unwrap_or(0xff);
    if rc != 0 {
        return Err(format!("broker recusou a conexão (CONNACK rc={rc})"));
    }
    Ok(())
}

pub fn sanitize_client_part(s: &str) -> String {
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
        let stable = sanitize_client_part(host);
        let short = stable.chars().take(24).collect::<String>();
        Self::new_with_client_id(host, port, &format!("distorrent-{short}"))
    }

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
                last_err: None,
                consec_errs: 0,
                wake: Arc::new(tokio::sync::Notify::new()),
            })),
            posts: Arc::new(AtomicU64::new(0)),
            poll_hits: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn new_with_fp(host: &str, port: u16, fp: &str) -> Self {
        let fp12: String = fp.chars().take(12).collect();
        let short = sanitize_client_part(host)
            .chars()
            .take(16)
            .collect::<String>();
        Self::new_with_client_id(host, port, &format!("distorrent-{fp12}-{short}"))
    }

    pub(super) fn ensure(&self) -> Option<rumqttc::AsyncClient> {
        let mut st = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        if st.client.is_none() {
            let mut opts =
                rumqttc::MqttOptions::new(self.client_id.clone(), self.host.clone(), self.port);
            opts.set_keep_alive(Duration::from_secs(10));
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
