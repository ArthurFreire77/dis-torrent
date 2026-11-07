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

pub const MAX_FRAME: u32 = 1 << 20;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);

pub const RELAY_HANDSHAKE_READ_TIMEOUT: Duration = Duration::from_secs(30);
pub const RELAY_HELLO_RESEND_INTERVAL: Duration = Duration::from_millis(1500);
pub const RELAY_HANDSHAKE_TOTAL_TIMEOUT: Duration = Duration::from_secs(80);
const RELAY_EARLY_STASH_CAP: usize = 4 << 20;

pub const SESSION_REORDER_WINDOW: u64 = 256;
pub const SESSION_GAP_TIMEOUT: Duration = Duration::from_millis(800);

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

async fn read_frame_session(r: &mut (dyn AsyncRead + Unpin + Send)) -> Result<Vec<u8>> {
    read_frame_with(r, Duration::from_secs(150)).await
}

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

pub struct Session {
    read: Box<dyn AsyncRead + Unpin + Send>,
    write: Box<dyn AsyncWrite + Unpin + Send>,
    cipher: ChaCha20Poly1305,
    send_counter: u64,
    recv_counter: u64,
    send_dir: u8,
    recv_dir: u8,
}

pub struct SessionWriter {
    write: Box<dyn AsyncWrite + Unpin + Send>,
    cipher: ChaCha20Poly1305,
    counter: u64,
    dir: u8,
}

pub struct SessionReader {
    read: Box<dyn AsyncRead + Unpin + Send>,
    cipher: ChaCha20Poly1305,
    counter: u64,
    dir: u8,
    pending: BTreeMap<u64, Vec<u8>>,
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

