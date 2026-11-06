# Release signing — offline ceremony

Ferramentas para assinar e verificar o **manifesto de release** do DisTorrent e
para rotacionar o conjunto de confiança. Tudo roda em Node puro (ESM), sem rede
e sem dependência nova: `@noble/ed25519` e `@noble/hashes` já estão no
`package.json`.

O formato binário **não é definido aqui**. A fonte de verdade é o Rust:

| Arquivo | Define |
|---|---|
| `distorrent-core/src/release/manifest.rs` | `MANIFEST_MAGIC` `DTMF1`, ordem dos campos, limites, validação, `to_wire`/`from_wire` |
| `distorrent-core/src/release/trust.rs` | `parse_trust_set`, 2-de-3, `TrustUpdate` (rotação) |
| `distorrent-core/src/release/trust_keys.rs` | `TRUST_SET_BOOTSTRAP`, a única raiz de confiança do build |

Se este documento e o Rust divergirem, **o Rust está certo** e a ferramenta está
com bug. Não "conserte" o Rust para bater com o script.

---

## 1. O que é assinado (e o que isso prova)

```
payload = blake3("distorrent/v1|release-manifest|" || body_canonico)
```

`body_canonico` é o encoding fechado de `ManifestBody::canonical_bytes`:
`DTMF1`, schema `u16`, strings com prefixo `u32` BE, `i64` para data, `u32`
para protocolo, `u64` para epoch, contagem + strings para as listas de
revogação, contagem + registros de asset — **todos os inteiros big-endian**.

Cada assinatura Ed25519 (64 bytes) cobre **todos** os campos do body: versão,
canal, tag, commit, data, versões de protocolo, epochs, listas de revogação e,
por asset, nome/os/arch/tamanho/sha256/url. Mudar um byte de qualquer um deles
invalida a assinatura.

`manifest_hash = blake3(body_canonico)` é o identificador que os peers trocam.
Não confunda com o payload: o payload é o hash **da string de domínio + body**.

### O que uma assinatura válida prova

Prova que **aquele artefato** (aquele tamanho, aquele SHA-256, aquela URL,
aquela arquitetura) foi autorizado por 2 das 3 chaves. Não prova que o processo
que está rodando é aquele binário — isso é `SelfIntegrityState`, medido no
executável, não declarado no manifesto.

### Formato no fio

```
u32 BE body_len
body_len bytes do body canônico
u32 BE sig_count            (1..=3)
para cada assinatura:
  u32 BE len + key_id       (16 hex = primeiros 8 bytes de blake3(pubkey))
  u32 BE len + sig          (128 hex = 64 bytes Ed25519)
```

Esse arquivo é publicado como asset da release com o nome **exato**
`distorrent-manifest.bin` (é o nome que `src-tauri/src/updater.rs` procura).
Uma release sem esse asset é recusada pelo app: não há como verificar a
procedência.

---

## 2. Cerimônia inicial (três máquinas offline, ideal)

O objetivo é que **nenhuma máquina sozinha** consiga assinar em nome do
projeto. Duas de três chaves bastam para autorizar; uma só não faz nada.

### Preparação (uma vez)

- 3 máquinas (ou 3 volumes offline) que nunca acessam a rede durante a
  cerimônia. Notas de release e commit podem ser levados em papel/pendrive.
- 3 pessoas diferentes, cada uma guardando **uma** chave. Se for uma pessoa só,
  ainda assim separe em 3 mídias: um pendrive único com as 3 seeds não é
  2-de-3, é 1-de-1.
- No Windows: a pasta das chaves precisa estar em volume **BitLocker** (ou
  disco removível guardado fisicamente). Não existe `chmod` no NTFS; o arquivo
  herda a ACL do diretório, e o script avisa isso na saída.
- No POSIX: `chmod 0600` é aplicado automaticamente.

### Gerar as chaves

Em **cada** máquina, gere a chave que ela vai guardar. O modo recomendado é
gerar as 3 de uma vez numa máquina offline e distribuir por papel — é mais
simples de conferir, e todas as pubs entram numa linha só:

```bash
node tools/release-trust/ceremony.mjs --init --keys 3 --threshold 2 --epoch 1
```

Saída (resumida):

```
Conjunto gerado: epoch=1 threshold=2 chaves=3
Diretorio: /home/voce/.distorrent-release-keys

Chaves privadas (segredo NUNCA impresso; guarde cada uma offline):
  /home/voce/.distorrent-release-keys/signer-1.key
    key_id    ab12cd34ef567890
    pubkey    9f86...e1
  ...

Linha de confianca (tambem em .../trust-set.txt):
  1|2|ab12cd34ef567890:9f86...,4d5e6f708192a3b4:...,...
```

