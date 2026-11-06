# Security Policy

> **Propósito educacional.** O DisTorrent é um projeto de estudo de rede P2P e
> não deve ser usado para fins ilegais; o autor não se responsabiliza pelo uso
> indevido. Este documento descreve as garantias reais — não prometa anonimato
> em nome do projeto (ver [`THREAT_MODEL.md`](THREAT_MODEL.md)).

## Reportando uma vulnerabilidade

Abra uma issue marcada como `security` **ou** entre em contato pelo GitHub do projeto. Não reporte por PR público.

## Escopo atual (v1 + camada Storm)

- Identidade ed25519 + fingerprint blake3 (`distorrent-core/src/identity.rs`)
- Handshake/sessão (`distorrent-core/src/net/transport.rs`) — composition: ed25519 transcript + X25519 efêmero + HKDF-SHA256 + ChaCha20Poly1305
- Envelope de mensagem assinado (`distorrent-core/src/protocol.rs`)
- Storage local (`distorrent-core/src/storage.rs`, schema v5: `server_rules`, `audit_log`, `reputation`, `reports`)
- **Storm**: nomes validados (`names.rs` + gate no engine), anti-spam pós-assinatura (`antispam.rs` + `spam_gate`), moderação por servidor com auditoria (`moderation.rs`), Safety Number (`safety_number`), 9 tauri commands — ver [`docs/SECURITY_LAYER.md`](docs/SECURITY_LAYER.md)
- **Reações**: validação e rate limit no receptor (`net/reaction_limit.rs` + `engine.rs`), deduplicação e verificação de mensagem/conversa antes da persistência.
- **Cofre portátil .stormvault v1** (export/import/backup cifrado + modo pânico) — spec em `docs/STORMVAULT.md`, modelo de ameaça em `THREAT_MODEL.md`
- **Autenticidade de releases e builds** (`distorrent-core/src/release/`): manifesto binário canônico assinado 2-de-3, rotação de chaves, piso monotônico de epoch, atestação de build entre peers e quarentena por política — spec em [`docs/RELEASE_TRUST.md`](docs/RELEASE_TRUST.md), contrato do updater em [`docs/UPDATER.md`](docs/UPDATER.md)

## Não escopo (assumido, documentado em THREAT_MODEL.md)

- Anonimato de rede (IP visível a peers)
- Malware no device do usuário
- Acesso físico/local à máquina

## Práticas

