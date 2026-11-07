// Relay diag: parte de net/relay.rs.
// Irmao do relay.rs; usa os tipos la declarados via super::*.

use super::relay_mqtt::{mqtt_connack, sanitize_client_part};
use super::*;

pub async fn check_relay_legs_via(proxy: Option<&str>) -> Vec<RelayLegStatus> {
    use std::time::{Duration, Instant};

    let via = proxy.map(|p| format!(" via {p}")).unwrap_or_default();
    let is_proxied = proxy.is_some();
    let connect_timeout = if is_proxied {
        Duration::from_secs(12)
    } else {
        Duration::from_secs(8)
    };
    let mqtt_hosts = [
        ("mqtt broker.emqx.io:1883", "broker.emqx.io", 1883u16),
        (
            "mqtt test.mosquitto.org:1883",
            "test.mosquitto.org",
            1883u16,
        ),
        (
            "mqtt broker.mqttdashboard.com:1883",
            "broker.mqttdashboard.com",
            1883u16,
        ),
        ("mqtt broker.hivemq.com:1883", "broker.hivemq.com", 1883u16),
    ];
    let mut out = Vec::new();
    for (name, host, port) in mqtt_hosts {
        let t0 = Instant::now();
        let res = tokio::time::timeout(connect_timeout, async {
            let stream = match proxy {
                Some(p) => crate::net::socks5::socks5_connect(
                    p,
                    &crate::net::socks5::SocksTarget::Host(host.to_string(), port),
                )
                .await
                .map_err(|e| e.to_string())?,
                None => tokio::net::TcpStream::connect((host, port))
                    .await
                    .map_err(|e| e.to_string())?,
            };
            mqtt_connack(stream, host).await
        })
        .await;
        match res {
            Ok(Ok(())) => out.push(RelayLegStatus {
                name: format!("{name}{via}"),
                ok: true,
                latency_ms: Some(t0.elapsed().as_millis() as u64),
                last_error: None,
            }),
            Ok(Err(e)) => out.push(RelayLegStatus {
                name: format!("{name}{via}"),
                ok: false,
                latency_ms: None,
                last_error: Some(short_err(&e)),
            }),
            Err(_) => out.push(RelayLegStatus {
                name: format!("{name}{via}"),
                ok: false,
                latency_ms: None,
                last_error: Some(format!(
                    "sem resposta em {}s{}",
                    connect_timeout.as_secs(),
                    if is_proxied {
                        " (proxy/Tor inacessível, lento, ou broker sem CONNACK)"
                    } else {
                        " (porta TCP bloqueada no 4G/NAT, ou broker sem CONNACK)"
                    }
                )),
            }),
        }
    }
    out
}

pub async fn check_relay_legs() -> Vec<RelayLegStatus> {
    check_relay_legs_via(None).await
}

pub async fn proxy_online_test(proxy: &str) -> std::result::Result<u64, String> {
    use std::time::Instant;
    let t0 = Instant::now();
    let brokers = [
        ("broker.emqx.io", 1883u16),
        ("test.mosquitto.org", 1883),
        ("broker.hivemq.com", 1883),
    ];
    let (tx, mut rx) = mpsc::unbounded_channel::<std::result::Result<(), String>>();
    for (host, port) in brokers {
        let (tx, proxy) = (tx.clone(), proxy.to_string());
        tokio::spawn(async move {
            let r = crate::net::socks5::socks5_connect(
                &proxy,
                &crate::net::socks5::SocksTarget::Host(host.to_string(), port),
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string());
            let _ = tx.send(r);
        });
    }
    drop(tx);
    let mut first_err = "proxy não respondeu".to_string();
    while let Some(r) = rx.recv().await {
        match r {
            Ok(()) => return Ok(t0.elapsed().as_millis() as u64),
            Err(e) => first_err = e,
        }
    }
    Err(short_err(&first_err))
}

pub fn short_err(s: &str) -> String {
    let mut t = s.trim().replace('\n', " ");
    if t.len() > 160 {
        t.truncate(160);
    }
    t
}
