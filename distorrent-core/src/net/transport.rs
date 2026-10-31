//! Transporte TCP: frames length-prefixed + handshake autenticado + sessão AEAD.
//! Handshake Hello/HelloAck/HelloOk com transcript assinado (anti-MITM,
//! anti-replay); sessão ChaCha20Poly1305 com chave HKDF(X25519).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::{debug, warn};

use crate::identity::Keypair;
use crate::protocol::{
    handshake_transcript, session_key, HandshakeFrame, Hello, HelloAck, HelloOk,
};
use crate::{DistorrentError, Result};

/// Teto de UM frame (1 MiB): qualquer frame com dado do usuário precisa
/// respeitá-lo ANTES de enviar — estourar derruba a sessão do RECEPTOR.
pub const MAX_FRAME: u32 = 1 << 20; // 1 MiB
/// TCP direto: falha rápido (8s); 4G usa só-relay com timeouts próprios.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);

/// Leitura por perna SÓ-RELAY (4G lento, pior caso ~10s/voo): 30s de folga;
/// NÃO reduzir (relay_lossy 20% + 0-3s precisa dos 30s; só o estabelecimento).
pub const RELAY_HANDSHAKE_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Retransmissão do Hello do dial (mesmo transcript) a cada ~1,5s até Ack:
/// 1 Hello perdido não mata mais a tentativa; duplicatas são dedupadas.
pub const RELAY_HELLO_RESEND_INTERVAL: Duration = Duration::from_millis(1500);
/// Teto total do handshake relay (80s; cabe dentro dos 90s do engine).
pub const RELAY_HANDSHAKE_TOTAL_TIMEOUT: Duration = Duration::from_secs(80);
/// Teto do buffer de frames de sessão que chegam ANTES do HelloOk (flush
/// imediato do peer + reordenação). Acima disso, aborta (anti-DoS).
const RELAY_EARLY_STASH_CAP: usize = 4 << 20;

/// Janela de reordenação do receptor de sessão: o relay NÃO preserva ordem e
/// o nonce é sequencial — sem janela, um reorder dessincronizava e MATAVA a
/// sessão. Decifra com counters da janela e entrega em ordem.
pub const SESSION_REORDER_WINDOW: u64 = 256;
/// Espera do frame "cabeça" antes de pular o gap (frame perdido de verdade);
/// sessão segue viva — outbox/ACK reenvia a DM. 4s cobre o atraso do relay.
pub const SESSION_GAP_TIMEOUT: Duration = Duration::from_secs(4);

async fn write_frame(w: &mut (dyn AsyncWrite + Unpin + Send), bytes: &[u8]) -> Result<()> {
    let len = u32::try_from(bytes.len())
        .map_err(|_| DistorrentError::Protocol("frame gigante".into()))?;
    w.write_all(&len.to_be_bytes()).await?;
    w.write_all(bytes).await?;
    w.flush().await?;
    Ok(())
}

async fn read_frame(r: &mut (dyn AsyncRead + Unpin + Send)) -> Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    tokio::time::timeout(HANDSHAKE_TIMEOUT, r.read_exact(&mut len_buf))
        .await
        .map_err(|_| DistorrentError::Protocol("timeout lendo tamanho do frame".into()))??;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(DistorrentError::Protocol(format!("frame {len} > limite")));
    }
    let mut buf = vec![0u8; len as usize];
    tokio::time::timeout(HANDSHAKE_TIMEOUT, r.read_exact(&mut buf))
        .await
        .map_err(|_| DistorrentError::Protocol("timeout lendo frame".into()))??;
    Ok(buf)
}

async fn send_json<T: Serialize>(w: &mut (dyn AsyncWrite + Unpin + Send), v: &T) -> Result<()> {
    write_frame(
        w,
        &serde_json::to_vec(v).map_err(|e| DistorrentError::Protocol(e.to_string()))?,
    )
    .await
}

async fn read_json<T: DeserializeOwned>(r: &mut (dyn AsyncRead + Unpin + Send)) -> Result<T> {
    let bytes = read_frame(r).await?;
    serde_json::from_slice(&bytes)
        .map_err(|e| DistorrentError::Protocol(format!("json inválido: {e}")))
}

async fn read_frame_with(
    r: &mut (dyn AsyncRead + Unpin + Send),
    per_read: Duration,
) -> Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    tokio::time::timeout(per_read, r.read_exact(&mut len_buf))
        .await
        .map_err(|_| {
            DistorrentError::Protocol("timeout lendo tamanho do frame (relay)".into())
        })??;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(DistorrentError::Protocol(format!("frame {len} > limite")));
    }
    let mut buf = vec![0u8; len as usize];
    tokio::time::timeout(per_read, r.read_exact(&mut buf))
        .await
        .map_err(|_| DistorrentError::Protocol("timeout lendo frame (relay)".into()))??;
    Ok(buf)
}

/// Leitura de SESSÃO: 150s só como proteção contra hang — a liveness é
/// governada pelo outer `timeout(ping_timeout)` (25s/120s), que dispara antes.
async fn read_frame_session(r: &mut (dyn AsyncRead + Unpin + Send)) -> Result<Vec<u8>> {
    read_frame_with(r, Duration::from_secs(150)).await
}

