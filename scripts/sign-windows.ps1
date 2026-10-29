# === DisTorrent — assinatura de código no Windows (signtool) ===
#
# Uso:
#   .\scripts\sign-windows.ps1 -File caminho\distorrent.exe
#   .\scripts\sign-windows.ps1 -File caminho\DisTorrent_..._setup.exe -Verify
#
# POR QUE ESTE SCRIPT EXISTE:
# o instalador do DisTorrent não é assinado (Get-AuthenticodeSignature =
# NotSigned). Sem assinatura, o SmartScreen depende só de reputação acumulada e
# o usuário vê "editor desconhecido". Assinar com um certificado de code
# signing resolve isso de verdade — diferente de "esperar a reputação subir".
#
# CONFIGURAÇÃO (uma das duas formas, via variáveis de ambiente — nunca por
# parâmetro na linha de comando, que fica no histórico do PowerShell):
#
#   A) Arquivo PFX:
#      $env:DISTORRENT_SIGN_PFX       = "C:\caminho\certificado.pfx"
#      $env:DISTORRENT_SIGN_PASSWORD  = "..."   # só na sessão, nunca no repo
#
#   B) Certificado já instalado no repositório do usuário (store "My"):
#      $env:DISTORRENT_SIGN_THUMBPRINT = "A1B2C3..."  # sha1 do certificado
#
# Opcional:
#   $env:DISTORRENT_SIGN_TIMESTAMP  = "http://timestamp.digicert.com"
#   (default: http://timestamp.digicert.com — timestamps RFC 3161)
#
# SEM CERTIFICADO CONFIGURADO o script NÃO falha: imprime
# "sem certificado configurado — pulando assinatura" e sai com 0. É o
# comportamento que o build precisa (build local/CI sem segredo continua
# gerando instalador; a assinatura é um upgrade, não um pré-requisito).
#
# SEGURANÇA (por que o PFX é importado em vez de usar `/p`):
# o signtool NÃO lê senha de variável de ambiente — a única forma nativa é
# `/p <senha>` em argv, e argv é visível a outros processos
# (Get-CimInstance Win32_Process) e aos logs do CI. Então o script importa o
# PFX para a store do USUÁRIO (`Import-PfxCertificate`, senha via SecureString
# só em memória), assina pelo thumbprint e remove o certificado no finally.
# - nenhuma senha é escrita em arquivo, log ou mensagem de erro;
# - o PFX nunca é copiado para o repositório (use caminho absoluto fora dele);
# - o certificado temporário importado é removido mesmo se a assinatura falhar.
#
# EXIT CODES:
#   0 = assinado com sucesso, ou pulado por falta de certificado
#   1 = certificado configurado mas a assinatura falhou (erro de verdade)
#   2 = arquivo inexistente / signtool ausente / configuração inválida

param(
    [Parameter(Mandatory = $true)]
    [string]$File,

    # Confere a assinatura de um arquivo já assinado (não assina nada).
    [switch]$Verify,

    # Caminho do signtool.exe. Se omitido, procura no PATH e no Windows SDK.
    [string]$SignTool,

    # SHA256 do certificado (mais forte que o thumbprint SHA1) quando se usa
    # a store do usuário. Opcional.
    [string]$CertificateSha256
)

$ErrorActionPreference = "Stop"

function Fail([string]$msg, [int]$code = 2) {
    Write-Host "FALHOU: $msg" -ForegroundColor Red
    exit $code
}

function Info([string]$msg) {
    Write-Host "  $msg" -ForegroundColor DarkGray
}

# --- signtool: procura no PATH e no Windows SDK ---
function Find-SignTool {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { Fail "signtool não encontrado em '$Explicit'." }
        return (Resolve-Path $Explicit).Path
    }

    # O signtool vem com o Windows SDK. Em runner de CI (windows-latest) ele
    # costuma estar no PATH; em máquina de dev, só na pasta do SDK.
    $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    $kitsRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
    if (Test-Path $kitsRoot) {
        # Versão mais recente que tenha signtool para x64.
        $candidate = Get-ChildItem $kitsRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($candidate) { return $candidate }
    }

    return $null
}

