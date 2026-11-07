use std::sync::Arc;

use crate::protocol::SecureFrame;
use crate::{DistorrentError, Result};

use super::{EngineCmd, EngineEvent, NetworkEngine};

pub const ROOM_TTL_MS: i64 = 35_000;

impl NetworkEngine {
    pub fn publish_room(
        &self,
        call_id: &str,
        conv_id: &str,
        kind: &str,
        participants: Vec<String>,
    ) {
        if self
            .room_open(call_id, conv_id, kind, participants.clone())
            .is_empty()
        {
            return;
        }
        self.room_announce(
            conv_id,
            SecureFrame::CallRoom {
                call_id: call_id.to_string(),
                conv_id: conv_id.to_string(),
                kind: kind.to_string(),
                state: "open".into(),
                participants,
                ts: crate::identity::now_ms(),
            },
        );
    }

    pub fn unpublish_room(&self, conv_id: &str) {
        if self.room_close(conv_id).is_empty() {
            return;
        }
        self.room_announce(
            conv_id,
            SecureFrame::CallRoom {
                call_id: String::new(),
                conv_id: conv_id.to_string(),
                kind: String::new(),
                state: "closed".into(),
                participants: Vec::new(),
                ts: crate::identity::now_ms(),
            },
        );
    }

    pub fn leave_room(&self, conv_id: &str) {
        let me = self.identity.fingerprint.clone();
        let Some(room) = ({
            let mut rooms = self.call_rooms.lock().unwrap_or_else(|e| e.into_inner());
            rooms.remove_member(conv_id, &me)
        }) else {
            return;
        };
        if room.participants.is_empty() {
            let _ = self.events.send(EngineEvent::CallRoom {
                call_id: room.call_id,
                conv_id: room.conv_id,
                kind: room.kind,
                state: "closed".into(),
                participants: Vec::new(),
                host_fp: room.host_fp,
            });
            self.room_announce(
                conv_id,
                SecureFrame::CallRoom {
                    call_id: String::new(),
                    conv_id: conv_id.to_string(),
                    kind: String::new(),
                    state: "closed".into(),
                    participants: Vec::new(),
                    ts: crate::identity::now_ms(),
                },
            );
            return;
        }
        let atual = self
            .call_rooms
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(conv_id)
            .cloned()
            .unwrap_or(room);
        let _ = self.events.send(EngineEvent::CallRoom {
            call_id: atual.call_id.clone(),
            conv_id: atual.conv_id.clone(),
            kind: atual.kind.clone(),
            state: "open".into(),
            participants: atual.participants.clone(),
            host_fp: atual.host_fp.clone(),
        });
        self.room_announce(
            conv_id,
            SecureFrame::CallRoom {
                call_id: atual.call_id,
                conv_id: atual.conv_id,
                kind: atual.kind,
                state: "open".into(),
                participants: atual.participants,
                ts: crate::identity::now_ms(),
            },
        );
    }

    pub fn room_join(self: &Arc<Self>, conv_id: &str, kind: &str) -> Result<(String, Vec<String>)> {
        let room = {
            let rooms = self.call_rooms.lock().unwrap_or_else(|e| e.into_inner());
            rooms.get(conv_id).cloned()
        };
        let Some(room) = room else {
            return Err(DistorrentError::Protocol(
                "a chamada encerrou ou ainda não foi anunciada".into(),
            ));
        };
        let host = room.host_fp.clone();
        let mut alvos: Vec<String> = room
            .participants
            .iter()
            .filter(|fp| *fp != &self.identity.fingerprint)
            .cloned()
            .collect();
        if alvos.is_empty() && !host.is_empty() && host != self.identity.fingerprint {
            alvos.push(host);
        }
        if alvos.is_empty() {
            return Err(DistorrentError::Protocol(
                "ninguém na sala para entrar".into(),
            ));
        }
        let _ = kind;
        #[cfg(target_os = "linux")]
        for fp in &alvos {
            self.native_pair_begin(&room.call_id, fp);
        }
        for fp in &alvos {
            let _ = self.store.join_call(&room.call_id, fp);
            self.queue_or_send_call_frame(
                fp,
                SecureFrame::CallAddParticipant {
                    call_id: room.call_id.clone(),
                    fp: self.identity.fingerprint.clone(),
                    kind: String::new(),
                },
            );
        }
        let _ = self
            .store
            .join_call(&room.call_id, &self.identity.fingerprint);
        Ok((room.call_id, alvos))
    }

