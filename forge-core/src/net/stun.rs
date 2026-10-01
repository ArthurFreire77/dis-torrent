//! Cliente STUN mínimo (RFC 5389) sobre UDP — descobre o endpoint PÚBLICO
//! (ip:porta) do nosso NAT. Essencial sob CGNAT, onde UPnP/NAT-PMP costumam
//! falhar (o gateway mapeável está a vários saltos). Sem crate nova.
//!
//! Só Binding (request/response); nada de autenticação/ICE. É best-effort:
//! qualquer erro/timeout vira `None` e o engine segue no hole punch normal.
//! Kill-flag: `FORGE_STUN=0` desliga a consulta.
//!
//! Observação honesta: STUN sobre UDP revela o IP público, mas a PORTA é do
//! binding UDP — o transporte de dados é TCP (porta diferente atrás de CGNAT).
//! Por isso o engine usa só o IP do STUN + a porta TCP (UPnP/ext ou a escuta
//! fixa estilo torrent), nunca a porta UDP como alvo de furo TCP.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;

use tokio::net::UdpSocket;
use tracing::debug;

/// Magic cookie do RFC 5389 (também usado no XOR dos endereços).
const MAGIC_COOKIE: u32 = 0x2112_A442;
/// Binding Request (0x0001).
const MSG_BINDING_REQUEST: u16 = 0x0001;
/// Binding Success Response (0x0101).
const MSG_BINDING_SUCCESS: u16 = 0x0101;
/// Atributo MAPPED-ADDRESS (RFC 3489, texto claro).
const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
/// Atributo XOR-MAPPED-ADDRESS (RFC 5389, ofuscado).
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
/// Tamanho fixo do header STUN.
const HEADER_LEN: usize = 20;
/// Timeout por servidor (curto: não atrasa boot/anúncio).
const QUERY_TIMEOUT: Duration = Duration::from_secs(2);
/// TTL do cache — bom cidadão: não spammar os STUN públicos.
const CACHE_TTL_MS: i64 = 60_000;

/// Servidores públicos (raça em paralelo; vence o 1º que responder).
const STUN_SERVERS: &[&str] = &[
    "stun.l.google.com:19302",
    "stun.cloudflare.com:3478",
    "stun1.l.google.com:19302",
];

/// Kill-flag `FORGE_STUN=0` (ou false/no/off) desliga. Default: ligado.
fn stun_flag_value(v: Option<&str>) -> bool {
    match v {
        None => true,
        Some(s) => !matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
    }
}

fn stun_enabled() -> bool {
    stun_flag_value(std::env::var("FORGE_STUN").ok().as_deref())
}

fn random_txid() -> [u8; 12] {
    use rand::RngCore;
    let mut txid = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut txid);
    txid
}

/// Monta um Binding Request de 20 bytes (sem atributos).
fn build_binding_request(txid: &[u8; 12]) -> [u8; HEADER_LEN] {
    let mut buf = [0u8; HEADER_LEN];
    buf[0..2].copy_from_slice(&MSG_BINDING_REQUEST.to_be_bytes());
    // length = 0 (sem atributos)
    buf[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    buf[8..20].copy_from_slice(txid);
    buf
}

/// Valida o header de uma Binding Success e devolve o corpo (atributos).
/// Rejeita: curta, tipo errado, cookie errado, txid divergente ou length fora.
fn parse_binding_success<'a>(buf: &'a [u8], expect_txid: &[u8; 12]) -> Option<&'a [u8]> {
    if buf.len() < HEADER_LEN {
        return None;
    }
    // Os 2 bits altos do tipo são SEMPRE 0 (RFC 5389 §6).
    if buf[0] & 0xC0 != 0 {
        return None;
    }
    let msg_type = u16::from_be_bytes([buf[0], buf[1]]);
    if msg_type != MSG_BINDING_SUCCESS {
        return None;
    }
    let msg_len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    // length é múltiplo de 4 e o buffer tem que conter o corpo inteiro.
    if msg_len % 4 != 0 {
        return None;
    }
    let end = HEADER_LEN.checked_add(msg_len)?;
    if buf.len() < end {
        return None;
    }
    if u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]) != MAGIC_COOKIE {
        return None;
    }
    if &buf[8..20] != expect_txid {
        return None;
    }
    Some(&buf[HEADER_LEN..end])
}

