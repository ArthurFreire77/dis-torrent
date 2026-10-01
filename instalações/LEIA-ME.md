# Instalações — DisTorrent 2.1

Build de 01/10/2026. Inclui a correção do "conectando infinito" (watchdogs de
outgoing/incoming/connecting + promoção por sinalização/mídia), vídeo
adaptativo com piso 480p e teto 120 FPS, e painel de diagnóstico da chamada
em tempo real com causa técnica da falha.

| Arquivo | Tamanho | Plataforma | Estado |
|---|---|---|---|
| `DisTorrent_2.1_amd64.deb` | 12,8 MB | Linux x86_64 | pacote Debian |
| `DisTorrent_2.1_arm64.apk` | 21,5 MB | Android arm64 | **ASSINADO** — instala |

A **versão real do pacote é 2.1.0** (é o que o `dpkg` e o Android enxergam).

## Instalar o .deb

```bash
sudo apt install "./instalações/DisTorrent_2.1_amd64.deb"
```

## Instalar o APK

Assinado com o mesmo keystore v3 (`667d56b7…`), então **atualiza por cima
da 2.0 direto**, sem desinstalar:

```bash
adb install "instalações/DisTorrent_2.1_arm64.apk"
```

Quem ainda está na v1 precisa desinstalar antes (conflito de assinatura
v1/v3):

```bash
adb uninstall com.forge.app
adb install "instalações/DisTorrent_2.1_arm64.apk"
```

**Aviso honesto:** desinstalar apaga os dados locais do app — identidade
ed25519, histórico, conversas, e o cofre (que sem a senha é irrecuperável).
Se você tem a mnemonic exportada, dá para recuperar. **Exporte a mnemonic
antes** de desinstalar, ou não desinstale ainda.

Da primeira instalação com o `v3` em diante, todo update é direto: basta
instalar o APK novo por cima.

## Sobre o tamanho do APK

O APK tem ~21 MB porque embute o frontend React compilado **dentro** do
`libforge_lib.so` — não é o bundle da interface. Não há como reduzir sem
trocar a engine de WebRTC ou fazer split por ABI.