/// Leitura com replay: devolve primeiro frames de sessão chegados ANTES do
/// HelloOk (sem isso, descartá-los dessincronizava o nonce e matava a sessão).
struct ReplayRead {
    buf: Vec<u8>,
    pos: usize,
    inner: Box<dyn AsyncRead + Unpin + Send>,
}

impl ReplayRead {
    fn wrap(
        stashed: Vec<u8>,
        inner: Box<dyn AsyncRead + Unpin + Send>,
    ) -> Box<dyn AsyncRead + Unpin + Send> {
        if stashed.is_empty() {
            inner
        } else {
            Box::new(Self {
                buf: stashed,
                pos: 0,
                inner,
            })
        }
    }
}

impl AsyncRead for ReplayRead {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use std::task::Poll;
        if self.pos < self.buf.len() {
            let n = (self.buf.len() - self.pos).min(buf.remaining());
            buf.put_slice(&self.buf[self.pos..self.pos + n]);
            self.pos += n;
            return Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

/// Guarda UM frame de sessão chegado cedo (wire bytes len+body) no stash.
/// Retorna Err se o cap anti-DoS estourar.
fn stash_early(stashed: &mut Vec<u8>, body: &[u8]) -> Result<()> {
    if stashed.len() + 4 + body.len() > RELAY_EARLY_STASH_CAP {
        return Err(DistorrentError::Protocol(
            "stash de frames precoces estourou (anti-DoS)".into(),
        ));
    }
    stashed.extend_from_slice(&(body.len() as u32).to_be_bytes());
    stashed.extend_from_slice(body);
    Ok(())
}

fn is_relay_timeout(e: &DistorrentError) -> bool {
    e.to_string().contains("timeout")
}

/// Sessão estabelecida: halves de leitura/escrita + cifra.
/// Funciona sobre TCP ou sobre o relay (stream virtual) — os halves são
/// boxed para o mesmo código rodar nos dois transportes.
pub struct Session {
    read: Box<dyn AsyncRead + Unpin + Send>,
    write: Box<dyn AsyncWrite + Unpin + Send>,
    cipher: ChaCha20Poly1305,
    send_counter: u64,
    recv_counter: u64,
    send_dir: u8,
    recv_dir: u8,
}

/// Metade de escrita — movida para a writer task.
pub struct SessionWriter {
    write: Box<dyn AsyncWrite + Unpin + Send>,
    cipher: ChaCha20Poly1305,
    counter: u64,
    dir: u8,
}

/// Metade de leitura — fica no reader loop (com timeout/heartbeat).
/// Tolerante a reordenação/perda: buffers de frames fora de ordem + pulo de
/// gap (ver `SESSION_REORDER_WINDOW`/`SESSION_GAP_TIMEOUT`).
pub struct SessionReader {
    read: Box<dyn AsyncRead + Unpin + Send>,
    cipher: ChaCha20Poly1305,
    counter: u64,
    dir: u8,
    /// Plaintexts decifrados fora de ordem, indexados pelo counter do nonce.
    pending: BTreeMap<u64, Vec<u8>>,
    /// Início da espera pelo frame "cabeça" ausente (None = em ordem / sem gap).
    gap_since: Option<Instant>,
}

impl Session {
    fn new(
        read: Box<dyn AsyncRead + Unpin + Send>,
        write: Box<dyn AsyncWrite + Unpin + Send>,
        key: [u8; 32],
        initiator: bool,
    ) -> Self {
        Self {
            read,
            write,
            cipher: ChaCha20Poly1305::new((&key).into()),
            send_counter: 0,
            recv_counter: 0,
            send_dir: if initiator { 0 } else { 1 },
            recv_dir: if initiator { 1 } else { 0 },
        }
    }

    pub fn split(self) -> (SessionReader, SessionWriter) {
        (
            SessionReader {
                read: self.read,
                cipher: self.cipher.clone(),
                counter: self.recv_counter,
                dir: self.recv_dir,
                pending: BTreeMap::new(),
                gap_since: None,
            },
            SessionWriter {
                write: self.write,
                cipher: self.cipher,
                counter: self.send_counter,
                dir: self.send_dir,
            },
        )
    }
}

impl SessionWriter {
    fn nonce(&mut self) -> Nonce {
        let c = self.counter;
        self.counter += 1;
        build_nonce(self.dir, c)
    }

    pub async fn send<T: Serialize>(&mut self, v: &T) -> Result<()> {
        let plaintext =
            serde_json::to_vec(v).map_err(|e| DistorrentError::Protocol(e.to_string()))?;
        let nonce = self.nonce();
        let ct = self
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: &plaintext,
                    aad: b"distorrent/frame",
                },
            )
            .map_err(|_| DistorrentError::Crypto("falha ao cifrar frame".into()))?;
        write_frame(&mut self.write, &ct).await
    }

