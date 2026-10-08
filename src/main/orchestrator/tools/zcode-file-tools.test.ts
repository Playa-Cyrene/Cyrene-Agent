import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "./registry/tool-registry";
import type { AgentFileAccessLevel } from "../../permission-policy";

const permissionFixture = vi.hoisted(() => ({ level: "full" as AgentFileAccessLevel }));

vi.mock("../../permission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permission")>(),
  getCurrentLevel: () => permissionFixture.level,
}));

const registryState = vi.hoisted(() => {
  const definitions = new Map<string, ToolDefinition>();
  return {
    definitions,
    register: vi.fn((tool: ToolDefinition) => definitions.set(tool.id, tool)),
    getById: vi.fn((id: string) => definitions.get(id)),
  };
});

vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: registryState.register,
    getById: registryState.getById,
  },
}));

import { registerSearchTextTool } from "./search-text-tools";
import { registerZCodeFileTools } from "./zcode-file-tools";

let workspace: string;
let backends: {
  read: ToolDefinition;
  readImage: ToolDefinition;
  write: ToolDefinition;
  edit: ToolDefinition;
  grep: ToolDefinition;
};

function backend(id: string, execute: ToolDefinition["execute"], extra: Partial<ToolDefinition> = {}): ToolDefinition {
  const tool = {
    id,
    name: id,
    description: id,
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute,
    ...extra,
  } as ToolDefinition;
  registryState.definitions.set(id, tool);
  return tool;
}

function tool(id: string): ToolDefinition {
  const found = registryState.definitions.get(id);
  if (!found) throw new Error(`Tool was not registered: ${id}`);
  return found;
}

function context(): { userQuery: string; resolvedWorkspaceRoot: string } {
  return { userQuery: "inspect files", resolvedWorkspaceRoot: workspace };
}

function expectedRealPath(target: string): string {
  return path.join(fs.realpathSync.native(path.dirname(target)), path.basename(target));
}

function registerAdapters(): void {
  registerZCodeFileTools(backends);
}

