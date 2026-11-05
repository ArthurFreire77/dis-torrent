//! Execução do CÓDIGO do bot como plugin isolado.
//!
//! O usuário escolhe uma pasta; o `bot.json` pode declarar `run` (ex.:
//! `node bot.js`). O app executa esse programa **como processo filho**, com:
//!
//! - ambiente mínimo (`DISTORRENT_BRIDGE_URL` + `DISTORRENT_BOT_TOKEN`);
//! - diretório de trabalho na própria pasta do bot;
//! - encerramento garantido do processo ao parar o bot ou fechar o app;
//! - saída capturada e mostrada no console do painel.
//!
//! O processo fala com o app **só** pela ponte 127.0.0.1, autenticada. Ele não
//! tem API de arquivo, de banco nem do motor: o que ele pode fazer é o que a
//! ponte expõe. Roda apenas na máquina do dono, como plugin do app.
//!
//! Limite honesto: um processo filho roda com as permissões do usuário do app.
//! A barreira é a API da ponte + o opt-in explícito do dono, não uma sandbox de
//! sistema operacional. No Android não há execução de processo.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

pub const MAX_LINES: usize = 400;
const MAX_LINE: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct PluginLine {
    pub at: i64,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub command: String,
    pub dir: String,
    pub started_at: i64,
    pub exited_code: Option<i32>,
    pub lines: Vec<PluginLine>,
}

struct Running {
    child: Mutex<Option<Child>>,
    stop: AtomicBool,
    pid: u32,
    command: String,
    dir: String,
    started_at: i64,
    code: Mutex<Option<i32>>,
    lines: Mutex<Vec<PluginLine>>,
}

#[derive(Default)]
pub struct Plugins {
    map: Mutex<HashMap<String, Arc<Running>>>,
}

fn push_line(r: &Running, level: &str, message: &str) {
    let msg: String = message.chars().take(MAX_LINE).collect();
    let mut lines = r.lines.lock().unwrap_or_else(|e| e.into_inner());
    if lines.len() >= MAX_LINES {
        lines.remove(0);
    }
    lines.push(PluginLine {
        at: distorrent_core::identity::now_ms(),
        level: level.to_string(),
        message: msg,
    });
}

/// `http://127.0.0.1:1234/b/segredo` → `1234`.
fn port_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|r| r.split('/').next())
        .and_then(|hp| hp.split(':').nth(1))
        .unwrap_or("0")
        .to_string()
}

