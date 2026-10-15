import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import { getTaskAgentProfile, resolveTaskTools } from "./task-profiles";

function tool(id: string): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "ok",
  };
}

const parentTools = [
  "Read",
  "Write",
  "write_excel",
  "write_pdf",
  "write_file",
  "list_dir",
  "web_search",
  "fetch_url",
  "task",
  "ask_user",
  "confirm_uncertain_effect",
].map(tool);

describe("Task agent profiles", () => {
  it("defines general, document, and search profiles", () => {
    expect(getTaskAgentProfile("general")).toMatchObject({
      id: "general",
      allowedToolIds: expect.arrayContaining(["run_shell", "Read", "Write", "Edit", "Glob", "Grep"]),
    });
    expect(getTaskAgentProfile("document").allowedToolIds).toContain("Write");
    expect(getTaskAgentProfile("search").allowedToolIds).toEqual(expect.arrayContaining(["web_search", "fetch_url"]));
  });

  it("never gives a child a blocked delegate or interactive tool", () => {
    const resolved = resolveTaskTools(getTaskAgentProfile("general"), parentTools);

    expect(resolved.map((entry) => entry.id)).toEqual(["Read", "Write"]);
  });

  it("intersects a specialized profile with the parent's enabled tools", () => {
    const resolved = resolveTaskTools(getTaskAgentProfile("search"), parentTools);

    expect(resolved.map((entry) => entry.id)).toEqual(["Read", "Write", "web_search", "fetch_url"]);
    expect(resolveTaskTools(getTaskAgentProfile("search"), [tool("web_search")]).map((entry) => entry.id)).toEqual(["web_search"]);
  });

  it("does not expose disabled, deprecated, or legacy tools to a child", () => {
    const tools = [
      { ...tool("Read"), enabled: false },
      { ...tool("Write"), deprecated: true },
      tool("read_file"),
      tool("write_word"),
      tool("Edit"),
    ];

    expect(resolveTaskTools(getTaskAgentProfile("general"), tools).map((entry) => entry.id)).toEqual(["Edit"]);
  });
});
