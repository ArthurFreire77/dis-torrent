//! Túnel virtual UDP (LAN estilo Radmin, Fase 1): handshake X25519 efêmero
//! autenticado por ed25519 via frames relay + datagramas ChaCha20Poly1305.
//!
//! Fase 1 carrega os pacotes em `SecureFrame::TunnelData` (pelo relay que já
//! existe) — prova cripto + endereçamento + ping. O UDP direto entra na
//! Fase 2; TCP sobre o túnel na Fase 3. IP virtual determinístico `fd9d::/8`
//! derivado do fingerprint: sem servidor de alocação, sem colisão prática.
//!
//! Segurança: efêmeras novas por sessão (sem forward secrecy entre sessões
//! antigas — rekey na Fase 4), transcript assinado cobre fps + efêmeras +
//! nonces (anti-MITM/replay), nonces de datagrama estritamente crescentes com
//! janela anti-replay de 64, AAD amarra direção (remetente→destinatário).

use std::net::Ipv6Addr;
use std::sync::atomic::{AtomicU64, Ordering};

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};

use crate::{ForgeError, Result};

pub const VTUN_DOMAIN: &[u8] = b"distorrent-vtun-v1";
pub const VTUN_HKDF_INFO: &[u8] = b"distorrent/vtun/v1";
/// Porta TCP que o app escuta DENTRO do túnel (igual à fixa de produção).
pub const VTUN_TCP_PORT: u16 = 51413;
/// Chunk máximo por datagrama do túnel (plaintext): cabe folgado num frame
/// relay (que fragmenta em ~3KB) sem estourar limites do writer direto.
pub const TUN_FRAG_MAX: usize = 48 * 1024;
/// Frame interno (SecureFrame JSON) máximo aceito pelo túnel: acima disso o
/// emissor manda pelo caminho normal (relay). Arquivo vai pelo swarm, nunca aqui.
pub const TUN_FRAME_MAX: usize = 512 * 1024;
/// Tags do envelope dentro do plaintext (1º byte).
pub const TAG_FULL: u8 = 0x01;
pub const TAG_FRAG: u8 = 0x02;

/// IP virtual estável: `fd9d:` + 64 bits do `blake3("distorrent-vtun-v1:<fp>")`.
/// Determinístico — dois lados calculam o mesmo sem trocar nada.
pub fn virtual_ipv6(fp: &str) -> Ipv6Addr {
    let h = blake3::hash(format!("distorrent-vtun-v1:{fp}").as_bytes());
    let b = h.as_bytes();
    let mut seg = [0u16; 8];
    seg[0] = 0xfd9d;
    for i in 1..8 {
        seg[i] = u16::from_be_bytes([b[(i - 1) * 2], b[(i - 1) * 2 + 1]]);
    }
    Ipv6Addr::new(
        seg[0], seg[1], seg[2], seg[3], seg[4], seg[5], seg[6], seg[7],
    )
}

/// Transcript do handshake do túnel (assinado por AMBOS com ed25519).
/// `a` = quem oferece, `b` = quem responde — ordem fixa, sem ambiguidade.
pub fn tunnel_transcript(
    a_fp: &str,
    a_eph: &[u8; 32],
    a_nonce: &[u8; 16],
    b_fp: &str,
    b_eph: &[u8; 32],
    b_nonce: &[u8; 16],
) -> Vec<u8> {
    let mut h = blake3::Hasher::new();
    h.update(VTUN_DOMAIN);
    h.update(b"|hs|");
    h.update(a_fp.as_bytes());
    h.update(a_eph);
    h.update(a_nonce);
    h.update(b_fp.as_bytes());
    h.update(b_eph);
    h.update(b_nonce);
    h.finalize().as_bytes().to_vec()
}