# --- Verificação de assinatura existente ---
if ($Verify) {
    if (-not (Test-Path $File)) { Fail "arquivo não existe: $File" }
    $sig = Get-AuthenticodeSignature -FilePath $File
    $sha = (Get-FileHash $File -Algorithm SHA256).Hash.ToLower()
    Write-Host ("Arquivo : {0}" -f (Resolve-Path $File).Path)
    Write-Host ("SHA256  : {0}" -f $sha)
    Write-Host ("Status  : {0}" -f $sig.Status)
    if ($sig.SignerCertificate) {
        Write-Host ("Signer  : {0}" -f $sig.SignerCertificate.Subject)
        Write-Host ("Emissor : {0}" -f $sig.SignerCertificate.Issuer)
        Write-Host ("Valido  : {0} -> {1}" -f $sig.SignerCertificate.NotBefore.ToString("yyyy-MM-dd"), $sig.SignerCertificate.NotAfter.ToString("yyyy-MM-dd"))
        Write-Host ("Thumb   : {0}" -f $sig.SignerCertificate.Thumbprint)
    }
    if ($sig.Status -ne "Valid") {
        Write-Host "Assinatura ausente ou inválida (esperado enquanto não houver certificado)." -ForegroundColor Yellow
        # -Verify é diagnóstico: sai 0 mesmo NotSigned para não quebrar quem só
        # quer RELATAR o estado. Quem exige assinatura inspeciona o texto acima.
        exit 0
    }
    Write-Host "Assinatura válida." -ForegroundColor Green
    exit 0
}

# --- Arquivo alvo ---
if (-not (Test-Path $File)) { Fail "arquivo não existe: $File" }
$target = (Resolve-Path $File).Path

# --- Configuração do certificado ---
$pfx = $env:DISTORRENT_SIGN_PFX
$pfxPassword = $env:DISTORRENT_SIGN_PASSWORD
$thumbprint = $env:DISTORRENT_SIGN_THUMBPRINT
$timestamp = $env:DISTORRENT_SIGN_TIMESTAMP
if ([string]::IsNullOrWhiteSpace($timestamp)) { $timestamp = "http://timestamp.digicert.com" }

$hasPfx = -not [string]::IsNullOrWhiteSpace($pfx)
$hasThumb = (-not [string]::IsNullOrWhiteSpace($thumbprint)) -or
            (-not [string]::IsNullOrWhiteSpace($CertificateSha256))

if (-not $hasPfx -and -not $hasThumb) {
    Write-Host "sem certificado configurado — pulando assinatura" -ForegroundColor Yellow
    Info "defina DISTORRENT_SIGN_PFX + DISTORRENT_SIGN_PASSWORD ou DISTORRENT_SIGN_THUMBPRINT para assinar"
    Info "arquivo: $target"
    exit 0
}

$signToolPath = Find-SignTool -Explicit $SignTool
if (-not $signToolPath) {
    Fail "signtool.exe não encontrado (Windows SDK instalado? passe -SignTool <caminho>)."
}
Info "signtool: $signToolPath"

