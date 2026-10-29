# === DisTorrent — build do instalador Windows (Inno Setup) ===
#
# Uso:
#   .\scripts\build-installer.ps1              # builda o app (se preciso) + instalador
#   .\scripts\build-installer.ps1 -SkipBuild   # só reempacota o distorrent.exe existente
#   .\scripts\build-installer.ps1 -Scan        # + teste do Defender com MOTW
#
# POR QUE ESTE SCRIPT EXISTE:
# o instalador NSIS do Tauri dispara `Program:Win32/Contebrew.A!ml` no Defender
# quando o arquivo é BAIXADO (Mark-of-the-Web). O scan local do .exe recém-buildado
# não reproduz isso — foi assim que uma versão foi publicada "limpa" e o Edge
# bloqueou o download de todo mundo. Então:
#   1) o instalador é feito em Inno Setup (outro motor, não aciona a heurística);
#   2) o teste de aceitação é -Scan, que aplica MOTW numa CÓPIA antes de escanear.

param(
    [string]$ISCC,
    [switch]$SkipBuild,
    [switch]$Scan
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Fail([string]$msg) {
    Write-Host "FALHOU: $msg" -ForegroundColor Red
    exit 1
}

# --- Versão: a textual vai no nome/instalador, a numérica no VersionInfo ---
$pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$appVersion = $pkg.version
$base = ($appVersion -split "-")[0]
if ($base -notmatch '^\d+\.\d+\.\d+$') { Fail "versão não parseável em package.json: $appVersion" }
$numericVersion = "$base.0"

# --- App já buildado? (o instalador empacota o .exe do Tauri) ---
# O crate continua se chamando `distorent-cli` (nome do pacote Rust), então o
# cargo produz `distorent-cli.exe`; o instalador e os atalhos usam
# `distorrent.exe`. Antes esse descompasso obrigava a copiar o arquivo à mão e
# o script morria com "binário do app não existe" numa árvore limpa.
$cargoExe = Join-Path $root "src-tauri\target\release\distorent-cli.exe"
$appExe = Join-Path $root "src-tauri\target\release\distorrent.exe"
if (-not $SkipBuild) {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { Fail "npm.cmd não encontrado no PATH (rode com Node no PATH — ver AGENTS.md §3)." }
    Write-Host "Buildando o app (tauri build --no-bundle)..." -ForegroundColor Cyan
    Push-Location $root
    try {
        & $npm run tauri build -- --no-bundle
        if ($LASTEXITCODE -ne 0) { Fail "tauri build falhou (exit $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path $appExe)) {
    if (Test-Path $cargoExe) {
        Copy-Item $cargoExe $appExe -Force
        Write-Host "  $([System.IO.Path]::GetFileName($cargoExe)) -> distorrent.exe" -ForegroundColor DarkGray
    } else {
        Fail "binário do app não existe: nem $appExe nem $cargoExe (rode sem -SkipBuild)."
    }
}

# --- ISCC (compilador do Inno Setup) ---
if (-not $ISCC) {
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    )
    $ISCC = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ISCC -or -not (Test-Path $ISCC)) {
    Fail "ISCC.exe não encontrado. Instale com: winget install --id JRSoftware.InnoSetup -e --scope user"
}

$outDir = Join-Path $root "src-tauri\target\release\bundle\inno"
Write-Host "Compilando instalador (Inno Setup)..." -ForegroundColor Cyan
& $ISCC `
    "/DAppVersion=$appVersion" `
    "/DNumericVersion=$numericVersion" `
    "/DSourceExe=$appExe" `
    "/DOutputDir=$outDir" `
    (Join-Path $root "installer\distorent.iss")
if ($LASTEXITCODE -ne 0) { Fail "ISCC falhou (exit $LASTEXITCODE)." }

$setup = Join-Path $outDir "DisTorrent_${appVersion}_x64_setup.exe"
if (-not (Test-Path $setup)) { Fail "instalador não foi gerado em $outDir." }

$item = Get-Item $setup
$sha = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
Write-Host ""
Write-Host "Instalador: $($item.FullName)" -ForegroundColor Green
Write-Host ("Tamanho: {0:N2} MB" -f ($item.Length / 1MB))
Write-Host "SHA256: $sha"

# --- Teste de aceitação: download simulado (MOTW) + Defender ---
if ($Scan) {
    $tmpDir = Join-Path $env:TEMP "distorent-scan"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    # Nome diferente de propósito: o Defender cacheia veredito por caminho/hash,
    # e o arquivo recém-buildado já foi escaneado sem MOTW.
    $copy = Join-Path $tmpDir "DisTorrent_${appVersion}_x64_setup_download.exe"
    Copy-Item $setup $copy -Force
    Set-Content -Path $copy -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3" -Encoding ascii

    $mp = Get-ChildItem "C:\ProgramData\Microsoft\Windows Defender\Platform\*\MpCmdRun.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName | Select-Object -Last 1
    if (-not $mp) { Fail "MpCmdRun.exe não encontrado (Defender ausente? não dá para validar o falso positivo)." }

    Write-Host "`nEscaneando cópia COM Mark-of-the-Web..." -ForegroundColor Cyan
    & $mp.FullName -Scan -ScanType 3 -File $copy -DisableRemediation
    $scanExit = $LASTEXITCODE
    Remove-Item $copy -Force -ErrorAction SilentlyContinue
    # MpCmdRun: 0 = nenhuma ameaça, 2 = ameaça encontrada.
    if ($scanExit -eq 2) { Fail "Defender acusou o instalador. NÃO publique: o navegador vai bloquear o download." }
    if ($scanExit -ne 0) { Fail "MpCmdRun saiu com código $scanExit — resultado inconclusivo, não publique sem repetir." }
    Write-Host "Defender: found no threats (com MOTW)" -ForegroundColor Green
}

exit 0
