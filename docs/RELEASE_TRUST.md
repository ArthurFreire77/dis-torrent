# Autenticidade de releases e de builds — especificação

Este documento é a fonte de verdade da camada `distorrent-core/src/release/`
(`manifest.rs`, `trust.rs`, `attestation.rs`, `store.rs`, `trust_keys.rs`) e da
ponte `distorrent-core/src/net/release_trust.rs`. Ele descreve **o que o código
faz**, não o que se pretende fazer. Onde algo não existe, está escrito
"não implementado".

Regra central que o resto do app precisa respeitar:

| Camada | Prova | Não prova |
|---|---|---|
| `RELEASE_VERIFICADA` | que a **autoridade de release** (assinaturas válidas de chaves distintas ≥ limiar; padrão 2 de 3) autorizou aquele artefato: versão, hash, URL, arquitetura | que o processo em execução é aquele artefato |
| `ATESTACAO_DE_HARDWARE` | que haveria uma prova de plataforma verificável | **não implementado** neste build (ver §9) |
| `SelfIntegrityState` | os bytes do **arquivo** que abriu este processo batem com um SHA-256 gravado localmente | que o processo em memória não foi alterado depois do boot |

---

## 1. Manifesto canônico

O manifesto **não é JSON**. JSON aberto tem ambiguidade de parser (chave
duplicada, float, ordem de chave) e uma assinatura sobre bytes "canonicalizados"
por duas implementações diferentes já quebrou sistemas reais. O invólucro é um
encoding binário fechado, de ordem fixa, com comprimentos explícitos.

Implementação: `distorrent-core/src/release/manifest.rs`.
Ferramenta espelho (mesmo encoding, em JS): `tools/release-trust/lib.mjs`.

### 1.1 Corpo (`ManifestBody`)

Todos os inteiros são **big-endian**. Toda string é **u32 BE de comprimento em
bytes + os bytes em UTF-8** (sem terminador, sem normalização).

| # | Campo | Tipo | Regra de validação |
|---|---|---|---|
| 1 | magic | 5 bytes fixos | `DTMF1` (`MANIFEST_MAGIC`) |
| 2 | `schema` | u16 | exatamente `1` (`MANIFEST_SCHEMA`) |
| 3 | `project` | string | exatamente `distorrent` (`PROJECT_ID`) |
| 4 | `version` | string | núcleo `N.N.N` com cada parte de 1 a 9 dígitos ASCII; sufixo livre depois de `-` (só o total é limitado a 64 bytes) |
| 5 | `channel` | string | não vazia, sem caracteres de controle; até 32 bytes |
| 6 | `tag` | string | `tag.trim_start_matches('v')` tem de ser igual ao núcleo da versão (parte antes do `-`) |
| 7 | `commit` | string | 40 caracteres hex (SHA-1) |
| 8 | `published_at_ms` | i64 | `> 0` |
| 9 | `protocol_version` | u32 | `1 ..= 1_000_000` |
| 10 | `min_protocol_version` | u32 | `<= protocol_version` |
| 11 | `security_epoch` | u64 | contador monotônico global |
| 12 | `min_security_epoch` | u64 | `<= security_epoch` |
| 13 | `revoked_versions` | lista de strings | até 512; **ordem estritamente crescente e sem repetição** |
| 14 | `revoked_key_ids` | lista de strings | até 512; mesma regra de ordem |
| 15 | `assets` | lista de assets | 1 a 32 (`MAX_ASSETS`) |

Cada asset, nesta ordem:

| Campo | Tipo | Regra |
|---|---|---|
| `name` | string | até 255 bytes; sem `/`, sem `\`, diferente de `.` e `..`; sem caracteres de controle |
| `os` | string | até 32 bytes (valores usados: `windows`, `linux`, `android`, `macos`, `freebsd`) |
| `arch` | string | até 32 bytes (`x86_64`, `aarch64`, `universal`, …) |
| `size` | u64 | `1 ..= 4 GiB` |
| `sha256` | string | 64 caracteres hex (o validador aceita `A-F`; a ferramenta emite minúsculo) |
| `url` | string | começa com `https://`, até 1024 bytes |

### 1.2 Ordem canônica dos assets

`assets` precisa estar **estritamente ordenado** pela tupla
`(os, arch, name)`, comparação de bytes (`asset_key` + `windows(2)` com `<`
estrito). Duas entradas com a mesma tupla são recusadas. O Rust **não** proíbe o
mesmo `name` em `os`/`arch` diferentes (tuplas distintas são válidas), mas a
ferramenta de assinatura recusa nome de arquivo repetido em qualquer entrada
(`sortAssets` em `lib.mjs`) — o manifesto gerado pela cerimônia nunca tem
duplicata de nome.

### 1.3 Re-encode obrigatório

`ManifestBody::parse_canonical(bytes)`:

1. rejeita `bytes.len() > 64 KiB` (`MAX_MANIFEST_BYTES`);
2. decodifica;
3. roda `validate()`;
4. **re-encoda e compara byte a byte com a entrada** — se divergir, erro
   `"manifesto não está na forma canônica"`.