/// Chave do túnel: X25519 (efêmera própria × efêmera do peer) → HKDF-SHA256
/// com salt = nonces. Rejeita shared all-zero ( MESMO padrão de `session_key`).
pub fn tunnel_key(
    own_secret: &x25519_dalek::StaticSecret,
    peer_eph: &[u8; 32],
    nonce_a: &[u8; 16],
    nonce_b: &[u8; 16],
) -> Result<[u8; 32]> {
    use hkdf::Hkdf;
    use sha2::Sha256;
    let shared = own_secret.diffie_hellman(&x25519_dalek::PublicKey::from(*peer_eph));
    if !shared.was_contributory() {
        return Err(ForgeError::Crypto("tunel: X25519 all-zero shared".into()));
    }
    let mut salt = [0u8; 32];
    salt[..16].copy_from_slice(nonce_a);
    salt[16..].copy_from_slice(nonce_b);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(VTUN_HKDF_INFO, &mut okm)
        .map_err(|e| ForgeError::Crypto(format!("tunel hkdf: {e}")))?;
    Ok(okm)
}

fn tun_aad(sender_fp: &str, receiver_fp: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(VTUN_DOMAIN.len() + 1 + 64);
    aad.extend_from_slice(VTUN_DOMAIN);
    aad.push(b'|');
    aad.extend_from_slice(sender_fp.as_bytes());
    aad.push(b'|');
    aad.extend_from_slice(receiver_fp.as_bytes());
    aad
}

/// Janela anti-replay: aceita nonce > highest, ou dentro de 64 abaixo e inédito.
struct RecvWindow {
    highest: u64,
    mask: u64,
}

impl RecvWindow {
    fn accept(&mut self, nonce: u64) -> bool {
        if nonce == 0 {
            return false;
        }
        if nonce > self.highest {
            let shift = nonce - self.highest;
            self.mask = if shift >= 64 { 0 } else { self.mask << shift };
            self.mask |= 1;
            self.highest = nonce;
            return true;
        }
        let diff = self.highest - nonce;
        if diff >= 64 {
            return false;
        }
        let bit = 1u64 << diff;
        if self.mask & bit != 0 {
            return false; // replay
        }
        self.mask |= bit;
        true
    }
}

/// Sessão estabelecida do túnel com um peer. Uma direção de contador por
/// lado (cada lado só ENVIA com o próprio contador — sem disputa).
pub struct TunnelSession {
    pub peer_fp: String,
    /// Criação (epoch ms) — base do rekey por idade (Fase 4).
    pub created_ms: i64,
    /// Bytes cifrados enviados — base do rekey por volume (Fase 4).
    pub tx_bytes: AtomicU64,
    key: [u8; 32],
    send_ctr: AtomicU64,
    recv: std::sync::Mutex<RecvWindow>,
}

impl TunnelSession {
    pub fn new(peer_fp: String, key: [u8; 32]) -> Self {
        Self {
            peer_fp,
            created_ms: crate::identity::now_ms(),
            tx_bytes: AtomicU64::new(0),
            key,
            send_ctr: AtomicU64::new(1),
            recv: std::sync::Mutex::new(RecvWindow {
                highest: 0,
                mask: 0,
            }),
        }
    }

    /// Cifra um datagrama; devolve (nonce, ciphertext). Nonce 12B = 4 zeros +
    /// contador BE de 64 bits. Estoura (u64::MAX) = erro → rekey (Fase 4).
    pub fn seal(
        &self,
        sender_fp: &str,
        receiver_fp: &str,
        plaintext: &[u8],
    ) -> Result<(u64, Vec<u8>)> {
        let ctr = self.send_ctr.fetch_add(1, Ordering::SeqCst);
        if ctr == u64::MAX {
            return Err(ForgeError::Crypto(
                "tunel: contador esgotado — rekey".into(),
            ));
        }
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes[4..].copy_from_slice(&ctr.to_be_bytes());
        let cipher = ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&self.key));
        let ct = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad: &tun_aad(sender_fp, receiver_fp),
                },
            )
            .map_err(|_| ForgeError::Crypto("tunel: falha ao cifrar".into()))?;
        self.tx_bytes.fetch_add(ct.len() as u64, Ordering::SeqCst);
        Ok((ctr, ct))
    }

    /// Abre e valida (AEAD + AAD de direção + anti-replay). Erro = descarta.
    pub fn open(
        &self,
        sender_fp: &str,
        receiver_fp: &str,
        nonce: u64,
        ct: &[u8],
    ) -> Result<Vec<u8>> {
        {
            let mut w = self.recv.lock().unwrap_or_else(|e| e.into_inner());
            if !w.accept(nonce) {
                return Err(ForgeError::Crypto("tunel: replay ou nonce velho".into()));
            }
        }
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes[4..].copy_from_slice(&nonce.to_be_bytes());
        let cipher = ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&self.key));
        cipher
            .decrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: ct,
                    aad: &tun_aad(sender_fp, receiver_fp),
                },
            )
            .map_err(|_| ForgeError::Crypto("tunel: autenticação falhou".into()))
    }
}