/// Formato MAPPED-ADDRESS: reservado(1), família(1), porta(2), endereço.
fn parse_mapped_addr(value: &[u8]) -> Option<SocketAddr> {
    if value.len() < 4 {
        return None;
    }
    let port = u16::from_be_bytes([value[2], value[3]]);
    match value[1] {
        0x01 => {
            if value.len() < 8 {
                return None;
            }
            let ip = Ipv4Addr::new(value[4], value[5], value[6], value[7]);
            Some(SocketAddr::new(IpAddr::V4(ip), port))
        }
        0x02 => {
            if value.len() < 20 {
                return None;
            }
            let mut raw = [0u8; 16];
            raw.copy_from_slice(&value[4..20]);
            Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(raw)), port))
        }
        _ => None,
    }
}

/// Formato XOR-MAPPED-ADDRESS (RFC 5389 §15.2): porta ^ (cookie>>16) e
/// endereço ^ máscara (cookie para IPv4; cookie||txid para IPv6).
fn parse_xor_addr(value: &[u8], txid: &[u8; 12]) -> Option<SocketAddr> {
    if value.len() < 4 {
        return None;
    }
    let port = u16::from_be_bytes([value[2], value[3]]) ^ ((MAGIC_COOKIE >> 16) as u16);
    match value[1] {
        0x01 => {
            if value.len() < 8 {
                return None;
            }
            let raw = u32::from_be_bytes([value[4], value[5], value[6], value[7]]);
            let ip = Ipv4Addr::from(raw ^ MAGIC_COOKIE);
            Some(SocketAddr::new(IpAddr::V4(ip), port))
        }
        0x02 => {
            if value.len() < 20 {
                return None;
            }
            // máscara = magic cookie (4) || transaction id (12)
            let mut mask = [0u8; 16];
            mask[0..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
            mask[4..16].copy_from_slice(txid);
            let mut ip = [0u8; 16];
            for k in 0..16 {
                ip[k] = value[4 + k] ^ mask[k];
            }
            Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(ip)), port))
        }
        _ => None,
    }
}

/// Percorre os atributos e devolve o primeiro endereço. XOR-MAPPED-ADDRESS
/// tem prioridade; MAPPED-ADDRESS fica como fallback. Nunca panica.
fn parse_address_attrs(body: &[u8], txid: &[u8; 12]) -> Option<SocketAddr> {
    let mut mapped: Option<SocketAddr> = None;
    let mut i = 0usize;
    while i + 4 <= body.len() {
        let attr_type = u16::from_be_bytes([body[i], body[i + 1]]);
        let attr_len = u16::from_be_bytes([body[i + 2], body[i + 3]]) as usize;
        let value_start = i + 4;
        let value_end = value_start.checked_add(attr_len)?;
        if value_end > body.len() {
            return None;
        }
        let value = &body[value_start..value_end];
        match attr_type {
            ATTR_XOR_MAPPED_ADDRESS => {
                if let Some(a) = parse_xor_addr(value, txid) {
                    return Some(a);
                }
            }
            ATTR_MAPPED_ADDRESS => {
                if mapped.is_none() {
                    mapped = parse_mapped_addr(value);
                }
            }
            _ => {}
        }
        // atributos são alinhados a 4 bytes (padding).
        i = value_end + ((4 - (attr_len % 4)) % 4);
    }
    mapped
}

type Cache = StdMutex<Option<(Option<SocketAddr>, i64)>>;
static STUN_CACHE: OnceLock<Cache> = OnceLock::new();

fn cache_cell() -> &'static Cache {
    STUN_CACHE.get_or_init(|| StdMutex::new(None))
}

/// Cache válido? `Some(inner)` = resposta cacheada (inner pode ser None numa
/// falha recente — evita bombardear os servidores). `None` = expirado/ausente.
fn cache_get() -> Option<Option<SocketAddr>> {
    let cell = cache_cell().lock().unwrap_or_else(|e| e.into_inner());
    match &*cell {
        Some((addr, at)) if crate::identity::now_ms() - *at < CACHE_TTL_MS => Some(*addr),
        _ => None,
    }
}

