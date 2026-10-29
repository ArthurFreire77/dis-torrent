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
# A ORDEM IMPORTA: o `distorrent.exe` que o instalador empacota tem de ser o
# binário RECÉM-COMPILADO, nunca um resto de build anterior.
#
# BUG REAL (1.1.9): o script só copiava quando `distorrent.exe` NÃO existia.
# Sobrou um `distorrent.exe` de 16:34 (1.1.8) ao lado de um `distorent-cli.exe`
# de 18:02 (1.1.9); com `-SkipBuild` a cópia era pulada e o Inno publicou um
# instalador rotulado 1.1.9 contendo o app 1.1.8. Agora a cópia é SEMPRE feita
# quando a origem é mais nova (ou quando a versão gravada no binário difere).
if (Test-Path $cargoExe) {
    $needCopy = -not (Test-Path $appExe)
    if (-not $needCopy) {
        $srcTime = (Get-Item $cargoExe).LastWriteTimeUtc
        $dstTime = (Get-Item $appExe).LastWriteTimeUtc
        $srcVer = (Get-Item $cargoExe).VersionInfo.ProductVersion
        $dstVer = (Get-Item $appExe).VersionInfo.ProductVersion
        if ($srcTime -gt $dstTime -or $srcVer -ne $dstVer) {
            Write-Host "  AVISO: distorrent.exe ($dstVer) estava DESATUALIZADO — recopiando de distorent-cli.exe ($srcVer)" -ForegroundColor Yellow
            $needCopy = $true
        }
    }
    if ($needCopy) {
        Copy-Item $cargoExe $appExe -Force
        Write-Host "  $([System.IO.Path]::GetFileName($cargoExe)) -> distorrent.exe" -ForegroundColor DarkGray
    }
} elseif (-not (Test-Path $appExe)) {
    Fail "binário do app não existe: nem $appExe nem $cargoExe (rode sem -SkipBuild)."
}

# Confere o que vai ser empacotado: versão e data do BINÁRIO, não do rótulo.
$appVer = (Get-Item $appExe).VersionInfo.ProductVersion
$appTime = (Get-Item $appExe).LastWriteTime
Write-Host "  app empacotado: $appVer  ($appTime)" -ForegroundColor DarkGray
if ($appVer -ne $appVersion) {
    Write-Host "  AVISO: o binário diz '$appVer' mas o instalador será rotulado '$appVersion'." -ForegroundColor Yellow
    Write-Host "         Rode sem -SkipBuild (ou `cargo build --release`) para casar os dois." -ForegroundColor Yellow
}

# --- Assinatura de código (opcional, best-effort) ---
# Assina o .exe do APP antes do Inno empacotar — assim o payload que o usuário
# executa já sai assinado — e assina o INSTALADOR depois de compilado, que é o
# arquivo que o navegador/SmartScreen avalia no download.
#
# Sem certificado configurado o sign-windows.ps1 imprime "sem certificado
# configurado — pulando assinatura" e sai 0: o build continua igual. Se um
# certificado ESTÁ configurado e a assinatura falha, avisamos alto mas não
# derrubamos o build (best-effort) — o resumo final marca NÃO assinado para
# ninguém publicar achando que assinou.
$signScript = Join-Path $PSScriptRoot "sign-windows.ps1"
# Estado por artefato: o app pode estar assinado e o instalador não (ou
# vice-versa). Um único booleano global já mentiu em teste manual.
$script:signStates = [ordered]@{}
function Invoke-Sign([string]$target, [string]$label) {
    if (-not (Test-Path $signScript)) {
        Write-Host "  sign-windows.ps1 ausente — pulando assinatura de ${label}" -ForegroundColor DarkYellow
        $script:signStates[$label] = "não assinado (script ausente)"
        return
    }
    & $signScript -File $target
    if ($LASTEXITCODE -eq 0) {
        $sig = Get-AuthenticodeSignature -FilePath $target
        if ($sig.Status -eq "Valid") {
            Write-Host "  ${label} assinado ($($sig.SignerCertificate.Subject))" -ForegroundColor Green
            $script:signStates[$label] = "assinado"
        } else {
            Write-Host "  ${label} NÃO assinado (sem certificado configurado)" -ForegroundColor Yellow
            $script:signStates[$label] = "não assinado"
        }
    } else {
        Write-Host "  ATENÇÃO: falha ao assinar ${label} — o artefato segue NÃO assinado." -ForegroundColor Yellow
        Write-Host "  NÃO publique como se estivesse assinado (ver docs/DEFENDER.md)." -ForegroundColor Yellow
        $script:signStates[$label] = "FALHA na assinatura"
    }
}
Write-Host "Assinatura de código (opcional)..." -ForegroundColor Cyan
Invoke-Sign -target $appExe -label "app"
# Observação: NÃO apagamos `DISTORRENT_SIGN_PASSWORD` do ambiente. Ela foi
# definida pelo próprio usuário/CI na sessão; removê-la surpreenderia quem roda
# o build duas vezes seguidas. O sign-windows.ps1 nunca a imprime nem a grava.

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

# Assina o INSTALADOR (é o arquivo que o navegador baixa e o SmartScreen
# avalia). Roda depois do ISCC porque assinar antes invalidaria o pacote.
Invoke-Sign -target $setup -label "instalador"

$item = Get-Item $setup
$sha = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
Write-Host ""
Write-Host "Instalador: $($item.FullName)" -ForegroundColor Green
Write-Host ("Tamanho: {0:N2} MB" -f ($item.Length / 1MB))
Write-Host "SHA256: $sha"
Write-Host "Assinatura: instalador = $($script:signStates['instalador']); app = $($script:signStates['app'])"

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
