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
; REABRE o app depois de instalar. É o que faz a ATUALIZAÇÃO AUTOMÁTICA
; ("atualizar antes de entrar") terminar sozinha: quando o próprio app executa
; este setup com /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS, o Inno fecha o
; processo antigo, instala a versão nova e abre de novo — sem o usuário ter de
; procurar o atalho. Numa instalação manual o efeito é o mesmo (desejável).
RestartApplications=yes
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
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
const
  // GUID do runtime WebView2 (mesmo usado pelo Edge Update). Se a chave existe,
  // o runtime está instalado — sem ele o app abre uma janela em branco.
  WebView2ClientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2ClientKeyWow = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2ClientKeyUser = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Instalado(): Boolean;
begin
  Result :=
    RegKeyExists(HKEY_LOCAL_MACHINE, WebView2ClientKey) or
    RegKeyExists(HKEY_LOCAL_MACHINE, WebView2ClientKeyWow) or
    RegKeyExists(HKEY_CURRENT_USER, WebView2ClientKeyUser);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ErrorCode: Integer;
begin
  // Erro honesto > estado falso: não fingimos instalar o WebView2. Avisamos e
  // abrimos a página oficial (o Windows 11 e o Windows 10 atualizado já têm).
  if (CurStep = ssPostInstall) and (not WebView2Instalado()) then
  begin
    if MsgBox('O DisTorrent usa o Microsoft Edge WebView2 para desenhar a interface e ele não foi encontrado neste computador.' + #13#10 + #13#10 +
              'Sem o WebView2 o app abre com a tela em branco. Quer abrir a página oficial de download agora?',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://go.microsoft.com/fwlink/p/?LinkId=2124703', '', '',
                SW_SHOWNORMAL, ewNoWait, ErrorCode);
  end;
end;