    fn room_dm_matches(&self, conv_id: &str, peer_fp: &str) -> bool {
        peer_fp != self.identity.fingerprint
            && crate::storage::Store::dm_conversation_id(&self.identity.fingerprint, peer_fp)
                == conv_id
    }

    pub fn room_open(
        &self,
        call_id: &str,
        conv_id: &str,
        kind: &str,
        participants: Vec<String>,
    ) -> Vec<String> {
        if call_id.is_empty() || conv_id.is_empty() {
            return Vec::new();
        }
        let me = self.identity.fingerprint.clone();
        let room = {
            let mut rooms = self.call_rooms.lock().unwrap_or_else(|e| e.into_inner());
            rooms.open(
                call_id,
                conv_id,
                kind,
                &me,
                participants,
                crate::identity::now_ms(),
            )
        };
        let _ = self.events.send(EngineEvent::CallRoom {
            call_id: room.call_id,
            conv_id: room.conv_id,
            kind: room.kind,
            state: "open".into(),
            participants: room.participants,
            host_fp: room.host_fp,
        });
        self.room_targets(conv_id)
    }

    pub fn room_close(&self, conv_id: &str) -> Vec<String> {
        let fechada = {
            let mut rooms = self.call_rooms.lock().unwrap_or_else(|e| e.into_inner());
            rooms.close(conv_id)
        };
        let Some(room) = fechada else {
            return Vec::new();
        };
        let _ = self.events.send(EngineEvent::CallRoom {
            call_id: room.call_id,
            conv_id: room.conv_id,
            kind: room.kind,
            state: "closed".into(),
            participants: Vec::new(),
            host_fp: room.host_fp,
        });
        self.room_targets(conv_id)
    }

    pub fn rooms_snapshot(&self) -> Vec<EngineEvent> {
        let rooms = self
            .call_rooms
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .all();
        rooms
            .into_iter()
            .map(|r| EngineEvent::CallRoom {
                call_id: r.call_id,
                conv_id: r.conv_id,
                kind: r.kind,
                state: "open".into(),
                participants: r.participants,
                host_fp: r.host_fp,
            })
            .collect()
    }

    pub fn room_tick(&self) {
        let me = self.identity.fingerprint.clone();
        let now = crate::identity::now_ms();
        let mine: Vec<(String, String, String, Vec<String>)> = {
            let mut rooms = self.call_rooms.lock().unwrap_or_else(|e| e.into_inner());
            for morta in rooms.reap(ROOM_TTL_MS, now) {
                let _ = self.events.send(EngineEvent::CallRoom {
                    call_id: morta.call_id,
                    conv_id: morta.conv_id,
                    kind: morta.kind,
                    state: "closed".into(),
                    participants: Vec::new(),
                    host_fp: morta.host_fp,
                });
            }
            rooms
                .all()
                .into_iter()
                .filter(|r| r.host_fp == me)
                .map(|r| (r.call_id, r.conv_id, r.kind, r.participants))
                .collect()
        };
        for (call_id, conv_id, kind, participants) in mine {
            self.publish_room(&call_id, &conv_id, &kind, participants);
        }
    }

