//! Túnel virtual UDP (LAN estilo Radmin): handshake X25519 autenticado por
//! ed25519 via relay + datagramas ChaCha20Poly1305 (nonces crescentes,
//! anti-replay, AAD de direção). IP virtual determinístico `fd9d::/8` por fp.

use std::net::Ipv6Addr;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};

use crate::{DistorrentError, Result};

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
        return Err(DistorrentError::Crypto(
            "tunel: X25519 all-zero shared".into(),
        ));
    }
    let mut salt = [0u8; 32];
    salt[..16].copy_from_slice(nonce_a);
    salt[16..].copy_from_slice(nonce_b);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(VTUN_HKDF_INFO, &mut okm)
        .map_err(|e| DistorrentError::Crypto(format!("tunel hkdf: {e}")))?;
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
    /// Último datagrama aberto com sucesso (prova real de vida) — o túnel era
    /// dado "pronto" só por chave derivada; half-open ficava em silêncio.
    last_rx_ms: AtomicI64,
    /// Último envio (contrapeso do last_rx_ms): sem ele, túnel OCIOSO seria
    /// derrubado a cada varredura (churn eterno de handshake).
    last_tx_ms: AtomicI64,
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
            // 0 = nunca abrimos/enixamos nada por aqui.
            last_rx_ms: AtomicI64::new(0),
            last_tx_ms: AtomicI64::new(0),
            key,
            send_ctr: AtomicU64::new(1),
            recv: std::sync::Mutex::new(RecvWindow {
                highest: 0,
                mask: 0,
            }),
        }
    }

    /// O túnel pode transportar tráfego? A pergunta é "provei que funciona?":
    /// prova recente, carência do handshake, ocioso (sem evidência de falha)
    /// ou envio dentro da janela de resposta. "Mandei e nada voltou" = não.
    pub fn is_proven(&self, now_ms: i64, grace_ms: i64, ttl_ms: i64, probe_ms: i64) -> bool {
        let rx = self.last_rx_ms.load(Ordering::SeqCst);
        let tx = self.last_tx_ms.load(Ordering::SeqCst);
        // 1. prova recente
        if rx > 0 && now_ms.saturating_sub(rx) <= ttl_ms {
            return true;
        }
        // 2. carência do handshake
        if now_ms.saturating_sub(self.created_ms) <= grace_ms {
            return true;
        }
        // 3. nada depois da última prova = ocioso, não quebrado
        if tx <= rx {
            return true;
        }
        // 4. saiu algo depois da prova e nada voltou: dá a janela de resposta
        now_ms.saturating_sub(tx) <= probe_ms
    }

    /// Túnel comprovadamente MORTO (≠ `is_proven`: envio sem resposta pode
    /// estar em voo). Sem esta separação, a varredura causava renegociação
    /// eterna em quem só está logado.
    pub fn is_dead(&self, now_ms: i64, grace_ms: i64, dead_ms: i64) -> bool {
        // Nunca enviou nada depois da criação: ocioso, não morto.
        let tx = self.last_tx_ms.load(Ordering::SeqCst);
        if tx == 0 {
            return false;
        }
        let rx = self.last_rx_ms.load(Ordering::SeqCst);
        if tx <= rx {
            // O último envio tem prova correspondente: nada a declarar.
            return false;
        }
        // Enviou e nunca voltou (ou voltou antes deste envio): espera o prazo
        // longo antes de concluir morte, para não confundir atraso com queda.
        if now_ms.saturating_sub(self.created_ms) <= grace_ms {
            return false;
        }
        now_ms.saturating_sub(tx) > dead_ms
    }

    /// Marca que este lado ABRIU um datagrama do peer (prova real de vida).
    fn mark_rx(&self, now_ms: i64) {
        self.last_rx_ms.store(now_ms, Ordering::SeqCst);
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
            return Err(DistorrentError::Crypto(
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
            .map_err(|_| DistorrentError::Crypto("tunel: falha ao cifrar".into()))?;
        self.tx_bytes.fetch_add(ct.len() as u64, Ordering::SeqCst);
        // Registra o ENVIO: é o que distingue "ocioso" de "mandei e não voltou".
        self.last_tx_ms
            .store(crate::identity::now_ms(), Ordering::SeqCst);
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
                return Err(DistorrentError::Crypto(
                    "tunel: replay ou nonce velho".into(),
                ));
            }
        }
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes[4..].copy_from_slice(&nonce.to_be_bytes());
        let cipher = ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&self.key));
        let pt = cipher
            .decrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: ct,
                    aad: &tun_aad(sender_fp, receiver_fp),
                },
            )
            .map_err(|_| DistorrentError::Crypto("tunel: autenticação falhou".into()))?;
        // Abriu de verdade = a chave serve nos dois sentidos (ver `is_proven`).
        self.mark_rx(crate::identity::now_ms());
        Ok(pt)
    }
}

/// Oferta pendente que EU fiz (segredo efêmero guardado até a resposta).
pub struct TunnelPending {
    pub secret: x25519_dalek::StaticSecret,
    pub nonce: [u8; 16],
    pub created_ms: i64,
}