    /// Envia VÁRIOS frames numa única escrita TCP (batching): cada frame
    /// mantém seu nonce sequencial e o wire format idêntico — só o número
    /// de syscalls muda. O receptor não percebe diferença.
    /// O CHAMADOR limita quantos frames por classe (bulky ≤ poucos por vez).
    /// Retorna os tamanhos de wire por frame (para métricas), na mesma ordem.
    pub async fn send_batch<T: Serialize>(&mut self, frames: &[T]) -> Result<Vec<usize>> {
        let mut wire = Vec::with_capacity(frames.len().saturating_mul(1024));
        let mut sizes = Vec::with_capacity(frames.len());
        for v in frames {
            let plaintext =
                serde_json::to_vec(v).map_err(|e| DistorrentError::Protocol(e.to_string()))?;
            let nonce = self.nonce();
            let ct = self
                .cipher
                .encrypt(
                    &nonce,
                    Payload {
                        msg: &plaintext,
                        aad: b"distorrent/frame",
                    },
                )
                .map_err(|_| DistorrentError::Crypto("falha ao cifrar frame".into()))?;
            wire.extend_from_slice(&(ct.len() as u32).to_be_bytes());
            wire.extend_from_slice(&ct);
            sizes.push(4 + ct.len());
        }
        self.write.write_all(&wire).await?;
        self.write.flush().await?;
        Ok(sizes)
    }
}

impl SessionReader {
    pub async fn recv<T: DeserializeOwned>(&mut self) -> Result<T> {
        let (v, _) = self.recv_sized::<T>().await?;
        Ok(v)
    }

    /// `recv` + tamanho do plaintext (para métricas de bytes RX sem
    /// re-serializar o frame).
    pub async fn recv_sized<T: DeserializeOwned>(&mut self) -> Result<(T, usize)> {
        // Sessão usa timeout longo (150s): a liveness real é do outer
        // ping_timeout (25s/120s). Ordenação: decifra com JANELA de counters e
        // entrega em ordem; gap de perda é pulado após SESSION_GAP_TIMEOUT.
        loop {
            // 1) cabeça já bufferizada? Entrega (fast-path em ordem também cai aqui).
            if let Some(pt) = self.pending.remove(&self.counter) {
                self.counter += 1;
                self.gap_since = None;
                let size = pt.len();
                let v = serde_json::from_slice(&pt)
                    .map_err(|e| DistorrentError::Protocol(format!("json inválido: {e}")))?;
                return Ok((v, size));
            }
            // 2) há frames à frente esperando a cabeça? Espera com teto de gap.
            let ct: Vec<u8> = if !self.pending.is_empty() {
                let since = *self.gap_since.get_or_insert_with(Instant::now);
                let elapsed = since.elapsed();
                if elapsed >= SESSION_GAP_TIMEOUT {
                    // frame cabeça perdido: pula para o próximo disponível
                    let next = *self.pending.keys().next().unwrap_or(&self.counter);
                    debug!(
                        "sessão: gap de nonce {}..{next} (perda) — pulando",
                        self.counter
                    );
                    self.counter = next;
                    self.gap_since = None;
                    continue;
                }
                let remaining = SESSION_GAP_TIMEOUT - elapsed;
                match tokio::time::timeout(remaining, read_frame_session(&mut self.read)).await {
                    Ok(res) => res?,
                    Err(_) => {
                        let next = *self.pending.keys().next().unwrap_or(&self.counter);
                        debug!(
                            "sessão: gap de nonce {}..{next} (timeout) — pulando",
                            self.counter
                        );
                        self.counter = next;
                        self.gap_since = None;
                        continue;
                    }
                }
            } else {
                read_frame_session(&mut self.read).await?
            };
            // 3) decifra em qualquer counter da janela (AEAD autentica o certo).
            let mut found: Option<(u64, Vec<u8>)> = None;
            for off in 0..SESSION_REORDER_WINDOW {
                let c = self.counter + off;
                let nonce = build_nonce(self.dir, c);
                if let Ok(pt) = self.cipher.decrypt(
                    &nonce,
                    Payload {
                        msg: &ct,
                        aad: b"distorrent/frame",
                    },
                ) {
                    found = Some((c, pt));
                    break;
                }
            }
            match found {
                Some((c, pt)) => {
                    if c == self.counter {
                        // em ordem (caso comum): sem tocar no buffer
                        self.counter += 1;
                        self.gap_since = None;
                        let size = pt.len();
                        let v = serde_json::from_slice(&pt).map_err(|e| {
                            DistorrentError::Protocol(format!("json inválido: {e}"))
                        })?;
                        return Ok((v, size));
                    }
                    // fora de ordem: guarda e volta ao passo 1 (entrega em ordem)
                    self.pending.insert(c, pt);
                    if self.gap_since.is_none() {
                        self.gap_since = Some(Instant::now());
                    }
                }
                None => {
                    // Stray de handshake OU lixo: não consome nonce, não mata sessão.
                    if serde_json::from_slice::<HandshakeFrame>(&ct).is_ok() {
                        continue;
                    }
                    debug!("sessão: frame indecifrável — descartado (best-effort)");
                    continue;
                }
            }
        }
    }
}

fn build_nonce(dir: u8, counter: u64) -> Nonce {
    let mut n = [0u8; 12];
    n[0] = dir;
    n[1..9].copy_from_slice(&counter.to_be_bytes());
    Nonce::from(n)
}

