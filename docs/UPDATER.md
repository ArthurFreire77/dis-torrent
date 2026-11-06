# Atualizador — contrato de segurança

Implementação: `src-tauri/src/updater.rs` + `distorrent-core/src/release/`
(`store.rs`, `trust.rs`, `manifest.rs`) + `distorrent-core/src/net/release_trust.rs`.
Fronteira de UI: `src/services/updater.ts`, `src/services/updateRules.ts`,
`src/components/UpdateGate.tsx`.

Regra que resume o desenho:

> **GitHub Releases é distribuição, não autoridade.** O GitHub diz *onde* o
> arquivo está; o manifesto assinado diz *o que* pode ser instalado.

---

## 1. Fluxo de checagem

```
update_check
  ├─ carrega ReleaseTrust do SQLite local (chaves embutidas + rotação + piso)
  ├─ respeita a janela de 6 h / backoff (reaproveita a LISTA de releases em
  │   cache, mas ainda baixa e re-verifica o manifesto — ver §7)
  ├─ GET api.github.com/.../releases?per_page=20   (If-None-Match quando há ETag)
  ├─ escolhe até 3 candidatas: as mais novas com tag > versão atual; se não
  │   houver nenhuma, até 3 do cache (só para detectar revogação da atual)
  │    ├─ exige o asset com nome exato "distorrent-manifest.bin"
  │    ├─ baixa (<= 128 KiB) de host da allowlist
  │    ├─ SignedManifest::from_wire  (forma canônica obrigatória)
  │    ├─ ReleaseTrust::accept → verify_manifest com as chaves LOCAIS
  │    │     status tem de ser RELEASE_VERIFICADA
  │    ├─ versão do manifesto == tag da release (sem "v")
  │    ├─ asset para (os, arch) desta máquina precisa existir no manifesto
  │    └─ URL do asset na allowlist
  ├─ confere digest e size do GitHub contra o manifesto assinado
  └─ grava release.update_pending, emite "distorrent://update" e devolve UpdateInfo
```

Pontos que importam:

- **A tag do GitHub não é fonte de versão.** Se o manifesto declara versão
  diferente da tag, a release é recusada (`"divergência recusada"`).
- **O asset é escolhido do manifesto**, não da lista de assets do GitHub. A
  lista do GitHub só serve para (a) localizar o manifesto e (b) conferir
  `digest`/`size` do arquivo escolhido.
- **Digest do GitHub divergente do manifesto = recusa.** É sinal de asset
  trocado ou adulteração no caminho; a mensagem diz isso.
- Se o asset citado no manifesto não existe na release, a checagem falha
  (`"o manifesto cita X mas a release não publicou esse arquivo"`).
- **Plataforma e arquitetura vêm do binário em execução**, não da UI:
  `platform_tag()` devolve `windows`/`linux`/`android`/`outro` e `arch_tag()`
  devolve `x86_64`/`aarch64`/`x86`/`outro`. O asset precisa ter `os` igual e
  `arch` igual **ou** `universal`. Uma combinação sem asset no manifesto
  (ex.: Windows x86) simplesmente não recebe update.

### 1.1 Sem chaves de confiança

`escolher` retorna erro imediatamente quando `!trust.verification_available()`:

> "este build não tem chaves de confiança de release" (ou o motivo gravado em
> `ReleaseTrust::unavailable_reason`)

Nenhum update é oferecido. `update_download` e `update_apply` também recusam com
"sem chaves de confiança: … recusado". **Não existe caminho de instalação
automática sem verificação.**

> Observação: no caminho de rede, a chamada ao GitHub acontece **antes** dessa
> checagem (é o `update_check` que busca a lista e depois chama `escolher`). Ou
> seja, sem chaves o app ainda faz uma requisição à API pública de releases —
> desnecessária, mas sem efeito de segurança.

### 1.2 Nada mais novo

Se nenhuma release tem tag maior que a atual, o código ainda examina até 3
releases do **cache local** (as primeiras da lista gravada, que preserva a ordem
bruta da API — não é reordenada) para saber se a versão instalada foi
**revogada**. A UI consegue mostrar "você está na mais nova" com procedência
comprovada, ou "esta versão foi revogada".

### 1.3 Rótulo do arquivo não manda em nada

Se o nome do asset traz uma versão diferente da versão assinada, o campo
`label_mismatch` é marcado e a UI avisa, mas **a versão usada é a do manifesto**.
O nome do arquivo nunca "corrige" a versão nem escolhe outro asset.

---

## 2. Contrato dos comandos Tauri

