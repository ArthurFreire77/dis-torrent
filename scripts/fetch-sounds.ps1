# Script: baixa os efeitos sonoros CC0/CC-BY/domínio público para src-tauri/sounds/.
#
# POR QUE um script e não arquivos soltos: a procedência e a licença precisam
# ficar registradas junto do binário. O manifesto gerado (SOURCES.json) é
# conferido por teste — som sem licença registrada não entra no app.
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $repo 'src-tauri\sounds'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Cada entrada: nome local e o título exato no Wikimedia Commons.
$alvos = @(
  @{ file = 'applause.ogg'; title = 'File:Applause i.ogg' },
  @{ file = 'clapping.ogg'; title = 'File:Clapping hurray.ogg' },
  @{ file = 'rimshot.wav';  title = 'File:Kevin MacLeod assorted rimshots - Bah-dum.wav' },
  @{ file = 'coin.mp3';     title = 'File:Coins 1 (Gravity Sound).mp3' },
  @{ file = 'airhorn.ogg';  title = 'File:Sound of American Train Horn Nathan Airchime K5LA.ogg' }
)

$api = 'https://commons.wikimedia.org/w/api.php'
# Wikimedia exige UA identificável; sem isto responde 429 e o download falha.
$ua = 'DisTorrentBot/1.0 (https://github.com/ArthurFreire77/dis-torrent; sounds-download) PowerShell'
$headers = @{ 'User-Agent' = $ua; 'Accept' = 'application/json' }

function Get-CommonsInfo($title) {
  $t = [uri]::EscapeDataString($title)
  $q = "${api}?action=query&format=json&titles=${t}&prop=imageinfo&iiprop=url%7Cextmetadata%7Csize"
  $r = Invoke-RestMethod -Uri $q -Headers $headers -TimeoutSec 30
  $page = $r.query.pages.PSObject.Properties.Value | Select-Object -First 1
  if (-not $page.imageinfo) { throw "sem imageinfo para $title" }
  $ii = $page.imageinfo[0]
  [pscustomobject]@{
    url     = $ii.url
    license = $ii.extmetadata.LicenseShortName.value
    artist  = ($ii.extmetadata.Artist.value -replace '<[^>]+>', '').Trim()
    page    = $ii.descriptionurl
  }
}

$manifesto = @()
foreach ($a in $alvos) {
  $info = Get-CommonsInfo $a.title
  if ($info.license -notmatch '^(CC0|CC BY|Public domain)') {
    throw "licença não permitida para $($a.title): $($info.license)"
  }
  $out = Join-Path $dest $a.file
  if ((Test-Path $out) -and -not $Force) {
    Write-Host "ja existe: $($a.file)"
  } else {
    Invoke-WebRequest -Uri $info.url -OutFile $out -Headers $headers -TimeoutSec 120
    Start-Sleep -Milliseconds 600
    Write-Host "baixado: $($a.file) ($([math]::Round((Get-Item $out).Length/1024)) KB) - $($info.license)"
  }
  $manifesto += [pscustomobject]@{
    file    = $a.file
    title   = $a.title
    url     = $info.url
    page    = $info.page
    license = $info.license
    artist  = $info.artist
    bytes   = (Get-Item $out).Length
  }
}

$json = ConvertTo-Json $manifesto -Depth 4
[IO.File]::WriteAllText((Join-Path $dest 'SOURCES.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "manifesto: src-tauri/sounds/SOURCES.json ($($manifesto.Count) sons)"
