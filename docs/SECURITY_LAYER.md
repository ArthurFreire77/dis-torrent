# Camada de Segurança Storm — segurança + anti-spam + nomes + moderação

> Módulo integrado ao Storm sem quebrar chamadas/downloads: só adiciona
> gates de descarte (a sessão nunca cai por spam) e validações de nome.
> Nada aqui loga chave privada ou conteúdo de mensagem.

## 1. Segurança geral (base já existente + reforços)

| Item | Onde | Estado |
|---|---|---|
| Handshake X25519 ECDH efêmero + HKDF-SHA256 + ChaCha20Poly1305 | `forge-core/src/protocol.rs::session_key` | REAL (existente) |
| Mensagem assinada ed25519, receptor re-verifica SEMPRE | `protocol.rs::MessageEnvelope` | REAL (existente) |
| Fingerprint = `blake3(pubkey)[0..12]` hex, vínculo fp↔pubkey | `identity.rs` | REAL (existente) |
| Cofre: Argon2id → ChaCha20Poly1305; chave no keyring do SO (Android Keystore / Keychain / DPAPI) | `vault.rs` + `src-tauri keyring` | REAL (existente) |
| **Safety Number estilo Signal** (ord. independente, 8×5 dígitos) | `names.rs::safety_number` + cmd `safety_number` + `VerifyIdentity` | NOVO |
| **Sanitização de rede**: nicknames/tópicos de peers passam por `sanitize_text` (controles, zero-width, bidi fora) | `engine.rs::cap_str` | NOVO |
| Rate limiting por peer e por canal | `engine.rs::spam_gate` (10 msgs/10s) | NOVO |

Verificação de identidade: `services.safetyNumber(fp)` → compare por voz ou
pessoalmente. Igual nos dois aparelhos = sem MITM.

## 2. Anti-spam (pipeline, barato → caro)

Ordem no receptor, **sempre depois** da verificação de assinatura:

1. **Flood** — 10 msgs / janela de 10s por peer. Excedente descartado,
   reputação −5. Sessão preservada.
2. **Duplicada** — `blake3(autor|corpo lower)` + janela 60s. Replay do mesmo
   conteúdo cai (−2). (Replay criptográfico real continua impossível: nonces
   de 16 bytes por conexão entram no transcript do handshake.)
3. **Links** — `check_links`: domínios maliciosos (grabify, iplogger, …) e
   lista do servidor derrubam (−8); encurtadores avisam no `medium` e caem
   no `high`.
4. **Proof-of-work** — `PowChallenge::fresh(bits)`; `medium` = 8 bits,
   `high` = 12 bits. Captcha leve para novatos em servidores públicos
   (verificação no dono antes do `member` valer).
5. **Reputação** — `new → trusted (≥20) / suspicious (≤−10) / banned (≤−30)`,
   persistida em SQLite (`reputation`), visível via `reputation_get` e com
   badge colorido na UI. `reportUser` = −10 + auditoria.

Pré-checagem no cliente (`src/core/security/antispam.ts`): `warnBeforeSend`
avisa link suspeito antes de enviar; `LocalRateGate` segura o dedo nervoso.
O core decide de verdade — o cliente só melhora o feedback.

## 3. Nomes (usuário / servidor / canal)

Validação em **tempo real na UI** (`NameField`) + **re-validação no core**
(`create_community`, `channel_create`, `channel_rename`, `community_rename`
usa gate? — ver §6). Regras:

