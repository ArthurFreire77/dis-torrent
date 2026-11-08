# Cofre Portátil .stormvault

## Formato do arquivo (container v1, conteúdo v2)

```
magic "DSVT" (4 bytes) | versão u16 BE | hdr_len u32 BE | header JSON | payload
payload = salt(16) || nonce(12) || ciphertext(ChaCha20Poly1305, tag 16)
```

- **O container NÃO mudou de versão.** `FORMAT_VERSION = 1` continua, porque o
  header inteiro é AAD do AEAD: bump nele faria todo cofre já exportado falhar
  ao abrir. A evolução do **conteúdo** é versionada em `meta.data_version`.
- Header JSON (plaintext): `v, app, created_ms, fp, nickname, msg_count, kdf
  ("argon2id"|"key"), kdf_params, cipher ("chacha20poly1305"), compressed,
  payload_len, payload_hash` (blake3 do body — plaintext comprimido).
- `payload_len` detecta truncamento/colagem ANTES da KDF (não gasta Argon2 à
  toa); `payload_hash` é verificado PÓS-decrypt, como defesa em profundidade.
- Senha → Argon2id (m=19456 KiB, t=2, p=1 — OWASP) → HKDF-SHA256
  (info="distorrent/stormvault/v1") → chave de dados. Domínio separada do
  cofre local (`vault.rs`), logo um não decompõe o outro.
- Payload comprimido com zstd nível 3 quando reduz ≥15%.
- `meta.data_version = 2` nos cofres novos. Ausente = 1 (cofre antigo).

## O que entra no cofre (v2)

**Identidade e relacionamento**

- identidade (fingerprint, pubkey, nickname, created_at);
- chave privada — **opcional** (`include_secret`); sem ela o arquivo só serve
  como backup de leitura e NÃO instala conta em aparelho limpo;
- amigos com estado completo: `status`, `added_at`, `requested_by`,
  `requested_at`, `blocked_at` (bloqueio nunca é removido pelo cofre);
- peers conhecidos (fp, pubkey, nickname, último endereço visto);
- conversas, grupos (com dono) e o histórico de mensagens (cap configurável,
  padrão 200 000).

**Conteúdo social**

- **perfis** (`profiles`): display_name, about, avatar_b64, banner_b64, accent,
  rev, content_hash. O perfil do próprio usuário é o que migra a "cara" da
  conta; os de terceiros são cache e viajam porque são inofensivos (vieram
  assinados do próprio peer);
- **presença do próprio usuário** (`presence`): status/custom/custom_emoji
  escolhidos por ele. Presença de terceiros NÃO entra (ver abaixo);
- **reações** (`msg_reactions`);
- **metadados de mensagem** (`msg_meta`): reply_to, forwarded_from,
  edited_body/edited_at, deleted, pinned, mentioned;
- **estado de leitura** (`conv_read` do próprio usuário + `read_cursors`
  legado);
- **bookmarks**, **threads**, **polls** + **votos**, **eventos**,
  **emojis personalizados**;
- **sanções de servidor**: bans e timeouts (entram só como adição; um cofre
  velho não desbane ninguém);
- **config de canal** (`channel_cfg`: slowmode/nsfw/topic_locked);
- **apelidos por servidor** (`server_nicknames`) e **menções** do usuário;
- **mensagens ocultas** (`local_hidden`) — "apagar para mim".

**Comunidades e moderação**

- comunidades com canais, cargos, membros, atribuições de cargo e metadados
  (descrição, categoria, ícone, público/privado);
- regras do servidor, reputação, auditoria e denúncias (reports).

**Preferências da conta** (`SETTINGS_WHITELIST`, 19 chaves)

- privacidade: `privacy.mode`, `privacy.proxy_addr`, `privacy.tor_addr`,
  `privacy.encryption`, `privacy.tor`, `privacy.udp_discovery`,
  `privacy.padding`, `privacy.obfuscation`;
- retenção: `privacy.retention_days`, `privacy.retention_servers`,
  `privacy.retention_groups`, `privacy.retention_dms`;
- mídia: `media.strip_exif`, `media.block_executables`;
- cache e backup: `cache.cap_mb`, `stormvault.backup_retention_days`;
- notificações: `notify.system`, `notify.preview`, `notify.policy`.

Preferências do aparelho ficam de fora na importação (`INSERT OR IGNORE`):
o cofre só preenche chave ausente, nunca sobrescreve a escolha local.

## O que NÃO entra (e por quê)

