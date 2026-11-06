//! Testes da política de quarentena como um TODO, incluindo o caso que mais
//! importa: o peer que NUNCA responde ao desafio não pode ficar liberado.
//!
//! O engine real não é instanciado aqui (exige store/rede); a lógica testada é
//! a mesma que `NetworkEngine::peer_quarantined` usa: estado + janela.

use distorrent_core::release::attestation::{
    verify_attestation, BuildAttestation, BuildClaim, PeerPolicy, PeerTrust, PeerTrustState,
    SelfIntegrityState, ATTEST_PROTO_V, ATTEST_TIMEOUT_MS,
};

/// Reproduz a decisão do engine sem depender de rede.
fn quarantined(
    trust: Option<&PeerTrust>,
    verificacao_disponivel: bool,
    desafio_enviado_em: Option<i64>,
    peer_proto: u32,
    agora: i64,
    policy: PeerPolicy,
) -> bool {
    match trust {
        Some(t) => policy.decision(t, verificacao_disponivel).is_some(),
        None => {
            if !verificacao_disponivel {
                return false;
            }
            let vencido = match desafio_enviado_em {
                Some(t) => agora.saturating_sub(t) > ATTEST_TIMEOUT_MS,
                None => peer_proto < ATTEST_PROTO_V,
            };
            if !vencido {
                return false;
            }
            policy
                .decision(&PeerTrust::unavailable("sem prova"), verificacao_disponivel)
                .is_some()
        }
    }
}

#[test]
fn peer_que_nunca_responde_nao_fica_liberado_para_sempre() {
    let p = PeerPolicy::BlockUnverified;
    // Desafio acabou de sair: janela aberta, não bloqueia ainda.
    assert!(!quarantined(None, true, Some(1_000), 5, 1_000, p));
    // Passou da janela sem resposta: passa a contar como não verificado.
    assert!(quarantined(
        None,
        true,
        Some(1_000),
        5,
        1_000 + ATTEST_TIMEOUT_MS + 1,
        p
    ));
}

#[test]
fn peer_antigo_sem_proto_v_5_nao_e_desafiado_e_conta_como_nao_verificado() {
    let p = PeerPolicy::BlockUnverified;
    // Nenhum desafio é enviado (proto_v < 5), então não há janela a esperar.
    assert!(quarantined(None, true, None, 4, 0, p));
    // Com policy permissiva, o mesmo peer continua livre.
    assert!(!quarantined(None, true, None, 4, 0, PeerPolicy::Warn));
}

#[test]
fn sem_chaves_no_receptor_ninguem_e_bloqueado_em_massa() {
    // Build sem cerimônia: não há como provar nada, então bloquear seria punir
    // todo mundo por uma limitação do próprio cliente.
    for proto in [0u32, 4, 5] {
        assert!(!quarantined(
            None,
            false,
            None,
            proto,
            0,
            PeerPolicy::BlockUnverified
        ));
        assert!(!quarantined(
            None,
            false,
            Some(1),
            proto,
            10_000_000,
            PeerPolicy::BlockUnverified
        ));
    }
}

#[test]
fn veredito_positivo_libera_e_negativo_bloqueia() {
    let f = fixture();
    let nonce = [3u8; 32];
    let transcript = "ab".repeat(32);
    let (trust_set, kp, manifest) = f;
    let claim = BuildClaim {
        version: manifest.body.version.clone(),
        manifest_hash: manifest.body.hash_hex().unwrap(),
        build_id: "b".into(),
        commit: manifest.body.commit.clone(),
        channel: manifest.body.channel.clone(),
        protocol_version: 5,
        security_epoch: manifest.body.security_epoch,
        self_integrity: SelfIntegrityState::Confere,
    };
    let att = BuildAttestation::sign(&kp, &transcript, &nonce, claim, Some(&manifest)).unwrap();
    let tr = verify_attestation(
        Some(&trust_set),
        &att,
        &kp.fingerprint(),
        &kp.public_hex(),
        &transcript,
        &nonce,
        0,
    );
    assert_eq!(tr.state, PeerTrustState::ReleaseVerificada);
    assert!(!quarantined(
        Some(&tr),
        true,
        Some(1_000),
        5,
        i64::MAX / 2,
        PeerPolicy::BlockUnverified
    ));
}

/// Fixture mínima: 3 chaves, conjunto 2-de-3, manifesto assinado por 0 e 1.
fn fixture() -> (
    distorrent_core::release::TrustSet,
    distorrent_core::identity::Keypair,
    distorrent_core::release::SignedManifest,
) {
    use distorrent_core::identity::Keypair;
    use distorrent_core::release::manifest::{
        ManifestAsset, ManifestBody, ManifestSignature, SignedManifest, MANIFEST_SCHEMA, PROJECT_ID,
    };
    use distorrent_core::release::trust::TrustedKey;

    let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
    let mut trusted: Vec<TrustedKey> = keys
        .iter()
        .map(|k| TrustedKey::from_pubkey_hex(&k.public_hex()).unwrap())
        .collect();
    trusted.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    let trust = distorrent_core::release::TrustSet {
        epoch: 1,
        threshold: 2,
        keys: trusted,
    };
    let body = ManifestBody {
        schema: MANIFEST_SCHEMA,
        project: PROJECT_ID.into(),
        version: "1.2.3".into(),
        channel: "stable".into(),
        tag: "v1.2.3".into(),
        commit: "b".repeat(40),
        published_at_ms: 1_700_000_000_000,
        protocol_version: 5,
        min_protocol_version: 4,
        security_epoch: 7,
        min_security_epoch: 1,
        revoked_versions: vec![],
        revoked_key_ids: vec![],
        assets: vec![ManifestAsset {
            name: "DisTorrent_1.2.3_x64_setup.exe".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            size: 1000,
            sha256: "a".repeat(64),
            url: "https://github.com/ArthurFreire77/dis-torrent/releases/download/v1.2.3/DisTorrent_1.2.3_x64_setup.exe".into(),
        }],
    };
    let payload = body.signing_payload().unwrap();
    let signed = SignedManifest {
        signatures: [0usize, 1]
            .iter()
            .map(|&i| ManifestSignature {
                key_id: TrustedKey::from_pubkey_hex(&keys[i].public_hex())
                    .unwrap()
                    .key_id,
                sig: keys[i].sign(&payload),
            })
            .collect(),
        body,
    };
    (trust, keys[0].clone(), signed)
}
