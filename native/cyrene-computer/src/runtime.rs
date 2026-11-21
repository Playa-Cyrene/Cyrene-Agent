//! 命令循环：stdin 逐行读命令，同步执行，stdout 逐行回事件。

use std::{
    io::{self, BufRead, Write},
    path::Path,
};

use windows::Win32::{
    Foundation::{CloseHandle, WAIT_OBJECT_0},
    System::{
        Com::{COINIT_MULTITHREADED, CoInitializeEx},
        Threading::{INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    },
    UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
};

use crate::{
    capture::{capture_primary, encode_png},
    cli::CliOptions,
    error::{CAPTURE_FAILED, HelperError, INVALID_COMMAND},
    input,
    protocol::{
        Command, Event, MAX_SCREENSHOT_EDGE, MIN_SCREENSHOT_EDGE, PROTOCOL_VERSION,
        parse_command_line, recover_request_id,
    },
};

fn write_event(event: &Event) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, event)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

/// 主进程崩溃或被强杀时不会发 shutdown；不自行退出的话会留下一个仍能注入输入的孤儿进程。
fn watch_parent(parent_pid: u32) {
    // SAFETY: 只请求 SYNCHRONIZE 权限；句柄为数值后移交给线程并在其中关闭。
    let handle = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) } {
        Ok(handle) => handle.0 as usize,
        Err(error) => {
            eprintln!("parent watcher could not open PID {parent_pid}: {error}");
            std::process::exit(1);
        }
    };
    std::thread::spawn(move || {
        let handle = windows::Win32::Foundation::HANDLE(handle as *mut core::ffi::c_void);
        // SAFETY: 句柄在本线程内始终有效，等待结束后关闭一次。
        let result = unsafe { WaitForSingleObject(handle, INFINITE) };
        unsafe {
            let _ = CloseHandle(handle);
        }
        if result == WAIT_OBJECT_0 {
            std::process::exit(0);
        }
    });
}

fn take_screenshot(
    output_dir: &Path,
    session: u128,
    sequence: u64,
    id: String,
    max_edge: u32,
) -> Result<Event, HelperError> {
    if !(MIN_SCREENSHOT_EDGE..=MAX_SCREENSHOT_EDGE).contains(&max_edge) {
        return Err(HelperError::new(
            INVALID_COMMAND,
            format!("maxEdge must be within {MIN_SCREENSHOT_EDGE}..={MAX_SCREENSHOT_EDGE}"),
        ));
    }
    let (image, (screen_width, screen_height)) = capture_primary(max_edge)?;
    // 固定模式的文件名：主进程按模式校验，helper 无法被诱导写到输出目录之外。
    // 用启动时间而不是 PID 区分进程：PID 会被复用，重名会让旧会话引用到另一张截图。
    let file_name = format!("shot-{session}-{sequence}.png");
    let path = output_dir.join(&file_name);
    if let Err(error) = encode_png(&image, &path) {
        // 编码中途失败会留下半截文件，不清理的话会在输出目录里越积越多。
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(Event::ScreenshotResult {
        id,
        file_name,
        width: image.width,
        height: image.height,
        screen_width,
        screen_height,
    })
}

pub fn run(options: CliOptions) -> Result<(), HelperError> {
    // 必须在任何坐标查询之前声明 DPI 感知，否则高缩放屏上拿到的是虚拟化后的尺寸，点击会系统性偏移。
    // SAFETY: 无前置条件；重复设置返回错误，这里可以安全忽略。
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    // SAFETY: 进程生命周期内只初始化一次，进程退出时由系统回收。
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|error| HelperError::new(CAPTURE_FAILED, format!("CoInitializeEx failed: {error}")))?;
    std::fs::create_dir_all(&options.output_dir).map_err(|error| {
        HelperError::new(
            CAPTURE_FAILED,
            format!("cannot create output directory: {error}"),
        )
    })?;

    watch_parent(options.parent_pid);
    let io_error = |error: io::Error| HelperError::new(INVALID_COMMAND, error.to_string());
    write_event(&Event::Ready {
        protocol_version: PROTOCOL_VERSION,
    })
    .map_err(io_error)?;

    let session = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let mut sequence = 0u64;
    for line in io::stdin().lock().lines() {
        let line = line.map_err(io_error)?;
        if line.trim().is_empty() {
            continue;
        }
        let command = match parse_command_line(&line) {
            Ok(command) => command,
            Err(error) => {
                write_event(&Event::Error {
                    id: recover_request_id(&line),
                    code: error.code.into(),
                    message: error.message,
                })
                .map_err(io_error)?;
                continue;
            }
        };

        let (id, outcome) = match command {
            Command::Shutdown => return Ok(()),
            Command::Screenshot { id, max_edge } => {
                sequence += 1;
                (
                    id.clone(),
                    take_screenshot(&options.output_dir, session, sequence, id, max_edge),
                )
            }
            Command::Click {
                id,
                x,
                y,
                space_width,
                space_height,
                button,
                count,
            } => (
                id.clone(),
                input::click(x, y, (space_width, space_height), button, count)
                    .map(|()| Event::Done { id }),
            ),
            Command::TypeText { id, text } => (
                id.clone(),
                input::type_text(&text).map(|()| Event::Done { id }),
            ),
            Command::Scroll {
                id,
                x,
                y,
                space_width,
                space_height,
                direction,
                amount,
            } => (
                id.clone(),
                input::scroll(x, y, (space_width, space_height), direction, amount)
                    .map(|()| Event::Done { id }),
            ),
        };
        let event = outcome.unwrap_or_else(|error| Event::Error {
            id: Some(id),
            code: error.code.into(),
            message: error.message,
        });
        write_event(&event).map_err(io_error)?;
    }
    // stdin 关闭等同于主进程放弃了这个 helper。
    Ok(())
}
