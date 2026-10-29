# Defender, falso positivo e integridade dos binários

Este documento registra **o que foi medido** sobre a detecção do Microsoft
Defender nos instaladores do DisTorrent, o que o app faz (auditoria de
comportamento), o que **não** foi possível verificar e como conferir a
integridade do arquivo que você baixou.

> Nada aqui é uma promessa de que o Defender nunca vai acusar. É o registro
> honesto das evidências que temos e das que faltam.

---

## 1. Detecção observada

| Campo | Valor |
|---|---|
| Nome da detecção | `Program:Win32/Contebrew.A!ml` |
| Motor | Microsoft Defender Antivirus |
| Versão de definições no teste | `1.463.24.0` |
| Sufixo `!ml` | indica classificação por **machine learning**, não assinatura de família de malware conhecida |
| Arquivos acusados | instalador **NSIS** do Tauri (`<App>_<versão>_x64-setup.exe`) e instalador **Inno Setup** compilado com `Compression=lzma2/max` |
| Situação | o `distorrent.exe` **puro** passa limpo, inclusive com Mark-of-the-Web (medido na rodada do 1.1.7, registrado no `AGENTS.md` §9) |

A classificação `!ml` é heurística: o Defender atribui um score ao arquivo. Não
há família de malware identificada, não há indicador de comando e controle,
não há hash em lista de bloqueio nomeada.

### 1.1 Hashes e resultados dos scans (medidos nesta máquina)

Todos os arquivos abaixo foram escaneados **com Mark-of-the-Web** (atributo
`Zone.Identifier`, `ZoneId=3`, simulando download do navegador) via
`MpCmdRun.exe -Scan -ScanType 3 -File <arquivo> -DisableRemediation`.

| Arquivo | SHA256 | Resultado |
|---|---|---|
| `DisTorrent_1.1.8-pre-alpha_x64_setup.exe` (Inno Setup, `lzma2/fast`) | `B0389D76BCD34429D8F2E9612728A59DB6FE863FC72845191295EEBFEA572774` | **found no threats** (exit 0) |
| `DisTorrent_1.1.7-pre-alpha_x64-setup.exe` (NSIS) | `ADE95BF68C847B475A362209766FEEBB9BF362606DFBF3C0ADF8DCD4394CC0C3` | **found no threats** (exit 0) |
| `DisTorrent_1.1.7-pre-alpha_x64_setup.exe` (Inno Setup) | `7388723C554B9B794923F76648DBCCDED1CD195C89A88DC58EEDDE0992C394C1` | **found no threats** (exit 0) |

Observação importante sobre a linha do NSIS 1.1.7: **aquele build específico
passou**. O falso positivo não é determinístico — ele depende do payload, do
stub e das definições do dia. Foi justamente por isso que o NSIS foi
abandonado (ver §3).

### 1.2 Assinatura de código

```
Get-AuthenticodeSignature <instalador>
  Status            : NotSigned
  SignerCertificate : (vazio)
```

O instalador atual **não é assinado** e não há certificado de code signing na
store do usuário desta máquina. Sem assinatura, o SmartScreen só pode usar
reputação acumulada — e reputação de um projeto novo é zero.

---

## 2. Conclusão

**Provável falso positivo de heurística; nenhum comportamento malicioso foi
encontrado na auditoria do código-fonte e do que o app faz em runtime.**

O que sustenta essa conclusão:

1. O gatilho acompanha a **embalagem**, não o conteúdo: o mesmo `distorrent.exe`
   passa limpo sozinho; o que acende é o stub do instalador (primeiro o NSIS,
   depois a compressão máxima do Inno).
2. Trocando **somente** a diretiva de compressão do Inno, mantendo o mesmo
   payload e a mesma versão do compilador, o veredito muda (§3). Um malware
   não desaparece por causa de `Compression=lzma2/fast`.
3. A auditoria do código (§4) não encontrou download+execução, shell, ofuscação
   nem persistência fora do mecanismo documentado do Windows.
