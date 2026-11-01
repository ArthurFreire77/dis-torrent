fn main() {
    // PLUGINS ANDROID PRÓPRIOS: precisam ser declarados no build para o Tauri
    // gerar o manifesto ACL deles.
    //
    // Sem isto, `invoke('plugin:callfg|start')` e companhia são REJEITADOS
    // antes de chegar ao Kotlin ("Command plugin:callfg|start not allowed by
    // ACL") — e como o JS engole o erro, o sintoma é mudo: sem foreground
    // service o Android 14+ corta microfone/câmera em segundo plano, o WebView
    // é pausado e a sinalização de chamada congela. Era o "áudio não pega".
    //
    // A checagem é em RUNTIME de propósito: `#[cfg(target_os)]` dentro de um
    // build script é avaliado para o HOST (Windows), não para o alvo Android —
    // os plugins nunca eram declarados e o build seguia com o ACL vazio.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    #[allow(unused_mut)]
    let mut attributes = tauri_build::Attributes::new();

    if target_os == "android" {
        use tauri_build::InlinedPlugin;
        attributes = attributes
            .plugin(
                "callfg",
                InlinedPlugin::new().commands(&["start", "stop", "ringStart", "ringStop"]),
            )
            .plugin(
                "bgservice",
                InlinedPlugin::new().commands(&["start", "stop", "state"]),
            )
            .plugin(
                "callnotif",
                InlinedPlugin::new().commands(&["show", "cancel", "pendingAction"]),
            )
            .plugin(
                "msgnotif",
                InlinedPlugin::new().commands(&["show", "cancel"]),
            )
            .plugin(
                "updater",
                InlinedPlugin::new().commands(&["installApk", "canInstall"]),
            );
    }

    tauri_build::try_build(attributes).expect("falha ao gerar o build script do Tauri");
}
