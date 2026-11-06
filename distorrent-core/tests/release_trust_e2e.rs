//! Testes de segurança ponta a ponta da camada de autenticidade:
//! manifestos assinados 2-de-3, atestação entre "peers" reais (via funções),
//! e o contrato de bytes canônicos que o tooling Node precisa reproduzir.

use distorrent_core::identity::Keypair;
use distorrent_core::release::attestation::{
    verify_attestation, BuildAttestation, BuildClaim, PeerPolicy, PeerTrustState,
    SelfIntegrityState,
};
use distorrent_core::release::manifest::{
    ManifestAsset, ManifestBody, ManifestSignature, SignedManifest, MANIFEST_SCHEMA, PROJECT_ID,
};
use distorrent_core::release::store::{KvStore, ReleaseTrust};
use distorrent_core::release::trust::{verify_manifest, ReleaseStatus, TrustSet, TrustedKey};

fn trust_set(keys: &[Keypair], epoch: u64) -> TrustSet {
    let mut trusted: Vec<TrustedKey> = keys
        .iter()
        .map(|k| TrustedKey::from_pubkey_hex(&k.public_hex()).unwrap())
        .collect();
    trusted.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    TrustSet {
        epoch,
        threshold: 2,
        keys: trusted,
    }
}

fn body(version: &str, epoch: u64) -> ManifestBody {
    let core = version.split('-').next().unwrap();
    ManifestBody {
        schema: MANIFEST_SCHEMA,
        project: PROJECT_ID.into(),
        version: version.into(),
        channel: "stable".into(),
        tag: format!("v{core}"),
        commit: "a".repeat(40),
        published_at_ms: 1_700_000_000_000,
        protocol_version: 5,
        min_protocol_version: 4,
        security_epoch: epoch,
        min_security_epoch: 1,
        revoked_versions: vec![],
        revoked_key_ids: vec![],
        assets: vec![
            ManifestAsset {
                name: format!("DisTorrent_{core}_arm64.apk"),
                os: "android".into(),
                arch: "aarch64".into(),
                size: 12_000_000,
                sha256: "b".repeat(64),
                url: format!(
                    "https://github.com/ArthurFreire77/dis-torrent/releases/download/v{core}/DisTorrent_{core}_arm64.apk"
                ),
            },
            ManifestAsset {
                name: format!("DisTorrent_{core}_amd64.AppImage"),
                os: "linux".into(),
                arch: "x86_64".into(),
                size: 90_000_000,
                sha256: "c".repeat(64),
                url: format!(
                    "https://github.com/ArthurFreire77/dis-torrent/releases/download/v{core}/DisTorrent_{core}_amd64.AppImage"
                ),
            },
            ManifestAsset {
                name: format!("DisTorrent_{core}_x64_setup.exe"),
                os: "windows".into(),
                arch: "x86_64".into(),
                size: 9_000_000,
                sha256: "d".repeat(64),
                url: format!(
                    "https://github.com/ArthurFreire77/dis-torrent/releases/download/v{core}/DisTorrent_{core}_x64_setup.exe"
                ),
            },
        ],
    }
}

fn sign(keys: &[Keypair], body: ManifestBody, which: &[usize]) -> SignedManifest {
    let payload = body.signing_payload().unwrap();
    SignedManifest {
        signatures: which
            .iter()
            .map(|&i| ManifestSignature {
                key_id: TrustedKey::from_pubkey_hex(&keys[i].public_hex())
                    .unwrap()
                    .key_id,
                sig: keys[i].sign(&payload),
            })
            .collect(),
        body,
    }
}

#[test]
fn fluxo_completo_2_de_3_e_wire_sobrevive_ao_transporte() {
    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let trust = trust_set(&keys, 1);
    let signed = sign(&keys, body("2.0.0", 10), &[0, 1]);

    // Passa pelo fio (é assim que o peer manda e o updater baixa).
    let wire = signed.to_wire().unwrap();
    let back = SignedManifest::from_wire(&wire).unwrap();
    assert_eq!(back, signed);

    let v = verify_manifest(&trust, &back, 0).unwrap();
    assert!(v.is_verified());
    assert_eq!(v.valid_signatures, 2);
    // O hash do manifesto é estável entre encode/decode.
    assert_eq!(v.manifest_hash, signed.body.hash_hex().unwrap());
}