- Diretório padrão: `~/.distorrent-release-keys` — **fora do repositório**.
  `--dir` muda (use um volume separado por chave).
- `signer-N.key` contém **só** 32 bytes de semente em hex + newline. Nada mais.
- O segredo **nunca** é impresso, nem em log de erro.
- Sobrescrever exige `--force`, e o script avisa em bloco que as assinaturas
  antigas deixam de verificar. O caminho normal para trocar chaves é
  `rotate-keys.mjs`, não `--force`.

`--keys` aceita 2..5 (o Rust limita `TRUST_KEYS_MAX = 5`) e `--threshold`
2..keys (`MIN_THRESHOLD = 2`). Para 2-de-3 use `--keys 3 --threshold 2`.

**Não rode a cerimônia de novo "para arrumar".** Um conjunto novo tem epoch
nova e invalida tudo que foi assinado antes.

### Embutir a raiz de confiança

O script **não escreve no repositório** (de propósito: a linha é o resultado da
cerimônia, e quem cola é o operador). Edite à mão:

```rust
// distorrent-core/src/release/trust_keys.rs
pub const TRUST_SET_BOOTSTRAP: &str =
    "1|2|ab12cd34ef567890:9f86...,4d5e6f708192a3b4:...,...";
```

Chaves ordenadas por `key_id` — `TrustSet::validate` recusa fora de ordem.
Depois:

```bash
cd distorrent-core && cargo test release::
```

O teste `bootstrap_vazio_nao_vira_confianca_implicita` **vai falhar** se você
preencher o arquivo; ele existe para garantir que o repositório versionado fica
vazio. Confira o build de produção pela linha embutida, não por esse teste.

Enquanto a constante estiver vazia, `bootstrap_trust_set()` devolve erro e o
cliente trata **toda** release como não verificada (fail-closed). Em build de
debug existe `DISTORRENT_TRUST_SET` como atalho local; **em release não**
(`#[cfg(debug_assertions)]`).

---

## 3. Assinar uma release

### 3.1 Manifesto JSON (autoral)

O JSON é entrada humana; o que circula é o `.bin`. Campos:

```json
{
  "version": "1.1.62-pre-alpha",
  "channel": "stable",
  "tag": "v1.1.62",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "published_at_ms": 1762345678901,
  "protocol_version": 5,
  "min_protocol_version": 4,
  "security_epoch": 12,
  "min_security_epoch": 9,
  "revoked_versions": ["1.1.60"],
  "revoked_key_ids": [],
  "assets": [
    {
      "name": "DisTorrent_1.1.62_x64_setup.exe",
      "os": "windows",
      "arch": "x86_64",
      "url": "https://github.com/ArthurFreire77/dis-torrent/releases/download/v1.1.62/DisTorrent_1.1.62_x64_setup.exe"
    }
  ]
}
```

Regras que o assinador aplica (as mesmas do Rust — ele recusa antes de gerar
bytes que o app rejeitaria):

- `version`: `N.N.N` com sufixo opcional após `-` (ex.: `-pre-alpha`), ≤ 64
  bytes, cada parte numérica ≤ 9 dígitos.
- `tag`: `v` + a parte `N.N.N` da versão. `v1.1.62` para `1.1.62-pre-alpha`.
  (Rust usa `trim_start_matches('v')`, que remove **todos** os `v` iniciais.)
- `commit`: SHA-1 de 40 hex.
- `published_at_ms`: inteiro > 0.
- `protocol_version`: 1..1.000.000; `min_protocol_version` ≤ ele.
- `min_security_epoch` ≤ `security_epoch`.
- `schema` é fixo em 1 e `project` em `"distorrent"` — não se escreve no JSON.
- `assets`: 1..32. `name` sem `/` nem `\`, ≠ `.`/`..`, ≤ 255 bytes. `url`
  **https** e ≤ 1024 bytes. `size` 1..4 GiB. `sha256` 64 hex.
- `revoked_versions` / `revoked_key_ids`: ≤ 512, ordenados e sem repetição.

O assinador **ordena sozinho** `revoked_versions`, `revoked_key_ids`
(lexicográfico crescente, por bytes UTF-8) e `assets` (por `os`, `arch`,
`name`), e **rejeita duplicatas**. Não tente pré-ordenar "no olho".

### 3.2 Calcular size/sha256 dos instaladores

Com os arquivos locais, deixe o script calcular:

```bash
node tools/release-trust/sign-release.mjs \
  --manifest release.json \
  --trust ~/.distorrent-release-keys/trust-set.txt \
  --key /media/signer-1.key \
  --key /media/signer-3.key \
  --asset-dir ./dist-release \
  --refresh-hashes
