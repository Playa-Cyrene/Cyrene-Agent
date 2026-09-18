import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findDefaultDialogCalls } from "./default-dialogs-scanner";

const rendererRoot = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.[jt]sx?$/.test(entry.name) || /\.(?:test|spec)\.[jt]sx?$/.test(entry.name)) return [];
    return [full];
  });
}

describe("renderer default dialog boundary", () => {
  it("detects browser globals but ignores component methods", () => {
    expect(findDefaultDialogCalls("sample.ts", "alert('x'); window.confirm('y'); modal.confirm({});"))
      .toEqual(["sample.ts:1", "sample.ts:1"]);
    // JavaScript 源文件同样纳入边界扫描
    expect(findDefaultDialogCalls("sample.js", "confirm('z');"))
      .toEqual(["sample.js:1"]);
  });

  it("uses no browser alert or confirm calls in production code", () => {
    const found = sourceFiles(rendererRoot).flatMap((file) =>
      findDefaultDialogCalls(path.relative(rendererRoot, file), fs.readFileSync(file, "utf8")),
    );
    expect(found).toEqual([]);
  });
});