Consequência: qualquer manifesto que não seja exatamente o que o encoder
produzir é recusado antes de qualquer verificação de assinatura. Não existe
"tolerância de parser".

### 1.4 Invólucro assinado (`SignedManifest` / `to_wire`)

```
u32 BE   body_len
bytes    corpo canônico (body_len bytes)
u32 BE   n_assinaturas           (1 ..= 3)
repetir n_assinaturas vezes:
  string key_id                  (16 hex = blake3(pubkey)[..8])
  string sig                     (128 hex = 64 bytes Ed25519)
```

`from_wire` exige que não sobrem bytes (`expect_end`). Um manifesto sem
assinatura não pode nem circular: `to_wire` recusa `n == 0`.

### 1.5 Limites

| Constante | Valor |
|---|---|
| `MAX_MANIFEST_BYTES` | 64 KiB (corpo e invólucro) |
| `MAX_ASSETS` | 32 |
| `MAX_REVOKED` | 512 por lista |
| `MAX_STRING` | 2048 bytes |
| `MAX_SIGNATURES` | 3 |
| `MAX_TRUST_KEYS` | 5 |

---

## 2. Assinatura

### 2.1 Payload

```
payload = BLAKE3( "distorrent/v1|release-manifest|" || corpo_canônico )
```

`SIGN_DOMAIN = b"distorrent/v1|release-manifest|"`. O resultado tem 32 bytes e é
assinado **diretamente** com Ed25519 (`Keypair::sign(&payload)` — o dalek assina
a mensagem de 32 bytes, não um hash dela de novo).

O domínio separa esta assinatura de qualquer outra do protocolo: uma assinatura
de mensagem, de convite ou de rotação não verifica como assinatura de manifesto,
mesmo que os bytes coincidam.

### 2.2 Identificador de chave

```
key_id = hex( BLAKE3(pubkey_ed25519_32_bytes)[0..8] )   // 16 caracteres
```

`TrustedKey::from_pubkey_hex` deriva o `key_id` da própria chave;
`TrustedKey::validate` recusa um par em que o `key_id` declarado não bata com a
pubkey. Não existe "key_id escolhido à mão".

### 2.3 Hash do manifesto

```
manifest_hash = hex( BLAKE3(corpo_canônico) )   // 64 hex
```

É o valor que os peers anunciam (`BuildClaim.manifest_hash`, `UpdateHint`) e que
o atualizador usa como chave de cache. Ele **não** cobre as assinaturas: dois
invólucros com o mesmo corpo e assinaturas diferentes têm o mesmo
`manifest_hash`.

---

## 3. Conjunto de confiança e a regra de limiar (2 de 3 por padrão)

`TrustSet { epoch, threshold, keys }`:

- `epoch` em `1 ..= 1_000_000`;
- `keys.len()` em `2 ..= 5`;
- `threshold` em `2 ..= keys.len()`; **nunca abaixo de 2** (`MIN_THRESHOLD`);
- chaves **estritamente ordenadas** por `key_id` (crescente, sem duplicata);
- cada chave precisa ter `key_id` coerente com a pubkey.

### 3.1 Contagem exata (`verify_signatures`)

| Situação | Efeito |
|---|---|
| `key_id` não está no conjunto | **ignorada** (não conta, não falha) |
| `key_id` conhecido repetido na lista | **conta uma vez só** (o `seen` evita 2 entradas da mesma chave passarem o limiar) |
| `key_id` conhecido, assinatura **válida** | conta +1 |
| `key_id` conhecido, assinatura **inválida** | **aborta a verificação inteira** (`Err`) — presença de assinatura falsa indica adulteração, não ruído |

No chamador (`verify_manifest`), o `Err` vira `NaoVerificado` com o motivo, e
`valid_signatures = 0`.

O veredito só é `RELEASE_VERIFICADA` quando `valid >= threshold`.

### 3.2 Ordem de verificação (`verify_manifest`)

1. `body.validate()` (forma canônica já garantida na decodificação);
2. calcula `hash` e `payload`;
3. se `revoked_versions` contém a própria `version` → **REVOGADO** (antes de
   olhar assinatura);
4. descarta assinaturas cujo `key_id` esteja em `revoked_key_ids`;
5. `verify_signatures` → erro vira **NÃO VERIFICADO**;
6. `valid < threshold` → **NÃO VERIFICADO**;
7. `security_epoch < max(piso_local, min_security_epoch)` → **OBSOLETO**;
8. caso contrário → **RELEASE_VERIFICADA**.

`ReleaseTrust::accept` acrescenta, **depois** do veredito, a revogação conhecida
localmente (`release.revoked`, alimentada por manifests e rotações anteriores):
se a versão está nessa lista, o status vira `REVOGADO` mesmo com assinatura
válida.

> Detalhe cosmético verificável: o motivo do sucesso é a string fixa
> `"duas assinaturas válidas"`, mesmo quando `valid_signatures == 3`. O número
> correto está em `valid_signatures`; a frase não deve ser lida como contagem.

### 3.3 Conjunto embutido e fail-closed

