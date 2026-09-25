import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// svg 资产 import 在 node 测试环境不可加载，mock 掉只测卡片逻辑
vi.mock("./file-icon-assets", () => ({
  FILE_ICON_URLS: { default: "default-url" },
  FILE_NAME_MAP: {},
  FILE_EXT_MAP: {},
}));

import { extractFileChanges, FileChangeCard } from "./FileChangeCard";

const SAMPLE_RESULT = JSON.stringify({
  tool: "str_replace",
  success: true,
  changes: [
    {
      file: "src/main/orchestrator/life-tools.ts",
      kind: "modified",
      insertions: 3,
      deletions: 1,
      diff: [
        { type: "context", text: "const a = 1;" },
        { type: "remove", text: "const b = 2;" },
        { type: "add", text: "const b = 20;" },
      ],
    },
    {
      file: "docs/new-file.md",
      kind: "added",
      insertions: 10,
      deletions: 0,
    },
  ],
});

describe("extractFileChanges", () => {
  it("parses changes from a tool result JSON", () => {
    const changes = extractFileChanges(SAMPLE_RESULT);
    expect(changes).not.toBeNull();
    expect(changes).toHaveLength(2);
    expect(changes![0].file).toBe("src/main/orchestrator/life-tools.ts");
    expect(changes![1].kind).toBe("added");
  });

  it("returns null for non-JSON results", () => {
    expect(extractFileChanges("plain text output")).toBeNull();
  });

  it("returns null when changes is missing or empty", () => {
    expect(extractFileChanges(JSON.stringify({ success: true }))).toBeNull();
    expect(extractFileChanges(JSON.stringify({ success: true, changes: [] }))).toBeNull();
  });

  it("returns null when a change entry is malformed", () => {
    expect(extractFileChanges(JSON.stringify({ changes: [{ file: "a.ts" }] }))).toBeNull();
    expect(
      extractFileChanges(JSON.stringify({ changes: [{ file: "a.ts", kind: "weird", insertions: 1, deletions: 0 }] })),
    ).toBeNull();
  });
});

describe("FileChangeCard", () => {
  it("renders summary counts and per-file rows with +x/-y stats", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const changes = extractFileChanges(SAMPLE_RESULT)!;
    const html = renderToStaticMarkup(React.createElement(FileChangeCard, { changes }));

    expect(html).toContain("2 个文件变更");
    expect(html).toContain("+13");
    expect(html).toContain("−1");
    expect(html).toContain("cy-file-change-card__kind is-modified");
    expect(html).toContain("cy-file-change-card__kind is-added");
    expect(html).toContain("cy-file-change-card__dir");
    expect(html).toContain("life-tools.ts");
    expect(html).toContain("new-file.md");
    expect(html).toContain("+3");
  });

  it("keeps diff body collapsed until the file row is expanded", () => {
    const changes = extractFileChanges(SAMPLE_RESULT)!;
    const html = renderToStaticMarkup(React.createElement(FileChangeCard, { changes }));

    expect(html).toContain("cy-file-change-card__row is-expandable");
    expect(html).not.toContain("cy-file-change-card__diff");
    expect(html).not.toContain("const b = 20;");
    // 无 diff 的文件行不可展开
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
  });
});
