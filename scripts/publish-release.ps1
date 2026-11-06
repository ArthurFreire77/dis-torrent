# Publica a release v1.1.61: cria (se preciso) e sobe os assets informados.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-release.ps1 -Tag v1.1.61 -NotesFile <arquivo> -Assets <a>,<b>
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$NotesFile,
    [Parameter(Mandatory = $true)][string[]]$Assets,
    [string]$Name = ''
)

$ErrorActionPreference = 'Stop'
$repo = 'ArthurFreire77/dis-torrent'

$cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
$token = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $token) { throw 'sem credencial do git para o github.com' }

$h = @{
    Authorization          = "Bearer $token"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}
$api = "https://api.github.com/repos/$repo"

# Resolve o id pela TAG a cada execucao. Fixar o id foi o que subiu a 1.1.45
# para a 1.1.44 e obrigou a apagar assets de uma release publicada.
$rel = $null
try {
    $rel = Invoke-RestMethod -Uri "$api/releases/tags/$Tag" -Headers $h -Method Get
    Write-Host "release existente: id=$($rel.id)"
}
catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -ne 404) { throw }
    Write-Host "release $Tag nao existe; criando..."
    $body = @{
        tag_name         = $Tag
        target_commitish = (git rev-parse HEAD)
        name             = if ($Name) { $Name } else { "DisTorrent $Tag" }
        body             = (Get-Content $NotesFile -Raw -Encoding UTF8)
        draft            = $false
        prerelease       = $false
    } | ConvertTo-Json -Depth 4
    $rel = Invoke-RestMethod -Uri "$api/releases" -Headers $h -Method Post -Body $body -ContentType 'application/json'
    Write-Host "release criada: id=$($rel.id) latest=$($rel.html_url)"
}

$existentes = @{}
foreach ($a in $rel.assets) { $existentes[$a.name] = $a.id }

foreach ($path in $Assets) {
    if (-not (Test-Path $path)) { throw "asset nao encontrado: $path" }
    $item = Get-Item $path
    $nome = $item.Name
    if ($existentes.ContainsKey($nome)) {
        Write-Host "ja publicado, pulando: $nome"
        continue
    }
    $sha = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
    Write-Host ("subindo {0} ({1:N1} MB) sha256={2}" -f $nome, ($item.Length / 1MB), $sha)
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $up = "https://uploads.github.com/repos/$repo/releases/$($rel.id)/assets?name=$([uri]::EscapeDataString($nome))"
    $res = Invoke-RestMethod -Uri $up -Headers $h -Method Post -Body $bytes -ContentType 'application/octet-stream'
    Write-Host "  ok: id=$($res.id) state=$($res.state) digest=$($res.digest)"
}

# Conferencia final: a release publicada tem de listar os assets com digest.
$final = Invoke-RestMethod -Uri "$api/releases/tags/$Tag" -Headers $h -Method Get
Write-Host ''
Write-Host "== $($final.name) =="
Write-Host "url: $($final.html_url)"
foreach ($a in $final.assets) {
    Write-Host ("  {0,-52} {1,9:N1} MB  {2}" -f $a.name, ($a.size / 1MB), $a.digest)
}