`distorrent-core/src/release/trust_keys.rs` contém **apenas chaves públicas**
(formato `epoch|threshold|key_id:pubkey,...`). Neste build:

```
pub const TRUST_SET_BOOTSTRAP: &str =
    "1|2|00214a4965a6f495:c340a475…,06aa2b141daf1729:…,e522a4686689acb8:…";
```

**Não existe override em runtime.** A raiz de confiança é a constante
compilada. Já existiu um `DISTORRENT_TRUST_SET` em `cfg(debug_assertions)` e ele
foi **removido**: era exatamente o botão que um atacante usaria para trocar a
autoridade. O teste `root_cannot_be_erased.rs` prova, entre outras coisas, que
setar essa variável **não altera** o conjunto retornado por
`bootstrap_trust_set()`.

Se a constante for esvaziada (build sabotado), `bootstrap_trust_set()` devolve
erro, `verification_available = false`, nenhum manifesto é aceito e o
atualizador recusa oferecer update. Nenhum caminho degrada para "confiar em
todo mundo".

### 3.4 O que acontece sem chaves

`PeerPolicy::decision` tem uma regra explícita para isso:

```rust
if !verification_available {
    // Sem raiz de confiança o cliente não pode afirmar que o outro é falso:
    // bloqueia só se a política for a mais estrita E houver como verificar.
    return None;
}
```

Ou seja:

- **sem chaves**, nenhum peer é bloqueado por política: `verify_attestation`
  retorna cedo com `state = NAO_VERIFICADO` e `verification_available = false`,
  então nem `REVOGADO` nem `OBSOLETO` chegam a existir;
- a política `block_revoked` (padrão) nunca bloqueia `NAO_VERIFICADO`;
- `block_unverified` só bloqueia `NAO_VERIFICADO` quando
  `verification_available == true`;
- `warn` nunca bloqueia `NAO_VERIFICADO`.

O build diz na UI e nos comandos (`update_trust_info`) que a verificação está
indisponível e por quê. Não existe "confiança implícita por omissão".

---

## 4. Rotação de chaves (`TrustUpdate`)

Formato binário (mesmo `Enc`/`WireDec`, corpo canônico e re-encode obrigatório):

```
"DTMF1" || "ROT"
u64 BE   from_epoch
u64 BE   new_set.epoch
u8       new_set.threshold
u32 BE   n_keys
  string key_id, string pubkey_hex      (x n_keys)
u32 BE   n_revoked
  string versão                          (x n_revoked)
i64 BE   effective_ms
string   reason                          (até 512 bytes, sem controle)
```

Payload assinado:

```
BLAKE3( "distorrent/v1|trust-rotation|" || corpo_canônico )
```

`ROTATION_DOMAIN = b"distorrent/v1|trust-rotation|"`.

`verify_and_apply(current)` exige, nesta ordem:

1. `from_epoch == current.epoch` (a rotação parte do conjunto atual);
2. assinaturas válidas do **conjunto ATUAL** `>= current.threshold` (2-de-3 do
   conjunto que está saindo — não do novo);
3. `new_set.threshold >= 2` (não pode reduzir o limiar);
4. **continuidade**: pelo menos um `key_id` do conjunto novo também existe no
   atual;
5. `new_set.validate()`: epoch **estritamente maior** que `from_epoch`, 2 a 5
   chaves, ordenadas, `threshold` válido.

Não existe caminho de rotação "de dentro": uma chave sozinha não muda o
conjunto, nem para se auto-promover, nem para remover as outras duas.

`ReleaseTrust::apply_rotation` persiste o novo conjunto em `release.trust`
(formato textual `epoch|threshold|id:pubkey,...`) e soma `up.revoked_versions` à
lista local `release.revoked`.

> **Ferramenta:** o payload é gerado por `tools/release-trust/rotate-keys.mjs`
> (ver `tools/release-trust/README.md` §6). Ele emite o `wire_hex` para colar em
> `update_trust_apply` e o arquivo de rotação guarda `payload_hex` e
> `signatures_hex` separados.
>
> **Formato no fio:** `TrustUpdate::from_wire` aceita `canonical_bytes` (payload)
> **seguido** do bloco de assinaturas — `u32 BE count` (1..=3) e, por assinatura,
> `string key_id` + `string sig`. O payload sozinho é recusado: uma rotação sem
> assinatura nunca entra no fluxo de aplicação. `encode_trust_update` é o
> inverso (usado pelas ferramentas). `update_trust_apply` decodifica com
> `from_wire` e passa para `verify_and_apply`, que exige o limiar do conjunto
> atual.

---

## 5. Revogação e epoch

### 5.1 `revoked_versions`

- declarada **dentro** do manifesto (e, quando o manifesto é válido, coberta pela
  assinatura);
- a checagem acontece **antes** da contagem de assinaturas: se a lista contém a
  própria `version`, o manifesto é `REVOGADO` mesmo sem assinatura válida. Na
  prática isso só permite a um atacante "revogar" a própria release forjada;
- toda versão revogada por um manifesto **aceito** é somada ao conjunto local e
  persistida (`release.revoked`, JSON array, ordenado e sem duplicata);
