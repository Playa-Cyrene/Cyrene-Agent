import { describe, expect, it } from "vitest";
import { computeReasoningDropdown } from "./reasoning-dropdown";

describe("manual reasoning in chat control", () => {
  const manualReasoning = {
    style: "openai-effort" as const,
    supportedEfforts: ["low", "medium", "high"] as ("low" | "medium" | "high")[],
    defaultEffort: "medium" as const,
    supportsDisable: true,
  };

  it("makes an unregistered model adjustable using its configured levels", () => {
    const view = computeReasoningDropdown("chatgpt", "unregistered-model", { mode: "auto" }, -1, "openai", manualReasoning);
    expect(view.disabled).toBe(false);
    expect(view.items.map((item) => item.preference)).toEqual([
      { mode: "off" },
      { mode: "on", effort: "low" },
      { mode: "on", effort: "medium" },
      { mode: "on", effort: "high" },
    ]);
    expect(view.activePreference).toEqual({ mode: "on", effort: "medium" });
  });

  it("falls back to the configured default when a saved level is unsupported", () => {
    const view = computeReasoningDropdown("chatgpt", "unregistered-model", { mode: "on", effort: "max" }, 0, "openai", manualReasoning);
    expect(view.activePreference).toEqual({ mode: "on", effort: "medium" });
  });
});
