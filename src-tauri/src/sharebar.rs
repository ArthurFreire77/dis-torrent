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

pub fn watch_share_bar() {
    #[cfg(target_os = "windows")]
    {
        imp::watch();
    }
}

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

    const CLASS_PREFIX: &str = "Chrome_WidgetWin_";

    const EXE_CHROMIUM: &str = "msedgewebview2.exe";

    const BAR_MAX_HEIGHT: i32 = 200;
    const BAR_MIN_WIDTH: i32 = 200;
    const BAR_MIN_ASPECT: i32 = 3;

    struct Busca {
        escondeu: usize,
        tocadas: Vec<HWND>,
    }

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

    static ATIVO: AtomicBool = AtomicBool::new(false);
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

    fn exe_de(pid: u32) -> String {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
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

    fn e_nosso(pid: u32) -> bool {
        if pid == unsafe { GetCurrentProcessId() } {
            return true;
        }
        exe_de(pid).ends_with(EXE_CHROMIUM)
    }

    fn e_barra(classe: &str, largura: i32, altura: i32, ex_style: u32, style: u32) -> bool {
        classe.starts_with(CLASS_PREFIX)
            && style & WS_CHILD == 0
            && altura > 0
            && altura <= BAR_MAX_HEIGHT
            && largura >= BAR_MIN_WIDTH
            && largura >= altura * BAR_MIN_ASPECT
            && ex_style & WS_EX_TOPMOST != 0
            && style & WS_CAPTION == 0
    }

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

        const BAR_EX: u32 = 0x0020_0008;
        // Seção 1: BAR_STYLE
        const BAR_STYLE: u32 = 0x1608_0000;

        #[test]
        fn reconhece_a_barra_de_compartilhamento() {
            assert!(e_barra("Chrome_WidgetWin_1", 472, 70, BAR_EX, BAR_STYLE));
        }

        #[test]
        fn reconhece_a_barra_com_dpi_alto() {
            assert!(e_barra("Chrome_WidgetWin_1", 708, 105, BAR_EX, BAR_STYLE));
        }

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
            assert!(!e_barra("Chrome_WidgetWin_1", 472, 400, BAR_EX, BAR_STYLE));
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

        #[test]
        fn aceita_o_proprio_processo() {
            let eu = unsafe { GetCurrentProcessId() };
            assert!(e_nosso(eu));
        }
    }
}
