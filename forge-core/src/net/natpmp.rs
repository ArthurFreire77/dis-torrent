//! NAT-PMP best-effort (RFC 6886) — complementa o UPnP IGD.
//!
//! O crate `igd` só fala UPnP (SOAP), NÃO expõe NAT-PMP/PCP. Muitos roteadores
//! domésticos e CGNATs só respondem NAT-PMP em UDP/5351, então implementamos um
//! cliente mínimo aqui. É 100% best-effort: qualquer falha/timeout vira `None`
//! e o engine segue no hole punch/relay. Não é transporte de dados.
//!
//! Ponto importante p/ o torrent: a porta EXTERNA atribuída pelo roteador pode
//! diferir da interna. O anúncio/`Punch` tem que publicar a EXTERNA, senão o
//! inbound não chega.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::time::Duration;

use tracing::{debug, info};

/// Porta UDP do protocolo NAT-PMP.
const NATPMP_PORT: u16 = 5351;
/// Versão do protocolo (RFC 6886 = 0).
const NATPMP_VERSION: u8 = 0;
/// Opcode para mapear porta TCP.
const OP_MAP_TCP: u8 = 2;
/// Bit alto marca RESPONSE (requisições têm bit 0).
const RESPONSE_BIT: u8 = 0x80;

/// Mapeia a porta TCP via NAT-PMP e devolve a porta EXTERNA atribuída pelo
/// roteador (pode diferir da interna). `None` = sem gateway/protocolo.
///
/// Bloqueante de propósito (rodar dentro de `spawn_blocking`): timeout curto,
/// sem `unwrap`, nunca panica.
pub fn map_tcp(port: u16, lifetime_s: u32) -> Option<u16> {
    let gateway = default_gateway_v4()?;
    let request = encode_request(OP_MAP_TCP, port, port, lifetime_s);
    let target = SocketAddr::V4(SocketAddrV4::new(gateway, NATPMP_PORT));
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.set_read_timeout(Some(Duration::from_millis(700)))
        .ok()?;

    for attempt in 0..3u8 {
        if sock.send_to(&request, target).is_err() {
            return None;
        }
        let mut buf = [0u8; 32];
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            // Só confia em resposta vinda do próprio gateway.
            if from.ip() != IpAddr::V4(gateway) {
                continue;
            }
            if let Some(ext) = parse_response(&buf[..n], OP_MAP_TCP, port) {
                // 0 no campo externo = "use a sugerida" (RFC 6886 §3.3.2).
                let ext = if ext == 0 { port } else { ext };
                if ext != port {
                    info!(internal = port, external = ext, %gateway, "NAT-PMP: porta externa != interna (anunciar a externa)");
                }
                return Some(ext);
            }
        }
        // backoff curto entre retries (gateway lento/primeiro pacote perdido)
        std::thread::sleep(Duration::from_millis(250 * (u64::from(attempt) + 1)));
    }
    debug!(%gateway, "NAT-PMP: sem resposta (protocolo não suportado) — segue UPnP/hole punch");
    None
}

/// Monta o request de 12 bytes do RFC 6886.
pub fn encode_request(
    op: u8,
    internal_port: u16,
    suggested_external: u16,
    lifetime_s: u32,
) -> [u8; 12] {
    let mut b = [0u8; 12];
    b[0] = NATPMP_VERSION;
    b[1] = op;
    // b[2..4]: reserved (0)
    b[4..6].copy_from_slice(&internal_port.to_be_bytes());
    b[6..8].copy_from_slice(&suggested_external.to_be_bytes());
    b[8..12].copy_from_slice(&lifetime_s.to_be_bytes());
    b
}

