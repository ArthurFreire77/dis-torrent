// Diagnóstico e liberação do firewall do Windows.
//
// POR QUE EXISTE: sem regra de ENTRADA, o Windows descarta as conexões TCP e os
// datagramas UDP de descoberta que chegam de outro PC. O sintoma relatado foi
// exatamente esse: dois PCs na MESMA rede não se acham, mas o Discord conecta
// (ele já tem a regra). Instalação por usuário (PrivilegesRequired=lowest) não
// dispara o prompt "permitir acesso à rede", então a regra tem de existir.
//
// HONESTIDADE: `netsh` exige administrador para criar regra. Quando falha,
// devolvemos o motivo real para a UI — nada de "liberado" falso.

#[derive(Debug, serde::Serialize, Clone)]
pub struct FirewallStatus {
    /// Existe regra de entrada liberando o executável atual.
    pub allowed: bool,
    /// Perfil de rede detectado: `domain` | `private` | `public` | `unknown`.
    pub profile: String,
    /// Caminho do executável que o Windows vê conectando.
    pub program: String,
    /// Por que não foi possível liberar (quando `allowed` é falso).
    pub reason: Option<String>,
}

#[cfg(target_os = "windows")]
fn run_netsh(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("netsh")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

/// Perfil ativo da rede principal (o que decide se a regra de entrada vale).
#[cfg(target_os = "windows")]
fn active_profile() -> String {
    let out = match run_netsh(&["advfirewall", "show", "currentprofile"]) {
        Ok(o) => o,
        Err(_) => return "unknown".into(),
    };
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    if text.contains("perfil do domínio") || text.contains("domain profile") {
        "domain".into()
    } else if text.contains("perfil particular") || text.contains("private profile") {
        "private".into()
    } else if text.contains("perfil público") || text.contains("public profile") {
        "public".into()
    } else {
        "unknown".into()
    }
}

#[cfg(target_os = "windows")]
fn rule_exists(program: &str) -> bool {
    let out = match run_netsh(&[
        "advfirewall",
        "firewall",
        "show",
        "rule",
        "name=all",
        "dir=in",
    ]) {
        Ok(o) => o,
        Err(_) => return false,
    };
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    let alvo = program.to_lowercase();
    // A saída vem em português OU inglês conforme o Windows; o caminho do
    // programa aparece igual nos dois.
    text.contains(&alvo) && (text.contains("permitir") || text.contains("allow"))
}

#[cfg(target_os = "windows")]
fn current_exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn network_firewall_status() -> FirewallStatus {
    #[cfg(target_os = "windows")]
    {
        let program = current_exe_path();
        FirewallStatus {
            allowed: !program.is_empty() && rule_exists(&program),
            profile: active_profile(),
            program,
            reason: None,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Linux/macOS: não há firewall por executável que dê para medir aqui.
        // Não inventamos um estado.
        FirewallStatus {
            allowed: true,
            profile: "unknown".into(),
            program: String::new(),
            reason: None,
        }
    }
}

#[cfg(target_os = "windows")]
fn netsh_tem_admin() -> bool {
    // `net session` só responde para administrador. Perguntar primeiro evita
    // pedir elevação à toa e permite gerar a receita de `RunAs` correta.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("net")
        .arg("session")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Programa que abre o Firewall do Windows na tela de exceções: o usuário
/// clica "Permitir" e a regra passa a valer SEM o app pedir administrador.
#[cfg(target_os = "windows")]
fn abrir_console_firewall() -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("control")
        .arg("/name")
        .arg("Microsoft.WindowsFirewall")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

#[tauri::command]
pub fn network_firmware_open_firewall() -> FirewallStatus {
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = abrir_console_firewall() {
            let mut s = network_firewall_status();
            s.reason = Some(format!(
                "não consegui abrir o Firewall do Windows ({e}). Abra à mão: Painel de Controle → Firewall do Windows Defender → Permitir um aplicativo"
            ));
            return s;
        }
        network_firewall_status()
    }
    #[cfg(not(target_os = "windows"))]
    {
        network_firewall_status()
    }
}

#[tauri::command]
pub fn network_firewall_allow() -> FirewallStatus {
    #[cfg(target_os = "windows")]
    {
        let program = current_exe_path();
        if program.is_empty() {
            return FirewallStatus {
                allowed: false,
                profile: active_profile(),
                program,
                reason: Some("não consegui descobrir o caminho do executável".into()),
            };
        }
        let mut last_err: Option<String> = None;
        let admin = netsh_tem_admin();
        if !admin {
            // Sem elevação o `netsh add` sempre falha. Mensagem honesta com o
            // caminho que funciona sem UAC (a tela do Firewall do Windows).
            let status = network_firewall_status();
            return FirewallStatus {
                reason: Some(
                    "precisa de administrador para criar a regra automaticamente. \
                     Use «Abrir Firewall do Windows» e marque o DisTorrent em \
                     «Permitir um aplicativo»."
                        .into(),
                ),
                ..status
            };
        }
        for proto in ["TCP", "UDP"] {
            let rule = format!("DisTorrent {proto}");
            let program_arg = format!("program={program}");
            // `delete` primeiro para a regra velha (caminho antigo) não sombrear.
            let _ = run_netsh(&[
                "advfirewall",
                "firewall",
                "delete",
                "rule",
                &format!("name={rule}"),
            ]);
            let args = [
                "advfirewall",
                "firewall",
                "add",
                "rule",
                &format!("name={rule}"),
                "dir=in",
                "action=allow",
                &program_arg,
                &format!("protocol={proto}"),
                "enable=yes",
                "profile=any",
            ];
            match run_netsh(&args) {
                Ok(o) if o.status.success() => {}
                Ok(o) => {
                    let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    last_err = Some(if msg.is_empty() {
                        "o Windows recusou a regra (precisa de administrador)".into()
                    } else {
                        msg
                    });
                }
                Err(e) => last_err = Some(e.to_string()),
            }
        }
        let status = network_firewall_status();
        if status.allowed {
            return status;
        }
        FirewallStatus {
            reason: Some(last_err.unwrap_or_else(|| {
                "a regra não aparece depois de criada — abra o Firewall do Windows e permita o DisTorrent".into()
            })),
            ..status
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        network_firewall_status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_tem_os_campos_que_a_ui_usa() {
        let s = network_firewall_status();
        assert!(!s.profile.is_empty(), "a UI mostra o perfil");
        #[cfg(target_os = "windows")]
        assert!(
            !s.program.is_empty(),
            "sem caminho não dá para conferir regra"
        );
    }
}
