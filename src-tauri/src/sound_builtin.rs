//! Efeitos sonoros embutidos no binário, com procedência e licença registradas.
//!
//! POR QUE embutir: o app precisa dos efeitos em qualquer servidor e sem
//! internet no primeiro uso. Os arquivos ficam em `src-tauri/sounds/` e o
//! `SOURCES.json` (gerado por `scripts/fetch-sounds.ps1`) guarda autor e
//! licença — nenhum som sem licença registrada entra aqui, e um teste confere.

use base64::{engine::general_purpose, Engine as _};

/// Um efeito embutido. O áudio vem de `include_bytes!`, então não há leitura de
/// disco nem download em runtime.
pub struct Builtin {
    pub id: &'static str,
    pub name: &'static str,
    pub ext: &'static str,
    pub bytes: &'static [u8],
    /// Licença curta para a UI mostrar ao lado do efeito.
    pub license: &'static str,
}

/// Catálogo fixo. A ordem é a que aparece primeiro na grade do painel.
pub const BUILTINS: &[Builtin] = &[
    Builtin {
        id: "builtin:applause",
        name: "Aplausos",
        ext: "ogg",
        bytes: include_bytes!("../sounds/applause.ogg"),
        license: "domínio público",
    },
    Builtin {
        id: "builtin:clapping",
        name: "Palmas",
        ext: "ogg",
        bytes: include_bytes!("../sounds/clapping.ogg"),
        license: "domínio público",
    },
    Builtin {
        id: "builtin:rimshot",
        name: "Rimshot",
        ext: "wav",
        bytes: include_bytes!("../sounds/rimshot.wav"),
        license: "CC BY 3.0 (Kevin MacLeod)",
    },
    Builtin {
        id: "builtin:coin",
        name: "Moeda",
        ext: "mp3",
        bytes: include_bytes!("../sounds/coin.mp3"),
        license: "CC BY 4.0 (Gravity Sound)",
    },
    Builtin {
        id: "builtin:airhorn",
        name: "Buzina",
        ext: "ogg",
        bytes: include_bytes!("../sounds/airhorn.ogg"),
        license: "CC BY 4.0",
    },
];

pub fn find(id: &str) -> Option<&'static Builtin> {
    BUILTINS.iter().find(|b| b.id == id)
}

/// Bytes do efeito, já decodificados do recurso embutido.
pub fn bytes(id: &str) -> Option<&'static [u8]> {
    find(id).map(|b| b.bytes)
}

/// Base64 para o frontend montar o AudioBuffer (mesma rota dos sons do usuário).
pub fn bytes_b64(id: &str) -> Option<String> {
    bytes(id).map(|b| general_purpose::STANDARD.encode(b))
}

pub fn is_builtin(id: &str) -> bool {
    id.starts_with("builtin:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todo_embutido_tem_audio_e_licenca() {
        for b in BUILTINS {
            assert!(b.bytes.len() > 1000, "{} está vazio", b.id);
            assert!(!b.license.trim().is_empty(), "{} sem licença", b.id);
            assert!(
                b.bytes.len() <= 2 * 1024 * 1024,
                "{} passa do teto de som ({} bytes)",
                b.id,
                b.bytes.len()
            );
        }
    }

    #[test]
    fn magic_bytes_sao_de_audio() {
        for b in BUILTINS {
            let ok = match b.ext {
                "ogg" => &b.bytes[0..4] == b"OggS",
                "wav" => &b.bytes[0..4] == b"RIFF",
                "mp3" => &b.bytes[0..3] == b"ID3" || (b.bytes[0] == 0xFF && (b.bytes[1] & 0xE0) == 0xE0),
                other => panic!("extensão inesperada: {other}"),
            };
            assert!(ok, "{} não tem magic bytes de {}", b.id, b.ext);
        }
    }

    #[test]
    fn id_desconhecido_nao_inventa_audio() {
        assert!(bytes("builtin:nao-existe").is_none());
        assert!(bytes("snd-123").is_none());
        assert!(!is_builtin("snd-123"));
        assert!(is_builtin("builtin:coin"));
    }

    #[test]
    fn sources_json_registra_licenca_de_cada_arquivo() {
        let raw = include_str!("../sounds/SOURCES.json");
        let lista: serde_json::Value = serde_json::from_str(raw).expect("SOURCES.json inválido");
        let arr = lista.as_array().expect("SOURCES.json precisa ser uma lista");
        for b in BUILTINS {
            let nome = b.id.trim_start_matches("builtin:");
            let achou = arr.iter().any(|e| {
                e.get("file")
                    .and_then(|f| f.as_str())
                    .map(|f| f.starts_with(nome))
                    .unwrap_or(false)
            });
            assert!(achou, "SOURCES.json não registra o arquivo de {}", b.id);
        }
        for e in arr {
            let lic = e.get("license").and_then(|l| l.as_str()).unwrap_or("");
            assert!(
                lic.starts_with("CC0") || lic.starts_with("CC BY") || lic.starts_with("Public domain"),
                "licença não permitida: {lic}"
            );
            assert!(
                e.get("artist").and_then(|a| a.as_str()).map(|a| !a.is_empty()).unwrap_or(false),
                "autor ausente: {e:?}"
            );
        }
    }
}
