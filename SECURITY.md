# Security Policy

## Reportando uma vulnerabilidade

Abra uma issue marcada como `security` **ou** entre em contato pelo GitHub do projeto. Não reporte por PR público.

## Escopo atual (v1 + camada Storm)

- Identidade ed25519 + fingerprint blake3 (`forge-core/src/identity.rs`)
- Handshake/sessão (`forge-core/src/net/transport.rs`) — composition: ed25519 transcript + X25519 efêmero + HKDF-SHA256 + ChaCha20Poly1305
- Envelope de mensagem assinado (`forge-core/src/protocol.rs`)
- Storage local (`forge-core/src/storage.rs`, schema v5: `server_rules`, `audit_log`, `reputation`, `reports`)
- **Storm**: nomes validados (`names.rs` + gate no engine), anti-spam pós-assinatura (`antispam.rs` + `spam_gate`), moderação por servidor com auditoria (`moderation.rs`), Safety Number (`safety_number`), 9 tauri commands — ver [`docs/SECURITY_LAYER.md`](docs/SECURITY_LAYER.md)
- **Cofre portátil .stormvault v1** (export/import/backup cifrado + modo pânico) — spec em `docs/STORMVAULT.md`, modelo de ameaça em `THREAT_MODEL.md`

## Não escopo (assumido, documentado em THREAT_MODEL.md)

- Anonimato de rede (IP visível a peers)
- Malware no device do usuário
- Acesso físico/local à máquina

## Práticas

- Somente primitivas maduras (RustCrypto, blake3, @noble/*). Nenhuma criptografia própria.
- Chave privada nunca logada, nunca serializada para a UI; keyring do SO com fallback explícito.
- Toda operação sensível validada no core — a UI não é fonte de autorização.
