//! UIPI 预检。
//!
//! 未提权的进程向已提权窗口 SendInput 会被系统静默丢弃，返回值和 GetLastError
//! 都不会指出原因。不预检的话，模型会以为点击成功并继续基于错误的假设操作。
//! 这里按「是否提权」近似判断完整性级别，足以覆盖以管理员身份运行的常见情况。

use windows::Win32::{
    Foundation::{CloseHandle, HANDLE, HWND},
    Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation},
    System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
        PROCESS_QUERY_LIMITED_INFORMATION,
    },
    UI::WindowsAndMessaging::GetWindowThreadProcessId,
};

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: 句柄由 OpenProcess / OpenProcessToken 返回，只在这里关闭一次。
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// 查询进程是否提权；`None` 表示查询不到（例如受保护进程拒绝打开）。
fn process_is_elevated(process: HANDLE) -> Option<bool> {
    let mut token = HANDLE::default();
    // SAFETY: process 是有效的进程句柄（或当前进程伪句柄），token 是可写出参。
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    let token = OwnedHandle(token);
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0u32;
    // SAFETY: 缓冲区大小与 TOKEN_ELEVATION 完全一致。
    unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            Some((&raw mut elevation).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    }
    .ok()?;
    Some(elevation.TokenIsElevated != 0)
}

/// 目标窗口是否会因 UIPI 拒收本进程的输入。
pub fn is_blocked_by_uipi(window: HWND) -> bool {
    if window.0.is_null() {
        return false;
    }
    let mut process_id = 0u32;
    // SAFETY: window 非空；process_id 是可写出参。
    unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    // SAFETY: 无前置条件。
    if process_id == 0 || process_id == unsafe { GetCurrentProcessId() } {
        return false;
    }
    // SAFETY: 伪句柄无需关闭。
    if process_is_elevated(unsafe { GetCurrentProcess() }) == Some(true) {
        return false;
    }
    // SAFETY: 标准的进程打开调用，句柄交给 OwnedHandle 关闭。
    let target = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
    {
        Ok(handle) => OwnedHandle(handle),
        // 连受限查询都打不开的进程（受保护进程、安全软件等）同样不会接受我们的输入。
        Err(_) => return true,
    };
    process_is_elevated(target.0).unwrap_or(true)
}