/// Oferta pendente que EU fiz (segredo efêmero guardado até a resposta).
pub struct TunnelPending {
    pub secret: x25519_dalek::StaticSecret,
    pub nonce: [u8; 16],
    pub created_ms: i64,
}

/// Envelope do plaintext dentro do túnel (Fase 2+): frame inteiro ou
/// fragmento com remontagem. Ping/pong da Fase 1 viraram `Full(b"ping:<id>")`
/// — o receptor decide pelo prefixo, igual antes.
pub enum TunMsg {
    Full(Vec<u8>),
    Frag {
        id: u32,
        idx: u16,
        total: u16,
        chunk: Vec<u8>,
    },
    Invalid,
}

pub fn encode_full(payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(1 + payload.len());
    v.push(TAG_FULL);
    v.extend_from_slice(payload);
    v
}

pub fn encode_frag(id: u32, idx: u16, total: u16, chunk: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(9 + chunk.len());
    v.push(TAG_FRAG);
    v.extend_from_slice(&id.to_be_bytes());
    v.extend_from_slice(&idx.to_be_bytes());
    v.extend_from_slice(&total.to_be_bytes());
    v.extend_from_slice(chunk);
    v
}

pub fn decode_envelope(pt: &[u8]) -> TunMsg {
    if pt.is_empty() {
        return TunMsg::Invalid;
    }
    match pt[0] {
        TAG_FULL => TunMsg::Full(pt[1..].to_vec()),
        TAG_FRAG => {
            if pt.len() < 9 {
                return TunMsg::Invalid;
            }
            let id = u32::from_be_bytes([pt[1], pt[2], pt[3], pt[4]]);
            let idx = u16::from_be_bytes([pt[5], pt[6]]);
            let total = u16::from_be_bytes([pt[7], pt[8]]);
            if total == 0 || total > 64 || idx >= total {
                return TunMsg::Invalid;
            }
            let chunk = pt[9..].to_vec();
            if chunk.is_empty() || chunk.len() > TUN_FRAG_MAX {
                return TunMsg::Invalid;
            }
            TunMsg::Frag {
                id,
                idx,
                total,
                chunk,
            }
        }
        _ => TunMsg::Invalid,
    }
}

/// Remontagem de frames fragmentados por peer. Limites anti-DoS: 64 frags/msg,
/// 16 msgs/peer, 4MB total, 30s de vida — estouro descarta o mais antigo.
pub struct TunnelReassembler {
    entries: std::collections::HashMap<(String, u32), ReasmEntry>,
    buffered_bytes: usize,
}

struct ReasmEntry {
    total: u16,
    got: Vec<Option<Vec<u8>>>,
    got_count: usize,
    bytes: usize,
    created_ms: i64,
}

impl TunnelReassembler {
    pub fn new() -> Self {
        Self {
            entries: std::collections::HashMap::new(),
            buffered_bytes: 0,
        }
    }

