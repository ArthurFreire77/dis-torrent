#!/bin/bash
# Build Linux (.deb + .AppImage) do DisTorrent dentro do WSL.
# Le a versao do package.json; antes o script tinha "1.1.43" fixo e falhava em
# silencio (o `|| true` no ls escondia o artefato com o nome errado).
set -e
cd /mnt/e/Programas/dis-torrent
export PATH="$HOME/.cargo/bin:$PATH"
export CI=true
VER=$(node -p "require('./package.json').version")
echo "=== versao: $VER ==="

# O node_modules pode ter sido instalado no Windows e vir sem o binario do CLI
# para Linux; sem isto o `tauri build` morre com "Cannot find native binding".
echo "=== deps do tauri-cli para linux ==="
if [ ! -d node_modules/@tauri-apps/cli-linux-x64-gnu ]; then
  npm i --no-save --no-audit --no-fund @tauri-apps/cli-linux-x64-gnu@2.12.4
fi

echo "=== frontend ==="
npm run build

echo "=== tauri build (deb, appimage) ==="
npm run tauri build -- --bundles deb,appimage

echo "=== artefatos ==="
find src-tauri/target/release/bundle -maxdepth 2 -name "*${VER}*" -printf '%p  %s bytes\n'
