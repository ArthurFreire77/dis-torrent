# Build do APK Android NA ORDEM CERTA.
#
# POR QUE ESTE SCRIPT EXISTE (release 1.1.16 saiu com "asset not found: index.html"):
# o frontend e EMBUTIDO no libdistorrent_lib.so em tempo de COMPILACAO do Rust.
# Se o cargo build rodar antes do npm run build, o .so embute um dist/ velho (ou
# vazio) e o APK instala, abre e mostra "asset not found: index.html".
# O Gradle NAO roda o build do frontend: ele so empacota o .so que achar.
#
# Ordem obrigatoria:
#   1. npm run build          (gera dist/ com index.html + assets)
#   2. cargo build --release  (embute o dist/ DENTRO do .so)
#   3. tocar o lib.rs         (para o cargo nao pular por cache)
#   4. hard link do .so para jniLibs
#   5. gradle assembleArm64Release
#   6. verificar DENTRO do APK se os assets estao no .so
#
# Mantido ASCII puro: PowerShell 5.1 le .ps1 como ANSI sem BOM e qualquer
# acento/travessao em string literal vira erro de parser.
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-android.ps1
#   ... -SkipFrontend   (quando o dist/ ja esta fresco de proposito)

param(
    [switch]$SkipFrontend
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

$env:ANDROID_HOME = "C:\Users\lucas\AppData\Local\Android\Sdk"
$env:NDK_HOME = "$env:ANDROID_HOME\ndk\27.0.12077973"
$env:JAVA_HOME = "C:\Users\lucas\jdk-17.0.13+11"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin;$env:ANDROID_HOME\platform-tools;$env:JAVA_HOME\bin;C:\Users\lucas\npm-wrapper;$env:TEMP\node24\node-v24.22.1-win-x64;$env:PATH"
$npm = Join-Path $env:TEMP 'node24\node-v24.22.1-win-x64\npm.cmd'

function Passo($n) { Write-Host ""; Write-Host "==> $n" -ForegroundColor Cyan }

# 1) FRONTEND PRIMEIRO. Sem isto o .so embute um dist/ vazio.
if (-not $SkipFrontend) {
    Passo 'frontend (npm run build)'
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw 'build do frontend falhou' }
}
if (-not (Test-Path 'dist\index.html')) {
    throw 'dist/index.html nao existe: o APK sairia com "asset not found"'
}
$frontendStamp = (Get-Item 'dist\index.html').LastWriteTime

# 2) Rust embute o dist/. Tocar o lib.rs evita o cache pular a recompilacao.
Passo 'rust android (embute o dist/)'
(Get-Item 'src-tauri\src\lib.rs').LastWriteTime = Get-Date
Push-Location 'src-tauri'
cargo build --target aarch64-linux-android --release
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw 'cargo build android falhou' }

$so = 'src-tauri\target\aarch64-linux-android\release\libdistorrent_lib.so'
if ((Get-Item $so).LastWriteTime -lt $frontendStamp) {
    throw 'o .so e mais velho que o dist/: os assets nao entraram'
}

# 3) hard link (symlink nao funciona no Windows sem Developer Mode)
Passo 'link do .so para jniLibs'
$dst = 'src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a\libdistorrent_lib.so'
New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null
Remove-Item $dst -Force -ErrorAction SilentlyContinue
cmd /c "mklink /H `"$dst`" `"$so`"" | Out-Null

# 4) Gradle (sem os rustBuild*, ja compilamos)
Passo 'gradle assembleArm64Release'
Push-Location 'src-tauri\gen\android'
.\gradlew.bat assembleArm64Release -x rustBuildArm64Release -x rustBuildArmRelease -x rustBuildX86Release -x rustBuildX86_64Release -x rustBuildUniversalRelease
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw 'gradle falhou' }

# 5) PROVA: os assets tem de estar dentro do .so que foi para o APK.
#    Tamanho de APK nao prova nada (o APK oco da 1.1.16 tinha 39 MB).
Passo 'verificando os assets DENTRO do APK'
$apk = 'src-tauri\gen\android\app\build\outputs\apk\arm64\release\app-arm64-release.apk'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$tmp = Join-Path $env:TEMP 'apk-so-check'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $apk))
$e = $zip.Entries | Where-Object { $_.FullName -eq 'lib/arm64-v8a/libdistorrent_lib.so' }
if (-not $e) { $zip.Dispose(); throw 'APK sem libdistorrent_lib.so' }
[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, "$tmp\lib.so", $true)
$zip.Dispose()

$txt = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes("$tmp\lib.so"))
$entradas = [regex]::Matches($txt, 'assets/(index|react|tauri)-[A-Za-z0-9_-]{8}\.(js|css)') |
    ForEach-Object { $_.Value } | Select-Object -Unique
if ($entradas.Count -lt 3) {
    throw "o .so do APK NAO tem o frontend embutido (achou $($entradas.Count)). O app abriria com 'asset not found: index.html'."
}

Passo 'verificacao de assinatura/estrutura'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify-apk.ps1') -Path $apk

Write-Host ""
Write-Host "APK pronto com frontend embutido. Referencias: $($entradas.Count)" -ForegroundColor Green
Write-Host "  $apk"
$sha = (Get-FileHash $apk -Algorithm SHA256).Hash
Write-Host "  SHA256: $sha"