/// Executa handshake sobre stream novo. `PROTO_V`: v2+ entende o túnel
/// virtual; variante desconhecida derruba sessão legada (gate no emissor).
pub const PROTO_V: u32 = 3;

/// Dial furador de NAT: conecta A PARTIR da porta do listener (reuseport) —
/// furo coordenado via Punch; Err rápido se o NAT não colaborar (simétrico).
pub async fn punch_dial(local_port: u16, remote: std::net::SocketAddr) -> Result<TcpStream> {
    let socket = match remote.ip() {
        std::net::IpAddr::V4(_) => tokio::net::TcpSocket::new_v4()?,
        std::net::IpAddr::V6(_) => tokio::net::TcpSocket::new_v6()?,
    };
    // reuseport/reuseaddr: discar a partir da MESMA porta do listener.
    #[cfg(unix)]
    socket.set_reuseport(true)?;
    #[cfg(windows)]
    socket.set_reuseaddr(true)?;
    let bind_ip = match remote.ip() {
        std::net::IpAddr::V4(_) => std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
        std::net::IpAddr::V6(_) => std::net::IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED),
    };
    socket.bind(std::net::SocketAddr::new(bind_ip, local_port))?;
    let stream = tokio::time::timeout(Duration::from_secs(8), socket.connect(remote))
        .await
        .map_err(|_| DistorrentError::Protocol("hole punch timeout (NAT não colaborou)".into()))?
        .map_err(DistorrentError::from)?;
    stream.set_nodelay(true)?;
    Ok(stream)
}

/// Probe UDP best-effort do furo TCP (abre pinhole em NATs
/// endpoint-independent); nunca falha o furo, timeout bounded ~0,6s.
pub async fn udp_punch_probe(remote: std::net::SocketAddr) {
    use tokio::net::UdpSocket;
    let bind = match remote {
        std::net::SocketAddr::V4(_) => "0.0.0.0:0",
        std::net::SocketAddr::V6(_) => "[::]:0",
    };
    let Ok(sock) = UdpSocket::bind(bind).await else {
        return;
    };
    // magic só p/ identificar ruído de furo
    const PROBE: &[u8] = b"DisTorrent-PUNCH1";
    for i in 0..3u8 {
        let _ = sock.send_to(PROBE, remote).await;
        if i < 2 {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }
    // best-effort: não bloqueia.
    let mut buf = [0u8; 64];
    let _ = tokio::time::timeout(Duration::from_millis(200), sock.recv_from(&mut buf)).await;
    debug!(%remote, "hole punch: probe UDP enviado (best-effort)");
}

pub struct HandshakeResult {
    pub session: Session,
    pub peer_fp: String,
    pub peer_pubkey_hex: String,
    pub peer_nickname: String,
    pub initiator: bool,
    /// proto_v anunciado pelo peer (0 = legado: sem Punch).
    pub peer_proto_v: u32,
}

pub async fn handshake(
    stream: TcpStream,
    keypair: Arc<Keypair>,
    nickname: &str,
    listen_port: u16,
    initiator: bool,
) -> Result<HandshakeResult> {
    handshake_with_fp(stream, keypair, nickname, listen_port, initiator, None).await
}

pub async fn handshake_with_fp(
    stream: TcpStream,
    keypair: Arc<Keypair>,
    nickname: &str,
    listen_port: u16,
    initiator: bool,
    my_fp_override: Option<String>,
) -> Result<HandshakeResult> {
    stream.set_nodelay(true)?;
    handshake_stream(
        stream,
        keypair,
        nickname,
        listen_port,
        initiator,
        my_fp_override,
    )
    .await
}

/// Handshake sobre QUALQUER stream bidirecional (TCP ou relay virtual).
/// Nonces por direção de sessão: emissor usa dir própria + contador;
/// receptor deriva o mesmo nonce com a dir OPOSTA + contador próprio.
pub async fn handshake_stream<S>(
    stream: S,
    keypair: Arc<Keypair>,
    nickname: &str,
    listen_port: u16,
    initiator: bool,
    my_fp_override: Option<String>,
) -> Result<HandshakeResult>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (read_half, write_half) = tokio::io::split(stream);
    let mut read: Box<dyn AsyncRead + Unpin + Send> = Box::new(read_half);
    let mut write: Box<dyn AsyncWrite + Unpin + Send> = Box::new(write_half);

    let eph = x25519_dalek::StaticSecret::random_from_rng(rand::rngs::OsRng);
    let mut nonce = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
    let eph_pub = x25519_dalek::PublicKey::from(&eph).to_bytes();

    let my_fp = my_fp_override
        .clone()
        .unwrap_or_else(|| keypair.fingerprint());
    let result = tokio::time::timeout(HANDSHAKE_TIMEOUT * 2, async {
        if initiator {
            let hello = Hello {
                fp: my_fp.clone(),
                pubkey_hex: keypair.public_hex(),
                nickname: nickname.to_string(),
                nonce,
                eph_pub,
                tcp_port: listen_port,
                proto_v: PROTO_V,
            };
            send_json(&mut write, &HandshakeFrame::Hello(hello)).await?;
            let HandshakeFrame::HelloAck(ack) = read_json::<HandshakeFrame>(&mut read).await?
            else {
                return Err(DistorrentError::Protocol("esperava HelloAck".into()));
            };
            verify_hello(&ack.fp, &ack.pubkey_hex)?;
            let transcript =
                handshake_transcript(&my_fp, &eph_pub, &nonce, &ack.fp, &ack.eph_pub, &ack.nonce);
            if !Keypair::verify(&ack.pubkey_hex, &transcript, &ack.sig)? {
                return Err(DistorrentError::Protocol(
                    "assinatura do HelloAck inválida".into(),
                ));
            }
            send_json(
                &mut write,
                &HandshakeFrame::HelloOk(HelloOk {
                    sig: keypair.sign(&transcript),
                }),
            )
            .await?;
            let key = session_key(&eph, &ack.eph_pub, &nonce, &ack.nonce)?;
            Ok((ack, key))
        } else {
            let HandshakeFrame::Hello(hello) = read_json::<HandshakeFrame>(&mut read).await? else {
                return Err(DistorrentError::Protocol("esperava Hello".into()));
            };
            verify_hello(&hello.fp, &hello.pubkey_hex)?;
            let transcript = handshake_transcript(
                &hello.fp,
                &hello.eph_pub,
                &hello.nonce,
                &my_fp,
                &eph_pub,
                &nonce,
            );
            send_json(
                &mut write,
                &HandshakeFrame::HelloAck(HelloAck {
                    fp: my_fp.clone(),
                    pubkey_hex: keypair.public_hex(),
                    nickname: nickname.to_string(),
                    nonce,
                    eph_pub,
                    sig: keypair.sign(&transcript),
                    proto_v: PROTO_V,
                }),
            )
            .await?;
            let HandshakeFrame::HelloOk(ok) = read_json::<HandshakeFrame>(&mut read).await? else {
                return Err(DistorrentError::Protocol("esperava HelloOk".into()));
            };
            if !Keypair::verify(&hello.pubkey_hex, &transcript, &ok.sig)? {
                return Err(DistorrentError::Protocol(
                    "assinatura do HelloOk inválida".into(),
                ));
            }
            // respondente deriva com nonces na ordem (iniciador, respondente)
            let key = session_key(&eph, &hello.eph_pub, &hello.nonce, &nonce)?;
            Ok((
                HelloAck {
                    fp: hello.fp,
                    pubkey_hex: hello.pubkey_hex,
                    nickname: hello.nickname,
                    nonce: hello.nonce,
                    eph_pub: hello.eph_pub,
                    sig: String::new(),
                    proto_v: hello.proto_v,
                },
                key,
            ))
        }
    })
    .await
    .map_err(|_| DistorrentError::Protocol("handshake timeout".into()))??;

    let (peer, key) = result;
    debug!(peer_fp = %peer.fp, initiator, "handshake concluído");
    Ok(HandshakeResult {
        session: Session::new(read, write, key, initiator),
        peer_fp: peer.fp,
        peer_pubkey_hex: peer.pubkey_hex,
        peer_nickname: peer.nickname,
        initiator,
        peer_proto_v: peer.proto_v,
    })
}