| Comando | Entrada | O que o chamador **não** consegue controlar |
|---|---|---|
| `update_check()` | — | — |
| `update_download(name)` | **só o nome do asset** | URL, hash, tamanho, versão, manifesto |
| `update_verify_ready(path)` | caminho | valida e devolve o `PendingUpdate`; não executa |
| `update_apply(path)` | caminho | qual arquivo é (tem de ser o registrado), se é o binário certo |
| `update_trust_info()` | — | — |
| `update_trust_apply(wire_hex)` | payload de rotação assinado | chaves do conjunto atual |
| `peer_trust_info()` / `peer_trust_policy_set(policy)` | política | — |
| `update_cleanup()` | — | — |

`update_download` (assinatura real):

```rust
pub async fn update_download(app: tauri::AppHandle, name: String) -> Result<String, String>
```

Confere, em ordem:

1. existe `release.update_pending` no `kv`;
2. `name == pending.asset_name` (senão "asset pedido não corresponde ao
   manifesto verificado");
3. extensão aceita para a plataforma (`.exe` / `.appimage` / `.deb` / `.apk`);
4. `Path::file_name(name) == name` (rejeita `..`, separador de caminho);
5. `trust.verification_available()`;
6. `pending.security_epoch >= trust.epoch_floor()`;
7. o manifesto verificado em cache ainda tem o mesmo `manifest_hash`;
8. o asset existe nesse manifesto e `sha256`/`size` batem com o `pending`;
9. URL na allowlist;
10. `0 < size <= 512 MiB`.

Depois baixa, valida e só então renomeia (§4).

> **Efeito colateral do cache:** `latest_verified()` guarda o manifesto de maior
> `security_epoch` já aceito. Se um peer empurrar (`BuildManifestPush`) um
> manifesto verificado mais novo entre a checagem e o download, o
> `manifest_hash` do `pending` deixa de casar e o download é recusado com
> "o manifesto verificado não está mais em cache — rode a checagem de novo". É
> recusa segura, não corrupção; basta checar de novo.

`update_apply` começa por `verify_before_apply(&app, &path)` — a validação final
acontece **imediatamente antes de executar** (§5). Não existe atalho.

---

## 3. Allowlist de hosts

```rust
const ALLOWED_HOSTS = [
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
```

`url_allowed` exige:

- esquema `https`;
- host exatamente na lista (comparação de string, não `ends_with` — `github.com.evil`
  não passa);
- sem `user:pass` na URL;
- para `github.com`: caminho começa com
  `/ArthurFreire77/dis-torrent/releases/download/`;
- para `api.github.com`: caminho começa com
  `/repos/ArthurFreire77/dis-torrent/releases`;
- para os dois hosts de CDN: qualquer caminho (o GitHub redireciona o asset
  assinado para lá).

O cliente de download (`download_client`) usa `redirect::Policy::custom`: **cada
redirect é revalidado** contra a mesma allowlist, até 5 saltos. O cliente HTTP
padrão seguiria qualquer `Location` — por isso ele não é usado para baixar
artefato.

---

## 4. Download

- arquivo escrito em `<updates_dir>/<nome>.part`;
- SHA-256 calculado durante a escrita;
- `Content-Length` (quando presente) tem de ser igual a `asset.size`;
- o total escrito não pode passar de `asset.size` (estoura → apaga e recusa);
- ao final, `total == asset.size` **e** `sha256 == asset.sha256`; qualquer
  divergência apaga o `.part` e devolve erro;
- só então `rename(.part → final)` — renomeação atômica;
- o registro em `release.update_pending` é regravado com o caminho absoluto e o
  hash conferido.

`updates_dir`:

| Plataforma | Caminho |
|---|---|
| Windows/Linux/macOS | `<app_data_dir>/updates` |
| Android | `<filesDir>/updates` (garantido dentro do `filesDir` do FileProvider) |

Não existe download para fora dessa pasta. `update_cleanup` apaga **todos** os
arquivos da pasta (é limpeza, não histórico).

Limite de tamanho do instalador: `0 < size <= 512 MiB` (`MAX_INSTALLER_BYTES`).
O `.part` é removido no início de cada download, então não há retomada.

---

## 5. Validação imediatamente antes de executar

`verify_before_apply` (chamado por `update_apply` e por `update_verify_ready`):

1. existe `release.update_pending`;
2. `pending.path == path` (a UI não escolhe outro arquivo);
3. `trust.verification_available()`;
4. o manifesto verificado em cache ainda tem o mesmo `manifest_hash`;
5. `symlink_metadata` — **symlink é recusado por si só**;
6. tem de ser arquivo comum;
7. `canonicalize(path)` tem de começar com `canonicalize(updates_dir)` — fecha
   `..`, symlink no meio do caminho e junction;
8. `metadata.len() == pending.size`;
9. SHA-256 do conteúdo == `pending.sha256`.

Falha em qualquer passo = instalação recusada. O arquivo **não** é apagado nesta
etapa (o usuário pode tentar de novo), mas o download que falhou no hash é
apagado na origem.

---

## 6. Aplicação por plataforma

### Windows

- só `.exe`;
- `instalação_por_usuario()` recusa se o executável atual está em
  `\Program Files\`, `\Program Files (x86)\` ou `\Windows\System32\`:

  > "esta instalação está em uma pasta do sistema (Program Files). A atualização
  > automática sem administrador não é possível — baixe o instalador e execute
  > manualmente."

- antes de executar, tenta um snapshot `.stormvault` do estado (`pre_update_snapshot`);
  falha do snapshot é registrada e a atualização **segue**;
- executa o instalador Inno com `/SILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS
  /RESTARTAPPLICATIONS`.

O instalador é por usuário: sem UAC, sem admin. Se a instalação for de máquina,
o caminho automático é recusado em vez de pedir elevação.

### Linux

- `.AppImage`: se a variável `APPIMAGE` aponta para um arquivo existente, copia o
  novo para `.<nome>.novo-<pid>` no mesmo diretório, marca `0755`, faz `rename`
  por cima do AppImage em uso e reabre com `--atualizado`. Devolve o sinal
  `ATUALIZADO_E_REINICIADO` para a UI não tratar como erro;
- `.AppImage` sem `APPIMAGE` (ou falha na substituição): cai para `xdg-open`;
- `.deb`: `xdg-open` — o instalador gráfico do sistema assume, com confirmação
  do usuário. O app **não** roda `dpkg` nem pede root.

### Android

- `update_apply` no Rust **não instala**: depois de `verify_before_apply`
  (caminho, symlink, tamanho, hash, manifesto), devolve o sinal
  `INSTALAR_APK_VALIDADO` para o JS chamar `updater|installApk`;
- `UpdaterPlugin.installApk` calcula o SHA-256 do certificado do **app
  instalado** (`getPackageInfo` com `GET_SIGNING_CERTIFICATES`, fallback
  `GET_SIGNATURES` abaixo da API 28) e o do **APK baixado**
  (`getPackageArchiveInfo`) e **recusa se forem diferentes**, antes de qualquer
  intent. É continuidade de assinatura Android — impede instalar um APK de outra
  chave mesmo que ele tenha passado pelo manifesto;
- exige `canRequestPackageInstalls()`; se faltar, abre
  `ACTION_MANAGE_UNKNOWN_APP_SOURCES` e recusa com instrução;
- entrega o APK por `FileProvider` + `ACTION_VIEW`
  (`application/vnd.android.package-archive`), com fallback para
  `ACTION_INSTALL_PACKAGE`;
- a instalação é sempre **com consentimento do usuário**, nunca silenciosa.

### Outras plataformas

`update_apply` devolve "atualização automática não disponível nesta plataforma".

---

## 7. Cache, janela e backoff

| Chave `kv` | Conteúdo |
|---|---|
| `update.releases_cache` | lista de releases (JSON) da última consulta bem-sucedida |
| `update.releases_etag` | ETag da API para `If-None-Match` |
| `update.last_check_ms` | timestamp da última checagem |
| `update.backoff_ms` | backoff atual em ms |
| `release.manifest.<hash>` | manifesto verificado (wire hex) — cache da camada de confiança |
| `release.epoch_floor` | piso monotônico de epoch |
| `release.update_pending` | registro do download verificado |

Comportamento:

- **Janela de 6 h** (`MIN_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000`): dentro dela,
  `update_check` **não chama a API de releases** e usa a lista em cache. Isso não
  significa "sem rede": `escolher` ainda **baixa o manifesto de até 3
  candidatas** e re-verifica (o cache de manifesto é por hash e `latest_verified`
  é reusado, mas o wire não é lido do cache por versão). A UI também agenda uma
  checagem a cada 6 h (`UpdateGate`).
- **ETag/304**: se o GitHub responde `304 Not Modified`, usa a lista em cache e
  zera o backoff — mesma ressalva do item anterior sobre o manifesto.
- **Backoff exponencial com jitter** em falha de rede ou status não-2xx:
  começa em 60 s, dobra até 1 h, soma até 20 % de jitter
  (`proximo_backoff` / `now_rand`). O valor é persistido, então reiniciar o app
  não zera a espera. `espera = max(6 h, backoff)`.
- **Cache de manifestos**: até 8 entradas; a eviction remove o menor hash. Cada
  entrada é **re-verificada** no carregamento do boot — cache adulterado no
  disco não vira confiança.

> **Não implementado:** "uma checagem concorrente por processo". `update_check`
> não tem mutex, `OnceLock` nem flag de "em andamento" — duas chamadas
> simultâneas (boot + clique na UI, por exemplo) podem fazer duas requisições,
> dois downloads de manifesto e dois registros em `release.update_pending`. A
> janela de 6 h reduz a chance, não elimina.
>
> **Não implementado:** cache do manifesto por versão. O manifesto baixado é
> guardado em `release.manifest.<hash>` para re-verificação, mas `escolher`
> sempre baixa de novo a partir do asset da release.

---

## 8. Regras de recusa (resumo)

| Situação | Resultado |
|---|---|
| release sem asset `distorrent-manifest.bin` | nenhum update oferecido: "a release X não publicou distorrent-manifest.bin — não há como verificar a procedência" |
| manifesto com assinaturas válidas abaixo do limiar | nenhum update: "não tem assinaturas válidas suficientes" |
| manifesto inválido / fora da forma canônica | release ignorada, tenta a próxima (até 3) |
| build sem chaves de confiança | nenhum update; mensagem honesta; download e apply recusados |
| versão do manifesto ≠ tag | recusa |
| versão revogada | recusa: "está REVOGADA pela autoridade — não será instalada" |
| `security_epoch` abaixo do piso local | recusa: "downgrade recusado" |
| `digest` do GitHub ≠ `sha256` do manifesto | recusa na checagem |
| `size` do GitHub ≠ manifesto | recusa na checagem |
| URL fora da allowlist (no manifesto ou no redirect) | recusa |
| hash do download ≠ manifesto | `.part` apagado, erro |
| tamanho do download ≠ manifesto | `.part` apagado, erro |
| arquivo mudou depois do download | `update_apply` recusa pelo hash |
| caminho fora de `<app_data>/updates` | `update_apply` recusa |
| symlink | `update_apply` recusa |
| `.exe` em `Program Files` | `update_apply` recusa e explica |

---

## 9. UI — o que ela pode e não pode fazer

`src/services/updater.ts`:

```ts
download: (info) => s.updateDownload!(info.asset_name)   // só o nome
apply:    async (path) => s.updateApply!(path)
```

`UpdateInfo` carrega `verified`, `manifest_hash`, `security_epoch`,
`valid_signatures`, `trust_epoch`, `commit`, `channel`, `self_integrity`,
`verification_available`, `verification_note`. A UI usa isso para **exibir**
procedência; ela não tem canal para alterar URL, hash, tamanho ou versão.

`runUpdateFlow` (em `src/services/updateRules.ts`) decide o que fazer com o
`UpdateInfo` e chama `download(info)`/`apply(path)`. O ponto de segurança é que
`download` só recebe `info.asset_name`; um `UpdateInfo` forjado no front-end não
muda o que o Rust baixa, porque o Rust relê o registro `release.update_pending`
gravado na checagem e compara nome, hash, tamanho e epoch.

No Android, `apply` trata `INSTALAR_APK_VALIDADO` como **sucesso da validação**
e só então chama `plugin:updater|installApk`. O plugin confere o certificado
antes de abrir o instalador do sistema; a UI não escolhe caminho nem certificado.

`src/services/browser.ts` (modo navegador) rejeita `updateCheck`,
`updateDownload` e `updateApply` com "atualização automática só existe no app
nativo". Não há caminho de update fora do Tauri.

---

## 10. Limites e pendências verificáveis

1. **A raiz de confiança está embutida** (`TRUST_SET_BOOTSTRAP`, epoch 1,
   limiar 2 de 3). Se ela for esvaziada num build, o atualizador não oferece
   nada — fail-closed, nunca "aceita qualquer instalador".
2. **Android: dois controles independentes.** (a) hash SHA-256 do APK contra o
   manifesto assinado (`verify_before_apply`), e (b) **continuidade de
   certificado**: `UpdaterPlugin.kt` compara o SHA-256 do signer do APK baixado
   com o do app instalado e recusa antes do intent se diferirem. O controle (b)
   é o que impede um APK de outra chave, mesmo que ele passasse pelo manifesto.
   Ressalva: a comparação usa `signingInfo.apkContentsSigners`, então um APK com
   múltiplos signers é comparado pelo **primeiro**; não há validação de rotação
   de chave (`SigningInfo` com `hasMultipleSigners`/linhagem).
3. **Não há checagem de concorrência** em `update_check` (§7).
4. **`update_download` não retoma** download interrompido: apaga o `.part`
   (`let _ = std::fs::remove_file(&part_path)` no início e em cada erro) e
   recomeça.
5. **`.deb` não é validado como pacote** — só hash + allowlist. Quem instala é o
   sistema, com a política dele.
6. **Não há assinatura Authenticode** nos instaladores Windows; ver `SECURITY.md`
   e `docs/DEFENDER.md`. O manifesto Ed25519 e o Authenticode são garantias
   diferentes (uma cobre o artefato publicado; a outra, o executável no disco
   para o Windows).
7. **O instalador não é iniciado com privilégio elevado.** Se a instalação
   existente exigir admin, o usuário tem de baixar e rodar manualmente.
