# Sobe assets extras numa release existente (o publish-release.ps1 aceita um
# numero limitado de extra assets pelo binding do PowerShell).
param(
    [string]$Tag = 'v1.1.17',
    [string[]]$Files = @()
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

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
$rel = Invoke-RestMethod -Uri "$api/releases/tags/$Tag" -Headers $headers
$releaseId = $rel.id
Write-Host "release $Tag (id=$releaseId)"

foreach ($path in $Files) {
    if (-not (Test-Path $path)) { throw "asset nao encontrado: $path" }
    $nome = Split-Path $path -Leaf
    $assets = Invoke-RestMethod -Uri "$api/releases/$releaseId/assets" -Headers $headers
    $atual = @($assets) | Where-Object { $_.name -eq $nome } | Select-Object -First 1
    if ($atual) {
        Write-Host "  $nome ja existia - removendo"
        Invoke-RestMethod -Uri "$api/releases/assets/$($atual.id)" -Method Delete -Headers $headers | Out-Null
    }
    $url = "https://uploads.github.com/repos/ArthurFreire77/dis-torrent/releases/$releaseId/assets?name=$([uri]::EscapeDataString($nome))"
    $tamanho = [math]::Round((Get-Item $path).Length / 1MB, 2)
    Write-Host "  subindo $nome ($tamanho MB)"
    $out = "$env:TEMP\gh-upload-extra.json"
    $code = 0
    for ($t = 1; $t -le 3; $t++) {
        & curl.exe -sS -X POST -H "Authorization: Bearer $tok" `
            -H 'Accept: application/vnd.github+json' -H 'User-Agent: distorrent-release' `
            -H 'Content-Type: application/octet-stream' `
            --data-binary "@$path" --max-time 3600 -o $out -w '%{http_code}' $url | Out-Null
        $code = $LASTEXITCODE
        $resp = Get-Content $out -Raw -ErrorAction SilentlyContinue
        if ($code -eq 0 -and $resp -match '"name"') {
            $info = $resp | ConvertFrom-Json
            Write-Host "    -> $($info.name) $([math]::Round($info.size/1MB,2)) MB digest=$($info.digest)"
            break
        }
        Write-Host "    tentativa $t falhou"
    }
    if ($code -ne 0) { throw "upload de $nome falhou" }
}
