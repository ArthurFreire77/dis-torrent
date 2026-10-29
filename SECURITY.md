# Security Policy

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

## Não escopo (assumido, documentado em THREAT_MODEL.md)

- Anonimato de rede (IP visível a peers)
- Malware no device do usuário
- Acesso físico/local à máquina

## Práticas

- Somente primitivas maduras (RustCrypto, blake3, @noble/*). Nenhuma criptografia própria.
- Chave privada nunca logada, nunca serializada para a UI; keyring do SO com fallback explícito.
- Toda operação sensível validada no core — a UI não é fonte de autorização.

## Binários, assinatura e verificação de integridade

- **Como conferir o que você baixou:** compare
  `Get-FileHash <arquivo> -Algorithm SHA256` com o hash divulgado no
  `CHANGELOG.md`, no anúncio da release ou no campo `digest` da API do GitHub.
  Se diferir, **não execute**. O passo a passo (hash, assinatura, MOTW e
  assinatura local) está em [`docs/DEFENDER.md`](docs/DEFENDER.md).
- **Assinatura de código (Windows):** os instaladores ainda **não** são
  assinados (`Get-AuthenticodeSignature` = `NotSigned`), porque o projeto não
  tem certificado de code signing. Não confundir ausência de assinatura com
  arquivo adulterado — a autenticidade hoje depende do hash publicado e da
  origem (GitHub Releases oficial).
- **Falso positivo conhecido:** o Defender já classificou o instalador NSIS
  como `Program:Win32/Contebrew.A!ml`. A investigação (hashes, scans com
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
