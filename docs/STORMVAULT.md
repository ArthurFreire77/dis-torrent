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

---

## Migrar sua conta para outro dispositivo

Guia passo a passo para levar a conta de um aparelho para outro — sem servidor,
sem nuvem obrigatória.

## 1. No dispositivo antigo: exportar

1. Abra **Configurações** (no celular: aba **Você**) → seção **COFRE & BACKUP**.
2. Em **EXPORTAR COFRE**, digite uma **senha de export** (mínimo 8 caracteres).
   Guarde bem essa senha — sem ela o arquivo não abre em lugar nenhum.
3. Deixe marcado **"incluir chave privada"** (é o que permite migrar de
   dispositivo; sem isso o arquivo só serve como backup de leitura).
4. Toque **Exportar**. O arquivo `.stormvault` é salvo na pasta **Downloads**.

## 2. Transferir o arquivo

Copie o `.stormvault` para o dispositivo novo por **pen drive, cabo USB,
cartão SD ou sua nuvem pessoal**. O arquivo é cifrado (Argon2id + ChaCha20):
o provedor, o dono do pen drive ou quem interceptar **não consegue ler nada**
sem a senha. Mesmo assim, prefira meios que você controla e apague a cópia
intermediária depois.

## 3. No dispositivo novo: importar

1. Instale o DisTorrent no dispositivo novo.
2. Na primeira abertura o app mostra **Criar conta** — crie uma conta
   temporária qualquer (só para entrar; ela será substituída/mesclada).
3. Vá em **Configurações → COFRE & BACKUP → IMPORTAR COFRE**.
3. Toque **Escolher arquivo…**, selecione o `.stormvault`, digite a
   **senha do arquivo** e toque **Importar**.
4. Entre com a **mesma senha do cofre**. Pronto: identidade, conversas,
   mensagens, amigos e comunidades aparecem no novo aparelho.

## 4. O que migra e o que NÃO migra

**Migra:** identidade e chave privada, histórico de mensagens, conversas,
amigos, comunidades (canais, cargos, bots, membros), grupos e configurações.

**NÃO migra:** mídia e arquivos baixados (fotos, vídeos, anexos salvos no
aparelho antigo). Só o histórico e a conta viajam no cofre — os arquivos
precisam ser baixados de novo nas conversas (peça reenvio aos contatos ou
baixe dos peers quando estiverem online).

## 5. Troubleshooting

- **"senha incorreta"**: a senha do arquivo é a que você digitou na hora de
  exportar, não a senha de desbloqueio do app antigo (a menos que sejam iguais).
  Confira acentos, maiúsculas e espaços.
- **"cofre de outra conta"**: o arquivo pertence a uma identidade diferente da
  que já existe neste dispositivo. Para trocar de conta, use o modo pânico
  (**digite APAGAR**) para limpar o aparelho antes — ou mantenha cada conta no
  seu dispositivo. Não há multi-conta no mesmo perfil.
- **Arquivo truncado / corrompido**: o app detecta truncamento e colagem antes
  mesmo de pedir a senha (tamanho e hash do corpo estão no header assinado).
  Exporte de novo no aparelho antigo e transfira por outro meio.
- **Esqueci a senha do arquivo**: não há recuperação — por design, ninguém
  (nem nós) tem cópia. Exporte um cofre novo no aparelho antigo com outra senha.