4. O binário puro, extraído do instalador, passa limpo **com** MOTW.

O que **não** se pode afirmar: que o Defender não vai acusar o próximo build.
Heurística é probabilística e o veredito muda com as definições.

---

## 3. A medição que isolou a compressão do Inno

Mesmo payload, mesmo Inno Setup, mesma máquina — só a diretiva `Compression`
mudou:

| Compressão | Tamanho aprox. | Defender (com MOTW) |
|---|---|---|
| `lzma2/max` | ~7,9 MB | **ACUSADO** (`Program:Win32/Contebrew.A!ml`) |
| `lzma2/fast` | ~8,9 MB | limpo |
| `none` | maior | limpo |

`lzma2/max` produz um bloco de altíssima entropia seguido de uma rotina de
descompressão embutida — exatamente o padrão estrutural de um packer. A
hipótese mais provável é que a heurística reaja a essa combinação.

**Decisão fixada:** `installer/distorent.iss` usa `Compression=lzma2/fast`.
Custa cerca de 1 MB no arquivo final e evita o navegador bloquear o download.
Não voltar para `max` sem repetir o teste de MOTW:

```powershell
.\scripts\build-installer.ps1 -Scan
```

O `-Scan` copia o instalador para um nome diferente, aplica `Zone.Identifier`
e roda `MpCmdRun.exe -ScanType 3`. Exit 0 = limpo; exit 2 = ameaça; qualquer
outro código = inconclusivo (não publique).

### 3.1 Histórico do NSIS

O instalador NSIS do Tauri (`--bundles nsis`) caiu nesse falso positivo de
forma consistente quando baixado pelo navegador. Trocar a compressão do NSIS
(`lzma` → `zlib`) **não** resolveu — o gatilho era o stub do NSIS. O projeto
migrou para Inno Setup, que usa outro motor de setup, tem atalhos no Menu
Iniciar/Área de Trabalho, entrada em Aplicativos e desinstalador.

Não voltar para NSIS (nem para executável portátil) sem repetir o teste do §3
no arquivo **publicado**, não só no recém-compilado.

---

## 4. Auditoria: o que o app faz (e o que não faz)

Auditoria feita por leitura do código em `src-tauri/src/` e
`distorrent-core/src/`, mais conferência do `Cargo.toml`/`Cargo.lock`.

### 4.1 Plugins — todos oficiais, nenhum de terceiros

| Plugin | Uso | Onde |
|---|---|---|
| `tauri-plugin-notification` | toast nativo do Windows (WinRT) | `background.rs` |
| `tauri-plugin-autostart` | chave `Run` do **usuário** | `background.rs` |
| `tauri-plugin-single-instance` | uma instância só; a 2ª entrega argv à 1ª | `lib.rs` |
| `tauri-plugin-deep-link` | links `distorrent://` | `lib.rs` |
| `downloads` (interno) | salvar em Downloads no Android (MediaStore) | `lib.rs` |

Não há `tauri-plugin-shell`, `tauri-plugin-opener`, `tauri-plugin-updater`,
`tauri-plugin-fs` nem plugin de execução de processo no `Cargo.toml`.

### 4.2 Persistência / inicialização automática

`autostart_set` chama `tauri_plugin_autostart`, que usa o crate `auto-launch`
e grava um valor na chave `Run` do Windows:

```
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run    (usuário atual)
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run    (todos os usuários)
```

- É o mecanismo documentado do Windows para iniciar com o login.
- **Não** usa `reg.exe`, PowerShell, `schtasks` ou script algum.
- **Não** instala serviço, driver ou tarefa agendada.
- É **opt-in**: o usuário liga em Configurações ou pelo menu da bandeja; o
  estado é lido de volta por `is_enabled` e a UI mostra ON/OFF honesto.
- O plugin usa o modo `WindowsEnableMode::Dynamic` (default do `auto-launch`
  0.6): tenta `HKLM` primeiro e cai para `HKCU` quando recebe
  `E_ACCESSDENIED`. Como o instalador padrão instala por usuário
  (`PrivilegesRequired=lowest`) e o app não pede elevação, na prática o valor
  fica em **HKCU** — sem UAC, sem alterar outros usuários.

