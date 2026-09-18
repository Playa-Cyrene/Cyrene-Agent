import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settingsRoot = fileURLToPath(new URL(".", import.meta.url));
const files = [
  "mcp/panel.ts", "scheduler/panel.ts", "tokens/panel.ts", "settings.ts",
  "channels/panel.ts", "memory/panel.ts", "preferences/panel.ts",
  "tts/panel.ts", "rag/panel.ts",
];

describe("settings feedback migration", () => {
  it("contains no default dialogs or legacy showModal calls", () => {
    const offenders = files.filter((file) => {
      const source = fs.readFileSync(path.join(settingsRoot, file), "utf8");
      return /\b(?:window\.)?(?:alert|confirm)\s*\(|\bshowModal\s*\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("does not duplicate the shared modal inside RAG", () => {
    const source = fs.readFileSync(path.join(settingsRoot, "rag/panel.ts"), "utf8");
    expect(source).not.toContain("function _showModal");
    expect(source).not.toContain('id = "cy-modal-overlay"');
  });
});
