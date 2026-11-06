//! Prova de interoperabilidade da ROTAÇÃO: o arquivo gerado por
//! `tools/release-trust/rotate-keys.mjs` (payload + bloco de assinaturas)
//! precisa decodificar em `TrustUpdate::from_wire` e ser aplicado por
//! `verify_and_apply` com o conjunto atual.
//!
//! O fixture é gerado pelo tooling e versionado em
//! `tests/fixtures/rotation_vector.json` (só chaves públicas e assinaturas).

use distorrent_core::release::trust::{TrustSet, TrustUpdate, TrustedKey};

#[test]
fn rotacao_gerada_pelo_tooling_node_e_aceita_pelo_rust() {
    let raw = include_str!("fixtures/rotation_vector.json");
    let v: serde_json::Value = serde_json::from_str(raw).unwrap();

    let current = parse(&v["current_trust_set"].as_str().unwrap().to_string());
    let expected_epoch = v["new_epoch"].as_u64().unwrap();
    let wire = hex::decode(v["wire_hex"].as_str().unwrap()).unwrap();

    let up = TrustUpdate::from_wire(&wire).expect("o arquivo de rotação precisa decodificar");
    assert_eq!(up.from_epoch, current.epoch);
    assert_eq!(up.new_set.epoch, expected_epoch);
    assert_eq!(up.signatures.len(), 2, "duas assinaturas no arquivo");

    let novo = up
        .verify_and_apply(&current)
        .expect("2-de-3 do conjunto atual autoriza a rotação");
    assert_eq!(novo.epoch, expected_epoch);
    assert!(novo.threshold >= 2);
    // Continuidade: pelo menos uma chave antiga permanece.
    assert!(novo.keys.iter().any(|k| current.has_key(&k.key_id)));

    // Reencodar dá os MESMOS bytes: o formato do arquivo é o canônico.
    let re = distorrent_core::release::encode_trust_update(&up).unwrap();
    assert_eq!(re, wire);
}

#[test]
fn rotacao_do_tooling_com_uma_assinatura_so_e_recusada() {
    let raw = include_str!("fixtures/rotation_vector.json");
    let v: serde_json::Value = serde_json::from_str(raw).unwrap();
    let current = parse(&v["current_trust_set"].as_str().unwrap().to_string());
    let wire = hex::decode(v["wire_hex"].as_str().unwrap()).unwrap();
    let mut up = TrustUpdate::from_wire(&wire).unwrap();
    up.signatures.truncate(1);
    assert!(
        up.verify_and_apply(&current).is_err(),
        "uma chave não pode rotacionar o conjunto"
    );
}

#[test]
fn rotacao_adulterada_no_arquivo_e_recusada() {
    let raw = include_str!("fixtures/rotation_vector.json");
    let v: serde_json::Value = serde_json::from_str(raw).unwrap();
    let current = parse(&v["current_trust_set"].as_str().unwrap().to_string());
    let mut wire = hex::decode(v["wire_hex"].as_str().unwrap()).unwrap();
    // Troca um byte da justificativa (perto do fim do payload).
    let pos = wire.len() - 80;
    wire[pos] ^= 0x01;
    let decoded = TrustUpdate::from_wire(&wire);
    match decoded {
        Err(_) => {}
        Ok(up) => assert!(
            up.verify_and_apply(&current).is_err(),
            "payload adulterado não pode ser aplicado"
        ),
    }
}

fn parse(raw: &str) -> TrustSet {
    let mut parts = raw.split('|');
    let epoch: u64 = parts.next().unwrap().trim().parse().unwrap();
    let threshold: u8 = parts.next().unwrap().trim().parse().unwrap();
    let mut keys: Vec<TrustedKey> = parts
        .next()
        .unwrap()
        .split(',')
        .map(|item| {
            let (id, pubkey) = item.split_once(':').unwrap();
            TrustedKey {
                key_id: id.trim().to_string(),
                pubkey_hex: pubkey.trim().to_string(),
            }
        })
        .collect();
    keys.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    TrustSet {
        epoch,
        threshold,
        keys,
    }
}