- `ReleaseTrust::accept` aplica a lista local **mesmo** quando a assinatura é
  válida;
- revogação de versão é permanente e local: não há comando para "desrevogar".

### 5.2 `revoked_key_ids`

- campo do corpo, validado (forma, ordem, tamanho) e coberto pela assinatura;
- **aplicado** em `verify_manifest`: qualquer assinatura cujo `key_id` aparece em
  `revoked_key_ids` é **descartada antes da contagem**;
- consequência: se um manifesto traz 3 assinaturas e uma delas é de chave
  revogada por ele mesmo, sobram 2 para o limiar; se a revogação derrubar abaixo
  do limiar, o status é `NAO_VERIFICADO`;
- um manifesto pode, portanto, se auto-revogar por chave — o autor declara que
  aquela chave não vale mais. Para remover a chave do conjunto de forma
  definitiva, ainda é preciso um `TrustUpdate` ou um build novo.

### 5.3 Piso monotônico de epoch

- `security_epoch` é um contador global que **nunca regride** numa release nova;
- o cliente guarda o maior valor já aceito em `release.epoch_floor`;
- `verify_manifest` calcula `piso = max(min_epoch_floor_local, body.min_security_epoch)`
  e devolve **OBSOLETO** quando `body.security_epoch < piso` — mesmo com 2 de 3
  assinaturas válidas;
- o piso declarado pela autoridade (`min_security_epoch`) vale para todos os
  clientes que virem aquele manifesto; o piso local protege contra rollback
  mesmo que um manifesto antigo reapareça;
- `ReleaseTrust::accept` só sobe o piso local (`if epoch > self.epoch_floor`),
  nunca desce;
- o piso é carregado no boot; se o `kv` estiver corrompido, o valor cai para `0`
  (o cache de manifestos é re-verificado no carregamento, então um cache
  adulterado no disco não vira confiança).

### 5.4 Cache de manifestos

`release.manifest.<manifest_hash>` guarda o wire em hex; no máximo 8 entradas
(`MAX_CACHED_MANIFESTS`). A eviction remove o **menor hash** (determinístico),
não o mais antigo — não há carimbo de tempo no cache. Ela apaga a chave na hora
(grava string vazia, que `StoreKv::set` converte em `kv_delete`). No
carregamento, cada entrada é re-verificada com o conjunto local e o piso; o que
não passar é ignorado (e a chave só desaparece na próxima eviction).

Chaves de `kv` usadas por esta camada:

| Chave | Conteúdo |
|---|---|
| `release.epoch_floor` | maior epoch já aceita (decimal) |
| `release.trust` | conjunto de confiança após rotação (texto da cerimônia) |
| `release.revoked` | versões revogadas conhecidas (JSON array) |
| `release.manifest.<hash>` | wire hex do manifesto assinado verificado |
| `release.self_integrity` | SHA-256 esperado do executável (64 hex) |
| `release.peer_policy` | `block_unverified` \| `block_revoked` \| `warn` |
| `release.update_pending` | registro do update baixado (ver `docs/UPDATER.md`) |

O antigo `release.applied_epoch` foi **removido** de `store.rs`: não tinha leitor
e manter um campo morto dava a impressão de controle que não existia. O controle
de rollback efetivo é o piso `release.epoch_floor`.

---

## 6. Atestação entre peers

### 6.1 Por que existe

A identidade Ed25519 do handshake prova **posse de uma chave**. Ela não diz nada
sobre o executável do outro lado. A atestação acrescenta uma segunda prova,
amarrada à conexão e ao artefato.

### 6.2 Frames (proto_v >= 5)

| Frame | Campos | Papel |
|---|---|---|
| `BuildChallenge` | `nonce_hex`, `transcript_hash`, `policy` | pergunta; `policy` é informativo e o receptor **ignora** (`..`) |
| `BuildAttestResponse` | `attestation_hex` | resposta JSON (`BuildAttestation`) em hex |
| `BuildManifestPush` | `manifest_hex` | manifesto assinado oferecido por um peer |
| `UpdateHint` | `version`, `manifest_hash` | aviso; nada é baixado por causa dele |

`ATTEST_PROTO_V = 5` (`release/attestation.rs`). Peer com `proto_v < 5` não
recebe desafio e permanece `NAO_VERIFICADO`.

### 6.3 Nonce

- 32 bytes de `rand::thread_rng` por consulta (`send_build_challenge`);
- guardado por peer em `attest_nonce` (um pendente por peer, sobrescrito por um
  novo desafio, removido quando a resposta é processada);
- mapa limitado a 4096 entradas (limpo ao estourar);
- um nonce nunca é reaproveitado: a próxima resposta exige novo desafio;
- `set_attest_transcript` guarda o hash do transcript da sessão atual (mapa
  limitado a 4096, limpo ao estourar).

Na desconexão (`engine.rs`, depois de `forget_peer`), `peer_trust`,
`attest_nonce` e `attest_transcript` daquele peer são **removidos**: o veredito é
por sessão, e reconectar sem nova prova não herda o estado anterior.

