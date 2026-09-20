// @ts-nocheck -- renderer tsconfig intentionally omits Node test globals.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(__dirname, "../../..");
const perfMain = resolve(__dirname, "main.tsx");
const baselineScript = resolve(projectRoot, "scripts/perf/chat-renderer-baseline.mjs");
const spikeFiles = [
  "streamdown-spike.tsx",
  "streamdown-spike.css",
  "streamdown-spike.test.ts",
  "streamdown-spike-state.test.ts",
];

describe("react perf harness cleanup", () => {
  it("uses the production renderer without an injected Streamdown experiment", () => {
    expect(readFileSync(perfMain, "utf8")).not.toContain("__cyreneChatPerfMarkdownRenderer");
    expect(readFileSync(baselineScript, "utf8")).not.toContain("paired-control");
    for (const file of spikeFiles) {
      expect(existsSync(resolve(__dirname, file))).toBe(false);
    }
  });
});