### 4.3 Notificações

`notification_show` usa `tauri-plugin-notification`, que no Windows emite um
toast **WinRT** com o AppUserModelID do próprio app (`com.distorrent.app`). O
AUMID é registrado pelo atalho criado pelo instalador — é o mecanismo
documentado da Microsoft (o atalho é a identidade do app para toasts).

Não há janela sem moldura imitando aviso do Windows, nem PowerShell/toast
script.

### 4.4 Sem shell, sem `reg.exe`, sem PowerShell

Busca no código por `std::process::Command`, `Command::new`,
`ShellExecute`, `WinExec`, `Start-Process`: **nenhuma ocorrência** em
`src-tauri/src/` nem em `distorrent-core/src/` (a única ocorrência de
`std::process` é `exit(1)` quando a thread de voz não sobe — não executa
nada).

### 4.5 Sem download + execução de binários

O app baixa **dados**, nunca código:

- mensagens, perfis, reações (SQLite local);
- arquivos enviados por P2P para a pasta Downloads do usuário;
- respostas HTTP para o runtime de bots (`http_fetch`, restrito a
  `http`/`https`, timeout 15 s, resposta limitada a 256 KB).

Nenhum caminho grava arquivo e depois o executa. Na verdade:

- `save_file`/`save_file_stream` **bloqueiam** por extensão (`exe`, `dll`,
  `msi`, `bat`, `ps1`, `vbs`, `js`, `hta`, `jar`, `apk`, `html`, `svg`...) e por
  magic bytes (executável disfarçado de imagem/PDF), com opção de desligar só
  por decisão explícita do usuário;
- o nome do arquivo é sanitizado contra path traversal (`../../`).

### 4.6 Rede P2P — legítima e explicável

| Item | Valor |
|---|---|
| Listener TCP | porta **51413** (estilo torrent), fallback +1..+9, depois efêmera; `DISTORRENT_PORT` sobrescreve |
| Descoberta LAN | UDP **45900**, broadcast/multicast local |
| NAT traversal | UPnP / NAT-PMP / STUN / hole punching / relay |
| Transporte | ed25519 + X25519 efêmero + HKDF-SHA256 + ChaCha20Poly1305 |

Portas fixas e um listener de entrada são o que qualquer cliente P2P faz
(Syncthing, Transmission, qBittorrent). Não há conexão com domínio de comando
e controle embutido.

### 4.7 Integridade do próprio app

- CSP restritiva no `tauri.conf.json` (`default-src 'self'`, sem
  `unsafe-eval`).
- O webview carrega **apenas** o frontend próprio (protocolo custom), nunca
  web arbitrária.
- Permissões do webview agora são **allowlist** (`lib.rs`,
  `.on_permission_request`): microfone, câmera, captura de tela, autoplay e
  `Other`; todo o resto é negado.
- Chave privada nunca é logada nem serializada para a UI (ver `SECURITY.md`).

---

## 5. O que NÃO foi possível reproduzir/verificar aqui

Sejamos explícitos — estas lacunas são reais:

1. **Scan do arquivo publicado pela URL pública (nesta rodada).** Os scans de
   `1.1.8` e do Inno `1.1.7` foram feitos no arquivo **local** com
   `Zone.Identifier` aplicado manualmente. O que já foi feito de verdade, em
   rodada anterior, está no `CHANGELOG.md`: o Inno `1.1.7` foi **baixado pela
   URL da release**, deu 7.578.486 bytes, `sha256 7388723c…`, recebeu MOTW e
   passou em `MpCmdRun` com "found no threats". O `1.1.8` ainda não foi
   publicado, então não há URL para baixar.
