// Frames de tunnel: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_tunnel(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::TunnelOffer {
            eph_pub_hex,
            nonce_hex,
            sig,
        } => {
            handle_tunnel_offer(engine, peer_fp, peer_pubkey, &eph_pub_hex, &nonce_hex, &sig);
        }

        SecureFrame::TunnelAnswer {
            eph_pub_hex,
            nonce_hex,
            for_nonce_hex,
            sig,
        } => {
            handle_tunnel_answer(
                engine,
                peer_fp,
                peer_pubkey,
                &eph_pub_hex,
                &nonce_hex,
                &for_nonce_hex,
                &sig,
            );
        }

        SecureFrame::TunnelData { nonce, ct_b64 } => {
            handle_tunnel_data(engine, peer_fp, nonce, &ct_b64);
        }

        _ => {}
    }
    Ok(())
}