beforeEach(() => {
  permissionFixture.level = "full";
  registryState.definitions.clear();
  vi.clearAllMocks();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-file-tools-"));
  backends = {
    read: backend("read_file", vi.fn(async () => JSON.stringify({ success: true, content: "1\tread result" }))),
    readImage: backend("read_image", vi.fn(async () => "image result")),
    write: backend("write_file", vi.fn(async () => JSON.stringify({ success: true, tool: "write_file" })), {
      verificationPolicyResolver: (args) => String(args.path).endsWith(".ts") ? "code" : "artifact",
    }),
    edit: backend("str_replace", vi.fn(async () => JSON.stringify({ success: true, tool: "str_replace" }))),
    grep: backend("search_text", vi.fn(async () => JSON.stringify({ matches: [], totalMatches: 0 }))),
  };
  backend("list_dir", vi.fn(async () => "directory result"));
  registerAdapters();
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("ZCode file tool adapters", () => {
  it("exposes five replacement tools and hides the legacy file wrappers", () => {
    expect(["Read", "Write", "Edit", "Glob", "Grep"].map((id) => tool(id).id)).toEqual([
      "Read", "Write", "Edit", "Glob", "Grep",
    ]);
    for (const id of ["read_file", "read_image", "list_dir", "write_file", "str_replace", "search_text"]) {
      expect(tool(id).deprecated).toBe(true);
    }
  });

  it("converts Read offset and limit to Cyrene's one-based line arguments", async () => {
    const filePath = path.join(workspace, "notes.md");
    const result = await tool("Read").execute({ file_path: filePath, offset: 4, limit: 12 }, context());

    expect(result).toBe("1\tread result");
    expect(backends.read.execute).toHaveBeenCalledWith({ path: expectedRealPath(filePath), startLine: 5, maxLines: 12 }, context());
  });

  it("routes image paths through the existing image reader", async () => {
    const filePath = path.join(workspace, "diagram.PNG");
    expect(await tool("Read").execute({ file_path: filePath }, context())).toBe("image result");
    expect(backends.readImage.execute).toHaveBeenCalledWith({ path: expectedRealPath(filePath) }, context());
    expect(backends.read.execute).not.toHaveBeenCalled();
  });

  it("rejects outside Read paths in project-read-only mode before accessing a backend", async () => {
    permissionFixture.level = "project-read-only";
    const outsidePath = path.resolve(workspace, "..", "outside.txt");
    const result = await tool("Read").execute({ file_path: outsidePath }, context());

    expect(JSON.parse(result)).toMatchObject({ success: false, errorCode: "PERMISSION_DENIED" });
    expect(result).toContain("目标路径在当前工作区外");
    expect(backends.read.execute).not.toHaveBeenCalled();
  });

  it("allows outside Read paths in ordinary read-only mode", async () => {
    permissionFixture.level = "read-only";
    const outsidePath = path.resolve(workspace, "..", "outside.txt");

    expect(await tool("Read").execute({ file_path: outsidePath }, context())).toBe("1\tread result");
    expect(backends.read.execute).toHaveBeenCalledWith(expect.objectContaining({ path: expectedRealPath(outsidePath) }), context());
  });

  it.each(["Write", "Edit"])("rejects outside %s paths in scoped mode before mutation", async (id) => {
    permissionFixture.level = "scoped";
    const outsidePath = path.resolve(workspace, "..", "outside.txt");
    const args = id === "Write"
      ? { file_path: outsidePath, content: "blocked" }
      : { file_path: outsidePath, old_string: "before", new_string: "after" };
    const result = await tool(id).execute(args, context());

    expect(JSON.parse(result)).toMatchObject({ success: false, errorCode: "PERMISSION_DENIED" });
    expect(result).toContain("目标路径在当前工作区外");
    expect(backends.write.execute).not.toHaveBeenCalled();
    expect(backends.edit.execute).not.toHaveBeenCalled();
  });

  it.each(["Write", "Edit"])("rejects %s in ordinary read-only mode even inside the workspace", async (id) => {
    permissionFixture.level = "read-only";
    const filePath = path.join(workspace, "note.md");
    const args = id === "Write"
      ? { file_path: filePath, content: "blocked" }
      : { file_path: filePath, old_string: "before", new_string: "after" };

    expect(JSON.parse(await tool(id).execute(args, context()))).toMatchObject({
      success: false,
      errorCode: "PERMISSION_DENIED",
    });
    expect(backends.write.execute).not.toHaveBeenCalled();
    expect(backends.edit.execute).not.toHaveBeenCalled();
  });

  it("maps Write paths, preserves extension-based verification policy, and reports the public tool name", async () => {
    const filePath = path.join(workspace, "new.ts");
    const result = await tool("Write").execute({ file_path: filePath, content: "const value = 1;" }, context());

    expect(backends.write.execute).toHaveBeenCalledWith({ path: expectedRealPath(filePath), content: "const value = 1;" }, context());
    expect(tool("Write").verificationPolicyResolver?.({ file_path: filePath })).toBe("code");
    expect(JSON.parse(result)).toMatchObject({ success: true, tool: "Write" });
  });

  it("maps a unique Edit to the precise replacement backend and reports Edit", async () => {
    const filePath = path.join(workspace, "note.md");
    const result = await tool("Edit").execute({ file_path: filePath, old_string: "before", new_string: "after" }, context());

    expect(backends.edit.execute).toHaveBeenCalledWith({ file_path: expectedRealPath(filePath), old_string: "before", new_string: "after" }, context());
    expect(JSON.parse(result)).toMatchObject({ success: true, tool: "Edit" });
  });

  it("replaces every occurrence through the guarded Write backend when replace_all is true", async () => {
    const filePath = path.join(workspace, "repeat.txt");
    fs.writeFileSync(filePath, "red, red, red", "utf8");
    backends.write.execute = vi.fn(async (args) => {
      fs.writeFileSync(String(args.path), String(args.content), "utf8");
      return JSON.stringify({ success: true, tool: "write_file" });
    });
    const result = await tool("Edit").execute({
      file_path: filePath,
      old_string: "red",
      new_string: "blue",
      replace_all: true,
    }, context());

    expect(fs.readFileSync(filePath, "utf8")).toBe("blue, blue, blue");
    expect(backends.write.execute).toHaveBeenCalledWith({ path: expectedRealPath(filePath), content: "blue, blue, blue" }, context());
    expect(JSON.parse(result)).toMatchObject({ success: true, tool: "Edit" });
  });

  it("does not write when replace_all cannot find the old string", async () => {
    const filePath = path.join(workspace, "unchanged.txt");
    fs.writeFileSync(filePath, "leave this alone", "utf8");
    const result = JSON.parse(await tool("Edit").execute({
      file_path: filePath,
      old_string: "missing",
      new_string: "replacement",
      replace_all: true,
    }, context()));

    expect(result.errorCode).toBe("OLD_STRING_NOT_FOUND");
    expect(fs.readFileSync(filePath, "utf8")).toBe("leave this alone");
    expect(backends.write.execute).not.toHaveBeenCalled();
  });

  it("finds matching files under the requested workspace directory and skips dependency folders", async () => {
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "app.ts"), "export {};");
    fs.writeFileSync(path.join(workspace, "node_modules", "pkg", "hidden.ts"), "export {};");

    const result = JSON.parse(await tool("Glob").execute({ pattern: "**/*.ts", path: "src" }, context()));

    expect(result.filenames).toEqual(["src/app.ts"]);
    expect(result.truncated).toBe(false);
  });

  it("rejects outside Glob roots in project-read-only mode", async () => {
    permissionFixture.level = "project-read-only";
    const outsideDirectory = path.resolve(workspace, "..");
    const result = JSON.parse(await tool("Glob").execute({ pattern: "**/*", path: outsideDirectory }, context()));

    expect(result.errorCode).toBe("PERMISSION_DENIED");
    expect(result.filenames).toBeUndefined();
  });

  it("returns matching filenames by default for Grep", async () => {
    registerSearchTextTool();
    backends.grep = tool("search_text");
    registerAdapters();
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "found.ts"), "const needle = true;", "utf8");

    const result = JSON.parse(await tool("Grep").execute({ pattern: "needle", path: "src" }, context()));

    expect(result.mode).toBe("files_with_matches");
    expect(result.filenames).toEqual(["src/found.ts"]);
    expect(result.content).toBeUndefined();
  });

  it("combines Grep glob and type filters and returns numbered context with only matching text", async () => {
    registerSearchTextTool();
    backends.grep = tool("search_text");
    registerAdapters();
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "match.test.ts"), "before\nneedle tail\nafter\n", "utf8");
    fs.writeFileSync(path.join(workspace, "src", "skip.spec.ts"), "needle\n", "utf8");
    fs.writeFileSync(path.join(workspace, "src", "skip.test.js"), "needle\n", "utf8");

    const result = JSON.parse(await tool("Grep").execute({
      pattern: "NEEDLE",
      path: "src",
      glob: "**/*.test.ts",
      type: "ts",
      output_mode: "content",
      "-i": true,
      "-o": true,
      "-C": 1,
    }, context()));

    expect(result).toMatchObject({ numMatches: 1 });
    expect(result.content).toBe("src/match.test.ts:1-before\nsrc/match.test.ts:2:needle\nsrc/match.test.ts:3-after");
  });
});
