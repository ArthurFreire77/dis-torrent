//! Cliente SOCKS5 minimalista (RFC 1928) com suporte a HOSTNAME/ONION como
//! alvo — o tokio_socks só aceita SocketAddr, o que impede conexões a
//! serviços onion (.onion) e força DNS local para domínios comuns.
//! Sem dependências externas: binário direto sobre TcpStream.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::ForgeError;

/// Alvo de conexão SOCKS5: IP:porta ou hostname:porta (domínio/.onion).
#[derive(Debug, Clone)]
pub enum SocksTarget {
    Addr(std::net::SocketAddr),
    Host(String, u16),
}

const VER: u8 = 5;
const CMD_CONNECT: u8 = 1;
const ATYP_IPV4: u8 = 1;
const ATYP_DOMAIN: u8 = 3;
const ATYP_IPV6: u8 = 4;

/// Conecta via proxy SOCKS5 ao alvo. Autenticação none (padrão do Tor).
/// Retorna o TcpStream pronto para o protocolo da aplicação.
pub async fn socks5_connect(proxy: &str, target: &SocksTarget) -> Result<TcpStream, ForgeError> {
    let mut stream = TcpStream::connect(proxy)
        .await
        .map_err(|e| ForgeError::Protocol(format!("proxy {proxy} inacessível: {e}")))?;

    // ── handshake: versões suportadas (apenas 5, sem auth) ──
    stream.write_all(&[VER, 1, 0x00]).await.map_err(io)?;
    let mut resp = [0u8; 2];
    stream.read_exact(&mut resp).await.map_err(io)?;
    if resp[0] != VER {
        return Err(ForgeError::Protocol("proxy não é SOCKS5".into()));
    }
    if resp[1] != 0x00 {
        return Err(ForgeError::Protocol(format!(
            "proxy exige autenticação (método 0x{:02x}) — sem suporte",
            resp[1]
        )));
    }

    // ── CONNECT com ATYP correto ──
    let mut req = vec![VER, CMD_CONNECT, 0x00]; // RSV
    match target {
        SocksTarget::Addr(sa) => match sa {
            std::net::SocketAddr::V4(v4) => {
                req.push(ATYP_IPV4);
                req.extend_from_slice(&v4.ip().octets());
                req.extend_from_slice(&v4.port().to_be_bytes());
            }
            std::net::SocketAddr::V6(v6) => {
                req.push(ATYP_IPV6);
                req.extend_from_slice(&v6.ip().octets());
                req.extend_from_slice(&v6.port().to_be_bytes());
            }
        },
        SocksTarget::Host(host, port) => {
            let host = host.trim();
            if host.is_empty() || host.len() > 255 {
                return Err(ForgeError::Protocol("hostname inválido para proxy".into()));
            }
            req.push(ATYP_DOMAIN);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
            req.extend_from_slice(&port.to_be_bytes());
        }
    }
    stream.write_all(&req).await.map_err(io)?;

    // ── resposta: VER REP RSV ATYP ADDR... ──
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await.map_err(io)?;
    if head[0] != VER {
        return Err(ForgeError::Protocol("resposta do proxy inválida".into()));
    }
    if head[1] != 0x00 {
        // 0x01 falha geral, 0x02 permitido, 0x03 rede, 0x04 host inalcançável,
        // 0x05 recusado, 0x06 TTL, 0x07 comando, 0x08 alvo — mapa direto
        return Err(ForgeError::Protocol(
            match head[1] {
                0x01 => "proxy: falha geral do SOCKS",
                0x02 => "proxy: conexão não permitida por regra",
                0x03 => "proxy: rede inalcançável",
                0x04 => "proxy: host inalcançável",
                0x05 => "proxy: conexão recusada",
                0x06 => "proxy: TTL expirado",
                0x07 => "proxy: comando não suportado",
                0x08 => "proxy: tipo de alvo não suportado",
                _ => "proxy: erro SOCKS desconhecido",
            }
            .to_string(),
        ));
    }
    // consome o BND.ADDR/BND.PORT conforme ATYP (não usamos, mas é obrigatório)
    let skip = match head[3] {
        ATYP_IPV4 => 4 + 2,
        ATYP_IPV6 => 16 + 2,
        ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(io)?;
            len[0] as usize + 2
        }
        _ => return Err(ForgeError::Protocol("ATYP desconhecido na resposta".into())),
    };
    let mut discard = vec![0u8; skip];
    stream.read_exact(&mut discard).await.map_err(io)?;

    Ok(stream)
}

fn io(e: std::io::Error) -> ForgeError {
    ForgeError::Protocol(format!("proxy io: {e}"))
}

