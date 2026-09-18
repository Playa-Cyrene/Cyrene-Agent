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
});