    pub async fn recv_sized<T: DeserializeOwned>(&mut self) -> Result<(T, usize)> {
        loop {
            if let Some(pt) = self.pending.remove(&self.counter) {
                self.counter += 1;
                self.gap_since = None;
                let size = pt.len();
                let v = serde_json::from_slice(&pt)
                    .map_err(|e| DistorrentError::Protocol(format!("json inválido: {e}")))?;
                return Ok((v, size));
            }
            let ct: Vec<u8> = if !self.pending.is_empty() {
                let since = *self.gap_since.get_or_insert_with(Instant::now);
                let elapsed = since.elapsed();
                if elapsed >= SESSION_GAP_TIMEOUT {
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
                        self.counter += 1;
                        self.gap_since = None;
                        let size = pt.len();
                        let v = serde_json::from_slice(&pt).map_err(|e| {
                            DistorrentError::Protocol(format!("json inválido: {e}"))
                        })?;
                        return Ok((v, size));
                    }
                    self.pending.insert(c, pt);
                    if self.gap_since.is_none() {
                        self.gap_since = Some(Instant::now());
                    }
                }
                None => {
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

/// Versão do protocolo anunciada no `Hello`/`HelloAck`.
///
/// 5 acrescenta os frames de atestação de build. Não há mudança de formato nos
/// frames antigos: peers com `proto_v < 5` continuam conectando e conversando
/// normalmente, só não são desafiados (ficam NAO_VERIFICADO, que é honesto).
pub const PROTO_V: u32 = 5;

pub async fn punch_dial(local_port: u16, remote: std::net::SocketAddr) -> Result<TcpStream> {
    let socket = match remote.ip() {
        std::net::IpAddr::V4(_) => tokio::net::TcpSocket::new_v4()?,
        std::net::IpAddr::V6(_) => tokio::net::TcpSocket::new_v6()?,
    };
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

pub async fn udp_punch_probe(remote: std::net::SocketAddr) {
    use tokio::net::UdpSocket;
    let bind = match remote {
        std::net::SocketAddr::V4(_) => "0.0.0.0:0",
        std::net::SocketAddr::V6(_) => "[::]:0",
    };
    let Ok(sock) = UdpSocket::bind(bind).await else {
        return;
    };
    const PROBE: &[u8] = b"DisTorrent-PUNCH1";
    for i in 0..3u8 {
        let _ = sock.send_to(PROBE, remote).await;
        if i < 2 {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }
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
    pub peer_proto_v: u32,
    /// blake3 do transcript desta conexão, em hex. A atestação de build é
    /// assinada sobre este valor: prova colhida em outra sessão não serve.
    pub transcript_hash: String,
}

fn transcript_hex(transcript: &[u8]) -> String {
    hex::encode(blake3::hash(transcript).as_bytes())
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
            let th = transcript_hex(&transcript);
            Ok((ack, key, th))
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
            let key = session_key(&eph, &hello.eph_pub, &hello.nonce, &nonce)?;
            let th = transcript_hex(&transcript);
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
                th,
            ))
        }
    })
    .await
    .map_err(|_| DistorrentError::Protocol("handshake timeout".into()))??;

    let (peer, key, transcript_hash) = result;
    debug!(peer_fp = %peer.fp, initiator, "handshake concluído");
    Ok(HandshakeResult {
        session: Session::new(read, write, key, initiator),
        peer_fp: peer.fp,
        peer_pubkey_hex: peer.pubkey_hex,
        peer_nickname: peer.nickname,
        initiator,
        peer_proto_v: peer.proto_v,
        transcript_hash,
    })
}

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
                        for _ in 0..3 {
                            send_json(
                                &mut write,
                                &HandshakeFrame::HelloOk(HelloOk { sig: sig.clone() }),
                            )
                            .await?;
                        }
                        let key = session_key(&eph, &ack.eph_pub, &nonce, &ack.nonce)?;
                        let th = transcript_hex(&transcript);
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
                            transcript_hash: th,
                        });
                    }
                    Ok(HandshakeFrame::Hello(peer_hello)) => {
                        if peer_hello.fp == my_fp {
                            continue;
                        }
                        if let Err(e) = verify_hello(&peer_hello.fp, &peer_hello.pubkey_hex) {
                            return Err(e);
                        }
                        if my_fp.as_str() > peer_hello.fp.as_str() {
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
                                                let th = transcript_hex(&transcript);
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
                                                    transcript_hash: th,
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
                                    Err(_) => continue,
                                }
                            }
                        } else {
                            send_json(&mut write, &HandshakeFrame::Hello(hello.clone())).await?;
                            continue;
                        }
                    }
                    Ok(_) => {
                        let _ = send_json(&mut write, &HandshakeFrame::Hello(hello.clone())).await;
                        continue;
                    }
                    Err(_) => {
                        stash_early(&mut stashed, &body)?;
                        continue;
                    }
                },
                Err(e) if is_relay_timeout(&e) => {
                    send_json(&mut write, &HandshakeFrame::Hello(hello.clone())).await?;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
    } else {
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
                        let th = transcript_hex(&transcript);
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
                            transcript_hash: th,
                        });
                    }
                    Ok(HandshakeFrame::Hello(dup)) if dup.fp == hello.fp => {
                        if dup.eph_pub == hello.eph_pub && dup.nonce == hello.nonce {
                            let _ =
                                send_json(&mut write, &HandshakeFrame::HelloAck(ack.clone())).await;
                            continue;
                        }
                        return Err(DistorrentError::Protocol(
                            "novo Hello durante handshake — reeleição".into(),
                        ));
                    }
                    Ok(_) => continue,
                    Err(_) => {
                        stash_early(&mut stashed, &body)?;
                        continue;
                    }
                },
                Err(e) if is_relay_timeout(&e) => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(DistorrentError::Protocol(
                            "handshake relay timeout (responder)".into(),
                        ));
                    }
                    let _ = send_json(&mut write, &HandshakeFrame::HelloAck(ack.clone())).await;
                    continue;
                }
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

    #[tokio::test]
    async fn session_reader_reordena_e_entrega_em_ordem() {
        let (mut sender, receiver) = tokio::io::duplex(1 << 20);
        let key = [0x11u8; 32];
        let cipher = ChaCha20Poly1305::new((&key).into());
        let (mut reader, _w) =
            Session::new(Box::new(receiver), Box::new(tokio::io::sink()), key, false).split();
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

    #[tokio::test]
    async fn session_reader_ignora_stray_em_claro() {
        let (mut sender, receiver) = tokio::io::duplex(1 << 20);
        let key = [0x22u8; 32];
        let cipher = ChaCha20Poly1305::new((&key).into());
        let (mut reader, _w) =
            Session::new(Box::new(receiver), Box::new(tokio::io::sink()), key, false).split();
        let stray =
            serde_json::to_vec(&serde_json::json!({ "type": "Hello", "proto_v": 1 })).unwrap();
        let mut framed = (stray.len() as u32).to_be_bytes().to_vec();
        framed.extend_from_slice(&stray);
        sender.write_all(&framed).await.unwrap();
        let frame = serde_json::json!({ "n": 0 });
        sender
            .write_all(&wire(&cipher, 0, 0, &frame))
            .await
            .unwrap();
        let got: serde_json::Value = reader.recv().await.unwrap();
        assert_eq!(got["n"].as_u64().unwrap(), 0);
    }
}