/// Versão SÍNCRONA (std, sem tokio) do CONNECT — para o `SocksTunnel`, que
/// precisa subir em contextos sem runtime async (ex.: comando Tauri síncrono
/// ao trocar o modo de privacidade). Mesmo protocolo byte-a-byte de
/// [`socks5_connect`].
pub fn socks5_connect_sync(
    proxy: &str,
    target: &SocksTarget,
) -> std::result::Result<std::net::TcpStream, ForgeError> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(proxy)
        .map_err(|e| ForgeError::Protocol(format!("proxy {proxy} inacessível: {e}")))?;
    stream.set_nodelay(true).ok();
    stream.write_all(&[VER, 1, 0x00]).map_err(io)?;
    let mut resp = [0u8; 2];
    stream.read_exact(&mut resp).map_err(io)?;
    if resp[0] != VER {
        return Err(ForgeError::Protocol("proxy não é SOCKS5".into()));
    }
    if resp[1] != 0x00 {
        return Err(ForgeError::Protocol(format!(
            "proxy exige autenticação (método 0x{:02x}) — sem suporte",
            resp[1]
        )));
    }
    let mut req = vec![VER, CMD_CONNECT, 0x00];
    match target {
        SocksTarget::Addr(sa) => match sa {
            std::net::SocketAddr::V4(v4) => {
                req.push(ATYP_IPV4);
                req.extend_from_slice(&v4.ip().octets());
                req.extend_from_slice(&v4.port().to_be_bytes());
            }
            std::net::SocketAddr::V6(v6) => {
                req.push(ATYP_IPV6);
                req.extend_from_slice(&v6.ip().octets());
                req.extend_from_slice(&v6.port().to_be_bytes());
            }
        },
        SocksTarget::Host(host, port) => {
            let host = host.trim();
            if host.is_empty() || host.len() > 255 {
                return Err(ForgeError::Protocol("hostname inválido para proxy".into()));
            }
            req.push(ATYP_DOMAIN);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
            req.extend_from_slice(&port.to_be_bytes());
        }
    }
    stream.write_all(&req).map_err(io)?;
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).map_err(io)?;
    if head[0] != VER {
        return Err(ForgeError::Protocol("resposta do proxy inválida".into()));
    }
    if head[1] != 0x00 {
        return Err(ForgeError::Protocol(
            match head[1] {
                0x01 => "proxy: falha geral do SOCKS",
                0x02 => "proxy: conexão não permitida por regra",
                0x03 => "proxy: rede inalcançável",
                0x04 => "proxy: host inalcançável",
                0x05 => "proxy: conexão recusada",
                0x06 => "proxy: TTL expirado",
                0x07 => "proxy: comando não suportado",
                0x08 => "proxy: tipo de alvo não suportado",
                _ => "proxy: erro SOCKS desconhecido",
            }
            .to_string(),
        ));
    }
    let skip = match head[3] {
        ATYP_IPV4 => 4 + 2,
        ATYP_IPV6 => 16 + 2,
        ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).map_err(io)?;
            len[0] as usize + 2
        }
        _ => return Err(ForgeError::Protocol("ATYP desconhecido na resposta".into())),
    };
    let mut discard = vec![0u8; skip];
    stream.read_exact(&mut discard).map_err(io)?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn socks5_host_e_addr_via_mock() {
        // servidor echo REAL por trás do mock SOCKS5
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_addr = echo.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                // Err => continue (transiente): nunca derruba o servidor de teste.
                // Não usar while-let aqui — ele faria break no Err, matando o accept loop.
                let (mut s, _) = match echo.accept().await {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    if let Ok(n) = s.read(&mut buf).await {
                        let _ = s.write_all(&buf[..n]).await;
                    }
                });
            }
        });

        let proxy = mock_server::spawn().await;

        // 1) alvo IP:porta
        let mut c = socks5_connect(&proxy.to_string(), &SocksTarget::Addr(echo_addr))
            .await
            .unwrap();
        c.write_all(b"ip-direct").await.unwrap();
        let mut buf = [0u8; 9];
        c.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"ip-direct");

        // 2) alvo HOST:porta (ATYP=domain — caminho do Tor/.onion)
        let host = format!("127.0.0.1:{}", echo_addr.port());
        let mut c = socks5_connect_host(&proxy.to_string(), &host)
            .await
            .unwrap();
        c.write_all(b"via-hostname").await.unwrap();
        let mut buf = [0u8; 12];
        c.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"via-hostname");
    }

    #[test]
    fn split_host_port_variants() {
        assert_eq!(
            split_host_port("a.onion:80").unwrap(),
            ("a.onion".into(), 80)
        );
        assert_eq!(
            split_host_port("127.0.0.1:45900").unwrap(),
            ("127.0.0.1".into(), 45900)
        );
        assert_eq!(split_host_port("[::1]:9000").unwrap(), ("::1".into(), 9000));
        assert!(split_host_port("sem-porta").is_err());
        assert!(split_host_port("host:porta-invalida").is_err());
    }
}

