#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

//! FORGE shell — entrada desktop.
//!
//! Toda a app (commands, engine, storage) vive em `forge_lib` (lib.rs) e é
//! compartilhada entre desktop e mobile. Antes disto, main.rs duplicava a
//! superfície de commands inteira e ficou para trás sem os commands novos de
//! canais/cargos/bots (channel_*, role_*, bot_*, member_*, community_rename) —
//! o binário desktop respondia "command not found" para todos eles.

fn main() {
    forge_lib::run();
}