### 6.4 Binding

O payload assinado pela **identidade do peer** é:

```
BLAKE3(
  "distorrent/v1|build-attestation|"
  || transcript_hash_ascii          // blake3(transcript) do handshake, hex
  || nonce[32]                      // bytes crus do desafio
  || u32 BE (len(fp)) || fp_utf8    // fingerprint do peer
  || claim.canonical_bytes()
)
```

`claim.canonical_bytes()` (ordem fixa, todos u32 BE de comprimento + UTF-8):

1. `version`
2. `manifest_hash`
3. `build_id`
4. `commit`
5. `channel`
6. `self_integrity` (`CONFERE` \| `DIVERGE` \| `UNAVAILABLE`)
7. `hardware.mechanism` (`none` \| `tpm2` \| `secure_boot` \| `android_key_attestation`)
8. `protocol_version` (u32)
9. `security_epoch` (u64)

`hardware.reason` e `hardware.proof_available` **não** entram na assinatura: são
declaração, e o receptor os substitui pelo próprio cálculo (§9).

### 6.5 Verificação no receptor (`verify_attestation`)

O receptor usa **as próprias chaves embutidas**. Ele nunca aceita o veredito do
peer. Ordem:

1. **A prova tem de ser DESTA conexão.** `att.nonce` precisa ser exatamente o
   nonce que **este** lado enviou (guardado em `attest_nonce`); senão
   "nonce do desafio não confere (replay?)";
2. `att.transcript_hash == transcript_hash` da conexão atual — senão "prova
   amarrada a outro handshake";
3. assinatura Ed25519 do **peer autenticado** (`peer_pubkey_hex`) sobre o
   payload acima — senão "assinatura da atestação inválida";
4. conjunto de confiança local presente — se `None`, `verification_available =
   false` e o estado fica `NAO_VERIFICADO`;
5. `manifest_hex` não vazio, `<= 2 * 64 KiB` (hex; 64 KiB de bytes), hex
   válido, `SignedManifest::from_wire` válido;
6. `verify_manifest(trust_local, signed, floor_local)` — com `revoked_key_ids` e
   `min_security_epoch` aplicados;
7. a `claim` tem de bater com o manifesto **verificado** em `version`,
   `manifest_hash`, `commit`, `channel`, `security_epoch` — senão
   `NAO_VERIFICADO` ("declaração do peer não bate com o manifesto assinado");
8. se `claim.self_integrity == DIVERGE`, o peer **se declara** adulterado →
   `NAO_VERIFICADO`;
9. se `hardware.proof_available` (calculado localmente, não o declarado) →
   `ATESTACAO_DE_HARDWARE`.

O campo `valid_signatures` vem do manifesto (0..=3).

### 6.6 O que a assinatura de identidade prova — e o que não prova

> A assinatura Ed25519 da atestação prova **posse da chave de identidade** e que
> aquela chave assinou *aquela claim, naquela conexão*. Ela **não** prova que o
> executável do peer está intacto: um processo comprometido pode assinar uma
> claim verdadeira sobre um binário que não é o que está rodando.

`RELEASE_VERIFICADA` prova **procedência do artefato** (a autoridade autorizou
aquela versão/hash/URL), não a execução. A única coisa que fala do executável
local é `SelfIntegrityState` (§10), e ela é medida localmente, não declarada
pela UI.

### 6.7 Re-verificação de manifesto empurrado por peer

`BuildManifestPush` → `Engine::accept_peer_manifest`:

- limite de `2 * MAX_MANIFEST_BYTES` no hex;
- `SignedManifest::from_wire`;
- `ReleaseTrust::accept` com as chaves **locais**;
- só entra no cache se `is_verified()`;
- recusa não vira erro de sessão, só log (`debug!`).

Manifesto de peer nunca é ordem de atualização. `UpdateHint` só é logado (e só
para peer com `proto_v >= 5`).

### 6.8 Quarentena

Quando o veredito combinado com a política resulta em bloqueio
(`record_peer_trust`), o peer fica em quarentena. No laço de leitura
(`engine.rs`), **antes** de `handle_frame`:

```rust
if engine.peer_quarantined(peer_fp)
    && !crate::release::frame_allowed_in_quarantine(&frame)
{
    continue;   // descarta o frame; a sessão continua viva
}
```

Frames permitidos em quarentena (`frame_allowed_in_quarantine`):

- `Ping`, `Pong`, `Bye`;
- `BuildChallenge`, `BuildAttestResponse`, `BuildManifestPush`, `UpdateHint`.

Todo o resto — mensagem, arquivo, chamada, estado de comunidade — é descartado.
A sessão TCP **não** é derrubada: o objetivo é o peer descobrir que precisa
atualizar, não matar o link em silêncio.

---

## 7. Estados de confiança

`PeerTrustState` (serializado em `SCREAMING_SNAKE_CASE`):

