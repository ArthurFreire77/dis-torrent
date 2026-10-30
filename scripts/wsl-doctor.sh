#!/bin/bash
# Diagnóstico do ambiente do WSL para o build Linux (deb/AppImage).
#
# POR QUE EXISTE: o `tauri build` no Linux depende de utilitários básicos
# (`sed`, `dirname`, `uname`) que o wrapper em `node_modules/.bin/tauri` usa no
# shebang. Neste WSL eles não existem, e o build falhava com "sed: not found"
# em vez de dizer qual peça falta. Este script responde isso em uma linha.
for c in sed dirname uname node npm npx cargo rustc gcc pkg-config dpkg-deb wget curl tar gzip file; do
  if command -v "$c" >/dev/null 2>&1; then
    echo "OK    $c -> $(command -v "$c")"
  else
    echo "FALTA $c"
  fi
done
echo "---"
echo "PATH=$PATH"
