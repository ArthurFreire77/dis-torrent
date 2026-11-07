// Despacho dos frames recebidos (handle_frame). O match por familia de frame
// fica nos irmaos frames_<familia>.rs; aqui so o prologo e a ordem das chamadas.

use super::*;

#[allow(unreachable_code)] // em build sem as variantes cfg-gated o match é exaustivo
pub(super) async fn handle_frame(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    engine.diag_update(peer_fp, |d| {
        d.last_rx_ms = crate::identity::now_ms();
    });
    if let SecureFrame::CallRoom {
        call_id,
        conv_id,
        kind,
        state,
        participants,
        ..
    } = &frame
    {
        engine.room_receive(peer_fp, call_id, conv_id, kind, state, participants.clone());
        return Ok(());
    }
    if matches!(
        frame,
        SecureFrame::CallInvite { .. }
            | SecureFrame::CallAccept { .. }
            | SecureFrame::CallReject { .. }
            | SecureFrame::CallEnd { .. }
            | SecureFrame::CallOffer { .. }
            | SecureFrame::CallAnswer { .. }
            | SecureFrame::CallIce { .. }
            | SecureFrame::CallAddParticipant { .. }
            | SecureFrame::ScreenShareOffer { .. }
            | SecureFrame::ScreenShareAnswer { .. }
    ) {
        if engine.netlimiter.allow_call_signal(peer_fp) == Decision::Blocked {
            return Err(DistorrentError::Protocol(
                "sinalização de chamada descartada (rate limit)".into(),
            ));
        }
        let is_friend = engine
            .store
            .get_friend(peer_fp)
            .ok()
            .flatten()
            .map(|(_, s)| s == "accepted")
            .unwrap_or(false);
        let shares_chamada = call_id_do_frame(&frame)
            .map(|cid| engine.store.is_in_call(&cid, &engine.identity.fingerprint))
            .unwrap_or(false);
        let shares_group = engine
            .store
            .group_convs_with_peer(peer_fp)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
            || shares_chamada;
        let shares_comm = engine
            .store
            .list_communities()
            .map(|cs| {
                cs.iter()
                    .any(|(id, _, _)| engine.store.member_role(id, peer_fp).is_some())
            })
            .unwrap_or(false);
        if !is_friend && !shares_group && !shares_comm {
            if let SecureFrame::CallInvite { call_id, .. } = &frame {
                let _ = engine.queue_or_send_call_frame(
                    peer_fp,
                    SecureFrame::CallReject {
                        call_id: call_id.clone(),
                        reason: "não é amigo".into(),
                    },
                );
            }
            return Err(DistorrentError::Protocol(
                "sinalização de chamada de quem não é amigo".into(),
            ));
        }
    }
    match &frame {
        SecureFrame::Msg { .. }
        | SecureFrame::Ack { .. }
        | SecureFrame::Read { .. }
        | SecureFrame::ChannelMsg { .. }
        | SecureFrame::ChannelAck { .. } => {
            return f_message::handle_message(engine, peer_fp, peer_pubkey, peer_nick, frame).await;
        }
        SecureFrame::Ping { .. }
        | SecureFrame::Pong { .. }
        | SecureFrame::PeerExchange { .. }
        | SecureFrame::PeerRelayPut { .. }
        | SecureFrame::PeerRelayGet { .. }
        | SecureFrame::PeerRelayData { .. }
        | SecureFrame::Bye { .. }
        | SecureFrame::Punch { .. } => {
            return f_peer::handle_peer(engine, peer_fp, peer_pubkey, peer_nick, frame).await;
        }
        SecureFrame::FriendRequest { .. }
        | SecureFrame::FriendAccept { .. }
        | SecureFrame::FriendReject { .. }
        | SecureFrame::FriendRemove { .. } => {
            return f_friends::handle_friends(engine, peer_fp, peer_pubkey, peer_nick, frame).await;
        }
        SecureFrame::JoinCommunity { .. }
        | SecureFrame::CommunityState { .. }
        | SecureFrame::CommunityKicked { .. }
        | SecureFrame::ChannelReorder { .. }
        | SecureFrame::CommunitySyncRequest { .. } => {
            return f_community::handle_community(engine, peer_fp, peer_pubkey, peer_nick, frame)
                .await;
        }
        SecureFrame::GroupCreated { .. }
        | SecureFrame::GroupMemberAdded { .. }
        | SecureFrame::GroupDeleted { .. } => {
            return f_groups::handle_groups(engine, peer_fp, peer_pubkey, peer_nick, frame).await;
        }
        SecureFrame::CallInvite { .. }
        | SecureFrame::CallRinging { .. }
        | SecureFrame::CallAccept { .. }
        | SecureFrame::CallReject { .. }
        | SecureFrame::CallEnd { .. }
        | SecureFrame::CallOffer { .. }
        | SecureFrame::CallAnswer { .. }
        | SecureFrame::CallIce { .. }
        | SecureFrame::CallAddParticipant { .. }
        | SecureFrame::CallRoom { .. }
        | SecureFrame::ScreenShareOffer { .. }
        | SecureFrame::ScreenShareAnswer { .. } => {
            return f_calls::handle_calls(engine, peer_fp, peer_pubkey, peer_nick, frame).await;
        }
        SecureFrame::VoiceJoin { .. }
        | SecureFrame::VoiceLeave { .. }
        | SecureFrame::VoiceState { .. } => {
            return f_voice::handle_voice(engine, peer_fp, peer_pubkey, peer_nick, frame).await;
        }
        SecureFrame::FileAnnounce { .. }
        | SecureFrame::FileChunkRequest { .. }
        | SecureFrame::FileChunkData { .. }
        | SecureFrame::FileHave { .. } => {
            return f_files::handle_files(engine, peer_fp, peer_pubkey, peer_nick, frame).await;
        }
        SecureFrame::BuildChallenge { .. }
        | SecureFrame::BuildAttestResponse { .. }
        | SecureFrame::BuildManifestPush { .. }
        | SecureFrame::UpdateHint { .. } => {
            return f_attest::handle_attest(engine, peer_fp, peer_pubkey, peer_nick, frame).await;
        }
        SecureFrame::React { .. }
        | SecureFrame::Reply { .. }
        | SecureFrame::MsgEdit { .. }
        | SecureFrame::MsgDelete { .. }
        | SecureFrame::MsgPin { .. }
        | SecureFrame::Forward { .. }
        | SecureFrame::PresenceSet { .. }
        | SecureFrame::PresencePing { .. }
        | SecureFrame::Typing { .. }
        | SecureFrame::ProfileSet { .. }
        | SecureFrame::ProfileQuery { .. }
        | SecureFrame::ThreadCreate { .. }
        | SecureFrame::ThreadMsg { .. }
        | SecureFrame::MemberBan { .. }
        | SecureFrame::MemberTimeout { .. }
        | SecureFrame::ChannelCfg { .. }
        | SecureFrame::PollCreate { .. }
        | SecureFrame::PollVote { .. }
        | SecureFrame::EventUpsert { .. }
        | SecureFrame::EventInterest { .. }
        | SecureFrame::EmojiUpsert { .. } => {
            return f_social::handle_social(engine, peer_fp, peer_pubkey, peer_nick, frame).await;
        }
        SecureFrame::TunnelOffer { .. }
        | SecureFrame::TunnelAnswer { .. }
        | SecureFrame::TunnelData { .. } => {
            return f_tunnel::handle_tunnel(engine, peer_fp, peer_pubkey, peer_nick, frame).await;
        }
    }
    Ok(())
}