| Fora do cofre | Motivo |
|---|---|
| **Token e `webhook_secret` de bots** | Credencial do dono, presa ao aparelho. O export zera os dois campos; quem restaura regenera o token. |
| **Presença de terceiros** | Dado vivo com TTL de 90 s. Restaurar faria o app mostrar "online" para quem está offline. |
| **Cursores de leitura de terceiros** | Cache; voltam pelos recibos de leitura. Só o cursor do próprio usuário migra. |
| **`kv identity.secret` / `identity.secret.backup`** | É a chave privada. Ela viaja (quando pedida) só dentro do payload cifrado, nunca como kv. |
| **`vault.on`, `imported.*`, `notify.ui_alive`, `ui.autostart_*`, `update.*`, `release.*`** | Descrevem ESTE aparelho (senha local, slots de multi-conta, carimbo da UI, autostart, cache de update e raiz de confiança). |
| **Mídia e arquivos baixados** | Já era conhecido: só o histórico e a conta viajam. Anexos são baixados de novo dos peers. |
| **Sessões efêmeras**: `calls`, `call_participants`, `voice_states`, `outbox`, `pending_reacts`, `dm_intro`, `read_receipts`, `bot_logs`, `bot_vars`, `warnings`, `files` | Estado de runtime, não da conta. Restaurar chamada/outbox não faz sentido em outro aparelho. |
| **Senha do cofre local** | A senha do `.stormvault` é a que o usuário digitou na exportação; pode ser diferente da senha de desbloqueio do app. |

## Identidade amarrada ao conteúdo (anti-vitrine)

`open_with_password` / `open_with_key` (e, em profundidade,
`import_merge_only`) recusam o arquivo quando:

1. `blake3(pubkey_hex)[..12] != identity.fingerprint` — fingerprint inventado;
2. `header.fp != identity.fingerprint` — header descreve outra pessoa;
3. `secret_hex` presente e `Keypair::from_secret_hex(secret)` não deriva a
   mesma `pubkey_hex`/fingerprint — segredo de outra conta colado no payload.

Ou seja: **um arquivo com senha conhecida não monta uma identidade "vitrine"
usando a pubkey de outra pessoa**. A pubkey do payload é a identidade
verificável; o fingerprint é o atalho de 12 caracteres dela.

## Mesclagem na importação

- Sem conta local → instala identidade (a senha do arquivo vira a senha do
  cofre local) e mescla os dados.
- Mesma conta → só mescla dados. Conta diferente (fingerprint) → recusa;
  multi-conta é o caminho (`account_switch`).
- Mensagens: dedup por id; mesma id com conteúdo diferente = conflito e a
  cópia LOCAL vence.
- Amigos: valor não-vazio do cofre vence só se `added_at ≥ local`;
  `blocked_at` só cresce (o cofre não desbloqueia).
- Perfis: vence a maior `rev`; empate usa o `content_hash` canônico
  (determinístico, sem depender de relógio).
- Reações, bookmarks, menções, ocultos: `INSERT OR IGNORE` (nunca apagam o
  que já existe).
- Read states: `MAX(local, cofre)` — importar um cofre antigo não "desmarca"
  leitura.
- Metadados de mensagem: só entram se a linha não existe (o pin local do
  servidor não é sobrescrito por cofre antigo).
- Sanções (bans/timeouts): só adicionam.
- Comunidades: base com `INSERT OR IGNORE`; conteúdo (canais/cargos/bots)
  atualiza; o host re-sincroniza o resto ao conectar.
- Settings: só preenchem chaves AUSENTES.

## Compatibilidade

- **Cofre v1 → app novo**: abre normalmente. `meta.data_version` ausente é
  lido como 1; todos os campos v2 têm `serde(default)`, então o payload v1
  decodifica com listas vazias. O relatório mostra `data_version: 1` e a UI
  avisa que aquele cofre não traz perfil/reações/preferências.
- **Cofre v2 → app antigo**: o container continua v1 e não há campo novo
  obrigatório, então um leitor antigo decodifica e **ignora** as chaves que
  não conhece (serde ignora campo desconhecido por padrão). Ele vê o
  histórico e a identidade, mas perde perfil/reações/etc. em silêncio. Não é
  corrupção — é degradação.
- **Container de versão futura** (`v > 1`) é recusado com "atualize o app".

## Backups automáticos

- Mesmo container, selados com chave derivada em RAM
  (`blake3("distorrent/stormvault/backup-key/v1" || secret)`) — sem senha,
  porque rodam enquanto o app está desbloqueado.
- Arquivos: `<app_data>/backups/stormvault-<unix_ms>.stormvault`; retenção
  configurável (7/30/90 dias), os 2 mais novos nunca são apagados.
- **Dependem do segredo.** No desktop o segredo está no keyring, não na pasta:
  copiar `%APPDATA%` sozinho NÃO abre os backups. No Android o segredo está no
  SQLite do sandbox (ver limitação abaixo).
- Conta protegida por senha (`vault.on = 1`) **não** gera snapshot
  pré-atualização no Windows: sem o segredo em claro não há como derivar a
  chave de backup. O snapshot só existe para contas com chave no keyring.

## Modelo de ameaça (resumo)

