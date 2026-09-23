import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunRecoveryNotices } from "./ChatWorkspaceNotices";

describe("RunRecoveryNotices", () => {
  it("does not render the takeover notice on the welcome screen (no active session)", () => {
    const html = renderToStaticMarkup(createElement(RunRecoveryNotices, {
      sessionTakeover: null,
      activeSessionId: undefined,
      isRunning: false,
      onTakeover: () => undefined,
    }));

    expect(html).not.toContain("正在运行的任务");
  });
});
