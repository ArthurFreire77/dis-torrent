#!/bin/bash
# Build Linux (.deb + .AppImage) do DisTorrent dentro do WSL.
set -e
cd /mnt/e/Programas/dis-torrent
export PATH="$HOME/.cargo/bin:$PATH"
export CI=true

echo "=== versao ==="
node -p "require('./package.json').version"

echo "=== tauri build (deb, appimage) ==="
npm run tauri build -- --bundles deb,appimage

echo "=== artefatos ==="
ls -la src-tauri/target/release/bundle/deb/*1.1.41* src-tauri/target/release/bundle/appimage/*1.1.41* || true
