#!/bin/bash
# Monta o bundle Linux (.deb + .AppImage) dentro do WSL.
#
# ARMADILHAS que este script resolve (todas custaram uma tentativa perdida):
#   1. `bash -lc` e' LOGIN shell e RESETA o PATH: o `export PATH=...` que vem
#      antes dele no comando e' descartado e o `cargo` some. Por isso o PATH e'
#      montado AQUI, depois do shell ja estar aberto.
#   2. `node_modules/.bin/tauri` e' um wrapper `sh` que chama `sed`/`dirname`/
#      `uname`; se o PATH estiver quebrado ele falha com "sed: not found" e
#      esconde a causa. Chamamos o JS do CLI com `node` direto.
#   3. O CLI do Tauri e' um binario NATIVO por plataforma: no Windows o npm
#      instala `cli-win32-x64-msvc`; no WSL ele precisa de
#      `cli-linux-x64-gnu`. Sem isso o `main.js` procura um binario que nao
#      existe e o build morre.
set -e

cd /mnt/e/Programas/dis-torrent
export PATH="/root/.cargo/bin:$PATH"

echo "== ambiente =="
command -v node cargo dpkg-deb

if [ ! -d node_modules/@tauri-apps/cli-linux-x64-gnu ]; then
  echo "== instalando CLI do Tauri para linux =="
  npm install --no-save --no-package-lock @tauri-apps/cli-linux-x64-gnu@2.12.1
fi

echo "== build do frontend =="
npm run build

echo "== bundle linux (deb + appimage) =="
node node_modules/@tauri-apps/cli/tauri.js build --bundles deb,appimage

echo "== resultado =="
ls -la src-tauri/target/release/bundle/deb/ src-tauri/target/release/bundle/appimage/
