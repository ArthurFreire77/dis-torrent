# Cria a release 1.1.12 e sobe os assets.
#
# POR QUE SCRIPT: o corpo da release e' markdown longo, com acentos e blocos de
# codigo. Passar isso por linha de comando (ou por ConvertTo-Json de um
# Get-Content -Raw) corrompe a codificacao e o `body` chega como OBJETO em vez
# de string - foi o 422 da primeira tentativa. Aqui leio os bytes em UTF-8 e
# monto o JSON sobre uma string de verdade.
#
# Mantido ASCII puro de proposito: PowerShell 5.1 le .ps1 como ANSI quando nao
# ha BOM, e qualquer acento em string literal volta corrompido.

param(
    [string]$Tag = 'v1.1.12',
    [string]$Name = 'DisTorrent 1.1.12-pre-alpha',
    [string]$BodyFile = "$env:TEMP\opencode\release-body.md",
    [string]$Setup,
    [string[]]$ExtraAssets = @(),
    # Pula a conferencia de versao entre package.json/tauri.conf.json/Cargo.toml.
    # NUNCA use em release de verdade: e' justamente essa conferencia que evita
    # o app achar que ja esta atualizado (ou baixar o mesmo binario em loop).
    [switch]$SkipVersionCheck
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot

# --- 0) Versao consistente ANTES de publicar -------------------------------
# O `update_check` do Rust recusa o asset quando a versao no NOME do instalador
# nao bate com a TAG (`label_mismatch`) e o frontend compara com a versao que o
# app reporta (`tauri.conf.json`). Se esses numeros divergirem, a atualizacao
# nao aparece, aparece eternamente, ou entra em loop de reinstalar o mesmo
# binario. Conferimos aqui para falhar ANTES de criar a release.
if (-not $SkipVersionCheck) {
    $pkgVersion = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    $confVersion = (Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
    $cargoRaw = Get-Content (Join-Path $root 'src-tauri\Cargo.toml') -Raw
    $cargoMatch = [regex]::Match($cargoRaw, '(?m)^version\s*=\s*"([^"]+)"')
    $cargoVersion = if ($cargoMatch.Success) { $cargoMatch.Groups[1].Value } else { '' }

    if ($confVersion -ne $pkgVersion -or $cargoVersion -ne $pkgVersion) {
        throw "versoes divergentes: package.json=$pkgVersion tauri.conf.json=$confVersion Cargo.toml=$cargoVersion - iguale antes de publicar"
    }
    # A tag tem de ser a versao do app (sem o sufixo de pre-release).
    if ($Tag -ne ("v" + ($pkgVersion -split '-')[0])) {
        throw "tag '$Tag' nao corresponde a versao '$pkgVersion' (esperado v$((($pkgVersion -split '-')[0])))"
    }
    # E o instalador, se informado, precisa citar a MESMA versao no nome.
    if ($Setup -and (Test-Path $Setup)) {
        $setupName = Split-Path $Setup -Leaf
        if ($setupName -notlike "*_$($pkgVersion)_*") {
            throw "instalador '$setupName' nao cita a versao $pkgVersion - foi buildado de outra arvore?"
        }
    }
    Write-Host "versao confere: $pkgVersion (tag $Tag)"
}

$cred = "protocol=https`nhost=github.com`n`n" | git credential fill
$tok = ($cred | Select-String '^password=').Line -replace '^password=', ''
if (-not $tok) { throw 'sem credencial do git para o GitHub' }

$headers = @{
    Authorization          = "Bearer $tok"
    Accept                 = 'application/vnd.github+json'
    'User-Agent'           = 'distorrent-release'
    'X-GitHub-Api-Version' = '2022-11-28'
}
$api = 'https://api.github.com/repos/ArthurFreire77/dis-torrent'

# 1) release ja existe para esta tag? (evita o erro `already_exists`)
$existente = $null
try {
    $existente = Invoke-RestMethod -Uri "$api/releases/tags/$Tag" -Headers $headers
} catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
}

if ($existente) {
    $releaseId = $existente.id
    Write-Host "release $Tag ja existia (id=$releaseId) - reutilizando"
} else {
    $body = [System.IO.File]::ReadAllText($BodyFile, [System.Text.Encoding]::UTF8)
    if (-not $body) { throw "corpo da release vazio em $BodyFile" }
    $payload = [ordered]@{
        tag_name   = $Tag
        name       = $Name
        body       = $body
        draft      = $false
        prerelease = $false
    } | ConvertTo-Json -Depth 3 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $r = Invoke-RestMethod -Uri "$api/releases" -Method Post -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8'
    $releaseId = $r.id
    Write-Host "release criada: $($r.tag_name) / $($r.name) (id=$releaseId) prerelease=$($r.prerelease)"
}

# 2) upload dos assets (substitui o de mesmo nome, se houver)
$arquivos = @($Setup) + $ExtraAssets | Where-Object { $_ }
foreach ($path in $arquivos) {
    if (-not (Test-Path $path)) { throw "asset nao encontrado: $path" }
    $nome = Split-Path $path -Leaf

    $assets = Invoke-RestMethod -Uri "$api/releases/$releaseId/assets" -Headers $headers
    $atual = @($assets) | Where-Object { $_.name -eq $nome } | Select-Object -First 1
    if ($atual) {
        Write-Host "  $nome ja estava no release - removendo antes de subir"
        Invoke-RestMethod -Uri "$api/releases/assets/$($atual.id)" -Method Delete -Headers $headers | Out-Null
    }

    $tamanho = [math]::Round((Get-Item $path).Length / 1MB, 2)
    Write-Host "  subindo $nome ($tamanho MB)"
    $url = "https://uploads.github.com/repos/ArthurFreire77/dis-torrent/releases/$releaseId/assets?name=$([uri]::EscapeDataString($nome))"

    # Arquivo grande (>90 MB) derruba o `Invoke-RestMethod` com "conexao
    # subjacente fechada" no meio do envio. O `curl` do sistema retenta melhor e
    # da' diagnostico claro; o RestMethod fica como reserva para maquinas sem ele.
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    $ok = $false
    for ($tentativa = 1; $tentativa -le 3 -and -not $ok; $tentativa++) {
        if ($curl) {
            & $curl.Source -sS -X POST -H "Authorization: Bearer $tok" `
                -H 'Accept: application/vnd.github+json' -H 'User-Agent: distorrent-release' `
                -H 'Content-Type: application/octet-stream' `
                --data-binary "@$path" --max-time 3600 -o "$env:TEMP\gh-upload.json" -w '%{http_code}' $url | Out-Null
            $code = $LASTEXITCODE
            $resp = Get-Content "$env:TEMP\gh-upload.json" -Raw -ErrorAction SilentlyContinue
            if ($code -eq 0 -and $resp -match '"name"') {
                $info = $resp | ConvertFrom-Json
                Write-Host "    -> $($info.name) $([math]::Round($info.size/1MB,2)) MB digest=$($info.digest)"
                $ok = $true
            } else {
                Write-Host "    tentativa $tentativa falhou (curl=$code) - retentando"
            }
        } else {
            try {
                $up = Invoke-RestMethod -Uri $url -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $path -TimeoutSec 1800
                Write-Host "    -> $($up.name) $([math]::Round($up.size/1MB,2)) MB digest=$($up.digest)"
                $ok = $true
            } catch {
                Write-Host "    tentativa $tentativa falhou - retentando"
            }
        }
        if (-not $ok) { Start-Sleep -Seconds (5 * $tentativa) }
    }
    if (-not $ok) { throw "nao foi possivel subir $nome apos 3 tentativas" }
}

# 3) confere o resultado final
$final = Invoke-RestMethod -Uri "$api/releases/tags/$Tag" -Headers $headers
Write-Host ''
Write-Host "RELEASE $($final.tag_name) - prerelease=$($final.prerelease) draft=$($final.draft)"
$final.assets | ForEach-Object { Write-Host "  $($_.name)  $([math]::Round($_.size/1MB,2)) MB  digest=$($_.digest)" }
