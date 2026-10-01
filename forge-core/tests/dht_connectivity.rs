//! Sonda: a DHT mainline funciona DAQUI? get_peers num infohash POPULAR
//! (Big Buck Bunny) — se achar peers, a rede BitTorrent está alcançável.
#[tokio::test]
#[ignore = "sonda real de conectividade DHT"]
async fn dht_mainline_alcanca_popular() {
    std::env::set_var("FORGE_DHT", "1");
    let dht = mainline::Dht::client().expect("dht client");
    // Big Buck Bunny (famoso, sempre semeado)
    let ih =
        mainline::Id::from_bytes(hex::decode("dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c").unwrap())
            .unwrap();
    let t0 = std::time::Instant::now();
    let r = tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        if let Ok(iter) = dht.get_peers(ih) {
            for batch in iter {
                for a in batch {
                    found.push(a);
                    if found.len() >= 20 {
                        return found;
                    }
                }
            }
        }
        found
    })
    .await
    .unwrap();
    eprintln!("DHT: {} peers em {:?}s", r.len(), t0.elapsed());
    assert!(
        !r.is_empty(),
        "DHT não achou NADA num infohash popular — rede bloqueada?"
    );
}
