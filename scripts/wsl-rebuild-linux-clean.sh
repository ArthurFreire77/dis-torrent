#!/bin/bash
# Rebuild LIMPO dos artefatos Linux da tag v1.1.68, a partir de um worktree que
# esta exatamente no commit da tag (sem edicoes de outro agente no meio).
#
# Roda via setsid para sobreviver ao restart do servidor do agente: sem isso o
# build morre no meio quando a sessao cai.
set -e
WT=/mnt/c/Users/lucas/AppData/Local/Temp/dt-clean-168
LOG=/tmp/rebuild-linux-168.log
cd "$WT"
export PATH="$HOME/.cargo/bin:$PATH"
export CI=true

exec > >(tee -a "$LOG") 2>&1

echo "=== inicio $(date -Is) ==="
echo "=== HEAD: $(git rev-parse HEAD) ==="
echo "=== arquivos sujos: $(git status --porcelain | wc -l) ==="

if [ ! -d node_modules ]; then
  echo "=== npm ci ==="
  npm ci --no-audit --no-fund
fi

echo "=== frontend ==="
npm run build

echo "=== tauri build (deb, appimage) ==="
npm run tauri build -- --bundles deb,appimage

echo "=== artefatos ==="
find src-tauri/target/release/bundle -maxdepth 2 \( -name '*.deb' -o -name '*.AppImage' \) -printf '%p  %s bytes\n'
echo "=== fim $(date -Is) ==="
touch /tmp/rebuild-linux-168.done
