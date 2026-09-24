import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(fileURLToPath(new URL("./ConversationSidebar.tsx", import.meta.url)), "utf8");

describe("ConversationSidebar feedback", () => {
  it("删除会话前等待统一危险确认，不残留浏览器默认弹窗", () => {
    expect(source).toContain("useFeedback");
    expect(source).toMatch(/await feedback\.confirm\([\s\S]*dangerous: true[\s\S]*onDelete/);
    expect(source).not.toContain("Modal.confirm");
    expect(source).not.toContain("window.confirm");
  });

  it("侧栏分类和分组编辑使用应用内弹窗，不调用浏览器 prompt", () => {
    expect(source).toContain("<Modal");
    expect(source).not.toContain("window.prompt");
    expect(source).not.toContain("window.confirm");
  });
});

describe("ConversationSidebar project session preview", () => {
  it("long project lists start with five sessions and expose a show-more control", () => {
    expect(source).toContain("SIDEBAR_SESSION_PREVIEW_LIMIT = 5");
    expect(source).toContain("project.sessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT)");
    expect(source).toContain('"sidebar.showMore"');
    expect(source).toContain('"sidebar.showLess"');
  });

  it("project rows swap closed/open folder icons instead of rotating a chevron", () => {
    const projectRow = source.match(/function SortableProjectRow[\s\S]*?(?=function SidebarProjectCategory)/)?.[0] ?? "";
    expect(projectRow).toMatch(/\{expanded\s*\?\s*<FolderOpen/);
    expect(projectRow).toContain(": <Folder");
    expect(projectRow).not.toContain("cy-sidebar-project__chevron");
  });
});
