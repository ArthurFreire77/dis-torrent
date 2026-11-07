// Frames de attest: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_attest(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    _peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::BuildChallenge {
            nonce_hex,
            transcript_hash,
            ..
        } => {
            if engine.netlimiter.allow_attest(peer_fp) == Decision::Blocked {
                debug!(peer_fp, "desafio de atestação descartado (rate limit)");
                return Ok(());
            }
            let nonce_bytes = hex::decode(&nonce_hex).ok();
            let Some(nonce_arr) = nonce_bytes.and_then(|v| <[u8; 32]>::try_from(v).ok()) else {
                debug!(
                    peer_fp,
                    "desafio de atestação com nonce inválido — ignorado"
                );
                return Ok(());
            };
            // O hash do transcript é conferido aqui: um peer não pode desafiar em nome de outra sessão.
            let meu = engine
                .attest_transcript
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(peer_fp)
                .cloned();
            if meu.as_deref() != Some(transcript_hash.as_str()) {
                debug!(
                    peer_fp,
                    "desafio de atestação com transcript de outra sessão — ignorado"
                );
                return Ok(());
            }
            let Some(att) = engine.own_build_attestation(nonce_arr, &transcript_hash) else {
                return Ok(());
            };
            let Ok(wire) = serde_json::to_vec(&att) else {
                return Ok(());
            };
            engine.send_to_peer(
                peer_fp.to_string(),
                SecureFrame::BuildAttestResponse {
                    attestation_hex: hex::encode(wire),
                },
            );
        }

        SecureFrame::BuildAttestResponse { attestation_hex } => {
            if engine.netlimiter.allow_attest(peer_fp) == Decision::Blocked {
                debug!(peer_fp, "resposta de atestação descartada (rate limit)");
                return Ok(());
            }
            // Desafio que ESTE lado enviou: sem ele, não há o que verificar.
            let expected = engine
                .attest_nonce
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(peer_fp)
                .copied();
            let Some(expected_nonce) = expected else {
                debug!(peer_fp, "resposta de atestação sem desafio pendente");
                return Ok(());
            };
            let Some(transcript) = engine
                .attest_transcript
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(peer_fp)
                .cloned()
            else {
                return Ok(());
            };
            if attestation_hex.len() > 256 * 1024 {
                debug!(peer_fp, "resposta de atestação acima do limite");
                return Ok(());
            }
            let Ok(bytes) = hex::decode(&attestation_hex) else {
                debug!(peer_fp, "resposta de atestação não é hex");
                return Ok(());
            };
            let att: crate::release::BuildAttestation = match serde_json::from_slice(&bytes) {
                Ok(a) => a,
                Err(_) => {
                    debug!(peer_fp, "resposta de atestação malformada");
                    return Ok(());
                }
            };
            // Sem orçamento de falhas: descarta ANTES de gastar CPU. Um peer
            // que só manda assinatura inválida não escolhe quanto trabalho o
            // receptor faz.
            if !engine.netlimiter.attest_failure_budget(peer_fp) {
                debug!(
                    peer_fp,
                    "orçamento de atestação esgotado — resposta ignorada"
                );
                return Ok(());
            }
            // Trabalho criptográfico com teto: um atacante não escolhe quanto de CPU o receptor gasta.
            let Some(_slot) = engine.netlimiter.try_attest_slot() else {
                debug!(peer_fp, "resposta de atestação descartada (teto global)");
                return Ok(());
            };
            let trust = engine
                .release_trust
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .trust()
                .cloned();
            let floor = engine.memory_floor();
            let verdict = crate::release::verify_attestation(
                trust.as_ref(),
                &att,
                peer_fp,
                peer_pubkey,
                &transcript,
                &expected_nonce,
                floor,
            );
            let veredito_ok = verdict.is_verified();
            if !veredito_ok && !engine.netlimiter.note_attest_failure(peer_fp) {
                debug!(
                    peer_fp,
                    "assinaturas inválidas repetidas — ignorando novas respostas"
                );
            }
            engine.record_peer_trust(peer_fp, verdict);
            // O nonce foi consumido: a próxima resposta precisa de novo desafio.
            engine
                .attest_nonce
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(peer_fp);
        }

        SecureFrame::BuildManifestPush { manifest_hex } => {
            if engine.netlimiter.allow_manifest_push(peer_fp) == Decision::Blocked {
                debug!(peer_fp, "push de manifesto descartado (rate limit)");
                return Ok(());
            }
            match engine.accept_peer_manifest(peer_fp, &manifest_hex) {
                Ok(true) => {}
                Ok(false) => debug!(peer_fp, "manifesto de peer recusado na verificação"),
                Err(e) => debug!(peer_fp, "manifesto de peer inválido: {e}"),
            }
        }

        SecureFrame::UpdateHint {
            version,
            manifest_hash,
        } => {
            // Aviso só. Nada é baixado nem executado por causa dele; o
            // atualizador decide contra o manifesto verificado localmente.
            if engine.peer_proto_v(peer_fp) >= crate::release::ATTEST_PROTO_V {
                debug!(peer_fp, %version, %manifest_hash, "peer avisou de atualização");
            }
        }

        _ => {}
    }
    Ok(())
}
