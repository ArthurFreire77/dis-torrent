//! Sonda educada de brokers MQTT públicos: UMA conexão por broker, sem storm.
//! Uso: cargo run --example mqtt_probe
//! Mostra CONNACK / recusa / timeout por broker — base para depurar "4G não conecta".

use std::time::Duration;

#[tokio::main]
async fn main() {
    for host in [
        "broker.emqx.io",
        "test.mosquitto.org",
        "broker.mqttdashboard.com",
        "broker.hivemq.com",
    ] {
        let mut opts =
            rumqttc::MqttOptions::new(format!("distorrent-probe-{}", uuid_short()), host, 1883);
        opts.set_keep_alive(Duration::from_secs(10));
        opts.set_clean_session(true);
        let (_client, mut eventloop) = rumqttc::AsyncClient::new(opts, 8);
        let t0 = std::time::Instant::now();
        let mut verdict = String::from("TIMEOUT 15s (sem CONNACK)");
        let deadline = tokio::time::sleep(Duration::from_secs(15));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                ev = eventloop.poll() => match ev {
                    Ok(rumqttc::Event::Incoming(rumqttc::Incoming::ConnAck(ack))) => {
                        verdict = format!("CONNACK em {:?} (session_present={})", t0.elapsed(), ack.session_present);
                        break;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        verdict = format!("ERRO em {:?}: {e}", t0.elapsed());
                        // recusa explícita (NotAuthorized etc.) não vai melhorar: para já
                        let s = format!("{e:?}");
                        if s.contains("NotAuthorized")
                            || s.contains("ServiceUnavailable")
                            || s.contains("BadUserNamePassword")
                        {
                            break;
                        }
                    }
                },
            }
        }
        println!("{host}: {verdict}");
        // intervalo educado entre brokers (não martelar)
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn uuid_short() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    format!("{:x}", h.finish())
}
