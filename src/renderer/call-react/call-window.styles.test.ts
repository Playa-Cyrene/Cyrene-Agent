import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(__dirname, "call-window.css"), "utf8");

describe("call window surface styles", () => {
  it("lets the footer show the call window gradient instead of a separate color band", () => {
    const footerRule = stylesheet.match(/\.cy-call-window__footer\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(footerRule).toMatch(/background:\s*transparent/);
  });
});