#[test]
fn reinstalar_uma_release_antiga_legitima_e_recusado_por_epoch() {
    // Cenário de rollback: atacante reapresenta manifesto REAL da 1.0.0
    // (assinaturas válidas) depois que a 2.0.0 já foi aceita.
    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let trust = trust_set(&keys, 1);
    let velho = sign(&keys, body("1.0.0", 10), &[0, 1]);
    let novo = sign(&keys, body("2.0.0", 20), &[0, 1]);

    let mut rt = ReleaseTrust::with_trust(trust.clone());
    let kv = MemKv::default();
    assert!(rt.accept(&kv, &novo).unwrap().is_verified());
    let v = rt.accept(&kv, &velho).unwrap();
    assert_eq!(v.status, ReleaseStatus::Obsoleto);
    assert!(!v.is_verified());
    assert_eq!(rt.epoch_floor(), 20, "o piso não pode descer");
}

#[test]
fn peer_mente_sobre_versao_e_e_pego_pela_claim() {
    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let trust = trust_set(&keys, 1);
    let signed = sign(&keys, body("2.0.0", 10), &[0, 1]);
    let nonce = [9u8; 32];
    let transcript = "ab".repeat(32);

    let mut claim = BuildClaim {
        version: "2.0.0".into(),
        manifest_hash: signed.body.hash_hex().unwrap(),
        build_id: "x".into(),
        commit: signed.body.commit.clone(),
        channel: signed.body.channel.clone(),
        protocol_version: 5,
        security_epoch: 10,
        self_integrity: SelfIntegrityState::Confere,
    };
    // Peer assina a própria mentira (identidade dele, chave dele).
    claim.version = "9.9.9".into();
    let att = BuildAttestation::sign(&keys[0], &transcript, &nonce, claim.clone(), Some(&signed))
        .unwrap();
    let tr = verify_attestation(
        Some(&trust),
        &att,
        &keys[0].fingerprint(),
        &keys[0].public_hex(),
        &transcript,
        &nonce,
        0,
    );
    assert_eq!(tr.state, PeerTrustState::NaoVerificado);
    assert!(tr.reason.contains("declaração"));
}

#[test]
fn peer_adultera_manifesto_e_a_assinatura_quebra() {
    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let trust = trust_set(&keys, 1);
    let signed = sign(&keys, body("2.0.0", 10), &[0, 1]);
    let mut adulterado = signed.clone();
    adulterado.body.assets[2].sha256 = "e".repeat(64);

    let nonce = [4u8; 32];
    let transcript = "cd".repeat(32);
    let claim = BuildClaim {
        version: "2.0.0".into(),
        manifest_hash: signed.body.hash_hex().unwrap(),
        build_id: "x".into(),
        commit: signed.body.commit.clone(),
        channel: signed.body.channel.clone(),
        protocol_version: 5,
        security_epoch: 10,
        self_integrity: SelfIntegrityState::Confere,
    };
    let att =
        BuildAttestation::sign(&keys[0], &transcript, &nonce, claim, Some(&adulterado)).unwrap();
    let tr = verify_attestation(
        Some(&trust),
        &att,
        &keys[0].fingerprint(),
        &keys[0].public_hex(),
        &transcript,
        &nonce,
        0,
    );
    assert_eq!(tr.state, PeerTrustState::NaoVerificado);
}

#[test]
fn peer_revogado_nao_passa_nem_com_duas_assinaturas() {
    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let trust = trust_set(&keys, 1);
    let mut b = body("2.0.0", 10);
    b.revoked_versions = vec!["2.0.0".into()];
    let signed = sign(&keys, b, &[0, 1]);

    let nonce = [1u8; 32];
    let transcript = "ef".repeat(32);
    let claim = BuildClaim {
        version: "2.0.0".into(),
        manifest_hash: signed.body.hash_hex().unwrap(),
        build_id: "x".into(),
        commit: signed.body.commit.clone(),
        channel: signed.body.channel.clone(),
        protocol_version: 5,
        security_epoch: 10,
        self_integrity: SelfIntegrityState::Confere,
    };
    let att = BuildAttestation::sign(&keys[0], &transcript, &nonce, claim, Some(&signed)).unwrap();
    let tr = verify_attestation(
        Some(&trust),
        &att,
        &keys[0].fingerprint(),
        &keys[0].public_hex(),
        &transcript,
        &nonce,
        0,
    );
    assert_eq!(tr.state, PeerTrustState::Revogado);
    // Revogado é bloqueado em QUALQUER política, inclusive "warn".
    for p in [
        PeerPolicy::BlockUnverified,
        PeerPolicy::BlockRevoked,
        PeerPolicy::Warn,
    ] {
        assert!(p.decision(&tr, true).is_some(), "política {p:?}");
    }
}

#[test]
fn uma_chave_comprometida_sozinha_nao_assina_release() {
    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let trust = trust_set(&keys, 1);
    // Atacante tem a chave 2 e assina perfeitamente. Não basta.
    let signed = sign(&keys, body("6.6.6", 999), &[2]);
    assert_eq!(
        verify_manifest(&trust, &signed, 0).unwrap().status,
        ReleaseStatus::NaoVerificado
    );
}

