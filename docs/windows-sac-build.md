# Build local bloqueado pelo Controle de Aplicativo do Windows (SAC/WDAC)

## Sintoma

`cargo check`, `cargo test`, `cargo fmt` e `cargo build` falham no Windows com:

```
error: failed to run custom build command for `zerocopy v0.8.56`
Caused by: could not execute process `...\build-script-build.exe` (never executed)
Caused by: Uma política de Controle de Aplicativo bloqueou este arquivo. (os error 4551)
```

e, mais adiante:

```
error[E0463]: can't find crate for `thiserror_impl`
```

O erro **não** é do código nem do Defender "demorando". É o **Controle de
Aplicativo (Smart App Control / WDAC)** — política `{0283AC0F-FFF1-49AE-ADA1-8A933130CAD6}`,
ver `CiPolicies\Active` — bloqueando executáveis e DLLs recém-gerados pelo
`cargo` dentro de `target/`.

## Prova rápida

- `rustc` compilando um `.exe` novo em `target/` → **executa normal**
- um `build-script-build.exe` já existente no `target/` → **bloqueado**
- a mesma cópia em `C:\...\Temp` ou `E:\` → **bloqueada** (não é caminho)
- o `distorrent.exe` já buildado → **bloqueado**

Confirmação no log:

```powershell
Get-WinEvent -FilterHashtable @{
  LogName='Microsoft-Windows-CodeIntegrity/Operational'
  Id=3077
  StartTime=(Get-Date).AddHours(-1)
} | Select-Object -First 5 TimeCreated,Message | Format-List
```

## O que NÃO resolve

- Apagar `target/debug/build` dos crates afetados (regenera bloqueado)
- Trocar `CARGO_TARGET_DIR` para outro disco ou para `%TEMP%` (o bloqueio é por
  arquivo, não por pasta)
- Rodar `cargo clean` (mesmo resultado)
- Esperar o Defender terminar (não é scan)

## Solução: buildar pelo WSL

O WSL não sofre essa política. É o caminho que a skill do projeto já usa para
validar código Linux:

```powershell
wsl -e bash -lc "cd /mnt/e/Programas/dis-torrent/distorrent-core && cargo check --lib && cargo test --lib"
wsl -e bash -lc "cd /mnt/e/Programas/dis-torrent/src-tauri && cargo check --lib"
```

## Solução para o binário Windows (instalador)

O binário Windows precisa ser compilado no Windows. Para isso, desligue o
Controle de Aplicativo (precisa de administrador e reinício):

Configurações → Privacidade e segurança → Segurança do Windows → Controle de
aplicativo e navegador → **Controle de aplicativo** → Desligado.

Depois religue quando terminar o build. Alternativa corporativa: adicionar regra
de permissão na política WDAC para `target/` (exige o `.cip` assinado).

Alternativa sem mexer no sistema: compilar o instalador numa máquina/VM onde o
SAC não esteja ativo.
