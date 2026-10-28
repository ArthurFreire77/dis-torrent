# === DisTorrent — build do APK Android (local, verificável) ===
#
# Uso:
#   .\build-android.ps1                 # release assinado (keystore.properties)
#   .\build-android.ps1 -Debug          # debug (debug.keystore)
#   .\build-android.ps1 -SkipChecks     # pula typecheck/lint/unit
#
# POR QUE ESTE SCRIPT EXISTE:
# o build manual antigo (cargo build + `mklink /H` + gradle com `-x rustBuild*`)
# produzia um APK SEM a libdistorrent_lib.so quando o hard link falhava — e ninguém
# percebia, porque o gradle termina "com sucesso" com jniLibs vazio. O app
# instalava e morria no boot ("parou de funcionar"). Aqui o Tauri CLI cuida do
# Rust + jniLibs (sem link manual) e o resultado é VERIFICADO antes de sair.

param(
    [switch]$Debug,
    [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

# --- Ambiente (AGENTS.md §13) ---------------------------------------------
$env:ANDROID_HOME = "C:\Users\lucas\AppData\Local\Android\Sdk"
$env:NDK_HOME = "$env:ANDROID_HOME\ndk\27.0.12077973"
$env:JAVA_HOME = "C:\Users\lucas\jdk-17.0.13+11"
$nodeDir = "$env:TEMP\node24\node-v24.22.1-win-x64"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin;$env:ANDROID_HOME\platform-tools;$env:JAVA_HOME\bin;$nodeDir;$env:PATH"

$npm = Join-Path $nodeDir "npm.cmd"
if (-not (Test-Path $npm)) { throw "npm.cmd não encontrado em $nodeDir (ver AGENTS.md §3)" }

Push-Location $PSScriptRoot
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version

    # Arquivos que o CLI gera e o git ignora (tauri.settings.gradle, app/tauri.*).
    # Num clone limpo eles NÃO existem e o gradle falha no settings.gradle —
    # o init do Tauri recria só o que falta e NÃO sobrescreve o que já está
    # versionado (MainActivity.kt, build.gradle.kts). Rodar init SEMPRE seria
    # arriscado; rodar SÓ quando falta é o caminho seguro.
    $needsInit = @(
        "src-tauri\gen\android\tauri.settings.gradle",
        "src-tauri\gen\android\app\tauri.properties",
        "src-tauri\gen\android\app\tauri.build.gradle.kts"
    ) | Where-Object { -not (Test-Path $_) }
    if ($needsInit) {
        Write-Host "`n[0/4] gerando arquivos do projeto Android (init)..." -ForegroundColor Yellow
        & $npm run tauri android init -- --ci
        if ($LASTEXITCODE -ne 0) { throw "tauri android init falhou" }
    }

    if (-not $SkipChecks) {
        Write-Host "`n[1/4] typecheck / lint / unit..." -ForegroundColor Yellow
        & $npm run typecheck; if ($LASTEXITCODE -ne 0) { throw "typecheck falhou" }
        & $npm run lint;      if ($LASTEXITCODE -ne 0) { throw "lint falhou" }
        & $npm run test:unit; if ($LASTEXITCODE -ne 0) { throw "unit falhou" }
    }

    Write-Host "`n[2/4] frontend + Rust (aarch64 Android)..." -ForegroundColor Yellow
    & $npm run build; if ($LASTEXITCODE -ne 0) { throw "build do frontend falhou" }

    Push-Location "src-tauri"
    try {
        cargo build --target aarch64-linux-android --release
        if ($LASTEXITCODE -ne 0) { throw "cargo build (Android) falhou" }
    } finally { Pop-Location }

    # Por que CÓPIA e não symlink: o Tauri CLI tenta criar um symlink para o
    # jniLibs, e no Windows isso exige Developer Mode — sem ela o build ABORTA
    # (ou, no caminho manual antigo, seguia com jniLibs VAZIO e gerava o APK oco
    # que morria no boot na 1.1.6). Uma cópia de 18 MB é rápida e não depende
    # de política do sistema.
    $so = "src-tauri\target\aarch64-linux-android\release\libdistorrent_lib.so"
    if (-not (Test-Path $so)) { throw "libdistorrent_lib.so não compilada: $so" }
    $jniLibs = "src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a"
    New-Item -ItemType Directory -Path $jniLibs -Force | Out-Null
    Copy-Item $so "$jniLibs\libdistorrent_lib.so" -Force
    if ((Get-Item "$jniLibs\libdistorrent_lib.so").Length -lt 1MB) { throw "libdistorrent_lib.so copiada parece truncada" }

    # Hard link (ou cópia, se symlink exigir Developer Mode) do lib para o
    # caminho alternativo que alguns ambientes do Tauri 2 usam
    $altJniLibs = "src-tauri\gen\android\app\src\main\jniLibs\arm64"
    New-Item -ItemType Directory -Path $altJniLibs -Force | Out-Null
    try {
        if (Test-Path "$jniLibs\libdistorrent_lib.so") {
            New-Item -ItemType HardLink -Path "$altJniLibs\libdistorrent_lib.so" -Value "$jniLibs\libdistorrent_lib.so" -Force | Out-Null
        }
    } catch {
        Copy-Item "$jniLibs\libdistorrent_lib.so" "$altJniLibs\libdistorrent_lib.so" -Force
    }
    Write-Host "  libdistorrent_lib.so em jniLibs: $([math]::Round((Get-Item "$jniLibs\libdistorrent_lib.so").Length/1MB,2)) MB" -ForegroundColor Green

    Write-Host "`n[3/4] gradle (skip rustBuild — Rust já está pronto)..." -ForegroundColor Yellow
    $flavor = if ($Debug) { "debug" } else { "release" }
    $skip = @(
        "rustBuildArm64Release", "rustBuildArmRelease", "rustBuildX86Release", "rustBuildX86_64Release", "rustBuildUniversalRelease",
        "rustBuildArm64Debug", "rustBuildArmDebug", "rustBuildX86Debug", "rustBuildX86_64Debug", "rustBuildUniversalDebug"
    ) | ForEach-Object { "-x", $_ }
    # Só a ABI arm64: `assembleRelease` puro compila as 5 flavors e as outras 4
    # saem SEM a libdistorrent_lib.so (só a arm64 foi copiada para jniLibs) — APK
    # que instala e morre no boot, o mesmo defeito da 1.1.6.
    & "src-tauri\gen\android\gradlew.bat" -p "src-tauri\gen\android" "assembleArm64$flavor" @skip
    if ($LASTEXITCODE -ne 0) { throw "gradle assembleArm64$flavor falhou" }

    Write-Host "`n[3/4] localizando APK..." -ForegroundColor Yellow
    $flavor = if ($Debug) { "debug" } else { "release" }
    # O Tauri pode escrever em apk/universal/<flavor> (padrão) ou apk/arm64/<flavor>
    # (com --split-per-abi); procuramos o mais recente para não depender disso.
    $apk = Get-ChildItem "src-tauri\gen\android\app\build\outputs\apk\arm64" -Recurse -Filter *.apk -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\$flavor\\" -and $_.Name -notlike "*unsigned*" } |
        Sort-Object LastWriteTime | Select-Object -Last 1
    if (-not $apk) { throw "APK não encontrado em app/build/outputs/apk/arm64/$flavor/" }

    Write-Host "`n[4/4] verificando conteúdo do APK..." -ForegroundColor Yellow
    & "$PSScriptRoot\scripts\verify-apk.ps1" -Path $apk.FullName
    if ($LASTEXITCODE -ne 0) { throw "verificação do APK falhou — NÃO publique este arquivo" }

    $outDir = "src-tauri\target\release\bundle\apk"
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    $suffix = if ($Debug) { "debug" } else { "release" }
    $dest = Join-Path $outDir "DisTorrent_${version}_arm64_${suffix}.apk"
    Copy-Item $apk.FullName $dest -Force

    Write-Host "`n=== APK OK ===" -ForegroundColor Green
    Write-Host "  $dest"
    Write-Host "  sha256: $((Get-FileHash $dest -Algorithm SHA256).Hash)"
} finally {
    Pop-Location
}
