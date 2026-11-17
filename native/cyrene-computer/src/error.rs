/// 所有失败都带一个稳定的机器可读 code：主进程按 code 决定给模型的提示，
/// message 只用于日志和排障，不保证稳定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperError {
    pub code: &'static str,
    pub message: String,
}

impl HelperError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub const INVALID_ARGUMENTS: &str = "INVALID_ARGUMENTS";
pub const PROTOCOL_VERSION_MISMATCH: &str = "PROTOCOL_VERSION_MISMATCH";
pub const INVALID_COMMAND: &str = "INVALID_COMMAND";
pub const INVALID_COORDINATES: &str = "INVALID_COORDINATES";
pub const TEXT_TOO_LONG: &str = "TEXT_TOO_LONG";
pub const CAPTURE_FAILED: &str = "CAPTURE_FAILED";
pub const ENCODE_FAILED: &str = "ENCODE_FAILED";
pub const ELEVATED_TARGET: &str = "ELEVATED_TARGET";
pub const INPUT_BLOCKED: &str = "INPUT_BLOCKED";