```

Sem `--asset-dir`, `size` e `sha256` precisam estar no JSON.

**Com `--asset-dir` sem `--refresh-hashes`**, os valores do JSON são
*conferidos* contra o arquivo: se `size` ou `sha256` divergirem, o script
**falha**. Isso é deliberado — assinar um hash que o arquivo não tem produz um
manifesto que nenhum peer consegue baixar, e o erro só apareceria no usuário
final. `--refresh-hashes` é a forma explícita de dizer "o arquivo manda".

### 3.3 Assinar

```bash
node tools/release-trust/sign-release.mjs \
  --manifest release.json \
  --trust ~/.distorrent-release-keys/trust-set.txt \
  --key /media/signer-1.key \
  --key /media/signer-3.key \
  --asset-dir ./dist-release
```

- **2 ou 3** `--key`. Com 1 o script recusa ("são necessárias 2 chaves
  distintas autorizadas").
- Chave repetida é recusa. Chave que não está no `--trust` é recusa (o app
  ignoraria a assinatura e o manifesto sairia com menos votos do que parece).
- Gera `release.bin` (ou `--out <prefix>.bin`).
- Imprime `manifest_hash`, tamanho do body, key ids e as assinaturas em hex
  truncado. **Nunca** imprime semente.

O `.bin` gerado é **idêntico byte-a-byte** ao que `SignedManifest::to_wire`
produz. Isso é verificado contra o vetor fixo gerado pelo Rust em
`distorrent-core/tests/fixtures/release_vector.json` (body canônico, hash e
wire completo).

### 3.4 Publicar

```bash
node scripts/publish-release.mjs v1.1.62 notes.md \
  dist-release/DisTorrent_1.1.62_x64_setup.exe \
  dist-release/DisTorrent_1.1.62_arm64.apk \
  dist-release/DisTorrent_1.1.62_amd64.deb \
  dist-release/DisTorrent_1.1.62_amd64.AppImage \
  release.bin   # renomeie para distorrent-manifest.bin antes de subir
```

O nome do asset precisa ser exatamente `distorrent-manifest.bin`. O updater
procura por esse nome em cada release; sem ele, a release é ignorada com a
mensagem "não há como verificar a procedência".

---

## 4. Verificar

```bash
node tools/release-trust/verify-release.mjs \
  --manifest release.bin \
  --trust ~/.distorrent-release-keys/trust-set.txt
```

Imprime versão, tag, commit, epochs, o `manifest_hash` e cada asset
(nome, os/arch, tamanho, sha256 curto, URL), o estado de cada assinatura, e
termina em `PASS` ou `FAIL`. **Exit code ≠ 0 em qualquer falha.**

O verificador tem **decoder próprio**: não importa o codificador do assinador.
Ele decodifica o que chegou, reencoda e exige igualdade byte-a-byte com os
bytes recebidos. Um bug nos dois lados não passa despercebido, e um arquivo
"canônico" só na aparência é rejeitado.

Conferir um instalador local contra o manifesto:

```bash
node tools/release-trust/verify-release.mjs \
  --manifest release.bin \
  --trust ~/.distorrent-release-keys/trust-set.txt \
  --file DisTorrent_1.1.62_x64_setup.exe=./dist-release/DisTorrent_1.1.62_x64_setup.exe
