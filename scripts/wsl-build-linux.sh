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

echo "=== frontend ==="
npm run build

echo "=== tauri build (deb, appimage) ==="
npm run tauri build -- --bundles deb,appimage

echo "=== artefatos ==="
find src-tauri/target/release/bundle -maxdepth 2 -name "*${VER}*" -printf '%p  %s bytes\n'
