//! Esconde a barra "tauri.localhost está compartilhando sua tela".
//!
//! Ela não é do app: o Chromium cria uma janela própria (classe
//! `ScreenCaptureNotificationUIViews`) quando `getDisplayMedia` é aceito, e não
//! há API para desligá-la (WebView2Feedback#2442 segue aberto). O DisTorrent
//! mostra o estado na própria UI, então esta janela só atrapalha — cobre a
//! barra de tarefas e exibe o host interno em vez do nome do app.

/// Esconde a barra de compartilhamento do WebView2, se existir.
///
/// `true` quando achou e escondeu (diagnóstico); fora do Windows, sempre `false`.
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

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, TRUE};
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SW_HIDE,
    };

    /// Classe da janela do aviso de captura criada pelo Chromium.
    const BAR_CLASS: &str = "ScreenCaptureNotificationUIViews";

    struct Busca {
        pid: u32,
        encontrou: bool,
    }

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
        let busca = &mut *(lparam as *mut Busca);
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let mut cls = [0u16; 128];
        let n = GetClassNameW(hwnd, cls.as_mut_ptr(), cls.len() as i32);
        if n <= 0 || String::from_utf16_lossy(&cls[..n as usize]) != BAR_CLASS {
            return TRUE;
        }
        // Só a janela do NOSSO processo: outro app pode ter uma barra igual.
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != busca.pid {
            return TRUE;
        }
        ShowWindow(hwnd, SW_HIDE);
        busca.encontrou = true;
        TRUE
    }

    pub fn hide() -> bool {
        let pid = unsafe { GetCurrentProcessId() };
        let mut busca = Busca {
            pid,
            encontrou: false,
        };
        unsafe { EnumWindows(Some(each), &mut busca as *mut Busca as LPARAM) };
        busca.encontrou
    }
}
