//! Transporte TCP: frames length-prefixed + handshake autenticado + sessão AEAD.
//!
//! Sequência do handshake (iniciador A, respondente B):
//!   A→B  Hello{fp_A, pub_A, nick, na, eph_A, port}
//!   B→A  HelloAck{fp_B, pub_B, nick, nb, eph_B, sig_B(transcript)}
//!   A→B  HelloOk{sig_A(transcript)}
//! Ambos verificam: fingerprint == blake3(pubkey) e assinatura sobre o transcript
//! (cobre identidades + nonces + chaves efêmeras → anti-MITM, anti-replay).
//! Sessão: ChaCha20Poly1305, chave = HKDF(X25519(ephA,ephB), salt=na||nb).

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
use crate::{ForgeError, Result};

const MAX_FRAME: u32 = 1 << 20; // 1 MiB
/// TCP direto: falha rápido em LAN (8s por perna, 16s total). NÃO MEXER para
/// cobrir 4G — o caminho só-relay abaixo tem seus próprios timeouts maiores.
/// Justificativa: aumentar o global atrasaria detecção de peer morto no TCP
/// (PING_TIMEOUT 25s) sem necessidade; 4G só usa o relay.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);

/// Timeout de leitura por perna SÓ-RELAY (4G lento): RRC wake 2-3s + poll do
/// manager ~2s + latência MQTT/ntfy 1-2s + atraso lossy 0-3s + jitter
/// => pior caso ~10s por voo. 30s dá folga ~3x sem afetar o TCP.
/// VOZ: handshake é 1x por sessão; voz/sinalização pós-handshake usa a sessão
/// (reader 150s + outer 60s relay) — este 30s NÃO limita voz contínua, só o
/// estabelecimento. NÃO reduzir: relay_lossy (20% + 0-3s) precisa dos 30s.
pub const RELAY_HANDSHAKE_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Retransmissão do Hello do dial: reenvia o MESMO Hello (mesmo eph/nonce,
/// mesmo transcript) a cada ~1,5s até Ack ou fim da tentativa. 1 Hello perdido
/// (20% loss, rádio dormindo, subscribe atrasado) não mata mais a tentativa.
/// 1,5s (era 3s): com poll de ~0,4-1,5s o Ack chega rápido sem perda; 1,5s
/// recupera perda mais cedo e encurta o estabelecimento no 4G. Duplicatas são
/// dedupadas pelo manager (mesmo eph) e pelo respondente (mesmo Ack).
pub const RELAY_HELLO_RESEND_INTERVAL: Duration = Duration::from_millis(1500);
/// Teto total do handshake relay. Cabe dentro do RELAY_HANDSHAKE_TIMEOUT=90s
/// do engine (respondente); o dial usa RELAY_DIAL_ATTEMPT=40s por fora, que
/// corta o iniciador em ~13 Hellos. ~26 Hellos cabem em 80s no pior caso.
pub const RELAY_HANDSHAKE_TOTAL_TIMEOUT: Duration = Duration::from_secs(80);
/// Teto do buffer de frames de sessão que chegam ANTES do HelloOk (flush
/// imediato do peer + reordenação). Acima disso, aborta (anti-DoS).
const RELAY_EARLY_STASH_CAP: usize = 4 << 20;

/// Janela de reordenação do receptor de sessão. O relay (MQTT/ntfy) NÃO
/// preserva ordem: MultiRelay publica cada frame em 6 pernas com atraso
/// 0–3 s, então um frame N+1 pode chegar antes do N. O nonce ChaCha é
/// sequencial (dir+counter), então sem tolerância um único reorder/perda
/// dessincronizava o nonce e MATAVA a sessão inteira. Aqui o receptor tenta
/// decifrar com counters `recv..recv+JANELA` (AEAD autentica; o counter
/// correto é o único que valida em 2^-128) e entrega em ordem.
pub const SESSION_REORDER_WINDOW: u64 = 256;
/// Tempo de espera do frame "cabeça" antes de declarar perda e PULAR o gap
/// (o frame realmente se perdeu — 20% por perna com 6 pernas ≈ 0,006% por
/// frame, mas acontece). Sessão segue viva; a camada de outbox/ACK reenvia
/// a DM perdida. 4 s cobre o atraso máximo do relay (0–3 s) com folga.
pub const SESSION_GAP_TIMEOUT: Duration = Duration::from_secs(4);

async fn write_frame(w: &mut (dyn AsyncWrite + Unpin + Send), bytes: &[u8]) -> Result<()> {
    let len =
        u32::try_from(bytes.len()).map_err(|_| ForgeError::Protocol("frame gigante".into()))?;
    w.write_all(&len.to_be_bytes()).await?;
    w.write_all(bytes).await?;
    w.flush().await?;
    Ok(())
}

async fn read_frame(r: &mut (dyn AsyncRead + Unpin + Send)) -> Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    tokio::time::timeout(HANDSHAKE_TIMEOUT, r.read_exact(&mut len_buf))
        .await
        .map_err(|_| ForgeError::Protocol("timeout lendo tamanho do frame".into()))??;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(ForgeError::Protocol(format!("frame {len} > limite")));
    }
    let mut buf = vec![0u8; len as usize];
    tokio::time::timeout(HANDSHAKE_TIMEOUT, r.read_exact(&mut buf))
        .await
        .map_err(|_| ForgeError::Protocol("timeout lendo frame".into()))??;
    Ok(buf)
}

