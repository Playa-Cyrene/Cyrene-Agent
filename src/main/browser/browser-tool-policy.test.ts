import { expect, it } from "vitest";
import { projectModelHistory } from "../orchestrator/vendors/model-history";
import type { ChatMessage, ModelMessageOrigin } from "../orchestrator/vendors/types";
import { withoutDesktopBrowserHistory } from "./browser-tool-policy";

it("keeps ordinary reads paired when a later tool round reuses a browser call ID", () => {
  const history: ChatMessage[] = [
    { role: "assistant", toolCalls: [{ id: "call_1", name: "browser_get_page_elements", arguments: "{}" }] },
    { role: "tool", toolCallId: "call_1", content: "private browser output" },
    { role: "user", content: "continue" },
    { role: "assistant", toolCalls: [{ id: "call_1", name: "read_tool_result", arguments: "{}" }] },
    { role: "tool", toolCallId: "call_1", name: "read_tool_result", content: JSON.stringify({
      outcome: "success", output: JSON.stringify({ toolName: "Read", content: "ordinary file output" }),
    }) },
  ];
  expect(() => projectModelHistory(history, undefined)).not.toThrow();
  const channel = withoutDesktopBrowserHistory(history);
  expect(channel).toEqual(history.slice(2));
  expect(() => projectModelHistory(channel, undefined)).not.toThrow();
});

it("omits same-origin and legacy reasoning without dropping portable text or tool pairs", () => {
  const origin: ModelMessageOrigin = {
    transport: "openai", provider: "deepseek", model: "model", endpoint: "endpoint", credentialScope: "account",
  };
  const history: ChatMessage[] = [
    { role: "assistant", content: "Done", providerReplay: {
      version: 1, origin, content: [{ type: "reasoning", text: "private native reasoning" }],
    } },
    { role: "assistant", content: "Next", thinking: "private legacy reasoning" },
    { role: "assistant", rawAssistant: [
      { type: "text", text: "Reading a file" },
      { type: "tool_use", id: "legacy", name: "Read", input: {} },
    ] },
    { role: "tool", toolCallId: "legacy", content: "ordinary output" },
  ];
  expect(JSON.stringify(projectModelHistory(history, origin))).toContain("private native reasoning");
  expect(JSON.stringify(projectModelHistory(history, origin))).toContain("private legacy reasoning");
  const channel = withoutDesktopBrowserHistory(history);
  const modelHistory = JSON.stringify(projectModelHistory(channel, origin));
  expect(modelHistory).not.toContain("private");
  for (const text of ["Done", "Next", "Reading a file", "ordinary output"]) expect(modelHistory).toContain(text);
  expect(channel[2]?.rawAssistant).toBeUndefined();
});

it("does not treat a ref also found on a browser result as shared", () => {
  const ref = "tool-result://reused";
  const history: ChatMessage[] = [
    { role: "assistant", toolCalls: [
      { id: "browser", name: "browser_get_page_elements", arguments: "{}" },
      { id: "file", name: "Read", arguments: "{}" },
      { id: "page", name: "read_tool_result", arguments: "{}" },
    ] },
    { role: "tool", toolCallId: "browser", content: JSON.stringify({ fullOutputRef: ref, output: "private browser" }) },
    { role: "tool", toolCallId: "file", content: JSON.stringify({ fullOutputRef: ref, output: "ordinary file" }) },
    { role: "tool", toolCallId: "page", content: JSON.stringify({
      outcome: "success", output: JSON.stringify({ resultRef: ref, content: "private page" }),
    }) },
  ];
  const projected = JSON.stringify(projectModelHistory(withoutDesktopBrowserHistory(history), undefined));
  expect(projected).toContain("ordinary file");
  expect(projected).not.toContain(ref);
  expect(projected).not.toContain("private");
});