2. **Reputação cloud / SmartScreen.** Não há como inspecionar o score de
   reputação do Microsoft Defender SmartScreen de fora. Um arquivo limpo no
   scan local ainda pode mostrar "aplicativo não reconhecido" no primeiro
   download — isso é ausência de reputação, não detecção.
3. **Todas as versões de definições.** O teste usou `1.463.24.0`. Definições
   novas podem mudar o veredito para melhor ou para pior.
4. **Outros antivírus.** Só o Microsoft Defender foi testado. Kaspersky,
   Bitdefender, ESET etc. têm heurísticas próprias e não foram avaliados.
5. **Assinatura de código.** Não há certificado configurado; o instalador é
   `NotSigned`. Assinar é a correção estrutural para SmartScreen e ainda não
   foi feita.
6. **Teste em máquina limpa.** Os scans rodaram na máquina de
   desenvolvimento, não em uma VM recém-instalada com o Windows atualizado.

---

## 6. Procedimento de submissão de falso positivo à Microsoft

Se o Defender (ou o SmartScreen) acusar um build publicado:

1. **Confirme antes de reportar.** Rode o teste de MOTW no arquivo baixado:

   ```powershell
   $f = ".\DisTorrent_<versao>_x64_setup.exe"
   Set-Content -Path $f -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3" -Encoding ascii
   $mp = Get-ChildItem "C:\ProgramData\Microsoft\Windows Defender\Platform\*\MpCmdRun.exe" |
         Sort-Object FullName | Select-Object -Last 1
   & $mp.FullName -Scan -ScanType 3 -File (Resolve-Path $f).Path -DisableRemediation
   ```

   - `found no threats` + exit 0 → pode ser só SmartScreen/reputação; siga para
     o passo 3.
   - ameaça + exit 2 → siga para o passo 2.

2. **Submeta o falso positivo (WDSI).**
   - Página: <https://www.microsoft.com/en-us/wdsi/filesubmission>
   - Escolha **"Submit a file"** → **"Software developer"** (é o fluxo para
     editor que acredita ter sido classificado incorretamente).
   - Anexe **o instalador exato** (mesmo SHA256 do asset publicado) e informe:
     - nome da detecção: `Program:Win32/Contebrew.A!ml`;
     - produto/versão e URL pública do release;
     - hash SHA256 completo;
     - justificativa: instalador legítimo, open source, repositório público,
       sem download+execução, sem shell.
   - Guarde o número do caso.

3. **SmartScreen / "app não reconhecido".** É reputação, não detecção. O
   caminho definitivo é **assinar o instalador** com certificado de code
   signing (ver §7) e acumular downloads. Não existe "formulário" que dê
   reputação imediata a um binário não assinado.

4. **Acompanhe.** Reenvie o arquivo no WDSI se a definição continuar acusando
   após alguns dias. Não publique um build novo tentando "fugir" da heurística
   sem entender a causa — foi assim que o NSIS foi abandonado.

---

## 7. Integridade: como conferir o que você baixou

Todo asset de release **deveria** ter o SHA256 publicado. Hoje ele é:

- impresso pelo `scripts/build-installer.ps1` ao final do build;
- registrado no `CHANGELOG.md` quando a rodada de release o anota;
- disponível no campo `digest` da API do GitHub, **quando o GitHub o
  preenche** (`GET /repos/<owner>/<repo>/releases` → `assets[].digest`,
  formato `sha256:<hex>`). Em repositórios/assets antigos esse campo pode vir
  vazio.

> **Pendência honesta:** o workflow de release **não** inclui os hashes no
> corpo da release. Até isso ser adicionado, a conferência depende do
> `CHANGELOG.md`, do `digest` da API ou do hash divulgado junto ao anúncio.
> Nenhuma dessas fontes é independente do GitHub — para uma garantia mais
> forte é preciso assinatura de código (§7.1).

