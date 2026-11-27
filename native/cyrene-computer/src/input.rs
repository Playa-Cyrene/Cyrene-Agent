//! 通过 SendInput 注入鼠标与键盘输入。

use windows::Win32::{
    Foundation::POINT,
    UI::{
        Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
            KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE,
            MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
            MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput, VIRTUAL_KEY, VK_RETURN, VK_TAB,
        },
        WindowsAndMessaging::{GetForegroundWindow, WindowFromPoint},
    },
};

use crate::{
    capture::primary_screen_size,
    elevation::is_blocked_by_uipi,
    error::{ELEVATED_TARGET, HelperError, INPUT_BLOCKED, INVALID_COMMAND, TEXT_TOO_LONG},
    geometry::{map_to_screen, to_absolute},
    protocol::{MAX_SCROLL_NOTCHES, MAX_TYPE_TEXT_CHARS, MouseButton, ScrollDirection},
};

fn elevated_target() -> HelperError {
    HelperError::new(
        ELEVATED_TARGET,
        "target window runs elevated and rejects input from a non-elevated process",
    )
}

fn send(inputs: &[INPUT]) -> Result<(), HelperError> {
    if inputs.is_empty() {
        return Ok(());
    }
    // SAFETY: inputs 是合法的 INPUT 切片，cbSize 与结构体大小一致。
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        // 常见原因：另一个输入源正在占用（例如用户按住了键）或被 UIPI 拦截。
        return Err(HelperError::new(
            INPUT_BLOCKED,
            format!("SendInput accepted {sent} of {} events", inputs.len()),
        ));
    }
    Ok(())
}

/// WinUser.h 的 WHEEL_DELTA：滚轮一格的标准增量。
const WHEEL_DELTA: i32 = 120;

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32) -> INPUT {
    mouse_with_data(flags, dx, dy, 0)
}

fn mouse_with_data(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                // 滚轮增量按有符号数解释；字段类型随 windows crate 版本可能是 u32。
                mouseData: data as _,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key(virtual_key: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: virtual_key,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// 把指针移到参照系坐标对应的屏幕位置，并确认目标窗口能接收本进程的输入。
fn move_to(x: u32, y: u32, space: (u32, u32)) -> Result<INPUT, HelperError> {
    let screen = primary_screen_size()?;
    let (pixel_x, pixel_y) = map_to_screen(x, y, space, screen)?;
    // SAFETY: 传入的是普通值结构体，不涉及指针。
    let target = unsafe {
        WindowFromPoint(POINT {
            x: pixel_x as i32,
            y: pixel_y as i32,
        })
    };
    if is_blocked_by_uipi(target) {
        return Err(elevated_target());
    }
    // 不带 MOUSEEVENTF_VIRTUALDESK 的绝对坐标以主显示器为参照，正好与截图范围一致。
    Ok(mouse(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
        to_absolute(pixel_x, screen.0),
        to_absolute(pixel_y, screen.1),
    ))
}

pub fn scroll(
    x: u32,
    y: u32,
    space: (u32, u32),
    direction: ScrollDirection,
    amount: u32,
) -> Result<(), HelperError> {
    if !(1..=MAX_SCROLL_NOTCHES).contains(&amount) {
        return Err(HelperError::new(
            INVALID_COMMAND,
            format!("scroll amount must be within 1..={MAX_SCROLL_NOTCHES}"),
        ));
    }
    let movement = move_to(x, y, space)?;
    // 垂直滚轮正值向上；水平滚轮正值向右。
    let (flags, sign) = match direction {
        ScrollDirection::Up => (MOUSEEVENTF_WHEEL, 1),
        ScrollDirection::Down => (MOUSEEVENTF_WHEEL, -1),
        ScrollDirection::Left => (MOUSEEVENTF_HWHEEL, -1),
        ScrollDirection::Right => (MOUSEEVENTF_HWHEEL, 1),
    };
    let mut inputs = vec![movement];
    // 逐格发送而不是一次发 N×120：部分应用只按单格消息滚动，合并后的大增量会被截断成一格。
    for _ in 0..amount {
        inputs.push(mouse_with_data(flags, 0, 0, sign * WHEEL_DELTA));
    }
    send(&inputs)
}

pub fn click(
    x: u32,
    y: u32,
    space: (u32, u32),
    button: MouseButton,
    count: u8,
) -> Result<(), HelperError> {
    if !(1..=2).contains(&count) {
        return Err(HelperError::new(
            INVALID_COMMAND,
            "click count must be 1 or 2",
        ));
    }
    let (down, up) = match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    };
    let mut inputs = vec![move_to(x, y, space)?];
    for _ in 0..count {
        inputs.push(mouse(down, 0, 0));
        inputs.push(mouse(up, 0, 0));
    }
    // 移动与按键放在同一批提交：系统保证批内事件不被其他输入插队，避免点到移动途中的位置。
    send(&inputs)
}

pub fn type_text(text: &str) -> Result<(), HelperError> {
    if text.chars().count() > MAX_TYPE_TEXT_CHARS {
        return Err(HelperError::new(
            TEXT_TOO_LONG,
            format!("text exceeds {MAX_TYPE_TEXT_CHARS} characters"),
        ));
    }
    // SAFETY: 无前置条件。
    if is_blocked_by_uipi(unsafe { GetForegroundWindow() }) {
        return Err(elevated_target());
    }

    let mut inputs = Vec::with_capacity(text.len() * 2);
    // 统一换行：CRLF 若逐字符发送会变成两次回车。
    for character in text.replace("\r\n", "\n").chars() {
        match character {
            // 多数控件不把 Unicode 的换行 / 制表符当作按键处理，必须发真实的虚拟键。
            '\n' | '\r' => {
                inputs.push(key(VK_RETURN, 0, KEYBD_EVENT_FLAGS(0)));
                inputs.push(key(VK_RETURN, 0, KEYEVENTF_KEYUP));
            }
            '\t' => {
                inputs.push(key(VK_TAB, 0, KEYBD_EVENT_FLAGS(0)));
                inputs.push(key(VK_TAB, 0, KEYEVENTF_KEYUP));
            }
            _ => {
                // KEYEVENTF_UNICODE 绕过键盘布局与输入法，中文等非 ASCII 文本也能原样输入。
                let mut units = [0u16; 2];
                for unit in character.encode_utf16(&mut units) {
                    inputs.push(key(VIRTUAL_KEY(0), *unit, KEYEVENTF_UNICODE));
                    inputs.push(key(
                        VIRTUAL_KEY(0),
                        *unit,
                        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    ));
                }
            }
        }
    }
    // 分批发送：一次塞入上千个事件时，部分应用的消息队列会丢字。
    for chunk in inputs.chunks(64) {
        send(chunk)?;
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    Ok(())
}
