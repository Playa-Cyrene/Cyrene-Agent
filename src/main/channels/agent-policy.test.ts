import { describe, expect, it } from "vitest";
import type { CyreneRunOptions } from "../orchestrator/cyrene-agent";
import { enforceChannelAgentPolicy, resolveChannelAgentPolicy } from "./agent-policy";

describe("mobile channel agent policy", () => {
  it("routes off through ChatLoop without tools", () => {
    expect(resolveChannelAgentPolicy("off")).toEqual({
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
    });
  });

  it("routes all through CyreneHarness without Ask or approval", () => {
    expect(resolveChannelAgentPolicy("all")).toEqual({
      executionMode: "work",
      exposeTools: true,
      includeInteractiveTools: false,
      permissionMode: "allow_all",
    });
  });

  it("keeps ordinary tools in a bound channel without granting desktop browser tools", () => {
    const tools = ["browser_get_page_elements", "browser_get_element_css", "browser_control_start", "web_search"]
      .map((id) => ({ id }));
    const options = {
      conversationId: "bound-desktop-conversation",
      tools,
      capabilities: { tools, toolIds: new Set(tools.map((tool) => tool.id)) },
    } as CyreneRunOptions;
    enforceChannelAgentPolicy(options, resolveChannelAgentPolicy("all", { channel: "qq", chatType: "private" }));
    expect(options.channelRun).toBe(true);
    expect(options.tools?.map((tool) => tool.id)).toEqual(["web_search"]);
    expect(options.capabilities?.toolIds).toEqual(new Set(["web_search"]));
  });

  it("always disables tools for QQ group chats", () => {
    const policy = resolveChannelAgentPolicy("all", { channel: "qq", chatType: "group" });
    expect(policy).toEqual({
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
    });

    const options = {
      tools: [{ id: "shell" }],
      toolSystemContent: "TOOL CATALOG",
      skillLayerContent: "SKILL CATALOG",
      capabilities: {
        mode: "chat",
        tools: [{ id: "shell" }],
        toolIds: new Set(["shell"]),
        skills: [],
        skillIds: new Set<string>(),
      },
    } as unknown as CyreneRunOptions;
    enforceChannelAgentPolicy(options, policy);
    expect(options.tools).toEqual([]);
    expect(options.toolSystemContent).toBe("");
    expect(options.skillLayerContent).toBe("");
    expect(options.capabilities?.tools).toEqual([]);
    expect(options.capabilities?.toolIds.size).toBe(0);
  });
});
