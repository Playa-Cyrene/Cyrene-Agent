import { describe, expect, it } from "vitest";
import {
  filterSlashSkillSuggestions,
  getActiveSlashSkillToken,
  replaceActiveSlashSkillToken,
  type SlashSkillSuggestion,
} from "./slashSkillSuggestions";

describe("getActiveSlashSkillToken", () => {
  it("detects a leading slash token while the caret is inside it", () => {
    expect(getActiveSlashSkillToken("/ana help me", 4, 4)).toEqual({
      start: 0,
      end: 4,
      query: "ana",
    });
  });

  it("does not open for prose, later slashes, selections, or invalid token characters", () => {
    expect(getActiveSlashSkillToken("help /ana", 8, 8)).toBeNull();
    expect(getActiveSlashSkillToken("/ana help", 7, 7)).toBeNull();
    expect(getActiveSlashSkillToken("/ana", 1, 2)).toBeNull();
    expect(getActiveSlashSkillToken("/bad!", 3, 3)).toBeNull();
  });
});

describe("replaceActiveSlashSkillToken", () => {
  it("completes the command and leaves the body in place", () => {
    const token = getActiveSlashSkillToken("/ana explain this", 3, 3);
    expect(token).not.toBeNull();
    expect(replaceActiveSlashSkillToken("/ana explain this", token!, "analytics-dashboard")).toEqual({
      value: "/analytics-dashboard explain this",
      cursor: "/analytics-dashboard ".length,
    });
  });

  it("adds a space when the command is the whole message", () => {
    const token = getActiveSlashSkillToken("/ana", 4, 4);
    expect(replaceActiveSlashSkillToken("/ana", token!, "analytics-dashboard")).toEqual({
      value: "/analytics-dashboard ",
      cursor: "/analytics-dashboard ".length,
    });
  });
});

describe("filterSlashSkillSuggestions", () => {
  const items: SlashSkillSuggestion[] = [
    { id: "make-report", name: "生成报表", description: "使用 analytics dashboard", source: "builtin" },
    { id: "analytics-dashboard", name: "Analytics Dashboard", description: "Create spreadsheets", source: "user" },
    { id: "analyze-data", name: "数据分析", description: "Analyze datasets", source: "builtin" },
  ];

  it("matches id, name, and description with prefix matches first", () => {
    expect(filterSlashSkillSuggestions(items, "ana").map((item) => item.id)).toEqual([
      "analytics-dashboard",
      "analyze-data",
      "make-report",
    ]);
    expect(filterSlashSkillSuggestions(items, "spreadsheet").map((item) => item.id)).toEqual(["analytics-dashboard"]);
  });
});