async fn send_json<T: Serialize>(w: &mut (dyn AsyncWrite + Unpin + Send), v: &T) -> Result<()> {
    write_frame(
        w,
        &serde_json::to_vec(v).map_err(|e| ForgeError::Protocol(e.to_string()))?,
    )
    .await
}

async fn read_json<T: DeserializeOwned>(r: &mut (dyn AsyncRead + Unpin + Send)) -> Result<T> {
    let bytes = read_frame(r).await?;
    serde_json::from_slice(&bytes).map_err(|e| ForgeError::Protocol(format!("json inválido: {e}")))
}

async fn read_frame_with(
    r: &mut (dyn AsyncRead + Unpin + Send),
    per_read: Duration,
) -> Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    tokio::time::timeout(per_read, r.read_exact(&mut len_buf))
        .await
        .map_err(|_| ForgeError::Protocol("timeout lendo tamanho do frame (relay)".into()))??;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(ForgeError::Protocol(format!("frame {len} > limite")));
    }
    let mut buf = vec![0u8; len as usize];
    tokio::time::timeout(per_read, r.read_exact(&mut buf))
        .await
        .map_err(|_| ForgeError::Protocol("timeout lendo frame (relay)".into()))??;
    Ok(buf)
}

/// Leitura de SESSÃO (pós-handshake): sem timeout curto — o outer
/// `timeout(ping_timeout)` no reader loop governa. 150s é só rede de proteção
/// contra hang eterno (maior que RELAY_PING_TIMEOUT=60s e PING_TIMEOUT=25s,
/// então o outer sempre dispara primeiro).
/// VOZ (frames pequenos/frequentes): cada frame — voz, ICE, Ping — reseta o
/// outer; rajada de voz mantém a sessão viva sem Pings. 150s nunca dispara
/// antes do outer em voz contínua; NÃO reduzir (perda 20% atrasa voos).
async fn read_frame_session(r: &mut (dyn AsyncRead + Unpin + Send)) -> Result<Vec<u8>> {
    read_frame_with(r, Duration::from_secs(150)).await
}

/// Leitura com replay: devolve primeiro os wire-bytes (len+body) de frames de
/// sessão que chegaram ANTES do HelloOk, depois delega ao stream. É o que
/// permite o flush IMEDIATO pós-handshake (sem os 5s de espera): o iniciador
/// posta Msg/Ping logo após o HelloOk e, se um frame de sessão reordenar na
/// frente do HelloOk, ele é guardado aqui em vez de ser descartado como
/// "lixo" (o descarte dessincronizava o nonce ChaCha e matava a sessão).
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
        return Err(ForgeError::Protocol(
            "stash de frames precoces estourou (anti-DoS)".into(),
        ));
    }
    stashed.extend_from_slice(&(body.len() as u32).to_be_bytes());
    stashed.extend_from_slice(body);
    Ok(())
}

