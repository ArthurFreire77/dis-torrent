# Cofre Portátil .stormvault (v1)

## Formato do arquivo

```
magic "DSVT" (4 bytes) | versão u16 BE | hdr_len u32 BE | header JSON | payload
payload = salt(16) || nonce(12) || ciphertext(ChaCha20Poly1305, tag 16)
```

- Header JSON (plaintext): `v, app, created_ms, fp, nickname, msg_count, kdf
  ("argon2id"|"key"), kdf_params, cipher ("chacha20poly1305"), compressed,
  payload_len, payload_hash` (blake3 do body — plaintext comprimido).
- O header inteiro entra como AAD do AEAD: adulterar qualquer campo invalida
  a cifra. `payload_len` detecta truncamento/colagem ANTES da KDF (não gasta
  Argon2 à toa); `payload_hash` é verificado PÓS-decrypt, como defesa em
  profundidade (o AEAD já autenticou).
- Senha → Argon2id (m=19456 KiB, t=2, p=1 — OWASP) → HKDF-SHA256
  (info="distorrent/stormvault/v1") → chave de dados. Domínio separada do
  cofre local (vault.rs), logo um não decompõe o outro.
- Payload comprimido com zstd nível 3 quando reduz ≥15%.
- Conteúdo (JSON): identidade, chave privada (opcional), conversas, mensagens,
  amigos, peers, comunidades (canais/cargos/bots/membros), regras do servidor,
  reputação, auditoria, denúncias (reports), grupos, settings
  whitelist (privacy.mode, privacy.proxy_addr).

## Mesclagem na importação

- Sem conta local → instala identidade (a senha do arquivo vira a senha do
  cofre local) e mescla os dados.
- Mesma conta → só mescla dados. Conta diferente → recusa (multi-conta é o caminho).
- Mensagens: dedup por id (id = blake3 de autor+conv+ts+corpo+rand); mesma id
  com conteúdo diferente = conflito e a cópia LOCAL vence.
- Amigos: valor não-vazio do cofre vence só se added_at ≥ local.
- Settings: só preenchem chaves AUSENTES (preferências do device têm precedência).
- Comunidades: base com INSERT OR IGNORE; conteúdo (canais/cargos/bots) atualiza
  (o host re-sincroniza o resto ao conectar).

## Backups

- Snapshots do mesmo formato, selados com chave derivada em RAM
  (blake3("stormvault/backup-key/v1" || secret)) — sem senha, porque rodam
  enquanto o app está desbloqueado.
- Arquivos: `<app_data>/backups/stormvault-<unix_ms>.stormvault`.
- Retenção configurável (7/30/90 dias); os 2 mais novos nunca são apagados.

## Modelo de ameaça

- Quem tem o arquivo + a senha tem a conta (by design — não há servidor).
- Sem a senha: Argon2id (19 MiB, t=2) torna força-bruta caro por tentativa.
- Chave privada NUNCA em claro no disco; só dentro do payload cifrado.
- O modo pânico (vaultWipe) apaga cofre+backups locais; um .stormvault
  guardado FORA do device continua válido para restaurar depois.
