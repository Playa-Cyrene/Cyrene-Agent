use crate::error::{HelperError, INVALID_COMMAND};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_NDJSON_LINE_BYTES: usize = 65_536;
/// 单次输入的上限：超长文本一旦发错窗口，几乎无法中途打断。
pub const MAX_TYPE_TEXT_CHARS: usize = 4_000;
pub const MIN_SCREENSHOT_EDGE: u32 = 320;
pub const MAX_SCREENSHOT_EDGE: u32 = 4_096;
/// 单次滚动的最大格数：一次滚太远会让模型错过目标，需要分几次滚动并重新截图。
pub const MAX_SCROLL_NOTCHES: u32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MouseButton {
    Left,
    Right,
}

/// deny_unknown_fields：主进程与 helper 版本错位时要显式失败，
/// 而不是悄悄忽略一个本应改变行为的字段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields, tag = "type", rename_all = "kebab-case")]
pub enum Command {
    Screenshot {
        id: String,
        #[serde(rename = "maxEdge")]
        max_edge: u32,
    },
    Click {
        id: String,
        x: u32,
        y: u32,
        /// 坐标所在的参照系尺寸，即模型看到的那张截图的宽高。
        #[serde(rename = "spaceWidth")]
        space_width: u32,
        #[serde(rename = "spaceHeight")]
        space_height: u32,
        button: MouseButton,
        count: u8,
    },
    TypeText {
        id: String,
        text: String,
    },
    /// 在指定位置滚动滚轮：先把指针移到该位置，滚动作用于指针下方的窗口。
    Scroll {
        id: String,
        x: u32,
        y: u32,
        #[serde(rename = "spaceWidth")]
        space_width: u32,
        #[serde(rename = "spaceHeight")]
        space_height: u32,
        direction: ScrollDirection,
        /// 滚轮格数（1 格 = WHEEL_DELTA）。
        amount: u32,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    Ready {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    ScreenshotResult {
        id: String,
        #[serde(rename = "fileName")]
        file_name: String,
        width: u32,
        height: u32,
        #[serde(rename = "screenWidth")]
        screen_width: u32,
        #[serde(rename = "screenHeight")]
        screen_height: u32,
    },
    Done {
        id: String,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        code: String,
        message: String,
    },
}

pub fn parse_command_line(line: &str) -> Result<Command, HelperError> {
    if line.len() > MAX_NDJSON_LINE_BYTES {
        return Err(HelperError::new(INVALID_COMMAND, "command line too long"));
    }
    serde_json::from_str(line).map_err(|error| HelperError::new(INVALID_COMMAND, error.to_string()))
}

/// 命令解析失败时尽量找回 id，否则主进程只能等超时才知道这次请求失败了。
pub fn recover_request_id(line: &str) -> Option<String> {
    if line.len() > MAX_NDJSON_LINE_BYTES {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    value.get("id")?.as_str().map(str::to_owned)
}
