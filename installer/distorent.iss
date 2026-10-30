; === DisTorrent — instalador Windows (Inno Setup 6) ===
;
; POR QUE INNO E NÃO NSIS (não regredir sem repetir o teste):
; o instalador NSIS do Tauri cai no falso positivo `Program:Win32/Contebrew.A!ml`
; do Defender. O detalhe que engana: o scan local do arquivo recém-buildado dá
; "no threats"; quem acende a heurística é o download — com Mark-of-the-Web o
; Defender/SmartScreen reprocessa o pacote e o Edge marca como perigoso. Trocar
; a compressão do NSIS (LZMA -> zlib) NÃO resolveu, e o binário puro do app
; (distorrent.exe) passa limpo até COM MOTW. Conclusão: o gatilho é o stub do NSIS.
; O Inno usa outro motor de setup e passou no teste completo (baixado pela URL
; pública + MOTW + MpCmdRun: "found no threats").
;
; Build (Windows):
;   pwsh -File scripts/build-installer.ps1
; ou direto:
;   ISCC.exe /DAppVersion=1.1.7-pre-alpha /DNumericVersion=1.1.7.0 ^
;            /DSourceExe=src-tauri\target\release\distorrent.exe installer\distorent.iss

#ifndef AppVersion
  #define AppVersion "1.1.7-pre-alpha"
#endif
#ifndef NumericVersion
  #define NumericVersion "1.1.7.0"
#endif
#ifndef SourceExe
  #define SourceExe "..\src-tauri\target\release\distorrent.exe"
#endif
#ifndef OutputDir
  #define OutputDir "..\src-tauri\target\release\bundle\inno"
#endif

#define AppName "DisTorrent"
#define AppExeName "distorrent.exe"
#define AppRepo "https://github.com/ArthurFreire77/dis-torrent"