| Estado | Como é atingido | O que prova | O que não prova |
|---|---|---|---|
| `NAO_VERIFICADO` | sem prova, assinatura falhou, claim divergente, receptor sem chaves | nada sobre o artefato | nada sobre o processo |
| `RELEASE_VERIFICADA` | manifesto com `>= threshold` assinaturas válidas, versão não revogada, epoch `>=` piso, claim == manifesto | a autoridade autorizou **aquele artefato** | que o peer está executando aquele artefato |
| `ATESTACAO_DE_HARDWARE` | `hardware.proof_available == true` após verificação local | (seria) prova de plataforma | **inalcançável neste build** (§9) |
| `REVOGADO` | manifesto declara a própria versão revogada, ou lista local contém a versão | a autoridade revogou aquela versão | que o peer seja malicioso |
| `OBSOLETO` | `security_epoch < piso local` | é rollback em relação ao que este cliente já viu | que a release seja falsa |

Política (`PeerPolicy`, padrão `block_revoked`):

| Política | `REVOGADO` | `OBSOLETO` | `NAO_VERIFICADO` (com verificação disponível) | `NAO_VERIFICADO` (sem chaves) |
|---|---|---|---|---|
| `block_unverified` | bloqueia | bloqueia | **bloqueia** | não bloqueia |
| `block_revoked` | bloqueia | bloqueia | não bloqueia | não bloqueia |
| `warn` | bloqueia | bloqueia | não bloqueia | não bloqueia |

`REVOGADO` e `OBSOLETO` bloqueiam sob **qualquer** política, inclusive `warn`
(`PeerPolicy::decision` testa esses dois estados antes de olhar a política).
`BlockUnverified` nunca bloqueia em massa quando o cliente não tem como
verificar.

---

## 8. Limites de recurso (anti-DoS da própria camada)

`net/netlimit.rs` (defaults; `DISTORRENT_LIMIT_*` sobrescreve):

| Bucket | Taxa / 10 s | Burst | Env |
|---|---|---|---|
| desafio/resposta de atestação, por peer | 10 | 6 | `DISTORRENT_LIMIT_ATTEST_10S` / `_BURST` |
| `BuildManifestPush`, por peer | 4 | 2 | `DISTORRENT_LIMIT_MANIFEST_PUSH_10S` / `_BURST` |
| falhas de atestação, por peer | 3 | 2 | `DISTORRENT_LIMIT_ATTEST_FAIL_10S` / `_BURST` |
| verificações simultâneas (global) | — | 16 vagas | `DISTORRENT_LIMIT_ATTEST_CONC` |

Fluxo no `handle_frame` de `BuildAttestResponse`:

1. `allow_attest` (bucket por peer) — estourado, descarta;
2. exige nonce pendente e transcript;
3. limite de 256 KiB **de hex** no `attestation_hex` (128 KiB de bytes);
4. decodifica hex + JSON;
5. `attest_failure_budget` (consulta **sem consumir**): sem orçamento de falhas,
   descarta **antes** de gastar CPU;
6. `try_attest_slot` (teto global de verificações simultâneas) — sem vaga,
   descarta;
7. `verify_attestation`;
8. se o veredito não é verificado, `note_attest_failure` **consome** o bucket de
   falhas;
9. grava o veredito e **consome o nonce**.

> O par `attest_failure_budget` (consulta) + `note_attest_failure` (consome) é o
> que faz o teto de falhas valer: um peer que só manda assinatura inválida
> esgota o orçamento e as respostas seguintes são descartadas sem trabalho
> criptográfico até a janela recarregar.

---

## 9. Atestação de hardware — status honesto

`attest_hardware` devolve sempre `HardwareStatus::none(motivo)` com
`proof_available: false`. Motivos por plataforma:

| Plataforma | Motivo registrado |
|---|---|
| Windows | TPM 2.0/Secure Boot existem no SO, mas um quote verificável exige cadeia de EK/endosso e política de PCR que o app não possui sem admin |
| Linux | IMA/TPM quote exige root e chaves de endosso; o AppImage não tem como produzir prova verificável por peers |
| Android | Key Attestation do AndroidKeyStore não é verificada por este build (sem a cadeia raiz da Google embutida); não é apresentada como prova |
| outras | plataforma sem mecanismo de atestação implementado |

O peer emissor também declara `HardwareStatus::none("prova de plataforma não
implementada neste build")` (`own_build_attestation`). E o receptor **ignora o
`proof_available` declarado**: recalcula localmente com `attest_hardware`. Um
peer não consegue se auto-promover a `ATESTACAO_DE_HARDWARE` dizendo
`proof_available: true`.

Consequência: `ATESTACAO_DE_HARDWARE` é **inalcançável** neste build. Implementar
um quote pela metade seria pior que não ter — o peer não teria como validar a
cadeia e o estado viraria teatro.

---

## 10. Auto-integridade (`SelfIntegrityState`)

`self_integrity(store)`:

1. lê `release.self_integrity` (SQLite `kv`) — precisa ter 64 hex;
2. `std::env::current_exe()` → lê os bytes do arquivo;
3. SHA-256 dos bytes;
4. igual ao esperado → `CONFERE`; diferente → `DIVERGE`; sem valor, sem permissão
   de leitura ou caminho inválido → `UNAVAILABLE`.