/// `run` vira argv direto, sem shell: `;`, `&&` e `|` não são interpretados.
fn split_command(run: &str) -> Result<(String, Vec<String>), String> {
    let parts: Vec<String> = run
        .split_whitespace()
        .map(|s| s.trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let Some((prog, args)) = parts.split_first() else {
        return Err("`run` vazio no bot.json".into());
    };
    Ok((prog.clone(), args.to_vec()))
}

impl Plugins {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self, key: &str) -> Option<PluginStatus> {
        let r = self
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()?;
        let code = *r.code.lock().unwrap_or_else(|e| e.into_inner());
        let lines = r.lines.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let running = !r.stop.load(Ordering::Relaxed);
        let (pid, command, dir, started_at) =
            (r.pid, r.command.clone(), r.dir.clone(), r.started_at);
        Some(PluginStatus {
            running,
            pid: Some(pid),
            command,
            dir,
            started_at,
            exited_code: code,
            lines,
        })
    }
    pub fn list(&self) -> Vec<(String, PluginStatus)> {
        let keys: Vec<String> = self
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|k| self.status(&k).map(|s| (k, s)))
            .collect()
    }

    pub fn start(
        &self,
        key: &str,
        dir: &str,
        run: &str,
        bridge_url: &str,
    ) -> Result<PluginStatus, String> {
        if cfg!(target_os = "android") {
            return Err(
                "executar código de bot não existe no Android — use comandos/DSL, que rodam no app"
                    .into(),
            );
        }
        if self
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(key)
        {
            return Err("este bot já está rodando como plugin".into());
        }
        let path = std::path::Path::new(dir);
        if !path.is_dir() {
            return Err(format!("pasta do bot não existe: {dir}"));
        }
        let (prog, args) = split_command(run)?;
        // O programa fica DENTRO da pasta do bot: `run` para fora transformaria
        // "importar bot" em "executar qualquer coisa da máquina".
        let resolved = if std::path::Path::new(&prog).is_absolute() {
            prog.clone()
        } else {
            path.join(&prog).display().to_string()
        };
        let canon_dir = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let canon_prog = std::fs::canonicalize(&resolved)
            .map_err(|_| format!("programa `{prog}` não encontrado na pasta do bot"))?;
        if !canon_prog.starts_with(&canon_dir) {
            return Err("o programa do bot precisa estar dentro da pasta importada".into());
        }

        let mut cmd = Command::new(&canon_prog);
        cmd.args(&args)
            .current_dir(path)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            // O app entrega a URL JÁ AUTENTICADA (com o segredo no caminho).
            // O plugin não tem token para colar, guardar nem vazar.
            .env("DISTORRENT_BOT_URL", bridge_url)
            .env("DISTORRENT_BOT_PORT", port_of(bridge_url))
            .env("DISTORRENT_API", "distorrent-bot/1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Sem janela de console piscando a cada bot iniciado.
            cmd.creation_flags(0x0800_0000);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("não foi possível executar `{prog}`: {e}"))?;
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let running = Arc::new(Running {
            child: Mutex::new(Some(child)),
            stop: AtomicBool::new(false),
            pid,
            command: run.to_string(),
            dir: dir.to_string(),
            started_at: distorrent_core::identity::now_ms(),
            code: Mutex::new(None),
            lines: Mutex::new(Vec::new()),
        });
        push_line(
            &running,
            "info",
            &format!("plugin iniciado: {run} (pid {pid})"),
        );

        if let Some(out) = stdout {
            let r = running.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    push_line(&r, "info", &line);
                }
            });
        }
        if let Some(err) = stderr {
            let r = running.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    push_line(&r, "warn", &line);
                }
            });
        }

        // Monitor de saída: sem isto o painel mostraria "rodando" para sempre.
        let mon = running.clone();
        std::thread::spawn(move || loop {
            if mon.stop.load(Ordering::Relaxed) {
                let mut guard = mon.child.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(mut c) = guard.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                push_line(&mon, "info", "plugin encerrado");
                break;
            }
            let mut done = false;
            {
                let mut guard = mon.child.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(c) = guard.as_mut() {
                    match c.try_wait() {
                        Ok(Some(status)) => {
                            let code = status.code();
                            *mon.code.lock().unwrap_or_else(|e| e.into_inner()) = code;
                            push_line(
                                &mon,
                                "warn",
                                &format!(
                                    "plugin terminou (código {})",
                                    code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
                                ),
                            );
                            *guard = None;
                            mon.stop.store(true, Ordering::SeqCst);
                            done = true;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            push_line(&mon, "error", &format!("monitor: {e}"));
                            done = true;
                        }
                    }
                } else {
                    done = true;
                }
            }
            if done {
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
        });

        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.to_string(), running);
        self.status(key)
            .ok_or_else(|| "plugin não iniciou".to_string())
    }

    pub fn stop(&self, key: &str) -> bool {
        let running = self
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(key);
        let Some(r) = running else {
            return false;
        };
        r.stop.store(true, Ordering::SeqCst);
        let mut guard = r.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut c) = guard.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        true
    }

    pub fn stop_all(&self) {
        let keys: Vec<String> = self
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        for k in keys {
            self.stop(&k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sem `tempfile` (o Cargo.toml proíbe dev-dependencies).
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tempdir() -> TempDir {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "distorrent-plugintest-{}-{}-{n}",
            std::process::id(),
            distorrent_core::identity::now_ms()
        ));
        std::fs::create_dir_all(&dir).expect("tmp");
        TempDir(dir)
    }

    #[test]
    fn run_vazio_e_recusado() {
        assert!(split_command("").is_err());
        assert!(split_command("   ").is_err());
    }

    #[test]
    fn run_nao_interpreta_shell() {
        let (prog, args) = split_command("node bot.js; rm -rf /").unwrap();
        assert_eq!(prog, "node");
        assert_eq!(args, vec!["bot.js;", "rm", "-rf", "/"]);
    }

    #[test]
    fn programa_inexistente_nao_inicia() {
        let p = Plugins::new();
        let dir = tempdir();
        let erro = p
            .start(
                "k",
                &dir.path().display().to_string(),
                "nao-existe.js",
                "http://127.0.0.1:1/b/segredo",
            )
            .unwrap_err();
        assert!(erro.contains("não encontrado"), "{erro}");
    }

    #[test]
    fn programa_fora_da_pasta_nao_inicia() {
        let p = Plugins::new();
        let dir = tempdir();
        let outside = tempdir();
        let script = outside.path().join("evil.js");
        std::fs::write(&script, "// x").unwrap();
        let run = script.display().to_string();
        let erro = p
            .start(
                "k",
                &dir.path().display().to_string(),
                &run,
                "http://127.0.0.1:1/b/segredo",
            )
            .unwrap_err();
        assert!(erro.contains("dentro da pasta"), "{erro}");
    }
}