[Setup]
; GUID fixo e estável: é o que faz o Windows tratar todas as versões como o
; MESMO aplicativo (atualiza por cima e mantém uma entrada só em Aplicativos).
AppId={{7C2F1B64-9A3D-4E58-9C1B-6E0D4A2F8B77}
AppName={#AppName}
AppVerName={#AppName} {#AppVersion}
AppVersion={#AppVersion}
AppPublisher=DisTorrent
AppPublisherURL={#AppRepo}
AppSupportURL={#AppRepo}/issues
AppUpdatesURL={#AppRepo}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Instalação por usuário por padrão (sem UAC). /ALLUSERS na linha de comando
; instala para todos; sem esse override o instalador pediria admin a toa.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
OutputDir={#OutputDir}
OutputBaseFilename=DisTorrent_{#AppVersion}_x64_setup
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
; `lzma2/fast`, NÃO `max`. Medido em 29/10/2026 com o MESMO payload e o mesmo
; Inno, só mudando esta diretiva:
;   lzma2/max  -> Defender acusa `Program:Win32/Contebrew.A!ml`
;   lzma2/fast -> limpo
;   none       -> limpo
; O gatilho é o bloco de altíssima entropia + a rotina de descompressão embutida
; (padrão de packer), não o código do app: `distorrent.exe` sozinho passa limpo.
; Custa ~1 MB no instalador final e evita o navegador bloquear o download.
; Não voltar para `max` sem repetir o teste de MOTW (scripts/build-installer.ps1 -Scan).
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Fecha o app aberto antes de sobrescrever o exe (senão o install falha com
; "arquivo em uso" e o usuário acha que o instalador está quebrado).
CloseApplications=yes
; REABRE o app depois de instalar.
;
; BUG QUE ISTO CORRIGE (janela abrindo e fechando em loop): `RestartApplications`
; só reinicia quem se registrou na API `RegisterApplicationRestart` do Windows —
; e o Tauri NÃO faz isso. Na atualização automática sobravam DUAS cópias
; disputando o mutex de instância única, e uma delas morria: a janela piscava.
; Agora quem reabre é só o `[Code]` (modo silencioso) ou o `[Run]` (modo
; manual), e o app não tem timer de saída. Não voltar para `yes` sem medir.
RestartApplications=no
; Versão exibida em Aplicativos e no título do wizard é a textual
; ("1.1.7-pre-alpha"); o VersionInfo do .exe é numérico porque o Windows não
; aceita sufixo em recurso de versão.
VersionInfoVersion={#NumericVersion}
VersionInfoCompany=DisTorrent
VersionInfoDescription={#AppName} {#AppVersion} — instalador
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#NumericVersion}
VersionInfoOriginalFileName=DisTorrent_{#AppVersion}_x64_setup.exe

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; O Tauri 2 embute frontend e recursos dentro do próprio .exe, então o pacote
; é só o binário. Se algum dia entrar recurso externo (bundle.resources), ele
; precisa ser listado aqui também — o instalador não adivinha.
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "{#AppExeName}"; Flags: ignoreversion

[Icons]
; `AppUserModelID` é o que faz o toast do Windows funcionar no app INSTALADO.
; O plugin oficial de notificações usa `com.distorrent.app` como AppUserModelID
; (o mesmo `identifier` do tauri.conf.json); sem o ID no atalho, o Windows não
; associa a notificação ao app e o aviso simplesmente não aparece. Não é
; truque: é o mecanismo documentado da Microsoft (atalho = identidade do app).
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; AppUserModelID: "com.distorrent.app"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon; AppUserModelID: "com.distorrent.app"

[Run]
; Abre o app UMA vez, no fim do fluxo MANUAL. Com `skipifsilent` a atualização
; automática (`/SILENT`) não abre nada por aqui — quem a reabre é o `[Code]`,
; depois de esperar o processo antigo morrer de verdade.
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
const
  // GUID do runtime WebView2 (mesmo usado pelo Edge Update). Se a chave existe,
  // o runtime está instalado — sem ele o app abre uma janela em branco.
  WebView2ClientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2ClientKeyWow = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2ClientKeyUser = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  // Nome do mutex criado pelo `tauri-plugin-single-instance`:
  // `<identifier>-sim` = `com.distorrent.app-sim` (a feature `semver` está
  // DESLIGADA em src-tauri/Cargo.toml; se um dia for ligada, o nome ganha a
  // versão e este literal precisa acompanhar).
  AppInstanceMutex = 'com.distorrent.app-sim';

function WebView2Instalado(): Boolean;
begin
  Result :=
    RegKeyExists(HKEY_LOCAL_MACHINE, WebView2ClientKey) or
    RegKeyExists(HKEY_LOCAL_MACHINE, WebView2ClientKeyWow) or
    RegKeyExists(HKEY_CURRENT_USER, WebView2ClientKeyUser);
end;

// Reinício na ATUALIZAÇÃO AUTOMÁTICA (o app se auto-instala em /SILENT).
//
// O problema relatado: a atualização "dá certo", o app fecha, reabre e começa
// tudo de novo. A origem era a CORRIDA entre coisas tentando abrir o app:
//   1. `RestartApplications` (Restart Manager) — o Tauri não chama
//      `RegisterApplicationRestart`, então quase nunca reiniciava de verdade;
//   2. o `[Run]` do fluxo manual;
//   3. um timer de saída no frontend (`updateRules`), que podia derrubar a
//      cópia recém-aberta.
// Aqui a atualização silenciosa tem UM dono do reinício, e ele espera o
// processo antigo morrer antes de abrir o novo (abrir cedo demais é o que fazia
// a cópia nova cair no single-instance e sumir calada).
procedure ReiniciarAppSilencioso();
var
  ErrorCode: Integer;
  tentativa: Integer;
begin
  for tentativa := 1 to 40 do
  begin
    if not CheckForMutexes(AppInstanceMutex) then
      Break;
    Sleep(250);
  end;
  // Ainda vivo depois de 10 s: NÃO abre uma segunda cópia. Ela morreria na hora
  // (single-instance) e o usuário veria a janela piscar.
  if CheckForMutexes(AppInstanceMutex) then
    Exit;
  ShellExec('open', ExpandConstant('{app}\{#AppExeName}'), '', ExpandConstant('{app}'),
            SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ErrorCode: Integer;
begin
  if CurStep <> ssPostInstall then
    Exit;

  // Erro honesto > estado falso: não fingimos instalar o WebView2. Avisamos e
  // abrimos a página oficial (o Windows 11 e o Windows 10 atualizado já têm).
  if not WebView2Instalado() then
  begin
    if MsgBox('O DisTorrent usa o Microsoft Edge WebView2 para desenhar a interface e ele não foi encontrado neste computador.' + #13#10 + #13#10 +
              'Sem o WebView2 o app abre com a tela em branco. Quer abrir a página oficial de download agora?',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://go.microsoft.com/fwlink/p/?LinkId=2124703', '', '',
                SW_SHOWNORMAL, ewNoWait, ErrorCode);
  end;

  // Só na atualização automática: no fluxo manual o `[Run]` já abre o app, e o
  // usuário acabou de ver o wizard — abrir aqui geraria duas janelas.
  if WizardSilent() then
    ReiniciarAppSilencioso();
end;
