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

## Build de release: construa a partir de um worktree limpo

Um build de release pode rodar durante minutos. Se outro agente (ou você, em
outra sessão) editar o repositório no meio, os binários saem com código que
**não está na tag** — o hash publicado deixa de corresponder ao fonte da
release.

Foi o que aconteceu na 1.1.68: o build Linux rodou de 12:25 a 12:39 enquanto
outro processo editava `media_voice.rs`, `commands_files.rs`, `lib.rs`,
`callWire.ts` e `callManager.ts` entre 12:33 e 12:43. Os artefatos Linux saíram
com mudanças fora da tag e precisaram ser refeitos.

Procedimento para qualquer build de release:

```powershell
# 1) worktree exatamente no commit que vai ser publicado
git worktree add "$env:TEMP\dt-release" v1.1.68

# 2) buildar de lá (não do diretório de trabalho)
wsl -e bash -lc "cd /mnt/c/Users/lucas/AppData/Local/Temp/dt-release && npm ci && npm run build && npm run tauri build -- --bundles deb,appimage"

# 3) conferir que nada mudou durante o build
cd "$env:TEMP\dt-release"; git status --porcelain   # tem de estar vazio

# 4) só então copiar os artefatos, assinar o manifesto e publicar
git worktree remove "$env:TEMP\dt-release" --force
```

O `git status --porcelain` vazio no fim é a prova de que o binário corresponde
ao fonte da tag. Sem isso, não há como afirmar que o artefato publicado veio do
commit anunciado.

Para builds longos no WSL, rode com `setsid` — um restart da sessão do agente
mata o processo filho no meio do build:

```bash
setsid bash scripts/wsl-rebuild-linux-clean.sh < /dev/null > /dev/null 2>&1 &
```

## Republicar uma tag com bytes diferentes

`publish-release.mjs` **pula** assets que já existem com o mesmo nome. Para
trocar o conteúdo de uma release já publicada, apague os assets antes — senão o
manifesto novo aponta para hashes que não estão no ar:

```powershell
node scripts/delete-release-assets.mjs v1.1.68 `
  DisTorrent_1.1.68-pre-alpha_amd64.AppImage `
  DisTorrent_1.1.68-pre-alpha_amd64.deb `
  distorrent-manifest.bin
```

Depois reassine com `--refresh-hashes`, rode `verify-release.mjs` (precisa dar
`PASS`), suba de novo e **baixe o asset publicado** para conferir o SHA-256.

