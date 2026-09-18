import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const theme = fs.readFileSync(fileURLToPath(new URL("../../ui/theme.css", import.meta.url)), "utf8");
const css = fs.readFileSync(fileURLToPath(new URL("../settings.css", import.meta.url)), "utf8");
const modal = fs.readFileSync(fileURLToPath(new URL("./modal.ts", import.meta.url)), "utf8");

describe("settings feedback visual contract", () => {
  it("defines shared feedback tokens and semantic states", () => {
    expect(theme).toContain("--rb-feedback-radius: 18px");
    expect(theme).toContain("--rb-feedback-danger:");
    expect(css).toContain(".cy-modal--danger");
    expect(css).toContain(".cy-notice--success");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("does not keep input presentation inline", () => {
    expect(modal).not.toMatch(/id="cy-input-field"[^>]+style=/);
  });
});