    /// Insere um fragmento; devolve o frame completo quando fecha.
    pub fn insert(
        &mut self,
        fp: &str,
        id: u32,
        idx: u16,
        total: u16,
        chunk: Vec<u8>,
        now_ms: i64,
    ) -> Option<Vec<u8>> {
        self.gc(now_ms);
        let key = (fp.to_string(), id);
        if !self.entries.contains_key(&key) {
            if self.entries.len() >= 16 {
                self.evict_oldest();
            }
            self.entries.insert(
                key.clone(),
                ReasmEntry {
                    total,
                    got: (0..total).map(|_| None).collect(),
                    got_count: 0,
                    bytes: 0,
                    created_ms: now_ms,
                },
            );
        }
        let entry = match self.entries.get_mut(&key) {
            Some(e) if e.total == total => e,
            _ => return None, // total conflitante = descarta
        };
        if entry.got[idx as usize].is_none() {
            entry.bytes += chunk.len();
            self.buffered_bytes += chunk.len();
            entry.got[idx as usize] = Some(chunk);
            entry.got_count += 1;
        }
        let full = entry.got_count == entry.total as usize;
        if self.buffered_bytes > 4 * 1024 * 1024 {
            self.evict_oldest();
        }
        if full {
            let e = self.entries.remove(&key)?;
            self.buffered_bytes = self.buffered_bytes.saturating_sub(e.bytes);
            let mut out = Vec::with_capacity(e.bytes);
            for part in e.got.into_iter().flatten() {
                out.extend_from_slice(&part);
            }
            Some(out)
        } else {
            None
        }
    }

    fn gc(&mut self, now_ms: i64) {
        let stale: Vec<(String, u32)> = self
            .entries
            .iter()
            .filter(|(_, e)| now_ms - e.created_ms > 30_000)
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale {
            if let Some(e) = self.entries.remove(&k) {
                self.buffered_bytes = self.buffered_bytes.saturating_sub(e.bytes);
            }
        }
    }

    fn evict_oldest(&mut self) {
        let oldest = self
            .entries
            .iter()
            .min_by_key(|(_, e)| e.created_ms)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            if let Some(e) = self.entries.remove(&k) {
                self.buffered_bytes = self.buffered_bytes.saturating_sub(e.bytes);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_ip_estavel_e_unico() {
        let a1 = virtual_ipv6("fp-alice-teste");
        let a2 = virtual_ipv6("fp-alice-teste");
        let b = virtual_ipv6("fp-bob-teste");
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        assert_eq!(&a1.segments()[0], &0xfd9d);
    }

    #[test]
    fn seal_open_roundtrip_e_replay() {
        let key = [7u8; 32];
        let s = TunnelSession::new("peer".into(), key);
        let (n1, ct1) = s.seal("eu", "peer", b"ping:1").unwrap();
        assert_eq!(n1, 1);
        let pt = s.open("eu", "peer", n1, &ct1).unwrap();
        assert_eq!(pt, b"ping:1");
        // replay do mesmo nonce morre
        assert!(s.open("eu", "peer", n1, &ct1).is_err());
        // direção trocada morre (AAD)
        let (n2, ct2) = s.seal("eu", "peer", b"x").unwrap();
        assert!(s.open("peer", "eu", n2, &ct2).is_err());
        // nonce 0 morre
        assert!(s.open("eu", "peer", 0, &ct1).is_err());
    }

    #[test]
    fn janela_aceita_fora_de_ordem_limitado() {
        let key = [9u8; 32];
        let s = TunnelSession::new("peer".into(), key);
        let mut cts = Vec::new();
        for _ in 0..5 {
            cts.push(s.seal("eu", "peer", b"d").unwrap());
        }
        // entrega reversa: todos entram
        for (n, ct) in cts.iter().rev() {
            assert!(s.open("eu", "peer", *n, ct).is_ok());
        }
    }

    #[test]
    fn handshake_dh_simbolico() {
        use rand::RngCore;
        let mut rng = rand::thread_rng();
        let sa = x25519_dalek::StaticSecret::random_from_rng(&mut rng);
        let sb = x25519_dalek::StaticSecret::random_from_rng(&mut rng);
        let pa = x25519_dalek::PublicKey::from(&sa).to_bytes();
        let pb = x25519_dalek::PublicKey::from(&sb).to_bytes();
        let mut na = [0u8; 16];
        let mut nb = [0u8; 16];
        rng.fill_bytes(&mut na);
        rng.fill_bytes(&mut nb);
        let ka = tunnel_key(&sa, &pb, &na, &nb).unwrap();
        let kb = tunnel_key(&sb, &pa, &na, &nb).unwrap();
        assert_eq!(ka, kb);
    }
}
