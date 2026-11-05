fn main() {
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
