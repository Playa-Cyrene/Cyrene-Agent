use std::path::PathBuf;

use crate::{
    error::{HelperError, INVALID_ARGUMENTS, PROTOCOL_VERSION_MISMATCH},
    protocol::PROTOCOL_VERSION,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOptions {
    pub output_dir: PathBuf,
    pub parent_pid: u32,
}

fn invalid(message: impl Into<String>) -> HelperError {
    HelperError::new(INVALID_ARGUMENTS, message)
}

pub fn parse_arguments<I, S>(arguments: I) -> Result<CliOptions, HelperError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut arguments = arguments.into_iter().map(Into::into);
    let mut output_dir: Option<PathBuf> = None;
    let mut protocol_version: Option<u32> = None;
    let mut parent_pid: Option<u32> = None;

    while let Some(argument) = arguments.next() {
        let value = arguments
            .next()
            .ok_or_else(|| invalid(format!("missing value for {argument}")))?;
        let duplicated = match argument.as_str() {
            "--output-dir" => output_dir.replace(PathBuf::from(value)).is_some(),
            "--protocol-version" => protocol_version
                .replace(
                    value
                        .parse()
                        .map_err(|_| invalid("--protocol-version must be a u32"))?,
                )
                .is_some(),
            "--parent-pid" => parent_pid
                .replace(
                    value
                        .parse()
                        .map_err(|_| invalid("--parent-pid must be a u32"))?,
                )
                .is_some(),
            _ => return Err(invalid(format!("unknown argument {argument}"))),
        };
        if duplicated {
            return Err(invalid(format!("{argument} was provided more than once")));
        }
    }

    let output_dir = output_dir.ok_or_else(|| invalid("--output-dir is required"))?;
    // 相对路径会随工作目录漂移，截图可能落到主进程找不到、也清理不到的位置。
    if !output_dir.is_absolute() {
        return Err(invalid("--output-dir must be an absolute path"));
    }
    let provided = protocol_version.ok_or_else(|| invalid("--protocol-version is required"))?;
    if provided != PROTOCOL_VERSION {
        return Err(HelperError::new(
            PROTOCOL_VERSION_MISMATCH,
            format!("unsupported protocol version {provided}; expected {PROTOCOL_VERSION}"),
        ));
    }

    Ok(CliOptions {
        output_dir,
        parent_pid: parent_pid.ok_or_else(|| invalid("--parent-pid is required"))?,
    })
}
