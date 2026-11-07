// Comandos Tauri: social.
// Irmão de lib.rs; o generate_handler! continua lá.

use super::*;

#[tauri::command]
pub(crate) fn friend_request(
    peer_fp: String,
    state: State<AppState>,
) -> Result<distorrent_core::net::engine::FriendOutcome, String> {
    let outcome = engine(&state)?.friend_request(&peer_fp).map_err(err)?;
    Ok(outcome)
}

#[tauri::command]
pub(crate) fn friend_respond(
    peer_fp: String,
    accept: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .friend_respond(peer_fp.trim(), accept)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn friend_remove(peer_fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.friend_remove(peer_fp.trim()).map_err(err)
}

#[tauri::command]
pub(crate) fn friend_block(peer_fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.friend_block(peer_fp.trim()).map_err(err)
}

#[tauri::command]
pub(crate) fn friend_unblock(peer_fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.friend_unblock(peer_fp.trim()).map_err(err)
}

#[tauri::command]
pub(crate) fn messages_list(
    conv_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::StoredMessage>, String> {
    Ok(engine(&state)?.messages(&conv_id))
}

#[tauri::command]
pub(crate) fn message_send(
    conv_id: String,
    body: String,
    state: State<AppState>,
) -> Result<distorrent_core::storage::StoredMessage, String> {
    if body.trim().is_empty() {
        return Err("mensagem vazia".into());
    }
    engine(&state)?.send_dm(&conv_id, body.trim()).map_err(err)
}

#[tauri::command]
pub(crate) fn message_resend(
    msg_id: String,
    state: State<AppState>,
) -> Result<distorrent_core::storage::StoredMessage, String> {
    engine(&state)?.resend_message(&msg_id).map_err(err)
}

#[tauri::command]
pub(crate) fn social_react(
    conv_id: String,
    msg_id: String,
    emoji: String,
    state: State<AppState>,
) -> Result<bool, String> {
    engine(&state)?
        .social_react(&conv_id, &msg_id, &emoji)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn social_reactions(
    msg_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::ReactionSummary>, String> {
    let store = open_store(&state)?;
    let rows = store.reactions_for_msg(&msg_id).map_err(err)?;
    Ok(store.mark_reactions_mine(rows, &identity_fp(&state)))
}

#[tauri::command]
pub(crate) fn social_reactions_bulk(
    msg_ids: Vec<String>,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::ReactionSummary>, String> {
    let store = open_store(&state)?;
    let rows = store.reactions_for_msgs(&msg_ids).map_err(err)?;
    Ok(store.mark_reactions_mine(rows, &identity_fp(&state)))
}

#[tauri::command]
pub(crate) fn social_reply(
    conv_id: String,
    msg_id: String,
    reply_to: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_reply(&conv_id, &msg_id, &reply_to)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn social_edit(
    conv_id: String,
    msg_id: String,
    body: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_edit(&conv_id, &msg_id, &body)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn social_delete(
    conv_id: String,
    msg_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_delete(&conv_id, &msg_id)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn social_pin(
    conv_id: String,
    msg_id: String,
    pinned: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_pin(&conv_id, &msg_id, pinned)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn social_pins(
    conv_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::MsgMetaView>, String> {
    open_store(&state)?.pins_list(&conv_id).map_err(err)
}

#[tauri::command]
pub(crate) fn social_meta_bulk(
    msg_ids: Vec<String>,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::MsgMetaView>, String> {
    open_store(&state)?.msg_meta_bulk(&msg_ids).map_err(err)
}

#[tauri::command]
pub(crate) fn social_bodies(
    msg_ids: Vec<String>,
    state: State<AppState>,
) -> Result<Vec<(String, String)>, String> {
    let store = open_store(&state)?;
    let mut out = Vec::new();
    for id in msg_ids {
        if let Some(m) = store.message_by_id(&id).map_err(err)? {
            let body = store.effective_body(&id, &m.body).map_err(err)?;
            out.push((id, body));
        }
    }
    Ok(out)
}

#[tauri::command]
pub(crate) fn social_forward(
    src_msg_id: String,
    target_conv: String,
    target_channel: String,
    from_label: String,
    state: State<AppState>,
) -> Result<StoredMessage, String> {
    engine(&state)?
        .social_forward(&src_msg_id, &target_conv, &target_channel, &from_label)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn read_set(conv_id: String, ts: i64, state: State<AppState>) -> Result<(), String> {
    let st = open_store(&state)?;
    st.read_set(&conv_id, ts).map_err(err)?;
    let fp = identity_fp(&state);
    st.conv_read_set(&conv_id, &fp, ts).map_err(err)?;
    if let Ok(e) = engine(&state) {
        e.notify_read(&conv_id, ts);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn read_all(
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::ReadCursor>, String> {
    open_store(&state)?.read_all().map_err(err)
}

#[tauri::command]
pub(crate) fn presence_set(
    status: String,
    custom: String,
    custom_emoji: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_presence_set(&status, &custom, &custom_emoji)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn presence_list(
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::PresenceView>, String> {
    open_store(&state)?.presence_list().map_err(err)
}

#[tauri::command]
pub(crate) fn presence_get(
    fp: String,
    state: State<AppState>,
) -> Result<distorrent_core::social::PresenceView, String> {
    open_store(&state)?.presence_get(&fp).map_err(err)
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) fn profile_set(
    display_name: String,
    about: String,
    avatar_b64: String,
    banner_b64: String,
    accent: String,
    remove_avatar: Option<bool>,
    remove_banner: Option<bool>,
    state: State<AppState>,
) -> Result<distorrent_core::social::ProfileView, String> {
    engine(&state)?
        .social_profile_set_full(
            &display_name,
            &about,
            &avatar_b64,
            &banner_b64,
            &accent,
            remove_avatar.unwrap_or(false),
            remove_banner.unwrap_or(false),
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn profile_sync_now(state: State<AppState>) -> Result<(), String> {
    engine(&state)?.sync_profiles_with_peers();
    Ok(())
}

#[tauri::command]
pub(crate) fn profile_get(
    fp: String,
    state: State<AppState>,
) -> Result<distorrent_core::social::ProfileView, String> {
    open_store(&state)?.profile_get(&fp).map_err(err)
}

#[tauri::command]
pub(crate) fn profile_list(
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::ProfileView>, String> {
    open_store(&state)?.profile_list().map_err(err)
}

#[tauri::command]
pub(crate) fn nickname_set(
    community_id: String,
    fp: String,
    nickname: String,
    state: State<AppState>,
) -> Result<(), String> {
    open_store(&state)?
        .nickname_set(&community_id, &fp, &nickname)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn nickname_get(
    community_id: String,
    fp: String,
    state: State<AppState>,
) -> Result<String, String> {
    open_store(&state)?
        .nickname_get(&community_id, &fp)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn message_search(
    mut q: distorrent_core::social::SearchQuery,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::SearchHit>, String> {
    if q.me.is_empty() {
        q.me = identity_fp(&state);
    }
    open_store(&state)?.message_search(&q).map_err(err)
}

#[tauri::command]
pub(crate) fn messages_around(
    conv_id: String,
    ts: i64,
    limit: i64,
    state: State<AppState>,
) -> Result<Vec<StoredMessage>, String> {
    open_store(&state)?
        .messages_around(&conv_id, ts, limit)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn message_receipts(
    msg_ids: Vec<String>,
    state: State<AppState>,
) -> Result<Vec<(String, String, i64)>, String> {
    open_store(&state)?.receipts_for(&msg_ids).map_err(err)
}

#[tauri::command]
pub(crate) fn thread_create(
    community_id: String,
    parent_channel: String,
    name: String,
    kind: String,
    tags: String,
    state: State<AppState>,
) -> Result<distorrent_core::social::ThreadRow, String> {
    engine(&state)?
        .social_thread_create(&community_id, &parent_channel, &name, &kind, &tags)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn thread_list(
    community_id: String,
    parent: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::ThreadRow>, String> {
    open_store(&state)?
        .threads_list(&community_id, &parent)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn thread_messages(
    thread_id: String,
    limit: i64,
    state: State<AppState>,
) -> Result<Vec<StoredMessage>, String> {
    open_store(&state)?
        .list_messages_thread(&thread_id, limit)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn thread_send(
    community_id: String,
    thread_id: String,
    body: String,
    state: State<AppState>,
) -> Result<StoredMessage, String> {
    engine(&state)?
        .social_thread_send(&community_id, &thread_id, &body)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn thread_archive(
    thread_id: String,
    archived: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_thread_archive(&thread_id, archived)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn poll_create(
    community_id: String,
    channel_id: String,
    question: String,
    options: Vec<String>,
    multi: bool,
    ends_at: i64,
    state: State<AppState>,
) -> Result<distorrent_core::social::PollRow, String> {
    engine(&state)?
        .social_poll_create(
            &community_id,
            &channel_id,
            &question,
            options,
            multi,
            ends_at,
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn poll_list(
    community_id: String,
    channel_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::PollRow>, String> {
    open_store(&state)?
        .poll_list(&community_id, &channel_id)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn poll_vote(
    community_id: String,
    channel_id: String,
    poll_id: String,
    option_idx: i64,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_poll_vote(&community_id, &channel_id, &poll_id, option_idx)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn poll_tally(
    poll_id: String,
    state: State<AppState>,
) -> Result<(Vec<i64>, i64, Vec<i64>), String> {
    let store = open_store(&state)?;
    let (counts, total) = store.poll_tally(&poll_id).map_err(err)?;
    let mine = store
        .poll_my_votes(&poll_id, &identity_fp(&state))
        .map_err(err)?;
    Ok((counts, total, mine))
}

#[tauri::command]
pub(crate) fn event_upsert(
    ev: distorrent_core::social::EventRow,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.social_event_upsert(ev).map_err(err)
}

#[tauri::command]
pub(crate) fn event_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::EventRow>, String> {
    open_store(&state)?.event_list(&community_id).map_err(err)
}

#[tauri::command]
pub(crate) fn event_interest(
    community_id: String,
    event_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_event_interest(&community_id, &event_id)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn event_delete(
    community_id: String,
    event_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_event_delete(&community_id, &event_id)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn emoji_upsert(
    e: distorrent_core::social::EmojiRow,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.social_emoji_upsert(e).map_err(err)
}

#[tauri::command]
pub(crate) fn emoji_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::EmojiRow>, String> {
    open_store(&state)?.emoji_list(&community_id).map_err(err)
}

#[tauri::command]
pub(crate) fn emoji_delete(
    community_id: String,
    id: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_emoji_delete(&community_id, &id)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bookmark_set(
    conv_id: String,
    name: String,
    payload: String,
    state: State<AppState>,
) -> Result<(), String> {
    open_store(&state)?
        .bookmark_set(&conv_id, &name, &payload)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bookmark_list(
    conv_id: String,
    state: State<AppState>,
) -> Result<Vec<(String, String)>, String> {
    open_store(&state)?.bookmark_list(&conv_id).map_err(err)
}

#[tauri::command]
pub(crate) fn messages_window(
    conv_id: String,
    before_ts: Option<i64>,
    limit: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<StoredMessage>, String> {
    engine(&state)?
        .messages_window(
            conv_id.trim(),
            before_ts,
            limit.unwrap_or(100).clamp(1, 1000),
        )
        .map_err(err)
}
