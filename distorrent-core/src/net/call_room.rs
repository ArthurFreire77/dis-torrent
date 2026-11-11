use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Room {
    pub call_id: String,
    pub conv_id: String,
    pub kind: String,
    pub host_fp: String,
    pub participants: Vec<String>,
    pub updated_ms: i64,
}

#[derive(Debug, Default)]
pub struct Rooms {
    map: HashMap<String, Room>,
}

impl Rooms {
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
                if r.host_fp == publisher_fp {
                    r.participants = participants;
                    // O host saiu da própria lista (fechou o app, saiu da call):
                    // o comando passa para quem ficou. Sem isto a sala ficava
                    // presa num host que não está mais nela — ninguém entrava.
                    if !r.participants.iter().any(|p| p == &r.host_fp) {
                        r.host_fp = r.participants.first().cloned().unwrap_or_default();
                    }
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

    pub fn set_participants(&mut self, conv_id: &str, participants: Vec<String>) {
        if let Some(r) = self.map.get_mut(conv_id) {
            r.participants = participants;
            // Quem era host e não está mais na lista não pode continuar
            // mandando na sala: o comando passa para quem ficou.
            if !r.participants.iter().any(|p| p == &r.host_fp) {
                r.host_fp = r.participants.first().cloned().unwrap_or_default();
            }
            r.updated_ms = crate::identity::now_ms();
        }
    }

    /// Tira um participante e, se ele era o host, passa o comando adiante.
    /// Sem a troca de host a sala fica presa num anúncio que ninguém renova.
    pub fn remove_member(&mut self, conv_id: &str, fp: &str) -> Option<Room> {
        let r = self.map.get_mut(conv_id)?;
        r.participants.retain(|p| p != fp);
        if r.host_fp == fp {
            r.host_fp = r.participants.first().cloned().unwrap_or_default();
        }
        r.updated_ms = crate::identity::now_ms();
        let vazio = r.participants.is_empty();
        let clone = r.clone();
        if vazio {
            self.map.remove(conv_id);
        }
        Some(clone)
    }

    pub fn get(&self, conv_id: &str) -> Option<&Room> {
        self.map.get(conv_id)
    }

    pub fn all(&self) -> Vec<Room> {
        let mut v: Vec<Room> = self.map.values().cloned().collect();
        v.sort_by(|a, b| a.conv_id.cmp(&b.conv_id));
        v
    }

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

    #[test]
    fn set_participants_nao_troca_host_nem_call_id() {
        let mut r = Rooms::default();
        r.open(
            "call-1",
            "conv",
            "voice",
            "host",
            vec!["host".into(), "guest".into()],
            1,
        );
        r.set_participants("conv", vec!["host".into()]);
        let sala = r.get("conv").expect("a sala continua viva");
        assert_eq!(sala.call_id, "call-1", "o id da chamada não muda");
        assert_eq!(sala.host_fp, "host", "o host não muda");
        assert_eq!(sala.participants, vec!["host".to_string()]);
    }

    #[test]
    fn set_participants_em_sala_inexistente_nao_faz_nada() {
        let mut r = Rooms::default();
        r.set_participants("nao-existe", vec!["x".into()]);
        assert!(r.get("nao-existe").is_none());
    }

    #[test]
    fn convidado_sair_tira_ele_da_lista_sem_fechar_a_sala() {
        let mut r = Rooms::default();
        r.open(
            "call-1",
            "conv",
            "voice",
            "host",
            vec!["host".into(), "guest".into()],
            1,
        );
        let depois = r.remove_member("conv", "guest").expect("sala viva");
        assert_eq!(depois.participants, vec!["host".to_string()]);
        assert_eq!(
            depois.host_fp, "host",
            "quem não era host não assume a sala"
        );
        assert!(r.get("conv").is_some(), "ainda tem gente: a sala continua");
    }

    #[test]
    fn sair_o_host_passa_o_comando_para_quem_ficou() {
        let mut r = Rooms::default();
        r.open(
            "call-1",
            "conv",
            "voice",
            "host",
            vec!["host".into(), "guest".into()],
            1,
        );
        let depois = r.remove_member("conv", "host").expect("sala viva");
        assert_eq!(depois.host_fp, "guest", "o comando passa adiante");
        assert_eq!(depois.participants, vec!["guest".to_string()]);
    }

    #[test]
    fn ultimo_sair_fecha_a_sala() {
        let mut r = Rooms::default();
        r.open("call-1", "conv", "voice", "host", vec!["host".into()], 1);
        let depois = r.remove_member("conv", "host").expect("sala existia");
        assert!(depois.participants.is_empty());
        assert!(r.get("conv").is_none(), "sem ninguém a sala precisa fechar");
    }

    #[test]
    fn sair_de_sala_inexistente_nao_cria_nada() {
        let mut r = Rooms::default();
        assert!(r.remove_member("nao-existe", "x").is_none());
        assert!(r.get("nao-existe").is_none());
    }
}
