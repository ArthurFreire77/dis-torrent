# Instalações — DisTorrent 0.2

Build de 30/09/2026, com as correções de chamada atrás de CGNAT, de proxy e de
tela compartilhada. Detalhes no `CHANGELOG.md`, seções 5.4.2 e 5.4.3.

| Arquivo | Tamanho | Plataforma | Estado |
|---|---|---|---|
| `DisTorrent_0.2_amd64.deb` | 10,0 MB | Linux x86_64 | assinado por pacote Debian, **instalado** |
| `DisTorrent_0.2_arm64.apk` | 20,9 MB | Android arm64 | **ASSINADO** — instala |

Os dois arquivos recebem o rótulo `0.2` para ficarem mais fáceis de distinguir,
mas a **versão real do pacote é 1.0.2** (é o que o `dpkg` e o Android enxergam).

## Instalar o .deb

```bash
sudo apt install "./instalações/DisTorrent_0.2_amd64.deb"
```

## Instalar o APK — LEIA ANTES

O APK é assinado com `android-keystore/forge-release-v3.jks`, um keystore
**novo** (criado em 30/09/2026, alias `forge`, senha em
`~/.config/opencode/AGENTS.md`). As chaves antigas `forge-release.jks` e
`forge-release-v2.jks` têm senha desconhecida e não abrem.

**Consequência: o Android recusa atualizar por cima da v1.** São certificados
diferentes (v1: SHA-256 `69117a25…`; esta: `667d56b7…`), e isso é conflito de
assinatura — o Android não deixa. É preciso **desinstalar a v1 antes**:

```bash
adb uninstall com.forge.app
adb install "instalações/DisTorrent_0.2_arm64.apk"
```

**Aviso honesto:** desinstalar apaga os dados locais do app — identidade
ed25519, histórico, conversas, e o cofre (que sem a senha é irrecuperável).
Se você tem a mnemonic exportada, dá para recuperar. **Exporte a mnemonic
antes** de desinstalar, ou não desinstale ainda.

Da primeira instalação com o `v3` em diante, todo update é direto: basta
instalar o APK novo por cima.

## Sobre o "20 MB"

O APK tem 20,9 MB porque embute o frontend React compilado **dentro** do
`libforge_lib.so` (18,3 MB de lib nativa) — não é o bundle da interface. Não há
como reduzir sem trocar a engine de WebRTC ou fazer split por ABI.