```

Calcula o SHA-256 do arquivo e compara com o assinado; `OK` ou `DIVERGE`, e
qualquer divergência derruba o exit code.

`--min-epoch <n>` aplica o piso local (rollback): uma release com epoch menor é
rejeitada mesmo com assinatura válida — é o mesmo papel do
`min_epoch_floor` do Rust.

---

## 5. Onde as chaves vivem

| O quê | Onde | Versionado? |
|---|---|---|
| Semente de cada signer | `signer-N.key`, em mídia offline separada | **nunca** |
| Linha de confiança | `trust-set.txt` + `TRUST_SET_BOOTSTRAP` no Rust | sim (só pubkeys) |
| Manifesto assinado | `distorrent-manifest.bin` como asset da release | sim (público) |
| Payload de rotação | arquivo de texto guardado pelo operador | sim (público) |

`*.key` já está no `.gitignore` (assim como `*.pfx`, `*.jks`, `*.keystore`,
`*.pem`...). **Não confie nisso como proteção**: rodar
`node scripts/scan-secrets.mjs` antes de commitar, e nunca usar `git add -A`
num diretório que tenha chaves.

---

## 6. Rotação de chaves

Rotação **não** é gerar chaves novas e trocar a constante. É um `TrustUpdate`
assinado pelo conjunto **atual**, que o app aplica e que passa a valer — e a
mesma linha vai para o build seguinte.

```bash
node tools/release-trust/rotate-keys.mjs \
  --from ~/.distorrent-release-keys/trust-set.txt \
  --key /media/signer-1.key --key /media/signer-2.key \
  --new-key /media/signer-3.key \
  --new-key /media/new-a.key --new-key /media/new-b.key \
  --threshold 2 --epoch 2 \
  --revoke 1.1.60 \
  --reason "rotação anual: signer-1 e signer-2 aposentadas" \
  --out rotation-1-2.txt
