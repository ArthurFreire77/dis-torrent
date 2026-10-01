//! DHT BitTorrent — regras PURAS (sem rede): derivação do infohash por
//! identidade e opt-in de produção.

/// O infohash é DETERMINÍSTICO por fingerprint: os dois lados derivam o
/// mesmo "torrent" sem trocar nada fora de banda. 20 bytes (BEP-5).
#[test]
fn infohash_deterministico_e_20_bytes() {
    let a = forge_core::net::dht::identity_infohash("abe1a18a12e1");
    let b = forge_core::net::dht::identity_infohash("abe1a18a12e1");
    let c = forge_core::net::dht::identity_infohash("3414eda11fb0");
    assert_eq!(a, b, "mesmo fp ⇒ mesmo infohash (rendezvous funciona)");
    assert_ne!(a, c, "fps diferentes ⇒ infohashes diferentes");
    assert_eq!(a.to_vec().len(), 20, "BEP-5: infohash tem 20 bytes");
}

/// Prefixo versionado: mudar o formato do hash não colide com a geração
/// anterior (rotação de protocolo sem ambiguidade).
#[test]
fn infohash_versionado_distinto_de_hash_cru() {
    use blake3::Hasher;
    let mut h = Hasher::new();
    h.update(b"abe1a18a12e1");
    let raw: [u8; 20] = h.finalize().as_bytes()[..20].try_into().unwrap();
    let v = forge_core::net::dht::identity_infohash("abe1a18a12e1");
    assert_ne!(
        raw,
        &v.to_vec()[..20],
        "domínio separado por prefixo forge-dht-v1"
    );
}
