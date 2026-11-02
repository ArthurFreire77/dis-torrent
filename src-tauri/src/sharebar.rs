//! Esconde a UI de aviso de captura do WebView2/Chromium.
//!
//! Ela não é do app: o Chromium cria janelas próprias quando `getDisplayMedia`
//! é aceito, e não há API para desligá-las (WebView2Feedback#2442 segue aberto).
//! O DisTorrent mostra o estado na própria UI, então essas janelas só
//! atrapalham — a barra é TOPMOST, cobre a barra de tarefas, aparece como uma
//! segunda entrada na barra de tarefas e exibe o host interno em vez do nome do
//! app.
//!
//! IDENTIFICAÇÃO: o critério antigo era o NOME DA CLASSE
//! (`ScreenCaptureNotificationUIViews`). Essa string é o nome do *widget* no
//! fonte do Chromium, não a classe Win32 — a janela real é `Chrome_WidgetWin_*`.
//! Por isso a barra nunca era escondida em versão nenhuma. O que a distingue de
//! verdade é a forma: faixa fina e larga (medida 472x70), TOPMOST e sem
//! legenda. E ela nasce no processo `msedgewebview2.exe`, não no PID do app.
//!
//! DEPENDÊNCIAS: só `user32`/`kernel32` e nada além do `windows-sys` que o app
//! já usava (`Foundation`, `WindowsAndMessaging`, `Threading`). A árvore de
//! processos é descoberta por `OpenProcess` + `QueryFullProcessImageNameW` (já em
//! `Threading`), sem `ToolHelp`, sem crate novo e sem alterar o `Cargo.lock`.