/// Handshake SÓ-RELAY (4G adverso): mesmo protocolo do TCP, com leitura por
/// perna de 30s, Hello retransmitido, Ack reenviado e HelloOk 3x (sobrevive
/// a 20% de perda). Tópico/envelope inalterados (compat).
pub async fn handshake_stream_relay<S>(
    stream: S,
    keypair: Arc<Keypair>,
    nickname: &str,
    listen_port: u16,
    initiator: bool,
    my_fp_override: Option<String>,
) -> Result<HandshakeResult>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (read_half, write_half) = tokio::io::split(stream);
    let mut read: Box<dyn AsyncRead + Unpin + Send> = Box::new(read_half);
    let mut write: Box<dyn AsyncWrite + Unpin + Send> = Box::new(write_half);

    let eph = x25519_dalek::StaticSecret::random_from_rng(rand::rngs::OsRng);
    let mut nonce = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
    let eph_pub = x25519_dalek::PublicKey::from(&eph).to_bytes();
    let my_fp = my_fp_override
        .clone()
        .unwrap_or_else(|| keypair.fingerprint());

    if initiator {
        let hello = Hello {
            fp: my_fp.clone(),
            pubkey_hex: keypair.public_hex(),
            nickname: nickname.to_string(),
            nonce,
            eph_pub,
            tcp_port: listen_port,
            proto_v: PROTO_V,
        };
        send_json(&mut write, &HandshakeFrame::Hello(hello.clone())).await?;
        // Stash de frames de sessão chegados cedo (flush imediato do peer +
        // reordenação): replayados na sessão via ReplayRead (sem descarte).
        let mut stashed: Vec<u8> = Vec::new();
        let deadline = tokio::time::Instant::now() + RELAY_HANDSHAKE_TOTAL_TIMEOUT;
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(DistorrentError::Protocol(
                    "handshake relay timeout (dial)".into(),
                ));
            }
            let wait = RELAY_HELLO_RESEND_INTERVAL.min(deadline.saturating_duration_since(now));
            if wait.is_zero() {
                return Err(DistorrentError::Protocol(
                    "handshake relay timeout (dial)".into(),
                ));
            }
            // Lê o frame CRU: o que não for HandshakeFrame é ciphertext
            // de sessão chegado cedo — vai ao stash (replay), não ao descarte.
            match read_frame_with(&mut read, wait).await {
                Ok(body) => match serde_json::from_slice::<HandshakeFrame>(&body) {
                    Ok(HandshakeFrame::HelloAck(ack)) => {
                        verify_hello(&ack.fp, &ack.pubkey_hex)?;
                        let transcript = handshake_transcript(
                            &my_fp,
                            &eph_pub,
                            &nonce,
                            &ack.fp,
                            &ack.eph_pub,
                            &ack.nonce,
                        );
                        if !Keypair::verify(&ack.pubkey_hex, &transcript, &ack.sig)? {
                            return Err(DistorrentError::Protocol(
                                "assinatura do HelloAck inválida".into(),
                            ));
                        }
                        let sig = keypair.sign(&transcript);
                        // HelloOk 3x: sobrevive a perda; extras pós-online são
                        // descartadas pelo manager.
                        for _ in 0..3 {
                            send_json(
                                &mut write,
                                &HandshakeFrame::HelloOk(HelloOk { sig: sig.clone() }),
                            )
                            .await?;
                        }
                        let key = session_key(&eph, &ack.eph_pub, &nonce, &ack.nonce)?;
                        debug!(peer_fp = %ack.fp, initiator, "handshake relay concluído (dial)");
                        return Ok(HandshakeResult {
                            session: Session::new(
                                ReplayRead::wrap(std::mem::take(&mut stashed), read),
                                write,
                                key,
                                initiator,
                            ),
                            peer_fp: ack.fp,
                            peer_pubkey_hex: ack.pubkey_hex,
                            peer_nickname: ack.nickname,
                            initiator,
                            peer_proto_v: ack.proto_v,
                        });
                    }
                    Ok(HandshakeFrame::Hello(peer_hello)) => {
                        // Dial cruzado: eleição determinística pelo fingerprint
                        // (sem retry/jitter, que recolide em livelock). Menor fp
                        // segue como iniciador; maior vira respondente do Hello
                        // recebido (mesma stream). Converge em 1 rodada.
                        if peer_hello.fp == my_fp {
                            continue; // auto-Hello (loopback): ignora
                        }
                        if let Err(e) = verify_hello(&peer_hello.fp, &peer_hello.pubkey_hex) {
                            return Err(e);
                        }
                        if my_fp.as_str() > peer_hello.fp.as_str() {
                            // Viro respondente: respondo o Hello dele e espero HelloOk.
                            let transcript = handshake_transcript(
                                &peer_hello.fp,
                                &peer_hello.eph_pub,
                                &peer_hello.nonce,
                                &my_fp,
                                &eph_pub,
                                &nonce,
                            );
                            let ack = HelloAck {
                                fp: my_fp.clone(),
                                pubkey_hex: keypair.public_hex(),
                                nickname: nickname.to_string(),
                                nonce,
                                eph_pub,
                                sig: keypair.sign(&transcript),
                                proto_v: PROTO_V,
                            };
                            send_json(&mut write, &HandshakeFrame::HelloAck(ack.clone())).await?;
                            // Espera o HelloOk com o tempo RESTANTE do dial.
                            loop {
                                let now2 = tokio::time::Instant::now();
                                if now2 >= deadline {
                                    return Err(DistorrentError::Protocol(
                                        "handshake relay timeout (cruzado→responder)".into(),
                                    ));
                                }
                                let wait2 = RELAY_HANDSHAKE_READ_TIMEOUT
                                    .min(deadline.saturating_duration_since(now2));
                                if wait2.is_zero() {
                                    return Err(DistorrentError::Protocol(
                                        "handshake relay timeout (cruzado→responder)".into(),
                                    ));
                                }
                                match read_frame_with(&mut read, wait2).await {
                                    Ok(cbody) => {
                                        match serde_json::from_slice::<HandshakeFrame>(&cbody) {
                                            Ok(HandshakeFrame::HelloOk(ok)) => {
                                                if !Keypair::verify(
                                                    &peer_hello.pubkey_hex,
                                                    &transcript,
                                                    &ok.sig,
                                                )? {
                                                    return Err(DistorrentError::Protocol(
                                                        "assinatura do HelloOk inválida".into(),
                                                    ));
                                                }
                                                let key = session_key(
                                                    &eph,
                                                    &peer_hello.eph_pub,
                                                    &peer_hello.nonce,
                                                    &nonce,
                                                )?;
                                                debug!(peer_fp = %peer_hello.fp, "handshake relay concluído (cruzado→responder)");
                                                return Ok(HandshakeResult {
                                                    session: Session::new(
                                                        ReplayRead::wrap(
                                                            std::mem::take(&mut stashed),
                                                            read,
                                                        ),
                                                        write,
                                                        key,
                                                        false,
                                                    ),
                                                    peer_fp: peer_hello.fp.clone(),
                                                    peer_pubkey_hex: peer_hello.pubkey_hex.clone(),
                                                    peer_nickname: peer_hello.nickname.clone(),
                                                    initiator: false,
                                                    peer_proto_v: peer_hello.proto_v,
                                                });
                                            }
                                            Ok(HandshakeFrame::Hello(dup))
                                                if dup.fp == peer_hello.fp
                                                    && dup.eph_pub == peer_hello.eph_pub
                                                    && dup.nonce == peer_hello.nonce =>
                                            {
                                                let _ = send_json(
                                                    &mut write,
                                                    &HandshakeFrame::HelloAck(ack.clone()),
                                                )
                                                .await;
                                                continue;
                                            }
                                            Ok(_) => continue,
                                            Err(_) => {
                                                // Frame de SESSÃO (flush imediato do peer +
                                                // reordenação) antes do HelloOk: guarda p/
                                                // replay (ReplayRead) em vez de descartar.
                                                stash_early(&mut stashed, &cbody)?;
                                                continue;
                                            }
                                        }
                                    }
                                    Err(e) if is_relay_timeout(&e) => {
                                        let _ = send_json(
                                            &mut write,
                                            &HandshakeFrame::HelloAck(ack.clone()),
                                        )
                                        .await;
                                        continue;
                                    }
                                    // Erro de leitura não-timeout: ignora e espera
                                    // (deadline limita).
                                    Err(_) => continue,
                                }
                            }
                        } else {
                            // Menor fp: ignora, reaquece meu Hello, sigo esperando Ack.
                            send_json(&mut write, &HandshakeFrame::Hello(hello.clone())).await?;
                            continue;
                        }
                    }
                    Ok(_) => {
                        // HelloOk inesperado no dial: ignora e reaquece com Hello.
                        let _ = send_json(&mut write, &HandshakeFrame::Hello(hello.clone())).await;
                        continue;
                    }
                    Err(_) => {
                        // Ciphertext de sessão chegado antes do Ack (sessão velha
                        // do peer ainda viva): guarda p/ replay após o handshake
                        // em vez de abortar o dial.
                        stash_early(&mut stashed, &body)?;
                        continue;
                    }
                },
                Err(e) if is_relay_timeout(&e) => {
                    // Sem Ack: reenvia o MESMO Hello (mesmo transcript) e espera.
                    send_json(&mut write, &HandshakeFrame::Hello(hello.clone())).await?;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
    } else {
        // Respondente: espera o Hello (até 30s); frames de sessão precoces vão
        // ao stash p/ replay, não ao descarte.
        let mut stashed: Vec<u8> = Vec::new();
        let hello: Hello = loop {
            let body = read_frame_with(&mut read, RELAY_HANDSHAKE_READ_TIMEOUT).await?;
            match serde_json::from_slice::<HandshakeFrame>(&body) {
                Ok(HandshakeFrame::Hello(h)) => break h,
                Ok(_) => return Err(DistorrentError::Protocol("esperava Hello (relay)".into())),
                Err(_) => stash_early(&mut stashed, &body)?,
            }
        };
        verify_hello(&hello.fp, &hello.pubkey_hex)?;
        let transcript = handshake_transcript(
            &hello.fp,
            &hello.eph_pub,
            &hello.nonce,
            &my_fp,
            &eph_pub,
            &nonce,
        );
        let ack = HelloAck {
            fp: my_fp.clone(),
            pubkey_hex: keypair.public_hex(),
            nickname: nickname.to_string(),
            nonce,
            eph_pub,
            sig: keypair.sign(&transcript),
            proto_v: PROTO_V,
        };
        send_json(&mut write, &HandshakeFrame::HelloAck(ack.clone())).await?;
        let deadline = tokio::time::Instant::now() + RELAY_HANDSHAKE_TOTAL_TIMEOUT;
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(DistorrentError::Protocol(
                    "handshake relay timeout (responder)".into(),
                ));
            }
            let wait = RELAY_HANDSHAKE_READ_TIMEOUT.min(deadline.saturating_duration_since(now));
            if wait.is_zero() {
                return Err(DistorrentError::Protocol(
                    "handshake relay timeout (responder)".into(),
                ));
            }
            match read_frame_with(&mut read, wait).await {
                Ok(body) => match serde_json::from_slice::<HandshakeFrame>(&body) {
                    Ok(HandshakeFrame::HelloOk(ok)) => {
                        if !Keypair::verify(&hello.pubkey_hex, &transcript, &ok.sig)? {
                            return Err(DistorrentError::Protocol(
                                "assinatura do HelloOk inválida".into(),
                            ));
                        }
                        let key = session_key(&eph, &hello.eph_pub, &hello.nonce, &nonce)?;
                        debug!(peer_fp = %hello.fp, initiator, "handshake relay concluído (responder)");
                        return Ok(HandshakeResult {
                            session: Session::new(
                                ReplayRead::wrap(std::mem::take(&mut stashed), read),
                                write,
                                key,
                                initiator,
                            ),
                            peer_fp: hello.fp.clone(),
                            peer_pubkey_hex: hello.pubkey_hex.clone(),
                            peer_nickname: hello.nickname.clone(),
                            initiator,
                            peer_proto_v: hello.proto_v,
                        });
                    }
                    Ok(HandshakeFrame::Hello(dup)) if dup.fp == hello.fp => {
                        // Mesmo Hello: nosso Ack se perdeu — reenvia o MESMO Ack.
                        if dup.eph_pub == hello.eph_pub && dup.nonce == hello.nonce {
                            let _ =
                                send_json(&mut write, &HandshakeFrame::HelloAck(ack.clone())).await;
                            continue;
                        }
                        // Hello NOVO (outro dial, eph/nonce diferentes): falha
                        // rápido para o manager eleger respondente novo — sem
                        // isso o dial novo receberia o Ack velho e travaria 80s.
                        return Err(DistorrentError::Protocol(
                            "novo Hello durante handshake — reeleição".into(),
                        ));
                    }
                    Ok(_) => continue, // Ack/Ok cruzado: ignora
                    Err(_) => {
                        // Frame de SESSÃO (flush imediato do iniciador, que já
                        // fechou o dial ao receber nosso Ack) antes do HelloOk:
                        // guarda p/ replay (ReplayRead) em vez de descartar — o
                        // descarte dessincronizava o nonce e matava a sessão.
                        stash_early(&mut stashed, &body)?;
                        continue;
                    }
                },
                Err(e) if is_relay_timeout(&e) => {
                    // Sem HelloOk: reenvia o Ack como nudge e espera mais.
                    if tokio::time::Instant::now() >= deadline {
                        return Err(DistorrentError::Protocol(
                            "handshake relay timeout (responder)".into(),
                        ));
                    }
                    let _ = send_json(&mut write, &HandshakeFrame::HelloAck(ack.clone())).await;
                    continue;
                }
                // Erro de leitura não-timeout: ignora e espera (deadline de
                // 80s limita).
                Err(_) => {
                    continue;
                }
            }
        }
    }
}

