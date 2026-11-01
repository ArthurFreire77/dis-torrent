// Salas de chamada anunciadas (grupo/DM).
// O `CallInvite` só chega a quem foi chamado; esta sala é anunciada para toda
// a conversa, para os outros verem a chamada e poderem entrar.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Room {
    pub call_id: String,
    pub conv_id: String,
    pub kind: String,
    /// Quem publicou; não troca enquanto a sala viver.
    pub host_fp: String,
    pub participants: Vec<String>,
    pub updated_ms: i64,
}

#[derive(Debug, Default)]
pub struct Rooms {
    map: HashMap<String, Room>,
}

impl Rooms {
    /// Abre/atualiza. A primeira publicação define o host, e só ele atualiza
    /// a lista de participantes.
    pub fn open(
        &mut self,
        call_id: &str,
        conv_id: &str,
        kind: &str,
        publisher_fp: &str,
        participants: Vec<String>,
        now_ms: i64,
    ) -> Room {
        match self.map.get_mut(conv_id) {
            Some(r) if r.call_id == call_id => {
                // Só o HOST renova o TTL. Antes qualquer publish renovava: com
                // o host morto, os joiners mantinham a sala viva para sempre e
                // o "Entrar" aparecia numa chamada que não existe mais.
                if r.host_fp == publisher_fp {
                    r.participants = participants;
                    r.updated_ms = now_ms;
                }
                r.clone()
            }
            _ => {
                let r = Room {
                    call_id: call_id.to_string(),
                    conv_id: conv_id.to_string(),
                    kind: kind.to_string(),
                    host_fp: publisher_fp.to_string(),
                    participants,
                    updated_ms: now_ms,
                };
                self.map.insert(conv_id.to_string(), r.clone());
                r
            }
        }
    }

    pub fn close(&mut self, conv_id: &str) -> Option<Room> {
        self.map.remove(conv_id)
    }

    pub fn get(&self, conv_id: &str) -> Option<&Room> {
        self.map.get(conv_id)
    }

    pub fn all(&self) -> Vec<Room> {
        let mut v: Vec<Room> = self.map.values().cloned().collect();
        v.sort_by(|a, b| a.conv_id.cmp(&b.conv_id));
        v
    }

    /// Fecha salas sem renovação (peer caiu sem mandar `closed`).
    pub fn reap(&mut self, older_than_ms: i64, now_ms: i64) -> Vec<Room> {
        let dead: Vec<String> = self
            .map
            .values()
            .filter(|r| now_ms - r.updated_ms > older_than_ms)
            .map(|r| r.conv_id.clone())
            .collect();
        dead.iter().filter_map(|c| self.close(c)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_nao_troca_na_segunda_publicacao() {
        let mut r = Rooms::default();
        r.open("c1", "conv", "voice", "host", vec!["host".into()], 1);
        let depois = r.open("c1", "conv", "voice", "outro", vec!["outro".into()], 2);
        assert_eq!(depois.host_fp, "host");
        assert_eq!(depois.participants, vec!["host".to_string()]);
    }

    #[test]
    fn reap_fecha_sala_sem_renovacao() {
        let mut r = Rooms::default();
        r.open("c1", "conv", "voice", "host", vec![], 1000);
        assert!(r.reap(500, 1400).is_empty());
        assert_eq!(r.reap(500, 1600).len(), 1);
        assert!(r.get("conv").is_none());
    }
}