$importedThumbprint = $null
try {
    # --- Resolve o thumbprint; importa o PFX só em memória -> store do usuário ---
    if ($hasPfx) {
        if (-not (Test-Path $pfx)) { Fail "DISTORRENT_SIGN_PFX aponta para arquivo inexistente." }
        if ([string]::IsNullOrEmpty($pfxPassword)) {
            Fail "DISTORRENT_SIGN_PFX definido mas DISTORRENT_SIGN_PASSWORD está vazio."
        }
        $secure = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
        Write-Host "Importando PFX temporariamente no repositório do usuário..." -ForegroundColor Cyan
        # Thumbprints que JÁ existiam: se o PFX for de um certificado que o
        # usuário já tem instalado, Import-PfxCertificate devolve o existente.
        # Sem esta checagem o finally apagaria um certificado do usuário —
        # destrutivo e silencioso.
        $before = @{}
        Get-ChildItem "Cert:\CurrentUser\My" -ErrorAction SilentlyContinue | ForEach-Object {
            $before[$_.Thumbprint] = $true
        }
        # `-Exportable` NÃO é necessário e é recusado por muitos PFX: omitido.
        # O certificado entra em CurrentUser\My e sai no finally.
        try {
            $imported = Import-PfxCertificate -FilePath (Resolve-Path $pfx).Path `
                -CertStoreLocation "Cert:\CurrentUser\My" -Password $secure
        } catch {
            # Mensagem sem o conteúdo da exceção do .NET: em alguns erros ela
            # repete dados do arquivo, e não queremos nada de senha em log.
            Fail "não foi possível importar o PFX (arquivo inválido ou senha incorreta)." 2
        }
        if ($before.ContainsKey($imported.Thumbprint)) {
            Info "certificado já existia na store do usuário (não será removido)"
            $importedThumbprint = $null
        } else {
            $importedThumbprint = $imported.Thumbprint
            Info "thumbprint temporário: $importedThumbprint"
        }
        $certThumb = $imported.Thumbprint
    } elseif ($CertificateSha256) {
        # `signtool /sha1` espera o THUMBPRINT (hash SHA1). Para aceitar um
        # SHA256 sem inventar uma flag nova do signtool, resolvemos o SHA256
        # para o thumbprint olhando a store do usuário.
        $normalized = $CertificateSha256 -replace '[^0-9A-Fa-f]', ''
        $found = Get-ChildItem "Cert:\CurrentUser\My" -ErrorAction SilentlyContinue |
            Where-Object { $_.GetCertHashString('SHA256') -eq $normalized } |
            Select-Object -First 1
        if (-not $found) {
            Fail "nenhum certificado na store do usuário (CurrentUser\My) com SHA256 $normalized." 2
        }
        $certThumb = $found.Thumbprint
        Info "thumbprint do cert (SHA256 informado): $certThumb"
    } else {
        $certThumb = $thumbprint
    }

    # --- Monta os argumentos (sem senha em argv) ---
    $signArgs = @(
        "sign",
        "/fd", "SHA256",          # digest do arquivo
        "/td", "SHA256",          # digest do timestamp (RFC 3161)
        "/tr", $timestamp,
        "/sha1", $certThumb,      # thumbprint do cert (SHA1); /sha1 é o nome
                                  # histórico do parâmetro, não o algoritmo do digest
        "/v",
        $target
    )

    Write-Host "Assinando (SHA256 + timestamp RFC3161)..." -ForegroundColor Cyan
    # `$ErrorActionPreference = 'Stop'` faz o PowerShell 5.1 transformar
    # stderr de comando nativo em erro TERMINANTE quando a saída é capturada —
    # e o signtool escreve avisos em stderr. Sem este guarda o script morreria
    # ANTES de ler `$LASTEXITCODE`, e o build reportaria "falha na assinatura"
    # por um aviso banal.
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $signToolPath @signArgs
        $signExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }

    if ($signExit -ne 0) {
        Fail "signtool falhou (exit $signExit). Confira o certificado e o servidor de timestamp." 1
    }

    # Confere o resultado em vez de confiar só no exit code do signtool.
    $sig = Get-AuthenticodeSignature -FilePath $target
    if ($sig.Status -ne "Valid") {
        Fail "signtool saiu 0 mas a assinatura não valida (status: $($sig.Status))." 1
    }

    $sha = (Get-FileHash $target -Algorithm SHA256).Hash.ToLower()
    Write-Host "Assinado: $target" -ForegroundColor Green
    Write-Host ("SHA256  : {0}" -f $sha)
    Write-Host ("Signer  : {0}" -f $sig.SignerCertificate.Subject)
} finally {
    # Zera as cópias LOCAIS da senha (best-effort; String no .NET não é
    # zeroizável). NÃO removemos `DISTORRENT_SIGN_PASSWORD` do ambiente: este
    # script é chamado com `&` pelo build-installer.ps1, no MESMO processo, e
    # ele precisa da variável para assinar o segundo artefato. Apagar o env aqui
    # fazia a assinatura do instalador falhar com "senha vazia" — bug real
    # observado em teste.
    $pfxPassword = $null
    $secure = $null
    # Remove o certificado que ESTE script importou. Um cert pré-existente do
    # usuário (DISTORRENT_SIGN_THUMBPRINT) nunca é tocado.
    if ($importedThumbprint) {
        $importedPath = "Cert:\CurrentUser\My\$importedThumbprint"
        if (Test-Path $importedPath) {
            Remove-Item $importedPath -Force -ErrorAction SilentlyContinue
            Info "certificado temporário removido da store"
        }
    }
}

exit 0