fn cache_put(addr: Option<SocketAddr>) {
    *cache_cell().lock().unwrap_or_else(|e| e.into_inner()) =
        Some((addr, crate::identity::now_ms()));
}

/// Consulta UM servidor e devolve o endereço mapeado.
async fn query_one(server: &str) -> Option<SocketAddr> {
    let addrs = tokio::net::lookup_host(server).await.ok()?;
    // Prefere IPv4 (rota mais previsível); aceita IPv6 se for só o que houver.
    let mut target: Option<SocketAddr> = None;
    for a in addrs {
        if a.is_ipv4() {
            target = Some(a);
            break;
        }
        if target.is_none() {
            target = Some(a);
        }
    }
    let target = target?;
    let bind = if target.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let sock = UdpSocket::bind(bind).await.ok()?;
    sock.connect(target).await.ok()?;
    let txid = random_txid();
    sock.send(&build_binding_request(&txid)).await.ok()?;
    let mut buf = [0u8; 512];
    let n = tokio::time::timeout(QUERY_TIMEOUT, sock.recv(&mut buf))
        .await
        .ok()?
        .ok()?;
    let body = parse_binding_success(&buf[..n], &txid)?;
    let addr = parse_address_attrs(body, &txid)?;
    debug!(%target, mapped = %addr, "STUN: endpoint público descoberto");
    Some(addr)
}

/// Raça todos os servidores; devolve o 1º que responder e aborta o resto.
async fn race_servers() -> Option<SocketAddr> {
    let mut set = tokio::task::JoinSet::new();
    for server in STUN_SERVERS {
        let server = *server;
        set.spawn(async move { query_one(server).await });
    }
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(addr)) = joined {
            set.abort_all();
            return Some(addr);
        }
    }
    None
}