```

### Regras (as mesmas de `TrustUpdate::verify_and_apply`)

- Assinada por **≥ 2 chaves do conjunto atual** (`--key`). Chave de fora do
  conjunto atual é **erro local**, não "assinatura ignorada".
- `--epoch` (nova) tem de **avançar** a atual.
- `--threshold` nunca abaixo de 2.
- **Continuidade**: o conjunto novo precisa manter **pelo menos uma** chave do
  atual. Sem isso o Rust recusa (`rotação sem continuidade`). O script avisa
  antes: mostra quais chaves são `(mantida do conjunto atual)` e quais são
  `(nova)`.
- `--new-key` aceita `.key` (deriva a pubkey da semente) ou `.pub` (32 bytes
  hex da pubkey). Arquivo `.key` **não é lido com segredo em log** — só serve
  para derivar a pubkey aqui.
- `--reason` é obrigatório (≤ 512 bytes).
- `--effective-ms` é quando a rotação passa a valer (padrão: agora).

### O que sai

Um arquivo de texto com `payload_hex` (o `TrustUpdate::canonical_bytes`),
`signatures_hex` (bloco `u32 count` + `(key_id, sig)`), o `wire_hex` completo
(payload + bloco) para colar em `update_trust_apply`, e a nova linha de
confiança para o build seguinte.

### Verificado nas duas direções (não é promessa)

`TrustUpdate::from_wire` (em `distorrent-core/src/release/trust.rs`) decodifica
o payload **e** o bloco de assinaturas; payload sem assinatura é recusado no
parse. O teste `distorrent-core/tests/rotation_interop.rs` usa o arquivo real
gerado por `rotate-keys.mjs` (fixture `tests/fixtures/rotation_vector.json`,
regenerável com `node tools/release-trust/emit-rotation-vector.mjs`) e prova:

- o `wire_hex` decodifica e `verify_and_apply` devolve o conjunto novo;
- reencodar produz os mesmos bytes (forma canônica);
- **uma** assinatura não rotaciona;
- adulterar o payload é recusado.

Se a rotação não for possível (duas chaves perdidas), o caminho é substituir
`TRUST_SET_BOOTSTRAP` e publicar um build novo — com o custo de que usuários em
versões antigas não aceitam a troca automaticamente.

---

## 7. Perda e comprometimento

### Perdi uma chave (mídia morreu, pessoa saiu)

Nada quebra enquanto **2 das 3** estiverem intactas: você continua assinando
com as duas restantes. Faça a rotação com as duas que sobraram, mantendo uma
delas e trazendo duas novas (o conjunto novo fica com 3). Até a rotação ser
aplicada, a chave perdida ainda *poderia* assinar — mas não há como alguém usá-la
sem tê-la.

### Perdi duas chaves (não consigo mais 2-de-3)

Aí a raiz de confiança acabou: nenhuma release nova consegue 2 assinaturas do
conjunto atual, e a rotação é impossível (exige 2 do conjunto atual). O caminho
é uma **nova cerimônia** (`ceremony.mjs --init`, epoch novo) e um build que
embuta a nova `TRUST_SET_BOOTSTRAP`. Isso quebra a continuidade: quem está em
versão antiga não aceita releases novas automaticamente e precisa atualizar por
fora. Trate como incidente, não como rotina.

### Uma chave foi comprometida (vazou / máquina invadida)

1. **Assuma que tudo que ela podia assinar está em dúvida** — mas lembre que
   sozinha ela não autoriza nada: o atacante precisa de **duas**.
2. Rotacione imediatamente com as **outras duas** chaves, sem incluir a
   comprometida no conjunto novo. Ela sai da raiz.
3. Coloque `revoked_key_ids` no próximo manifesto (e/ou `--revoke` na
   rotação), para que quem já aplicou o conjunto novo recuse o que ela assinou.
4. Se a comprometida foi usada em conjunto com outra, trate as duas como
   perdidas e vá para "perdi duas".
5. Se houver suspeita de release publicada com assinatura fraudulenta,
   **avise os usuários**; verificar procedência não desfaz um download já feito.

### Rotação de rotina (anual)

Rode `rotate-keys.mjs` mantendo uma chave antiga, traga duas novas, avance a
epoch, publique o payload e gere um build com a nova linha. Guarde o arquivo de
rotação: ele é a prova do que mudou e quando.

---

## 8. Varredura de segredos

```bash
node scripts/scan-secrets.mjs
```

Percorre a árvore (fora de `.git`, `node_modules`, `target`, `dist`,
`dist-release`, `test-results`, ...) e falha em:

- bloco `-----BEGIN ... PRIVATE KEY-----`;
- atribuição **com valor literal** de `WINDOWS_CERT_PFX_BASE64` ou
  `DISTORRENT_SIGN_PASSWORD` (referência a `${{ secrets.* }}`, `$env:NOME` ou
  placeholder não conta);
- hex de 32 bytes em contexto de segredo (semente Ed25519);
- arquivo cujo conteúdo é **só** 64 hex — o formato exato de `signer-N.key`;
- `*.key`, `*.pem`, `*.pfx`, `*.p12`, `*.jks`, `*.keystore` versionados no git
  ou presentes sem cobertura do `.gitignore`.

**Nunca imprime o valor encontrado** — só arquivo, linha e uma dica redigida.
O log de CI é público; a varredura não pode virar o vazamento.

`src-tauri/gen/android/app/debug.keystore` é uma exceção conhecida e aparece
como **AVISO** (é a chave de debug pública do template Android).

### Diretiva de fixture: `secret-scan: allow`

Um teste que precisa *conter* uma chave de mentira para provar que o scanner a
detecta tropeça nele mesmo. A saída é a mesma convenção já usada em
`distorrent-core/tests/release_vector.rs`:

```js
// secret-scan: allow  (fixture de teste, nao e' segredo)
const pem = '-----BEGIN ... PRIVATE KEY-----'
```

Vale na própria linha, na linha seguinte, ou para o arquivo inteiro se estiver
nas primeiras 40 linhas. Não é um "ignore" genérico: o marcador é explícito,
grepável e revisável no code review. Um `signer-N.key` real não tem esse
marcador — foi verificado que um arquivo com só 64 hex continua bloqueando
mesmo que outro arquivo na mesma árvore tenha a diretiva.

Pensado para virar job de CI. Rode `--verbose` para ver também referências e
arquivos ignorados.

---

## 9. Autotestes

```bash
node tools/release-trust/selftest.mjs       # cerimônia, assinatura, verificação, rotação
node tools/release-trust/selftest-scan.mjs  # o scanner pega o que deve pegar
node tools/release-trust/crosscheck.mjs     # bytes Node == Rust (vetor do Rust)
```

Ambos usam `os.tmpdir()` e apagam tudo no fim. **Nenhuma chave gerada encosta no
repositório.** O autoteste do scanner faz `git init` num diretório temporário
próprio e planta senhas/chaves de mentira para provar que o scanner falha
quando deve — e que não vaza o valor na saída.

Estado atual: `selftest.mjs` 48/48, `selftest-scan.mjs` 21/21,
`crosscheck.mjs` 8/8.

---

## 10. Procedimento de produção (resumo)

1. **Uma vez:** cerimônia offline em 3 mídias; cole a linha em
   `TRUST_SET_BOOTSTRAP`; `cargo test release::`; build de release.
2. Gere o JSON do manifesto com versão/tag/commit reais.
3. `sign-release.mjs --asset-dir <pasta dos instaladores>` (confere ou
   recalcula size/sha256), assinando com **2 chaves**.
4. `verify-release.mjs` no `.bin` recém-gerado: precisa dar `PASS`. Confira
   também cada instalador com `--file`.
5. Publique os instaladores e `distorrent-manifest.bin` na release.
6. Guarde as chaves privadas **offline**, separadas, fora de qualquer pasta
   sincronizada com nuvem. O repositório só conhece pubkeys.
7. `node scripts/scan-secrets.mjs` antes de commitar.
