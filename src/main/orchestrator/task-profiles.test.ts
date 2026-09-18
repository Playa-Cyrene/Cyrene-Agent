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
  "read_file",
  "write_word",
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
    expect(getTaskAgentProfile("general")).toMatchObject({ id: "general", allowedToolIds: "inherit" });
    expect(getTaskAgentProfile("document").allowedToolIds).toContain("write_word");
    expect(getTaskAgentProfile("search").allowedToolIds).toEqual(expect.arrayContaining(["web_search", "fetch_url"]));
  });

  it("never gives a child a blocked delegate or interactive tool", () => {
    const resolved = resolveTaskTools(getTaskAgentProfile("general"), parentTools);

    expect(resolved.map((entry) => entry.id)).toEqual(expect.arrayContaining(["read_file", "write_word"]));
    expect(resolved.map((entry) => entry.id)).not.toEqual(expect.arrayContaining([
      "task",
      "ask_user",
      "confirm_uncertain_effect",
    ]));
  });

  it("intersects a specialized profile with the parent's enabled tools", () => {
    const resolved = resolveTaskTools(getTaskAgentProfile("search"), parentTools);

    expect(resolved.map((entry) => entry.id)).toEqual(["web_search", "fetch_url"]);
    expect(resolveTaskTools(getTaskAgentProfile("search"), [tool("web_search")]).map((entry) => entry.id)).toEqual(["web_search"]);
  });
});
