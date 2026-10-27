# === DisTorrent — Build local (Windows) ===
# Uso: .\build-local.ps1
# Gera: src-tauri\target\release\bundle\nsis\*.exe e msi\*.msi

$ErrorActionPreference = "Stop"

Write-Host "`n=== DisTorrent Build Local ===" -ForegroundColor Cyan

# 1. Verificar prerequisitos
Write-Host "`n[1/6] Verificando prerequisitos..." -ForegroundColor Yellow
$missing = @()
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { $missing += "Rust (rustup)" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $missing += "Node.js" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $missing += "npm" }
if ($missing.Count -gt 0) {
    Write-Host "FALTANDO: $($missing -join ', ')" -ForegroundColor Red
    Write-Host "Instale antes de continuar. Veja AGENTS.md secao 3." -ForegroundColor Red
    exit 1
}
Write-Host "  cargo: $(cargo --version)" -ForegroundColor Green
Write-Host "  node:  $(node --version)" -ForegroundColor Green
Write-Host "  npm:   $(npm --version)" -ForegroundColor Green

# 2. Instalar dependencias
Write-Host "`n[2/6] npm ci..." -ForegroundColor Yellow
npm ci
if ($LASTEXITCODE -ne 0) { Write-Host "npm ci falhou" -ForegroundColor Red; exit 1 }

# 3. Typecheck
Write-Host "`n[3/6] Typecheck..." -ForegroundColor Yellow
npm run typecheck
if ($LASTEXITCODE -ne 0) { Write-Host "Typecheck falhou" -ForegroundColor Red; exit 1 }

# 4. Lint
Write-Host "`n[4/6] Lint..." -ForegroundColor Yellow
npm run lint
if ($LASTEXITCODE -ne 0) { Write-Host "Lint falhou" -ForegroundColor Red; exit 1 }

# 5. Unit tests
Write-Host "`n[5/6] Unit tests..." -ForegroundColor Yellow
npm run test:unit
if ($LASTEXITCODE -ne 0) { Write-Host "Unit tests falharam" -ForegroundColor Red; exit 1 }

# 6. Build Tauri
Write-Host "`n[6/6] Tauri build (isso pode demorar varios minutos)..." -ForegroundColor Yellow
npm run tauri:build
if ($LASTEXITCODE -ne 0) { Write-Host "Tauri build falhou" -ForegroundColor Red; exit 1 }

# Resultado
Write-Host "`n=== BUILD CONCLUIDO ===" -ForegroundColor Green
$bundle = "src-tauri\target\release\bundle"
Write-Host "Instaladores em: $bundle" -ForegroundColor Cyan
Get-ChildItem -Path $bundle -Recurse -Include *.exe,*.msi,*.AppImage,*.deb,*.apk -ErrorAction SilentlyContinue | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    Write-Host "  $($_.Name)  sha256:$hash  ($([math]::Round($_.Length/1MB,2)) MB)"
}