    pub fn room_targets(&self, conv_id: &str) -> Vec<String> {
        let me = &self.identity.fingerprint;
        let mut out: Vec<String> = self
            .store
            .list_group_members(conv_id)
            .unwrap_or_default()
            .into_iter()
            .map(|(fp, _)| fp)
            .filter(|fp| fp != me)
            .collect();
        if out.is_empty() {
            if let Ok(Some(conv)) = self.store.get_conversation(conv_id) {
                if !conv.peer_fp.is_empty() && &conv.peer_fp != me {
                    out.push(conv.peer_fp);
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    pub fn room_announce(&self, _conv_id: &str, frame: SecureFrame) {
        let conv_id = match &frame {
            SecureFrame::CallRoom { conv_id, .. } => conv_id.clone(),
            _ => return,
        };
        for fp in self.room_targets(&conv_id) {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(fp, frame.clone()))
                .ok();
        }
    }

    pub fn room_receive(
        &self,
        peer_fp: &str,
        call_id: &str,
        conv_id: &str,
        kind: &str,
        state: &str,
        participants: Vec<String>,
    ) {
        if conv_id.is_empty() {
            return;
        }
        let membro = self
            .store
            .list_group_members(conv_id)
            .map(|m| m.iter().any(|(fp, _)| fp == peer_fp))
            .unwrap_or(false)
            || self
                .store
                .get_conversation(conv_id)
                .ok()
                .flatten()
                .map(|c| c.kind == "dm" && (c.peer_fp == peer_fp || c.peer_fp.is_empty()))
                .unwrap_or(false)
            || self.room_dm_matches(conv_id, peer_fp);
        if !membro {
            return;
        }
        let _ = self
            .store
            .ensure_dm_conversation(&self.identity.fingerprint, peer_fp, "");
        if state == "closed" {
            let existe = {
                let rooms = self.call_rooms.lock().unwrap_or_else(|e| e.into_inner());
                rooms.get(conv_id).is_some()
            };
            if existe {
                let pode_fechar = {
                    let rooms = self.call_rooms.lock().unwrap_or_else(|e| e.into_inner());
                    rooms
                        .get(conv_id)
                        .map(|r| {
                            r.host_fp == peer_fp || r.participants.iter().any(|f| f == peer_fp)
                        })
                        .unwrap_or(false)
                };
                if !pode_fechar {
                    return;
                }
            }
            let fechada = {
                let mut rooms = self.call_rooms.lock().unwrap_or_else(|e| e.into_inner());
                rooms.close(conv_id)
            };
            if let Some(room) = fechada {
                let _ = self.events.send(EngineEvent::CallRoom {
                    call_id: room.call_id,
                    conv_id: room.conv_id,
                    kind: room.kind,
                    state: "closed".into(),
                    participants: Vec::new(),
                    host_fp: room.host_fp,
                });
            }
            return;
        }
        let room = {
            let mut rooms = self.call_rooms.lock().unwrap_or_else(|e| e.into_inner());
            rooms.open(
                call_id,
                conv_id,
                kind,
                peer_fp,
                participants,
                crate::identity::now_ms(),
            )
        };
        let _ = self.events.send(EngineEvent::CallRoom {
            call_id: room.call_id,
            conv_id: room.conv_id,
            kind: room.kind,
            state: "open".into(),
            participants: room.participants,
            host_fp: room.host_fp,
        });
    }

    pub fn flush_rooms_to(&self, peer_fp: &str) {
        for room in self
            .call_rooms
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .all()
        {
            let meu = self
                .room_targets(&room.conv_id)
                .iter()
                .any(|fp| fp == peer_fp);
            if !meu {
                continue;
            }
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.to_string(),
                    SecureFrame::CallRoom {
                        call_id: room.call_id,
                        conv_id: room.conv_id,
                        kind: room.kind,
                        state: "open".into(),
                        participants: room.participants,
                        ts: crate::identity::now_ms(),
                    },
                ))
                .ok();
        }
    }

    pub fn room_tick_arc(self: &Arc<Self>) {
        self.room_tick();
    }
}