- Somente primitivas maduras (RustCrypto, blake3, @noble/*). Nenhuma criptografia própria.
- Chave privada nunca logada, nunca serializada para a UI; keyring do SO com fallback explícito.
- Toda operação sensível validada no core — a UI não é fonte de autorização.

## Autenticidade de releases

A camada nova está em `distorrent-core/src/release/` e tem spec completo em
[`docs/RELEASE_TRUST.md`](docs/RELEASE_TRUST.md); o contrato do atualizador
está em [`docs/UPDATER.md`](docs/UPDATER.md).

- **GitHub Releases é distribuição, não autoridade.** O manifesto assinado
  (`distorrent-manifest.bin`) é a autoridade. Ele lista versão, canal, commit,
  epoch de segurança, arquitetura, tamanho, SHA-256 e URL de cada instalador, e
  o contrato exige assinatura de **2** de até 5 chaves Ed25519 offline (o
  conjunto padrão da cerimônia é 3 chaves com limiar 2). O cliente verifica com
  as chaves **embutidas** no build (`trust_keys.rs`) — nunca com uma chave que o
  peer ou o GitHub ofereçam.
- **Formato binário fechado, não JSON.** Magic `DTMF1`, inteiros big-endian,
  strings com comprimento u32, assets ordenados por `(os, arch, name)`, listas
  de revogação ascendentes e sem repetição. O decodificador re-encoda e recusa
  qualquer coisa que não seja byte-a-byte idêntica ao que chegou.
- **Assinatura e identificador de chave:**
  `payload = BLAKE3("distorrent/v1|release-manifest|" || corpo_canônico)`;
  `key_id = hex(BLAKE3(pubkey)[0..8])`. Domínio separado impede reaproveitar
  assinatura de mensagem, convite ou rotação.
- **Contagem 2-de-3 exata:** `key_id` duplicado conta **uma vez**; `key_id`
  desconhecido é **ignorado**; assinatura **inválida** de uma chave conhecida
  **aborta a verificação inteira** (indício de adulteração, não ruído). Chave
  listada em `revoked_key_ids` pelo próprio manifesto não conta.
- **Piso monotônico:** `security_epoch` nunca regride. Epoch abaixo de
  `max(piso_local, min_security_epoch)` = `OBSOLETO`, mesmo com 2 assinaturas
  válidas. É proteção contra rollback, local e declarada pela autoridade.
- **Fail-closed de verdade:** a raiz de confiança vem **só** da constante
  compilada `TRUST_SET_BOOTSTRAP` em
  `distorrent-core/src/release/trust_keys.rs` (epoch 1, limiar 2 de 3). **Não
  existe override em runtime** — nem variável de ambiente, nem arquivo, nem
  comando. Se a constante for esvaziada, nada é verificado, o atualizador não
  oferece update e o app diz isso na UI; nenhum caminho degrada para "confiar em
  todos". Os testes `root_cannot_be_erased.rs` e
  `production_key_accepts.rs` travam esse comportamento.
- **Declaração do peer nunca é prova.** `BuildClaim` não tem campo de atestação
  de hardware e `verify_attestation` só pode **rebaixar** por declaração
  (`self_integrity = DIVERGE`). O estado máximo alcançável é
  `RELEASE_VERIFICADA`, que fala do **artefato**, não do processo em execução.
- **Sem chaves não se bloqueia peer honesto.** A política padrão é
  `block_revoked` (bloqueia só `REVOGADO` e `OBSOLETO`). `block_unverified` só
  bloqueia `NAO_VERIFICADO` quando a verificação está realmente disponível
  (`PeerPolicy::decision`).

### O que isso NÃO prova

- **`RELEASE_VERIFICADA` prova procedência do artefato, não integridade do
  processo.** A assinatura de identidade de um peer prova posse da chave; não
  prova que o executável dele está intacto. Um processo comprometido pode
  assinar uma claim verdadeira sobre um binário que não é o que está rodando.
- **Não há atestação de hardware.** Nenhuma plataforma deste build produz prova
  verificável (TPM quote exigiria cadeia EK/endosso + admin; IMA/TPM no Linux
  exigiria root; Key Attestation do Android exigiria a cadeia raiz da Google
  embutida). O campo `hardware.proof_available` é sempre `false` com o motivo, e
  o receptor recalcula esse valor localmente — um peer não se auto-promove a
  `ATESTACAO_DE_HARDWARE`.
- **Auto-integridade não tem referência.** `SelfIntegrityState` está
  `UNAVAILABLE`: `set_expected_self_sha256` não tem chamador. Gravar o hash do
  instalador seria errado (não é o hash do `distorrent.exe`), então o campo
  fica honestamente indisponível em vez de acusar `DIVERGE` sempre.
- **`revoked_key_ids` é aplicado**, mas só dentro do manifesto que o declara:
  assinaturas de chaves revogadas são descartadas antes da contagem. Sem uma
  rotação (ou build novo) a chave continua no conjunto de confiança.
- **A raiz de confiança está embutida** (epoch 1, 2-de-3), mas ela é uma única
  cerimônia: quem controlar 2 das 3 chaves assina qualquer release. Não há log
  público de transparência para provar que uma release *deixou de existir*.
- **Não há build reprodutível verificado.** O `commit` é assinado, não
  reconstruído; o cliente não prova que o binário veio daquele código.

### Assinatura de código (Windows) — garantia separada

Os instaladores continuam **sem** Authenticode (`Get-AuthenticodeSignature` =
`NotSigned`), porque o projeto não tem certificado de code signing. **Não são a
mesma garantia:**

| Mecanismo | Cobre | Estado |
|---|---|---|
| Manifesto Ed25519 (2 de 3) | o artefato publicado: versão, hash, URL, arquitetura | **implementado**: raiz de confiança embutida (epoch 1, limiar 2), sem override em runtime |
| Authenticode (Windows) | o executável no disco, para o SmartScreen/Defender e para o Windows | **ausente** (sem certificado) |
| Assinatura do APK (Android) | o APK contra o app instalado | **implementado**: SHA-256 do certificado do APK baixado vs. app instalado, recusa antes do intent |

Ausência de Authenticode não é sinal de arquivo adulterado, e presença de
manifesto assinado não substitui o Authenticode. O passo a passo de conferência
manual (hash, MOTW, assinatura local) continua em
[`docs/DEFENDER.md`](docs/DEFENDER.md).

### Cerimônia de chaves

As chaves privadas **nunca** entram no repositório. A geração é offline
(`tools/release-trust/ceremony.mjs`), em 3 lugares separados, e qualquer release
precisa de **2** delas para assinar (`tools/release-trust/sign-release.mjs`). O
arquivo `trust_keys.rs` só recebe a linha pública
`epoch|threshold|key_id:pubkey,...`, colada manualmente. Rotação
(`tools/release-trust/rotate-keys.mjs`) exige 2 assinaturas do conjunto
**atual**, epoch nova e ao menos uma chave em comum com o conjunto anterior.

> **Pendência verificável:** a decodificação do bloco existe e funciona
> (`TrustUpdate::from_wire` lê `payload_hex + signatures_hex`; o payload sozinho
> é recusado). O que não existe é o **transporte** do payload até o usuário: ele
> é entregue à mão e aplicado via `update_trust_apply`. Detalhes em
> [`docs/RELEASE_TRUST.md`](docs/RELEASE_TRUST.md) §4.

### Falso positivo conhecido do Defender

O Defender já classificou o instalador NSIS como
`Program:Win32/Contebrew.A!ml`. A investigação (hashes, scans com
Mark-of-the-Web, auditoria de comportamento, tabela de compressão do Inno e
procedimento de submissão à Microsoft) está em
[`docs/DEFENDER.md`](docs/DEFENDER.md). O instalador atual é feito em Inno
Setup e passa no teste de MOTW.
- **Assinando um build:** `scripts/sign-windows.ps1` assina com certificado
  configurado por variável de ambiente (`DISTORRENT_SIGN_PFX` +
  `DISTORRENT_SIGN_PASSWORD`, ou `DISTORRENT_SIGN_THUMBPRINT`), com timestamp
  RFC 3161. Sem certificado configurado ele **pula** a assinatura e diz isso
  claramente; a senha nunca é gravada em arquivo, log ou linha de comando. O
  release do GitHub Actions só assina se o secret `WINDOWS_CERT_PFX_BASE64`
  existir.
