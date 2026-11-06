# Atalho do skill distorrent-app: chama o controlador CDP com o Node portatil.
# Nao fecha nem move nada: cada acao e explicita no comando.
param(
  [Parameter(Position = 0)][string]$Command = 'status',
  [Parameter(Position = 1)][string]$Arg1,
  [Parameter(Position = 2)][string]$Arg2
)

$ErrorActionPreference = 'Stop'
$node = Join-Path $env:TEMP 'node24/node-v24.22.1-win-x64'
if (Test-Path (Join-Path $node 'node.exe')) { $env:PATH = "$node;$env:PATH" }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'app.mjs'

if ($Command -eq 'kill') {
  # Fecha o app: quem chama tem de avisar o usuario antes.
  & node $script kill @($Arg1, $Arg2 | Where-Object { $_ })
  exit $LASTEXITCODE
}

& node $script $Command @($Arg1, $Arg2 | Where-Object { $_ })
exit $LASTEXITCODE