/// Endpoint público (ip:porta) do nosso NAT, com cache de ~60s. Raça alguns
/// servidores públicos e devolve o primeiro que responder. `None` se estiver
/// desligado (`FORGE_STUN=0`), todos falharem ou tudo expirar.
pub async fn stun_external_addr() -> Option<SocketAddr> {
    if !stun_enabled() {
        return None;
    }
    if let Some(cached) = cache_get() {
        return cached;
    }
    let addr = race_servers().await;
    cache_put(addr);
    addr
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Monta uma Binding Success sintética com UM atributo (sem rede).
    fn build_response(txid: &[u8; 12], attr_type: u16, attr_value: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&MSG_BINDING_SUCCESS.to_be_bytes());
        let attr_total = 4 + attr_value.len();
        v.extend_from_slice(&(attr_total as u16).to_be_bytes());
        v.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        v.extend_from_slice(txid);
        v.extend_from_slice(&attr_type.to_be_bytes());
        v.extend_from_slice(&(attr_value.len() as u16).to_be_bytes());
        v.extend_from_slice(attr_value);
        while v.len() % 4 != 0 {
            v.push(0);
        }
        v
    }

    fn xor_value_v4(ip: Ipv4Addr, port: u16) -> Vec<u8> {
        let mut value = vec![0u8, 0x01];
        value.extend_from_slice(&(port ^ ((MAGIC_COOKIE >> 16) as u16)).to_be_bytes());
        value.extend_from_slice(&(u32::from(ip) ^ MAGIC_COOKIE).to_be_bytes());
        value
    }

    #[test]
    fn binding_request_layout_rfc5389() {
        let txid = [0x11u8; 12];
        let req = build_binding_request(&txid);
        assert_eq!(req.len(), 20);
        assert_eq!(u16::from_be_bytes([req[0], req[1]]), MSG_BINDING_REQUEST);
        assert_eq!(u16::from_be_bytes([req[2], req[3]]), 0); // sem atributos
        assert_eq!(&req[4..8], &MAGIC_COOKIE.to_be_bytes());
        assert_eq!(&req[8..20], &txid);
    }

    #[test]
    fn parse_xor_mapped_address_ipv4() {
        let txid = [0x42u8; 12];
        let ip = Ipv4Addr::new(203, 0, 113, 7);
        let port = 12345u16;
        let resp = build_response(&txid, ATTR_XOR_MAPPED_ADDRESS, &xor_value_v4(ip, port));
        let body = parse_binding_success(&resp, &txid).expect("header válido");
        let addr = parse_address_attrs(body, &txid).expect("xor address");
        assert_eq!(addr, SocketAddr::new(IpAddr::V4(ip), port));
    }

    #[test]
    fn parse_mapped_address_ipv4_como_fallback() {
        let txid = [0x07u8; 12];
        let ip = Ipv4Addr::new(198, 51, 100, 20);
        let port = 5555u16;
        let mut value = vec![0u8, 0x01];
        value.extend_from_slice(&port.to_be_bytes());
        value.extend_from_slice(&ip.octets());
        let resp = build_response(&txid, ATTR_MAPPED_ADDRESS, &value);
        let body = parse_binding_success(&resp, &txid).expect("header válido");
        let addr = parse_address_attrs(body, &txid).expect("mapped address");
        assert_eq!(addr, SocketAddr::new(IpAddr::V4(ip), port));
    }

    #[test]
    fn parse_xor_mapped_address_ipv6() {
        let txid = [0xABu8; 12];
        let ip = Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1);
        let port = 9000u16;
        let mut value = vec![0u8, 0x02];
        value.extend_from_slice(&(port ^ ((MAGIC_COOKIE >> 16) as u16)).to_be_bytes());
        let mut mask = [0u8; 16];
        mask[0..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
        mask[4..16].copy_from_slice(&txid);
        let raw = ip.octets();
        for k in 0..16 {
            value.push(raw[k] ^ mask[k]);
        }
        let resp = build_response(&txid, ATTR_XOR_MAPPED_ADDRESS, &value);
        let body = parse_binding_success(&resp, &txid).expect("header válido");
        let addr = parse_address_attrs(body, &txid).expect("xor v6");
        assert_eq!(addr, SocketAddr::new(IpAddr::V6(ip), port));
    }

    #[test]
    fn parse_rejeita_resposta_invalida() {
        let txid = [0x01u8; 12];
        let value = xor_value_v4(Ipv4Addr::new(1, 2, 3, 4), 100);
        let resp = build_response(&txid, ATTR_XOR_MAPPED_ADDRESS, &value);

        // txid diferente → rejeita
        assert!(parse_binding_success(&resp, &[0xFFu8; 12]).is_none());
        // curta → rejeita (não panica)
        assert!(parse_binding_success(&[], &txid).is_none());
        assert!(parse_binding_success(&resp[..10], &txid).is_none());
        // tipo errado (request) → rejeita
        let mut wrong = resp.clone();
        wrong[0..2].copy_from_slice(&MSG_BINDING_REQUEST.to_be_bytes());
        assert!(parse_binding_success(&wrong, &txid).is_none());
        // cookie errado → rejeita
        let mut bad_cookie = resp.clone();
        bad_cookie[4..8].copy_from_slice(&0u32.to_be_bytes());
        assert!(parse_binding_success(&bad_cookie, &txid).is_none());
        // length que estoura o buffer → rejeita
        let mut bad_len = resp.clone();
        bad_len[2..4].copy_from_slice(&500u16.to_be_bytes());
        assert!(parse_binding_success(&bad_len, &txid).is_none());
    }

    #[test]
    fn parse_atributo_truncado_nao_panica() {
        // Atributo declara 8 bytes mas só há 2 → devolve None, sem panic.
        let txid = [0x09u8; 12];
        let mut body = Vec::new();
        body.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        body.extend_from_slice(&8u16.to_be_bytes());
        body.extend_from_slice(&[0u8, 0x01]);
        assert!(parse_address_attrs(&body, &txid).is_none());
    }

    #[test]
    fn stun_kill_flag_parsing() {
        assert!(stun_flag_value(None), "default = ligado");
        assert!(stun_flag_value(Some("1")));
        assert!(stun_flag_value(Some("yes")));
        assert!(stun_flag_value(Some("TRUE")));
        assert!(!stun_flag_value(Some("0")));
        assert!(!stun_flag_value(Some("false")));
        assert!(!stun_flag_value(Some("no")));
        assert!(!stun_flag_value(Some("off")));
        assert!(!stun_flag_value(Some(" OFF ")));
    }
}