- Quem tem o arquivo **+ a senha** tem a conta (by design — não há servidor).
- Sem a senha: Argon2id (19 MiB, t=2) torna força-bruta cara por tentativa.
- Chave privada nunca em claro no disco **no desktop**: só no keyring do SO
  ou dentro do payload cifrado.
- Header inteiro como AAD + `payload_len`/`payload_hash`: truncamento,
  colagem ou adulteração são detectados antes/depois da KDF.
- Modo pânico (`vaultWipe`) apaga cofre+backups locais; um `.stormvault`
  guardado FORA do device continua válido para restaurar.

Detalhes de armazenamento local, o que um atacante com a pasta do app
consegue e a limitação do Android estão em
[`THREAT_MODEL.md`](../THREAT_MODEL.md) (seção "Cofre portátil e segredo da
identidade").

---

## Migrar sua conta para outro dispositivo

Guia passo a passo para levar a conta de um aparelho para outro — sem servidor,
sem nuvem obrigatória.

## 1. No dispositivo antigo: exportar

1. Abra **Configurações** (no celular: aba **Você**) → seção **COFRE & BACKUP**.
2. Em **EXPORTAR COFRE**, digite uma **senha de export** (mínimo 8 caracteres).
   Guarde bem essa senha — sem ela o arquivo não abre em lugar nenhum.
3. Deixe marcado **"levar minha chave privada"** (é o que permite migrar de
   dispositivo; sem isso o arquivo só serve como backup de leitura).
4. Toque **Exportar**. O arquivo `.stormvault` é salvo na pasta **Downloads**.
5. Anote o **fingerprint** mostrado no aviso: é ele que deve aparecer no outro
   aparelho depois da importação.

## 2. Transferir o arquivo

Copie o `.stormvault` para o dispositivo novo por **pen drive, cabo USB,
cartão SD ou sua nuvem pessoal**. O arquivo é cifrado (Argon2id + ChaCha20 +
Poly1305): o provedor, o dono do pen drive ou quem interceptar **não consegue
ler nada** sem a senha. Mesmo assim, prefira meios que você controla e apague a
cópia intermediária depois.

## 3. No dispositivo novo: importar

1. Instale o DisTorrent no dispositivo novo.
2. Na primeira abertura, se aparecer **Criar conta**, use o botão
   **"Já tenho conta em outro aparelho — importar cofre"** e escolha o
   `.stormvault`. (Se o aparelho já tem identidade, o caminho é
   **Configurações → COFRE & BACKUP → IMPORTAR COFRE**.)
3. Digite a **senha do arquivo** e toque **Importar**.
4. Entre com a **mesma senha do cofre**. Pronto: identidade, perfil (avatar,
   banner, status), conversas, mensagens, reações, fixados, marcadores,
   comunidades e preferências aparecem no novo aparelho.

## 4. O que migra e o que NÃO migra

**Migra:** identidade e chave privada, perfil social, presença escolhida,
histórico de mensagens, conversas, amigos (com bloqueios), comunidades
(canais, cargos, membros, regras), grupos, reações, fixados, marcadores,
estado de leitura, menções, enquetes/votos, eventos, emojis e configurações da
lista acima.

**NÃO migra:** mídia e arquivos baixados (fotos, vídeos, anexos salvos no
aparelho antigo), histórico de chamadas, outbox/fila de envio, logs de bot e
**token/segredo de webhook de bot**. Só o histórico e a conta viajam no cofre —
os arquivos precisam ser baixados de novo nas conversas; os bots precisam ter o
token regenerado no painel.

## 5. Troubleshooting

- **"senha incorreta"**: a senha do arquivo é a que você digitou na hora de
  exportar, não a senha de desbloqueio do app antigo (a menos que sejam iguais).
  Confira acentos, maiúsculas e espaços.
- **"cofre de outra conta"**: o arquivo pertence a uma identidade diferente da
  que já existe neste dispositivo. Para trocar de conta, use o modo pânico
  (**digite APAGAR**) para limpar o aparelho antes — ou mantenha cada conta no
  seu dispositivo.
- **"cofre adulterado: fingerprint não corresponde à pubkey"** ou **"chave
  privada não corresponde à identidade"**: o arquivo foi editado ou montado
  com identidade de outra pessoa. Não há como "consertar" — exporte de novo no
  aparelho de origem.
- **"Este cofre é antigo (v1)"**: o arquivo foi gerado por uma versão que não
  exportava perfil/reações/preferências. A conta entra, mas esses dados não
  vêm. Exporte de novo com a versão atual para levar tudo.
- **Arquivo truncado / corrompido**: o app detecta truncamento e colagem antes
  mesmo de pedir a senha (tamanho e hash do corpo estão no header assinado).
  Exporte de novo no aparelho antigo e transfira por outro meio.
- **Esqueci a senha do arquivo**: não há recuperação — por design, ninguém
  (nem nós) tem cópia. Exporte um cofre novo no aparelho antigo com outra senha.