| Prova | Não prova |
|---|---|
| os bytes do **arquivo** que abriu este processo são os que geraram aquele SHA-256 | que o processo **em execução agora** é esse arquivo (o arquivo pode ser trocado depois do boot) |
| — | que a memória do processo não foi alterada (patch em runtime) |
| — | que o instalador que gravou o arquivo foi autêntico (isso é a assinatura do manifesto) |

`src-tauri/src/updater.rs` **não chama** mais `set_expected_self_sha256` no
`update_apply`. O bloco Windows agora tem só um comentário explicando o motivo:
`pending.sha256` é o hash do **instalador** (`.exe` do Inno), não do
`distorrent.exe` que sai da instalação; gravá-lo faria o próximo boot acusar
`DIVERGE` sempre — "mentira pior que `UNAVAILABLE`".

> **Não implementado:** não existe hoje nenhum caminho que grave
> `release.self_integrity`. O contrato pretendido: o manifesto publica o
> SHA-256 do **executável** como asset próprio (separado do instalador), e
> depois de uma atualização verificada o app grava esse valor para comparar no
> boot seguinte. Enquanto o manifesto só publicar o instalador, a medição fica
> `UNAVAILABLE` — que é o estado honesto, porque a referência não existe.
>
> **Também não implementado:** medição em Linux e Android. Não há chamador em
> nenhuma plataforma.

A UI mostra `CONFERE` / `DIVERGE` / `UNAVAILABLE`; `DIVERGE` faz o peer que
declara isso cair para `NAO_VERIFICADO` no lado do receptor (§6.5, passo 8).

---

## 11. Cerimônia de chaves

`tools/release-trust/`:

| Arquivo | Papel |
|---|---|
| `ceremony.mjs` | gera N (2..5) sementes Ed25519 de 32 bytes, grava `signer-N.key` (0600 em POSIX) em `~/.distorrent-release-keys` por padrão, e imprime a linha `epoch\|threshold\|id:pubkey,...` para colar em `trust_keys.rs`. **Não escreve no repositório.** |
| `sign-release.mjs` | lê um manifesto JSON autoral, confere/refaz `size`+`sha256` a partir de `--asset-dir`, ordena assets e listas, assina com 2 ou 3 chaves do conjunto e escreve `<out>.bin` — exatamente o que o app baixa como `distorrent-manifest.bin` |
| `rotate-keys.mjs` | gera o `TrustUpdate` assinado por ≥ 2 chaves do conjunto **atual**, com `--new-key`/`--threshold`/`--epoch`/`--revoke`/`--reason`; emite `payload_hex`, `signatures_hex` e `wire_hex` |
| `verify-release.mjs` | decoder **próprio** (não reusa o encoder do assinador): decodifica, re-encoda e exige igualdade byte-a-byte; valida assinaturas contra um `trust-set.txt`; `--file nome=caminho` confere SHA-256 de instalador local; `--min-epoch` aplica piso. Exit ≠ 0 em qualquer falha |
| `lib.mjs` | encoding canônico espelho de `manifest.rs`, validação, assinatura/verificação, parser/formatter do conjunto de confiança |
| `crosscheck.mjs` | compara os bytes gerados pelo Node com o vetor fixo do Rust (`distorrent-core/tests/fixtures/release_vector.json`) |
| `selftest.mjs` / `selftest-scan.mjs` | autotestes da cerimônia/assinatura/verificação/rotação e do scanner de segredos |
| `README.md` | procedimento operacional completo (cerimônia, assinatura, verificação, rotação, perda/comprometimento de chave) |

Limites que a ferramenta espelha do Rust: `MAX_MANIFEST_BYTES = 64 KiB`,
`MAX_ASSETS = 32`, `MAX_REVOKED = 512`, `MAX_SIGNATURES = 3`,
`MAX_TRUST_KEYS = 5`, `MIN_THRESHOLD = 2`, `MAX_ASSET_BYTES = 4 GiB`.

Regras operacionais que o código impõe:

- as chaves privadas **nunca** entram no repositório (`ceremony.mjs` avisa e não
  escreve lá; `*.key` está no `.gitignore`);
- `sign-release.mjs` recusa menos de 2 chaves distintas, recusa chave repetida,
  recusa chave que não esteja no `--trust` e recusa `signers < threshold`;
- 3 chaves guardadas em 3 lugares separados, 2 necessárias para assinar (o
  default da cerimônia é `--keys 3 --threshold 2`);
- `--force` na cerimônia deixa claro que as releases antigas deixam de verificar
  contra o conjunto novo; trocar de chaves é `rotate-keys`, não `--force`;
- `verify-release.mjs` tem decoder próprio e exige re-encode byte-a-byte, para
  que um bug compartilhado entre assinador e verificador não passe despercebido;
- `crosscheck.mjs` trava a paridade Node↔Rust contra
  `distorrent-core/tests/fixtures/release_vector.json`; `release_trust_e2e.rs`
  (12 testes) cobre o fluxo 2-de-3, rollback, claim mentirosa, adulteração,
  revogação, chave única, assinatura duplicada, projeto errado, key_id forjado,
  rotação com epoch repetida e cache.