/// Valida a response e devolve a porta externa mapeada.
/// `None` se curta, opcode/versão divergentes ou result_code != 0.
pub fn parse_response(buf: &[u8], op: u8, internal_port: u16) -> Option<u16> {
    if buf.len() < 16 {
        return None;
    }
    if buf[0] != NATPMP_VERSION {
        return None;
    }
    if buf[1] != (op | RESPONSE_BIT) {
        return None;
    }
    let result_code = u16::from_be_bytes([buf[2], buf[3]]);
    if result_code != 0 {
        return None;
    }
    let resp_internal = u16::from_be_bytes([buf[8], buf[9]]);
    if resp_internal != internal_port {
        return None;
    }
    Some(u16::from_be_bytes([buf[10], buf[11]]))
}

/// Descobre o gateway IPv4 padrão. Linux: `/proc/net/route` (rota default).
/// Fallback: assume `.1` da /24 da interface de saída (comum em casa/CGNAT).
fn default_gateway_v4() -> Option<Ipv4Addr> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/net/route") {
            for line in content.lines().skip(1) {
                let cols: Vec<&str> = line.split_whitespace().collect();
                // Destination == 00000000 => rota default; Gateway em hex LE.
                if cols.len() >= 3 && cols[1] == "00000000" {
                    if let Ok(raw) = u32::from_str_radix(cols[2], 16) {
                        let gw = Ipv4Addr::from(raw.to_le_bytes());
                        if !gw.is_unspecified() {
                            return Some(gw);
                        }
                    }
                }
            }
        }
    }
    let IpAddr::V4(local) = local_outbound_ip()? else {
        return None;
    };
    let o = local.octets();
    Some(Ipv4Addr::new(o[0], o[1], o[2], 1))
}

/// IP local que o kernel escolheria para a rota padrão (sem enviar pacote).
fn local_outbound_ip() -> Option<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_request_layout_rfc6886() {
        let r = encode_request(OP_MAP_TCP, 4242, 4242, 3600);
        assert_eq!(r.len(), 12);
        assert_eq!(r[0], 0); // versão
        assert_eq!(r[1], 2); // op TCP
        assert_eq!(&r[2..4], &[0, 0]); // reserved
        assert_eq!(u16::from_be_bytes([r[4], r[5]]), 4242);
        assert_eq!(u16::from_be_bytes([r[6], r[7]]), 4242);
        assert_eq!(u32::from_be_bytes([r[8], r[9], r[10], r[11]]), 3600);
    }

    #[test]
    fn parse_response_ok_e_porta_externa() {
        let mut b = [0u8; 16];
        b[0] = 0;
        b[1] = OP_MAP_TCP | RESPONSE_BIT;
        // result_code = 0
        b[8..10].copy_from_slice(&4242u16.to_be_bytes());
        b[10..12].copy_from_slice(&5555u16.to_be_bytes());
        assert_eq!(parse_response(&b, OP_MAP_TCP, 4242), Some(5555));
    }

    #[test]
    fn parse_response_rejeita_erro_curto_e_op_errado() {
        let mut err = [0u8; 16];
        err[1] = OP_MAP_TCP | RESPONSE_BIT;
        err[2] = 0;
        err[3] = 2; // result_code = 2 (não suportado)
        err[8..10].copy_from_slice(&4242u16.to_be_bytes());
        assert_eq!(parse_response(&err, OP_MAP_TCP, 4242), None);

        let mut wrong_op = [0u8; 16];
        wrong_op[1] = 1 | RESPONSE_BIT; // UDP, não TCP
        assert_eq!(parse_response(&wrong_op, OP_MAP_TCP, 4242), None);

        // resposta curta não panica
        assert_eq!(parse_response(&[0u8; 5], OP_MAP_TCP, 4242), None);
        assert_eq!(parse_response(&[], OP_MAP_TCP, 4242), None);

        // porta interna diferente = response de outro pedido
        let mut mismatch = [0u8; 16];
        mismatch[1] = OP_MAP_TCP | RESPONSE_BIT;
        mismatch[8..10].copy_from_slice(&9999u16.to_be_bytes());
        assert_eq!(parse_response(&mismatch, OP_MAP_TCP, 4242), None);
    }
}
