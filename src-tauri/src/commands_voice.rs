// Comandos Tauri: voice.
// Irmão de lib.rs; o generate_handler! continua lá.

use super::*;

#[tauri::command]
pub(crate) fn call_room_publish(
    call_id: String,
    conv_id: String,
    kind: String,
    participants: Vec<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let e = engine(&state)?;
    e.publish_room(&call_id, &conv_id, &kind, participants);
    Ok(())
}

#[tauri::command]
pub(crate) fn call_room_close(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.unpublish_room(&conv_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn call_room_leave(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.leave_room(&conv_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn call_room_join(
    conv_id: String,
    kind: String,
    state: State<AppState>,
) -> Result<(String, Vec<String>), String> {
    engine(&state)?.room_join(&conv_id, &kind).map_err(err)
}

#[tauri::command]
pub(crate) fn call_rooms_list(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let e = engine(&state)?;
    let mut out = Vec::new();
    for ev in e.rooms_snapshot() {
        if let distorrent_core::EngineEvent::CallRoom {
            call_id,
            conv_id,
            kind,
            state,
            participants,
            host_fp,
        } = ev
        {
            out.push(serde_json::json!({
                "call_id": call_id,
                "conv_id": conv_id,
                "kind": kind,
                "state": state,
                "participants": participants,
                "host_fp": host_fp,
            }));
        }
    }
    Ok(out)
}

#[tauri::command]
pub(crate) async fn call_invite(
    target_fp: String,
    kind: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let e = engine(&state)?;
    tauri::async_runtime::spawn_blocking(move || e.call_invite(&target_fp, &kind))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
pub(crate) async fn call_accept(
    call_id: String,
    from_fp: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let e = engine(&state)?;
    let e2 = e.clone();
    let (cid, fp) = (call_id.clone(), from_fp.clone());
    tauri::async_runtime::spawn_blocking(move || e.call_accept(&cid, &fp))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)?;
    e2.resume_held_call(&call_id, &from_fp).await;
    Ok(())
}

#[tauri::command]
pub(crate) fn call_ring_retry(
    call_id: String,
    target_fp: String,
    kind: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_ring_retry(&call_id, &target_fp, &kind)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn call_reject(
    call_id: String,
    from_fp: String,
    reason: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_reject(&call_id, &from_fp, &reason)
        .map_err(err)
}

#[tauri::command]
pub(crate) async fn call_end(call_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let e = engine(&state)?;
    tauri::async_runtime::spawn_blocking(move || e.call_end(&call_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
pub(crate) fn call_offer(
    target_fp: String,
    call_id: String,
    sdp: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_signal(
            &target_fp,
            distorrent_core::protocol::SecureFrame::CallOffer { call_id, sdp },
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn call_answer(
    target_fp: String,
    call_id: String,
    sdp: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_signal(
            &target_fp,
            distorrent_core::protocol::SecureFrame::CallAnswer { call_id, sdp },
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn call_ice(
    target_fp: String,
    call_id: String,
    candidate: String,
    mid: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_signal(
            &target_fp,
            distorrent_core::protocol::SecureFrame::CallIce {
                call_id,
                candidate,
                mid,
            },
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn call_add_participant(
    target_fp: String,
    call_id: String,
    fp: String,
    kind: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_add_participant(&target_fp, &call_id, &fp, kind.as_deref().unwrap_or(""))
        .map_err(err)
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_media_available(state: State<AppState>) -> Result<bool, String> {
    match state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        Some(e) => Ok(e.voice_media_available()),
        None => Ok(distorrent_core::net::engine::native_voice_capable()),
    }
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_media_stats(
    call_id: String,
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    match engine(&state)?.voice_media_stats(&call_id) {
        Some(s) => serde_json::to_value(s).map_err(|e| e.to_string()),
        None => Ok(serde_json::Value::Null),
    }
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_set_muted(
    call_id: String,
    muted: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.voice_set_muted(&call_id, muted);
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_hangup(call_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.voice_hangup(&call_id);
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_set_deafened(
    call_id: String,
    deafened: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.voice_set_deafened(&call_id, deafened);
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_video_start(
    call_id: String,
    peer_fp: String,
    source: String,
    monitor_id: Option<u32>,
    state: State<AppState>,
) -> Result<String, String> {
    let e = engine(&state)?;
    let Some(v) = e.voice() else {
        return Err("mídia nativa indisponível (voz nativa desligada?)".into());
    };
    v.video_start(&call_id, &peer_fp, &source, monitor_id)
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_video_stop(
    call_id: String,
    peer_fp: String,
    state: State<AppState>,
) -> Result<(), String> {
    let e = engine(&state)?;
    if let Some(v) = e.voice() {
        v.video_stop(&call_id, &peer_fp);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_video_frame(
    call_id: String,
    peer_fp: String,
    since_seq: Option<u64>,
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    let e = engine(&state)?;
    let Some(v) = e.voice() else {
        return Ok(serde_json::Value::Null);
    };
    match v.video_frame(&call_id, &peer_fp) {
        Some(f) => {
            if let Some(since) = since_seq {
                if f.seq <= since {
                    return Ok(serde_json::json!({ "seq": f.seq, "w": f.w, "h": f.h }));
                }
            }
            let b64 = {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(&f.jpeg)
            };
            Ok(serde_json::json!({ "jpeg": b64, "w": f.w, "h": f.h, "seq": f.seq }))
        }
        None => Ok(serde_json::Value::Null),
    }
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_media_available(_state: State<AppState>) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_media_stats(
    _call_id: String,
    _state: State<AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::Value::Null)
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_set_muted(
    _call_id: String,
    _muted: bool,
    _state: State<AppState>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_hangup(_call_id: String, _state: State<AppState>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_set_deafened(
    _call_id: String,
    _deafened: bool,
    _state: State<AppState>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_video_start(
    _call_id: String,
    _peer_fp: String,
    _source: String,
    _monitor_id: Option<u32>,
    _state: State<AppState>,
) -> Result<String, String> {
    Err("vídeo nativo indisponível nesta plataforma".into())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_video_stop(
    _call_id: String,
    _peer_fp: String,
    _state: State<AppState>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_video_frame(
    _call_id: String,
    _peer_fp: String,
    _since_seq: Option<u64>,
    _state: State<AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::Value::Null)
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_mic_test_start(state: State<AppState>) -> Result<u64, String> {
    engine(&state)?
        .voice_mic_test_start()
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_mic_test_level(test_id: u64, state: State<AppState>) -> Result<f32, String> {
    Ok(engine(&state)?.voice_mic_test_level(test_id))
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_mic_test_stop(test_id: u64, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.voice_mic_test_stop(test_id);
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) fn voice_mic_name(state: State<AppState>) -> Result<String, String> {
    Ok(engine(&state)?.voice_mic_name())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_mic_test_start(_state: State<AppState>) -> Result<u64, String> {
    Err("teste de mic nativo indisponível nesta plataforma".into())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_mic_test_level(_test_id: u64, _state: State<AppState>) -> Result<f32, String> {
    Ok(0.0)
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_mic_test_stop(_test_id: u64, _state: State<AppState>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn voice_mic_name(_state: State<AppState>) -> Result<String, String> {
    Ok(String::new())
}

#[tauri::command]
pub(crate) async fn voice_join(
    community_id: String,
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let e = engine(&state)?;
    tauri::async_runtime::spawn_blocking(move || e.voice_join(&community_id, &channel_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
pub(crate) async fn voice_leave(
    community_id: String,
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let e = engine(&state)?;
    tauri::async_runtime::spawn_blocking(move || e.voice_leave(&community_id, &channel_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
pub(crate) fn voice_state(
    community_id: String,
    channel_id: String,
    muted: bool,
    deafened: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .voice_state_update(&community_id, &channel_id, muted, deafened)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn voice_states(
    community_id: String,
    channel_id: String,
    state: State<AppState>,
) -> Result<Vec<(String, bool, bool)>, String> {
    Ok(engine(&state)?.list_voice_states(&community_id, &channel_id))
}