/// Conecta via SOCKS5 a um alvo "host:porta" (aceita IP, domínio ou .onion).
/// Útil para o modo Tor: o hostname NUNCA é resolvido localmente — vai
/// criptografado ao proxy, que resolve dentro da rede.
pub async fn socks5_connect_host(proxy: &str, host_port: &str) -> Result<TcpStream, ForgeError> {
    let (host, port) = split_host_port(host_port)?;
    socks5_connect(proxy, &SocksTarget::Host(host, port)).await
}

/// Separa "host:porta" (suporta [IPv6]:porta e onion:porta).
pub fn split_host_port(s: &str) -> Result<(String, u16), ForgeError> {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('[') {
        let end = rest
            .find(']')
            .ok_or_else(|| ForgeError::Protocol("IPv6 sem ']'".into()))?;
        let host = rest[..end].to_string();
        let after = &rest[end + 1..];
        let port = after
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .ok_or_else(|| ForgeError::Protocol("porta inválida".into()))?;
        return Ok((host, port));
    }
    let (host, port) = s
        .rsplit_once(':')
        .ok_or_else(|| ForgeError::Protocol("use host:porta".into()))?;
    let port: u16 = port
        .parse()
        .map_err(|_| ForgeError::Protocol("porta inválida".into()))?;
    if host.is_empty() {
        return Err(ForgeError::Protocol("host vazio".into()));
    }
    Ok((host.to_string(), port))
}

// ── servidor SOCKS5 de teste (mock mínimo, CONNECT apenas) ──
#[cfg(test)]
pub(crate) mod mock_server {
    use super::*;
    use tokio::io::{AsyncRead, AsyncWrite};
    use tokio::net::{TcpListener, TcpStream};

    /// Servidor SOCKS5 que aceita CONNECT e faz pipe bidirecional ao alvo REAL.
    /// Usado nos testes para validar o protocolo byte-a-byte sem Tor.
    pub async fn spawn() -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                // Err => continue (transiente): accept falho não derruba o mock.
                // Mantido como loop+match propositalmente — while-let faria break no Err.
                match listener.accept().await {
                    Ok((client, _)) => {
                        tokio::spawn(async move {
                            if let Err(e) = serve(client).await {
                                eprintln!("[mock-socks5] erro: {e}");
                            }
                        });
                    }
                    Err(_) => continue,
                }
            }
        });
        addr
    }

    async fn serve(mut client: TcpStream) -> std::io::Result<()> {
        // greeting
        let mut hdr = [0u8; 2];
        client.read_exact(&mut hdr).await?;
        if hdr[0] != VER {
            return Ok(());
        }
        let mut methods = vec![0u8; hdr[1] as usize];
        client.read_exact(&mut methods).await?;
        let ok = methods.contains(&0x00);
        client
            .write_all(&[VER, if ok { 0x00 } else { 0xFF }])
            .await?;
        if !ok {
            return Ok(());
        }
        // request
        let mut head = [0u8; 4];
        client.read_exact(&mut head).await?;
        let target: std::net::SocketAddr = match head[3] {
            ATYP_IPV4 => {
                let mut o = [0u8; 6];
                client.read_exact(&mut o).await?;
                let ip = std::net::Ipv4Addr::new(o[0], o[1], o[2], o[3]);
                format!("{ip}:{}", u16::from_be_bytes([o[4], o[5]]))
                    .parse()
                    .unwrap()
            }
            ATYP_DOMAIN => {
                let mut l = [0u8; 1];
                client.read_exact(&mut l).await?;
                let mut host = vec![0u8; l[0] as usize];
                client.read_exact(&mut host).await?;
                let mut p = [0u8; 2];
                client.read_exact(&mut p).await?;
                let port = u16::from_be_bytes(p);
                // resolve o hostname REAL (mock é para testes locais)
                tokio::net::lookup_host((String::from_utf8(host).unwrap(), port))
                    .await?
                    .next()
                    .ok_or_else(|| std::io::Error::other("dns falhou"))?
            }
            _ => return Ok(()),
        };
        let mut up = TcpStream::connect(target).await?;
        client
            .write_all(&[VER, 0x00, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
            .await?;
        pipe(&mut client, &mut up).await;
        Ok(())
    }

    async fn pipe<A, B>(a: &mut A, b: &mut B)
    where
        A: AsyncRead + AsyncWrite + Unpin,
        B: AsyncRead + AsyncWrite + Unpin,
    {
        // bidirecional CONCORRENTE — cópia sequencial dá deadlock com
        // servidores que respondem antes do cliente fechar a escrita
        let _ = tokio::io::copy_bidirectional(a, b).await;
    }
}