fn is_relay_timeout(e: &ForgeError) -> bool {
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
        let plaintext = serde_json::to_vec(v).map_err(|e| ForgeError::Protocol(e.to_string()))?;
        let nonce = self.nonce();
        let ct = self
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: &plaintext,
                    aad: b"forge/frame",
                },
            )
            .map_err(|_| ForgeError::Crypto("falha ao cifrar frame".into()))?;
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
                serde_json::to_vec(v).map_err(|e| ForgeError::Protocol(e.to_string()))?;
            let nonce = self.nonce();
            let ct = self
                .cipher
                .encrypt(
                    &nonce,
                    Payload {
                        msg: &plaintext,
                        aad: b"forge/frame",
                    },
                )
                .map_err(|_| ForgeError::Crypto("falha ao cifrar frame".into()))?;
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
        // Sessão NÃO usa o timeout curto de handshake (8s/30s): a liveness é
        // governada pelo outer `timeout(ping_timeout)` em register_and_run
        // (25s direto, 120s relay). Inner de 150s nunca dispara antes do outer
        // — sem isso, sessão relay idle morria em 8s (antes do 1º Ping de 30s).
        //
        // Ordenação: o relay reordena (MultiRelay publica N cópias com atraso
        // 0–3 s e cada perna entrega quando quer). Como o nonce é sequencial,
        // entregar fora de ordem dessincronizava a sessão. Aqui deciframos com
        // uma JANELA de counters (o AEAD só valida no counter certo) e
        // entregamos estritamente em ordem. Gap (frame perdido de verdade) é
        // pulado após SESSION_GAP_TIMEOUT — a sessão sobrevive e o outbox/ACK
        // reenvia a DM. Strays de handshake continuam sendo ignorados.
        loop {
            // 1) cabeça já bufferizada? Entrega (fast-path em ordem também cai aqui).
            if let Some(pt) = self.pending.remove(&self.counter) {
                self.counter += 1;
                self.gap_since = None;
                let size = pt.len();
                let v = serde_json::from_slice(&pt)
                    .map_err(|e| ForgeError::Protocol(format!("json inválido: {e}")))?;
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
                        aad: b"forge/frame",
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
                        let v = serde_json::from_slice(&pt)
                            .map_err(|e| ForgeError::Protocol(format!("json inválido: {e}")))?;
                        return Ok((v, size));
                    }
                    // fora de ordem: guarda e volta ao passo 1 (entrega em ordem)
                    self.pending.insert(c, pt);
                    if self.gap_since.is_none() {
                        self.gap_since = Some(Instant::now());
                    }
                }
                None => {
                    // Stray de handshake (Hello/Ack/Ok duplicados) OU lixo:
                    // não consome nonce e não mata a sessão.
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

/// Executa handshake sobre stream novo. Retorna sessão cifrada + info do peer.
/// Versão do protocolo de sessão deste build (anunciada no Hello/HelloAck).
/// v2 = entende os frames do túnel virtual (TunnelOffer/Answer/Data); v1
/// NUNCA recebe esses frames (desserializar variante desconhecida derruba
/// a sessão legada — o gate é `peer_proto_v >= 2` no emissor).
pub const PROTO_V: u32 = 3;

/// Dial furador de NAT (hole punching estilo torrent): conecta A PARTIR da
/// porta de escuta local (SO_REUSEPORT) para o endpoint público do peer.
/// Se ambos furarem ao mesmo tempo (coordenado via Punch), NATs full-cone e
/// restricted deixam passar — sem servidor no caminho de dados.
/// Retorna Err rápido (8s) se o NAT não colaborar (ex.: simétrico).
pub async fn punch_dial(local_port: u16, remote: std::net::SocketAddr) -> Result<TcpStream> {
    let socket = match remote.ip() {
        std::net::IpAddr::V4(_) => tokio::net::TcpSocket::new_v4()?,
        std::net::IpAddr::V6(_) => tokio::net::TcpSocket::new_v6()?,
    };
    // SO_REUSEPORT (Unix) / SO_REUSEADDR (Windows): discar a partir da MESMA
    // porta do listener (hole punch). Windows não tem reuseport.
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
        .map_err(|_| ForgeError::Protocol("hole punch timeout (NAT não colaborou)".into()))?
        .map_err(ForgeError::from)?;
    stream.set_nodelay(true)?;
    Ok(stream)
}

/// Probe UDP best-effort "junto" do furo TCP (estilo µTP/STUN). Abre um socket
/// UDP efêmero e dispara datagramas-máquina ao endpoint do peer: em NATs
/// endpoint-independent isso abre um pinhole e sinaliza o par; NÃO é transporte
/// de dados (o TCP segue sendo o transporte). Nunca falha o furo TCP — erro
/// vira `debug!`. Timeout curto e bounded (~0,6s) para não atrasar os dials.
pub async fn udp_punch_probe(remote: std::net::SocketAddr) {
    use tokio::net::UdpSocket;
    let bind = match remote {
        std::net::SocketAddr::V4(_) => "0.0.0.0:0",
        std::net::SocketAddr::V6(_) => "[::]:0",
    };
    let Ok(sock) = UdpSocket::bind(bind).await else {
        return;
    };
    // magic só p/ identificar ruído de furo (não é protocolo de sessão)
    const PROBE: &[u8] = b"FORGE-PUNCH1";
    for i in 0..3u8 {
        let _ = sock.send_to(PROBE, remote).await;
        if i < 2 {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }
    // best-effort: se o par respondeu, o pinhole de volta abriu; não bloqueia.
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
                return Err(ForgeError::Protocol("esperava HelloAck".into()));
            };
            verify_hello(&ack.fp, &ack.pubkey_hex)?;
            let transcript =
                handshake_transcript(&my_fp, &eph_pub, &nonce, &ack.fp, &ack.eph_pub, &ack.nonce);
            if !Keypair::verify(&ack.pubkey_hex, &transcript, &ack.sig)? {
                return Err(ForgeError::Protocol(
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
                return Err(ForgeError::Protocol("esperava Hello".into()));
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
                return Err(ForgeError::Protocol("esperava HelloOk".into()));
            };
            if !Keypair::verify(&hello.pubkey_hex, &transcript, &ok.sig)? {
                return Err(ForgeError::Protocol(
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
    .map_err(|_| ForgeError::Protocol("handshake timeout".into()))??;

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

/// Handshake SÓ-RELAY (4G adverso): mesmo protocolo/autenticação do TCP
/// (Hello/HelloAck/HelloOk + transcript ed25519 + HKDF), mas com:
/// - leitura por perna de 30s (`RELAY_HANDSHAKE_READ_TIMEOUT`) em vez de 8s;
/// - iniciador retransmite o MESMO Hello a cada ~3s até Ack ou teto total;
/// - respondente reenvia o MESMO Ack ao ver Hello duplicado (retransmissão);
/// - iniciador envia HelloOk 3x (com filtro do manager, extras pós-online são
///   descartadas — sobrevive a 20% de perda: P(3 perdidos)=0.8%).
///
/// Tópico `distorrent_r_<fp>` e envelope inalterados (compat 4.3.1/4.3.2).
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
                return Err(ForgeError::Protocol(
                    "handshake relay timeout (dial)".into(),
                ));
            }
            let wait = RELAY_HELLO_RESEND_INTERVAL.min(deadline.saturating_duration_since(now));
            if wait.is_zero() {
                return Err(ForgeError::Protocol(
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
                            return Err(ForgeError::Protocol(
                                "assinatura do HelloAck inválida".into(),
                            ));
                        }
                        let sig = keypair.sign(&transcript);
                        // HelloOk 3x: sobrevive a perda sem criar sessão half-open.
                        // Extras que chegarem após o respondente fechar o handshake
                        // são descartadas pelo relay_manager_loop (peer já online).
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
                        // Dial cruzado (ambos discaram juntos — comum após disconnect
                        // bilateral): eleição determinística pelo fingerprint, SEM
                        // retry/jitter (que recolide em livelock simétrico).
                        // - Menor fp: IGNORA o Hello alheio, reenvia o próprio e segue
                        //   esperando o Ack (o maior vai virar respondente).
                        // - Maior fp: DESISTE do dial e VIRA respondente do Hello
                        //   recebido (mesmo eph/nonce, mesma stream — sem nova
                        //   tentativa). Converge em 1 rodada.
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
                                    return Err(ForgeError::Protocol(
                                        "handshake relay timeout (cruzado→responder)".into(),
                                    ));
                                }
                                let wait2 = RELAY_HANDSHAKE_READ_TIMEOUT
                                    .min(deadline.saturating_duration_since(now2));
                                if wait2.is_zero() {
                                    return Err(ForgeError::Protocol(
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
                                                    return Err(ForgeError::Protocol(
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
                    // Sem Ack em ~3s: Hello se perdeu (loss/rádio/subscribe) —
                    // reenvia o MESMO Hello (mesmo transcript) e espera de novo.
                    send_json(&mut write, &HandshakeFrame::Hello(hello.clone())).await?;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
    } else {
        // Respondente: o primeiro Hello já está na fila (spawn_relay_responder
        // injeta first_frame), mas espera até 30s por robustez. Frames de
        // sessão que furaram a fila (corrida no manager) vão ao stash p/
        // replay, não ao descarte.
        let mut stashed: Vec<u8> = Vec::new();
        let hello: Hello = loop {
            let body = read_frame_with(&mut read, RELAY_HANDSHAKE_READ_TIMEOUT).await?;
            match serde_json::from_slice::<HandshakeFrame>(&body) {
                Ok(HandshakeFrame::Hello(h)) => break h,
                Ok(_) => return Err(ForgeError::Protocol("esperava Hello (relay)".into())),
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
                return Err(ForgeError::Protocol(
                    "handshake relay timeout (responder)".into(),
                ));
            }
            let wait = RELAY_HANDSHAKE_READ_TIMEOUT.min(deadline.saturating_duration_since(now));
            if wait.is_zero() {
                return Err(ForgeError::Protocol(
                    "handshake relay timeout (responder)".into(),
                ));
            }
            match read_frame_with(&mut read, wait).await {
                Ok(body) => match serde_json::from_slice::<HandshakeFrame>(&body) {
                    Ok(HandshakeFrame::HelloOk(ok)) => {
                        if !Keypair::verify(&hello.pubkey_hex, &transcript, &ok.sig)? {
                            return Err(ForgeError::Protocol(
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
                        // Mesmo Hello (mesmo eph/nonce) = nosso Ack se perdeu ou o
                        // dial reenviou por timeout de 3s. Reenvia o MESMO Ack.
                        if dup.eph_pub == hello.eph_pub && dup.nonce == hello.nonce {
                            let _ =
                                send_json(&mut write, &HandshakeFrame::HelloAck(ack.clone())).await;
                            continue;
                        }
                        // Hello NOVO (novo dial com eph/nonce diferentes) enquanto o
                        // respondente antigo ainda vive: falha rápido para o manager
                        // limpar a entrada e um respondente novo nascer com o Hello
                        // novo (retransmitido em ~5s). Sem isso o dial novo receberia
                        // o Ack velho (transcript errado) e travaria até 80s.
                        return Err(ForgeError::Protocol(
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
                    // Sem HelloOk em 30s: reenvia o Ack como nudge (cobre Ack
                    // perdido onde o dial segue reenviando Hello) e espera mais.
                    if tokio::time::Instant::now() >= deadline {
                        return Err(ForgeError::Protocol(
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
        return Err(ForgeError::Protocol(
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
                    aad: b"forge/frame",
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
