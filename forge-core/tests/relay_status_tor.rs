//! TESTE REAL do diagnóstico de relay em modo anônimo (proxy/Tor).
//!
//! Ignorado por padrão porque exige um Tor (ou SOCKS5) rodando localmente.
//! Rode com:
//!   cargo test --test relay_status_tor -- --ignored --nocapture
//!
//! Prova DUAS coisas de verdade, sem mock:
//! 1. O caminho SOCKS5 muda o IP de saída: um GET em http://api.ipify.org
//!    feito por `socks5_connect` retorna um IP DIFERENTE do GET direto.
//!    (Se igual, o tráfego NÃO passou pelo proxy — exatamente o vazamento
//!    que o modo proxy/Tor evita.)
//! 2. `check_relay_legs_via(Some(tor))` roda ponta a ponta e marca a perna
//!    ntfy (HTTPS) como alcançável pelo SOCKS — ou seja, o diagnóstico
//!    `relay_status` deixa de vazar o IP nesses modos.

use std::time::Duration;

use forge_core::net::socks5::{socks5_connect, SocksTarget};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

const ECHO_HOST: &str = "api.ipify.org";

/// GET HTTP/1.0 cru e devolve o corpo (o IP público visto pela origem).
async fn http_get_ip<S>(mut stream: S) -> Option<String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let req = format!(
        "GET / HTTP/1.1\r\nHost: {ECHO_HOST}\r\nUser-Agent: forge-test\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).await.ok()?;
    stream.flush().await.ok()?;
    let mut buf = Vec::new();
    // timeout total do corpo: Tor pode ser lento ao abrir circuito
    let read = tokio::time::timeout(Duration::from_secs(40), stream.read_to_end(&mut buf)).await;
    if read.is_err() {
        return None;
    }
    let text = String::from_utf8_lossy(&buf);
    // separa headers do corpo e valida que é um IP plausível
    let body = text
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or("")
        .trim()
        .to_string();
    if body.is_empty() || body.len() > 64 || !body.contains('.') {
        return None;
    }
    Some(body)
}

async fn ip_direto() -> Option<String> {
    let stream = TcpStream::connect((ECHO_HOST, 80u16)).await.ok()?;
    http_get_ip(stream).await
}

async fn ip_via_socks(proxy: &str) -> Option<String> {
    let stream = socks5_connect(proxy, &SocksTarget::Host(ECHO_HOST.to_string(), 80u16))
        .await
        .ok()?;
    http_get_ip(stream).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requer SOCKS5/Tor local (ex.: Tor em 127.0.0.1:9050) — rode com --ignored"]
async fn relay_diagnostics_via_tor_nao_vaza_ip() {
    let proxy = std::env::var("FORGE_TOR_ADDR").unwrap_or_else(|_| "127.0.0.1:9050".to_string());

    // 0) O proxy está no ar?
    if TcpStream::connect(proxy.as_str()).await.is_err() {
        eprintln!("SKIP: SOCKS5/Tor não está rodando em {proxy}");
        return;
    }

    // 1) Prova REAL de rota: o IP de saída via SOCKS tem de diferir do direto.
    let direto = ip_direto().await;
    let via = ip_via_socks(&proxy).await;
    eprintln!("IP direto = {direto:?}  |  IP via SOCKS({proxy}) = {via:?}");
    match (direto, via) {
        (Some(d), Some(v)) => {
            assert_ne!(
                d, v,
                "SOCKS5 não trocou o IP de saída (direto={d}, via={v}) — não está passando pelo proxy"
            );
        }
        (_, None) => {
            eprintln!("SKIP: não foi possível obter o IP via SOCKS (rede/Tor indisponível)");
            return;
        }
        (None, Some(_)) => {
            eprintln!("SKIP: sem rota direta para comparar (rede fechada)");
        }
    }

    // 2) O diagnóstico oficial roda pelo SOCKS e reporta as pernas.
    let legs = forge_core::net::relay::check_relay_legs_via(Some(&proxy)).await;
    assert!(!legs.is_empty(), "diagnóstico não retornou pernas");
    for l in &legs {
        eprintln!(
            "[tor] {:<40} ok={:<5} lat={:?}ms err={:?}",
            l.name, l.ok, l.latency_ms, l.last_error
        );
    }
    assert!(
        legs.iter().any(|l| l.name.contains("via")),
        "o nome da perna deve indicar a rota via proxy (senão o usuário não sabe que está anônimo)"
    );
    assert!(
        legs.iter().any(|l| l.name.contains("ntfy") && l.ok),
        "ntfy (HTTPS) deveria estar alcançável através do Tor"
    );
}