/// Envelope do plaintext do túnel: frame inteiro, fragmento ou inválido.
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
    fn tunel_so_carrega_depois_de_provar() {
        const GRACE: i64 = 8_000;
        const TTL: i64 = 45_000;
        const PROBE: i64 = 10_000;
        // Relógio REAL como base: `seal`/`mark_rx` estampam `now_ms()`, então
        // deslocamentos sintéticos sobre `created_ms` não valem depois de um
        // envio. Aqui a base é agora e os casos avançam no tempo.
        let s = TunnelSession::new("peer".into(), [3u8; 32]);
        let t0 = crate::identity::now_ms();

        // Recém-criado: dentro da carência, pode carregar (é quando costuma dar certo).
        assert!(s.is_proven(t0, GRACE, TTL, PROBE), "carência precisa valer");
        assert!(s.is_proven(t0 + 7_000, GRACE, TTL, PROBE));

        // OCIOSO (nunca enviei nada): continua valendo. Derrubar aqui puniria
        // quem só está logado e viraria renegociação a cada varredura.
        assert!(
            s.is_proven(t0 + 120_000, GRACE, TTL, PROBE),
            "túnel ocioso não é túnel quebrado"
        );

        // Mandei e nada voltou: depois da janela de resposta, NÃO carrega mais.
        // Era o "uma mensagem funciona, depois emudece até reiniciar".
        s.seal("eu", "peer", b"msg").unwrap();
        assert!(
            s.is_proven(t0, GRACE, TTL, PROBE),
            "dentro da janela de resposta ainda dá tempo"
        );
        assert!(
            !s.is_proven(t0 + 30_000, GRACE, TTL, PROBE),
            "enviou e não voltou nada: rota morta, usa o caminho normal"
        );

        // Voltou algo: prova real dos dois sentidos → vale de novo.
        s.mark_rx(crate::identity::now_ms());
        assert!(s.is_proven(crate::identity::now_ms(), GRACE, TTL, PROBE));
    }

    /// `is_dead` só dispara em "mandei, nada voltou, prazo folgado" — nunca em
    /// ocioso nem em envio ainda em voo.
    ///
    /// É a diferença que impede renegociação eterna: derrubar por "sem prova
    /// agora" fazia o túnel nascer e morrer a cada varredura.
    #[test]
    fn tunel_so_e_morto_quando_envio_nao_volta_no_prazo() {
        const GRACE: i64 = 8_000;
        const DEAD: i64 = 120_000;

        // Ocioso desde sempre: nunca é morto (nada para provar).
        let ocioso = TunnelSession::new("peer".into(), [7u8; 32]);
        let t0 = crate::identity::now_ms();
        assert!(!ocioso.is_dead(t0 + 3_600_000, GRACE, DEAD));

        // Enviou algo: dentro do prazo ainda não é morte (pode estar em voo).
        let mudo = TunnelSession::new("peer".into(), [8u8; 32]);
        mudo.seal("eu", "peer", b"msg").unwrap();
        let agora = crate::identity::now_ms();
        assert!(
            !mudo.is_dead(agora + 30_000, GRACE, DEAD),
            "30s de atraso não é morte — relay/4G é lento"
        );
        // Passado o prazo folgado sem nada voltar: morto, vale renegociar.
        assert!(
            mudo.is_dead(agora + DEAD + 1_000, GRACE, DEAD),
            "mandei e nada voltou no prazo: renegocia"
        );

        // Voltou algo DEPOIS do envio: não é morto (o envio foi provado).
        let vivo = TunnelSession::new("peer".into(), [9u8; 32]);
        vivo.seal("eu", "peer", b"msg").unwrap();
        vivo.mark_rx(crate::identity::now_ms());
        assert!(!vivo.is_dead(crate::identity::now_ms() + DEAD * 5, GRACE, DEAD));
    }

    /// A prova vence: envio depois da última prova, sem resposta, derruba —
    /// e o ocioso NÃO pode cair nesta regra.
    #[test]
    fn tunel_ocioso_nao_e_derrubado_mas_mudo_e() {
        const GRACE: i64 = 8_000;
        const TTL: i64 = 45_000;
        const PROBE: i64 = 10_000;
        let s = TunnelSession::new("peer".into(), [5u8; 32]);
        let t0 = crate::identity::now_ms();

        // Ocioso desde o começo, muito depois da carência: segue válido.
        assert!(s.is_proven(t0 + 600_000, GRACE, TTL, PROBE));

        // Envio sem resposta depois disso: janela esgotada = morto.
        s.seal("eu", "peer", b"x").unwrap();
        let agora = crate::identity::now_ms();
        assert!(!s.is_proven(agora + PROBE + 5_000, GRACE, TTL, PROBE));

        // A prova real devolve a confiança.
        s.mark_rx(agora);
        assert!(s.is_proven(agora, GRACE, TTL, PROBE));
        // E continua valendo dentro do ttl.
        assert!(s.is_proven(agora + 30_000, GRACE, TTL, PROBE));
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
