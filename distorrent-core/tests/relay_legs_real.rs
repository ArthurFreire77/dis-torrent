// Roda `check_relay_legs` real contra os brokers públicos e mostra o resultado
// (o mesmo que o relatório de diagnóstico do app exibe).
#[tokio::test]
#[ignore = "rede real: consulta brokers MQTT públicos"]
async fn probe_real_dos_brokers_publicos() {
    let legs = distorrent_core::net::relay::check_relay_legs().await;
    for l in &legs {
        println!(
            "{} {:<34} {:>6}ms {}",
            if l.ok { "OK   " } else { "FALHA" },
            l.name,
            l.latency_ms.unwrap_or(0),
            l.last_error.clone().unwrap_or_default()
        );
    }
    let ok = legs.iter().filter(|l| l.ok).count();
    println!("\n{ok}/{} pernas funcionando", legs.len());
    assert!(
        ok >= 2,
        "pelo menos 2 pernas precisam responder (fail-open do relay)"
    );
}
