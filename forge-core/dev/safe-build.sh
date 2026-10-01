#!/usr/bin/env bash
# Build travado: teto de RAM + 1 job + nice. Nenhum build pode derrubar a maquina.
# Uso: safe-build <dir-do-crate> [args do cargo...]
set -uo pipefail

DIR="$1"; shift
LIMIT_GB="${FORGE_MEM_LIMIT_GB:-3}"

# 1) Aborta se nao houver folga. Abaixo de 2 GB livres, compilar e o que travou
#    a maquina da outra vez.
FREE_MB=$(free -m | awk '/^Mem/ {print $7}')
if [ "${FREE_MB:-0}" -lt 2000 ]; then
  echo "[safe-build] ABORTADO: RAM livre ${FREE_MB} MB (< 2000). Nada compilado."
  exit 3
fi
echo "[safe-build] RAM livre: ${FREE_MB} MB — prosseguindo (teto ${LIMIT_GB} GB, 1 job)"

# 2) Compila dentro de um scope com MemoryMax. Se estourar o teto, o OOM killer
#    mata SO o build, e nao o sistema inteiro.
cd "$DIR" || exit 1
if command -v systemd-run >/dev/null 2>&1; then
  # `Nice=` NAO e' uma propriedade valida de --scope neste systemd
  # ("Unknown assignment: Nice=19" aborta o build inteiro). A garantia de
  # prioridade continua: o nice e' aplicado DENTRO do scope, pelo proprio cargo.
  systemd-run --user --scope -p "MemoryMax=${LIMIT_GB}G" -p "MemorySwapMax=4G" -- \
    env CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=1 \
    nice -n 19 cargo "$@"
  rc=$?
else
  echo "[safe-build] systemd-run indisponivel; usando nice -j1"
  env CARGO_BUILD_JOBS=1 nice -n 19 cargo "$@"
  rc=$?
fi

FREE_MB2=$(free -m | awk '/^Mem/ {print $7}')
echo "[safe-build] terminou (rc=$rc). RAM livre agora: ${FREE_MB2} MB"
exit $rc
