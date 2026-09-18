import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(fileURLToPath(new URL("./MomentPostCard.tsx", import.meta.url)), "utf8");

describe("MomentPostCard feedback", () => {
  it("删除动态前等待统一危险确认，不残留浏览器默认弹窗", () => {
    const confirmIndex = source.indexOf("await feedback.confirm");
    const deleteIndex = source.indexOf("onDelete(post.id)", confirmIndex);
    expect(source).toContain("useFeedback");
    expect(source).toContain("dangerous: true");
    expect(source).not.toContain("window.confirm");
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(confirmIndex);
  });
});