/// Esconde as janelas de aviso de captura, se existirem.
///
/// `true` quando achou e escondeu pelo menos uma (diagnóstico); fora do
/// Windows, sempre `false`.
pub fn hide_share_bar() -> bool {
    #[cfg(target_os = "windows")]
    {
        imp::hide()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Mantém a barra escondida enquanto o compartilhamento durar.
///
/// O Chromium recria a janela ao trocar a fonte e não avisa; esconder só no
/// momento da captura deixava a barra reaparecer (e piscar na barra de
/// tarefas). Uma thread vigia em segundo plano e não depende do front estar
/// rodando JS. Idempotente: chamar de novo durante um share não abre threads.
pub fn watch_share_bar() {
    #[cfg(target_os = "windows")]
    {
        imp::watch();
    }
}

/// Para de vigiar (fim do compartilhamento).
pub fn unwatch_share_bar() {
    #[cfg(target_os = "windows")]
    {
        imp::unwatch();
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId,
        IsWindowVisible, ShowWindow, GWL_EXSTYLE, GWL_STYLE, SW_HIDE, SW_SHOWNOACTIVATE,
        WS_CAPTION, WS_CHILD, WS_EX_TOPMOST,
    };

    /// Classe das janelas do Chromium (a barra é uma delas).
    const CLASS_PREFIX: &str = "Chrome_WidgetWin_";

    /// Sufixo do executável: o único outro processo que pode criar a barra.
    const EXE_CHROMIUM: &str = "msedgewebview2.exe";

    /// A barra é uma faixa fina e larga (medida no Chromium 156: 472x70, ou
    /// seja ~6,7:1). O critério é a PROPORÇÃO, não o pixel: em monitor a 150%
    /// a mesma barra mede ~708x105 e um limite fixo de altura a rejeitaria.
    const BAR_MAX_HEIGHT: i32 = 200;
    const BAR_MIN_WIDTH: i32 = 200;
    /// Largura mínima em múltiplos da altura (a barra real é ~6,7x mais larga).
    const BAR_MIN_ASPECT: i32 = 3;

    /// Quantas janelas vieram de um processo do Chromium; se a rodada não
    /// escondeu nenhuma, as mudanças são desfeitas (ver `hide`).
    struct Busca {
        escondeu: usize,
        tocadas: Vec<HWND>,
    }

    /// `true` se escondeu ao menos uma janela.
    ///
    /// TUDO-OU-NADA: se nenhuma janela for a barra, o estado é desfeito. Sem
    /// isso, uma janela de conteúdo que casasse por engano ficaria escondida
    /// para sempre (o app nunca a mostraria de novo).
    pub fn hide() -> bool {
        let mut busca = Busca {
            escondeu: 0,
            tocadas: Vec::new(),
        };
        unsafe { EnumWindows(Some(each_topo), &mut busca as *mut Busca as LPARAM) };
        if busca.escondeu == 0 {
            for hwnd in busca.tocadas {
                unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
            }
        }
        busca.escondeu > 0
    }

    /// Enquanto `ATIVO` estiver marcado, uma thread esconde a barra 4x por
    /// segundo. A lista de PIDs é recalculada a cada rodada: o processo do
    /// WebView2 pode nascer depois da captura (e reaparecer após um crash).
    static ATIVO: AtomicBool = AtomicBool::new(false);
    /// Cada `watch` incrementa; a thread de uma geração antiga morre sozinha.
    /// Sem isto, um stop/start rápido deixava DUAS threads escondendo janelas.
    static GERACAO: AtomicU64 = AtomicU64::new(0);

    pub fn watch() {
        if ATIVO.swap(true, Ordering::SeqCst) {
            return;
        }
        let minha = GERACAO.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::Builder::new()
            .name("sharebar-watch".into())
            .spawn(move || {
                while ATIVO.load(Ordering::SeqCst) && GERACAO.load(Ordering::SeqCst) == minha {
                    hide();
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            })
            .ok();
    }

    pub fn unwatch() {
        ATIVO.store(false, Ordering::SeqCst);
    }

    /// Nome do executável de `pid`, ou vazio.
    ///
    /// `PROCESS_QUERY_LIMITED_INFORMATION` funciona em processo de outro dono
    /// (o WebView2 roda sob o mesmo usuário, mas é outro processo).
    fn exe_de(pid: u32) -> String {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            // `OpenProcess` devolve nulo quando o processo morreu no meio.
            if h.is_null() {
                return String::new();
            }
            let mut buf = [0u16; 260];
            let mut tam = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut tam);
            CloseHandle(h);
            if ok == 0 {
                return String::new();
            }
            String::from_utf16_lossy(&buf[..tam as usize]).to_ascii_lowercase()
        }
    }

    /// A janela pertence ao app ou a um Chromium que ele subiu?
    ///
    /// O PID do app cobre o dono; o nome do executável cobre o WebView2 (que é
    /// filho direto) sem varrer a tabela de processos inteira 4x por segundo.
    fn e_nosso(pid: u32) -> bool {
        if pid == unsafe { GetCurrentProcessId() } {
            return true;
        }
        exe_de(pid).ends_with(EXE_CHROMIUM)
    }

    /// A janela é a barra de compartilhamento?
    ///
    /// Pura (sem Win32) para ser testável. O que identifica a barra é a forma e
    /// o estilo, não o nome: `Chrome_WidgetWin_*`, fina e larga, TOPMOST (é o
    /// que a faz cobrir a barra de tarefas) e sem legenda. Janela de conteúdo do
    /// WebView2 é filha (`WS_CHILD`) e a janela principal do app tem legenda.
    fn e_barra(classe: &str, largura: i32, altura: i32, ex_style: u32, style: u32) -> bool {
        classe.starts_with(CLASS_PREFIX)
            // Janela de topo: a barra flutua sobre o desktop.
            && style & WS_CHILD == 0
            && altura > 0
            && altura <= BAR_MAX_HEIGHT
            && largura >= BAR_MIN_WIDTH
            && largura >= altura * BAR_MIN_ASPECT
            && ex_style & WS_EX_TOPMOST != 0
            && style & WS_CAPTION == 0
    }

    /// É a barra? Se sim, esconde.
    unsafe fn tentar(hwnd: HWND, busca: &mut Busca) {
        if IsWindowVisible(hwnd) == 0 {
            return;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if !e_nosso(pid) {
            return;
        }
        let mut cls = [0u16; 256];
        let n = GetClassNameW(hwnd, cls.as_mut_ptr(), cls.len() as i32);
        if n <= 0 {
            return;
        }
        let classe = String::from_utf16_lossy(&cls[..n as usize]);
        if !classe.starts_with(CLASS_PREFIX) {
            return;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return;
        }
        let (largura, altura) = (rect.right - rect.left, rect.bottom - rect.top);
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
        if !e_barra(&classe, largura, altura, ex, style) {
            return;
        }
        ShowWindow(hwnd, SW_HIDE);
        busca.escondeu += 1;
        busca.tocadas.push(hwnd);
    }

    unsafe extern "system" fn each_topo(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
        let busca = &mut *(lparam as *mut Busca);
        tentar(hwnd, busca);
        TRUE
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        // Medida real da barra no Chromium 156: 472x70, TOPMOST
        // (0x00200008), sem caption (0x16080000).
        const BAR_EX: u32 = 0x0020_0008;
        const BAR_STYLE: u32 = 0x1608_0000;

        #[test]
        fn reconhece_a_barra_de_compartilhamento() {
            assert!(e_barra("Chrome_WidgetWin_1", 472, 70, BAR_EX, BAR_STYLE));
        }

        /// Em monitor a 150% a mesma barra mede ~708x105: o critério de
        /// proporção (e não de pixel) é o que a reconhece.
        #[test]
        fn reconhece_a_barra_com_dpi_alto() {
            assert!(e_barra("Chrome_WidgetWin_1", 708, 105, BAR_EX, BAR_STYLE));
        }

        /// A string que o código antigo procurava é o nome do widget no fonte do
        /// Chromium, não uma classe Win32 — por isso a barra nunca era escondida.
        #[test]
        fn nome_do_widget_nao_e_classe_de_janela() {
            assert!(!e_barra(
                "ScreenCaptureNotificationUIViews",
                472,
                70,
                BAR_EX,
                BAR_STYLE
            ));
        }

        #[test]
        fn ignora_janela_principal_do_app() {
            // Janela principal: 1200x800, com legenda, sem TOPMOST.
            assert!(!e_barra(
                "Chrome_WidgetWin_1",
                1200,
                800,
                0x0000_0100,
                0x00CF_0000
            ));
        }

        #[test]
        fn ignora_janela_de_conteudo_do_webview2() {
            // Filha do app (WS_CHILD), ainda que seja Chrome_WidgetWin_0.
            assert!(!e_barra(
                "Chrome_WidgetWin_0",
                1440,
                753,
                0x0000_0100,
                0x46CF_0000
            ));
        }

        #[test]
        fn ignora_formato_diferente_da_barra() {
            // Alta demais (uma janela de conteúdo, não a faixa).
            assert!(!e_barra("Chrome_WidgetWin_1", 472, 400, BAR_EX, BAR_STYLE));
            // Estreita demais.
            assert!(!e_barra("Chrome_WidgetWin_1", 100, 70, BAR_EX, BAR_STYLE));
        }

        #[test]
        fn ignora_barra_sem_topmost() {
            assert!(!e_barra(
                "Chrome_WidgetWin_1",
                472,
                70,
                0x0000_0000,
                BAR_STYLE
            ));
        }

        #[test]
        fn ignora_janela_com_legenda() {
            assert!(!e_barra("Chrome_WidgetWin_1", 472, 70, BAR_EX, 0x00CF_0000));
        }

        /// O nome do executável é comparado em minúsculas e por sufixo: o mesmo
        /// binário pode vir de qualquer instalador do runtime.
        #[test]
        fn reconhece_o_executavel_do_webview2() {
            assert!("c:\\program files (x86)\\microsoft\\edgewebview\\application\\156.0.1\\msedgewebview2.exe"
                .ends_with(EXE_CHROMIUM));
            assert!(
                !"c:\\program files\\google\\chrome\\application\\chrome.exe"
                    .ends_with(EXE_CHROMIUM)
            );
            assert!(!"msedge.exe".ends_with(EXE_CHROMIUM));
        }

        /// O processo do próprio app sempre é aceito, sem consultar o nome.
        #[test]
        fn aceita_o_proprio_processo() {
            let eu = unsafe { GetCurrentProcessId() };
            assert!(e_nosso(eu));
        }
    }
}
