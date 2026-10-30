# VERIFICAÇÃO COMPLETA DO DISTORRENT (Windows)
#
# POR QUE ESTE SCRIPT EXISTE: os comandos do projeto são longos (Node é
# portátil, fora do PATH; Rust vive em ~\.cargo\bin) e é fácil esquecer um gate.
# Rodar isto antes de entregar garante typecheck + lint + unit + Rust no mesmo
# pacote, e o resumo diz o que rodou DE VERDADE — nunca "parece que passou".
#
# Uso (NESTA MÁQUINA não há `pwsh` — use `powershell`):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .opencode/skills/distorrent/run-verify.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File ... -SkipRust
#
# Sai com código != 0 se qualquer gate falhar.

param(
    [switch]$SkipRust,
    [switch]$SkipWeb
)

$ErrorActionPreference = 'Continue'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
Set-Location $root

$nodeDir = Join-Path $env:TEMP 'node24\node-v24.22.1-win-x64'
$npm = Join-Path $nodeDir 'npm.cmd'
$env:PATH = "$env:USERPROFILE\.cargo\bin;$nodeDir;$env:PATH"

$falhas = New-Object System.Collections.Generic.List[string]
$ok = New-Object System.Collections.Generic.List[string]

function Gate([string]$nome, [scriptblock]$acao) {
    Write-Host ""
    Write-Host "==> $nome" -ForegroundColor Cyan
    # O cargo escreve progresso em STDERR; com $ErrorActionPreference='Continue'
    # isso vira "NativeCommandError" no meio da saída e confunde quem lê. Aqui
    # só o CÓDIGO DE SAÍDA decide o gate — a mensagem final é o veredito.
    $anterior = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    & $acao 2>&1 | Out-Host
    $code = $LASTEXITCODE
    $ErrorActionPreference = $anterior
    if ($code -eq 0) {
        $ok.Add($nome)
        Write-Host "    OK" -ForegroundColor Green
    } else {
        $falhas.Add("$nome (exit $code)")
        Write-Host "    FALHOU (exit $code)" -ForegroundColor Red
    }
}

if (-not $SkipWeb) {
    if (-not (Test-Path $npm)) {
        $falhas.Add("npm.cmd não encontrado em $nodeDir")
        Write-Host "Node portátil ausente em $nodeDir" -ForegroundColor Red
    } else {
        Gate 'typecheck (tsc -b)'      { & $npm run typecheck 2>&1 | Select-Object -Last 20 }
        Gate 'lint (eslint .)'         { & $npm run lint 2>&1 | Select-String -Pattern 'error|problems' | Select-Object -Last 5 }
        Gate 'unit (node --test)'      { & $npm run test:unit 2>&1 | Select-String -Pattern 'tests |pass |fail ' | Select-Object -Last 4 }
    }
}

if (-not $SkipRust) {
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        $falhas.Add('cargo não encontrado no PATH')
        Write-Host 'Rust ausente no PATH' -ForegroundColor Red
    } else {
        Push-Location (Join-Path $root 'distorrent-core')
        Gate 'core: cargo check --lib' { cargo check --lib 2>&1 | Select-Object -Last 3 }
        Gate 'core: cargo test --lib'  { cargo test --lib 2>&1 | Select-String -Pattern 'test result' }
        Gate 'core: cargo fmt --check' { cargo fmt --check 2>&1 | Select-Object -First 10 }
        Pop-Location

        Push-Location (Join-Path $root 'src-tauri')
        Gate 'shell: cargo check --lib' { cargo check --lib 2>&1 | Select-Object -Last 3 }
        Gate 'shell: cargo fmt --check' { cargo fmt --check 2>&1 | Select-Object -First 10 }
        Pop-Location
    }
}

Write-Host ""
Write-Host "================ RESUMO ================" -ForegroundColor Cyan
foreach ($g in $ok)     { Write-Host "  OK      $g" -ForegroundColor Green }
foreach ($f in $falhas) { Write-Host "  FALHOU  $f" -ForegroundColor Red }
Write-Host ""
Write-Host "Lembrete honesto: nada aqui prova áudio, vídeo ou tela. Os testes de"
Write-Host "mídia nativa são Linux-only; o resto exige dois dispositivos."
Write-Host ""

if ($falhas.Count -gt 0) { exit 1 }
exit 0

# ---------------------------------------------------------------------------
# ALVO LINUX (WSL). O cargo do Windows NAO compila media_voice.rs/media_video.rs
# (sao #[cfg(target_os = "linux")]) � erros ali passam batido e so quebram no
# CI. Use -Linux para rodar o gate de verdade.
# ---------------------------------------------------------------------------
if ($Linux) {
    $distro = wsl -e bash -lc "echo ok" 2>$null
    if ($LASTEXITCODE -ne 0) {
        $falhas.Add('WSL indisponivel (necessario para compilar o alvo Linux)')
    } else {
        Gate 'linux: core check+test+clippy+fmt' {
            wsl -e bash -lc "cd /mnt/e/Programas/dis-torrent/distorrent-core && cargo check --lib && cargo test --lib && cargo clippy --all-targets && cargo fmt --check" 2>&1 | Select-Object -Last 12
        }
        Gate 'linux: shell check+fmt' {
            wsl -e bash -lc "cd /mnt/e/Programas/dis-torrent/src-tauri && cargo check --lib && cargo fmt --check" 2>&1 | Select-Object -Last 8
        }
    }
}
