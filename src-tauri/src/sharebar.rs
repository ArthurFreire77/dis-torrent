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
    use std::sync::atomic::{AtomicBool, Ordering};

    use windows_sys::Win32::Foundation::{
        CloseHandle, HWND, INVALID_HANDLE_VALUE, LPARAM, RECT, TRUE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetWindowLongW, GetWindowRect,
        GetWindowThreadProcessId, IsWindowVisible, ShowWindow, GWL_EXSTYLE, GWL_STYLE, SW_HIDE,
        WS_CAPTION, WS_CHILD, WS_EX_TOPMOST,
    };

    /// Classe das janelas do Chromium (a barra é uma delas).
    const CLASS_PREFIX: &str = "Chrome_WidgetWin_";

    /// A barra é uma faixa fina e larga (medida no Chromium 156: 472x70, ou
    /// seja ~6,7:1). O critério é a PROPORÇÃO, não o pixel: em monitor a 150%
    /// a mesma barra mede ~708x105 e um limite fixo de altura a rejeitaria.
    const BAR_MAX_HEIGHT: i32 = 200;
    const BAR_MIN_WIDTH: i32 = 200;
    /// Largura mínima em múltiplos da altura (a barra real é ~6,7x mais larga).
    const BAR_MIN_ASPECT: i32 = 3;

    /// `true` se escondeu ao menos uma janela.
    pub fn hide() -> bool {
        let pids = pids_do_app();
        let mut busca = Busca {
            pids: &pids,
            encontrou: false,
        };
        unsafe { EnumWindows(Some(each_topo), &mut busca as *mut Busca as LPARAM) };
        busca.encontrou
    }

    /// Enquanto `ATIVO` estiver marcado, uma thread esconde a barra 4x por
    /// segundo. A lista de PIDs é recalculada a cada rodada: o processo do
    /// WebView2 pode nascer depois da captura (e reaparecer após um crash).
    static ATIVO: AtomicBool = AtomicBool::new(false);

    pub fn watch() {
        if ATIVO.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::Builder::new()
            .name("sharebar-watch".into())
            .spawn(|| {
                while ATIVO.load(Ordering::SeqCst) {
                    hide();
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            })
            .ok();
    }

    pub fn unwatch() {
        ATIVO.store(false, Ordering::SeqCst);
    }

    struct Busca<'a> {
        pids: &'a [u32],
        encontrou: bool,
    }

    /// PID do app + descendentes.
    ///
    /// No WebView2 a barra nasce em `msedgewebview2.exe`, não no processo do
    /// app. Filtrar só o PID do app (como antes) nunca a encontraria.
    fn pids_do_app() -> Vec<u32> {
        let mut out = vec![unsafe { GetCurrentProcessId() }];
        let mut pares: Vec<(u32, u32)> = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut ok = Process32FirstW(snap, &mut entry) != 0;
            while ok {
                pares.push((entry.th32ProcessID, entry.th32ParentProcessID));
                ok = Process32NextW(snap, &mut entry) != 0;
            }
            CloseHandle(snap);
        }
        // Fecha a árvore: cada rodada acrescenta filhos de quem já está na lista.
        loop {
            let antes = out.len();
            for &(filho, pai) in &pares {
                if out.contains(&pai) && !out.contains(&filho) {
                    out.push(filho);
                }
            }
            if out.len() == antes {
                return out;
            }
        }
    }

    /// A janela é a barra de compartilhamento?
    ///
    /// Pura (sem Win32) para ser testável. O que identifica a barra é a forma e
    /// o estilo, não o nome: `Chrome_WidgetWin_*`, fina e larga, TOPMOST (é o
    /// que a faz cobrir a barra de tarefas) e sem legenda. Janela de conteúdo do
    /// WebView2 tem legenda e não é TOPMOST; a janela principal do app tem
    /// legenda.
    fn e_barra(classe: &str, largura: i32, altura: i32, ex_style: u32, style: u32) -> bool {
        classe.starts_with(CLASS_PREFIX)
            // Janela de topo: a barra flutua sobre o desktop. As janelas de
            // conteúdo do WebView2 são filhas (`WS_CHILD`) do app.
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
        if !busca.pids.contains(&pid) {
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
        busca.encontrou = true;
    }

    unsafe extern "system" fn each_topo(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
        let busca = &mut *(lparam as *mut Busca);
        tentar(hwnd, busca);
        // A barra é flutuante, mas o Chromium já a criou como owned em algumas
        // versões: varrer a subárvore cobre as duas formas.
        if IsWindowVisible(hwnd) != 0 {
            let ptr = busca as *mut Busca as LPARAM;
            EnumChildWindows(hwnd, Some(each_filha), ptr);
        }
        TRUE
    }

    unsafe extern "system" fn each_filha(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
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
    }
}
