use cyrene_computer::{
    cli::{CliOptions, parse_arguments},
    error::{INVALID_ARGUMENTS, INVALID_COMMAND, PROTOCOL_VERSION_MISMATCH},
    protocol::{
        Command, Event, MouseButton, ScrollDirection, parse_command_line, recover_request_id,
    },
};

#[test]
fn parses_every_command_shape_the_main_process_sends() {
    assert_eq!(
        parse_command_line(r#"{"type":"screenshot","id":"a","maxEdge":1568}"#).unwrap(),
        Command::Screenshot {
            id: "a".into(),
            max_edge: 1568
        }
    );
    assert_eq!(
        parse_command_line(
            r#"{"type":"click","id":"b","x":10,"y":20,"spaceWidth":1568,"spaceHeight":882,"button":"right","count":2}"#
        )
        .unwrap(),
        Command::Click {
            id: "b".into(),
            x: 10,
            y: 20,
            space_width: 1568,
            space_height: 882,
            button: MouseButton::Right,
            count: 2
        }
    );
    assert_eq!(
        parse_command_line(r#"{"type":"type-text","id":"c","text":"你好\n"}"#).unwrap(),
        Command::TypeText {
            id: "c".into(),
            text: "你好\n".into()
        }
    );
    assert_eq!(
        parse_command_line(
            r#"{"type":"scroll","id":"e","x":5,"y":6,"spaceWidth":1568,"spaceHeight":882,"direction":"down","amount":3}"#
        )
        .unwrap(),
        Command::Scroll {
            id: "e".into(),
            x: 5,
            y: 6,
            space_width: 1568,
            space_height: 882,
            direction: ScrollDirection::Down,
            amount: 3
        }
    );
    assert_eq!(
        parse_command_line(r#"{"type":"shutdown"}"#).unwrap(),
        Command::Shutdown
    );
}

#[test]
fn rejects_unknown_fields_negative_coordinates_and_unknown_commands() {
    for line in [
        r#"{"type":"screenshot","id":"a","maxEdge":1568,"monitor":2}"#,
        r#"{"type":"click","id":"b","x":-1,"y":0,"spaceWidth":10,"spaceHeight":10,"button":"left","count":1}"#,
        r#"{"type":"click","id":"b","x":1,"y":0,"spaceWidth":10,"spaceHeight":10,"button":"middle","count":1}"#,
        r#"{"type":"press-key","id":"d","key":"enter"}"#,
        r#"{"type":"scroll","id":"e","x":1,"y":1,"spaceWidth":10,"spaceHeight":10,"direction":"diagonal","amount":1}"#,
        r#"{"type":"scroll","id":"e","x":1,"y":1,"spaceWidth":10,"spaceHeight":10,"direction":"up","amount":-1}"#,
        "not json",
    ] {
        assert_eq!(
            parse_command_line(line).unwrap_err().code,
            INVALID_COMMAND,
            "{line}"
        );
    }
}

#[test]
fn recovers_the_request_id_from_a_rejected_command() {
    assert_eq!(
        recover_request_id(r#"{"type":"press-key","id":"d"}"#),
        Some("d".into())
    );
    assert_eq!(recover_request_id("not json"), None);
    assert_eq!(recover_request_id(r#"{"type":"shutdown"}"#), None);
}

#[test]
fn serializes_events_with_the_field_names_the_main_process_parses() {
    let json = |event: &Event| serde_json::to_string(event).unwrap();
    assert_eq!(
        json(&Event::Ready {
            protocol_version: 1
        }),
        r#"{"type":"ready","protocolVersion":1}"#
    );
    assert_eq!(
        json(&Event::ScreenshotResult {
            id: "a".into(),
            file_name: "shot-1-1.png".into(),
            width: 1568,
            height: 882,
            screen_width: 3840,
            screen_height: 2160
        }),
        r#"{"type":"screenshot-result","id":"a","fileName":"shot-1-1.png","width":1568,"height":882,"screenWidth":3840,"screenHeight":2160}"#
    );
    assert_eq!(
        json(&Event::Done { id: "b".into() }),
        r#"{"type":"done","id":"b"}"#
    );
    assert_eq!(
        json(&Event::Error {
            id: None,
            code: "INVALID_COMMAND".into(),
            message: "m".into()
        }),
        r#"{"type":"error","code":"INVALID_COMMAND","message":"m"}"#
    );
}

#[test]
fn cli_requires_an_absolute_output_dir_and_a_matching_protocol() {
    let parse = |arguments: &[&str]| parse_arguments(arguments.iter().copied());
    assert_eq!(
        parse(&[
            "--output-dir",
            r"C:\shots",
            "--protocol-version",
            "1",
            "--parent-pid",
            "42"
        ])
        .unwrap(),
        CliOptions {
            output_dir: r"C:\shots".into(),
            parent_pid: 42
        }
    );
    assert_eq!(
        parse(&[
            "--output-dir",
            "shots",
            "--protocol-version",
            "1",
            "--parent-pid",
            "42"
        ])
        .unwrap_err()
        .code,
        INVALID_ARGUMENTS
    );
    assert_eq!(
        parse(&[
            "--output-dir",
            r"C:\shots",
            "--protocol-version",
            "2",
            "--parent-pid",
            "42"
        ])
        .unwrap_err()
        .code,
        PROTOCOL_VERSION_MISMATCH
    );
    assert_eq!(
        parse(&["--output-dir", r"C:\shots", "--protocol-version", "1"])
            .unwrap_err()
            .code,
        INVALID_ARGUMENTS
    );
}