```powershell
# 1) Hash do arquivo baixado
Get-FileHash .\DisTorrent_<versao>_x64_setup.exe -Algorithm SHA256 |
  Select-Object -ExpandProperty Hash

# 2) Compare com o hash publicado do asset (ignore maiúsculas/minúsculas).
#    Se diferir, NÃO execute: o download foi corrompido ou adulterado.

# 2b) Alternativa: leia o digest que o GitHub calculou no upload
gh api repos/ArthurFreire77/dis-torrent/releases --jq '.[0].assets[] | {name, digest}'

# 3) Assinatura (quando houver certificado)
Get-AuthenticodeSignature .\DisTorrent_<versao>_x64_setup.exe |
  Format-List Status, StatusMessage, SignerCertificate

# 4) Pelo script do repositório (faz hash + assinatura + MOTW opcional)
.\scripts\sign-windows.ps1 -File .\DisTorrent_<versao>_x64_setup.exe -Verify
```

`Status : NotSigned` é o estado **esperado** enquanto o projeto não tiver
certificado de code signing. Isso não significa que o arquivo está adulterado —
significa que a autenticidade depende do hash publicado e da origem (GitHub
Releases do repositório oficial).

### 7.1 Assinatura local (mantenedor)

Variáveis de ambiente — **nunca** senha no repositório, no histórico do
PowerShell ou em log de CI:

```powershell
# Opção A: PFX
$env:DISTORRENT_SIGN_PFX      = "D:\cert\distorrent.pfx"
$env:DISTORRENT_SIGN_PASSWORD = "<senha>"     # só nesta sessão
.\scripts\build-installer.ps1 -SkipBuild -Scan

# Opção B: certificado já instalado na store do usuário
$env:DISTORRENT_SIGN_THUMBPRINT = "<sha1 do cert>"
.\scripts\build-installer.ps1 -SkipBuild
```

Sem certificado configurado o script imprime
`sem certificado configurado — pulando assinatura` e o build continua. O
resumo final diz, por artefato, se ele saiu assinado ou não — nunca "assumir
que assinou".

O `sign-windows.ps1` **importa o PFX na store do usuário** em vez de passar a
senha por `/p`: argumentos de linha de comando são visíveis a outros processos
(`Get-CimInstance Win32_Process`). O certificado temporário é removido no
`finally`, inclusive quando a assinatura falha — **exceto** se ele já existia
na store antes (nesse caso é do usuário e não é tocado).

Detalhe de implementação que já causou bug: o `build-installer.ps1` chama o
`sign-windows.ps1` com `&` no **mesmo processo**, duas vezes (app e
instalador). Por isso o script de assinatura **não** apaga
`DISTORRENT_SIGN_PASSWORD` do ambiente no `finally` — apagar fazia a segunda
chamada falhar com "senha vazia". Ele só zera as cópias locais.

### 7.2 Assinatura no CI

O job `build-windows` do `.github/workflows/release.yml` só tenta assinar se o
secret `WINDOWS_CERT_PFX_BASE64` existir:

| Secret | Conteúdo |
|---|---|
| `WINDOWS_CERT_PFX_BASE64` | PFX codificado em base64 (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`) |
| `WINDOWS_CERT_PASSWORD` | senha do PFX |

Sem esses secrets o job roda como antes e produz um instalador não assinado.
Com eles: o PFX é decodificado em `$RUNNER_TEMP` (fora do workspace), o
caminho vai por `GITHUB_ENV` e a senha só como `env` do step que assina —
nunca em arquivo. O passo "Limpar certificado temporário" roda com
`if: always()` e apaga o PFX mesmo se o build falhar.

---

## 8. Checklist antes de publicar um build Windows

- [ ] `.\scripts\build-installer.ps1 -Scan` terminou com
      `Defender: found no threats (com MOTW)`.
- [ ] O SHA256 do instalador gerado foi copiado para a release/CHANGELOG.
- [ ] O resumo do build mostra o estado de assinatura **real** do instalador
      (`assinado` / `não assinado`).
- [ ] Se assinado: `.\scripts\sign-windows.ps1 -File <setup> -Verify` retorna
      `Status : Valid`.
- [ ] Se o Defender acusar: **não publique**; siga o §6.