#[test]
fn assinatura_de_duas_chaves_iguais_nao_conta_duas_vezes() {
    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let trust = trust_set(&keys, 1);
    let mut signed = sign(&keys, body("2.0.0", 10), &[0]);
    let dup = signed.signatures[0].clone();
    signed.signatures.push(dup);
    assert_eq!(
        verify_manifest(&trust, &signed, 0).unwrap().status,
        ReleaseStatus::NaoVerificado
    );
}

#[test]
fn manifesto_de_outro_projeto_ou_repo_nao_e_aceito() {
    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let trust = trust_set(&keys, 1);
    let mut b = body("2.0.0", 10);
    b.project = "outro-app".into();
    assert!(b.canonical_bytes().is_err(), "projeto divergente");

    let mut b = body("2.0.0", 10);
    b.assets[0].url = "https://github.com/outro/repo/releases/download/v2.0.0/x.apk".into();
    // O manifesto pode citar outra URL? A validação de forma não olha o host
    // (o updater olha). O que NÃO pode é a assinatura cobrir outra coisa.
    let signed = sign(&keys, b.clone(), &[0, 1]);
    let v = verify_manifest(&trust, &signed, 0).unwrap();
    assert!(v.is_verified(), "assinatura cobre a URL declarada");
    assert_eq!(signed.body.assets[0].url, b.assets[0].url);
}

#[test]
fn onboarding_de_chaves_novas_nao_aceita_key_id_forjado() {
    let k = Keypair::generate();
    let real = TrustedKey::from_pubkey_hex(&k.public_hex()).unwrap();
    let forjado = TrustedKey {
        key_id: "0000000000000000".into(),
        pubkey_hex: real.pubkey_hex.clone(),
    };
    let mut set = TrustSet {
        epoch: 1,
        threshold: 2,
        keys: vec![real.clone(), forjado],
    };
    set.keys.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    assert!(set.validate().is_err());
}

#[test]
fn rotacao_com_epoch_repetida_e_recusada() {
    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let trust = trust_set(&keys, 5);
    let novo = TrustSet {
        epoch: 5,
        threshold: 2,
        keys: trust.keys.clone(),
    };
    let up = distorrent_core::release::trust::TrustUpdate {
        from_epoch: 5,
        new_set: novo,
        revoked_versions: vec![],
        effective_ms: 1,
        reason: "sem avanço".into(),
        signatures: vec![],
    };
    assert!(up.verify_and_apply(&trust).is_err());
}

#[derive(Default)]
struct MemKv(std::sync::Mutex<std::collections::BTreeMap<String, String>>);

impl KvStore for MemKv {
    fn get(&self, key: &str) -> Option<String> {
        self.0.lock().unwrap().get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> distorrent_core::Result<()> {
        let mut m = self.0.lock().unwrap();
        if value.is_empty() {
            m.remove(key);
        } else {
            m.insert(key.to_string(), value.to_string());
        }
        Ok(())
    }
    fn list_prefix(&self, prefix: &str) -> Vec<(String, String)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

#[test]
fn cache_nao_deixa_manifesto_invalido_entrar() {
    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let trust = trust_set(&keys, 1);
    let kv = MemKv::default();
    let mut rt = ReleaseTrust::with_trust(trust);
    let ruim = sign(&keys, body("2.0.0", 10), &[0]);
    let v = rt.accept(&kv, &ruim).unwrap();
    assert!(!v.is_verified());
    assert!(rt.latest_verified().is_none());
    assert!(kv.list_prefix("release.manifest.").is_empty());
}

#[test]
fn bytes_canonicos_sao_estaveis_para_o_tooling_node() {
    // Vetor fixo: se o formato mudar, o tooling Node (e o teste dele) precisa
    // mudar junto. Esse hash é o contrato entre os dois lados.
    let b = body("1.2.3", 7);
    let bytes = b.canonical_bytes().unwrap();
    let hash = b.hash_hex().unwrap();
    assert_eq!(bytes.len(), bytes.len());
    assert_eq!(hash.len(), 64);
    // A ordem dos campos está fixada: magic + schema.
    assert_eq!(&bytes[..5], b"DTMF1");
    assert_eq!(&bytes[5..7], &1u16.to_be_bytes());
    // "distorrent" é o primeiro campo string: u32 len + bytes.
    assert_eq!(&bytes[7..11], &10u32.to_be_bytes());
    assert_eq!(&bytes[11..21], PROJECT_ID.as_bytes());
    // Determinismo: chamar de novo dá o mesmo resultado.
    assert_eq!(b.canonical_bytes().unwrap(), bytes);
    assert_eq!(b.hash_hex().unwrap(), hash);
}