**Interop da rotação provada nas duas direções:**
`distorrent-core/tests/rotation_interop.rs` decodifica o arquivo real que
`rotate-keys.mjs` produz (payload + bloco `u32 count` + `(key_id, sig)`) com
`TrustUpdate::from_wire`, aplica com `verify_and_apply` e reencoda byte-a-byte.
O mesmo teste confirma que **uma** assinatura não rotaciona e que adulterar o
payload é recusado. O fixture `tests/fixtures/rotation_vector.json` é gerado por
`tools/release-trust/emit-rotation-vector.mjs` e contém só chaves públicas e
assinaturas.

**`scripts/scan-secrets.mjs` roda em CI** (job `web` do `ci.yml` e job
`secrets-scan` do `release.yml`, que bloqueia o job `release`).

---

## 12. O que esta camada NÃO garante

1. **A raiz embutida é uma única cerimônia, sem transparência pública.** Este
   build carrega uma linha de confiança (epoch 1, 2-de-3). Quem controlar 2 das
   3 chaves assina qualquer release. Não existe log público append-only para
   provar que uma release *deixou de existir*.
2. **Não prova integridade do processo em execução.** Só a procedência do
   artefato. `SelfIntegrityState` continua `UNAVAILABLE` (não há referência
   publicada do executável) e, mesmo com ela, só olharia o arquivo em disco.
3. **Não há atestação de hardware.** `proof_available` é sempre `false`.
4. **Não há build reprodutível verificado.** O `commit` no manifesto é assinado,
   mas nada no cliente reconstrói o binário para comparar.
5. **Não há transparência de log** (nenhum append-only público de manifestos):
   quem controla o GitHub pode esconder uma release, embora não consiga assinar
   uma falsa sem 2 de 3 chaves offline.
6. **O limiar protege contra 1 chave, não contra 2.** Uma chave isolada não
   assina release nem roda rotação; duas chaves comprometidas (ou dois
   operadores coagidos) assinam qualquer coisa que o conjunto novo permitir.
7. **Não há revogação de chave emergencial sem publicar um `TrustSet` novo**, o
   que exige 2 assinaturas do conjunto antigo — se duas chaves forem perdidas
   ao mesmo tempo, não há recuperação criptográfica.
8. **Não há sandbox de execução.** Depois que `update_apply` inicia o
   instalador, o app não controla mais o que ele faz. Um `.deb` é entregue ao
   gerenciador do sistema sem validação de pacote.

---

## 13. Estado deste build (pendências conhecidas e verificáveis)

Itens verificados nesta árvore de trabalho. O que já foi corrigido está anotado
como corrigido, para não ser "redescoberto" como bug:

1. ~~`transport::PROTO_V` era `4`~~ — **corrigido**: agora vale `5`
   (`net/transport.rs`), igual a `ATTEST_PROTO_V`. Builds que anunciam 4 não
   são desafiados (e ficam `NAO_VERIFICADO`, o estado honesto).
2. ~~Desafio enviado antes de `peer_protos` ser preenchido~~ — **corrigido**:
   `register_and_run` preenche `peer_protos` primeiro e só depois chama
   `send_build_challenge`, com comentário explícito sobre a ordem.
3. ~~Rotação descartava as assinaturas~~ — **corrigido**:
   `TrustUpdate::from_wire` lê o bloco `u32 count` + `(key_id, sig)` depois do
   `reason` e recusa payload sem assinatura.
4. ~~`revoked_key_ids` e `min_security_epoch` sem uso~~ — **corrigido**:
   `verify_manifest` descarta assinaturas de chave revogada e aplica
   `max(piso_local, min_security_epoch)`.
5. **`release.applied_epoch` removido.** O contador não tinha leitor e foi
   retirado em vez de ficar como campo morto (`store.rs`).
6. **`set_expected_self_sha256` não tem chamador.** O `update_apply` deixou de
   gravar o hash do instalador (seria `DIVERGE` garantido) e nenhum caminho grava
   o hash do executável. `SelfIntegrityState` fica `UNAVAILABLE` por falta de
   referência (§10). É uma limitação declarada, não um "ok" implícito.
7. ~~`scripts/scan-secrets.mjs` não rodava em CI~~ — **corrigido**: o job `web`
   do `ci.yml` roda o scanner e o job `secrets-scan` do `release.yml` bloqueia a
   publicação.
8. **Não há build reprodutível verificado** (§12, item 4).

Com 1 e 2 corrigidos, o caminho de atestação existe de ponta a ponta **e a raiz
de confiança está embutida** (epoch 1, 2-de-3). Verificado com as chaves reais
em `production_key_accepts.rs`: o manifesto assinado por 2 das 3 chaves passa
por `verify_manifest` contra a constante compilada; com 1 assinatura ou com 1
byte alterado, não passa.

Ainda assim, `RELEASE_VERIFICADA` só aparece quando o peer apresenta um
manifesto que o RECEPTOR consegue verificar. Peer que não apresenta nada fica
`NAO_VERIFICADO` — e é isso que o estado diz.
