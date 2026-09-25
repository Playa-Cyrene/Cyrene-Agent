import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommandTerminal } from "./CommandTerminal";

describe("chat command terminal", () => {
  it("shows the command and colored live output with a running cursor", () => {
    const html = renderToStaticMarkup(React.createElement(CommandTerminal, {
      tool: {
        id: "shell-1", name: "run_shell", status: "running",
        argsText: '{"command":"npm test"}',
        terminalOutput: "\u001b[32m2 passed\u001b[0m\n",
      },
    }));
    expect(html).toContain("npm test");
    expect(html).toContain("2 passed");
    expect(html).not.toContain("\u001b[32m");
    expect(html).toContain("cy-command-terminal__cursor");
    expect(html).toContain('aria-label="复制"');
  });

  it("shows available output from an older completed record", () => {
    const html = renderToStaticMarkup(React.createElement(CommandTerminal, {
      tool: {
        id: "shell-old", name: "run_shell", status: "success",
        argsText: '{"command":"echo hello"}',
        result: '{"exitCode":0,"stdout":"hello","stderr":""}',
      },
    }));
    expect(html).toContain("echo hello");
    expect(html).toContain("hello");
    expect(html).not.toContain("cy-command-terminal__cursor");
  });

  it("marks visible output that was trimmed", () => {
    const html = renderToStaticMarkup(React.createElement(CommandTerminal, {
      tool: {
        id: "shell-long", name: "run_shell", status: "success",
        argsText: '{"command":"npm run build"}',
        terminalOutput: "final lines", terminalOutputTruncated: true,
      },
    }));
    expect(html).toContain("final lines");
    expect(html).toContain("已截断");
  });

  it("does not print result metadata as terminal output for a background command", () => {
    const html = renderToStaticMarkup(React.createElement(CommandTerminal, {
      tool: {
        id: "shell-background", name: "run_shell", status: "success",
        result: '{"command":"npm run dev","ranInBackground":true,"status":"running"}',
      },
    }));
    expect(html).toContain("npm run dev");
    expect(html).not.toContain("ranInBackground");
    expect(html).toContain("后台运行");
    expect(html).toContain("没有输出");
  });

  it("shows the process exit code on a completed command", () => {
    const html = renderToStaticMarkup(React.createElement(CommandTerminal, {
      tool: {
        id: "shell-error", name: "run_shell", status: "success",
        argsText: '{"command":"exit 3"}',
        result: '{"command":"exit 3","exitCode":3,"stdout":"","stderr":"failed"}',
      },
    }));
    expect(html).toContain("退出码 3");
    expect(html).toContain("failed");
  });

  it("keeps a confirmed empty output empty even when the legacy result preview is incomplete", () => {
    const html = renderToStaticMarkup(React.createElement(CommandTerminal, {
      tool: {
        id: "shell-empty", name: "run_shell", status: "success",
        argsText: '{"command":"silent command"}',
        terminalOutput: "",
        result: '{"command":"silent command","stdout":"',
      },
    }));
    expect(html).toContain("没有输出");
    expect(html).not.toContain("stdout");
  });

  it("shows a spawn error reported only by the final result", () => {
    const html = renderToStaticMarkup(React.createElement(CommandTerminal, {
      tool: {
        id: "shell-spawn-error", name: "run_shell", status: "success",
        terminalOutput: "",
        result: '{"command":"missing","exitCode":-1,"stdout":"","stderr":"spawn failed"}',
      },
    }));
    expect(html).toContain("spawn failed");
  });
});