fn verify_hello(fp: &str, pubkey_hex: &str) -> Result<()> {
    if !crate::identity::fingerprint_matches(fp, pubkey_hex) {
        warn!("handshake: pubkey não bate com fingerprint — rejeitado");
        return Err(DistorrentError::Protocol(
            "identidade forjada no handshake".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chacha20poly1305::aead::Aead;
    use tokio::io::AsyncWriteExt;

    /// Cifra um frame JSON com o nonce (dir, counter) e devolve wire bytes len+body.
    fn wire(
        cipher: &ChaCha20Poly1305,
        dir: u8,
        counter: u64,
        frame: &serde_json::Value,
    ) -> Vec<u8> {
        let pt = serde_json::to_vec(frame).unwrap();
        let nonce = build_nonce(dir, counter);
        let ct = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: &pt,
                    aad: b"distorrent/frame",
                },
            )
            .unwrap();
        let mut out = (ct.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&ct);
        out
    }

    /// O relay reordena; o receptor tem de entregar em ordem (nonce sequencial).
    #[tokio::test]
    async fn session_reader_reordena_e_entrega_em_ordem() {
        let (mut sender, receiver) = tokio::io::duplex(1 << 20);
        let key = [0x11u8; 32];
        let cipher = ChaCha20Poly1305::new((&key).into());
        // initiator=false → recv_dir = 0; o "peer" cifra com dir 0.
        let (mut reader, _w) =
            Session::new(Box::new(receiver), Box::new(tokio::io::sink()), key, false).split();
        // envia FORA DE ORDEM: 2,0,1,3 → receptor devolve 0,1,2,3
        for c in [2u64, 0, 1, 3] {
            let frame = serde_json::json!({ "n": c });
            sender
                .write_all(&wire(&cipher, 0, c, &frame))
                .await
                .unwrap();
        }
        for expected in 0..4u64 {
            let got: serde_json::Value = reader.recv().await.unwrap();
            assert_eq!(got["n"].as_u64().unwrap(), expected);
        }
    }

    /// Stray de handshake (JSON em claro) não consome nonce nem mata a sessão.
    #[tokio::test]
    async fn session_reader_ignora_stray_em_claro() {
        let (mut sender, receiver) = tokio::io::duplex(1 << 20);
        let key = [0x22u8; 32];
        let cipher = ChaCha20Poly1305::new((&key).into());
        let (mut reader, _w) =
            Session::new(Box::new(receiver), Box::new(tokio::io::sink()), key, false).split();
        // stray: bytes length-prefixed que NÃO são ciphertext válido
        let stray =
            serde_json::to_vec(&serde_json::json!({ "type": "Hello", "proto_v": 1 })).unwrap();
        let mut framed = (stray.len() as u32).to_be_bytes().to_vec();
        framed.extend_from_slice(&stray);
        sender.write_all(&framed).await.unwrap();
        // frame real logo depois (counter 0) — deve ser entregue
        let frame = serde_json::json!({ "n": 0 });
        sender
            .write_all(&wire(&cipher, 0, 0, &frame))
            .await
            .unwrap();
        let got: serde_json::Value = reader.recv().await.unwrap();
        assert_eq!(got["n"].as_u64().unwrap(), 0);
    }
}
