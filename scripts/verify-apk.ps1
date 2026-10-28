# === DisTorrent — verificação de APK Android ===
#
# Uso:
#   .\scripts\verify-apk.ps1 -Path "caminho\app-arm64-release.apk"
#
# POR QUE ESTE SCRIPT EXISTE (regressão 1.1.6):
# o APK publicado tinha 2,49 MB e NENHUM lib/*/libforge_lib.so: o app abria e o
# Android matava na hora ("parou de funcionar") com UnsatisfiedLinkError em
# System.loadLibrary("forge_lib"). Tamanho de APK não é prova de nada, então
# verificamos o CONTEÚDO: a biblioteca nativa tem que estar lá, e o APK tem que
# ser grande o bastante para conter Rust + WebView + assets.
#
# Sai com código 1 (build quebrado) se qualquer critério falhar.

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$MinMB = 10,
    [string]$ExpectedAbi = "arm64-v8a"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Fail([string]$msg) {
    Write-Host "FALHOU: $msg" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $Path)) { Fail "APK não existe: $Path" }

$apk = Get-Item $Path
$sizeMB = [math]::Round($apk.Length / 1MB, 2)
Write-Host "APK: $($apk.FullName)" -ForegroundColor Cyan
Write-Host "Tamanho: $sizeMB MB (mínimo exigido: $MinMB MB)" -ForegroundColor Cyan

if ($apk.Length -lt ($MinMB * 1MB)) {
    Fail "APK de $sizeMB MB é pequeno demais — quase sempre significa Rust/assets ausentes (foi exatamente o bug da 1.1.6)."
}

$zip = [System.IO.Compression.ZipFile]::OpenRead($apk.FullName)
try {
    $entries = $zip.Entries

    $libs = $entries | Where-Object { $_.FullName -match '^lib/[^/]+/libforge_lib\.so$' }
    if (-not $libs) {
        $abis = ($entries | Where-Object { $_.FullName -like 'lib/*' } | ForEach-Object { $_.FullName }) -join ', '
        Fail "nenhum lib/*/libforge_lib.so dentro do APK. O app vai morrer no boot com UnsatisfiedLinkError. Entradas lib/: [$abis]"
    }

    Write-Host "`nBibliotecas nativas:" -ForegroundColor Green
    foreach ($l in $libs) {
        $mb = [math]::Round($l.Length / 1MB, 2)
        Write-Host "  $($l.FullName)  $mb MB"
        if ($l.Length -lt 1MB) {
            Fail "$($l.FullName) tem só $mb MB — biblioteca truncada (build interrompido?)."
        }
    }

    if (-not ($libs | Where-Object { $_.FullName -eq "lib/$ExpectedAbi/libforge_lib.so" })) {
        Fail "ABI esperada ausente: lib/$ExpectedAbi/libforge_lib.so (o aparelho alvo não roda este APK)."
    }

    # Frontend/config do Tauri: no Tauri 2 os assets vão embutidos na .so, mas o
    # tauri.conf.json de runtime fica em assets/. Se não houver NADA em assets/,
    # o empacotamento saiu errado.
    $assets = $entries | Where-Object { $_.FullName -like 'assets/*' -and $_.Length -gt 0 }
    if (-not $assets) {
        Fail "nenhum asset em assets/ — o pacote não tem configuração de runtime do Tauri."
    }
    Write-Host "`nAssets embutidos: $($assets.Count) entradas"

    if (-not ($entries | Where-Object { $_.FullName -like 'classes*.dex' })) {
        Fail "APK sem classes.dex — build de Kotlin não entrou."
    }
} finally {
    $zip.Dispose()
}

# Assinatura: um APK não assinado não instala em aparelho nenhum.
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = "$env:LOCALAPPDATA\Android\Sdk" }
$apksigner = Get-ChildItem "$sdk\build-tools\*\apksigner.bat" -ErrorAction SilentlyContinue |
    Sort-Object FullName | Select-Object -Last 1
if ($apksigner) {
    # `$ErrorActionPreference = "Stop"` + stderr do apksigner (ele imprime um
    # WARNING restrito do java.lang.System em toda execução) = NativeCommandError
    # e o script morria ANTES de dizer se a assinatura era válida. Lemos o
    # exit code de verdade e só então decidimos.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $certs = & $apksigner.FullName verify --print-certs $apk.FullName 2>&1 | Out-String
    $signExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($signExit -ne 0) {
        Write-Host $certs -ForegroundColor Yellow
        Fail "APK não assinado / assinatura inválida (não instala em aparelho)."
    }
    $certs = $certs -split "`n"
    $dn = ($certs | Select-String "certificate DN:" | Select-Object -First 1).Line
    $sha = ($certs | Select-String "SHA-256 digest:" | Select-Object -First 1).Line
    Write-Host "`nAssinatura OK" -ForegroundColor Green
    Write-Host "  $($dn -replace '.*certificate DN: ', '')"
    Write-Host "  $($sha -replace '.*SHA-256 digest: ', 'SHA-256: ')"
} else {
    Write-Host "`n(aviso) apksigner não encontrado — não verifiquei a assinatura." -ForegroundColor Yellow
}

Write-Host "`nAPK VÁLIDO: $sizeMB MB, libforge_lib.so presente." -ForegroundColor Green
exit 0