- NFC + trim + colapso de espaços; tamanho por tipo (2–32 / 3–64 / 2–40).
- Bloqueio de `< > " ' \ ``, controles, zero-width e overrides bidi.
- Só letras/números/espaço/`_ - .`; canal exige minúsculas + hífen.
- Blocklist PT-BR + EN + palavras do servidor (compara por **skeleton**,
  então `4dm1n`, `аdmin` cirílico e `café`/`café` caem do mesmo jeito).
- Reserva de cargos (`admin`, `moderador`, `storm oficial`, …).
- Anti-spoof: unicidade por **skeleton** no escopo + distância de edição 1
  de nomes existentes.
- Sugestões (`ana_01`, `ana_2025`) e 🎲 aleatório (`random_name`).

## 4. Regras por servidor + auditoria

- `ServerRules { spam_level, banned_words, blocked_domains, moderators, shadow_banned }`
  via `server_rules_get/set` (set = só dono; listas sanitizadas, teto 200/50/500).
- `moderate(cid, action, target, reason)`: `ban/unban/mute/unmute/
  shadow_ban/unshadow/delete_msg`. Permissão = dono OU moderador listado OU
  bit `PERM_BAN/MUTE/DELETE` no cargo. Dono e si mesmo nunca são alvo.
- `delete_msg` só apaga mensagem de canal **deste** servidor.
- Tudo gera `AuditEntry` (motivo sanitizado + escapado) em `audit_log`;
  leitura via `audit_list`. Shadow-ban: some para todos, o alvo nem percebe.
- `report_user`: qualquer membro denuncia (−10, auditoria `report`).

Tabelas SQLite (migration v5): `server_rules`, `audit_log`, `reputation`,
`reports`. Upgrade automático de bancos v1–v4.

## 5. UI (`src/components/security/Security.tsx`)

Mobile-first (toque ≥44px, fluido, sem deps nativas; clipboard com fallback
para WebView Android). Componentes prontos, **não montados** (shell
congelado — montagem opt-in):

| Componente | Uso |
|---|---|
| `EncryptedBadge` | cadeado no cabeçalho da conversa (`privacyGet().encryption_enabled`) |
| `VerifyIdentity` | tela de verificação: avatar, fp, badge de reputação, safety number + copiar |
| `NameField` | criação/renomeação com preview, sugestões e 🎲 |
| `ReportButton` | denunciar usuário (DM ou servidor) |
| `ModerationPanel` | painel do dono/mod: nível anti-spam, palavras, domínios, ações, auditoria |
| `sendWarning()` | selo/aviso de link antes de enviar (usa regras do servidor) |

Exemplo de montagem (desktop e mobile usam o mesmo import):

```tsx
import { EncryptedBadge, ModerationPanel } from '../components/security/Security'
// cabeçalho: <EncryptedBadge encrypted={privacy.encryption_enabled} />
// config do servidor: <ModerationPanel communityId={cid} isOwner={amIOwner} />
```

`ForgeServices` ganhou 9 métodos (nativo via invoke, browser via
localStorage honesto entre abas): `serverRulesGet/Set`, `auditList`,
`reputationGet`, `safetyNumber`, `moderate`, `reportUser`, `validateName`,
`randomName`. TS espelho em `src/core/security/` (`sanitize`, `names`,
`antispam`) — o core tem a palavra final.

## 6. Limitações honestas (não é marketing)

- Renomear servidor/canal, criar servidor/canal e apelidos vindos da rede
  têm gate total; nome de **cargo** e de **bot** ainda usam trim clássico —
  backfill planejado.
- PoW é verificado contra desafio emitido pelo dono; em DMs não se aplica
  (amizade aceita já é o gate).
- Metadados (quem fala com quem, quando, tamanho) continuam visíveis —
  padding só no modo `full`.
- Fallback de keyring sem secret service guarda chave em SQLite plano
  (documentado em THREAT_MODEL.md, visível na UI).
- Sibyl continua sem solução criptográfica; reputação + PoW + convite
  com fingerprint mitigam em servidores.

## 7. Testes

- `cargo test -p forge-core --lib` — 80 testes (names, antispam,
  moderation, vault, protocolo, engine).
- `cargo test --test security_layer` — 9 testes de penetração: MITM,
  transcript amarrado, replay/dup, spoof de nome, flood, links,
  regras/auditoria, roundtrip SQLite v5 e **E2E real de dois nós**:
  DM legítima entrega, flood cai sem matar a sessão, link malicioso não
  chega, sessão segue viva.
- Regressão verde: `integration`, `friends`, `channels`,
  `call_signaling_e2e` (chamadas e downloads intactos).
- Frontend: `npx tsc -b` + `npx eslint` limpos. Sem `tauri build` neste
  ciclo (a pedido — nenhum APK/DEB foi recompilado).
